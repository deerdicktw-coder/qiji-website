#!/usr/bin/env python3
"""
sync_reviews.py — 從 Google Places API (New) 同步最新 5 星評論到 index.html

使用 Places API (New)：
  Text Search   POST https://places.googleapis.com/v1/places:searchText
  Place Details GET  https://places.googleapis.com/v1/places/{PLACE_ID}
（舊版 Places API 已停止對新專案開放，2026/09 改用新版端點）

流程：
  1. 用地址查 Place ID（避免硬編碼，店家搬遷時自動找新的）
  2. 用 Place ID 抓評論，依發佈時間由新到舊排序，最多 5 則
  3. 過濾 rating == 5 的評論
  4. 用 HTML 標記之間替換 testimonial-grid
  5. 更新 Schema.org reviewCount + aggregateRating
  6. 更新 "N 則真實評價" 文字（兩處）

環境變數：
  GOOGLE_API_KEY  — Google Places API 金鑰（必填）
  GOOGLE_PLACE_QUERY — 搜尋字串（預設用地址，可選）

輸出：
  直接修改 index.html（in-place）；無變化時不寫檔
  退出碼 0=成功有變化, 78=無變化, 其他=錯誤
"""
# rev: 2026-09-19 Places API (New)
from __future__ import annotations

import datetime as _dt
import html as _html
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request


# === 設定 ===
DEFAULT_QUERY = "凱莉美學 台中市北屯區瀋陽路三段351-1"  # Google 商家上的店名 + 地址
INDEX_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "index.html")
GRID_START_MARK = "<!-- AUTO_REVIEW_GRID_START -->"
GRID_END_MARK = "<!-- AUTO_REVIEW_GRID_END -->"

# 評論文字長度上限（避免破板，每張卡 70 字以內）
MAX_TEXT_LEN = 70
# 取幾則評論（Google API 最多 5 則）
MAX_REVIEWS = 5


PLACES_HOST = "https://places.googleapis.com/v1"


def _request(url: str, api_key: str, field_mask: str, payload: dict | None = None) -> dict:
    """呼叫 Places API (New)。payload 為 None 時走 GET，否則 POST。"""
    headers = {
        "X-Goog-Api-Key": api_key,
        "X-Goog-FieldMask": field_mask,
        "Content-Type": "application/json",
    }
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, headers=headers,
                                 method="POST" if payload is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            msg = json.loads(body).get("error", {}).get("message", body)
        except Exception:
            msg = body
        raise RuntimeError(f"HTTP {e.code}: {msg[:300]}") from None


def find_place_id(api_key: str, query: str) -> dict:
    """Text Search (New) 找 Place ID。回傳格式沿用舊版鍵名，下游不用改。"""
    mask = ("places.id,places.displayName,places.formattedAddress,"
            "places.rating,places.userRatingCount")
    data = _request(f"{PLACES_HOST}/places:searchText", api_key, mask,
                    {"textQuery": query, "languageCode": "zh-TW",
                     "regionCode": "TW", "maxResultCount": 1})
    places = data.get("places") or []
    if not places:
        raise RuntimeError("No place found for query: " + query)
    p = places[0]
    return {
        "place_id": p.get("id", ""),
        "name": (p.get("displayName") or {}).get("text", ""),
        "formatted_address": p.get("formattedAddress", ""),
        "rating": p.get("rating", 5.0),
        "user_ratings_total": p.get("userRatingCount", 0),
    }


def get_place_details(api_key: str, place_id: str) -> dict:
    """Place Details (New) 抓評論 + 評分總數。轉成舊版欄位名。"""
    mask = "id,displayName,rating,userRatingCount,googleMapsUri,reviews"
    url = (f"{PLACES_HOST}/places/{urllib.parse.quote(place_id)}"
           "?languageCode=zh-TW&regionCode=TW")
    data = _request(url, api_key, mask)

    raw = data.get("reviews") or []
    # 新版 API 沒有 reviews_sort 參數，自行依發佈時間由新到舊排序
    raw.sort(key=lambda rv: rv.get("publishTime", ""), reverse=True)

    reviews = []
    for rv in raw:
        author = (rv.get("authorAttribution") or {}).get("displayName", "")
        # text 是翻譯後版本，originalText 是原文；優先用原文避免被翻成英文
        body = ((rv.get("originalText") or {}).get("text")
                or (rv.get("text") or {}).get("text") or "")
        reviews.append({
            "author_name": author,
            "text": body,
            "rating": rv.get("rating", 0),
            "relative_time_description": rv.get("relativePublishTimeDescription", ""),
        })

    return {
        "name": (data.get("displayName") or {}).get("text", ""),
        "rating": data.get("rating", 5.0),
        "user_ratings_total": data.get("userRatingCount", 0),
        "url": data.get("googleMapsUri", ""),
        "reviews": reviews,
    }


def filter_five_star(reviews: list) -> list:
    """過濾 5 星評論，最多 MAX_REVIEWS 則"""
    return [rv for rv in reviews if rv.get("rating") == 5][:MAX_REVIEWS]


def truncate(text: str, n: int = MAX_TEXT_LEN) -> str:
    """超過長度截掉並加 …"""
    text = (text or "").strip().replace("\n", " ").replace("\r", "")
    if len(text) <= n:
        return text
    return text[:n].rstrip() + "…"


def avatar_char(name: str) -> str:
    """取作者首字當頭像（中文取第 1 個字，英文取大寫首字母）"""
    name = (name or "").strip()
    if not name:
        return "★"
    return name[0].upper()


