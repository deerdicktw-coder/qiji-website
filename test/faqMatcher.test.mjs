/**
 * 用 Node 內建的 test runner（node:test），不需要額外安裝 Vitest 或任何套件。
 * 跑法：node --test test/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { matchFaq, rankFaq, buildRagContext } from '../functions/lib/faqMatcher.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const faqData = JSON.parse(readFileSync(path.join(__dirname, '../functions/data/faq.json'), 'utf-8'));

test('faq.json 內容完整，每條都有必要欄位', () => {
  assert.ok(faqData.length >= 10, 'FAQ 條目數量應該至少 10 條');
  for (const item of faqData) {
    assert.ok(item.id && item.question && item.answer, `條目缺少必要欄位: ${JSON.stringify(item)}`);
    assert.ok(Array.isArray(item.keywords) && item.keywords.length > 0, `${item.id} 缺少 keywords`);
  }
});

test('直接問營業時間，應該命中 business-hours', () => {
  const { best, score } = matchFaq('你們營業時間是幾點？', faqData);
  assert.ok(best, '應該要命中某一條 FAQ');
  assert.equal(best.id, 'business-hours');
  assert.ok(score >= 0.6);
});

test('用口語化問法問地址，也應該命中 location-directions', () => {
  const { best } = matchFaq('請問你們在哪裡啊，怎麼過去？', faqData);
  assert.ok(best, '口語化問法也應該命中');
  assert.equal(best.id, 'location-directions');
});

test('完全不相關的問題不應該命中任何 FAQ', () => {
  const { best, score } = matchFaq('今天天氣如何台北101多高', faqData);
  assert.equal(best, null);
  assert.ok(score < 0.6);
});

test('rankFaq 回傳結果依分數由高到低排序', () => {
  const ranked = rankFaq('生日當月有優惠嗎', faqData);
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i - 1].score >= ranked[i].score);
  }
  assert.equal(ranked[0].item.id, 'birthday-discount');
});

test('buildRagContext 在分數太低時回傳空字串，不會塞進不相關內容', () => {
  const ranked = rankFaq('外星人存在嗎', faqData);
  const context = buildRagContext(ranked);
  assert.equal(context, '');
});

test('buildRagContext 在有相關度時回傳可讀的 Q/A 文字', () => {
  const ranked = rankFaq('請問可以刷卡嗎', faqData);
  const context = buildRagContext(ranked);
  assert.ok(context.includes('Q:'));
  assert.ok(context.includes('付款'));
});
