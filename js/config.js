// Firebase 網頁設定值：本來就會公開在前端，資料安全靠 firestore.rules。
export const firebaseConfig = {
  apiKey: 'AIzaSyBNJJ4R8B1WsXHutIsAS-VB_5QPF4udCOs',
  authDomain: 'keyw007.github.io', // 登入元件放在 keyw007/keyw007.github.io 的 __/auth/（見 js/firebase.js linkGoogle）
  projectId: 'tripsplit-86d7e',
  storageBucket: 'tripsplit-86d7e.firebasestorage.app',
  messagingSenderId: '797754761745',
  appId: '1:797754761745:web:ace4c57c8ff46a97fa87b0',
};

export const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/13.2.0';

// 收據辨識與語音解析用的 Gemini 模型，依序嘗試，前一個不能用就換下一個
export const AI_MODELS = ['gemini-3.6-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];

// App Check：Firebase AI Logic 自 2026/11/2 起強制要求。
// type 'v3'（reCAPTCHA v3 網站金鑰）或 'enterprise'（reCAPTCHA Enterprise 金鑰）；key 空白代表還沒設定。
export const APP_CHECK = { type: 'enterprise', key: '6LcZvRIuAAAAAGdVlakrp6akdS6enEiLgaWLsKOJ' };

export const APP_VERSION = '1.2.7';
