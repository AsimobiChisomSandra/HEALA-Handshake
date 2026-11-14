// Run before every deploy: node tools/preflight.js
// Catches what breaks a GitHub Pages site: missing files, wrong capital letters, files the offline cache does not know about,
// failing tests, external links, and anything that looks like a secret. Plain Node, no packages.
const fs = require('fs'), path = require('path'), cp = require('child_process');
const root = path.join(__dirname, '..');
const P = (...a) => path.join(root, ...a);
let fails = 0, warns = 0;
const pass = m => console.log('PASS  ' + m);
const fail = m => { fails++; console.log('FAIL  ' + m); };
const warn = m => { warns++; console.log('WARN  ' + m); };

// GitHub Pages is case-sensitive, Windows is not: compare every path segment letter by letter.
function existsExact(rel) {
  let dir = root;
  for (const seg of rel.replace(/^\.\//, '').split('/').filter(Boolean)) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false;
    if (!fs.readdirSync(dir).includes(seg)) return false;
    dir = path.join(dir, seg);
  }
  return true;
}

// 1. Required files
['index.html', 'card.html', 'js/data.js', 'js/engine.js', 'js/app.js', 'sw.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'js/pwa.js', 'tests/run-tests.js']
  .forEach(f => existsExact(f) ? pass('found ' + f) : fail('missing or wrong capital letters: ' + f + (/^(js|tests)\//.test(f) ? '   (try: node tools/tidy.js --apply)' : '')));

// 2. Everything the pages load must exist with exact spelling
const refs = {};
['index.html', 'card.html'].forEach(page => {
  if (!fs.existsSync(P(page))) return;
  const html = fs.readFileSync(P(page), 'utf8');
  [...html.matchAll(/(?:src|href)\s*=\s*"([^"#?]+)"/g)].map(m => m[1]).forEach(u => {
    if (/^(mailto:|tel:|data:)/.test(u)) return;
    if (/^https?:/i.test(u)) { fail('external link in ' + page + ': ' + u + ' (the app must work offline)'); return; }
    (refs[page] = refs[page] || []).push(u);
    existsExact(u) ? pass(page + ' loads ' + u) : fail(page + ' loads ' + u + ' but no file with exactly that spelling exists');
  });
});

// 3. Offline cache list
if (fs.existsSync(P('sw.js'))) {
  const m = fs.readFileSync(P('sw.js'), 'utf8').match(/const FILES = \[([\s\S]*?)\];/);
  const files = m ? [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]) : [];
  if (!files.length) fail('could not read the FILES list in sw.js');
  files.filter(f => f !== './').forEach(f => existsExact(f) || fail('sw.js caches ' + f + ' which does not exist'));
  Object.keys(refs).forEach(page => refs[page].forEach(u => {
    if (!files.includes('./' + u.replace(/^\.\//, ''))) fail('sw.js does not cache ' + u + ' (used by ' + page + '), so it would break offline');
  }));
  if (files.length) pass('offline cache list checked (' + files.length + ' entries)');
}

// 4. Manifest
if (fs.existsSync(P('manifest.webmanifest'))) {
  try {
    const mf = JSON.parse(fs.readFileSync(P('manifest.webmanifest'), 'utf8'));
    (mf.icons || []).forEach(i => existsExact(i.src) || fail('manifest icon missing: ' + i.src));
    pass('manifest.webmanifest is valid JSON');
  } catch (e) { fail('manifest.webmanifest is not valid JSON'); }
}
if (fs.existsSync(P('index.html'))) {
  const h = fs.readFileSync(P('index.html'), 'utf8');
  /rel="manifest"/.test(h) ? pass('index.html links the manifest') : warn('index.html does not link manifest.webmanifest yet (offline install needs it)');
  /js\/pwa\.js/.test(h) ? pass('index.html loads js/pwa.js') : warn('index.html does not load js/pwa.js yet (offline cache will not start)');
}

// 5. Tests
if (existsExact('tests/run-tests.js')) {
  const r = cp.spawnSync(process.execPath, [P('tests', 'run-tests.js')], { cwd: root, encoding: 'utf8' });
  const last = (r.stdout || '').trim().split('\n').pop();
  r.status === 0 ? pass('tests: ' + last) : fail('tests failed: ' + last + '\n' + (r.stdout || '').split('\n').filter(l => /^FAIL/.test(l)).slice(0, 5).join('\n') + (r.stderr ? '\n' + r.stderr.split('\n').slice(0, 3).join('\n') : ''));
}

// 6. Secrets and size
const skip = new Set(['.git', 'node_modules', '.tidy-backup']);
(function walk(dir) {
  fs.readdirSync(dir).forEach(n => {
    if (skip.has(n)) return;
    const full = path.join(dir, n), st = fs.statSync(full), rel = path.relative(root, full).replace(/\\/g, '/');
    if (st.isDirectory()) return walk(full);
    if (st.size > 20 * 1024 * 1024) warn(rel + ' is over 20 MB');
    if (/\.(js|html|json|md|csv|webmanifest|txt)$/i.test(n) && st.size < 2 * 1024 * 1024 && rel !== 'js/data.js') {
      const t = fs.readFileSync(full, 'utf8');
      if (/ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|sk-[A-Za-z0-9]{20,}|(api[_-]?key|secret|password)\s*[:=]\s*["'][^"']{6,}/i.test(t)) fail('possible secret in ' + rel + ': remove it before publishing');
    }
  });
})(root);
if (!fails) pass('no secrets or oversized files found');

console.log('\n' + (fails ? fails + ' problem(s) to fix before deploying.' : 'READY TO DEPLOY.') + (warns ? ' (' + warns + ' warning(s).)' : ''));
process.exit(fails ? 1 : 0);
