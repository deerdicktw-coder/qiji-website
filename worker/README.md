# QIJI AI 客服後端（Cloudflare Worker）

這是「淇肌淨膚 QIJI」網站 AI 智能客服的後端 API，獨立部署成 Cloudflare Worker
（不是 Cloudflare Pages Functions）。

## 為什麼獨立部署

正式站 `qiji-skin.com` 是 GitHub Pages（純靜態），無法跑任何後端程式碼。
所以這支 API 另外部署成一個獨立的 Cloudflare Worker，網站前端的 `chat-widget.js`
用完整跨網域網址呼叫它（`https://qiji-ai-customer-service.<你的子網域>.workers.dev/api/chat`），
Worker 端用 CORS 只允許 `qiji-skin.com` / `www.qiji-skin.com` / GitHub Pages 網域呼叫，
避免被其他網站盜用消耗免費額度。

目前已部署的網址：`https://qiji-ai-customer-service.deerdick-tw.workers.dev`
（`chat-widget.js` 裡的 `API_ENDPOINT` 就是指到這個網址，兩邊要保持一致。）

## 檔案結構

```
src/
  index.js          Worker 入口（路由、CORS、限流、轉真人邏輯）
  faqMatcher.mjs     FAQ 關鍵字比對 + RAG context 組裝
  llmClient.mjs      呼叫 Cloudflare Workers AI（主）／Gemini（備援），組裝完整知識庫當 system prompt
  notify.mjs         轉真人時用 Resend 寄信通知
  faq.json           精準常見問題（命中就直接回覆，不呼叫 LLM，最快最省）
  knowledge.json     完整知識庫（官網全部內容分類彙整，每次呼叫 LLM 都整包當背景資料）
wrangler.toml        Worker 設定（名稱、AI binding）
.dev.vars.example    本機測試用環境變數範本
```

## 知識庫分兩層（為什麼要這樣設計）

一開始只有 `faq.json`（幾十條手動挑的問答），靠關鍵字比對命中才回答，沒命中的問題一律轉真人 ——
問題是官網實際內容遠比這幾十條豐富（完整課程價格、除毛部位報價、三種會員方案、保養品專區、
品牌故事、膚質衛教知識、預約教學等），漏掉的內容問了就只能轉真人，等於沒發揮 AI 的用處。

現在改成業界常見的「精準比對 + 全量知識庫」兩層做法：

1. **`faq.json`**：高頻率、需要 100% 精確回覆的問題（課程價格、地址、營業時間等），
   命中就直接回傳答案，不呼叫 LLM，速度最快、也最省 Workers AI 的免費額度。
2. **`knowledge.json`**：從官網完整擷取、依分類整理的知識庫（品牌介紹、服務項目總覽、
   會員方案、膚質知識、藻針知識、粉刺知識、保養知識、除毛知識、保養品專區、預約流程、聯絡資訊），
   每次呼叫 LLM（Workers AI／Gemini）都會整包放進 system prompt 當背景資料。
   因為 QIJI 網站內容量不大（全部知識庫壓縮後約 4000 字），整包塞進去比只挑幾條 FAQ 更完整、
   更不容易漏答，這是目前規模下最實際的做法。之後若網站內容大幅增加（例如上百篇文章），
   才需要考慮換成 embedding + 向量搜尋（Cloudflare Vectorize），屆時只要改 `llmClient.mjs`
   組 context 的方式，`faqMatcher.mjs` 的介面不用動。

## 常見問題 / 知識庫怎麼更新

- 想讓某個問題「秒回、不經過 LLM」：編輯 `src/faq.json`，每筆包含 `id`、`category`、
  `question`、`keywords[]`、`answer`、`updatedAt`。`keywords` 建議放「正式說法」跟
  「口語說法」（例如「怎麼過去」「怎麼走」「在哪」都放進去），比對效果會比較好。
  **新增關鍵字時注意別跟其他條目的關鍵字撞在一起**（例如兩條都用「五行罐撥」當關鍵字，
  會互搶答案）——關鍵字盡量具體、不要用太籠統的單詞。
