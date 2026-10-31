// data/snapshot.json + site/template.html → dist/index.html (자료를 gzip+base64로 내장)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const ROOT = path.join(__dirname, '..');
const raw = fs.readFileSync(path.join(ROOT, 'data/snapshot.json'));
const b64 = zlib.gzipSync(raw, { level: 9 }).toString('base64');
const html = fs.readFileSync(path.join(ROOT, 'site/template.html'), 'utf8')
  .replace('__REGIONS__', () => fs.readFileSync(path.join(ROOT, 'site/regions.js'), 'utf8'))
  .replace('__SNAPSHOT_B64__', () => b64);
fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'dist/index.html'), html);
fs.writeFileSync(path.join(ROOT, 'dist/.nojekyll'), '');
console.log(`dist/index.html ${(html.length / 1e6).toFixed(1)}MB`);
