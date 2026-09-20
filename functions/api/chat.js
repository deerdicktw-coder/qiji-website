import faqData from '../data/faq.json';
import { matchFaq, buildRagContext } from '../lib/faqMatcher.mjs';
import { generateReply } from '../lib/llmClient.mjs';
import { notifyHandoff } from '../lib/notify.mjs';

const MAX_MESSAGE_LENGTH = 2000;
const HANDOFF_KEYWORDS = ['真人', '客服人員', '找老師', '找凱莉', '找carrie', '投訴', '客訴', '生氣', '不滿意', '退費', '打電話'];
const RATE_LIMIT_WINDOW_SECONDS = 600; // 10 分鐘
const RATE_LIMIT_MAX_REQUESTS = 20;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function handoffMessage(reason) {
  const base = '已經幫您轉接給 Carrie 老師，我們會盡快回覆您，感謝耐心等候！';
  if (reason === 'explicit_request') return `好的，${base}`;
  return base;
}

/**
 * 極簡的固定窗口 rate limit：只有在有掛 RATE_LIMIT_KV 這個 KV binding 時才啟用。
 * 沒有掛的話直接放行 —— 對 QIJI 這種流量規模，先求正確性，之後真的被濫用再加。
 */
async function checkRateLimit(env, clientIp) {
  if (!env.RATE_LIMIT_KV) return { limited: false };
  const key = `chat-rl:${clientIp}`;
  const current = await env.RATE_LIMIT_KV.get(key);
  const count = current ? parseInt(current, 10) : 0;
  if (count >= RATE_LIMIT_MAX_REQUESTS) return { limited: true };
  await env.RATE_LIMIT_KV.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW_SECONDS });
  return { limited: false };
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }

  const { sessionId, message, history } = body || {};

  if (!sessionId || typeof sessionId !== 'string') {
    return jsonResponse({ error: 'missing_session_id' }, 400);
  }
  if (!message || typeof message !== 'string' || !message.trim()) {
    return jsonResponse({ error: 'empty_message' }, 400);
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return jsonResponse({ error: 'message_too_long' }, 400);
  }
  const safeHistory = Array.isArray(history) ? history.slice(-10) : [];

  const clientIp = request.headers.get('cf-connecting-ip') || 'unknown';
  const { limited } = await checkRateLimit(env, clientIp);
  if (limited) {
    return jsonResponse(
      { reply: '目前詢問的人有點多，請稍後再試，或直接透過 LINE 官方帳號 @qiji 詢問。', source: 'handoff', handoffTriggered: false },
      429
    );
  }

  const threshold = env.FAQ_MATCH_THRESHOLD ? parseFloat(env.FAQ_MATCH_THRESHOLD) : 0.6;
  const { best, score, ranked } = matchFaq(message, faqData, threshold);

  if (best) {
    return jsonResponse({ reply: best.answer, source: 'faq', confidence: Number(score.toFixed(2)), handoffTriggered: false });
  }

  const explicitHandoff = HANDOFF_KEYWORDS.some((kw) => message.toLowerCase().includes(kw.toLowerCase()));
  // 連續好幾輪都沒有命中 FAQ，代表 LLM 也一直在跳答，值得轉真人而不是一直嘗試
  const priorUnresolvedRounds = safeHistory.filter((h) => h.role === 'assistant' && h.source && h.source !== 'faq').length;

  if (explicitHandoff) {
    await notifyHandoff(env, { sessionId, message, history: safeHistory, reason: 'explicit_request' });
    return jsonResponse({ reply: handoffMessage('explicit_request'), source: 'handoff', handoffTriggered: true });
  }

  const ragContext = buildRagContext(ranked);
  const llmReply = await generateReply({ env, message, history: safeHistory, ragContext });

  if (!llmReply) {
    await notifyHandoff(env, { sessionId, message, history: safeHistory, reason: 'llm_unavailable' });
    return jsonResponse({ reply: handoffMessage('llm_unavailable'), source: 'handoff', handoffTriggered: true });
  }

  if (priorUnresolvedRounds >= 2) {
    await notifyHandoff(env, { sessionId, message, history: safeHistory, reason: 'repeated_unresolved' });
    return jsonResponse({
      reply: `${llmReply}\n\n（這個問題我們已經幫您轉接給 Carrie 老師，會盡快補充回覆。）`,
      source: 'llm',
      handoffTriggered: true,
    });
  }

  return jsonResponse({ reply: llmReply, source: 'llm', confidence: Number(score.toFixed(2)), handoffTriggered: false });
}

export async function onRequestGet() {
  return jsonResponse({ error: 'method_not_allowed', hint: 'POST { sessionId, message, history? }' }, 405);
}
