// AI 辨識：拍收據自動拆品項、語音文字解析（需要網路）。
// 透過 Firebase AI Logic 呼叫 Gemini Developer API，網頁裡不放 API key。
import { FIREBASE_SDK, AI_MODELS, APP_CHECK } from './config.js';
import { getFb } from './firebase.js';
import { CATEGORIES } from './parse.js';

let aiMod = null;
let aiInstance = null;
const MODEL_KEY = 'ts_ai_model';

async function ensureAi() {
  if (aiInstance) return aiInstance;
  const app = getFb().app;
  await ensureAppCheck(app);
  aiMod = await import(`${FIREBASE_SDK}/firebase-ai.js`);
  aiInstance = aiMod.getAI(app, { backend: new aiMod.GoogleAIBackend() });
  return aiInstance;
}

// Firebase AI Logic 需要 App Check 證明請求來自這個網站（用 reCAPTCHA，使用者不會看到驗證框）
let appCheckReady = null;
let appCheckMod = null;
let appCheckInst = null;
function ensureAppCheck(app) {
  if (!APP_CHECK.key) return Promise.resolve();
  if (!appCheckReady) {
    appCheckReady = import(`${FIREBASE_SDK}/firebase-app-check.js`).then((ac) => {
      const provider = APP_CHECK.type === 'enterprise'
        ? new ac.ReCaptchaEnterpriseProvider(APP_CHECK.key)
        : new ac.ReCaptchaV3Provider(APP_CHECK.key);
      appCheckMod = ac;
      appCheckInst = ac.initializeAppCheck(app, { provider, isTokenAutoRefreshEnabled: true });
    }).catch((err) => { appCheckReady = null; throw err; });
  }
  return appCheckReady;
}

// App Check 失敗時查原因，顯示在錯誤訊息裡方便排查
async function appCheckDiagnosis() {
  if (!APP_CHECK.key) return 'App Check 金鑰還沒設定';
  if (!appCheckInst) return 'App Check 沒有載入';
  try {
    const t = await appCheckMod.getToken(appCheckInst, true);
    return t?.token ? '已取得 App Check token，但伺服器不接受：請確認 Firebase App Check 已用 Fraud Defense 註冊這把金鑰' : '取不到 App Check token';
  } catch (e) {
    return `取不到 App Check token：${e?.code || e?.message || e}`;
  }
}

function modelOrder() {
  const saved = localStorage.getItem(MODEL_KEY);
  return saved && AI_MODELS.includes(saved) ? [saved, ...AI_MODELS.filter((m) => m !== saved)] : AI_MODELS;
}

// 依序嘗試模型，記住第一個成功的
async function generateJson(parts, schema) {
  const ai = await ensureAi();
  let lastErr = null;
  for (const name of modelOrder()) {
    try {
      const model = aiMod.getGenerativeModel(ai, {
        model: name,
        generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.1 },
      });
      const res = await model.generateContent(parts);
      const text = res.response.text();
      localStorage.setItem(MODEL_KEY, name);
      return JSON.parse(text);
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err);
      // 只有模型不存在或不支援時才換下一個；網路或額度問題直接回報
      if (!/not found|404|not supported|unsupported|invalid model|is not found/i.test(msg)) break;
    }
  }
  if (/app check/i.test(String(lastErr?.message || ''))) {
    const why = await appCheckDiagnosis();
    const e = new Error(`${why}（${lastErr.message}）`);
    e.code = lastErr.code;
    throw e;
  }
  throw lastErr || new Error('AI 無法使用');
}

const categoryIds = CATEGORIES.map((c) => c.id);

export async function recognizeReceipt(base64Jpeg, { defaultCurrency, memberNames }) {
  const S = aiMod?.Schema || (await ensureAi(), aiMod.Schema);
  const schema = S.object({
    properties: {
      store: S.string({ description: '店名，保留原文' }),
      titleZh: S.string({ description: '這筆開支的繁體中文短標題，例如「一蘭拉麵 午餐」' }),
      date: S.string({ description: '收據日期 YYYY-MM-DD，看不出來就空字串' }),
      currency: S.string({ description: 'ISO 幣別代碼，例如 JPY、TWD' }),
      total: S.number({ description: '實際付款總額（含稅、扣掉折扣）' }),
      category: S.enumString({ enum: categoryIds }),
      items: S.array({
        items: S.object({
          properties: {
            name: S.string({ description: '品項原文' }),
            nameZh: S.string({ description: '品項繁體中文翻譯' }),
            price: S.number({ description: '單價' }),
            quantity: S.number({ description: '數量，沒寫就 1' }),
          },
        }),
      }),
    },
    optionalProperties: ['store', 'date', 'items'],
  });
  const prompt = [
    '這是一張旅行中的收據或明細照片。請辨識並以 JSON 回傳。',
    `沒有明確幣別時用 ${defaultCurrency}。`,
    'items 只放實際購買的品項，不要放小計、稅金、找零、付款方式、點數。',
    'total 是實際付款金額（含稅後、折扣後）。',
    `旅伴名字（若收據上有手寫標註可參考）：${memberNames.join('、')}。`,
  ].join('\n');
  return generateJson([prompt, { inlineData: { mimeType: 'image/jpeg', data: base64Jpeg } }], schema);
}

export async function parseTextWithAi(text, { memberNames, meName, defaultCurrency, today }) {
  const S = aiMod?.Schema || (await ensureAi(), aiMod.Schema);
  const schema = S.object({
    properties: {
      title: S.string({ description: '簡短標題，不含金額與人名' }),
      amount: S.number(),
      currency: S.string({ description: 'ISO 幣別代碼' }),
      payerName: S.string({ description: '付錢的人，必須是旅伴名字之一' }),
      participantNames: S.array({ items: S.string(), description: '要分攤的人；全部人分攤就回傳空陣列' }),
      category: S.enumString({ enum: categoryIds }),
      date: S.string({ description: 'YYYY-MM-DD' }),
    },
    optionalProperties: ['date'],
  });
  const prompt = [
    '把下面這句記帳的話整理成 JSON。',
    `旅伴：${memberNames.join('、')}。說「我」指的是 ${meName}。`,
    `沒講幣別時用 ${defaultCurrency}；「元」「塊」在日本旅行時通常指日圓。今天是 ${today}。`,
    '沒講誰付的，付錢的人就是我。說「各自」「只算我」時，分攤的人只有付錢的人。',
    `句子：「${text}」`,
  ].join('\n');
  return generateJson([prompt], schema);
}

// 把照片縮小並轉成 JPEG base64（收據文字需要解析度，長邊 1600px）
export function compressImage(file, maxSide = 1600, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      resolve({ dataUrl, base64: dataUrl.split(',')[1] });
    };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}
