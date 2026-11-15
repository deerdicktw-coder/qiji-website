#!/usr/bin/env python3
"""
sync_slots.py
--------------
Fetch available booking start times from the FreeTime API (aapi.myfreetime.io)
and write slots.json for the website's 「可預約時段」 page.

Auth (set as GitHub Actions secrets, never commit them):
  FREETIME_PHONE + FREETIME_PASSWORD  -> preferred. The script logs in with
      FreeTime's phone/password login on every run, so the token renews itself.
  FREETIME_AUTH_TOKEN                 -> fallback: a Bearer token copied from a
      logged-in browser session. Expires eventually and must be replaced by hand.

Exit codes:
  0  slots changed, slots.json written
  78 no meaningful change (slots.json may still get a refreshed syncedAt)
  2  authentication failed (token expired / wrong password) -> needs a human
  1  any other error (network, API change, ...)
"""
from __future__ import annotations

import datetime as _dt
import json
import os
import sys
import urllib.error
import urllib.request

API_BASE = "https://aapi.myfreetime.io"
START_TIMES_URL = f"{API_BASE}/v1/bookings:start-times"
LOGIN_URL = f"{API_BASE}/v1/auth/tokens"
SHOP_ID = "14791"
OPERATOR_ID = "16270"  # 紫淇（凱莉）
OPERATOR_NAME = "紫淇（凱莉）"
SERVICE_ID = "184868"  # 120 分鐘課程：時段以此長度計算
DAYS_AHEAD = 21
# Re-write syncedAt even without slot changes once it is this old, so the page
# can tell "data is fresh" apart from "sync is broken" without a commit every run.
HEARTBEAT = _dt.timedelta(hours=2)

TW = _dt.timezone(_dt.timedelta(hours=8), "Asia/Taipei")
OUTPUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "slots.json")
DAY_NAMES_TW = ["一", "二", "三", "四", "五", "六", "日"]
BASE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Content-Type": "application/json",
    "Accept": "application/json",
    "Origin": "https://myfreetime.io",
    "Referer": "https://myfreetime.io/shop/qijiskin/booking",
}


class AuthError(Exception):
    pass


def _post(url: str, payload: dict, token: str | None = None) -> dict:
    headers = dict(BASE_HEADERS)
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8")[:300]
        except Exception:
            pass
        if e.code in (400, 401, 403) and (token or url == LOGIN_URL):
            raise AuthError(f"HTTP {e.code} from {url}: {body}") from e
        raise RuntimeError(f"HTTP {e.code} from {url}: {body}") from e


def _phone_variants(phone: str) -> list[str]:
    """FreeTime's web app sends E.164 (+8869xxxxxxxx); accept 09xxxxxxxx too."""
    p = phone.replace(" ", "").replace("-", "")
    out = []
    if p.startswith("09") and len(p) == 10:
        out.append("+886" + p[1:])
    elif p.startswith("8869"):
        out.append("+" + p)
    out.append(p)
    return list(dict.fromkeys(out))


def login(phone: str, password: str) -> str:
    """FreeTime phone + password login (same call as the web app's password login)."""
    last = None
    for username in _phone_variants(phone):
        try:
            res = _post(LOGIN_URL, {"provider": "basic", "username": username, "password": password})
        except (AuthError, RuntimeError) as e:  # 404 E_ROW_NOT_FOUND = no such account/format
            last = e
            continue
        token = res.get("token") or (res.get("data") or {}).get("token")
        if token:
            return token
        last = AuthError(f"login response had no token (keys: {sorted(res)})")
    raise AuthError(f"phone/password login failed: {last}")


def fetch_start_times(token: str, start: _dt.datetime, end: _dt.datetime) -> list[dict]:
    payload = {
        "bookingItems": [{
            "customerNumber": 1,
            "consecutive": False,
            "operatorSpecified": True,
            "operatorId": OPERATOR_ID,
            "serviceItems": [{"serviceId": SERVICE_ID, "subitems": []}],
        }],
        "startTime": {
            "gte": start.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
            "lt": end.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        },
        "providedOperatorIds": [OPERATOR_ID],
    }
    res = _post(START_TIMES_URL, payload, token)
    data = res.get("data")
    if not isinstance(data, list):
        raise RuntimeError(f"unexpected start-times response (keys: {sorted(res)})")
    return data


