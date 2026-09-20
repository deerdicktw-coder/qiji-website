/**
 * FAQ 比對邏輯 — 不依賴任何外部套件或斷詞工具。
 *
 * 中文沒有天然的空白斷詞，所以用三種訊號取最大值：
 *   1. 關鍵字命中率：使用者輸入是否直接包含（或打錯字但很接近）FAQ 條目預先標好的關鍵字
 *   2. 字元 bigram Jaccard 相似度：把字串切成連續兩字的組合（"營業時間" -> "營業","業時","時間"），
 *      比對集合重疊程度。這是不需要斷詞、對中文短句也相對穩定的簡單做法。
 *   3. 關鍵字模糊比對（Levenshtein 編輯距離）：容忍使用者打錯字、簡體字混打（例如「雪早喚膚」
 *      「针」打成簡體）。在訊息裡滑動跟關鍵字等長的視窗，只要編輯距離在容許範圍內就算命中，
 *      比 bigram 更直接對應「打錯一兩個字」這種常見輸入情境。
 *
 * 之後若 FAQ 數量明顯增加（例如 > 150 條）或想要更精準的語義比對，
 * 可以把這個檔案換成呼叫 embedding API + Cloudflare Vectorize，介面（matchFaq 的輸入/輸出）不需要變。
 */

const KEYWORD_PRIMARY_WEIGHT = 2;
const KEYWORD_SECONDARY_WEIGHT = 1;
const PRIMARY_KEYWORD_COUNT = 2;
// 分母用固定值而不是 keywords.length：長的關鍵字列表（罕見問法變體較多）不該因此稀釋分數。
// 3 大約對應「命中 1 個主要關鍵字 + 1 個次要關鍵字」或「命中 2 個主要關鍵字」，視為已經很確定。
const CONFIDENCE_DENOMINATOR = 3;
// 模糊比對容許的編輯距離。3 個字以內的關鍵字不做模糊比對：實測發現短關鍵字（例如「改時間」
// 「營業時間」都有「時間」這個共同片段）編輯距離 1 很容易誤配到語意完全不同的關鍵字，
// 短字串每改一個字影響的語意比例太大，不值得冒誤配的風險。4~6 個字容許錯 1 個字，
// 7 個字以上容許錯 2 個字，這個門檻是實測調整後覺得平衡的值。
function maxAllowedDistance(len) {
  if (len <= 3) return 0;
  return len <= 6 ? 1 : 2;
}

// 常見簡體字 → 繁體字對照表，只收錄跟 QIJI 服務內容相關、實測會用到的字，不追求完整涵蓋
// 整個簡繁轉換（那需要專門的套件如 opencc-js）。用意是讓「针」「疗」這類簡體打錯字/混打
// 也能命中原本用繁體字寫的關鍵字。
const SIMPLIFIED_TO_TRADITIONAL = {
  针: '針', 疗: '療', 复: '復', 优: '優', 会: '會', 员: '員', 储: '儲',
  预: '預', 约: '約', 时: '時', 间: '間', 营: '營', 业: '業', 价: '價', 钱: '錢',
  课: '課', 护: '護', 肤: '膚', 洁: '潔', 净: '淨', 脸: '臉', 头: '頭',
  发: '髮', 颈: '頸', 体: '體', 检: '檢', 测: '測', 问: '問', 题: '題', 电: '電',
  话: '話', 号: '號', 线: '線', 银: '銀', 转: '轉', 换: '換', 单: '單', 账: '賬',
  拨: '撥', 后: '後', 达: '達', 长: '長', 应: '應', 处: '處',
  询: '詢', 别: '別', 无: '無', 敏: '敏', 龄: '齡', 适: '適',
  个: '個', 现: '現', 场: '場', 乐: '樂', 车: '車', 医: '醫', 药: '藥',
};

function toTraditional(text) {
  return String(text || '')
    .split('')
    .map((ch) => SIMPLIFIED_TO_TRADITIONAL[ch] || ch)
    .join('');
}

function normalize(text) {
  return toTraditional(String(text || '').trim().toLowerCase());
}

// 標準 Levenshtein 編輯距離（插入/刪除/替換各算 1 步）。
function levenshtein(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}

