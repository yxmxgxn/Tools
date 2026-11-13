// 投稿のURL（またはID）から、投稿者の今のアカウント名を調べる。
// 対応: Instagram / X / Threads / TikTok
//
// 静的ファイルはCloudflareの配信がそのまま返す。このWorkerが動くのは API_PATH だけ
// （wrangler.jsonc の assets.run_worker_first で指定）。
//
// 安全のための作り方
//  - 入力からIDだけを取り出し、問い合わせ先のURLはここで組み立てる（入力されたURLには接続しない）
//  - 同じサイトの画面からのPOSTだけを受け付ける
//  - 1回の件数・文字数の上限、IPごとの回数制限
//  - 入力・結果は保存しない、ログに書かない

const API_PATH = '/sns-account-lookup/api';
const MAX_LINES = 5;
const MAX_LEN = 300;
const MAX_BODY = 5000;
const MAX_BYTES = 3_000_000;
const TIMEOUT_MS = 12_000;
const RATE_MAX = 30;           // 1ウィンドウあたりの問い合わせ回数
const RATE_WINDOW_MS = 600_000;
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });

// ---- 回数制限 ----
// Workerのインスタンスごとのメモリだけなので、あくまで簡易。
// 本格的に止めるときは、Cloudflareのダッシュボードで API_PATH にレート制限ルールを付ける。
// env.LOOKUP_LIMITER（Rate Limiting バインディング）があれば、それも使う。
const hits = new Map();
function rateHit(ip, n) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => t > now - RATE_WINDOW_MS);
  if (arr.length + n > RATE_MAX) { hits.set(ip, arr); return true; }
  for (let i = 0; i < n; i++) arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear(); // 溜まりすぎないように
  return false;
}

// ---- IDから時刻 ----
const bigFromB64 = (c) => {
  let n = 0n;
  for (const ch of c) { const v = B64.indexOf(ch); if (v < 0) return null; n = n * 64n + BigInt(v); }
  return n;
};
const igMs = (c) => { const n = bigFromB64(c); return n === null ? null : Number((n >> 23n) + 1314220021721n); };
const xMs = (id) => Number((BigInt(id) >> 22n) + 1288834974657n);
const ttMs = (id) => Number(BigInt(id) >> 32n) * 1000;
const plausible = (ms, min) => ms !== null && Number.isFinite(ms) && ms >= min && ms <= Date.now() + 86_400_000;
const pad = (n) => String(n).padStart(2, '0');
function jst(ms) {
  const d = new Date(ms + 9 * 3600 * 1000);
  return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// ---- 入力の解釈 ----
// 戻り値: {service, id} か {error}
//   service: instagram | x | threads | tiktok | instagram_or_threads
function parseInput(raw) {
  const s = raw.trim();
  if (!s) return { error: '空です' };
  if (s.length > MAX_LEN) return { error: '長すぎます' };

  const m = s.match(/^(?:https?:\/\/)?([^/\s?#]+)(\/[^\s?#]*)?/i);
  if (m && m[1].includes('.')) {
    let host = m[1].toLowerCase();
    if (/[@: ]/.test(host)) return { error: '対応していないURLです' };
    host = host.replace(/^(www|m|mobile)\./, '');
    const path = m[2] || '';
    let x;
    if (host === 'instagram.com' && (x = path.match(/\/(?:p|reels?|tv)\/([A-Za-z0-9_-]{10,11})(?:\/|$)/))) return { service: 'instagram', id: x[1] };
    if ((host === 'x.com' || host === 'twitter.com') && (x = path.match(/\/status(?:es)?\/(\d{15,19})(?:\/|$)/))) return { service: 'x', id: x[1] };
    if ((host === 'threads.com' || host === 'threads.net') && (x = path.match(/\/post\/([A-Za-z0-9_-]{10,11})(?:\/|$)/))) return { service: 'threads', id: x[1] };
    if (host === 'tiktok.com' && (x = path.match(/\/(?:video|photo)\/(\d{19})(?:\/|$)/))) return { service: 'tiktok', id: x[1] };
    return { error: '対応していないURLです（Instagram・X・Threads・TikTokの投稿URLを入れてください）' };
  }

  if (/^\d{15,19}$/.test(s)) {
    // XとTikTokは、数字を時刻に直して、妥当な年になるほうを採用する
    const isX = plausible(xMs(s), 1288834974657);
    const isTT = plausible(ttMs(s), 1451606400000);
    if (isX && !isTT) return { service: 'x', id: s };
    if (isTT && !isX) return { service: 'tiktok', id: s };
    return { error: 'IDからSNSを判別できませんでした（URLで入れてください）' };
  }
  if (/^[A-Za-z0-9_-]{10,11}$/.test(s)) {
    // InstagramとThreadsはコードの形が同じ。両方試す
    if (!plausible(igMs(s), 1314220021721)) return { error: 'コードの形が正しくありません' };
    return { service: 'instagram_or_threads', id: s };
  }
  return { error: 'URLまたはIDとして読めませんでした' };
}

// ---- 問い合わせ ----
async function readLimited(res, max) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = '', size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { try { await reader.cancel(); } catch (e) {} return ''; }
    out += dec.decode(value, { stream: true });
  }
  return out;
}

async function fetchFinal(url, wantBody) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctl.signal,
      headers: { 'user-agent': 'sns-account-lookup/0.1', 'accept-language': 'ja,en;q=0.8' },
    });
    let body = '';
    if (wantBody) body = await readLimited(res, MAX_BYTES);
    else { try { await res.body?.cancel(); } catch (e) {} }
    return { url: res.url, body };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function lookupInstagram(code) {
  const r = await fetchFinal(`https://www.instagram.com/x/p/${code}/`, false);
  if (!r) return null;
  const m = r.url.match(new RegExp(`^https://www\\.instagram\\.com/([A-Za-z0-9._]{1,30})/p/${esc(code)}/?(?:\\?.*)?$`));
  if (m && m[1] !== 'x' && m[1] !== 'accounts') return { username: m[1], url: `https://www.instagram.com/${m[1]}/p/${code}/` };
  return null;
}
async function lookupThreads(code) {
  const r = await fetchFinal(`https://www.threads.com/i/post/${code}`, false);
  if (!r) return null;
  const m = r.url.match(new RegExp(`^https://www\\.threads\\.(?:com|net)/@([A-Za-z0-9._]{1,30})/post/${esc(code)}/?(?:\\?.*)?$`));
  if (m && m[1] !== 'i') return { username: m[1], url: `https://www.threads.com/@${m[1]}/post/${code}` };
  return null;
}
async function lookupX(id) {
  const r = await fetchFinal(`https://x.com/i/status/${id}`, false);
  if (!r) return null;
  const m = r.url.match(new RegExp(`^https://x\\.com/([A-Za-z0-9_]{1,15})/status/${esc(id)}/?(?:\\?.*)?$`));
  if (m && m[1] !== 'i') return { username: m[1], url: `https://x.com/${m[1]}/status/${id}` };
  return null;
}
async function lookupTikTok(id) {
  // TikTokは転送せず、ページの中にユーザー名が入っている
  const r = await fetchFinal(`https://www.tiktok.com/@i/video/${id}`, true);
  if (!r || !r.body) return null;
  let name = null;
  const m = r.body.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (m) {
    try { name = JSON.parse(m[1])?.['__DEFAULT_SCOPE__']?.['webapp.video-detail']?.itemInfo?.itemStruct?.author?.uniqueId ?? null; } catch (e) {}
  }
  if (typeof name !== 'string' || !/^[A-Za-z0-9._]{1,30}$/.test(name) || name === 'i') return null;
  return { username: name, url: `https://www.tiktok.com/@${name}/video/${id}` };
}

