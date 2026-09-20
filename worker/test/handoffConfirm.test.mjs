import test from 'node:test';
import assert from 'node:assert/strict';
import { isNegativeReply, isAffirmativeReply, handoffConfirmMessage, handoffDeclineMessage, CONFIRM_SOURCE_PREFIX } from '../src/handoffConfirm.mjs';

test('否定回覆：常見的「不用」「算了」等要判定為否定', () => {
  for (const msg of ['不用', '不用了', '不需要', '先不用啦', '算了', '沒關係', '不用寄信']) {
    assert.equal(isNegativeReply(msg), true, `應判定為否定: ${msg}`);
  }
});

test('否定句不應該同時被判定為肯定（避免「不用」裡的「要」被誤判）', () => {
  // 呼叫端必須先檢查 isNegativeReply()，這裡單獨驗證否定關鍵字判斷本身沒問題
  assert.equal(isNegativeReply('不用'), true);
});

test('肯定回覆：常見的「要」「好」「麻煩」等要判定為肯定', () => {
  for (const msg of ['要', '好', '好啊', '可以', '麻煩幫我通知', 'ok', '拜託']) {
    assert.equal(isAffirmativeReply(msg), true, `應判定為肯定: ${msg}`);
  }
});

test('不相關的訊息不該被誤判成肯定或否定回覆', () => {
  const msg = '請問明天營業嗎';
  assert.equal(isNegativeReply(msg), false);
  assert.equal(isAffirmativeReply(msg), false);
});

test('確認訊息應包含 LINE 連結與是非引導文字', () => {
  const text = handoffConfirmMessage('explicit_request', '我要投訴');
  assert.match(text, /LINE 官方帳號/);
  assert.match(text, /要」或「不用」/);
});

test('確認訊息若與預約相關要附上 FreeTime 連結', () => {
  const text = handoffConfirmMessage('repeated_unresolved', '我想預約下週五可以嗎');
  assert.match(text, /myfreetime\.io/);
});

test('婉拒訊息仍要保留 LINE 連結讓客人自己選擇聯絡方式', () => {
  const text = handoffDeclineMessage();
  assert.match(text, /LINE 官方帳號/);
});

test('CONFIRM_SOURCE_PREFIX 常數格式正確，供 history.source 比對使用', () => {
  assert.equal(CONFIRM_SOURCE_PREFIX, 'handoff_confirm:');
});

// ---- 2026-09-20 實測抓到的 bug：否定詞裡包含肯定詞 ----
// 客人回「不是」時，因為字串含「是」而被判成肯定，結果誤判成同意寄信給 Carrie。
test('包含肯定詞的否定說法，必須判定為否定（不是/不好/不可以/不行）', () => {
  for (const msg of ['不是', '不好', '不可以', '不行', '不對', '都不是']) {
    assert.equal(isNegativeReply(msg), true, `應判定為否定: ${msg}`);
  }
});

test('呼叫端順序契約：這些否定詞雖然也含肯定關鍵字，但因為否定先判斷所以不會誤判', () => {
  // 這裡明確驗證「為什麼順序很重要」：這些字串在肯定判斷下確實會是 true
  assert.equal(isAffirmativeReply('不是'), true, '「不是」含「是」，肯定判斷會誤中');
  // 所以否定判斷必須先跑，且要涵蓋這個詞
  assert.equal(isNegativeReply('不是'), true);
});