// 判斷關鍵字是不是「打錯字但很接近」出現在訊息裡：在訊息裡滑動跟關鍵字等長（含前後各多 1 字的
// 容錯）的視窗，取編輯距離最小值，在容許範圍內就算命中。
function fuzzyIncludes(msg, keyword) {
  const kw = normalize(keyword);
  if (!kw) return false;
  if (msg.includes(kw)) return true; // 完全命中，最快路徑
  const allowed = maxAllowedDistance(kw.length);
  if (allowed === 0) return false; // 太短的關鍵字（1 個字）不做模糊比對，容易誤判
  if (msg.length < kw.length - allowed) return false;
  for (let start = 0; start <= msg.length - Math.max(1, kw.length - allowed); start++) {
    for (const winLen of [kw.length - 1, kw.length, kw.length + 1]) {
      if (winLen <= 0) continue;
      const window = msg.slice(start, start + winLen);
      if (window.length === 0) continue;
      if (levenshtein(window, kw) <= allowed) return true;
    }
  }
  return false;
}

function bigrams(text) {
  const t = normalize(text).replace(/\s+/g, '');
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) {
    set.add(t.slice(i, i + 2));
  }
  // 單字或空字串時退而求其次，用整串當作一個 token，避免相似度永遠是 0
  if (set.size === 0 && t.length > 0) set.add(t);
  return set;
}

function jaccard(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// 模糊命中（有打錯字但很接近）給打折權重，比完全命中保守一點，避免容錯範圍放太寬反而誤配。
const FUZZY_MATCH_DISCOUNT = 0.75;

function keywordScore(message, keywords) {
  if (!keywords || keywords.length === 0) return 0;
  const msg = normalize(message);
  let weighted = 0;
  keywords.forEach((kw, idx) => {
    const weight = idx < PRIMARY_KEYWORD_COUNT ? KEYWORD_PRIMARY_WEIGHT : KEYWORD_SECONDARY_WEIGHT;
    if (!kw) return;
    const normKw = normalize(kw);
    if (msg.includes(normKw)) {
      weighted += weight; // 完全命中（含簡體字自動轉繁體後的命中）
    } else if (fuzzyIncludes(msg, kw)) {
      weighted += weight * FUZZY_MATCH_DISCOUNT; // 打錯字但很接近
    }
  });
  return Math.min(1, weighted / CONFIDENCE_DENOMINATOR);
}

/**
 * @param {string} message 使用者輸入
 * @param {Array} faqList functions/data/faq.json 的內容
 * @returns {Array<{item: object, score: number}>} 依分數由高到低排序
 */
export function rankFaq(message, faqList) {
  const msgBigrams = bigrams(message);

  return faqList
    .map((item) => {
      const kwScore = keywordScore(message, item.keywords);
      const questionBigramScore = jaccard(msgBigrams, bigrams(item.question));
      const keywordBigramScore = jaccard(msgBigrams, bigrams((item.keywords || []).join('')));

      // bigram 分數通常偏低（短句組合有限），給一點加成讓它跟關鍵字分數在同個量級上可比較
      const score = Math.min(1, Math.max(kwScore, questionBigramScore * 1.4, keywordBigramScore * 1.2));

      return { item, score };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * @param {string} message
 * @param {Array} faqList
 * @param {number} threshold 直接回定稿的門檻，預設 0.6
 * @returns {{ best: object|null, score: number, ranked: Array }}
 */
export function matchFaq(message, faqList, threshold = 0.6) {
  const ranked = rankFaq(message, faqList);
  const top = ranked[0];
  if (top && top.score >= threshold) {
    return { best: top.item, score: top.score, ranked };
  }
  return { best: null, score: top ? top.score : 0, ranked };
}

/**
 * 取相關度中等的 FAQ 條目給 LLM 當 RAG context（不到直接回答的門檻，但比完全不相關高）
 * @param {Array<{item:object, score:number}>} ranked matchFaq 回傳的 ranked
 * @param {number} minScore
 * @param {number} limit
 */
export function buildRagContext(ranked, minScore = 0.15, limit = 3) {
  return ranked
    .filter((r) => r.score >= minScore)
    .slice(0, limit)
    .map((r) => `Q: ${r.item.question}\nA: ${r.item.answer}`)
    .join('\n\n');
}
