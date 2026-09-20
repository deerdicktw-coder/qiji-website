/**
 * 轉真人通知。用 Resend（https://resend.com）免費層發 Email，
 * 因為 LINE Notify 已於 2025 年 3 月終止服務，不採用。
 *
 * 需要的環境變數（於 Cloudflare Pages 後台設定，不要寫進程式碼或 repo）：
 *   RESEND_API_KEY   Resend 的 API key
 *   NOTIFY_EMAIL_TO  收通知的 Email（你自己的信箱）
 *   NOTIFY_EMAIL_FROM 寄件者位址（需在 Resend 驗證過的網域，例如 bot@qiji-skin.com）
 *
 * 任何一個變數沒設定時，直接跳過（不丟錯），避免因為通知失敗連累主要對話功能。
 */
export async function notifyHandoff(env, { sessionId, message, history = [], reason }) {
  const { RESEND_API_KEY, NOTIFY_EMAIL_TO, NOTIFY_EMAIL_FROM } = env || {};
  if (!RESEND_API_KEY || !NOTIFY_EMAIL_TO || !NOTIFY_EMAIL_FROM) {
    console.log('[notify] 通知環境變數未設定，略過發信', { sessionId, reason });
    return { sent: false, skipped: true };
  }

  const transcript = [...history.slice(-6), { role: 'user', content: message }]
    .map((h) => `${h.role === 'assistant' ? 'AI' : '訪客'}：${h.content}`)
    .join('\n');

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: NOTIFY_EMAIL_FROM,
        to: NOTIFY_EMAIL_TO,
        subject: `[QIJI 智能客服] 需要真人接手（${reason}）`,
        text: `對話 ID：${sessionId}\n觸發原因：${reason}\n\n最近對話：\n${transcript}`,
      }),
    });
    if (!res.ok) {
      console.error('[notify] Resend 回應非 2xx', res.status, await res.text());
      return { sent: false, skipped: false };
    }
    return { sent: true, skipped: false };
  } catch (err) {
    console.error('[notify] 發信失敗', err);
    return { sent: false, skipped: false };
  }
}
