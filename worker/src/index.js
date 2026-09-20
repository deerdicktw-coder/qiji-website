import faqData from './faq.json';
import { matchFaq, buildRagContext } from './faqMatcher.mjs';
import { generateReply } from './llmClient.mjs';
import { notifyHandoff } from './notify.mjs';

/**
 * 獨立的 Cloudflare Worker（不是 Pages Functions）。
 *
 * 為什麼要獨立出來：qiji-skin.com 正式站其實是 GitHub Pages 架設（server: GitHub.com，
 * 實測確認過），不是 Cloudflare Pages，GitHub Pages 純靜態、不能跑任何後端程式碼。
 * 所以這支 API 另外部署成一個獨立的 Worker，前端 chat-widget.js 用完整網址（跨網域）呼叫它，
 * 靠 CORS 允許 qiji-skin.com 讀取回應。正式站完全不用搬家，維持原本 GitHub Pages 架構。
 */

const MAX_MESSAGE_LENGTH = 2000;
const HANDOFF_KEYWORDS = ['真人', '客服人員', '找老師', '找凱莉', '找carrie', '投訴', '客訴', '生氣', '不滿意', '退費', '打電話'];
// 轉真人的通知是寄 Email，凱莉不會馬上看到，所以轉真人訊息裡要主動引導客人改用比較即時的管道，
// 而不是讓客人誤以為「等一下這個對話視窗就會有人回」。真的需要即時互動 → LINE 官方帳號；
// 單純要約時段 → 直接引導去 FreeTime 線上預約系統自己選（不用等任何人回覆）。網址跟 LINE ID
// 都是官網上本來就公開寫的資訊，這裡只是讓 AI 客服也主動講出來。
const LINE_OA_ID = '@qiji';
const FREETIME_BOOKING_URL = 'https://myfreetime.io/shop/qijiskin';
const BOOKING_INTENT_KEYWORDS = ['預約', '約診', '約時間', '約時段', '訂位', '改期', '改時間', '取消', '時段', '有名額', '有空檔', '有沒有空'];
const RATE_LIMIT_WINDOW_SECONDS = 600; // 10 分鐘
const RATE_LIMIT_MAX_REQUESTS = 20;
// 同一個 sessionId 在這段時間內，轉真人只寄一次 Email 通知，避免同一位客人一直觸發轉真人
// （例如連續問好幾個知識庫沒涵蓋到的問題）就一直灌信箱。使用者看到的回覆訊息不受影響，
// 只有「有沒有真的寄信」會被節流。
const HANDOFF_NOTIFY_COOLDOWN_SECONDS = 1800; // 30 分鐘

// 只允許正式站與測試網域打這支 API，避免被其他網站盜用消耗免費額度。
// 之後若正式網域改變或加測試網域，改這裡即可。
const ALLOWED_ORIGINS = new Set([
  'https://qiji-skin.com',
  'https://www.qiji-skin.com',
  'https://deerdicktw-coder.github.io',
]);

function corsHeaders(origin) {
  const allowOrigin = ALLOWED_ORIGINS.has(origin) ? origin : 'https://qiji-skin.com';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function jsonResponse(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...cors },
  });
}

function handoffMessage(reason, message = '') {
  const isBookingRelated = BOOKING_INTENT_KEYWORDS.some((kw) => message.includes(kw));
  const lineHint = `這邊會通知 Carrie 老師，但信箱通知沒辦法馬上被看到，建議直接加 LINE 官方帳號 ${LINE_OA_ID} 私訊，會比等這裡回覆快很多`;
  const bookingHint = isBookingRelated
    ? `；如果是要約時段，也可以直接到線上預約系統自己選時間，不用等人回覆：${FREETIME_BOOKING_URL}`
    : '';
  const base = `${lineHint}${bookingHint}！`;
  return reason === 'explicit_request' ? `好的，${base}` : base;
}

async function checkRateLimit(env, clientIp) {
  if (!env.RATE_LIMIT_KV) return { limited: false };
  const key = `chat-rl:${clientIp}`;
  const current = await env.RATE_LIMIT_KV.get(key);
  const count = current ? parseInt(current, 10) : 0;
  if (count >= RATE_LIMIT_MAX_REQUESTS) return { limited: true };
  await env.RATE_LIMIT_KV.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW_SECONDS });
  return { limited: false };
}

// 回傳 true 代表這次「可以真的寄信」；false 代表這個 session 冷卻中，跳過寄信（但使用者的
// 轉真人回覆訊息照常顯示，不受影響）。沒有綁定 HANDOFF_DEDUP KV 時退回原本行為（每次都寄）。
async function shouldSendHandoffEmail(env, sessionId) {
  if (!env.HANDOFF_DEDUP) return true;
  const key = `handoff-notified:${sessionId}`;
  const alreadyNotified = await env.HANDOFF_DEDUP.get(key);
  if (alreadyNotified) return false;
  await env.HANDOFF_DEDUP.put(key, '1', { expirationTtl: HANDOFF_NOTIFY_COOLDOWN_SECONDS });
  return true;
}

