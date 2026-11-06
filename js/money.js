// 分帳計算：換匯、每筆開支的分攤、每人餘額、最少轉帳的結算建議。
// 純函式，不依賴 Firebase，可以直接用 node 測試。

// 各幣別在畫面上顯示的小數位數
export const CURRENCY_DECIMALS = { TWD: 0, JPY: 0, KRW: 0, USD: 2, EUR: 2, HKD: 2, CNY: 2, THB: 2 };

export const CURRENCY_SYMBOL = { TWD: 'NT$', JPY: '¥', KRW: '₩', USD: 'US$', EUR: '€', HKD: 'HK$', CNY: 'CN¥', THB: '฿' };

export function decimalsOf(currency) {
  return CURRENCY_DECIMALS[currency] ?? 2;
}

export function formatMoney(amount, currency) {
  const d = decimalsOf(currency);
  const sym = CURRENCY_SYMBOL[currency] ?? `${currency} `;
  const n = Number(amount) || 0;
  const s = Math.abs(n).toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d });
  return `${n < 0 ? '-' : ''}${sym}${s}`;
}

// rates: { JPY: 0.21 } 表示 1 JPY = 0.21 基準幣（基準幣本身為 1）
export function toBase(amount, currency, trip) {
  if (!currency || currency === trip.baseCurrency) return Number(amount) || 0;
  const rate = Number(trip.rates?.[currency]);
  if (!rate) return Number(amount) || 0; // 沒設匯率時當作 1:1，畫面會提示
  return (Number(amount) || 0) * rate;
}

export function missingRates(trip, expenses) {
  const missing = new Set();
  for (const e of expenses) {
    if (e.currency && e.currency !== trip.baseCurrency && !Number(trip.rates?.[e.currency])) missing.add(e.currency);
  }
  return [...missing];
}

// 回傳這筆開支每位成員應分攤的金額（原幣別）。
// splitMode:
//   equal  → shares[memberId] > 0 的成員平分
//   shares → 依 shares 權重分
//   amount → shares[memberId] 是各自的金額
export function owedShares(expense) {
  const amount = Number(expense.amount) || 0;
  const shares = expense.shares || {};
  const ids = Object.keys(shares).filter((id) => Number(shares[id]) > 0);
  const out = {};
  if (!ids.length) return out;
  if (expense.splitMode === 'amount') {
    for (const id of ids) out[id] = Number(shares[id]);
    return out;
  }
  const weights = expense.splitMode === 'shares' ? ids.map((id) => Number(shares[id])) : ids.map(() => 1);
  const total = weights.reduce((a, b) => a + b, 0);
  ids.forEach((id, i) => { out[id] = (amount * weights[i]) / total; });
  return out;
}

// 檢查「指定金額」分攤時各人金額加總是否等於總額，回傳差額（原幣別）
export function amountSplitGap(expense) {
  if (expense.splitMode !== 'amount') return 0;
  const sum = Object.values(expense.shares || {}).reduce((a, b) => a + (Number(b) || 0), 0);
  return (Number(expense.amount) || 0) - sum;
}

// 每位成員：paid 付出、owed 應負擔、balance = paid - owed（正數代表別人欠他）
// 全部以基準幣計算。轉帳（type: transfer）視為付款人付給收款人。
export function computeBalances(trip, expenses) {
  const res = {};
  for (const m of trip.members || []) res[m.id] = { paid: 0, owed: 0, balance: 0 };
  const ensure = (id) => (res[id] ??= { paid: 0, owed: 0, balance: 0 });
  for (const e of expenses) {
    if (e.deleted) continue;
    const base = toBase(e.amount, e.currency, trip);
    if (e.type === 'transfer') {
      ensure(e.payerId).paid += base;
      ensure(e.toId).owed += base;
      continue;
    }
    if (!e.payerId) continue;
    ensure(e.payerId).paid += base;
    const owed = owedShares(e);
    for (const [id, v] of Object.entries(owed)) ensure(id).owed += toBase(v, e.currency, trip);
  }
  for (const v of Object.values(res)) v.balance = v.paid - v.owed;
  return res;
}

