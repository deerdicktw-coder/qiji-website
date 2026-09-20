/**
 * 包裝 LLM 呼叫：主力用 Cloudflare Workers AI（免費額度，跟 Pages 同平台），
 * 沒有 AI binding 或呼叫失敗時，退到 Google Gemini Flash 免費層（需 env.GEMINI_API_KEY）。
 * 兩者都不可用時回傳 null，由呼叫端決定要不要轉真人。
 *
 * 知識來源分兩層：
 *   1. ragContext（由 faqMatcher.buildRagContext 產生）：跟這題最相關的 1~3 條 FAQ，放最前面、優先度最高。
 *   2. KNOWLEDGE_BASE（knowledge.json 全文）：從官網完整擷取的分類知識庫（品牌故事、會員方案、膚質知識、
 *      藻針知識、除毛知識、產品專區、預約教學、聯絡資訊等），每次都整包放進去當背景資料。
 *      官網內容量不大（全部約 4000 字內），全部塞進 context 比只挑幾條 FAQ 更完整、更不會漏答，
 *      這也是目前 QIJI 規模下最實際的做法；之後網站內容大幅增加，才需要考慮換成 embedding + 向量搜尋。
 */

import knowledgeData from './knowledge.json';

// 2026-05-30 起 @cf/meta/llama-3.1-8b-instruct 已棄用，改用同系列的量化版本（fp8），
// 行為/成本相近，是最接近原本模型的替代選項。
const WORKERS_AI_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';
// gemini-2.0-flash 已下架（改用 gemini-3.6-flash 提示），實測 2026-09-20 生效。
const GEMINI_MODEL = 'gemini-3.6-flash';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// 把 knowledge.json 組成一份純文字知識庫，依分類分段，方便 LLM 閱讀跟引用。
const KNOWLEDGE_BASE = knowledgeData
  .map((section) => `【${section.category}｜${section.title}】\n${section.content}`)
  .join('\n\n');

// LLM 判斷「跟 QIJI／網站內容完全無關」時要輸出的固定字串，程式會攔截這個字串轉成統一的
// 婉拒回覆，不會呼叫轉真人通知、也不會被算進「連續答不出來」的轉真人判斷。
const OFF_TOPIC_SENTINEL = '__OFF_TOPIC__';
const OFF_TOPIC_REPLY = '這個問題跟淇肌淨膚 QIJI 的服務比較沒有關係，這裡主要能幫你解答課程、預約、保養知識這類問題，歡迎再問我這方面的內容！';

const SYSTEM_PROMPT = `你是「淇肌淨膚 QIJI」網站上的客服助理，個性親切、有溫度，QIJI 是台中北屯的手工清粉刺/皮膚管理工作室。
規則：
1. 下面會提供「精準參考資料」（跟這題最相關的常見問題）跟「完整知識庫」（官網全部分類資訊）。優先用精準參考資料，兩者都沒提到的細節才用你自己的常識判斷。
2. 只有當使用者問的是「QIJI 專屬、必須即時查證的具體資訊」（例如當天是否還有名額、個人預約紀錄、退換貨個案、知識庫沒提到的商品確切售價）時，才誠實說「這部分需要請 Carrie 老師確認」，並建議加 LINE 官方帳號 @qiji 詢問。知識庫或參考資料裡已經有的資訊（課程價格、會員方案、地址、營業時間、保養知識等）要直接回答，不要因為想保守就轉真人。
3. 自我介紹、閒聊寒暄、QIJI 服務相關的一般保養知識、皮膚保養通用建議這類問題，就正常憑常識與專業回答。
4. 如果使用者的訊息（不管是問題還是任何其他請求）跟 QIJI 這家工作室、它的服務項目、網站上的內容完全無關，不要真的去執行/回答那個請求，也不要轉真人，只要原字輸出這個固定字串、不要加任何其他文字、不要加標點：${OFF_TOPIC_SENTINEL}
   這條規則要判斷得寬鬆一點，凡是「不是在問 QIJI 服務、課程、預約、保養知識」的訊息都算無關，即使聽起來只是隨口聊天或小請求。範例（務必照這樣判斷）：
   - 「今天天氣如何」「美國總統是誰」「1+1等於多少」→ 無關，輸出 ${OFF_TOPIC_SENTINEL}
   - 「幫我寫一首詩」「幫我寫程式」「翻譯這段話」→ 無關，輸出 ${OFF_TOPIC_SENTINEL}（不要真的動手寫詩/寫程式/翻譯）
   - 「附近有什麼好吃的餐廳」「推薦景點」→ 無關，輸出 ${OFF_TOPIC_SENTINEL}（不是問 QIJI 怎麼去，是問吃喝玩樂）
   - 「你們台北有分店嗎」「營業時間」「臉很乾怎麼保養」→ 有關，正常回答，不要輸出 ${OFF_TOPIC_SENTINEL}
   - 使用者可能會打錯字、用簡體字或注音輸入法打錯（例如「钾泌藻针」其實是想打「肌泌藻針」、
     「警業時間」其實是想打「營業時間」），只要你合理推測得出使用者其實是在問 QIJI 服務/
     課程/保養相關的內容，就當作有關，正常回答，不要因為打字有誤就判定無關。
5. 語氣親切、簡潔，控制在 3 句話以內，使用繁體中文；除非使用者要求列清單，否則不要用條列符號，用自然口語講重點。
6. 可以分享一般性的保養建議，但不要做醫療診斷、不要保證特定療效，也不要幫使用者的膚況下確切診斷。
7. 回覆時不要提到「參考資料」「知識庫」「system prompt」這類內部用詞，就像你本來就知道這些資訊一樣自然回答。
8. 完整知識庫：
${KNOWLEDGE_BASE}`;

