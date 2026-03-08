const fs = require('fs');
const path = require('path');
const luaparse = require('luaparse');

const file = path.join(__dirname, '..', '..', 'ref', 'object.lua');
const src = fs.readFileSync(file, 'utf8');
const doc = { getText: () => src, lineCount: src.split('\n').length, lineAt: (n) => ({ text: src.split('\n')[n] }) };

const ast = luaparse.parse(src, { locations: true, ranges: true, comments: false });
// find clone function node
let found = null;
const visit = (node) => {
  if (!node || typeof node !== 'object') return;
  if (node.type && (node.type === 'FunctionDeclaration' || node.type === 'FunctionStatement' || node.type === 'FunctionExpression')) {
    if (node.identifier && node.identifier.name === 'clone') found = node;
  }
  for (const k of Object.keys(node)) {
    const child = node[k];
    if (Array.isArray(child)) child.forEach(visit);
    else visit(child);
  }
};
visit(ast);
if (!found) { console.error('clone not found'); process.exit(1); }
console.log('found clone range', found.range, 'loc', found.loc.start);

// replicate logic
const selOffset = found.range[0];
const nodeRangeStart = found.range[0];
const nodeRangeEnd = found.range[1];
const srcLower = src.toLowerCase();

let headStartIdx = nodeRangeStart;
if (found.identifier && found.identifier.range) headStartIdx = found.identifier.range[0];
else headStartIdx = nodeRangeStart;

// find '(' after headStartIdx
const findMatchingParen = (s, openIdx) => {
  let i = openIdx;
  let depth = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return i; }
    i++;
  }
  return -1;
};

let openIdx = src.indexOf('(', headStartIdx);
if (openIdx < 0 || openIdx >= nodeRangeEnd) {
  const funcIdx = srcLower.indexOf('function', nodeRangeStart);
  if (funcIdx >= 0 && funcIdx < nodeRangeEnd) openIdx = src.indexOf('(', funcIdx);
}
let headEndIdx = nodeRangeStart;
let bodyStartIdx = nodeRangeStart;
if (openIdx >= 0 && openIdx < nodeRangeEnd) {
  const closeIdx = findMatchingParen(src, openIdx);
  if (closeIdx >= 0) { headEndIdx = closeIdx + 1; bodyStartIdx = headEndIdx; }
  else { headEndIdx = openIdx + 1; bodyStartIdx = headEndIdx; }
} else {
  const funcIdx2 = srcLower.indexOf('function', nodeRangeStart);
  if (funcIdx2 >= 0) headEndIdx = Math.min(nodeRangeEnd, funcIdx2 + 'function'.length);
  else headEndIdx = Math.min(nodeRangeEnd, nodeRangeStart + 8);
  bodyStartIdx = headEndIdx;
}

console.log('computed headStart/headEnd/bodyStart/bodyEnd offsets:', headStartIdx, headEndIdx, bodyStartIdx, nodeRangeEnd);
const offset2pos = (o) => {
  const lines = src.slice(0, o).split('\n');
  const line = lines.length - 1;
  const col = lines[lines.length - 1].length;
  return [line+1, col+1];
};
console.log('headStart pos', offset2pos(headStartIdx));
console.log('headEnd pos', offset2pos(headEndIdx));
console.log('bodyStart pos', offset2pos(bodyStartIdx));
console.log('nodeEnd pos', offset2pos(nodeRangeEnd));

// now replicate whitespace skip to find actual body start line/char
let body_start_line = offset2pos(bodyStartIdx)[0]-1;
let body_start_char = offset2pos(bodyStartIdx)[1]-1;
// If head ends on a '(' or ')' try to start after it
if (src.split('\n')[body_start_line].length > body_start_char && src.split('\n')[body_start_line][body_start_char] === ')') {
  body_start_char = body_start_char + 1;
}
// Skip any whitespace to start of body
{
  const line = src.split('\n')[body_start_line].substr(body_start_char);
  if (line.trim() === '') {
    body_start_line++;
    body_start_char = 0;
  }
}
console.log('after whitespace skip, body_start_line/char (1-based):', body_start_line+1, body_start_char+1);

// Now find matching 'end' considering nested constructs (simple token search)
const lines = src.split('\n');
const funcRegex = /\bfunction\b/gi;
const doRegex = /\bdo\b/gi;
const repeatRegex = /\brepeat\b/gi;
const ifRegex = /\bif\b/gi;
const forRegex = /\bfor\b/gi;
const whileRegex = /\bwhile\b/gi;
const endRegex = /\bend\b/gi;
const untilRegex = /\buntil\b/gi;

let depth = 0;
const startIndentMatch = lines[nodeRangeStart ? src.slice(0, nodeRangeStart).split('\n').length-1 : 0].match(/^\s*/);
const startIndent = startIndentMatch ? startIndentMatch[0] : '';

