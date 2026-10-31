// 집값흐름 서버: 정적 파일 제공 + 국토부 아파트 매매 실거래 API 프록시
// 의존성 없음 (Node 18 이상, 내장 fetch 사용)
const http = require('http');
const fs = require('fs');
const path = require('path');

loadEnv();
const KEY = process.env.DATA_GO_KR_KEY;
const PORT = process.env.PORT || 3000;
const BASE = 'https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev';
const PUBLIC_DIR = path.join(__dirname, 'public');
const cache = new Map(); // key: lawd+ym -> { t, items }
const inflight = new Map(); // 같은 달 동시 요청 합치기
// 공공데이터포털은 '디코딩 키'(원문)와 '인코딩 키'(%xx 포함) 두 가지를 줌.
// 인코딩 키를 다시 encodeURIComponent 하면 %25로 이중 인코딩돼 '등록되지 않은 서비스키' 오류가 남.
const KEY_PARAM = KEY && /%[0-9A-Fa-f]{2}/.test(KEY) ? KEY : encodeURIComponent(KEY || '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadEnv() {
  try {
    const text = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (_) { /* .env 없으면 환경변수만 사용 */ }
}

// 한국시간 기준 이번 달부터 n개월 (YYYYMM)
function recentYms(n) {
  const now = new Date(Date.now() + 9 * 3600e3);
  let y = now.getUTCFullYear(), m = now.getUTCMonth() + 1;
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(`${y}${String(m).padStart(2, '0')}`);
    m--; if (m === 0) { m = 12; y--; }
  }
  return out;
}

