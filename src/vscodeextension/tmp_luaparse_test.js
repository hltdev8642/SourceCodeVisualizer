const luaparse = require('luaparse');

const samples = [
`function foo(a,b)
  return a+b
end`,
`local function bar(x)
  print(x)
end`,
`t = function(x,y)
  return x*y
end`,
`function t:method(a)
  return a
end`,
`if x then
  print(1)
elseif y then
  print(2)
end`,
`for i=1,10 do
  print(i)
end`,
`repeat
  x = x - 1
until x<=0`
];

for (let i = 0; i < samples.length; i++) {
  const s = samples[i];
  console.log('--- Sample', i, '---');
  console.log(s);
  try {
    const ast = luaparse.parse(s, { locations: true, ranges: true, comments: false });
    console.log('AST body types:', ast.body.map(n => n.type));
    if (ast.body && ast.body.length > 0) {
      ast.body.forEach((n, idx) => {
        console.log(' node', idx, 'type', n.type, 'range', n.range, 'loc', n.loc && n.loc.start);
      });
    }
  } catch (e) {
    console.error('parse error:', e && e.message);
  }
}
