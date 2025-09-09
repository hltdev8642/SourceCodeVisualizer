import * as vscode from 'vscode';
import { VpLspExtenderProvider } from '../outlineproviderAPI/lspextenderprovider';
import * as Outline from '../outlineproviderAPI/SymbolDefinition';
import * as utils from '../utils';
import { OutlineUtils } from '../outlineproviderAPI/utils/outlineutils';
// try to use luaparse for robust Lua AST parsing
let luaparse: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  luaparse = require('luaparse');
} catch (e) {
  // not available at runtime — will fallback to heuristics
  luaparse = null;
}

/**
 * LspExtenderProvider for Lua
 *
 * Notes:
 *  - Heuristics assume simple `function ...(...) ... end` structure.
 *  - Nested/end matching is naive and may fail with complex scopes.
 */
export class VpLspExtenderLua implements VpLspExtenderProvider {
  public getLanguageStr(): string {
    return 'lua';
  }

  public isDefinition(_doc: vscode.TextDocument, _position: vscode.Position): boolean {
    // TODO: Differentiate definition vs. reference. Keep simple for now.
    return false;
  }

  /**
   * Determine head/body ranges for a DocumentSymbol using Lua syntax cues.
   * Returns: [rangeHead, rangeBody, attributes]
   */
  public getLanguageSpecificSymbolInformation(
    document: vscode.TextDocument,
    docSymbol: vscode.DocumentSymbol
  ): any[] {
    // If luaparse is available, attempt AST-based range detection for better robustness
    if (luaparse) {
      try {
        const src = document.getText();
        const ast = luaparse.parse(src, { locations: true, ranges: true, comments: false });

        // find the node that corresponds to docSymbol.selectionRange
        const selStart = docSymbol.selectionRange.start;
        const selOffset = document.offsetAt(selStart);

        // traverse AST to find function node that encloses the selection
        let foundNode: any = null;
        const visit = (node: any) => {
          if (!node || typeof node !== 'object') return;
          if (node.type && node.loc) {
            const start = node.range ? node.range[0] : node.loc.start.offset;
            const end = node.range ? node.range[1] : node.loc.end.offset;
            if (start <= selOffset && selOffset <= end) {
              if (node.type === 'FunctionDeclaration' || node.type === 'FunctionStatement' || node.type === 'ForNumericStatement' || node.type === 'ForGenericStatement' || node.type === 'IfStatement' || node.type === 'RepeatStatement') {
                foundNode = node;
              }
            }
          }
          for (const k of Object.keys(node)) {
            const child = node[k];
            if (Array.isArray(child)) child.forEach(visit);
            else visit(child);
          }
        };
        visit(ast);

        if (foundNode) {
          // Helpers: find matching ')' for a '(' at a given offset, skipping strings and long brackets
          const findMatchingParen = (src: string, openIdx: number) => {
            let i = openIdx;
            let depth = 0;
            const len = src.length;
            while (i < len) {
              const ch = src[i];
              // naive string skip
              if (ch === '"' || ch === "'") {
                const quote = ch;
                i++;
                while (i < len && src[i] !== quote) {
                  if (src[i] === '\\') i += 2; else i++;
                }
                i++;
                continue;
              }
              // long bracket skip
              if (ch === '[' && src.substring(i).match(/^\[=*\[/)) {
                const m = src.substring(i).match(/^\[=*\[/)![0];
                const equals = m.slice(1, -1);
                const close = ']' + equals + ']';
                const endIdx = src.indexOf(close, i + m.length);
                if (endIdx < 0) return -1;
                i = endIdx + close.length;
                continue;
              }
              if (ch === '(') depth++;
              else if (ch === ')') {
                depth--;
                if (depth === 0) return i;
              }
              i++;
            }
            return -1;
          };

          const src = document.getText();
          const nodeRangeStart = foundNode.range ? foundNode.range[0] : foundNode.loc.start.offset;
          const nodeRangeEnd = foundNode.range ? foundNode.range[1] : foundNode.loc.end.offset;

          // start of head: generally nodeRangeStart or identifier start for assignments
          let headStartIdx = nodeRangeStart;
          let headEndIdx = nodeRangeStart; // will be adjusted
          let bodyStartIdx = nodeRangeStart;
          let bodyEndIdx = nodeRangeEnd;

          const takeRange = (s: number, e: number) => {
            const startPos = document.positionAt(Math.max(0, Math.min(s, src.length)));
            const endPos = document.positionAt(Math.max(0, Math.min(e, src.length)));
            return [new vscode.Range(startPos, endPos)];
          };

          const lowerSrc = src.toLowerCase();

          // FunctionDeclaration or function statement inside assignment
          if (foundNode.type === 'FunctionDeclaration' || foundNode.type === 'FunctionStatement') {
            // headStart: if identifier exists use its start, else node start
            if (foundNode.identifier && foundNode.identifier.range) headStartIdx = foundNode.identifier.range[0];
            else headStartIdx = nodeRangeStart;

            // find '(' after headStartIdx
            const openIdx = src.indexOf('(', headStartIdx);
            if (openIdx >= 0 && openIdx < nodeRangeEnd) {
              const closeIdx = findMatchingParen(src, openIdx);
              if (closeIdx >= 0) {
                headEndIdx = closeIdx + 1;
                bodyStartIdx = headEndIdx;
              } else {
                // fallback: set head end near openIdx
                headEndIdx = openIdx + 1;
                bodyStartIdx = headEndIdx;
              }
            } else {
              // no paren found — fallback to keyword end
              headEndIdx = nodeRangeStart + 8; // length of 'function' approx
              bodyStartIdx = headEndIdx;
            }
            bodyEndIdx = nodeRangeEnd;
          } else if (foundNode.type === 'AssignmentStatement' && Array.isArray(foundNode.init) && foundNode.init.length > 0 && (foundNode.init[0].type === 'FunctionDeclaration' || foundNode.init[0].type === 'FunctionExpression')) {
            // e.g. foo = function(...) ... end
            const funcNode = foundNode.init[0];
            // head is the left-hand target start to function param close
            if (Array.isArray(foundNode.variables) && foundNode.variables.length > 0 && foundNode.variables[0].range) {
              headStartIdx = foundNode.variables[0].range[0];
            } else headStartIdx = nodeRangeStart;
            const funcStart = funcNode.range ? funcNode.range[0] : funcNode.loc.start.offset;
            const openIdx = src.indexOf('(', funcStart);
            if (openIdx >= 0) {
              const closeIdx = findMatchingParen(src, openIdx);
              if (closeIdx >= 0) {
                headEndIdx = closeIdx + 1;
                bodyStartIdx = headEndIdx;
              } else {
                headEndIdx = funcStart + 8;
                bodyStartIdx = headEndIdx;
              }
            } else {
              headEndIdx = funcStart + 8;
              bodyStartIdx = headEndIdx;
            }
            bodyEndIdx = funcNode.range ? funcNode.range[1] : funcNode.loc.end.offset;
          } else if (foundNode.type === 'IfStatement') {
            // find the specific clause that contains selection — clauses are IfClause/ElseifClause/ElseClause
            let clause: any = null;
            if (Array.isArray(foundNode.clauses)) {
              for (const c of foundNode.clauses) {
                const s = c.range ? c.range[0] : (c.loc ? c.loc.start.offset : null);
                const e = c.range ? c.range[1] : (c.loc ? c.loc.end.offset : null);
                if (s != null && e != null && s <= selOffset && selOffset <= e) { clause = c; break; }
              }
            }
            if (!clause) clause = foundNode.clauses && foundNode.clauses[0];
            if (clause) {
              headStartIdx = clause.range ? clause.range[0] : clause.loc.start.offset;
              // try to find 'then' token after clause start and before clause body
              const thenIdx = lowerSrc.indexOf('then', headStartIdx);
              if (thenIdx >= 0 && thenIdx < (clause.body && clause.body.range ? clause.body.range[0] : nodeRangeEnd)) {
                headEndIdx = thenIdx + 4;
                bodyStartIdx = headEndIdx;
              } else {
                headEndIdx = (clause.condition && clause.condition.range) ? clause.condition.range[1] : (clause.range ? clause.range[1] : headStartIdx + 4);
                bodyStartIdx = headEndIdx;
              }
            }
            bodyEndIdx = nodeRangeEnd;
          } else if (foundNode.type === 'ForNumericStatement' || foundNode.type === 'ForGenericStatement' || foundNode.type === 'WhileStatement') {
            // head ends at 'do'
            headStartIdx = nodeRangeStart;
            const doIdx = lowerSrc.indexOf(' do', headStartIdx);
            if (doIdx >= 0 && doIdx < nodeRangeEnd) {
              headEndIdx = doIdx + 1; // include space before do
              bodyStartIdx = headEndIdx;
            } else {
              headEndIdx = headStartIdx + 4;
              bodyStartIdx = headEndIdx;
            }
            bodyEndIdx = nodeRangeEnd;
          } else if (foundNode.type === 'RepeatStatement') {
            headStartIdx = nodeRangeStart;
            headEndIdx = headStartIdx + 6; // 'repeat'
            bodyStartIdx = headEndIdx;
            // body end is handled by nodeRangeEnd (which ends at 'until' probably)
            bodyEndIdx = nodeRangeEnd;
          } else {
            // default conservative mapping: head is node start to a small offset, body is node
            headStartIdx = nodeRangeStart;
            headEndIdx = Math.min(nodeRangeStart + 10, nodeRangeEnd);
            bodyStartIdx = headEndIdx;
            bodyEndIdx = nodeRangeEnd;
          }

          // construct positions
          try {
            const headStartPos = document.positionAt(Math.max(0, Math.min(headStartIdx, src.length)));
            const headEndPos = document.positionAt(Math.max(0, Math.min(headEndIdx, src.length)));
            const bodyStartPos = document.positionAt(Math.max(0, Math.min(bodyStartIdx, src.length)));
            const bodyEndPos = document.positionAt(Math.max(0, Math.min(bodyEndIdx, src.length)));

            const rangeHead = new vscode.Range(headStartPos, headEndPos);
            const rangeBody = new vscode.Range(bodyStartPos, bodyEndPos);
            return [rangeHead, rangeBody, []];
          } catch (e) {
            // fall through to heuristics
          }
        }
      } catch (e) {
        // parsing failed — fallback to heuristic scanning below
        // console.warn('luaparse failed:', e);
      }
    }
  const docText = document.getText();
  const stripped = stripLuaComments(docText);
  const startOffset = document.offsetAt(docSymbol.range.start);

  const END_KEYWORD = 'end';
  const PAREN_O = '(';
  const PAREN_C = ')';

    let rangeHead: vscode.Range | null = null;
    let rangeBody: vscode.Range | null = null;
    const attributes: Outline.Attribute[] = [];

    // Find head range: try multiple fallbacks to account for different Lua function syntaxes
    {
      const name_start = [docSymbol.selectionRange.start.line, docSymbol.selectionRange.start.character];
      const name_end = [docSymbol.selectionRange.end.line, docSymbol.selectionRange.end.character];

      const head_start_line = name_start[0];
      const head_start_char = name_start[1];

      let headEnd: number[] | null = null;

      // 1) Preferred: find '(' after the selectionRange end and match its closing ')' across lines
      let parenLoc: number[] | null = null;
      // search stripped text for '(' to avoid comments interfering
      const parenIdx = stripped.indexOf(PAREN_O, startOffset);
      if (parenIdx >= 0) {
        const ppos = document.positionAt(parenIdx);
        parenLoc = [ppos.line, ppos.character];
      }
      if (parenLoc) {
        const parenEnd = ((): number[] | null => {
          // scan character-wise from parenLoc to find matching ')', handle nested parentheses, skip comments and strings simply
          let depth = 0;
          for (let ln = parenLoc[0]; ln < document.lineCount; ++ln) {
            const lineText = document.lineAt(ln).text;
            // start index
            let i = (ln === parenLoc[0]) ? parenLoc[1] : 0;
            while (i < lineText.length) {
              const ch = lineText[i];
              // skip string starts (", ', [[ ) simple heuristic
              if (ch === '"' || ch === "'" ) {
                const quote = ch;
                i++;
                while (i < lineText.length && lineText[i] !== quote) {
                  if (lineText[i] === '\\') i += 2; else i++;
                }
                i++;
                continue;
              }
              // skip start of long bracket (which could be block string) -- rough check
              if (ch === '[' && lineText.substring(i).match(/^\[=*\[/)) {
                // find closing pattern
                const m = lineText.substring(i).match(/^\[=*\[/);
                const equals = m ? m[0].slice(1, -1) : '';
                const close = ']' + equals + ']';
                // scan forward from current line to find close
                let closed = false;
                for (let ln2 = ln; ln2 < document.lineCount && !closed; ++ln2) {
                  const text2 = document.lineAt(ln2).text;
                  const startIdx = (ln2 === ln) ? i + m![0].length : 0;
                  const idx = text2.indexOf(close, startIdx);
                  if (idx >= 0) {
                    if (ln2 === ln) { i = idx + close.length; }
                    closed = true;
                    // continue scanning after close
                    if (ln2 > ln) { ln = ln2; i = idx + close.length; }
                  }
                }
                if (!closed) return null; // unterminated long bracket
                continue;
              }

              if (ch === '(') { depth++; }
              else if (ch === ')') {
                depth--;
                if (depth <= 0) return [ln, i];
              }
              i++;
            }
          }
          return null;
        })();
        if (parenEnd) headEnd = parenEnd;
      }

      // Also look for ' do' or 'repeat' which can end a header (for/while/repeat)
      let doLoc = utils.findInDocument(' do', document, name_end) || utils.findInDocument('do', document, name_end);
      let repeatLoc = utils.findInDocument('repeat', document, name_end);
      // choose a head end that covers either a closing paren or the 'do'/'repeat' token
      if (!headEnd) {
        if (doLoc) headEnd = doLoc;
        else if (repeatLoc) headEnd = repeatLoc;
      } else {
        // if we already have a paren-based headEnd, prefer a later 'do' if present
        if (doLoc) {
          const doIsLater = (doLoc[0] > headEnd[0]) || (doLoc[0] === headEnd[0] && doLoc[1] > headEnd[1]);
          if (doIsLater) headEnd = doLoc;
        }
      }

      // 2) Fallback: search for '(' after the symbol start (covers some language-server selectionRange quirks)
      if (!headEnd) {
        parenLoc = utils.findInDocument(PAREN_O, document, [head_start_line, head_start_char]);
        if (parenLoc) {
          const parenEnd = ((): number[] | null => {
            // reuse same scanning logic as above starting from parenLoc
            let depth = 0;
            for (let ln = parenLoc[0]; ln < document.lineCount; ++ln) {
              const lineText = document.lineAt(ln).text;
              let i = (ln === parenLoc[0]) ? parenLoc[1] : 0;
              while (i < lineText.length) {
                const ch = lineText[i];
                if (ch === '(') depth++; else if (ch === ')') { depth--; if (depth <= 0) return [ln, i]; }
                i++;
              }
            }
            return null;
          })();
          if (parenEnd) headEnd = parenEnd;
        }
      }

      // 3) Fallback: anonymous/assigned function like `foo = function(...)` -> find 'function' keyword in symbol range and then '(' after it
      if (!headEnd) {
        const funcKeyword = utils.findInDocument('function', document, [head_start_line, head_start_char]);
        if (funcKeyword && utils.range_fromArray([funcKeyword, funcKeyword])) {
          const parenAfterFunc = utils.findInDocument(PAREN_O, document, funcKeyword);
          if (parenAfterFunc) {
            // use matching paren scanner
            let depth = 0;
            const parenEnd = ((): number[] | null => {
              for (let ln = parenAfterFunc[0]; ln < document.lineCount; ++ln) {
                const lineText = document.lineAt(ln).text;
                let i = (ln === parenAfterFunc[0]) ? parenAfterFunc[1] : 0;
                while (i < lineText.length) {
                  const ch = lineText[i];
                  if (ch === '(') depth++; else if (ch === ')') { depth--; if (depth <= 0) return [ln, i]; }
                  i++;
                }
              }
              return null;
            })();
            if (parenEnd) headEnd = parenEnd;
          }
        }
      }

      // 4) Best-effort fallback: if still not found, try to find 'do' or 'repeat' on same line or use selectionRange end as head end (graceful fallback)
      if (!headEnd) {
        // try find ' do' or 'repeat' on same line first
        const lineText = document.lineAt(head_start_line).text;
        const doIdx = lineText.indexOf(' do', head_start_char);
        const repeatIdx = lineText.indexOf('repeat', head_start_char);
        if (doIdx >= 0) headEnd = [head_start_line, doIdx + 1];
        else if (repeatIdx >= 0) headEnd = [head_start_line, repeatIdx];
        else headEnd = name_end;
      }

      rangeHead = utils.range_new(head_start_line, head_start_char, headEnd[0], headEnd[1]);
    }

    // Find body range: from right after head to the matching `end` (handles nested functions)
    {
      if (!rangeHead) throw new Error('Error: Function not parsable (rangeHead is null).');

      let body_start_line = rangeHead.end.line;
      let body_start_char = Math.max(0, rangeHead.end.character);
      // If head ends on a '(' or ')' try to start after it
      if (document.lineAt(body_start_line).text.length > body_start_char && document.lineAt(body_start_line).text[body_start_char] === ')') {
        body_start_char = body_start_char + 1;
      }

      // Skip any whitespace to start of body
      {
        const line = document.lineAt(body_start_line).text.substr(body_start_char);
        if (line.trim() === '') {
          body_start_line++;
          body_start_char = 0;
        }
      }

      // Now search for matching 'end'/'until' considering nested constructs (function, do, repeat)
      const endPos = ((): number[] | null => {
        let depth = 0;
  const funcRegex = /\bfunction\b/gi;
  const doRegex = /\bdo\b/gi;
  const repeatRegex = /\brepeat\b/gi;
  const ifRegex = /\bif\b/gi;
  const forRegex = /\bfor\b/gi;
  const whileRegex = /\bwhile\b/gi;
  const endRegex = /\bend\b/gi;
  const untilRegex = /\buntil\b/gi;

        const startIndentMatch = document.lineAt(rangeHead.start.line).text.match(/^\s*/);
        const startIndent = startIndentMatch ? startIndentMatch[0] : '';

        // support Lua block comments --[[ ... ]] and --[=[ ... ]=]
        let inBlockComment = false;
        let blockClosePattern: string | null = null;

        for (let ln = body_start_line; ln < document.lineCount; ++ln) {
          let textLine = document.lineAt(ln).text;

          // handle being inside a block comment from previous lines
          if (inBlockComment) {
            const closeIdx = textLine.indexOf(blockClosePattern as string);
            if (closeIdx >= 0) {
              // drop everything up to and including the close token
              textLine = textLine.substring(closeIdx + (blockClosePattern as string).length);
              inBlockComment = false;
              blockClosePattern = null;
            } else {
              // whole line is inside block comment
              continue;
            }
          }

          // remove any inline block comment that starts and ends on the same line, or starts and continues
          let blockStartMatch = textLine.match(/--\[(=*)\[/);
          if (blockStartMatch) {
            const equals = blockStartMatch[1];
            const close = ']' + equals + ']';
            const startIdx = textLine.indexOf(blockStartMatch[0]);
            const closeIdx = textLine.indexOf(close, startIdx + blockStartMatch[0].length);
            if (closeIdx >= 0) {
              // remove the block comment content on this line
              textLine = textLine.substring(0, startIdx) + textLine.substring(closeIdx + close.length);
            } else {
              // remove from start to end of line and mark block comment state
              textLine = textLine.substring(0, startIdx);
              inBlockComment = true;
              blockClosePattern = close;
            }
          }

          // strip single-line comments (--)
          const commentIdx = textLine.indexOf('--');
          if (commentIdx >= 0) textLine = textLine.substring(0, commentIdx);

          let searchFrom = 0;
          if (ln === body_start_line) searchFrom = body_start_char;

          let sub = textLine.substring(searchFrom);
          if (sub.length === 0) continue;

          // reset lastIndex for safety
          funcRegex.lastIndex = 0;
          doRegex.lastIndex = 0;
          repeatRegex.lastIndex = 0;
          endRegex.lastIndex = 0;
          untilRegex.lastIndex = 0;

          while (true) {
            const funcMatch = funcRegex.exec(sub);
            const doMatch = doRegex.exec(sub);
            const repeatMatch = repeatRegex.exec(sub);
            const ifMatch = ifRegex.exec(sub);
            const forMatch = forRegex.exec(sub);
            const whileMatch = whileRegex.exec(sub);
            const endMatch = endRegex.exec(sub);
            const untilMatch = untilRegex.exec(sub);

            // pick the earliest positive match
            let candidates: Array<{idx: number | null; type: string}> = [
              { idx: funcMatch ? funcMatch.index : null, type: 'function' },
              { idx: doMatch ? doMatch.index : null, type: 'do' },
              { idx: repeatMatch ? repeatMatch.index : null, type: 'repeat' },
              { idx: ifMatch ? ifMatch.index : null, type: 'if' },
              { idx: forMatch ? forMatch.index : null, type: 'for' },
              { idx: whileMatch ? whileMatch.index : null, type: 'while' },
              { idx: endMatch ? endMatch.index : null, type: 'end' },
              { idx: untilMatch ? untilMatch.index : null, type: 'until' }
            ];
            candidates = candidates.filter(c => c.idx !== null) as any;
            if (candidates.length === 0) break;
            candidates.sort((a, b) => (a.idx as number) - (b.idx as number));
            const pick = candidates[0];

            if (pick.type === 'function' || pick.type === 'do' || pick.type === 'repeat' || pick.type === 'for' || pick.type === 'while') {
              depth++;
              // continue searching after this token
              continue;
            }

            // special-case 'if' because it can appear as 'else if' which is not a new block
            if (pick.type === 'if') {
              // determine absolute index of the 'if' match in the original line
              const ifMatchArr = ifMatch as RegExpExecArray | null;
              if (ifMatchArr) {
                const absoluteIdx = searchFrom + ifMatchArr.index;
                const beforeText = document.lineAt(ln).text.substring(0, absoluteIdx);
                // if line ends with 'else' (allowing whitespace), then this is an 'else if' situation
                if (/\belse\s*$/i.test(beforeText)) {
                  // do not treat as block opener; continue scanning
                } else {
                  depth++;
                }
              } else {
                depth++;
              }
              continue;
            }

            if (pick.type === 'end') {
              if (depth === 0) {
                // require indent level to match startIndent
                const endIndentMatch = document.lineAt(ln).text.match(/^\s*/);
                const endIndent = endIndentMatch ? endIndentMatch[0] : '';
                if (endIndent === startIndent) return [ln, searchFrom + (endMatch as RegExpExecArray).index];
                // otherwise treat as non-matching 'end' and continue
              } else {
                depth--;
              }
              continue;
            }

            if (pick.type === 'until') {
              if (depth === 0) {
                const endIndentMatch = document.lineAt(ln).text.match(/^\s*/);
                const endIndent = endIndentMatch ? endIndentMatch[0] : '';
                if (endIndent === startIndent) return [ln, searchFrom + (untilMatch as RegExpExecArray).index];
              } else {
                depth--;
              }
              continue;
            }
          }
        }
        return null;
      })();

      if (!endPos) throw new Error('Error: Function not parsable (Could not find matching end keyword).');

      const body_end_line = endPos[0];
      const body_end_char = endPos[1] + END_KEYWORD.length;

      rangeBody = utils.range_new(body_start_line, body_start_char, body_end_line, body_end_char);
    }

    return [rangeHead, rangeBody, attributes];
  }

  public async provideOutlineForRange(
    document: vscode.TextDocument,
    symbolRange: vscode.Range
  ): Promise<Array<Outline.Symbol | Outline.Text>> {
    const ret: Array<Outline.Symbol | Outline.Text> = [];
    // Placeholder for future implementation
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const symbolsInRange = OutlineUtils.getDocumentSymbolsInRange(document.uri, symbolRange);
    throw new Error('outlines for ranges are not yet implemented');
    // return ret; // unreachable until implemented
  }
}

// Strip single-line comments (-- ... ) and long-bracket block comments (--[[ ... ]] or --[=[ ... ]=])
function stripLuaComments(src: string) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src[i] === '-' && src[i + 1] === '-') {
      // check for long bracket
      if (src[i + 2] === '[') {
        // determine level of '=' signs
        let j = i + 3;
        let eq = 0;
        while (src[j] === '=') { eq++; j++; }
        if (src[j] === '[') {
          // long bracket comment start
          const endToken = ']' + '='.repeat(eq) + ']';
          const endIdx = src.indexOf(endToken, j + 1);
          if (endIdx >= 0) {
            // replace with spaces to preserve offsets
            out += ' '.repeat(endIdx + endToken.length - i);
            i = endIdx + endToken.length;
            continue;
          } else {
            // unterminated — drop rest
            out += ' '.repeat(src.length - i);
            break;
          }
        }
      }
      // single-line comment — skip until newline
      let k = i + 2;
      while (k < src.length && src[k] !== '\n') k++;
      out += ' '.repeat(k - i);
      i = k;
      continue;
    }
    out += src[i];
    i++;
  }
  return out;
}