def render_card(review: dict) -> str:
    """產一張 testimonial-card HTML"""
    name = _html.escape(review.get("author_name", "顧客"))
    text = _html.escape(truncate(review.get("text", "")))
    when = _html.escape(review.get("relative_time_description", "Google 評論"))
    avatar = _html.escape(avatar_char(review.get("author_name", "")))
    return (
        '      <div class="testimonial-card">\n'
        '        <div class="testimonial-card-stars">&#9733;&#9733;&#9733;&#9733;&#9733;</div>\n'
        f'        <p class="testimonial-card-text">{text}</p>\n'
        '        <div class="testimonial-card-author">\n'
        f'          <div class="testimonial-card-avatar">{avatar}</div>\n'
        f'          <div><div class="testimonial-card-name">{name}</div><div class="testimonial-card-date">{when} &middot; Google 評論</div></div>\n'
        '        </div>\n'
        '      </div>'
    )


def build_grid_block(reviews: list) -> str:
    """產整個 testimonial-grid 內部內容（不含 grid div）"""
    cards = "\n".join(render_card(rv) for rv in reviews)
    return "\n" + cards + "\n    "


def update_html(html: str, reviews: list, review_count: int) -> str:
    """更新 index.html: testimonial-grid 內容 + Schema.org + 兩處數字文字"""
    n = len(reviews)
    new_html = html

    # 1. 替換 grid 區塊（marker 之間）
    pattern = re.compile(
        re.escape(GRID_START_MARK) + r"[\s\S]*?" + re.escape(GRID_END_MARK),
        re.DOTALL,
    )
    if not pattern.search(new_html):
        raise RuntimeError("找不到 AUTO_REVIEW_GRID marker，請先用 add_review_markers 改 index.html")
    grid_replacement = GRID_START_MARK + build_grid_block(reviews) + GRID_END_MARK
    new_html = pattern.sub(grid_replacement, new_html, count=1)

    # 2. 更新 Schema.org reviewCount
    new_html = re.sub(
        r'"reviewCount":\s*"\d+"',
        f'"reviewCount": "{review_count}"',
        new_html, count=1,
    )

    # 3. 更新 "N 則真實評價"
    new_html = re.sub(
        r'\d+\s*則真實評價',
        f'{review_count} 則真實評價',
        new_html, count=1,
    )

    # 4. 更新 "查看全部 N 則 Google 評論"
    new_html = re.sub(
        r'查看全部\s*\d+\s*則',
        f'查看全部 {review_count} 則',
        new_html, count=1,
    )

    # 5. 更新總覽卡 "N 則 Google 評價"
    new_html = re.sub(
        r'\d+\s*則\s*Google\s*評價',
        f'{review_count} 則 Google 評價',
        new_html, count=1,
    )

    return new_html


def main():
    api_key = os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        print("[sync_reviews] ERROR: GOOGLE_API_KEY 環境變數未設定", file=sys.stderr)
        sys.exit(1)

    query = os.environ.get("GOOGLE_PLACE_QUERY", DEFAULT_QUERY)

    # 1) 找店家
    print(f"[sync_reviews] 查詢店家: {query}")
    try:
        place = find_place_id(api_key, query)
    except Exception as e:
        print(f"[sync_reviews] Find Place 失敗: {e}", file=sys.stderr)
        sys.exit(2)
    place_id = place["place_id"]
    print(f"  店名:     {place.get('name')}")
    print(f"  地址:     {place.get('formatted_address')}")
    print(f"  Place ID: {place_id}")

    # 2) 抓詳情 + 評論
    print(f"[sync_reviews] 抓 Place Details...")
    try:
        details = get_place_details(api_key, place_id)
    except Exception as e:
        print(f"[sync_reviews] Place Details 失敗: {e}", file=sys.stderr)
        sys.exit(3)

    review_count = int(details.get("user_ratings_total", 0))
    rating = details.get("rating", 5.0)
    reviews = details.get("reviews", [])
    print(f"  星等:     {rating}")
    print(f"  總評論:   {review_count}")
    print(f"  收到:     {len(reviews)} 則")

    # 3) 過濾 5 星
    five_star = filter_five_star(reviews)
    print(f"  5 星:     {len(five_star)} 則")
    if not five_star:
        print("[sync_reviews] 沒有 5 星評論，保留原 HTML", file=sys.stderr)
        sys.exit(0)

    # 4) 讀 index.html 並更新
    if not os.path.exists(INDEX_PATH):
        print(f"[sync_reviews] ERROR: 找不到 {INDEX_PATH}", file=sys.stderr)
        sys.exit(4)
    with open(INDEX_PATH, "r", encoding="utf-8") as f:
        old_html = f.read()

    try:
        new_html = update_html(old_html, five_star, review_count)
    except Exception as e:
        print(f"[sync_reviews] 更新失敗: {e}", file=sys.stderr)
        sys.exit(5)

    if new_html == old_html:
        print("[sync_reviews] 內容無變化，不寫檔")
        sys.exit(78)

    # 5) 寫回
    with open(INDEX_PATH, "w", encoding="utf-8") as f:
        f.write(new_html)
    delta = len(new_html) - len(old_html)
    print(f"[sync_reviews] 已更新 {INDEX_PATH}  ({'+' if delta>=0 else ''}{delta} bytes)")
    print(f"  寫入 {len(five_star)} 則 5 星評論，reviewCount={review_count}")


if __name__ == "__main__":
    main()