async function handleChat(request, env, cors) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400, cors);
  }

  const { sessionId, message, history } = body || {};
  if (!sessionId || typeof sessionId !== 'string') return jsonResponse({ error: 'missing_session_id' }, 400, cors);
  if (!message || typeof message !== 'string' || !message.trim()) return jsonResponse({ error: 'empty_message' }, 400, cors);
  if (message.length > MAX_MESSAGE_LENGTH) return jsonResponse({ error: 'message_too_long' }, 400, cors);
  const safeHistory = Array.isArray(history) ? history.slice(-10) : [];

  const clientIp = request.headers.get('cf-connecting-ip') || 'unknown';
  const { limited } = await checkRateLimit(env, clientIp);
  if (limited) {
    return jsonResponse(
      { reply: `目前詢問的人有點多，請稍後再試，或直接透過 LINE 官方帳號 ${LINE_OA_ID} 詢問（比較快得到回覆）。`, source: 'handoff', handoffTriggered: false },
      429,
      cors
    );
  }

  const threshold = env.FAQ_MATCH_THRESHOLD ? parseFloat(env.FAQ_MATCH_THRESHOLD) : 0.6;
  const { best, score, ranked } = matchFaq(message, faqData, threshold);

  if (best) {
    return jsonResponse({ reply: best.answer, source: 'faq', confidence: Number(score.toFixed(2)), handoffTriggered: false }, 200, cors);
  }

  const explicitHandoff = HANDOFF_KEYWORDS.some((kw) => message.toLowerCase().includes(kw.toLowerCase()));
  // 「連續答不出來」只算真正嘗試回答過、但沒解決的輪次；跟網站無關被婉拒的（off_topic）跟一般
  // 轉真人（handoff）都不算，不然使用者問了兩個無關問題就會被誤判成需要轉真人。
  const priorUnresolvedRounds = safeHistory.filter((h) => h.role === 'assistant' && h.source === 'llm').length;

  if (explicitHandoff) {
    if (await shouldSendHandoffEmail(env, sessionId)) {
      await notifyHandoff(env, { sessionId, message, history: safeHistory, reason: 'explicit_request' });
    }
    return jsonResponse({ reply: handoffMessage('explicit_request', message), source: 'handoff', handoffTriggered: true }, 200, cors);
  }

  const ragContext = buildRagContext(ranked);
  const llmResult = await generateReply({ env, message, history: safeHistory, ragContext });

  if (!llmResult) {
    if (await shouldSendHandoffEmail(env, sessionId)) {
      await notifyHandoff(env, { sessionId, message, history: safeHistory, reason: 'llm_unavailable' });
    }
    return jsonResponse({ reply: handoffMessage('llm_unavailable', message), source: 'handoff', handoffTriggered: true }, 200, cors);
  }

  // 跟 QIJI／網站內容無關的問題：只回婉拒訊息，不轉真人、不寄信、也不算進「連續答不出來」。
  if (llmResult.offTopic) {
    return jsonResponse({ reply: llmResult.text, source: 'off_topic', handoffTriggered: false }, 200, cors);
  }

  if (priorUnresolvedRounds >= 2) {
    if (await shouldSendHandoffEmail(env, sessionId)) {
      await notifyHandoff(env, { sessionId, message, history: safeHistory, reason: 'repeated_unresolved' });
    }
    const isBookingRelated = BOOKING_INTENT_KEYWORDS.some((kw) => message.includes(kw));
    const followUpHint = isBookingRelated
      ? `（這個問題比較需要真人確認，建議直接加 LINE 官方帳號 ${LINE_OA_ID} 私訊 Carrie 老師，約時段也可以直接到線上預約系統自己選：${FREETIME_BOOKING_URL}）`
      : `（這個問題比較需要真人確認，建議直接加 LINE 官方帳號 ${LINE_OA_ID} 私訊 Carrie 老師，會比等這裡回覆快很多）`;
    return jsonResponse(
      { reply: `${llmResult.text}\n\n${followUpHint}`, source: 'llm', handoffTriggered: true },
      200,
      cors
    );
  }

  return jsonResponse({ reply: llmResult.text, source: 'llm', confidence: Number(score.toFixed(2)), handoffTriggered: false }, 200, cors);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin') || '';
    const cors = corsHeaders(origin);
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === '/api/chat' && request.method === 'POST') {
      return handleChat(request, env, cors);
    }

    if (url.pathname === '/api/chat') {
      return jsonResponse({ error: 'method_not_allowed', hint: 'POST { sessionId, message, history? }' }, 405, cors);
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return jsonResponse({ ok: true, service: 'qiji-ai-customer-service' }, 200, cors);
    }

    return jsonResponse({ error: 'not_found' }, 404, cors);
  },
};
