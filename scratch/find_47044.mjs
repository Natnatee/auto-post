async function main() {
  const chunks = [
    'pages/_app-eaca3f562b8cf74a.js',
    'pages/jobs-b4fad3d9fb436e97.js',
    '2-367b8b17691f9bbf.js',
    '688-949e2a591d6e58e9.js',
    '84-d637258a2033d599.js',
    '396-2d0a694cd1cf8b46.js',
    '192-c237e443fc871261.js'
  ];
  for (const c of chunks) {
    const res = await fetch(`https://jobboard.fastwork.co/_next/static/chunks/${c}`);
    const text = await res.text();
    let idx = 0;
    while ((idx = text.indexOf('47044', idx)) !== -1) {
      console.log(c, 'found 47044:', text.slice(Math.max(0, idx - 50), Math.min(text.length, idx + 250)));
      idx += 5;
    }
  }
}
main().catch(console.error);
