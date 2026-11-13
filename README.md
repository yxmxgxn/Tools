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
- 回数制限は、Workerのメモリによる簡易なものだけ。本格的に止めるときは、Cloudflareのダッシュボードで `/sns-account-lookup/api` にレート制限ルールを付ける。

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
