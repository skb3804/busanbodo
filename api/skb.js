/**
 * /api/skb — B tv news(news.skbroadband.com) 부산보도국 기사 목록 수집 API
 *
 * 브라우저는 CORS 때문에 SK 사이트를 직접 읽을 수 없으므로, 이 서버 함수가 대신
 * 목록 페이지를 가져와 JSON으로 돌려준다. (외부 패키지 없음)
 *
 * 쿼리:
 *   start  시작 페이지 (기본 1)
 *   count  한 번에 가져올 페이지 수 (1~8, 기본 6)
 *   since  YYYY-MM-DD — 이 날짜보다 오래된 기사가 나오면 done=true
 *   y, m   이전 호출이 돌려준 state (연도 보정용. 첫 호출은 생략)
 */
const BASE = process.env.SKB_BASE || 'https://news.skbroadband.com';
const SECTION_CODE = 'S1N7';
const SECTION_LABEL = '부산';
const KNOWN_LABELS = ['서울', '인천', '경기', '충남·세종', '전북', '대구', '부산', '이슈러너'];
const UA = 'Mozilla/5.0 (compatible; BusanNewsAnalyzer/1.0)';

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function textPieces(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .split('\n')
    .map((p) => decodeEntities(p).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** 목록 HTML → [{id,title,reporter,label,y,m,d,time,url}] (페이지 내 순서 유지, 전 지역 포함) */
function parseList(html) {
  const out = [];
  const seen = new Set();
  const liRe = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
  const aRe = /<a\b[^>]*href\s*=\s*["']([^"']*articleView\.html[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let lm;
  while ((lm = liRe.exec(html))) {
    const block = lm[1];
    const anchors = [];
    let am;
    aRe.lastIndex = 0;
    while ((am = aRe.exec(block))) {
      const href = decodeEntities(am[1]);
      const id = (href.match(/idxno=(\d+)/) || [])[1];
      if (id) anchors.push({ id, href, text: textPieces(am[2]).join(' ') });
    }
    const ids = new Set(anchors.map((a) => a.id));
    if (ids.size !== 1) continue;
    const id = anchors[0].id;
    if (seen.has(id)) continue;
    const main = anchors.find((a) => a.text.length >= 3);
    if (!main) continue;
    const pieces = textPieces(block);
    const rest = pieces.join(' ').replace(main.text, ' ').replace(/\s+/g, ' ').trim();
    const dm = rest.match(/(?:(20\d{2})[-./])?(\d{2})[-./](\d{2})\s+(\d{2}):(\d{2})/);
    if (!dm) continue;
    const label = pieces.find((p) => KNOWN_LABELS.includes(p)) || '';
    const rep = rest.match(/([가-힣]{2,4})\s*(기자|국장|팀장|앵커|PD)/);
    seen.add(id);
    out.push({
      id,
      title: main.text,
      label,
      reporter: rep ? rep[1] + ' ' + rep[2] : '부산보도국',
      y: dm[1] ? parseInt(dm[1], 10) : null,
      m: parseInt(dm[2], 10),
      d: parseInt(dm[3], 10),
      time: dm[4] + ':' + dm[5],
      url: new URL(main.href, BASE + '/news/').href,
    });
  }
  return out;
}

/** 연도 없는 'MM-DD'에 연도를 붙인다. 최신→과거 순서에서 월이 6 넘게 커지면 해가 바뀐 것. */
function fixYears(items, y, prevM) {
  items.forEach((it) => {
    if (it.y) y = it.y;
    else if (it.m - prevM > 6) y--;
    prevM = it.m;
    it.date = y + '-' + String(it.m).padStart(2, '0') + '-' + String(it.d).padStart(2, '0');
  });
  return { y, m: prevM };
}

async function fetchPage(page) {
  const url = `${BASE}/news/articleList.html?sc_section_code=${SECTION_CODE}&view_type=sm&page=${page}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9', Accept: 'text/html' },
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const err = new Error(`SK 사이트 응답 오류 (HTTP ${r.status}) — page=${page}`);
      err.upstreamStatus = r.status;
      throw err;
    }
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    const q = new URL(req.url, 'http://localhost').searchParams;
    const start = Math.min(Math.max(parseInt(q.get('start') || '1', 10) || 1, 1), 20000);
    const count = Math.min(Math.max(parseInt(q.get('count') || '6', 10) || 6, 1), 8);
    const since = /^\d{4}-\d{2}-\d{2}$/.test(q.get('since') || '') ? q.get('since') : '';

    const kst = new Date(Date.now() + 9 * 3600 * 1000);
    const y0 = parseInt(q.get('y') || '', 10) || kst.getUTCFullYear();
    const m0 = parseInt(q.get('m') || '', 10) || kst.getUTCMonth() + 1;

    const pages = Array.from({ length: count }, (_, i) => start + i);
    const htmls = await Promise.all(pages.map(fetchPage));

    const raw = [];
    const rawIds = new Set();
    let reachedEnd = false;
    htmls.forEach((h) => {
      const list = parseList(h).filter((it) => !rawIds.has(it.id));
      if (list.length === 0) reachedEnd = true;
      list.forEach((it) => rawIds.add(it.id));
      raw.push(...list);
    });

    const state = fixYears(raw, y0, m0);
    const labelCounts = {};
    raw.forEach((it) => {
      labelCounts[it.label || '(없음)'] = (labelCounts[it.label || '(없음)'] || 0) + 1;
    });

    const items = raw
      .filter((it) => !it.label || it.label === SECTION_LABEL)
      .filter((it) => !since || it.date >= since)
      .map(({ id, title, reporter, date, time, url }) => ({ id, title, reporter, date, time, url }));

    const last = raw[raw.length - 1];
    const done = reachedEnd || raw.length === 0 || (since && last && last.date < since);

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.statusCode = 200;
    res.end(
      JSON.stringify({
        ok: true,
        items,
        rawCount: raw.length,
        rawLastId: last ? last.id : null,
        lastDate: last ? last.date : null,
        state,
        nextStart: start + count,
        done: !!done,
        debug: { labelCounts },
      })
    );
  } catch (e) {
    res.statusCode = e.upstreamStatus ? 502 : 500;
    res.end(JSON.stringify({ ok: false, error: e.name === 'AbortError' ? 'SK 사이트 응답 시간 초과' : e.message }));
  }
}

module.exports = handler;
module.exports.parseList = parseList;
module.exports.fixYears = fixYears;
