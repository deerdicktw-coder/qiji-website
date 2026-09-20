/**
 * 包裝 LLM 呼叫：主力用 Cloudflare Workers AI（免費額度，跟 Pages 同平台），
 * 沒有 AI binding 或呼叫失敗時，退到 Google Gemini Flash 免費層（需 env.GEMINI_API_KEY）。
 * 兩者都不可用時回傳 null，由呼叫端決定要不要轉真人。
 */

// 2026-05-30 起 @cf/meta/llama-3.1-8b-instruct 已棄用，改用同系列的量化版本（fp8），
// 行為/成本相近，是最接近原本模型的替代選項。
const WORKERS_AI_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';
const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const SYSTEM_PROMPT = `你是「淇肌淨膚 QIJI」的網站客服助理，QIJI 是台中北屯的手工清粉刺/皮膚管理工作室。
規則：
1. 只根據下面提供的「參考資料」回答，不要編造課程內容、價格或政策。
2. 參考資料沒有提到的細節（例如精確報價、特定日期是否有空檔），請誠實說「這部分需要請 Carrie 老師確認」，並建議加 LINE 官方帳號 @qiji 詢問。
3. 語氣親切、簡潔，控制在 3 句話以內，使用繁體中文。
4. 不要主動提供醫療診斷或保證療效。`;

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
    : `使用者問題：${message}\n\n（目前沒有相關的參考資料，請依規則第 2 點誠實回覆）`;

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
          generationConfig: { maxOutputTokens: 300 },
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
