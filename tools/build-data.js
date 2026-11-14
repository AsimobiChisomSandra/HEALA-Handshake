// Regenerates js/data.js from data/pilot_cluster_warri_riverine.csv.
// Run with: node tools/build-data.js
// Plain Node, no packages. js/data.js is generated: never edit it by hand.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const text = fs.readFileSync(path.join(root, 'data', 'pilot_cluster_warri_riverine.csv'), 'utf8').replace(/^\uFEFF/, '');

function parseCsv(src) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.length > 1);
}

const rows = parseCsv(text);
const head = rows.shift();
const col = n => head.indexOf(n);
const need = ['nhfr_uid', 'name', 'lga', 'ward', 'level', 'ownership', 'lat', 'lng'];
need.forEach(n => { if (col(n) < 0) throw new Error('CSV is missing column: ' + n); });

const out = rows.map(r => ({
  uid: r[col('nhfr_uid')], name: r[col('name')], lga: r[col('lga')], ward: r[col('ward')],
  level: r[col('level')], own: r[col('ownership')],
  lat: Number(r[col('lat')]), lng: Number(r[col('lng')])
}));

const body = '[\n' + out.map(o => JSON.stringify(o)).join(',\n') + '\n]';
const header = '// GENERATED from data/pilot_cluster_warri_riverine.csv by tools/build-data.js. Do not edit by hand.\n' +
  '// Source: GRID3 NGA Health Facilities v2.0 (CC BY 4.0), Nigeria Health Facility Registry extract.\n' +
  '// Note: nhfr_uid is not unique in this extract, so the engine builds its own ids from row order.\n';
fs.writeFileSync(path.join(root, 'js', 'data.js'), header + 'const FACILITIES_RAW = ' + body + ';\n');
console.log('Wrote js/data.js with ' + out.length + ' facilities');