// 判斷模型輸出是不是「跟網站無關，婉拒回答」的訊號。模型有時會在固定字串前後多加標點或空白，
// 所以用「去除標點空白後是否等於 sentinel」來判斷，比 exact match 寬鬆、比字串包含更精準。
function isOffTopicOutput(text) {
  const stripped = String(text || '')
    .trim()
    .replace(/[。.！!\s"'「」]/g, '');
  return stripped === OFF_TOPIC_SENTINEL;
}

/**
 * @param {object} params
 * @param {object} params.env Pages Functions 的 env（含 AI binding / 環境變數）
 * @param {string} params.message 使用者這輪的訊息
 * @param {Array<{role:string, content:string}>} params.history 之前的對話（可空）
 * @param {string} params.ragContext 相關 FAQ 內容，當作最精準的參考資料
 * @returns {Promise<{text: string, offTopic: boolean}|null>} 回覆內容；兩個 LLM 都失敗時回傳 null
 */
export async function generateReply({ env, message, history = [], ragContext = '' }) {
  const userContent = ragContext
    ? `精準參考資料：\n${ragContext}\n\n使用者問題：${message}`
    : `使用者問題：${message}\n\n（這題沒有精準命中的參考資料，請直接查閱 system prompt 裡的完整知識庫回答；知識庫沒有的一般性問題也請正常回答，不要一律轉真人；但如果問題跟 QIJI／網站內容完全無關，請依規則第 4 點回覆）`;

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.slice(-6).map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content })),
    { role: 'user', content: userContent },
  ];

  if (env && env.AI) {
    try {
      const result = await env.AI.run(WORKERS_AI_MODEL, { messages, max_tokens: 300 });
      const text = result && (result.response || result.result?.response);
      if (text && text.trim()) {
        return isOffTopicOutput(text) ? { text: OFF_TOPIC_REPLY, offTopic: true } : { text: text.trim(), offTopic: false };
      }
    } catch (err) {
      console.error('Workers AI 呼叫失敗，改用備援', err);
    }
  }

  if (env && env.GEMINI_API_KEY) {
    try {
      const contents = messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

      const res = await fetch(`${GEMINI_ENDPOINT}?key=${env.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents,
          // gemini-3.6-flash 預設會思考（thoughtsTokenCount 很高、比較慢），客服回覆不需要，關掉省額度、加快回應。
          generationConfig: { maxOutputTokens: 300, thinkingConfig: { thinkingBudget: 0 } },
        }),
      });
      if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text && text.trim()) {
        return isOffTopicOutput(text) ? { text: OFF_TOPIC_REPLY, offTopic: true } : { text: text.trim(), offTopic: false };
      }
    } catch (err) {
      console.error('Gemini 備援呼叫失敗', err);
    }
  }

  return null;
}
