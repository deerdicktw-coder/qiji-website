import faqData from './faq.json';
import { matchFaq, buildRagContext } from './faqMatcher.mjs';
import { generateReply } from './llmClient.mjs';
import { notifyHandoff } from './notify.mjs';
import { LINE_OA_ID, LINE_OA_URL, FREETIME_BOOKING_URL, BOOKING_INTENT_KEYWORDS } from './constants.mjs';
import {
  CONFIRM_SOURCE_PREFIX,
  FAQ_GUESS_MIN_SCORE,
  FAQ_GUESS_SOURCE,
  isNegativeReply,
  isAffirmativeReply,
  handoffMessage,
  handoffConfirmMessage,
  handoffDeclineMessage,
  faqGuessMessage,
  faqGuessConfirmedMessage,
} from './handoffConfirm.mjs';

/**
 * 獨立的 Cloudflare Worker（不是 Pages Functions）。
 *
 * 為什麼要獨立出來：qiji-skin.com 正式站其實是 GitHub Pages 架設（server: GitHub.com，
 * 實測確認過），不是 Cloudflare Pages，GitHub Pages 純靜態、不能跑任何後端程式碼。
 * 所以這支 API 另外部署成一個獨立的 Worker，前端 chat-widget.js 用完整網址（跨網域）呼叫它，
 * 靠 CORS 允許 qiji-skin.com 讀取回應。正式站完全不用搬家，維持原本 GitHub Pages 架構。
 */

const MAX_MESSAGE_LENGTH = 2000;
// 注意：故意不用單獨的「真人」兩個字當關鍵字。實測發現像「你是真人還是AI」這種單純好奇AI身份
// 的問題，也會因為字串裡剛好包含「真人」兩個字被誤判成要轉真人，害客人問身份問題也被寄信通知
// Carrie。改成用「真人」搭配明確的請求動詞/名詞組成的完整詞組，只有客人真的在要求真人協助時才會
// 命中，不會被「真人／AI」這種身份比較的問句誤觸發。
// 2026-09-20 自主測試 277 題發現：口語化的情緒抱怨（不是正式用詞，例如「太扯了吧」「白痴機器人」）
// 完全沒有一句觸發轉真人，甚至有幾句被 LLM 判成離題、回覆「跟服務無關」，對已經在生氣的客人來說
// 這樣的回覆可能會讓對方更不滿。補上這些口語詞，讓抱怨型訊息能更早被攔截轉真人，而不是被機器人
// 用制式回覆隨便帶過。
const HANDOFF_KEYWORDS = [
  '真人客服', '找真人', '轉真人', '真人協助', '真人幫', '真人處理', '真人回覆', '真人回答', '麻煩真人', '真人來',
  '客服人員', '找老師', '找凱莉', '找carrie', '投訴', '客訴', '生氣', '不滿意', '退費', '打電話',
  '太扯', '很爛', '很差', '白痴', '這什麼鬼', '不智能', '亂回答', '沒人理我', '沒人回',
  '都聽不懂', '完全聽不懂', '完全沒用', '沒有用', '很不滿', '爛透了',
];
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

