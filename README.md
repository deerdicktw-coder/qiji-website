# 淇肌淨膚 QIJI — 網站專案

台中北屯｜手工清粉刺・肌膚保養
正式站：<https://qiji-skin.com>

---

## 目錄結構

這個資料夾同時是 **Git repo 的工作副本**。根目錄放的東西 = 會被部署到網站上的東西；
不會上線的工作檔案一律收在 `_workspace/`（已列入 `.gitignore`，不進版控）。

```
D:\claud QIJI\
│
├── index.html            單頁式網站本體（約 440 KB，含所有 CSS/JS）
├── reviews.html          評價頁
├── landing.css           少數獨立樣式
├── sw.js                 Service Worker
├── manifest.json         PWA 設定
├── promotion.json        本月活動資料（由 GitHub Actions 每小時同步）
├── sitemap.xml           SEO 網站地圖（33 個網址）
├── robots.txt            搜尋引擎索引規則
├── CNAME                 自訂網域設定（qiji-skin.com）
│
├── audio/                背景音樂 16 首（128 kbps，共 46 MB）
├── images/               網站圖片（70 檔）
├── knowledge/            知識文章頁（SEO 著陸頁）
├── services/             服務項目頁（SEO 著陸頁）
├── boss.png              店主照片
├── og-image.jpg          社群分享縮圖
├── salon.jpg             店內照
├── favicon.svg           分頁圖示
│
├── sync_promotion.py     ⚠ GitHub Actions 依路徑呼叫，勿移動
├── sync_reviews.py       ⚠ GitHub Actions 依路徑呼叫，勿移動
├── deploy.sh             部署腳本（讀 data/tokkk.txt，勿移動）
├── data/                 GitHub Token 等機密（.gitignore）
│
├── .github/workflows/    自動化排程
└── _workspace/           本機工作區（.gitignore，不會上線）
    ├── assets/           設計原始檔（品牌物料：Logo、海報、素材）
    ├── audio-src/        音樂原始檔 256 kbps（網站用的是壓過的 128 kbps）
    ├── backups/          index.html 歷次備份
    ├── archive/          舊版封存
    ├── prototypes/       測試頁與設計示範頁
    └── tools/            零星工具腳本與舊筆記
```

---

## 為什麼這樣分

**根目錄 = 部署內容。** 這是 Git 專案的通則：repo 根目錄只放產品本身，
一眼就能看出「網站有哪些東西」。

**三個檔案不能移動：**

| 檔案 | 原因 |
|---|---|
| `sync_promotion.py` | GitHub Actions 以 `python sync_promotion.py` 從根目錄執行，且 `paths:` 觸發條件寫死此路徑 |
| `sync_reviews.py` | 同上 |
| `deploy.sh` | 內部以 `SCRIPT_DIR/data/tokkk.txt` 與 `SCRIPT_DIR/index.html` 定位，移動後會找不到 |

**`_workspace/` 全部忽略版控。** 裡面 250 MB 的設計原始檔、備份、音樂原檔都不該進 repo：
它們不是網站的一部分，上傳只會拖慢每次 clone，而且 GitHub 對單一檔案有 100 MB 上限。

---

## 部署方式

```bash
bash deploy.sh "commit 訊息"
```

腳本會自動更新版本號、取得遠端 SHA、推送 `index.html`。
Cloudflare Pages 收到 GitHub 的變更後會自動重新建置，約需 1–2 分鐘。

部署前務必先備份：`cp index.html _workspace/backups/index_備份_$(date +%Y%m%d_%H%M).html`

---

## 音樂授權

`audio/` 內 16 首皆取自 [Pixabay](https://pixabay.com/music/)，
採 Pixabay Content License：可商用、免標註出處。
檔名保留 Pixabay 原始編號（如 `-517098`），可回溯授權來源。

原始 256 kbps 檔案保存在 `_workspace/audio-src/原始檔_256k/`，
網站使用的是壓縮為 128 kbps 的版本（背景音樂用途，聽感無差異，流量減半）。
