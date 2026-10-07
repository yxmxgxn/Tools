#!/usr/bin/env python3
"""
TSVのURL列についてWayback Machineのスナップショットを探し、
本文を抽出してClaude Haikuで「記事として成立しているか」を判定し、
OKならWebArcive列に書き込む。

- Dateより後の、新しいスナップショットから順に試す
- スナップショットが無い／全部NGなら Save Page Now で新規保存して再判定
- 1行処理するごとに出力TSVを保存するので、途中で止めても再実行で続きから

必要: pip install requests trafilatura anthropic
環境変数: ANTHROPIC_API_KEY
"""

import argparse
import csv
import json
import os
import re
import sys
import time
from pathlib import Path

import requests
import trafilatura
from anthropic import Anthropic

MODEL = "claude-haiku-4-5"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 webarchive-checker"
CDX = "https://web.archive.org/cdx/search/cdx"
CANDIDATES = 3        # 新しい順に何個のスナップショットまで試すか
BODY_CHARS = 1500     # Haikuに渡す本文の長さ
# Haiku 4.5 の料金（USD / 100万トークン）と円換算レート。料金改定時はここを直す
PRICE_IN, PRICE_OUT = 1.00, 5.00
YEN_PER_USD = 150

usage = {"calls": 0, "in": 0, "out": 0}

session = requests.Session()
session.headers["User-Agent"] = UA


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def get(url, **kw):
    """リトライ付きGET（Waybackはよく429/5xxを返す）"""
    for attempt in range(4):
        try:
            r = session.get(url, timeout=60, **kw)
            if r.status_code in (429, 502, 503, 504):
                raise requests.HTTPError(f"HTTP {r.status_code}")
            return r
        except requests.RequestException as e:
            wait = 10 * (attempt + 1)
            log(f"    … {e} / {wait}秒待って再試行")
            time.sleep(wait)
    return None


def date_to_wayback(date):
    """'2018/02/20' や '2012/06' を '20180220' / '201206' に"""
    parts = re.findall(r"\d+", date or "")
    if not parts:
        return ""
    y = parts[0]
    m = parts[1].zfill(2) if len(parts) > 1 else ""
    d = parts[2].zfill(2) if len(parts) > 2 else ""
    return y + m + d


def find_snapshots(url, date):
    """Date以降のステータス200のスナップショットを新しい順に返す"""
    params = {
        "url": url,
        "output": "json",
        "fl": "timestamp,original",
        "filter": "statuscode:200",
        "collapse": "digest",
        "limit": f"-{CANDIDATES}",
    }
    since = date_to_wayback(date)
    if since:
        params["from"] = since
    r = get(CDX, params=params)
    if r is None or r.status_code != 200 or not r.text.strip():
        return []
    try:
        rows = r.json()[1:]  # 先頭はヘッダー
    except ValueError:
        return []
    rows.sort(key=lambda x: x[0], reverse=True)
    return [(ts, orig) for ts, orig in rows]


def save_page_now(url):
    """Save Page Nowで保存を依頼。成功したらタイムスタンプを返す"""
    log("    Save Page Nowで保存中…（1〜2分かかることがあります）")
    r = get(f"https://web.archive.org/save/{url}", allow_redirects=True)
    if r is None:
        return None
    m = re.search(r"/web/(\d{14})/", r.url) or re.search(r"/web/(\d{14})/", r.text)
    if m:
        return m.group(1)
    log(f"    ✗ 保存失敗 (HTTP {r.status_code})")
    return None


def decode_html(r):
    """文字コードを正しく判定してデコード（文字化け対策）"""
    raw = r.content
    m = re.search(rb'charset=["\']?([A-Za-z0-9_\-]+)', raw[:4096], re.I)
    candidates = []
    if m:
        candidates.append(m.group(1).decode("ascii", "ignore"))
    if r.encoding and r.encoding.lower() != "iso-8859-1":
        candidates.append(r.encoding)
    candidates += ["utf-8", "cp932", "euc-jp"]
    for enc in candidates:
        try:
            return raw.decode(enc)
        except (LookupError, UnicodeDecodeError):
            continue
    return raw.decode("utf-8", "replace")


def fetch_body(timestamp, url):
    """ツールバー無しの元HTMLを取得し、タイトルと本文を抽出"""
    raw_url = f"https://web.archive.org/web/{timestamp}id_/{url}"
    r = get(raw_url)
    if r is None or r.status_code != 200:
        return None, None
    html = decode_html(r)
    body = trafilatura.extract(html, include_comments=False, include_tables=False) or ""
    m = re.search(r"<title[^>]*>(.*?)</title>", html, re.I | re.S)
    page_title = re.sub(r"\s+", " ", m.group(1)).strip() if m else ""
    return page_title, body


