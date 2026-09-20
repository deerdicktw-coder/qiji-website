/**
 * FAQ 比對邏輯 — 不依賴任何外部套件或斷詞工具。
 *
 * 中文沒有天然的空白斷詞，所以用兩種訊號取最大值：
 *   1. 關鍵字命中率：使用者輸入是否直接包含 FAQ 條目預先標好的關鍵字（substring）
 *   2. 字元 bigram Jaccard 相似度：把字串切成連續兩字的組合（"營業時間" -> "營業","業時","時間"），
 *      比對集合重疊程度。這是不需要斷詞、對中文短句也相對穩定的簡單做法。
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

function normalize(text) {
  return String(text || '').trim().toLowerCase();
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

function keywordScore(message, keywords) {
  if (!keywords || keywords.length === 0) return 0;
  const msg = normalize(message);
  let weighted = 0;
  keywords.forEach((kw, idx) => {
    const weight = idx < PRIMARY_KEYWORD_COUNT ? KEYWORD_PRIMARY_WEIGHT : KEYWORD_SECONDARY_WEIGHT;
    if (kw && msg.includes(normalize(kw))) weighted += weight;
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
