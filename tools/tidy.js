// Puts the project files in the folders the project expects (js/, tests/, tools/, data/).
// Safe by default: it only shows the plan. Add --apply to do it.
//   node tools/tidy.js            (show the plan)
//   node tools/tidy.js --apply    (do it)
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const apply = process.argv.includes('--apply');
const P = (...a) => path.join(root, ...a);
const log = m => console.log(m);

// Find a folder such as "Script" or "scripts" (any capital letters) that holds the app files.
const srcDir = fs.readdirSync(root).find(n => /^scripts?$/i.test(n) && fs.statSync(P(n)).isDirectory());
const moves = [];
if (srcDir) {
  moves.push([srcDir + '/app.js', 'js/app.js'], [srcDir + '/data.js', 'js/data.js'], [srcDir + '/engine.js', 'js/engine.js'],
    [srcDir + '/pwa.js', 'js/pwa.js'], [srcDir + '/run-tests.js', 'tests/run-tests.js'], [srcDir + '/build-data.js', 'tools/build-data.js']);
}
moves.push(['pilot_cluster_warri_riverine.csv', 'data/pilot_cluster_warri_riverine.csv']);

let todo = 0, warnings = 0;
moves.forEach(([from, to]) => {
  if (!fs.existsSync(P(from))) return;
  todo++;
  if (fs.existsSync(P(to))) {
    const same = fs.readFileSync(P(from)).equals(fs.readFileSync(P(to)));
    if (same) { log((apply ? 'REMOVE duplicate ' : 'would remove duplicate ') + from + ' (identical to ' + to + ')'); if (apply) fs.unlinkSync(P(from)); }
    else { warnings++; log('SKIP ' + from + ' -> ' + to + ': a different file already exists there. Decide by hand which one to keep.'); }
    return;
  }
  log((apply ? 'MOVE ' : 'would move ') + from + ' -> ' + to);
  if (apply) { fs.mkdirSync(path.dirname(P(to)), { recursive: true }); fs.renameSync(P(from), P(to)); }
});

// Point the pages at js/ instead of the old folder.
if (srcDir) {
  ['index.html', 'card.html'].forEach(page => {
    if (!fs.existsSync(P(page))) return;
    const html = fs.readFileSync(P(page), 'utf8');
    const re = new RegExp('(src\\s*=\\s*")(?:\\./)?' + srcDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/', 'gi');
    if (re.test(html)) {
      todo++;
      log((apply ? 'UPDATE ' : 'would update ') + page + ': script paths ' + srcDir + '/ -> js/');
      if (apply) {
        fs.mkdirSync(P('.tidy-backup'), { recursive: true });
        fs.writeFileSync(P('.tidy-backup', page), html);
        fs.writeFileSync(P(page), html.replace(re, '$1./js/'));
      }
    }
  });
  if (apply && fs.existsSync(P(srcDir)) && fs.readdirSync(P(srcDir)).length === 0) { fs.rmdirSync(P(srcDir)); log('REMOVE empty folder ' + srcDir + '/'); }
  else if (apply && fs.existsSync(P(srcDir))) { warnings++; log('NOTE: ' + srcDir + '/ still holds: ' + fs.readdirSync(P(srcDir)).join(', ') + ' (left alone)'); }
}

if (apply && fs.existsSync(P('.tidy-backup'))) {
  const gi = P('.gitignore'), cur = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  if (!/\.tidy-backup/.test(cur)) fs.writeFileSync(gi, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + '.tidy-backup/\n');
}

if (!todo) log('Nothing to tidy: the files are already where the project expects them.');
else if (!apply) log('\nThat was only the plan. Run: node tools/tidy.js --apply');
else log('\nDone' + (warnings ? ' with ' + warnings + ' warning(s) above.' : '.') + ' Next: node tools/preflight.js');
