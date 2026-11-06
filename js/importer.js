// 從試算表匯入（純函式，可以用 node 測試）。
// 使用者在 Google 試算表選取含標題列的範圍 → 複製 → 貼到 App（Tab 分隔），或匯入下載的 CSV。
// 依標題名稱找欄位，所以欄位順序可以不同、可以多出其他欄。認得的欄位：
//   日期、項目（或 名稱／標題）、類別、TWD（或 台幣）、JPY（或 日圓／日幣）、
//   「<成員名字> 先付」（或「<名字>付」）、付款方式、狀態、備註、各自付
import { guessCategory } from './parse.js';

// Tab 分隔或 CSV（支援雙引號、引號內換行）
export function parseTable(text) {
  const src = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const firstLine = src.split('\n', 1)[0];
  const sep = firstLine.includes('\t') ? '\t' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ''));
}

export function toNumber(s) {
  const n = parseFloat(String(s ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

const isTrue = (s) => /^(true|是|v|✓|✔|y|yes|1)$/i.test(String(s ?? '').trim());

const CATEGORY_WORDS = [
  [/住宿|飯店|旅館|山屋/, 'lodging'],
  [/機票|交通|車|巴士|纜車/, 'transport'],
  [/餐|食/, 'food'],
  [/門票|票|入場/, 'ticket'],
  [/購物|伴手禮/, 'shopping'],
  [/超商|零食/, 'snack'],
];

function categoryOf(cat, title) {
  for (const [re, id] of CATEGORY_WORDS) if (re.test(cat || '')) return id;
  if (cat) return 'other'; // 網路、保險、寄物與其他…
  return guessCategory(title || '');
}

// 「12/25」「2026/12/25」「2026-12-25」→ YYYY-MM-DD。只有月日時，選離今天最近的年份（今天 60 天前以前就算明年）
export function parseDate(s, today = new Date()) {
  const str = String(s || '').trim();
  let m = str.match(/^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = str.match(/^(\d{1,2})[/.-](\d{1,2})$/);
  if (!m) return '';
  const mo = Number(m[1]);
  const d = Number(m[2]);
  let y = today.getFullYear();
  const cand = new Date(y, mo - 1, d);
  if (cand < new Date(today.getTime() - 60 * 86400000)) y += 1;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// 找欄位
function columnsOf(header, members) {
  const find = (re) => header.findIndex((h) => re.test(h));
  const payerCols = [];
  for (const m of members) {
    const i = header.findIndex((h) => h.includes(m.name) && /付/.test(h));
    if (i >= 0) payerCols.push({ i, id: m.id });
  }
  return {
    date: find(/日期/),
    title: find(/^(項目|名稱|標題|品項|內容)/),
    cat: find(/類別|分類/),
    twd: find(/^(TWD|台幣|新台幣|NT\$?)$/i),
    jpy: find(/^(JPY|日圓|日幣|日元)$/i),
    method: find(/付款方式|支付方式/),
    status: find(/狀態/),
    note: find(/備註|說明/),
    each: find(/各自付/),
    payerCols,
  };
}

// 回傳 { items, error }。item：{ date, title, category, amount, currency, payerId, payMethod, note, checked, reason }
// 預設勾選：有指定誰付、不是「預估」、付款方式是刷卡（事先刷卡）或狀態是「已付」
export function rowsToItems(rows, { members, today = new Date() }) {
  if (!rows.length) return { items: [], error: '沒有資料' };
  const hi = rows.findIndex((r) => r.some((c) => /^(項目|名稱|標題|品項|內容)$/.test(c)) && r.some((c) => /^(TWD|JPY|台幣|日圓|日幣|金額)$/i.test(c)));
  if (hi < 0) return { items: [], error: '找不到標題列：請連第一列（日期、項目、TWD、JPY…）一起複製' };
  const col = columnsOf(rows[hi], members);
  if (col.title < 0 || (col.twd < 0 && col.jpy < 0)) return { items: [], error: '標題列要有「項目」和「TWD」或「JPY」欄' };
  const get = (r, i) => (i >= 0 ? r[i] ?? '' : '');

  const raw = [];
  for (const r of rows.slice(hi + 1)) {
    const title = get(r, col.title);
    if (!title) continue;
    const twd = toNumber(get(r, col.twd));
    const jpy = toNumber(get(r, col.jpy));
    if (!(twd > 0) && !(jpy > 0)) continue;
    const payers = col.payerCols.filter((p) => isTrue(get(r, p.i))).map((p) => p.id);
    const method = get(r, col.method);
    const status = get(r, col.status);
    const note = get(r, col.note);
    const each = isTrue(get(r, col.each));
    const base = { title, category: categoryOf(get(r, col.cat), title), date: parseDate(get(r, col.date), today), payerId: payers[0] || null, note, status, method, each, multiPayer: payers.length > 1 };
    if (twd > 0) {
      raw.push({ ...base, amount: twd, currency: 'TWD', payMethod: /現金/.test(method) && !/日圓/.test(method) ? 'cash' : 'card' });
      // 台幣預付＋日圓現場付：日圓部分另一筆，到時候付了再記
      if (jpy > 0) raw.push({ ...base, title: `${title}（現場付）`, amount: jpy, currency: 'JPY', payMethod: 'cash', onSite: true });
    } else {
      raw.push({ ...base, amount: jpy, currency: 'JPY', payMethod: /現金/.test(method) ? 'cash' : 'card' });
    }
  }
  // 沒寫日期的，放在行程最早的那一天
  const first = raw.map((x) => x.date).filter(Boolean).sort()[0] || '';
  const items = raw.map((x) => {
    let reason = '';
    if (x.each) reason = '各自付，不影響分帳';
    else if (!x.payerId) reason = '沒有勾誰先付';
    else if (x.multiPayer) reason = '勾了不只一位付款人';
    else if (/預估/.test(x.status)) reason = '還是預估金額';
    else if (x.onSite) reason = '現場才付，到時候再記';
    else if (!/刷卡/.test(x.method) && !/已付/.test(x.status)) reason = `${x.method || '付款方式未定'}，付了再記`;
    const { status, method, each, multiPayer, onSite, ...rest } = x;
    return { ...rest, date: x.date || first, checked: !reason, reason };
  });
  return { items, error: '' };
}

// 已經記過的：同日期、同幣別、同金額、同標題
export function markDuplicates(items, expenses) {
  const key = (e) => `${e.date}|${e.currency}|${Number(e.amount)}|${(e.title || '').trim()}`;
  const have = new Set(expenses.map(key));
  return items.map((it) => (have.has(key(it)) ? { ...it, checked: false, reason: '已經匯入過', dup: true } : it));
}
