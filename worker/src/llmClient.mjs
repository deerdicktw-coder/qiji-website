/**
 * 包裝 LLM 呼叫：主力用 Cloudflare Workers AI（免費額度，跟 Pages 同平台），
 * 沒有 AI binding 或呼叫失敗時，退到 Google Gemini Flash 免費層（需 env.GEMINI_API_KEY）。
 * 兩者都不可用時回傳 null，由呼叫端決定要不要轉真人。
 */

// 2026-05-30 起 @cf/meta/llama-3.1-8b-instruct 已棄用，改用同系列的量化版本（fp8），
// 行為/成本相近，是最接近原本模型的替代選項。
const WORKERS_AI_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';
// gemini-2.0-flash 已下架（改用 gemini-3.6-flash 提示），實測 2026-09-20 生效。
const GEMINI_MODEL = 'gemini-3.6-flash';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const SYSTEM_PROMPT = `你是「淇肌淨膚 QIJI」網站上的客服助理，個性親切、有溫度，QIJI 是台中北屯的手工清粉刺/皮膚管理工作室。
規則：
1. 有提供「參考資料」時，優先根據參考資料回答，不要跟參考資料矛盾。
2. 只有當使用者問的是「QIJI 專屬、必須查證的具體資訊」（例如精確報價、某天是否還有名額、預約細節、退換貨等政策），而參考資料又沒提到時，才誠實說「這部分需要請 Carrie 老師確認」，並建議加 LINE 官方帳號 @qiji 詢問。不要用這句話迴避其他問題。
3. 除了第 2 點以外的問題（例如自我介紹、閒聊、一般保養知識、皮膚保養通用建議、課程流程的一般說明），就正常憑常識與專業回答，不要因為沒有參考資料就拒答或轉真人。
4. 語氣親切、簡潔，控制在 3 句話以內，使用繁體中文。
5. 可以分享一般性的保養建議（例如乾肌怎麼挑保濕產品的通則），但不要做醫療診斷、不要保證特定療效，也不要幫使用者的膚況下確切診斷。`;

/**
 * @param {object} params
 * @param {object} params.env Pages Functions 的 env（含 AI binding / 環境變數）
 * @param {string} params.message 使用者這輪的訊息
 * @param {Array<{role:string, content:string}>} params.history 之前的對話（可空）
 * @param {string} params.ragContext 相關 FAQ 內容，當作參考資料
 * @returns {Promise<string|null>} 回覆文字，失敗回傳 null
 */
export async function generateReply({ env, message, history = [], ragContext = '' }) {
  const userContent = ragContext
    ? `參考資料：\n${ragContext}\n\n使用者問題：${message}`
    : `使用者問題：${message}\n\n（這題沒有現成的參考資料，如果是需要查證的 QIJI 專屬資訊才依規則第 2 點回覆，一般問題請直接正常回答，不要一律轉真人）`;

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.slice(-6).map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content })),
    { role: 'user', content: userContent },
  ];

  if (env && env.AI) {
    try {
      const result = await env.AI.run(WORKERS_AI_MODEL, { messages, max_tokens: 300 });
      const text = result && (result.response || result.result?.response);
      if (text && text.trim()) return text.trim();
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
      if (text && text.trim()) return text.trim();
    } catch (err) {
      console.error('Gemini 備援呼叫失敗', err);
    }
  }

  return null;
}