def judge(client, expected_title, page_title, body):
    """Haikuで判定。(OKかどうか, 理由) を返す"""
    prompt = f"""ウェブアーカイブに保存されたページが、目的の記事として読める状態か判定してください。

目的の記事タイトル: {expected_title}
ページの<title>: {page_title}
抽出した本文（冒頭{BODY_CHARS}字、全体{len(body)}字）:
{body[:BODY_CHARS]}

OKの条件:
- 目的の記事と同じ記事である（タイトルや内容が一致する）
- 本文がある程度読める（インタビューやレポートの文章がある）

NGの例: 404やエラーページ、トップページや一覧ページへの転送、本文が無い、ログイン/会員限定の壁、文字化け

JSONだけで答えてください: {{"ok": true または false, "reason": "20字以内の理由"}}"""
    msg = client.messages.create(
        model=MODEL,
        max_tokens=100,
        messages=[{"role": "user", "content": prompt}],
    )
    usage["calls"] += 1
    usage["in"] += msg.usage.input_tokens
    usage["out"] += msg.usage.output_tokens
    text = msg.content[0].text
    m = re.search(r"\{.*\}", text, re.S)
    try:
        data = json.loads(m.group(0)) if m else {}
        return bool(data.get("ok")), str(data.get("reason", ""))
    except ValueError:
        return False, f"応答を解釈できず: {text[:40]}"


def check_snapshot(client, ts, url, title):
    page_title, body = fetch_body(ts, url)
    if body is None:
        return False, "取得失敗"
    if len(body) < 200:
        return False, f"本文が短い({len(body)}字)"
    log(f"    本文{len(body)}字 / {body[:60]}…")
    return judge(client, title, page_title, body)


def write_tsv(path, header, rows):
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, delimiter="\t", lineterminator="\n")
        w.writerow(header)
        w.writerows(rows)
    os.replace(tmp, path)


def main():
    ap = argparse.ArgumentParser(description="TSVのURLにWebarchiveを付ける（Haiku判定付き）")
    ap.add_argument("input", help="入力TSV")
    ap.add_argument("output", nargs="?", help="出力TSV（省略時は入力と同じフォルダに *_updated.tsv）")
    ap.add_argument("--no-save", action="store_true", help="スナップショットが無いときにSave Page Nowしない")
    args = ap.parse_args()

    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY が設定されていません")
    client = Anthropic()

    in_path = Path(args.input).resolve()
    out_path = Path(args.output).resolve() if args.output else in_path.with_name(in_path.stem + "_updated.tsv")
    report_path = out_path.with_name(out_path.stem + "_report.tsv")

    # 出力が既にあればそこから再開
    src = out_path if out_path.exists() else in_path
    with open(src, encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f, delimiter="\t")
        header = next(reader)
        rows = list(reader)

    col = {name: i for i, name in enumerate(header)}
    wa = col.get("WebArcive", col.get("WebArchive"))
    if wa is None or "URL" not in col:
        sys.exit("URL列またはWebArcive列が見つかりません")
    ui, di, ti = col["URL"], col.get("Date"), col.get("Title")
    for row in rows:
        row.extend([""] * (len(header) - len(row)))

    log(f"入力: {in_path}")
    log(f"出力: {out_path}")
    log(f"レポート: {report_path}" + ("（続きから再開）" if src == out_path else ""))

    report = []
    todo = [r for r in rows if r[ui].strip() and not r[wa].strip()]
    for n, row in enumerate(todo, 1):
        url = row[ui].strip()
        date = row[di].strip() if di is not None else ""
        title = row[ti].strip() if ti is not None else ""
        log(f"\n[{n}/{len(todo)}] {url}")

        result, reason = "", "スナップショットなし"
        snaps = find_snapshots(url, date)
        log(f"  Date({date})以降のスナップショット: {len(snaps)}件")
        for ts, orig in snaps:
            log(f"  {ts} を確認")
            ok, reason = check_snapshot(client, ts, orig, title)
            log(f"    → {'OK' if ok else 'NG'}: {reason}")
            if ok:
                result = f"https://web.archive.org/web/{ts}/{orig}"
                break
            time.sleep(2)

        if not result and not args.no_save:
            ts = save_page_now(url)
            if ts:
                ok, reason = check_snapshot(client, ts, url, title)
                log(f"    → 新規保存 {ts}: {'OK' if ok else 'NG'}: {reason}")
                if ok:
                    result = f"https://web.archive.org/web/{ts}/{url}"
            time.sleep(10)  # Save Page Nowは連続アクセスに厳しい

        if result:
            row[wa] = result
            log(f"  ✓ 書き込み: {result}")
        else:
            log(f"  ✗ 見送り: {reason}")
        report.append([row[col["ID"]] if "ID" in col else "", url, "OK" if result else "NG", reason, result])

        write_tsv(out_path, header, rows)
        write_tsv(report_path, ["ID", "URL", "結果", "理由", "WebArchive"], report)
        time.sleep(2)

    ok_count = sum(1 for r in report if r[2] == "OK")
    log(f"\n完了: {ok_count}/{len(report)}件 書き込み")
    log(f"NGの行は {report_path} で確認できます")
    usd = usage["in"] / 1e6 * PRICE_IN + usage["out"] / 1e6 * PRICE_OUT
    log(f"\nHaiku呼び出し: {usage['calls']}回 / 入力 {usage['in']:,} + 出力 {usage['out']:,} トークン")
    log(f"概算料金: ${usd:.4f}（約{usd * YEN_PER_USD:.1f}円）")


if __name__ == "__main__":
    main()
