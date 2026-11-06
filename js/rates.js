// 自動抓匯率（需要網路）。三個免費、不用金鑰的來源依序嘗試，前一個失敗就換下一個。
// 回傳 { rates: { JPY: 0.2104, ... }, date: '2026-12-20', source: '...' }，rates 是「1 外幣 = 多少結算幣別」。
import { roundRate } from './money.js';

// 每個來源回傳「1 結算幣別 = 多少外幣」的對照表（鍵是大寫幣別代碼）
const SOURCES = [
  {
    name: 'currency-api（jsDelivr）',
    url: (b) => `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${b.toLowerCase()}.json`,
    parse: (d, b) => ({ date: d.date, table: upperKeys(d[b.toLowerCase()]) }),
  },
  {
    name: 'currency-api（Cloudflare）',
    url: (b) => `https://latest.currency-api.pages.dev/v1/currencies/${b.toLowerCase()}.json`,
    parse: (d, b) => ({ date: d.date, table: upperKeys(d[b.toLowerCase()]) }),
  },
  {
    name: 'ExchangeRate-API',
    url: (b) => `https://open.er-api.com/v6/latest/${b}`,
    parse: (d) => {
      if (d.result !== 'success') throw new Error(d['error-type'] || 'result 不是 success');
      return { date: (d.time_last_update_utc ? new Date(d.time_last_update_utc).toISOString().slice(0, 10) : ''), table: d.rates };
    },
  },
];

function upperKeys(obj) {
  if (!obj) throw new Error('格式不對');
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k.toUpperCase(), v]));
}

async function getJson(url, ms = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    throw new Error(err.name === 'AbortError' ? '逾時' : err.message || String(err));
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchRates(baseCurrency, currencies) {
  const wanted = currencies.filter((c) => c && c !== baseCurrency);
  const errors = [];
  for (const src of SOURCES) {
    try {
      const { date, table } = src.parse(await getJson(src.url(baseCurrency)), baseCurrency);
      const rates = {};
      for (const c of wanted) {
        const perBase = Number(table[c]); // 1 結算幣別 = perBase 外幣
        if (perBase > 0) rates[c] = roundRate(1 / perBase);
      }
      if (!Object.keys(rates).length && wanted.length) throw new Error('沒有需要的幣別');
      return { rates, date: date || '', source: src.name };
    } catch (err) {
      errors.push(`${src.name}：${err.message}`);
    }
  }
  throw new Error(`抓不到匯率（${errors.join('；')}）`);
}
