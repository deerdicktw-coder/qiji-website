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
  const LINE_OA_URL = 'https://page.line.me/026xbaov?openQrModal=true';
  // Turnstile 站點金鑰是公開資訊（本來就會出現在網頁原始碼裡）；機密的 Secret Key
  // 只存在 Cloudflare 的 Worker secret，不在這支檔案、也不在任何版控裡。
  const TURNSTILE_SITE_KEY = '0x4AAAAAAE-u1HyR-VV2rMxY';
  const VERIFY_ENDPOINT = API_ENDPOINT.replace('/api/chat', '/api/verify');
  // 自家的連結在對話裡改成中文說明文字，客人看到的是「加 LINE 官方帳號」而不是一長串網址，
  // 讀起來比較像真人在講話。滑鼠移上去（title）還是看得到完整網址，不會讓客人不知道會連去哪。
  // 沒列在這裡的網址就維持顯示原網址，只是變成可以點。
  const LINK_LABELS = [
    { prefix: 'https://page.line.me/026xbaov', label: '👉 點這裡加好友' },
    { prefix: 'https://myfreetime.io/shop/qijiskin', label: '👉 點這裡預約' },
  ];
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
      const known = LINK_LABELS.filter(function (item) { return cleanUrl.indexOf(item.prefix) === 0; })[0];
      const label = known ? known.label : cleanUrl;
      return '<a href="' + cleanUrl + '" target="_blank" rel="noopener noreferrer" title="' + cleanUrl + '">' + label + '</a>' + suffix;
    });
  }

  const STYLE = `
    :host, .qc-root { box-sizing: border-box; font-family: 'Jost', 'Noto Sans TC', sans-serif; }
    * { box-sizing: border-box; }
    .qc-fab {
      position: fixed; right: 20px; bottom: calc(20px + env(safe-area-inset-bottom, 0px)); z-index: 996;
      width: 56px; height: 56px; border-radius: 50%;
      background: #c9a96e; border: none; cursor: pointer; padding: 0; overflow: hidden;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 4px 16px rgba(0,0,0,0.25);
      transition: transform 0.25s ease;
    }
    .qc-fab:hover { transform: scale(1.06); }
    /* 往下滾動時淡出收起，停下或往上滾再回來，減少手機上被浮動鈕吃掉的畫面 */
    .qc-fab { transition: transform 0.25s ease, opacity 0.25s ease, visibility 0.25s; }
    .qc-fab.qc-fab-hidden { opacity: 0; visibility: hidden; transform: scale(0.6) translateY(10px); pointer-events: none; }
    /* 跟著網站自家 FAB 一起讓開：選單／各種面板開啟、或與首屏資訊帶重疊時 */
    .qc-root.qc-suppressed .qc-fab,
    .qc-root.qc-suppressed .qc-panel { opacity: 0; visibility: hidden; pointer-events: none; }
    .qc-fab svg { width: 100%; height: 100%; display: block; }
    .qc-panel {
      position: fixed; right: 20px; bottom: calc(88px + env(safe-area-inset-bottom, 0px)); z-index: 999;
      width: min(360px, calc(100vw - 40px)); height: min(520px, calc(100vh - 140px));
      height: min(520px, calc(100dvh - 140px - var(--qc-kb, 0px)));
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
    .qc-msg a { color: inherit; font-weight: 600; text-decoration: underline; text-underline-offset: 2px; overflow-wrap: anywhere; }
    .qc-msg-bot a { color: #b08d4f; }
    .qc-msg-handoff a { color: #8a6417; }
    .qc-msg a:hover { opacity: 0.72; }
    .qc-typing { align-self: flex-start; display: flex; gap: 4px; padding: 10px 14px; }
    .qc-typing span { width: 6px; height: 6px; border-radius: 50%; background: #999; animation: qc-blink 1.2s infinite ease-in-out; }
    .qc-typing span:nth-child(2) { animation-delay: 0.2s; }
    .qc-typing span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes qc-blink { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }
    .qc-inputbar { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #ebebeb; background: #fff; }
    .qc-input {
      flex: 1; min-width: 0; border: 1px solid #d4d4d4; border-radius: 20px; padding: 9px 14px;
      /* 必須 >= 16px：否則 iOS 聚焦輸入框時會自動放大整頁，把版面推出畫面外 */
      font-size: 16px; font-family: inherit; outline: none;
    }
    .qc-input:focus { border-color: #c9a96e; }
    .qc-send {
      background: #c9a96e; color: #fff; border: none; border-radius: 20px;
      padding: 0 18px; font-size: 0.82rem; letter-spacing: 1px; cursor: pointer;
    }
    .qc-send:disabled { background: #d4d4d4; cursor: not-allowed; }
    .qc-hint { padding: 8px 16px; font-size: 0.72rem; color: #999; background: #f7f7f7; text-align: center; }
    .qc-hint a { color: #b08d4f; text-decoration: underline; text-underline-offset: 2px; }
    /* 網站在 ≤900px 會顯示自己的預約 FAB(68px, bottom 20)與諮詢 FAB(56px, bottom 100)，
       客服鈕排在它們上方第三順位，避免互相遮蓋。 */
    @media (max-width: 900px) {
      .qc-fab { right: 20px; bottom: calc(100px + env(safe-area-inset-bottom, 0px)); }
      /* 諮詢鈕(.inquiry-fab.show)出現時會佔住 bottom 100，客服鈕再往上讓一格 */
      .qc-fab.qc-fab-raised { bottom: calc(168px + env(safe-area-inset-bottom, 0px)); }
    }
    @media (max-width: 480px) {
      .qc-panel {
        right: 12px; left: 12px; width: auto;
        bottom: calc(12px + env(safe-area-inset-bottom, 0px) + var(--qc-kb, 0px));
        height: min(560px, calc(100vh - 120px));
        height: min(560px, calc(100dvh - 120px - var(--qc-kb, 0px)));
      }
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
          <svg viewBox="0 0 56 56" aria-hidden="true">
            <g fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <rect x="14.6" y="16.8" width="26.9" height="22.4" rx="7.8"/>
              <path d="M28 16.8V11.4"/>
              <rect x="11.5" y="24.1" width="3.1" height="7.8" rx="1.2"/>
              <rect x="41.4" y="24.1" width="3.1" height="7.8" rx="1.2"/>
              <path d="M18.6 29.2Q22.4 24.4 26.2 29.2"/>
              <path d="M29.8 29.2Q33.6 24.4 37.4 29.2"/>
            </g>
            <circle cx="28" cy="9" r="2.1" fill="#fff"/>
          </svg>
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
          <div class="qc-hint">回覆由 AI 產生，重要事項仍建議以 <a href="https://page.line.me/026xbaov?openQrModal=true" target="_blank" rel="noopener noreferrer">LINE @qiji</a> 與 Carrie 老師確認</div>
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

    // ── Turnstile：驗一次、換一張通行證 ──────────────────────────────
    // Turnstile 的 token 只能用一次、5 分鐘就失效，所以不能每則訊息都帶同一個。
    // 改成開啟聊天視窗時驗一次，換一張後端簽章的通行證，之後的訊息帶著它走。
    let chatPass = null;
    let passPending = null;

    // 2026-09-21：這裡原本用 async/defer 載入 api.js，再呼叫 turnstile.ready()，
    // 結果 Turnstile 直接丟出 TurnstileError（官方規定：用了 async/defer 就不能呼叫 ready()），
    // 例外被 ensurePass() 的 catch 吞掉，變成「永遠拿不到通行證，但畫面完全正常」的無聲失敗，
    // 查了很久才靠後端計數器發現。改用官方支援 async/defer 的 onload= 參數：
    // api.js 初始化完成後會主動呼叫這個全域函式，不需要也不可以再用 ready()。
    const TURNSTILE_READY_CALLBACK = '__qijiTurnstileReady';

    function loadTurnstileScript() {
      if (window.turnstile) return Promise.resolve();
      if (window.__qijiTurnstileLoading) return window.__qijiTurnstileLoading;
      window.__qijiTurnstileLoading = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('turnstile_script_slow')), 15000);
        window[TURNSTILE_READY_CALLBACK] = () => { clearTimeout(timer); resolve(); };
        const el = document.createElement('script');
        el.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=' + TURNSTILE_READY_CALLBACK;
        el.async = true;
        el.defer = true;
        el.onerror = () => { clearTimeout(timer); reject(new Error('turnstile_script_blocked')); };
        document.head.appendChild(el);
      });
      return window.__qijiTurnstileLoading;
    }

    function getTurnstileToken() {
      return new Promise((resolve, reject) => {
        // 容器放在 shadow DOM 外、畫面外：Turnstile 需要能存取真實 DOM，
        // 而 Managed 模式偶爾要顯示互動挑戰，藏在 shadow DOM 裡會出不來。
        let holder = document.getElementById('qiji-turnstile-holder');
        if (!holder) {
          holder = document.createElement('div');
          holder.id = 'qiji-turnstile-holder';
          // 需要實際尺寸，Managed 模式要顯示互動挑戰時才有地方畫。
          // 平常挑戰是無感通過的，所以預設縮到極小且不擋點擊；
          // 真的跳出挑戰時由 Turnstile 自己撐開。
          holder.style.cssText =
            'position:fixed;bottom:12px;left:12px;z-index:9998;width:300px;max-width:calc(100vw - 24px);';
          document.body.appendChild(holder);
        }
        holder.innerHTML = '';
        const timer = setTimeout(() => reject(new Error('turnstile_timeout')), 20000);
        const doRender = () => {
          try {
            window.turnstile.render(holder, {
              sitekey: TURNSTILE_SITE_KEY,
              callback: (t) => { clearTimeout(timer); resolve(t); },
              'error-callback': () => { clearTimeout(timer); reject(new Error('turnstile_error')); },
            });
          } catch (e) { clearTimeout(timer); reject(e); }
        };
        // 不要在這裡呼叫 turnstile.ready()：api.js 是用 async/defer 載入的，
        // 這種情況下呼叫 ready() 會被 Turnstile 擋下並丟例外（見上面 loadTurnstileScript 的註解）。
        // 走到這裡就代表 onload= 回呼已經觸發，API 已經初始化完成，可以直接 render。
        doRender();
      });
    }

    // 取得通行證。任何一步失敗都只是回傳 null——後端目前採「沒通行證也放行」，
    // 所以客人的網路擋掉 Cloudflare 時，客服仍然可用，不會整個壞掉。
    function ensurePass() {
      if (chatPass) return Promise.resolve(chatPass);
      if (passPending) return passPending;
      passPending = loadTurnstileScript()
        .then(getTurnstileToken)
        .then((token) => fetch(VERIFY_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: getSessionId(), token }),
        }))
        .then((r) => r.json())
        .then((d) => { chatPass = (d && d.ok && d.pass) ? d.pass : null; return chatPass; })
        .catch((e) => {
          // 失敗照樣放行（後端是 fail-open），但要把原因回報給後端計數，
          // 否則又會變成這次這種「什麼線索都沒有」的無聲失敗。
          const reason = (e && e.message) ? String(e.message).slice(0, 40) : 'unknown';
          try {
            fetch(VERIFY_ENDPOINT, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId: getSessionId(), reason }),
            }).catch(() => {});
          } catch (_) { }
          return null;
        })
        .then((v) => { passPending = null; return v; });
      return passPending;
    }

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
      ensurePass(); // 先背景取得，客人還在打字時就驗好了
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

    // 往下滾動時把客服鈕收起來，停下或往上滾再淡入。手機上浮動鈕本來就多，
    // 這樣看內容時畫面不會一直被擋住。聊天視窗開著的時候不收。
    let lastY = window.pageYOffset || 0;
    let ticking = false;
    let idleTimer = null;
    function onScroll() {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(() => {
        const y = window.pageYOffset || 0;
        if (!panel.classList.contains('qc-open')) {
          // 只有往下滾、且已經離開頁首一段距離才收起，避免在頁面頂端閃爍
          if (y > lastY + 6 && y > 240) fab.classList.add('qc-fab-hidden');
          else if (y < lastY - 6 || y <= 240) fab.classList.remove('qc-fab-hidden');
        }
        lastY = y;
        ticking = false;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => fab.classList.remove('qc-fab-hidden'), 900);
      });
    }
    window.addEventListener('scroll', onScroll, { passive: true });

    // 鍵盤彈出時，iOS 只會縮小 visual viewport，position:fixed 的面板仍貼在
    // layout viewport 底部，等於被鍵盤蓋住。這裡把鍵盤高度寫進 CSS 變數，
    // 讓面板往上抬、同時縮短高度，輸入框就不會被擋住。
    const vv = window.visualViewport;
    function syncKeyboard() {
      if (!vv) return;
      const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      // 小於 80px 多半是網址列收合造成的誤差，不是真的鍵盤
      panel.style.setProperty('--qc-kb', (kb > 80 ? kb : 0) + 'px');
    }
    if (vv) {
      vv.addEventListener('resize', syncKeyboard);
      vv.addEventListener('scroll', syncKeyboard);
    }
    input.addEventListener('focus', () => setTimeout(syncKeyboard, 250));
    input.addEventListener('blur', () => setTimeout(() => panel.style.setProperty('--qc-kb', '0px'), 250));

    // 跟著網站自家 FAB 的顯示規則走。網站用 body 上的 class 控制，但外部 CSS 進不了
    // shadow DOM，所以這裡自己監看同一組 class，狀態一致就不會出現「別人都讓開了、
    // 只有客服鈕還擋在上面」的情況。
    const root = shadow.querySelector('.qc-root');
    const SUPPRESS_CLASSES = ['menu-open', 'right-panel-open', 'fab-over-band'];
    function syncSuppressed() {
      const hit = SUPPRESS_CLASSES.some((c) => document.body.classList.contains(c));
      root.classList.toggle('qc-suppressed', hit);
    }
    // 諮詢鈕只有在諮詢清單有東西時才會以 .show 出現，並佔住客服鈕平常的位置，
    // 這時把客服鈕往上讓一格。
    function syncRaised() {
      const iq = document.querySelector('.inquiry-fab');
      fab.classList.toggle('qc-fab-raised', !!(iq && iq.classList.contains('show')));
    }
    syncSuppressed();
    syncRaised();
    try {
      new MutationObserver(syncSuppressed).observe(document.body, { attributes: true, attributeFilter: ['class'] });
      const iq = document.querySelector('.inquiry-fab');
      if (iq) new MutationObserver(syncRaised).observe(iq, { attributes: true, attributeFilter: ['class'] });
    } catch (e) { /* 監看失敗不影響基本功能 */ }
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
        const pass = await ensurePass();
        const res = await fetch(API_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: getSessionId(),
            message: text,
            history: history.slice(-HISTORY_LIMIT),
            pass: pass || undefined,
          }),
        });
        const data = await res.json();
        typingEl.remove();

        if (!res.ok || !data.reply) {
          appendMessage('目前連線有點不穩定，建議直接透過 LINE 官方帳號 @qiji 詢問：' + LINE_OA_URL + '，謝謝您的耐心。', 'handoff');
        } else {
          // handoff / handoff_confirm:xxx / handoff_declined 都是轉真人相關的訊息，用同一種強調樣式
          appendMessage(data.reply, String(data.source || '').indexOf('handoff') === 0 ? 'handoff' : 'bot');
          history.push({ role: 'assistant', content: data.reply, source: data.source });
        }
      } catch (err) {
        typingEl.remove();
        appendMessage('目前連線有點不穩定，建議直接透過 LINE 官方帳號 @qiji 詢問：' + LINE_OA_URL + '，謝謝您的耐心。', 'handoff');
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
