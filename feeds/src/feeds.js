// サイトを足すときはここに1つ書き足すだけ。
//   id      … 配信URL（/<id>.xml）
//   url     … 一覧ページ
//   item    … 記事1件を囲む要素のCSSセレクタ
//   title / link / date / description … item の中でのセレクタ（link は href、他は文字列）
//   clean   … タイトルの整形（省略可）
export default [
  {
    id: "helloshop-event",
    name: "ハロショ イベント",
    url: "https://www.helloshop.info/category/news/event",
    item: ".postNav + ul > li",
    title: ".title",
    link: "a",
    date: ".date",
    clean: (t) => t.replace(/NEW!$/, ""),
  },
  {
    id: "upfc-news",
    name: "ハロプロFC ニュース",
    url: "https://www.upfc.jp/helloproject/news_list.php",
    item: '[data-category="ctg00"] .news_ul > li',
    title: ".news__txt",
    link: "a",
    date: ".news__date",
  },
];
