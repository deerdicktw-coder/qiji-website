#!/usr/bin/env python3
"""
sync_slots.py
--------------
Fetch real-time available booking slots from FreeTime API (aapi.myfreetime.io)
and emit slots.json for the website to display available booking windows.

Designed to run locally or inside GitHub Actions (hourly / half-hourly cron).
"""
from __future__ import annotations

import datetime as _dt
import json
import os
import sys
import urllib.error
import urllib.request

# Configuration
API_URL = "https://aapi.myfreetime.io/v1/bookings:start-times"
SHOP_ID = "14791"
OPERATOR_ID = "16270"  # 紫淇（凱莉）
SERVICE_ID = "184868"   # 主推美顏/護理課程 (120 min)
DEFAULT_TOKEN = "MmU5NTg5YjQtYjY5Zi00MjA2LTk2YjgtOTcxMzM2NDYxYzgx.RN_YoBDKYgp-mazjwdEImHzfSJt9GTISMr267fDxPQtOvpKIlVQ-PVwOAzKR"

OUTPUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "slots.json")

DAY_NAMES_TW = ["一", "二", "三", "四", "五", "六", "日"]


def fetch_start_times(auth_token: str, start_dt: _dt.datetime, end_dt: _dt.datetime) -> list[dict]:
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Content-Type": "application/json",
        "Origin": "https://myfreetime.io",
        "Referer": "https://myfreetime.io/shop/qijiskin/booking",
        "Authorization": f"Bearer {auth_token}",
    }

    payload = {
        "bookingItems": [
            {
                "customerNumber": 1,
                "consecutive": False,
                "operatorSpecified": True,
                "operatorId": OPERATOR_ID,
                "serviceItems": [
                    {
                        "serviceId": SERVICE_ID,
                        "subitems": [],
                    }
                ],
            }
        ],
        "startTime": {
            "gte": start_dt.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
            "lt": end_dt.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        },
        "providedOperatorIds": [OPERATOR_ID],
    }

    req = urllib.request.Request(
        API_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )

    with urllib.request.urlopen(req, timeout=30) as resp:
        res = json.loads(resp.read().decode("utf-8"))
        return res.get("data", [])


def group_slots(raw_data: list[dict]) -> dict:
    tz_offset = _dt.timedelta(hours=8)  # Taiwan UTC+8
    now_tw = _dt.datetime.now(_dt.timezone.utc) + tz_offset
    dates_map: dict[str, dict] = {}

    for item in raw_data:
        if not item.get("available"):
            continue

        raw_iso = item.get("startTime")
        if not raw_iso:
            continue

        # Parse UTC time
        clean_iso = raw_iso.replace("Z", "+00:00")
        utc_dt = _dt.datetime.fromisoformat(clean_iso)
        tw_dt = utc_dt + tz_offset

        # Skip past slots
        if tw_dt <= now_tw:
            continue

        date_str = tw_dt.strftime("%Y-%m-%d")
        time_str = tw_dt.strftime("%H:%M")

        if date_str not in dates_map:
            weekday_idx = tw_dt.weekday()  # 0=Monday
            dates_map[date_str] = {
                "date": date_str,
                "displayDate": f"{tw_dt.month}/{tw_dt.day}",
                "dayOfWeek": f"週{DAY_NAMES_TW[weekday_idx]}",
                "weekday": weekday_idx,
                "slots": [],
            }

        dates_map[date_str]["slots"].append(time_str)

    # Sort slots and filter dates with at least 1 slot
    sorted_dates = []
    for d in sorted(dates_map.keys()):
        dates_map[d]["slots"].sort()
        sorted_dates.append(dates_map[d])

    return {
        "active": True,
        "syncedAt": now_tw.isoformat(),
        "shopId": SHOP_ID,
        "operatorName": "紫淇（凱莉）",
        "totalAvailableDates": len(sorted_dates),
        "dates": sorted_dates,
    }


def main():
    token = os.getenv("FREETIME_AUTH_TOKEN", DEFAULT_TOKEN).strip()
    if not token:
        print("[ERROR] No auth token provided", file=sys.stderr)
        sys.exit(1)

    # Query next 21 days
    now_utc = _dt.datetime.now(_dt.timezone.utc)
    start_utc = now_utc
    end_utc = now_utc + _dt.timedelta(days=21)

    print(f"Fetching slots from {start_utc.date()} to {end_utc.date()}...")
    try:
        raw_slots = fetch_start_times(token, start_utc, end_utc)
        print(f"Fetched {len(raw_slots)} raw slots from FreeTime API.")
    except urllib.error.HTTPError as e:
        print(f"[HTTP Error] {e.code}: {e.reason}", file=sys.stderr)
        try:
            print(e.read().decode("utf-8"), file=sys.stderr)
        except Exception:
            pass
        sys.exit(1)
    except Exception as e:
        print(f"[Error] {e}", file=sys.stderr)
        sys.exit(1)

    grouped = group_slots(raw_slots)

    # Compare with existing
    existing_content = None
    if os.path.exists(OUTPUT_PATH):
        try:
            with open(OUTPUT_PATH, "r", encoding="utf-8") as f:
                existing_content = f.read()
        except Exception:
            pass

    new_content = json.dumps(grouped, ensure_ascii=False, indent=2)

    # Check if dates or slots actually changed (ignoring syncedAt)
    def clean_for_cmp(c_str):
        try:
            d = json.loads(c_str)
            d.pop("syncedAt", None)
            return json.dumps(d, sort_keys=True)
        except Exception:
            return ""

    if existing_content and clean_for_cmp(existing_content) == clean_for_cmp(new_content):
        print(f"No changes in available slots ({grouped['totalAvailableDates']} dates available).")
        # Still update syncedAt timestamp in file so site knows last check time
        with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
            f.write(new_content)
        sys.exit(78)  # 78 means no meaningful change (like sync_reviews.py)

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        f.write(new_content)

    print(f"[SUCCESS] slots.json updated with {grouped['totalAvailableDates']} dates.")
    sys.exit(0)


if __name__ == "__main__":
    main()
