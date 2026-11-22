// Cliplist（https://cliplist.yxmxgxn.workers.dev/）のWorker。
// YouTubeの好きな区間をつないで再生するプレイリストのサイト。画面は public/ の静的ファイル。
//
//   POST /api/shorten   本文 {v:1, title, loop, items:[{id,s,e,label}]} → {"code": "Ab3xK9qZ", "url": "https://…/Ab3xK9qZ"}
//   GET  /api/status    短縮が使えるか（KVが付いているか）→ {"ok": true|false}
//   GET  /<code>        短縮URL。トップと同じ画面を返し、画面が /api/clip/<code> で中身を読む
//                       （アドレス欄は短縮URLのまま。編集したら画面側で長いURLに切り替わる）
//   GET  /api/clip/<code>  短縮URLの中身 → {"code", "data": {v:1, ...}}
//   それ以外            public/ の静的ファイルを返す
//
// 短縮URLは「共有した時点のプレイリスト」を預かって短い名前を付けるだけのシェア専用URL。
// 一度発行した中身は変わらない（編集・削除はない）。中身を変えたいときは、新しく発行する。
// 長いURL（プレイリストをまるごとクエリに入れたもの）は、これまでどおりそのまま動く。
//
// 安全のための作り方
//  - 預かるのはプレイリストとして正しい中身だけ。動画ID・秒・ラベルを検査して、
//    作り直したデータだけを保存する（届いた文字列をそのまま保存しない）
//  - 同じ中身には同じ短縮コード（中身のハッシュから作る）。保存したものは書き換えない
//  - このサイトの画面からのPOSTだけを受け付ける。大きさと回数に上限を付ける
//  - KV（CLIPS）が付いていないときは、短縮は使えない（status が ok:false を返す）

const SHORTEN_PATH = '/api/shorten';
const STATUS_PATH = '/api/status';
const CLIP_RE = /^\/api\/clip\/([0-9A-Za-z]{8,12})$/;
// 短縮コードは英数字8〜12文字。静的ファイル（.を含む）やほかのページ名とは重ならない
const SHORT_RE = /^\/([0-9A-Za-z]{8,12})\/?$/;

const MAX_BODY = 32_000;
const MAX_ITEMS = 300;
const MAX_LABEL = 60;
const MAX_TITLE = 80;
const MAX_SEC = 360_000;        // 100時間。ライブ配信のアーカイブでも足りる長さ
const ID_RE = /^[A-Za-z0-9_-]{11}$/;
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const RATE_MAX = 20;            // 1人あたり、10分に発行できる回数（Workerのメモリによる簡易な制限）
const RATE_WINDOW_MS = 600_000;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });

const hits = new Map();
function rateHit(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => t > now - RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) { hits.set(ip, arr); return true; }
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return false;
}

// ---- 保存する中身（第1版） ----
// URLの文字列ではなく、データとして保存する。URLの書き方をあとで変えても、保存済みの中身は読める。
//   { v: 1, title: "", loop: false, items: [{ id, s, e, label }] }
//   id: 動画ID(11文字) / s: 開始秒 / e: 終了秒（null で最後まで）/ label: チャプター名（空なら省略）
const DATA_VERSION = 1;
const round1 = (x) => Math.round(x * 10) / 10;
// 制御文字を消して、前後の空白を落とす
const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

// 届いたデータを検査して作り直す。区間がひとつも無ければ null
export function normalizeData(d) {
  if (!d || typeof d !== 'object' || !Array.isArray(d.items)) return null;
  const items = [];
  for (const it of d.items) {
    if (items.length >= MAX_ITEMS) break;
    if (!it || !ID_RE.test(String(it.id || ''))) continue;
    let s = Number(it.s);
    if (!Number.isFinite(s) || s < 0) s = 0;
    if (s > MAX_SEC) continue;
    let e = it.e == null || it.e === '' ? null : Number(it.e);
    if (e != null && (!Number.isFinite(e) || e <= s || e > MAX_SEC)) e = null;
    const out = { id: String(it.id), s: round1(s), e: e == null ? null : round1(e) };
    const label = clean(it.label, MAX_LABEL);
    if (label) out.label = label;
    items.push(out);
  }
  if (!items.length) return null;
  const data = { v: DATA_VERSION, title: clean(d.title, MAX_TITLE), loop: d.loop === true, items };
  return data;
}

// 保存したデータから、トップページ（/）が読める長いURLのクエリ（第1版）を作る。
// 長いURLの書き方を変えたときは、ここも合わせて直せば、保存済みの短縮URLはそのまま開ける
const enc = (s) => encodeURIComponent(s).replace(/%7E/gi, '~');
export function toQueryV1(data) {
  const parts = [];
  if (data.title) parts.push('title=' + enc(data.title));
  for (const it of data.items) {
    let v = it.id + '~' + String(it.s) + '~' + (it.e == null ? '' : String(it.e));
    if (it.label) v += '~' + it.label;
    parts.push('c=' + enc(v));
  }
  if (data.loop) parts.push('loop=1');
  return parts.join('&');
}

