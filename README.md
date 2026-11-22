# Hello! Tools

ブラウザだけで完結する小さなウェブツール置き場。Cloudflare Workers で配信する静的サイト（https://tools.yxmxgxn.workers.dev/）。

## 構成

```
tools/
├─ index.html          … トップ（ツール一覧）
├─ assets/
│  └─ common.css       … 全ツール共通のスタイル
└─ post-context/
   └─ index.html       … Xポスト前後検索  → /post-context/
```

## 例外：サーバーで動く部分

ほとんどのツールは静的だが、`sns-account-lookup`（投稿URLからアカウントを調べる）だけは、SNSに問い合わせるためにサーバー側の処理が要る。

- `worker/index.js` … Cloudflare Worker。`/sns-account-lookup/api` のリクエストだけを処理する（`wrangler.jsonc` の `assets.run_worker_first` で指定）。それ以外のパスは、これまでどおり静的ファイルをそのまま返す。
- `worker/` は配信用の `public/` には入れない（`build/build.sh` で除外）。
- 回数制限は、`wrangler.jsonc` の `ratelimits`（Cloudflareの Rate Limiting バインディング）で、1人あたり60秒に8回（`LOOKUP_LIMITER`）、全体で60秒に120回（`LOOKUP_GLOBAL`）。あわせて、Workerのメモリによる簡易な制限もある。拠点ごとの数え上げなので、きっちりした数ではない。

## 別サイト：Cliplist（sites/cliplist）

YouTubeの好きな区間をつないで再生するプレイリストのサイト（https://cliplist.yxmxgxn.workers.dev/）。
ツール集とは別の Worker として、同じリポジトリから配信する。ツール集のビルド（`build/build.sh`）には含めない。

```
sites/cliplist/
├─ wrangler.jsonc      … Worker の設定（名前 cliplist）
├─ worker/index.js     … 短縮URL（/<コード>）と /api/shorten・/api/status。それ以外は public/ を返す
└─ public/             … 画面（index.html）・OGP画像・共通CSSとファビコンの写し
```

- デプロイは `.github/workflows/deploy.yml` が、ツール集の前に `sites/cliplist` で `wrangler deploy` する。
- **URLの互換性**: 長いURL `/?c=動画ID~開始秒~終了秒~チャプター名` は第1版として固定。形を変えるときは版の印（`v=2` など）を付け、印の無いURLは第1版としてずっと読めるようにする。
- **短縮URL**は「共有した時点で固定するシェア専用URL」。編集・削除はない。中身は版つきのデータ `{v:1, title, loop, items:[{id,s,e,label}]}` で KV に保存し、開かれたら長いURL（第1版）へ転送する。同じ中身なら同じコード。
- 短縮URLの保存先 KV は、Cloudflare で作ったあと、`sites/cliplist/wrangler.jsonc` の `kv_namespaces`（バインディング名 `CLIPS`）に ID を書く。付いていない間は短縮ボタンが出ないだけで、長いURLはそのまま動く。

## 新しいツールの足し方

1. `ツール名/index.html` を作る（`/assets/common.css` を読み込む）
2. `index.html`（トップ）の `.tool-grid` にカードを1つ追加
3. commit して push すれば Cloudflare Pages が自動デプロイ

## Cloudflare Pages 設定（初回のみ）

- Framework preset: **None**
- Build command: **（空欄）**
- Build output directory: **`/`**

## ローカル確認

パスが `/assets/...` の絶対指定なので、`file://` で直接開くとCSSが当たらない。
簡易サーバー経由で見ること:

```bash
python -m http.server 8000
# → http://localhost:8000/
```
