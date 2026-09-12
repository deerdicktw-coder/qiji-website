#!/usr/bin/env python3
"""
sync_promotion.py
-----------------
Fetch the freetime reservation page, extract the shop's topBanner
(window.__INITIAL_STATE__.order.shop.topBanner) and emit promotion.json
for the site to consume.

Designed to run locally or inside a GitHub Action (hourly cron).

Output schema (promotion.json):
{
  "active": bool,
  "syncedAt": "ISO8601 UTC",
  "source": "freetime",
  "sourceUrl": "...",
  "topBanner": {
    "show": bool,
    "title": str,
    "body": str,
    "photoUrl": str
  },
  "parsed": {
    "startDate": "YYYY-MM-DD" | null,
    "endDate":   "YYYY-MM-DD" | null,
    "shortTitle": str | null
  },
  "priceList": [
    {"id": str, "url": str, "previewUrl": str, "displayOrder": int},
    ...
  ]
}
"""
from __future__ import annotations

import datetime as _dt
import json
import os
import re
import sys
import urllib.request

FREETIME_URL = "https://myfreetime.io/shop/qijiskin"
OUTPUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "promotion.json")


def fetch_html(url, timeout=30):
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; qiji-skin-sync/1.0; +https://qiji-skin.com)",
            "Accept-Language": "zh-TW,zh;q=0.9",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    enc = resp.headers.get_content_charset() or "utf-8"
    return raw.decode(enc, errors="replace")


def extract_initial_state(html):
    marker = "window.__INITIAL_STATE__"
    idx = html.find(marker)
    if idx == -1:
        raise RuntimeError("window.__INITIAL_STATE__ not found in HTML")
    eq = html.find("=", idx)
    if eq == -1:
        raise RuntimeError("assignment '=' not found after __INITIAL_STATE__")
    j = eq + 1
    while j < len(html) and html[j].isspace():
        j += 1
    if j >= len(html) or html[j] != "{":
        raise RuntimeError("expected '{' after __INITIAL_STATE__ =")
    decoder = json.JSONDecoder()
    obj, _end = decoder.raw_decode(html[j:])
    return obj


def parse_date_range(body):
    if not body:
        return None, None
    text = body.replace("\u301c", "-").replace("\u2014", "-").replace("\u2013", "-")

    # 標籤：活動期間／活動時間／期間／時間／日期（前面可能有 emoji 或空白）
    LABEL = (
        r"(?:\u6d3b\u52d5\u671f\u9593|\u6d3b\u52d5\u6642\u9593|"
        r"\u671f\u9593|\u6642\u9593|\u65e5\u671f)[\s:\uff1a]*"
    )

    pat_slash = re.compile(
        LABEL
        + r"(?:(\d{4})[/\.])?(\d{1,2})[/\.](\d{1,2})"
        r"\s*-\s*"
        r"(?:(\d{4})[/\.])?(\d{1,2})[/\.](\d{1,2})"
    )
    m = pat_slash.search(text)
    if m:
        y1, mo1, d1, y2, mo2, d2 = m.groups()
        now = _dt.datetime.now()
        y1 = int(y1) if y1 else now.year
        y2 = int(y2) if y2 else y1
        try:
            start = _dt.date(y1, int(mo1), int(d1))
            end = _dt.date(y2, int(mo2), int(d2))
            return start.isoformat(), end.isoformat()
        except ValueError:
            pass

    pat_cjk = re.compile(
        LABEL
        + r"(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日"
        r"\s*-\s*"
        r"(?:(\d{4})\u5e74)?(\d{1,2})\u6708(\d{1,2})\u65e5"
    )
    m = pat_cjk.search(text)
    if m:
        y1, mo1, d1, y2, mo2, d2 = m.groups()
        now = _dt.datetime.now()
        y1 = int(y1) if y1 else now.year
        y2 = int(y2) if y2 else y1
        try:
            start = _dt.date(y1, int(mo1), int(d1))
            end = _dt.date(y2, int(mo2), int(d2))
            return start.isoformat(), end.isoformat()
        except ValueError:
            pass

    # 保底：沒有標籤時，抓文字裡第一組完整的 YYYY/MM/DD - YYYY/MM/DD
    pat_bare = re.compile(
        r"(\d{4})[/\.-](\d{1,2})[/\.-](\d{1,2})"
        r"\s*-\s*"
        r"(\d{4})[/\.-](\d{1,2})[/\.-](\d{1,2})"
    )
    m = pat_bare.search(text)
    if m:
        y1, mo1, d1, y2, mo2, d2 = m.groups()
        try:
            start = _dt.date(int(y1), int(mo1), int(d1))
            end = _dt.date(int(y2), int(mo2), int(d2))
            return start.isoformat(), end.isoformat()
        except ValueError:
            pass

    return None, None


