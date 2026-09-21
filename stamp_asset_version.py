#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 chat-widget.js 的內容雜湊寫進載入它的 <script src> 後面，當作版本號。

為什麼需要：GitHub Pages 回傳 cache-control: max-age=600，而且不能自訂標頭。
LINE 內建瀏覽器又比一般瀏覽器更黏，改完 widget 客人可能還在跑舊版，
造成「明明改了卻顯示一樣」。網址帶上內容雜湊後，檔案一變網址就變，
瀏覽器一定會重抓；檔案沒變則網址不變，快取照常生效。

用法：
    python stamp_asset_version.py          # 就地改寫，有變動時 exit 0
    python stamp_asset_version.py --check   # 只檢查不改寫，需要更新時 exit 1

由 .github/workflows/stamp-asset-version.yml 在 chat-widget.js 變動時自動執行。
"""
import hashlib
import io
import re
import sys
import glob

ASSETS = ['chat-widget.js']       # 之後要納管其他檔案，加進這個清單即可
HASH_LEN = 8


def short_hash(path):
    with open(path, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()[:HASH_LEN]


def main():
    check_only = '--check' in sys.argv
    changed = []

    for asset in ASSETS:
        try:
            digest = short_hash(asset)
        except FileNotFoundError:
            print('[stamp] 找不到 %s，略過' % asset)
            continue

        # 比對 src="/chat-widget.js" 或 src="chat-widget.js"，可帶或不帶既有的 ?v=
        pattern = re.compile(
            r'(src=["\'])(/?' + re.escape(asset) + r')(\?v=[0-9a-f]+)?(["\'])'
        )

        for html in sorted(glob.glob('*.html')):
            text = io.open(html, encoding='utf-8').read()
            new_text, n = pattern.subn(
                lambda m: '%s%s?v=%s%s' % (m.group(1), m.group(2), digest, m.group(4)),
                text,
            )
            if n and new_text != text:
                changed.append('%s -> %s?v=%s' % (html, asset, digest))
                if not check_only:
                    io.open(html, 'w', encoding='utf-8', newline='').write(new_text)

    if changed:
        for c in changed:
            print('[stamp] %s %s' % ('需要更新:' if check_only else '已更新:', c))
        sys.exit(1 if check_only else 0)

    print('[stamp] 版本號已是最新，無需變動。')
    sys.exit(0)


if __name__ == '__main__':
    main()