- 想讓 AI「知道某個新資訊但不用到逐字精準回覆」：編輯 `src/knowledge.json`，
  依現有分類加一段，或新增一個分類段落（`id`、`category`、`title`、`content`）。
  這個檔案不需要設計關鍵字，因為每次都整包給 LLM 看。
- 官網內容有大改版時，建議兩個檔案都重新核對一次，確保金額、政策沒有過時。
- 改完直接照下面步驟重新部署即可，不需要改程式邏輯。

## 部署方式

需要一個有 **Workers Scripts: Edit** 權限的 Cloudflare API Token
（在 https://dash.cloudflare.com/profile/api-tokens 建立，選「Edit Cloudflare Workers」範本），
以及帳戶的 Account ID（Cloudflare Dashboard 右側欄可以看到）。

```bash
cd worker
export CLOUDFLARE_API_TOKEN="你的 token"
export CLOUDFLARE_ACCOUNT_ID="你的 account id"
npx wrangler deploy
```

部署完成後 wrangler 會印出網址，理論上每次都會是同一個網址
（`https://qiji-ai-customer-service.<子網域>.workers.dev`），不需要另外改前端。

## LLM 備援 / 轉真人通知的環境變數

目前已設定（2026-09-20），Gemini 備援跟轉真人 Email 通知都是啟用狀態。
沒設定也能運作（FAQ 比對 + Cloudflare Workers AI 主模型都是免費額度內），
但沒設定 Gemini 備援的話，如果 Workers AI 那天暫時出問題就會直接轉真人。

```bash
npx wrangler secret put GEMINI_API_KEY      # Google AI Studio 免費金鑰
npx wrangler secret put RESEND_API_KEY      # Resend 免費額度，用於轉真人寄信通知
npx wrangler secret put NOTIFY_EMAIL_TO
npx wrangler secret put NOTIFY_EMAIL_FROM
```

## 本機測試

`[ai]` binding 需要連線 Cloudflare（本機沒有模型可跑），非互動環境下本機測試前
先把 `wrangler.toml` 裡的 `[ai]` / `binding = "AI"` 兩行註解掉，測完再復原：

```bash
npx wrangler dev --port 8792
```

## 維護紀錄

- 2026-09-20：`@cf/meta/llama-3.1-8b-instruct` 已於 2026-05-30 被 Cloudflare 棄用，
  改用 `@cf/meta/llama-3.1-8b-instruct-fp8`（同系列量化版本）。之後若又收到
  「已經幫您轉接給 Carrie 老師」出現頻率異常高的回報，第一步先用
  `npx wrangler tail` 看即時 log，確認是不是又有模型被棄用。
- 2026-09-20：同一天發現 Gemini 備援的 `gemini-2.0-flash` 也已下架，改用
  `gemini-3.6-flash`，並加上 `thinkingConfig: { thinkingBudget: 0 }`
  關掉思考模式（不然回覆會變慢、且多耗費不必要的 token）。同時設定好
  `GEMINI_API_KEY`、`RESEND_API_KEY`、`NOTIFY_EMAIL_TO`、`NOTIFY_EMAIL_FROM`
  四個 Worker secrets，Gemini 備援跟轉真人 Email 通知都已經是可運作狀態。
  之後若這兩個模型又被下架，用同樣方式去 Cloudflare / Google 官方文件查目前
  可用的模型 id 即可，程式邏輯不用動。
- 2026-09-20：新增 `knowledge.json` 完整知識庫（品牌介紹、會員方案、膚質/藻針/粉刺/
  保養知識、除毛知識、保養品專區、預約教學、聯絡資訊），並讓 `llmClient.mjs` 每次都把
  整份知識庫放進 system prompt。原因是原本只有 `faq.json` 的幾十條問答，官網其實還有
  完整課程與除毛報價、三種會員方案細節、保養品清單等大量內容沒被 AI 知道，問到就只能
  轉真人。同時修正 `faq.json` 裡「會員和儲值有什麼差別」這條，原本漏了月費方案的實際
  折扣數字。之後官網若新增大分類內容（例如新課程、新的知識文章），比照 `knowledge.json`
  現有格式加一段即可。