def extract_short_title(title):
    if not title:
        return None
    m = re.search(r"\u3010([^\u3011]+)\u3011", title)
    return m.group(1) if m else None


def extract_price_list(shop):
    images = shop.get("images") or []
    price_list = []
    for img in images:
        if not isinstance(img, dict):
            continue
        if img.get("type") != "PRICE_LIST":
            continue
        if img.get("enabled") is False:
            continue
        url = (img.get("url") or "").strip()
        if not url:
            continue
        price_list.append({
            "id": str(img.get("id") or ""),
            "url": url,
            "previewUrl": (img.get("previewUrl") or "").strip(),
            "displayOrder": int(img.get("displayOrder") or 0),
        })
    price_list.sort(key=lambda x: x["displayOrder"])
    return price_list


def build_promotion(state):
    shop = (state.get("order") or {}).get("shop") or {}
    banner = shop.get("topBanner") or {}
    show = bool(banner.get("show"))
    title = (banner.get("title") or "").strip()
    body = (banner.get("body") or "").strip()
    photo = (banner.get("photoUrl") or "").strip()

    start_iso, end_iso = parse_date_range(body) if (show and body) else (None, None)

    active = show and bool(title or body)
    if active and end_iso:
        try:
            end_date = _dt.date.fromisoformat(end_iso)
            if end_date < _dt.date.today():
                active = False
        except ValueError:
            pass

    now_iso = _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")

    return {
        "active": active,
        "syncedAt": now_iso,
        "source": "freetime",
        "sourceUrl": FREETIME_URL,
        "topBanner": {
            "show": show,
            "title": title,
            "body": body,
            "photoUrl": photo,
        },
        "parsed": {
            "startDate": start_iso,
            "endDate": end_iso,
            "shortTitle": extract_short_title(title),
        },
        "priceList": extract_price_list(shop),
    }


def main():
    try:
        html = fetch_html(FREETIME_URL)
    except Exception as e:
        print("[sync_promotion] fetch failed:", e, file=sys.stderr)
        sys.exit(1)

    try:
        state = extract_initial_state(html)
    except Exception as e:
        print("[sync_promotion] parse failed:", e, file=sys.stderr)
        sys.exit(2)

    # 防呆：若頁面沒有店家資料（網址失效、改版、被擋），直接失敗，
    # 不要把既有的 promotion.json 洗成空的。
    shop = (state.get("order") or {}).get("shop") or {}
    if not shop.get("id") and not shop.get("name"):
        print(
            "[sync_promotion] shop object empty at %s - refusing to overwrite promotion.json"
            % FREETIME_URL,
            file=sys.stderr,
        )
        sys.exit(3)

    data = build_promotion(state)

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print("[sync_promotion] wrote", OUTPUT_PATH)
    print("  active=", data["active"], " title=", repr(data["topBanner"]["title"]))
    print("  parsed=", data["parsed"])
    print("  priceList=", len(data["priceList"]), "items")
    for p in data["priceList"]:
        print("    [%d] id=%s  %s" % (p["displayOrder"], p["id"], p["url"]))


if __name__ == "__main__":
    main()