// 2026-09-20：發現 Email 通知量太大（每次轉真人都會寄信給 Carrie，等於每個誤判/口語抱怨/連續
// 答不出來都會變成一封信），使用者要求「發信前先問過客人」，避免騷擾信件。
// 做法：所有原本會 notifyHandoff 的地方，改成先回一則「要不要幫你發信通知？」的確認訊息
// （source 用 `handoff_confirm:<原因>` 標記，不寄信、不算 handoffTriggered），
// 下一輪如果客人明確說「要」才真的寄信；說「不用」就不寄，並保留 LINE／FreeTime 連結讓客人自己選；
// 如果客人沒有給出明確是非回答（可能是問了別的問題），就當作放棄這次確認，訊息照正常流程處理。
// 相關的純函式與常數抽在 ./handoffConfirm.mjs（方便單元測試，見上方 import）。

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
      { reply: `目前詢問的人有點多，請稍後再試，或直接透過 LINE 官方帳號 ${LINE_OA_ID} 詢問（比較快得到回覆）：${LINE_OA_URL}`, source: 'handoff', handoffTriggered: false },
      429,
      cors
    );
  }

  // 先檢查：上一輪機器人是不是正在等客人回答「要不要發信通知」。如果是，這一輪訊息要優先當成
  // 對那個確認的回答來處理，不要先跑 FAQ／LLM 判斷（不然「要」「不用」這種單字會被當成新問題）。
  const lastTurn = safeHistory.length > 0 ? safeHistory[safeHistory.length - 1] : null;
  const pendingReason =
    lastTurn && lastTurn.role === 'assistant' && typeof lastTurn.source === 'string' && lastTurn.source.startsWith(CONFIRM_SOURCE_PREFIX)
      ? lastTurn.source.slice(CONFIRM_SOURCE_PREFIX.length)
      : null;

  // 上一輪是「AI 暫時不可用，先猜一條 FAQ 給你」的情況，這一輪要先當成對那個猜測的回答處理。
  // 注意這裡不能沿用轉真人的確認流程：客人回「是」是在說「這就是我要問的」，不是要寄信。
  if (lastTurn && lastTurn.role === 'assistant' && lastTurn.source === FAQ_GUESS_SOURCE) {
    if (isNegativeReply(message)) {
      // 猜錯了，這時才問要不要請 Carrie 老師幫忙
      return jsonResponse(
        { reply: handoffConfirmMessage('llm_unavailable', message), source: `${CONFIRM_SOURCE_PREFIX}llm_unavailable`, handoffTriggered: false },
        200,
        cors
      );
    }
    if (isAffirmativeReply(message)) {
      return jsonResponse({ reply: faqGuessConfirmedMessage(), source: 'faq_guess_confirmed', handoffTriggered: false }, 200, cors);
    }
    // 沒有明確回答，當作問了新問題，照正常流程往下走
  }

  if (pendingReason) {
    if (isNegativeReply(message)) {
      return jsonResponse({ reply: handoffDeclineMessage(), source: 'handoff_declined', handoffTriggered: false }, 200, cors);
    }
    if (isAffirmativeReply(message)) {
      // 找出當初觸發轉真人確認的那一則客人訊息（在確認提示之前的最後一則 user 訊息），
      // 讓寄出的通知信內容還是原始問題，而不是這一輪的「要」/「好」。
      let originalMessage = message;
      for (let i = safeHistory.length - 2; i >= 0; i -= 1) {
        if (safeHistory[i].role === 'user') {
          originalMessage = safeHistory[i].content;
          break;
        }
      }
      if (await shouldSendHandoffEmail(env, sessionId)) {
        await notifyHandoff(env, { sessionId, message: originalMessage, history: safeHistory, reason: pendingReason });
      }
      return jsonResponse({ reply: handoffMessage(pendingReason, originalMessage), source: 'handoff', handoffTriggered: true }, 200, cors);
    }
    // 沒有明確答「要」或「不用」，可能是客人不理會確認、直接問了別的問題，就放棄這次確認，
    // 讓這則訊息照正常流程（FAQ／LLM／轉真人判斷）往下處理。
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
    return jsonResponse(
      { reply: handoffConfirmMessage('explicit_request', message), source: `${CONFIRM_SOURCE_PREFIX}explicit_request`, handoffTriggered: false },
      200,
      cors
    );
  }

  const ragContext = buildRagContext(ranked);
  const llmResult = await generateReply({ env, message, history: safeHistory, ragContext });

  if (!llmResult) {
    // AI 暫時不可用（多半是每日免費額度用完）。與其直接問「要不要發 Email」讓客人空手而回，
    // 先看有沒有分數接近、只是沒到直接回答門檻的 FAQ，有就先給出來並確認是不是他要問的。
    const guess = ranked && ranked.length > 0 ? ranked[0] : null;
    if (guess && guess.score >= FAQ_GUESS_MIN_SCORE) {
      return jsonResponse(
        { reply: faqGuessMessage(guess.item.answer), source: FAQ_GUESS_SOURCE, confidence: Number(guess.score.toFixed(2)), handoffTriggered: false },
        200,
        cors
      );
    }
    return jsonResponse(
      { reply: handoffConfirmMessage('llm_unavailable', message), source: `${CONFIRM_SOURCE_PREFIX}llm_unavailable`, handoffTriggered: false },
      200,
      cors
    );
  }

  // 跟 QIJI／網站內容無關的問題：只回婉拒訊息，不轉真人、不寄信、也不算進「連續答不出來」。
  if (llmResult.offTopic) {
    return jsonResponse({ reply: llmResult.text, source: 'off_topic', handoffTriggered: false }, 200, cors);
  }

  if (priorUnresolvedRounds >= 2) {
    const confirmHint = handoffConfirmMessage('repeated_unresolved', message);
    return jsonResponse(
      { reply: `${llmResult.text}\n\n${confirmHint}`, source: `${CONFIRM_SOURCE_PREFIX}repeated_unresolved`, handoffTriggered: false },
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