function decode(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}
function tag(xml, t) {
  const m = xml.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`));
  return m ? decode(m[1].trim()) : '';
}

// 오류 응답 형식이 여러 가지라 모두 처리
//  1) 정상 XML: <header><resultCode>000</resultCode>
//  2) 게이트웨이 XML: <OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>…<returnAuthMsg>…
//  3) 게이트웨이 JSON: {"OpenAPI_ServiceResponse":{"cmmMsgHeader":{…}}}
//  4) HTML/빈 응답 (점검, 5xx)
function parseApiError(text, status) {
  let errMsg = tag(text, 'errMsg'), auth = tag(text, 'returnAuthMsg'), reason = tag(text, 'returnReasonCode');
  if (!errMsg && text.trim().startsWith('{')) {
    try {
      const h = JSON.parse(text).OpenAPI_ServiceResponse?.cmmMsgHeader || {};
      errMsg = h.errMsg || ''; auth = h.returnAuthMsg || ''; reason = h.returnReasonCode || '';
    } catch (_) { /* 무시 */ }
  }
  const resultMsg = tag(text, 'resultMsg');
  const retryable = status === 429 || status >= 500 || reason === '22'
    || /LIMITED_NUMBER_OF_SERVICE_REQUESTS|초당|TEMPORARILY|SERVICE_TIMEOUT|HTTP_ERROR/i.test(errMsg + auth);
  const friendly = {
    '30': '인증키가 등록되지 않았어요. 공공데이터포털에서 이 API 활용신청이 승인됐는지, 디코딩 키를 넣었는지 확인해 주세요.',
    '31': '인증키 사용 기간이 끝났어요.',
    '22': '일일 호출 한도를 넘었어요. 내일 다시 시도해 주세요.',
    '20': '이 API에 대한 접근 권한이 없어요.',
  }[reason];
  return { retryable: retryable && reason !== '22', msg: friendly || auth || errMsg || resultMsg || `HTTP ${status}` };
}

async function callApi(url, ym) {
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep(400 * 2 ** (attempt - 1)); // 0.4s, 0.8s, 1.6s
    let res, text;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      text = await res.text();
    } catch (e) {
      last = { retryable: true, msg: `네트워크 오류: ${e.message}` };
      continue;
    }
    const code = tag(text, 'resultCode');
    if (res.ok && /^0+$/.test(code)) return text;
    last = code ? { retryable: res.status >= 500, msg: tag(text, 'resultMsg') || `resultCode ${code}` } : parseApiError(text, res.status);
    if (!last.retryable) break;
  }
  throw new Error(`공공데이터 API 오류 (${ym}): ${last.msg}`);
}

function normalize(block) {
  const g = (t) => tag(block, t);
  const y = g('dealYear'), m = g('dealMonth').padStart(2, '0'), d = g('dealDay').padStart(2, '0');
  return {
    name: g('aptNm'),
    dong: g('umdNm'),
    jibun: g('jibun'),
    seq: g('aptSeq'),
    aptDong: g('aptDong'),
    area: Number(g('excluUseAr')),
    price: Number(g('dealAmount').replace(/[^0-9]/g, '')), // 만원
    date: `${y}-${m}-${d}`,
    floor: Number(g('floor')),
    built: Number(g('buildYear')) || null,
    canceled: g('cdealType') === 'O',
    direct: g('dealingGbn').includes('직거래'),
  };
}

function fetchMonth(lawd, ym) {
  const key = lawd + ym;
  if (inflight.has(key)) return inflight.get(key);
  const p = fetchMonthInner(lawd, ym).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function fetchMonthInner(lawd, ym) {
  const key = lawd + ym;
  const isCurrent = ym === recentYms(1)[0];
  const ttl = isCurrent ? 3600e3 : 12 * 3600e3; // 이번 달 1시간, 지난 달 12시간 캐시
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.items;

  const items = [];
  let page = 1, total = Infinity;
  while (items.length < total && page <= 30) {
    const url = `${BASE}?serviceKey=${KEY_PARAM}&LAWD_CD=${lawd}&DEAL_YMD=${ym}&pageNo=${page}&numOfRows=1000`;
    const xml = await callApi(url, ym);
    total = Number(tag(xml, 'totalCount')) || 0;
    const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    for (const b of blocks) {
      const t = normalize(b);
      // 가격·면적·날짜가 깨진 행은 평균 계산을 망가뜨리므로 제외
      if (t.price > 0 && t.area > 0 && /^\d{4}-\d{2}-(0[1-9]|[12]\d|3[01])$/.test(t.date)) items.push(t);
    }
    if (!blocks.length) break;
    page++;
  }
  cache.set(key, { t: Date.now(), items });
  return items;
}

async function handleTrades(res, url) {
  if (!KEY) return sendJson(res, 500, { error: '서버에 DATA_GO_KR_KEY 환경변수가 없습니다.' });
  const lawd = url.searchParams.get('lawd') || '';
  if (!/^\d{5}$/.test(lawd)) return sendJson(res, 400, { error: 'lawd는 5자리 지역코드여야 합니다.' });
  const months = Math.min(24, Math.max(1, parseInt(url.searchParams.get('months') || '3', 10) || 3));
  try {
    const yms = recentYms(months);
    const results = [];
    for (let i = 0; i < yms.length; i += 2) { // 2개월씩 동시 요청 (초당 호출 제한 대응)
      const chunk = await Promise.all(yms.slice(i, i + 2).map((ym) => fetchMonth(lawd, ym)));
      results.push(...chunk);
    }
    const items = results.flat();
    sendJson(res, 200, { lawd, months: yms, fetchedAt: new Date().toISOString(), count: items.length, items });
  } catch (e) {
    sendJson(res, 502, { error: e.message });
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) {
      // 모르는 경로는 첫 화면으로
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        if (e2) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': TYPES['.html'] }); res.end(html);
      });
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

if (require.main === module) http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/trades') return handleTrades(res, url);
  if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true, hasKey: Boolean(KEY) });
  serveStatic(res, url.pathname);
}).listen(PORT, () => console.log(`집값흐름 서버 실행 중: http://localhost:${PORT}`));

module.exports = { normalize, tag, recentYms, parseApiError, fetchMonth };
