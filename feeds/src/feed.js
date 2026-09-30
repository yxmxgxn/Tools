import { parse } from "node-html-parser";

const text = (el) => (el?.text ?? "").replace(/\s+/g, " ").trim();

const esc = (s) =>
  s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);

// "2026年9月21日" "2026.09.29" などを日本時間0時のRFC822日付にする。読めなければ null
function toRfc822(s) {
  const m = s.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], -9)).toUTCString();
}

export function extractItems(def, html) {
  const root = parse(html);
  return root.querySelectorAll(def.item).map((el) => {
    const href = el.querySelector(def.link)?.getAttribute("href");
    const link = href ? new URL(href, def.url).href : def.url;
    let title = text(el.querySelector(def.title));
    if (def.clean) title = def.clean(title).trim();
    const dateText = def.date ? text(el.querySelector(def.date)) : "";
    const description = def.description ? text(el.querySelector(def.description)) : "";
    // リンクが同じ記事が並ぶサイトでも別記事として扱えるよう、guid は日付とタイトルも混ぜる
    const guid = `${link}#${dateText}#${title}`;
    return { title, link, guid, pubDate: toRfc822(dateText), description: description || dateText };
  }).filter((i) => i.title);
}

export function toRss(def, items) {
  const body = items.map((i) => `    <item>
      <title>${esc(i.title)}</title>
      <link>${esc(i.link)}</link>
      <guid isPermaLink="false">${esc(i.guid)}</guid>${i.pubDate ? `
      <pubDate>${i.pubDate}</pubDate>` : ""}${i.description ? `
      <description>${esc(i.description)}</description>` : ""}
    </item>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${esc(def.name)}</title>
    <link>${esc(def.url)}</link>
    <description>${esc(def.name)}</description>
${body}
  </channel>
</rss>
`;
}