def get_slots(start: _dt.datetime, end: _dt.datetime) -> list[dict]:
    phone = os.getenv("FREETIME_PHONE", "").strip()
    password = os.getenv("FREETIME_PASSWORD", "").strip()
    token = os.getenv("FREETIME_AUTH_TOKEN", "").strip()
    if not (phone and password) and not token:
        raise AuthError("no credentials: set FREETIME_PHONE + FREETIME_PASSWORD (or FREETIME_AUTH_TOKEN)")

    if phone and password:
        print("Logging in with phone/password (auto-renewing token)...")
        try:
            return fetch_start_times(login(phone, password), start, end)
        except AuthError as e:
            if not token:
                raise
            print(f"[WARN] {e}\n       Falling back to FREETIME_AUTH_TOKEN.", file=sys.stderr)
    print("Using FREETIME_AUTH_TOKEN (will need manual renewal when it expires)...")
    return fetch_start_times(token, start, end)


def group_slots(raw: list[dict], now_tw: _dt.datetime) -> dict:
    dates: dict[str, dict] = {}
    for item in raw:
        if not item.get("available") or not item.get("startTime"):
            continue
        tw_dt = _dt.datetime.fromisoformat(item["startTime"].replace("Z", "+00:00")).astimezone(TW)
        if tw_dt <= now_tw:
            continue
        key = tw_dt.strftime("%Y-%m-%d")
        d = dates.setdefault(key, {
            "date": key,
            "displayDate": f"{tw_dt.month}/{tw_dt.day}",
            "dayOfWeek": f"週{DAY_NAMES_TW[tw_dt.weekday()]}",
            "weekday": tw_dt.weekday(),
            "slots": [],
        })
        d["slots"].append(tw_dt.strftime("%H:%M"))
    ordered = []
    for key in sorted(dates):
        dates[key]["slots"] = sorted(set(dates[key]["slots"]))
        ordered.append(dates[key])
    return {
        "active": True,
        "syncedAt": now_tw.isoformat(timespec="seconds"),
        "shopId": SHOP_ID,
        "operatorName": OPERATOR_NAME,
        "serviceMinutes": 120,
        "totalAvailableDates": len(ordered),
        "dates": ordered,
    }


def main() -> int:
    now_utc = _dt.datetime.now(_dt.timezone.utc)
    print(f"Fetching slots {now_utc.date()} .. {(now_utc + _dt.timedelta(days=DAYS_AHEAD)).date()}")
    try:
        raw = get_slots(now_utc, now_utc + _dt.timedelta(days=DAYS_AHEAD))
    except AuthError as e:
        print(f"[AUTH ERROR] {e}", file=sys.stderr)
        return 2
    except Exception as e:
        print(f"[ERROR] {e}", file=sys.stderr)
        return 1
    print(f"Fetched {len(raw)} start times.")

    new = group_slots(raw, now_utc.astimezone(TW))
    old = None
    if os.path.exists(OUTPUT_PATH):
        try:
            with open(OUTPUT_PATH, encoding="utf-8") as f:
                old = json.load(f)
        except Exception:
            old = None

    def strip(d):
        d = dict(d or {})
        d.pop("syncedAt", None)
        return json.dumps(d, sort_keys=True, ensure_ascii=False)

    changed = old is None or strip(old) != strip(new)
    try:
        last = _dt.datetime.fromisoformat(old["syncedAt"]) if old else None
        heartbeat_due = last is None or now_utc - last > HEARTBEAT
    except Exception:
        heartbeat_due = True

    if changed or heartbeat_due:
        with open(OUTPUT_PATH, "w", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(new, ensure_ascii=False, indent=2) + "\n")
    if changed:
        print(f"[SUCCESS] slots.json updated: {new['totalAvailableDates']} dates with openings.")
        return 0
    print(f"No slot changes ({new['totalAvailableDates']} dates)" + ("; refreshed syncedAt." if heartbeat_due else "."))
    return 78


if __name__ == "__main__":
    sys.exit(main())
