const fs = require('fs');
const luaparse = require('luaparse');
const path = require('path');

const file = path.join(__dirname, '..', '..', 'ref', 'object.lua');
const src = fs.readFileSync(file, 'utf8');
console.log('Parsing file:', file);
try {
  const ast = luaparse.parse(src, { locations: true, ranges: true, comments: true, luaVersion: '5.3' });
  // list function-like nodes
  const interesting = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type && (node.type.indexOf('Function') >= 0 || node.type === 'AssignmentStatement')) {
      interesting.push(node);
    }
    for (const k of Object.keys(node)) {
      const child = node[k];
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  };
  visit(ast);
  console.log('Found', interesting.length, 'interesting nodes');
  interesting.forEach((n, i) => {
    console.log('--- Node', i, 'type=', n.type, 'range=', n.range, 'loc=', n.loc && n.loc.start);
    if (n.type === 'FunctionDeclaration' || n.type === 'FunctionStatement' || n.type === 'FunctionExpression') {
      console.log('  identifier=', n.identifier && n.identifier.name);
      console.log('  params=', n.parameters && n.parameters.map(p=>p.name));
      console.log('  body count=', n.body && n.body.length, 'first body range=', n.body && n.body[0] && n.body[0].range);
    }
    if (n.type === 'AssignmentStatement') {
      console.log('  variables=', n.variables && n.variables.map(v=>v.name));
      console.log('  init types=', n.init && n.init.map(x=>x.type));
    }
  });
} catch (e) {
  console.error('parse failed', e && e.message);
}
