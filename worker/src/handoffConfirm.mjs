// 轉真人「發信前先確認」相關的純函式與常數，抽成獨立檔案（不 import faq.json），
// 方便 Node 原生 --test 直接單元測試，不用經過 wrangler 的 bundler。
import { LINE_OA_ID, LINE_OA_URL, FREETIME_BOOKING_URL, BOOKING_INTENT_KEYWORDS } from './constants.mjs';

// 2026-09-20：發現 Email 通知量太大（每次轉真人都會寄信給 Carrie，等於每個誤判/口語抱怨/連續
// 答不出來都會變成一封信），使用者要求「發信前先問過客人」，避免騷擾信件。
// 做法：所有原本會 notifyHandoff 的地方，改成先回一則「要不要幫你發信通知？」的確認訊息
// （source 用 `handoff_confirm:<原因>` 標記，不寄信、不算 handoffTriggered），
// 下一輪如果客人明確說「要」才真的寄信；說「不用」就不寄，並保留 LINE／FreeTime 連結讓客人自己選；
// 如果客人沒有給出明確是非回答（可能是問了別的問題），就當作放棄這次確認，訊息照正常流程處理。
export const CONFIRM_SOURCE_PREFIX = 'handoff_confirm:';

const NEGATIVE_REPLY_PATTERNS = [
  '不用', '不需要', '不要', '先不用', '不用了', '算了', '沒關係', '不寄', '不用寄',
  '不用通知', '免了', 'no', 'NO', 'No',
];
const AFFIRMATIVE_REPLY_PATTERNS = [
  '要', '好', '是', '對', '可以', 'ok', 'OK', 'Ok', '麻煩', '幫我通知', '幫我發', '幫我寄', '寄',
  '通知她', '通知一下', '拜託',
];

export function isNegativeReply(message) {
  return NEGATIVE_REPLY_PATTERNS.some((kw) => message.includes(kw));
}

// 要先排除「不用／不要」這種否定語句裡也含有「要」字的情況，所以否定判斷要優先於肯定判斷，
// 呼叫端務必先呼叫 isNegativeReply()，只有在不是否定的情況下才呼叫這個函式判斷是否為肯定回覆。
export function isAffirmativeReply(message) {
  return AFFIRMATIVE_REPLY_PATTERNS.some((kw) => message.includes(kw));
}

export function handoffMessage(reason, message = '') {
  const isBookingRelated = BOOKING_INTENT_KEYWORDS.some((kw) => message.includes(kw));
  const lineHint = `這邊會通知 Carrie 老師，但信箱通知沒辦法馬上被看到，建議直接加 LINE 官方帳號 ${LINE_OA_ID} 私訊，會比等這裡回覆快很多：${LINE_OA_URL}（手機點開會直接跳轉加好友，電腦點開會顯示 QR Code）`;
  const bookingHint = isBookingRelated
    ? `；如果是要約時段，也可以直接到線上預約系統自己選時間，不用等人回覆：${FREETIME_BOOKING_URL}`
    : '';
  const base = `${lineHint}${bookingHint}！`;
  return reason === 'explicit_request' ? `好的，${base}` : base;
}

export function handoffConfirmMessage(reason, message = '') {
  const isBookingRelated = BOOKING_INTENT_KEYWORDS.some((kw) => message.includes(kw));
  const bookingHint = isBookingRelated
    ? `如果是要約時段，也可以直接到線上預約系統自己選時間，不用等人回覆：${FREETIME_BOOKING_URL}。`
    : '';
  return (
    `這個問題比較需要 Carrie 老師親自確認一下。要不要我發 Email 通知她？` +
    `（她一人作業，Email 不一定能馬上看到；如果想更快得到回覆，也可以直接加 LINE 官方帳號 ${LINE_OA_ID} 私訊：${LINE_OA_URL}）` +
    `${bookingHint}跟我回覆「要」或「不用」都可以喔。`
  );
}

export function handoffDeclineMessage() {
  return `好的，那先不發信通知囉。如果之後想直接找 Carrie 老師，都可以透過 LINE 官方帳號 ${LINE_OA_ID} 私訊：${LINE_OA_URL}。`;
}
