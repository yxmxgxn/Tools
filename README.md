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
