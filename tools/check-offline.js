// Run before every deploy: node tools/check-offline.js
// Checks that every file listed in sw.js exists, and that every local script, link and image used by index.html and card.html is cached.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const files = [...sw.match(/const FILES = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
let bad = 0;
files.forEach(f => {
  if (f === './') return;
  if (!fs.existsSync(path.join(root, f))) { console.log('MISSING FILE listed in sw.js:', f); bad++; }
});
['index.html', 'card.html'].forEach(page => {
  const p = path.join(root, page);
  if (!fs.existsSync(p)) { console.log('MISSING PAGE:', page); bad++; return; }
  const html = fs.readFileSync(p, 'utf8');
  [...html.matchAll(/(?:src|href)\s*=\s*"([^"#]+)"/g)].map(m => m[1]).forEach(u => {
    if (/^(https?:|mailto:|tel:|data:)/.test(u)) { if (/^https?:/.test(u)) { console.log('EXTERNAL LINK in ' + page + ':', u); bad++; } return; }
    const rel = './' + u.replace(/^\.\//, '');
    if (!files.includes(rel)) { console.log('NOT CACHED (add to sw.js FILES):', u, 'used in', page); bad++; }
  });
});
console.log(bad ? bad + ' problem(s) found' : 'Offline check passed: ' + files.length + ' files cached');
process.exit(bad ? 1 : 0);