async function codeFor(text, len) {
  const buf = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  let out = '';
  for (let i = 0; i < len; i++) { out += B62[Number(n % 62n)]; n /= 62n; }
  return out;
}

async function handleShorten(request, env) {
  if (request.method !== 'POST') return json({ error: 'POSTで送ってください' }, 405);
  if (!env || !env.CLIPS) return json({ error: '短縮URLはいま使えません' }, 503);

  const site = request.headers.get('sec-fetch-site') || '';
  if (site && site !== 'same-origin') return json({ error: 'このサイトの画面からだけ使えます' }, 403);
  const origin = request.headers.get('origin') || '';
  if (origin) {
    let oh = '';
    try { oh = new URL(origin).host; } catch (e) {}
    if (oh !== new URL(request.url).host) return json({ error: 'このサイトの画面からだけ使えます' }, 403);
  }

  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if (env.SHORTEN_LIMITER) {
    const { success } = await env.SHORTEN_LIMITER.limit({ key: ip });
    if (!success) return json({ error: '短い時間に発行しすぎです。しばらくしてからもう一度試してください' }, 429);
  }
  if (rateHit(ip)) return json({ error: '短い時間に発行しすぎです。しばらくしてからもう一度試してください' }, 429);

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ error: 'プレイリストが大きすぎます' }, 413);
  let data;
  try { data = normalizeData(JSON.parse(raw)); } catch (e) { return json({ error: '形式が正しくありません' }, 400); }
  if (!data) return json({ error: '区間がひとつもありません' }, 400);
  const canon = JSON.stringify(data);

  // 中身から短縮コードを作る。同じ中身なら同じコード。万一ほかの中身と重なったら、1文字ずつ長くする。
  // 一度保存した中身は書き換えない
  for (let len = 8; len <= 12; len++) {
    const code = await codeFor(canon, len);
    const have = await env.CLIPS.get(code);
    if (have === null) await env.CLIPS.put(code, canon);
    else if (have !== canon) continue;
    const base = new URL(request.url).origin;
    return json({ code, url: `${base}/${code}` });
  }
  return json({ error: '発行できませんでした。もう一度試してください' }, 500);
}

// 保存済みの中身を読む。無い・読めないときは null
async function loadClip(env, code) {
  if (!env || !env.CLIPS) return null;
  const raw = await env.CLIPS.get(code);
  if (raw === null) return null;
  let data = null;
  try { data = JSON.parse(raw); } catch (e) {}
  // 版ごとに読み分ける。いまは第1版だけ
  return data && data.v === 1 ? data : null;
}

const notFound = (msg) => new Response(
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>見つかりません | Cliplist</title>` +
  `<p style="font-family:sans-serif;padding:1rem">${msg}</p>` +
  `<p style="font-family:sans-serif;padding:0 1rem"><a href="/">Cliplist を開く</a></p>`,
  { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });

// 短縮URL（/<code>）。中身があれば、トップと同じ画面を返す（中身は画面が /api/clip で読む）
async function handleShort(request, env, code) {
  const data = await loadClip(env, code);
  if (!data) {
    // コードの形をしていても、保存されていなければ、ふつうのページ（静的ファイル）として扱う
    const res = env && env.ASSETS ? await env.ASSETS.fetch(request) : null;
    if (res && res.status !== 404) return res;
    return notFound('この短縮URLのプレイリストは見つかりませんでした。');
  }
  const top = new URL('/', request.url);
  return env.ASSETS.fetch(new Request(top.toString(), { method: request.method, headers: request.headers }));
}

// 短縮URLの中身。発行後は変わらないので、長めにキャッシュしてよい
async function handleClip(env, code) {
  const data = await loadClip(env, code);
  if (!data) return json({ error: '見つかりませんでした' }, 404);
  return new Response(JSON.stringify({ code, data }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=86400',
      'x-content-type-options': 'nosniff',
    },
  });
}

// 版つきデータから長いURL（第1版）を作る処理 toQueryV1 は、今は使っていないが、
// 長いURLの形を変えるときの読み替えの基準として残しておく

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === SHORTEN_PATH) return handleShorten(request, env);
    if (url.pathname === STATUS_PATH) return json({ ok: !!(env && env.CLIPS) });
    const c = url.pathname.match(CLIP_RE);
    if (c && request.method === 'GET') return handleClip(env, c[1]);
    const m = url.pathname.match(SHORT_RE);
    if (m && (request.method === 'GET' || request.method === 'HEAD')) return handleShort(request, env, m[1]);
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
  },
};
