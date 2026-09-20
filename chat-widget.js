/**
 * QIJI 智能客服 — 網頁嵌入式聊天視窗
 *
 * 純 vanilla JS，不依賴任何框架或第三方套件。
 * 用 Shadow DOM 把樣式完全隔離，不會跟 index.html 現有的（很大的）全站 CSS 互相污染，
 * 所以不需要額外的 chat-widget.css 檔案，也不用小心翼翼取 class 名稱。
 *
 * 使用方式：在頁面任何地方加一行
 *   <script src="/chat-widget.js" defer></script>
 * 元件會自己在 <body> 掛一個浮動按鈕，不需要額外的容器。
 */
(function () {
  'use strict';

  const API_ENDPOINT = 'https://qiji-ai-customer-service.deerdick-tw.workers.dev/api/chat';
  const SESSION_KEY = 'qiji-chat-session-id';
  const HISTORY_LIMIT = 20;

  function getSessionId() {
    try {
      let id = sessionStorage.getItem(SESSION_KEY);
      if (!id) {
        id = (crypto.randomUUID ? crypto.randomUUID() : 'sid-' + Date.now() + '-' + Math.random().toString(16).slice(2));
        sessionStorage.setItem(SESSION_KEY, id);
      }
      return id;
    } catch (e) {
      // sessionStorage 在少數環境（例如無痕模式的部分瀏覽器）會擲例外，退化成每次都是新對話
      return 'sid-' + Date.now();
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // 把已經跑過 escapeHtml 的文字裡的網址轉成可以直接點的連結。escapeHtml 先跑過一次，
  // 所以這裡看到的是 HTML 已轉義後的字串（例如 & 會變成 &amp;），比對網址時要用轉義後的
  // 樣子（&amp;）避免漏轉，但不影響一般網址（多半沒有 & 或後面帶的參數不影響可讀性）。
  function linkifyUrls(escapedHtml) {
    // 網址字元集合只收 URL 合法的半形符號，遇到中文全形標點或中文字就會自然停止，
    // 不會像原本的「非空白字元」判斷一樣把後面的中文句子也吃進連結裡（中文沒有空白斷詞）。
    return escapedHtml.replace(/https?:\/\/[A-Za-z0-9\-._~:\/?#\[\]@!$&'()*+,;=%]+/g, (url) => {
      // 保險起見再去掉可能殘留在結尾的半形標點（例如句子剛好用逗號接著網址）
      const trailingPunct = /[.,;:!?)]+$/;
      const match = url.match(trailingPunct);
      const cleanUrl = match ? url.slice(0, -match[0].length) : url;
      const suffix = match ? match[0] : '';
      return '<a href="' + cleanUrl + '" target="_blank" rel="noopener noreferrer">' + cleanUrl + '</a>' + suffix;
    });
  }

  const STYLE = `
    :host, .qc-root { box-sizing: border-box; font-family: 'Jost', 'Noto Sans TC', sans-serif; }
    * { box-sizing: border-box; }
    .qc-fab {
      position: fixed; right: 20px; bottom: 20px; z-index: 9999;
      width: 56px; height: 56px; border-radius: 50%;
      background: #c9a96e; color: #fff; border: none; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 4px 16px rgba(0,0,0,0.25);
      transition: transform 0.25s ease;
    }
    .qc-fab:hover { transform: scale(1.06); }
    .qc-fab svg { width: 26px; height: 26px; fill: #fff; }
    .qc-panel {
      position: fixed; right: 20px; bottom: 88px; z-index: 9999;
      width: min(360px, calc(100vw - 40px)); height: min(520px, calc(100vh - 140px));
      background: #fff; border-radius: 16px; box-shadow: 0 8px 32px rgba(0,0,0,0.28);
      display: flex; flex-direction: column; overflow: hidden;
      opacity: 0; visibility: hidden; transform: translateY(12px);
      transition: all 0.25s ease;
    }
    .qc-panel.qc-open { opacity: 1; visibility: visible; transform: translateY(0); }
    .qc-header {
      background: #000; color: #fff; padding: 16px 18px;
      display: flex; align-items: center; justify-content: space-between;
    }
    .qc-header-title { font-size: 0.95rem; letter-spacing: 2px; }
    .qc-header-sub { font-size: 0.7rem; color: #d4b87a; margin-top: 2px; letter-spacing: 1px; }
    .qc-close { background: none; border: none; color: #fff; font-size: 1.3rem; cursor: pointer; line-height: 1; padding: 4px; }
    .qc-messages { flex: 1; overflow-y: auto; padding: 16px; background: #f7f7f7; display: flex; flex-direction: column; gap: 10px; }
    .qc-msg { max-width: 84%; padding: 10px 14px; border-radius: 12px; font-size: 0.86rem; line-height: 1.6; white-space: pre-wrap; }
    .qc-msg-user { align-self: flex-end; background: #c9a96e; color: #fff; border-bottom-right-radius: 4px; }
    .qc-msg-bot { align-self: flex-start; background: #fff; color: #333; border: 1px solid #ebebeb; border-bottom-left-radius: 4px; }
    .qc-msg-handoff { align-self: flex-start; background: #fff8ea; color: #7a5c22; border: 1px solid #d4b87a; font-size: 0.8rem; }
    .qc-typing { align-self: flex-start; display: flex; gap: 4px; padding: 10px 14px; }
    .qc-typing span { width: 6px; height: 6px; border-radius: 50%; background: #999; animation: qc-blink 1.2s infinite ease-in-out; }
    .qc-typing span:nth-child(2) { animation-delay: 0.2s; }
    .qc-typing span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes qc-blink { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }
    .qc-inputbar { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #ebebeb; background: #fff; }
    .qc-input {
      flex: 1; border: 1px solid #d4d4d4; border-radius: 20px; padding: 9px 14px;
      font-size: 0.86rem; font-family: inherit; outline: none;
    }
    .qc-input:focus { border-color: #c9a96e; }
    .qc-send {
      background: #c9a96e; color: #fff; border: none; border-radius: 20px;
      padding: 0 18px; font-size: 0.82rem; letter-spacing: 1px; cursor: pointer;
    }
    .qc-send:disabled { background: #d4d4d4; cursor: not-allowed; }
    .qc-hint { padding: 8px 16px; font-size: 0.72rem; color: #999; background: #f7f7f7; text-align: center; }
    @media (max-width: 480px) {
      .qc-panel { right: 12px; left: 12px; width: auto; bottom: 84px; }
      .qc-fab { right: 14px; bottom: 14px; }
    }
  `;

  function buildWidget() {
    const host = document.createElement('div');
    host.id = 'qiji-chat-widget-host';
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });

    shadow.innerHTML = `
      <style>${STYLE}</style>
      <div class="qc-root">
        <button class="qc-fab" aria-label="開啟客服聊天">
          <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.03 2 11c0 2.4 1.06 4.57 2.8 6.19L4 22l5.1-1.35C10.02 20.87 11 21 12 21c5.52 0 10-4.03 10-9s-4.48-10-10-10z"/></svg>
        </button>
        <div class="qc-panel">
          <div class="qc-header">
            <div>
              <div class="qc-header-title">QIJI 智能客服</div>
              <div class="qc-header-sub">淇肌淨膚 · 通常幾秒內回覆</div>
            </div>
            <button class="qc-close" aria-label="關閉">&times;</button>
          </div>
          <div class="qc-messages"></div>
          <div class="qc-hint">回覆由 AI 產生，重要事項仍建議以 LINE @qiji 與 Carrie 老師確認</div>
          <form class="qc-inputbar">
            <input class="qc-input" type="text" maxlength="500" placeholder="想問價格、預約或課程都可以..." autocomplete="off" />
            <button class="qc-send" type="submit">送出</button>
          </form>
        </div>
      </div>
    `;

    const fab = shadow.querySelector('.qc-fab');
    const panel = shadow.querySelector('.qc-panel');
    const closeBtn = shadow.querySelector('.qc-close');
    const messagesEl = shadow.querySelector('.qc-messages');
    const form = shadow.querySelector('.qc-inputbar');
    const input = shadow.querySelector('.qc-input');
    const sendBtn = shadow.querySelector('.qc-send');

    const history = [];
    let greeted = false;

    function scrollToBottom() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function appendMessage(text, kind) {
      const el = document.createElement('div');
      el.className = 'qc-msg ' + (kind === 'user' ? 'qc-msg-user' : kind === 'handoff' ? 'qc-msg-handoff' : 'qc-msg-bot');
      el.innerHTML = linkifyUrls(escapeHtml(text)).replace(/\n/g, '<br>');
      messagesEl.appendChild(el);
      scrollToBottom();
    }

    function showTyping() {
      const el = document.createElement('div');
      el.className = 'qc-typing';
      el.innerHTML = '<span></span><span></span><span></span>';
      el.setAttribute('data-typing', '1');
      messagesEl.appendChild(el);
      scrollToBottom();
      return el;
    }

    function openPanel() {
      panel.classList.add('qc-open');
      if (!greeted) {
        greeted = true;
        appendMessage('您好，我是 QIJI 智能客服 🌿 可以問我課程內容、價格、預約方式或營業時間，需要真人協助也可以直接跟我說。', 'bot');
      }
      setTimeout(() => input.focus(), 100);
    }

    function closePanel() {
      panel.classList.remove('qc-open');
    }

    fab.addEventListener('click', () => {
      panel.classList.contains('qc-open') ? closePanel() : openPanel();
    });
    closeBtn.addEventListener('click', closePanel);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;

      appendMessage(text, 'user');
      history.push({ role: 'user', content: text });
      input.value = '';
      input.disabled = true;
      sendBtn.disabled = true;

      const typingEl = showTyping();

      try {
        const res = await fetch(API_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: getSessionId(),
            message: text,
            history: history.slice(-HISTORY_LIMIT),
          }),
        });
        const data = await res.json();
        typingEl.remove();

        if (!res.ok || !data.reply) {
          appendMessage('目前連線有點不穩定，建議直接透過 LINE 官方帳號 @qiji 詢問，謝謝您的耐心。', 'handoff');
        } else {
          appendMessage(data.reply, data.source === 'handoff' ? 'handoff' : 'bot');
          history.push({ role: 'assistant', content: data.reply, source: data.source });
        }
      } catch (err) {
        typingEl.remove();
        appendMessage('目前連線有點不穩定，建議直接透過 LINE 官方帳號 @qiji 詢問，謝謝您的耐心。', 'handoff');
      } finally {
        input.disabled = false;
        sendBtn.disabled = false;
        input.focus();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildWidget);
  } else {
    buildWidget();
  }
})();
