// 執行：node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { owedShares, computeBalances, settle, splitReceipt, roundShares, toBase, formatMoney } from '../js/money.js';
import { parseExpenseText, cnToNumber } from '../js/parse.js';

const trip = {
  baseCurrency: 'TWD',
  rates: { JPY: 0.21 },
  members: [{ id: 'a', name: '郁文' }, { id: 'b', name: '吳薰' }],
};
const members = trip.members;

test('平分與換匯', () => {
  const e = { amount: 2000, currency: 'JPY', payerId: 'a', splitMode: 'equal', shares: { a: 1, b: 1 } };
  assert.deepEqual(owedShares(e), { a: 1000, b: 1000 });
  const bal = computeBalances(trip, [e]);
  assert.equal(Math.round(bal.a.balance), 210);
  assert.equal(Math.round(bal.b.balance), -210);
  assert.deepEqual(settle(bal), [{ from: 'b', to: 'a', amount: 210 }]);
});

test('只算一人的開支不影響結算', () => {
  const e = { amount: 420, currency: 'JPY', payerId: 'a', splitMode: 'equal', shares: { a: 1 } };
  const bal = computeBalances(trip, [e]);
  assert.equal(bal.a.balance, 0);
  assert.deepEqual(settle(bal), []);
});

test('轉帳抵銷欠款', () => {
  const es = [
    { amount: 37960, currency: 'TWD', payerId: 'b', splitMode: 'equal', shares: { a: 1, b: 1 } },
    { type: 'transfer', amount: 18980, currency: 'TWD', payerId: 'a', toId: 'b' },
  ];
  assert.deepEqual(settle(computeBalances(trip, es)), []);
});

test('指定金額與權重', () => {
  assert.deepEqual(owedShares({ amount: 100, splitMode: 'amount', shares: { a: 70, b: 30 } }), { a: 70, b: 30 });
  assert.deepEqual(owedShares({ amount: 90, splitMode: 'shares', shares: { a: 2, b: 1 } }), { a: 60, b: 30 });
});

test('三人最少轉帳', () => {
  const t = { baseCurrency: 'TWD', rates: {}, members: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
  const es = [
    { amount: 300, currency: 'TWD', payerId: 'a', splitMode: 'equal', shares: { a: 1, b: 1, c: 1 } },
    { amount: 150, currency: 'TWD', payerId: 'b', splitMode: 'equal', shares: { a: 1, b: 1, c: 1 } },
  ];
  const s = settle(computeBalances(t, es));
  const total = s.reduce((x, y) => x + y.amount, 0);
  assert.equal(total, 150);
  assert.ok(s.every((x) => x.to === 'a'));
});

test('收據品項分配含稅', () => {
  const per = splitReceipt(
    [{ price: 1000, quantity: 1, memberIds: ['a'] }, { price: 500, quantity: 2, memberIds: [] }],
    2200,
    ['a', 'b'],
  );
  // 品項 2000，總額 2200（含 10% 稅）：a = (1000+500)*1.1, b = 500*1.1
  assert.equal(Math.round(per.a), 1650);
  assert.equal(Math.round(per.b), 550);
  const r = roundShares({ a: 333.333, b: 333.333, c: 333.334 }, 1000, 0);
  assert.equal(r.a + r.b + r.c, 1000);
});

test('格式化與換算', () => {
  assert.equal(formatMoney(2400, 'JPY'), '¥2,400');
  assert.equal(formatMoney(-504, 'TWD'), '-NT$504');
  assert.equal(toBase(1000, 'JPY', trip), 210);
});

test('中文數字', () => {
  assert.equal(cnToNumber('兩千四百'), 2400);
  assert.equal(cnToNumber('三千五'), 3500);
  assert.equal(cnToNumber('一萬二'), 12000);
  assert.equal(cnToNumber('十五'), 15);
  assert.equal(cnToNumber('五百'), 500);
});

const opt = { members, meId: 'a', defaultCurrency: 'JPY', today: new Date('2026-12-26T12:00:00') };

test('語音：標準句型', () => {
  const r = parseExpenseText('午餐拉麵 2400 日圓 吳薰付 平分', opt);
  assert.equal(r.amount, 2400);
  assert.equal(r.currency, 'JPY');
  assert.equal(r.payerId, 'b');
  assert.equal(r.participantIds, null);
  assert.equal(r.category, 'food');
  assert.equal(r.title, '午餐拉麵');
  assert.equal(r.date, '2026-12-26');
});

test('語音：我付、只算我、台幣', () => {
  const r = parseExpenseText('伴手禮 1,580 台幣 我付 只算我', opt);
  assert.equal(r.amount, 1580);
  assert.equal(r.currency, 'TWD');
  assert.equal(r.payerId, 'a');
  assert.deepEqual(r.participantIds, ['a']);
  assert.equal(r.category, 'shopping');
});

test('語音：中文數字、昨天、預設幣別', () => {
  const r = parseExpenseText('昨天晚餐燒肉兩千四百塊 郁文先付', opt);
  assert.equal(r.amount, 2400);
  assert.equal(r.currency, 'JPY');
  assert.equal(r.payerId, 'a');
  assert.equal(r.date, '2026-12-25');
  assert.equal(r.category, 'food');
  assert.ok(r.title.includes('晚餐燒肉'));
});

test('語音：沒講支付者就是我', () => {
  const r = parseExpenseText('巴士 2000', opt);
  assert.equal(r.payerId, 'a');
  assert.equal(r.category, 'transport');
  assert.equal(r.title, '巴士');
});

test('語音：三人只有其中兩人', () => {
  const m3 = [...members, { id: 'c', name: '小明' }];
  const r = parseExpenseText('門票 1400 小明付 只有小明和吳薰', { ...opt, members: m3 });
  assert.equal(r.payerId, 'c');
  assert.deepEqual(new Set(r.participantIds), new Set(['b', 'c']));
  assert.equal(r.category, 'ticket');
});
