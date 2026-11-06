// 測試用：假的 AI 辨識，回傳固定的日本收據內容。
export async function recognizeReceipt() {
  await new Promise((r) => setTimeout(r, 300));
  return {
    store: '飛騨牛 まるとよ',
    titleZh: '飛驒牛 午餐',
    date: '2026-12-26',
    currency: 'JPY',
    total: 5940,
    category: 'food',
    items: [
      { name: '飛騨牛丼', nameZh: '飛驒牛丼', price: 2800, quantity: 1 },
      { name: '朴葉味噌定食', nameZh: '朴葉味噌定食', price: 1800, quantity: 1 },
      { name: '生ビール', nameZh: '生啤酒', price: 400, quantity: 2 },
    ],
  };
}
// 預設模擬 AI 失敗；測試可設定 window.__mockVoiceAi = { delay, result } 模擬 AI 回應
export async function parseTextWithAi() {
  const m = window.__mockVoiceAi;
  if (!m) throw new Error('mock: no ai');
  await new Promise((r) => setTimeout(r, m.delay || 500));
  return m.result;
}
export function warmUpAi() {}
export function getLastAiTiming() { return { prepMs: 120, tries: [{ name: 'mock-model', ms: 300, ok: true, thinking: true }], usage: { thoughtsTokenCount: 0 } }; }
export function compressImage(file) {
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve({ dataUrl: fr.result, base64: String(fr.result).split(',')[1] });
    fr.readAsDataURL(file);
  });
}
