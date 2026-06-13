import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const html = readFileSync('punisher-game.html', 'utf8');
const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!m) { console.error('no module script'); process.exit(1); }
// Strip the top-level `import` so vm.Script can parse it as a classic script
// — we only care about syntax, not module semantics.
const body = m[1].replace(/^\s*import\s.+?;\s*$/m, '/* import stripped */');
try {
  new vm.Script(body, { filename: 'punisher.module.js' });
  console.log('parse OK', body.length, 'chars');
} catch (e) {
  console.error('PARSE ERROR:', e.message);
  process.exit(2);
}