// 由餘額算出最少筆數的轉帳建議：[{ from, to, amount }]，金額為基準幣
export function settle(balances, decimals = 0) {
  const eps = decimals === 0 ? 0.5 : 0.005;
  const round = (x) => Number(x.toFixed(decimals));
  const debtors = [];
  const creditors = [];
  for (const [id, b] of Object.entries(balances)) {
    if (b.balance < -eps) debtors.push({ id, amt: -b.balance });
    else if (b.balance > eps) creditors.push({ id, amt: b.balance });
  }
  debtors.sort((a, b) => b.amt - a.amt);
  creditors.sort((a, b) => b.amt - a.amt);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].amt, creditors[j].amt);
    if (pay > eps) out.push({ from: debtors[i].id, to: creditors[j].id, amount: round(pay) });
    debtors[i].amt -= pay;
    creditors[j].amt -= pay;
    if (debtors[i].amt <= eps) i++;
    if (creditors[j].amt <= eps) j++;
  }
  return out;
}

// 收據品項分配：items: [{ price, quantity, memberIds }]，total 為收據總額（含稅、折扣）
// 品項加總與總額的差（稅、服務費、折扣）依各人品項比例分攤
export function splitReceipt(items, total, fallbackMemberIds) {
  const per = {};
  let itemsSum = 0;
  for (const it of items) {
    const line = (Number(it.price) || 0) * (Number(it.quantity) || 1);
    itemsSum += line;
    const ids = it.memberIds?.length ? it.memberIds : fallbackMemberIds;
    for (const id of ids) per[id] = (per[id] || 0) + line / ids.length;
  }
  const t = Number(total) || itemsSum;
  if (itemsSum > 0 && Math.abs(t - itemsSum) > 1e-9) {
    const k = t / itemsSum;
    for (const id of Object.keys(per)) per[id] *= k;
  } else if (itemsSum === 0) {
    for (const id of fallbackMemberIds) per[id] = t / fallbackMemberIds.length;
  }
  return per;
}

// 把小數攤平成指定小數位，並把尾差補到金額最大的人身上，確保加總等於總額
export function roundShares(per, total, decimals) {
  const ids = Object.keys(per);
  if (!ids.length) return {};
  const out = {};
  let sum = 0;
  for (const id of ids) { out[id] = Number(per[id].toFixed(decimals)); sum += out[id]; }
  const diff = Number((Number(total) - sum).toFixed(decimals));
  if (diff !== 0) {
    const top = ids.reduce((a, b) => (out[a] >= out[b] ? a : b));
    out[top] = Number((out[top] + diff).toFixed(decimals));
  }
  return out;
}

// ---------- 現金 ----------
// 現金紀錄（存在 expenses 集合，type: 'cash'，不算進分帳）：
//   kind 'in'  換匯／領錢：memberId 多了 amount（currency）；cost 是花了多少結算幣別（可不填）
//   kind 'adj' 清點：實際數到 counted，和帳面差 amount（可正可負）
// 開支或轉帳 payMethod === 'cash' 時：付款人的現金減少；轉帳的收款人增加。
// 回傳 { memberId: { 幣別: 金額 } }
export function cashBalances(expenses, cashRecords) {
  const res = {};
  const add = (id, cur, v) => {
    if (!id || !cur) return;
    res[id] ??= {};
    res[id][cur] = (res[id][cur] || 0) + v;
  };
  for (const r of cashRecords) {
    if (r.deleted) continue;
    add(r.memberId, r.currency, Number(r.amount) || 0);
  }
  for (const e of expenses) {
    if (e.deleted || e.payMethod !== 'cash') continue;
    const a = Number(e.amount) || 0;
    add(e.payerId, e.currency, -a);
    if (e.type === 'transfer') add(e.toId, e.currency, a);
  }
  return res;
}

// 換匯平均匯率：有填「花了多少結算幣別」的換匯紀錄，1 外幣 = 多少結算幣別
// 回傳 { 幣別: { rate, amount, cost } }
export function exchangeAverages(cashRecords, baseCurrency) {
  const sum = {};
  for (const r of cashRecords) {
    if (r.deleted || r.kind !== 'in' || r.currency === baseCurrency) continue;
    const cost = Number(r.cost) || 0;
    const amount = Number(r.amount) || 0;
    if (!(cost > 0 && amount > 0)) continue;
    sum[r.currency] ??= { amount: 0, cost: 0 };
    sum[r.currency].amount += amount;
    sum[r.currency].cost += cost;
  }
  return Object.fromEntries(Object.entries(sum).map(([c, s]) => [c, { ...s, rate: s.cost / s.amount }]));
}

// 匯率顯示用：保留 4 位有效數字（0.2104、32.45、0.02315）
export function roundRate(r) {
  return Number(Number(r).toPrecision(4));
}
