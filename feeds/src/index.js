import feeds from "./feeds.js";
import { extractItems, toRss } from "./feed.js";

const TTL = 1800; // 秒。この間は元サイトを取りに行かずキャッシュを返す

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    const id = pathname.replace(/^\/|\.xml$/g, "");

    if (!id) {
      const list = feeds.map((f) => `<li><a href="/${f.id}.xml">${f.name}</a></li>`).join("");
      return new Response(`<!doctype html><meta charset="utf-8"><title>feeds</title><ul>${list}</ul>`, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    const def = feeds.find((f) => f.id === id);
    if (!def) return new Response("not found", { status: 404 });

    const cache = caches.default;
    const hit = await cache.match(request);
    if (hit) return hit;

    const res = await fetch(def.url, { headers: { "user-agent": "Mozilla/5.0 (feeds; personal use)" } });
    if (!res.ok) return new Response(`upstream ${res.status}`, { status: 502 });

    const items = extractItems(def, await res.text());
    const out = new Response(toRss(def, items), {
      headers: {
        "content-type": "application/rss+xml; charset=utf-8",
        "cache-control": `public, max-age=${TTL}`,
      },
    });
    ctx.waitUntil(cache.put(request, out.clone()));
    return out;
  },
};
