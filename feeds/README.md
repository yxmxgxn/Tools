# feeds

RSS がないサイトの新着を RSS にする Worker。`/<id>.xml` で配信する。

## サイトの足し方

`src/feeds.js` に1件書き足して push するだけ（セレクタの意味は同ファイルの冒頭コメント）。
一覧は `/` に出る。取得結果は30分キャッシュされるので、購読者が増えても元サイトへのアクセスは増えない。

## ローカル確認

```bash
cd feeds
npm i
npm test        # セレクタ抽出・日付・guid のテスト
npm run dev     # http://localhost:8787/helloshop-event.xml
```

## メモ

- `guid` は「リンク＋日付＋タイトル」。リンクが同じ記事が並ぶサイトでも、リーダーに1件へ畳まれない
- 日付は日本時間0時の RFC822 に変換（読めなければ省略）
- JS 描画のサイトは HTML では取れない。API の JSON を使う対応は未実装