// ---- 入口 ----
export async function handleLookup(request, env) {
  if (request.method !== 'POST') return json({ error: 'POSTで送ってください' }, 405);

  const site = request.headers.get('sec-fetch-site') || '';
  if (site && site !== 'same-origin') return json({ error: 'このサイトの画面からだけ使えます' }, 403);
  const origin = request.headers.get('origin') || '';
  if (origin) {
    let oh = '';
    try { oh = new URL(origin).host; } catch (e) {}
    if (oh !== new URL(request.url).host) return json({ error: 'このサイトの画面からだけ使えます' }, 403);
  }

  const text = (await request.text()).slice(0, MAX_BODY);
  const u = new URLSearchParams(text).get('u') || '';
  const lines = u.trim().split(/\s+/).filter(Boolean);
  if (!lines.length) return json({ error: 'URLを入れてください' }, 400);
  if (lines.length > MAX_LINES) return json({ error: `1回に調べられるのは${MAX_LINES}件までです` }, 400);

  const parsed = lines.map(parseInput);
  const need = parsed.reduce((a, p) => a + (p.error ? 0 : p.service === 'instagram_or_threads' ? 2 : 1), 0);
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if (need > 0) {
    if (rateHit(ip, need)) return json({ error: '短い時間に調べすぎです。しばらくしてからもう一度試してください' }, 429);
    if (env && env.LOOKUP_LIMITER) {
      const { success } = await env.LOOKUP_LIMITER.limit({ key: ip });
      if (!success) return json({ error: '短い時間に調べすぎです。しばらくしてからもう一度試してください' }, 429);
    }
  }

  const results = [];
  for (let i = 0; i < lines.length; i++) {
    const p = parsed[i];
    const row = { input: lines[i].slice(0, 80) };
    if (p.error) { row.error = p.error; results.push(row); continue; }
    let svc = p.service, res = null;
    if (svc === 'instagram_or_threads') {
      res = await lookupInstagram(p.id);
      if (res) svc = 'instagram';
      else { res = await lookupThreads(p.id); if (res) svc = 'threads'; }
    } else if (svc === 'instagram') res = await lookupInstagram(p.id);
    else if (svc === 'threads') res = await lookupThreads(p.id);
    else if (svc === 'x') res = await lookupX(p.id);
    else if (svc === 'tiktok') res = await lookupTikTok(p.id);

    const ms = ['instagram', 'threads', 'instagram_or_threads'].includes(svc) ? igMs(p.id) : svc === 'x' ? xMs(p.id) : ttMs(p.id);
    row.service = svc === 'instagram_or_threads' ? null : svc;
    row.time = plausible(ms, 1136073600000) ? jst(ms) : null;
    if (res) { row.username = res.username; row.url = res.url; }
    else row.error = '見つかりませんでした（削除された投稿、非公開のアカウント、または相手のサービス側の制限の可能性があります）';
    results.push(row);
  }
  return json({ results });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === API_PATH) return handleLookup(request, env);
    // run_worker_first で API_PATH 以外はここに来ないが、念のため静的ファイルへ回す
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
  },
};
