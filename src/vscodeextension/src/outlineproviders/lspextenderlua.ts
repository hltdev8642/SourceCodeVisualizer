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

        // traverse AST to find the most specific (smallest) enclosing node of interest
        let foundNode: any = null;
        const visit = (node: any) => {
          if (!node || typeof node !== 'object') return;
          if (node.type && node.loc) {
            const start = node.range ? node.range[0] : node.loc.start.offset;
            const end = node.range ? node.range[1] : node.loc.end.offset;
            if (start <= selOffset && selOffset <= end) {
              // only consider node types we care about
              const interesting = new Set(["FunctionDeclaration", "FunctionStatement", "FunctionExpression", "ForNumericStatement", "ForGenericStatement", "IfStatement", "RepeatStatement", "WhileStatement"]);
              if (interesting.has(node.type)) {
                if (!foundNode) foundNode = node;
                else {
                  const foundStart = foundNode.range ? foundNode.range[0] : foundNode.loc.start.offset;
                  const foundEnd = foundNode.range ? foundNode.range[1] : foundNode.loc.end.offset;
                  // pick the smaller (more specific) node
                  if ((end - start) <= (foundEnd - foundStart)) foundNode = node;
                }
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
          if (foundNode.type === 'FunctionDeclaration' || foundNode.type === 'FunctionStatement' || foundNode.type === 'FunctionExpression') {
            // Determine head start: prefer identifier start; support identifiers that are simple Identifiers or Member/Index expressions
            if (foundNode.identifier && foundNode.identifier.range) {
              headStartIdx = foundNode.identifier.range[0];
            } else if (foundNode.identifier && (foundNode.identifier.base || foundNode.identifier.index)) {
              // member or index expression, use its range if present
              if (foundNode.identifier.range) headStartIdx = foundNode.identifier.range[0];
              else headStartIdx = nodeRangeStart;
            } else {
              headStartIdx = nodeRangeStart;
            }

            // find '(' after headStartIdx, but limit to nodeRangeEnd
            let openIdx = src.indexOf('(', headStartIdx);
            if (openIdx < 0 || openIdx >= nodeRangeEnd) {
              // fallback: try to find '(' after the 'function' keyword within the node range
              const funcIdx = lowerSrc.indexOf('function', nodeRangeStart);
              if (funcIdx >= 0 && funcIdx < nodeRangeEnd) {
                openIdx = src.indexOf('(', funcIdx);
              }
            }

            if (openIdx >= 0 && openIdx < nodeRangeEnd) {
              const closeIdx = findMatchingParen(src, openIdx);
              if (closeIdx >= 0) {
                headEndIdx = closeIdx + 1;
                bodyStartIdx = headEndIdx;
              } else {
                headEndIdx = openIdx + 1;
                bodyStartIdx = headEndIdx;
              }
            } else {
              // final fallback: use end of 'function' keyword position or node start
              const funcIdx2 = lowerSrc.indexOf('function', nodeRangeStart);
              if (funcIdx2 >= 0) headEndIdx = Math.min(nodeRangeEnd, funcIdx2 + 'function'.length);
              else headEndIdx = Math.min(nodeRangeEnd, nodeRangeStart + 8);
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
            // pick the clause that contains the selection (IfClause / ElseifClause / ElseClause)
            let clause: any = null;
            if (Array.isArray(foundNode.clauses)) {
              for (const c of foundNode.clauses) {
                const s = c.range ? c.range[0] : (c.loc ? c.loc.start.offset : null);
                const e = c.range ? c.range[1] : (c.loc ? c.loc.end.offset : null);
                if (s != null && e != null && s <= selOffset && selOffset <= e) { clause = c; break; }
              }
            }
            if (!clause) clause = Array.isArray(foundNode.clauses) && foundNode.clauses[0];
            if (clause) {
              headStartIdx = clause.range ? clause.range[0] : clause.loc.start.offset;
              // determine head end by the start of the clause body if present, otherwise use condition end or clause end
              if (Array.isArray(clause.body) && clause.body.length > 0 && clause.body[0].range) {
                headEndIdx = clause.body[0].range[0];
                bodyStartIdx = headEndIdx;
              } else if (clause.condition && clause.condition.range) {
                headEndIdx = clause.condition.range[1];
                bodyStartIdx = headEndIdx;
              } else {
                headEndIdx = clause.range ? clause.range[1] : headStartIdx;
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
            // Debug logging to help diagnose if/then and clause parsing issues
            try {
              // use console.warn so logs appear in extension host output
              console.warn('[VpLspExtenderLua] AST-found node:', foundNode.type, 'nodeRange=', [nodeRangeStart, nodeRangeEnd]);
              console.warn('[VpLspExtenderLua] computed head:', [headStartIdx, headEndIdx], 'body:', [bodyStartIdx, bodyEndIdx]);
            } catch (logErr) {
              // swallow logging errors
            }
            return [rangeHead, rangeBody, []];
          } catch (e) {
            // fall through to heuristics
          }
        }
      } catch (e) {
        // parsing failed — fallback to symbol range
        const rangeHead = docSymbol.range;
        const rangeBody = docSymbol.range;
        return [rangeHead, rangeBody, []];
      }
    }

    // Fallback: use symbol range for both head and body
    const rangeHead = docSymbol.range;
    const rangeBody = docSymbol.range;
    return [rangeHead, rangeBody, []];
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
