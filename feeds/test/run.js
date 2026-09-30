import assert from "node:assert/strict";
import { extractItems, toRss } from "../src/feed.js";

const helloshop = `<div class="postNav"></div><ul>
<li><a href="https://www.helloshop.info/news/event/20260921_209966.html"><div class="date">更新日：<br>2026年9月21日</div>
<div class="title">大阪店開催イベント<span class="new">NEW!</span></div></a>
<div class="cate"><a href="/category/shops">店舗</a></div></li>
<li><a href="https://www.helloshop.info/news/event/20260917_209847.html"><div class="date">更新日：<br>2026年9月17日</div>
<div class="title">二人会 &amp; 配信</div></a></li></ul><ul><li><a href="/x"><div class="title">別のul</div></a></li></ul>`;
const def1 = {
  id: "h", name: "h", url: "https://www.helloshop.info/category/news/event",
  item: ".postNav + ul > li", title: ".title", link: "a", date: ".date",
  clean: (t) => t.replace(/NEW!$/, ""),
};
const a = extractItems(def1, helloshop);
assert.equal(a.length, 2);
assert.equal(a[0].title, "大阪店開催イベント");
assert.equal(a[0].link, "https://www.helloshop.info/news/event/20260921_209966.html");
assert.equal(a[0].pubDate, "Sun, 20 Sep 2026 15:00:00 GMT"); // 日本時間9/21 0:00

const upfc = `<div data-category="ctg00"><ul class="news_ul">
<li><a href="/helloproject/news_detail.php?@uid=A"><p class="news__date">2026.09.29<span>イベント</span></p><p class="news__txt">記事A</p></a></li></ul></div>
<div data-category="ctg05"><ul class="news_ul">
<li><a href="https://www.upfc.jp/fan_sp_info.php"><p class="news__date">2026.09.16</p><p class="news__txt">SP更新</p></a></li>
<li><a href="https://www.upfc.jp/fan_sp_info.php"><p class="news__date">2026.09.15</p><p class="news__txt">SP更新</p></a></li></ul></div>`;
const def2 = { id: "u", name: "u", url: "https://www.upfc.jp/helloproject/news_list.php",
  item: '[data-category="ctg05"] .news_ul > li', title: ".news__txt", link: "a", date: ".news__date" };
const b = extractItems(def2, upfc);
assert.equal(b.length, 2);
assert.notEqual(b[0].guid, b[1].guid); // 同じリンクでも guid は別
assert.equal(extractItems({ ...def2, item: '[data-category="ctg00"] .news_ul > li' }, upfc)[0].link,
  "https://www.upfc.jp/helloproject/news_detail.php?@uid=A");

const xml = toRss(def1, a);
assert.match(xml, /<title>二人会 &amp; 配信<\/title>/);
console.log("ok");