let inBlockComment = false;
let blockClosePattern = null;
let foundEndPos = null;
for (let ln = body_start_line; ln < lines.length; ++ln) {
  let textLine = lines[ln];
  // simplify: strip single-line comments
  const cidx = textLine.indexOf('--');
  if (cidx >= 0) textLine = textLine.substring(0, cidx);
  let sub = (ln === body_start_line) ? textLine.substring(body_start_char) : textLine;
  if (sub.trim() === '') continue;
  // token regex checks
  funcRegex.lastIndex = 0; doRegex.lastIndex = 0; repeatRegex.lastIndex=0; ifRegex.lastIndex=0; forRegex.lastIndex=0; whileRegex.lastIndex=0; endRegex.lastIndex=0; untilRegex.lastIndex=0;
  while (true) {
    const funcMatch = funcRegex.exec(sub);
    const doMatch = doRegex.exec(sub);
    const repeatMatch = repeatRegex.exec(sub);
    const ifMatch = ifRegex.exec(sub);
    const forMatch = forRegex.exec(sub);
    const whileMatch = whileRegex.exec(sub);
    const endMatch = endRegex.exec(sub);
    const untilMatch = untilRegex.exec(sub);
    let candidates = [];
    if (funcMatch) candidates.push({idx: funcMatch.index, type:'function'});
    if (doMatch) candidates.push({idx: doMatch.index, type:'do'});
    if (repeatMatch) candidates.push({idx: repeatMatch.index, type:'repeat'});
    if (ifMatch) candidates.push({idx: ifMatch.index, type:'if'});
    if (forMatch) candidates.push({idx: forMatch.index, type:'for'});
    if (whileMatch) candidates.push({idx: whileMatch.index, type:'while'});
    if (endMatch) candidates.push({idx: endMatch.index, type:'end'});
    if (untilMatch) candidates.push({idx: untilMatch.index, type:'until'});
    if (candidates.length === 0) break;
    candidates.sort((a,b)=>a.idx-b.idx);
    const pick = candidates[0];
    if (pick.type === 'function' || pick.type === 'do' || pick.type === 'repeat' || pick.type === 'for' || pick.type === 'while') { depth++; continue; }
    if (pick.type === 'if') {
      const absoluteIdx = (ln === body_start_line ? body_start_char : 0) + pick.idx;
      const beforeText = lines[ln].substring(0, absoluteIdx);
      if (/\belse\s*$/.test(beforeText)) {
        // else if -> ignore
      } else { depth++; }
      continue;
    }
    if (pick.type === 'end') {
      if (depth === 0) {
        const endIndentMatch = lines[ln].match(/^\s*/);
        const endIndent = endIndentMatch ? endIndentMatch[0] : '';
        if (endIndent === startIndent) { foundEndPos = [ln, (ln===body_start_line? body_start_char:0) + pick.idx]; break; }
      } else { depth--; }
      continue;
    }
    if (pick.type === 'until') {
      if (depth === 0) { const endIndentMatch = lines[ln].match(/^\s*/); const endIndent = endIndentMatch ? endIndentMatch[0] : ''; if (endIndent === startIndent) { foundEndPos = [ln, (ln===body_start_line? body_start_char:0) + pick.idx]; break; } } else { depth--; } continue;
    }
  }
  if (foundEndPos) break;
}
console.log('foundEndPos', foundEndPos);
if (!foundEndPos) { console.log('Could not find matching end'); }
else { console.log('body end (1-based)', foundEndPos[0]+1, foundEndPos[1]+1); }

// Simulate the extension-host debug log added in OutlineUtils.documentSymbol2outlineSymbol
{
  const totalRange = { start: offset2pos(nodeRangeStart), end: offset2pos(nodeRangeEnd) };
  const range_head = { start: offset2pos(headStartIdx), end: offset2pos(headEndIdx) };
  // body start uses the whitespace-skipped position we computed, body end uses foundEndPos if available, otherwise nodeRangeEnd
  const range_body_start = [body_start_line+1, body_start_char+1];
  const range_body_end = foundEndPos ? [foundEndPos[0]+1, foundEndPos[1]+1 + 3] : offset2pos(nodeRangeEnd);
  const range_body = { start: { line: range_body_start[0], char: range_body_start[1] }, end: { line: range_body_end[0], char: range_body_end[1] } };

  // Print in the same shape as OutlineUtils logging
  // eslint-disable-next-line no-console
  console.warn('[VpOutline] documentSymbol2outlineSymbol:', { name: 'clone', totalRange: totalRange, range_head: { start: { line: range_head.start[0], char: range_head.start[1] }, end: { line: range_head.end[0], char: range_head.end[1] } }, range_body: range_body, language: 'lua' });
}
