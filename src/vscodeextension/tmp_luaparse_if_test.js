const luaparse = require('luaparse');

const sample = `if a then
  print('a')
elseif b then
  print('b')
else
  print('else')
end`;

console.log('Sample:\n' + sample + '\n');
try {
  const ast = luaparse.parse(sample, { locations: true, ranges: true, comments: true });
  console.log('Top-level body types:', ast.body.map(n => n.type));
  if (ast.body && ast.body.length > 0) {
    const node = ast.body[0];
    console.log('Node type:', node.type);
    console.log('Node range:', node.range);
    if (node.clauses && Array.isArray(node.clauses)) {
      console.log('Clauses count:', node.clauses.length);
      node.clauses.forEach((c, idx) => {
        console.log(` Clause ${idx}: type=${c.type}`);
        if (c.condition) console.log(`  condition.range=${c.condition.range}`);
        if (c.body) console.log(`  body length=${c.body.length} first.range=${(c.body[0] && c.body[0].range) || 'none'}`);
        if (c.range) console.log(`  clause.range=${c.range}`);
      });
    }
    console.log('Full AST node:', JSON.stringify(node, null, 2));
  }
} catch (e) {
  console.error('parse error', e);
}
