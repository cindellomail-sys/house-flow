// 전 지역 최근 약 6개월 실거래 수집 → data/snapshot.json
// 사용: DATA_GO_KR_KEY=... node scripts/collect.js   (LIMIT=3 이면 앞 3개 지역만 테스트)
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const srv = require('../server.js');   // API 호출·파싱·재시도 로직 재사용

const ROOT = path.join(__dirname, '..');
const REGIONS = vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'site/regions.js'), 'utf8') + ';REGIONS');
let codes = [...new Set(Object.values(REGIONS).flat().map(([, c]) => c))];
if (process.env.LIMIT) codes = codes.slice(0, Number(process.env.LIMIT));

const DAYS = 270;                                   // 12주 전 거래도 직전 6개월과 비교하려면 약 9개월 필요
const kstToday = new Date(Date.now() + 9 * 3600e3); // 한국 날짜 기준
const at = kstToday.toISOString().slice(0, 10);
const baseMs = Date.UTC(kstToday.getUTCFullYear(), kstToday.getUTCMonth(), kstToday.getUTCDate()) - DAYS * 864e5;
const base = new Date(baseMs).toISOString().slice(0, 10);
const yms = srv.recentYms(10);                      // 270일을 덮는 달 수
const dayOf = (s) => { const [y, m, d] = s.split('-').map(Number); return Math.round((Date.UTC(y, m - 1, d) - baseMs) / 864e5); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(code, ym){
  for (let k = 0; k < 5; k++){
    try { return await srv.fetchMonth(code, ym); }
    catch (e){ console.log(`  재시도 ${k + 1}: ${code} ${ym} ${e.message}`); await sleep(3000 * (k + 1)); }
  }
  throw new Error(`수집 실패: ${code} ${ym}`);   // 실패하면 배포하지 않고 이전 사이트 유지
}

(async () => {
  if (!process.env.DATA_GO_KR_KEY && !fs.existsSync(path.join(ROOT, '.env'))) throw new Error('DATA_GO_KR_KEY가 없어요.');
  const out = {}; let total = 0;
  for (const [i, code] of codes.entries()){
    const items = [];
    for (const ym of yms){ items.push(...await fetchWithRetry(code, ym)); await sleep(120); }
    const apts = [], idx = new Map(), t = [];
    for (const x of items){
      const d = dayOf(x.date);
      if (d < 0) continue;
      const k = x.seq || `${x.name}|${x.dong}`;
      if (!idx.has(k)){ idx.set(k, apts.length); apts.push([x.name, x.dong, x.built || 0]); }
      t.push(idx.get(k), Math.round(x.area * 100), x.price, d, x.floor, (x.canceled ? 1 : 0) | (x.direct ? 2 : 0));
    }
    out[code] = { a: apts, t };
    total += t.length / 6;
    console.log(`${i + 1}/${codes.length} ${code} ${t.length / 6}건`);
  }
  if (!process.env.LIMIT && total < 50000) throw new Error(`거래 수가 비정상적으로 적어요(${total}건). 배포를 중단해요.`);
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'data/snapshot.json'), JSON.stringify({ at, base, d: out }));
  console.log(`완료: ${at} 기준, ${total}건`);
})().catch((e) => { console.error(e.message); process.exit(1); });
