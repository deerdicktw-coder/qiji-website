// 共用常數：轉真人的通知是寄 Email，凱莉不會馬上看到，所以轉真人訊息裡要主動引導客人改用比較
// 即時的管道，而不是讓客人誤以為「等一下這個對話視窗就會有人回」。真的需要即時互動 → LINE 官方
// 帳號；單純要約時段 → 直接引導去 FreeTime 線上預約系統自己選（不用等任何人回覆）。網址跟 LINE
// ID 都是官網上本來就公開寫的資訊，這裡只是讓 AI 客服也主動講出來。
export const LINE_OA_ID = '@qiji';
// 官網本來就用這個連結做 LINE 加好友按鈕：手機點開會直接跳轉到 LINE 加好友，電腦點開會顯示
// QR Code 讓客人掃描，兩種情境都涵蓋，所以 AI 客服建議加 LINE 時也附上同一個連結，而不是只
// 留一個文字帳號名稱讓客人自己去 LINE 裡搜尋。
export const LINE_OA_URL = 'https://page.line.me/026xbaov?openQrModal=true';
export const FREETIME_BOOKING_URL = 'https://myfreetime.io/shop/qijiskin';
export const BOOKING_INTENT_KEYWORDS = ['預約', '約診', '約時間', '約時段', '訂位', '改期', '改時間', '取消', '時段', '有名額', '有空檔', '有沒有空'];
