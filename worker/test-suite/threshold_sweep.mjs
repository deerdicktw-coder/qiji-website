/**
 * 離線比對門檻掃描：用 generate_questions.py 裡既有的口語化題庫（每題都標註了預期命中的 FAQ id），
 * 不打任何 API、不耗 LLM 額度，純跑 faqMatcher 看不同門檻下的命中狀況。
 *
 * 跑法：node test-suite/threshold_sweep.mjs
 *
 * 用途：調整 FAQ_MATCH_THRESHOLD 前，先確認提高門檻會修掉哪些誤配、又會不會誤傷本來正確的命中。
 */
import { readFileSync } from 'node:fs';
import { matchFaq } from '../src/faqMatcher.mjs';

const faqData = JSON.parse(readFileSync(new URL('../src/faq.json', import.meta.url), 'utf-8'));

// 這份對照表直接對應 test-suite/generate_questions.py 裡的 paraphrases（口語化問法 -> 預期 FAQ id）
const EXPECTED = {
  'business-hours': ['你們幾點營業啊', '禮拜天有開嗎', '平常開到幾點', '你們周日公休嗎', '最晚可以幾點到'],
  'location-directions': ['你們店在哪', '怎麼去你們那裡', '停車方便嗎', '你們地址給我一下'],
  'payment-methods': ['可以刷卡嗎', '有沒有分期', '收現金嗎', '可以用line pay嗎'],
  'membership-vs-deposit': ['會員跟儲值差在哪', '哪個比較划算', 'care club是什麼', '入會費跟月費差別'],
  'birthday-discount': ['生日有優惠嗎', '生日月份折扣多少', '生日當月可以打折嗎'],
  'how-to-book': ['要怎麼約時間', '第一次怎麼預約', '線上可以約嗎', '要打電話預約嗎'],
  'reschedule-cancel': ['我想改約時間', '可以取消預約嗎', '遲到會怎樣', '突然不能去怎麼辦'],
  'course-facial-gua-sha': ['臉部撥筋要多少錢', '撥筋一次多少'],
  'course-exosome-algae': ['肌泌藻針要多少', '肌泌藻針費用是多少'],
  'course-snow-algae': ['雪藻喚膚要花多少錢', '招牌課程多少錢'],
  'course-painless-algae-price': ['無痛藻針費用多少', '無痛的藻針多少錢'],
  'course-micro-mts': ['微雕蘊膚費用', '最高階的課程多少錢'],
  'course-back-cleaning': ['背部清潔怎麼收費', '背後粉刺清潔多少錢'],
  'course-cupping-price': ['罐撥怎麼算錢', '五行罐撥一次多少', '身體按摩多少錢', '拔罐價錢多少'],
  'course-hair-removal': ['除毛怎麼算', '熱蠟除腋毛多少錢', '除小腿毛多少錢'],
  'course-nail': ['做美甲多少錢', '單色美甲費用'],
  'course-addon-general': ['可以加購什麼', '有哪些加購選項', '安瓶加購多少錢'],
  'sensitive-skin-algae': ['我是敏感肌可以做藻針嗎', '皮膚很敏感適合嗎'],
  'aftercare': ['做完課程要注意什麼', '課後保養怎麼做', '做完可以化妝嗎'],
  'algae-course-diff': ['藻針課程差在哪', '雪藻跟肌泌哪個好', '該選哪個藻針課程'],
  'ampoule-addon': ['安瓶有哪些選擇', '可以加購安瓶嗎'],
  'cupping-marks': ['拔罐印多久會退', '罐印要多久才會消'],
  'course-frequency': ['多久做一次比較好', '課程頻率建議'],
  'extraction-time-limit': ['清粉刺有時間限制嗎', '清粉刺要多久'],
  'recovery-algae': ['做完藻針會脫皮嗎', '藻針恢復期多久'],
};

// 這些是「不該命中任何 FAQ、應該交給 LLM 依知識庫回答」的一般性問題。
// 之所以列出來，是因為實測發現「臉很乾又會脫皮怎麼辦」會誤配到 recovery-algae（藻針術後恢復），
// 客人根本還沒做過課程，卻拿到術後說明，這是最傷「人味」的答非所問。
const SHOULD_NOT_MATCH = [
  '臉很乾又會脫皮怎麼辦',
  '換季皮膚很癢怎麼辦',
  '最近長很多痘痘怎麼辦',
  '毛孔粗大有救嗎',
  '第一次去要注意什麼',
];

const thresholds = [0.6, 0.65, 0.7, 0.75];

for (const th of thresholds) {
  let hit = 0, miss = 0, wrong = 0;
  const missed = [], wronglyMatched = [], falsePositives = [];

  for (const [expectedId, queries] of Object.entries(EXPECTED)) {
    for (const q of queries) {
      const { best, score } = matchFaq(q, faqData, th);
      if (!best) { miss += 1; missed.push(`${q} (期望 ${expectedId}, 分數 ${score.toFixed(2)})`); }
      else if (best.id !== expectedId) { wrong += 1; wronglyMatched.push(`${q} -> ${best.id} (期望 ${expectedId})`); }
      else hit += 1;
    }
  }

  for (const q of SHOULD_NOT_MATCH) {
    const { best, score } = matchFaq(q, faqData, th);
    if (best) falsePositives.push(`${q} -> ${best.id} (${score.toFixed(2)})`);
  }

  console.log(`\n===== 門檻 ${th} =====`);
  console.log(`正確命中 ${hit} / 落到 LLM ${miss} / 配錯條目 ${wrong} / 不該命中卻命中 ${falsePositives.length}`);
  if (missed.length) console.log('  落到 LLM：', missed.join(' | '));
  if (wronglyMatched.length) console.log('  配錯：', wronglyMatched.join(' | '));
  if (falsePositives.length) console.log('  誤配（答非所問）：', falsePositives.join(' | '));
}
