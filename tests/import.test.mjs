// 試算表匯入（js/importer.js）。資料是假的，格式和實際使用的試算表相同。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTable, rowsToItems, markDuplicates, parseDate, toNumber } from '../js/importer.js';

const members = [{ id: 'a', name: '郁文' }, { id: 'b', name: '吳薰' }];
const today = new Date('2026-11-06T12:00:00');
const HEAD = ['日期', '項目', '類別', 'TWD', 'JPY', '約 TWD', '郁文 先付', '吳薰 先付', '付款方式', '狀態', '備註', '各自付'];
const ROWS = [
  ['', '來回機票 ×2', '機票', '30,000', '¥0', '30,000', 'FALSE', 'TRUE', '台幣刷卡', '已付', '吳薰刷卡', 'FALSE'],
  ['12/25', '測試飯店 名古屋', '住宿', '2,500', '¥0', '2,500', 'TRUE', 'FALSE', '台幣刷卡', '待付', '12/21 扣款', 'FALSE'],
  ['12/26', '測試溫泉飯店', '住宿', '3,000', '¥300', '3,063', 'TRUE', 'FALSE', '台幣刷卡', '待付', '溫泉稅現場付', 'FALSE'],
  ['12/31', '測試山屋（二食）', '住宿', '0', '¥20,000', '4,200', 'TRUE', 'FALSE', '日圓刷卡', '已付', '', 'FALSE'],
  ['1/1', '測試鉱泉', '住宿', '0', '¥40,000', '8,400', 'TRUE', 'FALSE', '日圓現金', '待付', '', 'FALSE'],
  ['12/26', '測試特急', '交通', '0', '¥10,000', '2,100', 'FALSE', 'TRUE', '日圓刷卡', '待付', '', 'FALSE'],
  ['12/29', '測試巴士', '交通', '0', '¥800', '168', 'FALSE', 'FALSE', '日圓現金', '待付', '', 'TRUE'],
  ['12/30', '測試纜車', '交通', '0', '¥5,000', '1,050', 'TRUE', 'FALSE', '未定', '待付', '', 'FALSE'],
  ['12/25', '晚餐', '餐費', '0', '¥2,000', '420', 'FALSE', 'FALSE', '日圓現金', '預估', '', 'FALSE'],
  ['', '測試 eSIM ×2', '網路', '1,400', '¥0', '1,400', 'TRUE', 'FALSE', '台幣刷卡', '待付', '', 'FALSE'],
  ['', '', '', '', '', '', 'FALSE', 'FALSE', '', '', '', 'FALSE'],
];
const tsv = [HEAD, ...ROWS].map((r) => r.join('\t')).join('\n');

test('匯入：讀表格（Tab 與 CSV）', () => {
  assert.equal(parseTable(tsv).length, 12); // 標題＋11 列（只剩 FALSE 的空白列會留著，轉成項目時略過）
  const csv = '日期,項目,TWD\n12/25,"飯店, 兩晚","2,700"\n,"備註有""引號""",100\n';
  assert.deepEqual(parseTable(csv), [['日期', '項目', 'TWD'], ['12/25', '飯店, 兩晚', '2,700'], ['', '備註有"引號"', '100']]);
  assert.equal(toNumber('¥26,400'), 26400);
  assert.equal(parseDate('12/25', today), '2026-12-25');
  assert.equal(parseDate('1/2', today), '2027-01-02');
  assert.equal(parseDate('2026/8/7', today), '2026-08-07');
});

test('匯入：預設勾選事先刷卡、已付的；其他說明原因', () => {
  const { items, error } = rowsToItems(parseTable(tsv), { members, today });
  assert.equal(error, '');
  const by = (t) => items.find((i) => i.title === t);
  // 機票：吳薰付、台幣、沒日期 → 放行程第一天
  assert.deepEqual([by('來回機票 ×2').payerId, by('來回機票 ×2').currency, by('來回機票 ×2').amount, by('來回機票 ×2').date, by('來回機票 ×2').checked],
    ['b', 'TWD', 30000, '2026-12-25', true]);
  assert.equal(by('來回機票 ×2').category, 'transport');
  // 台幣預付＋日圓現場付 → 兩筆，現場那筆不勾
  assert.equal(by('測試溫泉飯店').checked, true);
  assert.equal(by('測試溫泉飯店（現場付）').currency, 'JPY');
  assert.equal(by('測試溫泉飯店（現場付）').checked, false);
  // 日圓刷卡已付 → 勾
  assert.equal(by('測試山屋（二食）').checked, true);
  assert.equal(by('測試山屋（二食）').category, 'lodging');
  assert.equal(by('測試特急').payerId, 'b');
  assert.equal(by('測試特急').payMethod, 'card');
  // 日圓現金、未定、預估、各自付 → 不勾
  assert.equal(by('測試鉱泉').checked, false);
  assert.equal(by('測試鉱泉').payMethod, 'cash');
  assert.match(by('測試纜車').reason, /未定/);
  assert.match(by('晚餐').reason, /預估|沒有勾/);
  assert.match(by('測試巴士').reason, /各自付/);
  assert.equal(by('測試 eSIM ×2').category, 'other');
  assert.equal(items.filter((i) => i.checked).length, 6); // 機票、兩間飯店、山屋、特急、eSIM
});

test('匯入：已經匯入過的不勾', () => {
  const { items } = rowsToItems(parseTable(tsv), { members, today });
  const marked = markDuplicates(items, [{ date: '2026-12-25', currency: 'TWD', amount: 2500, title: '測試飯店 名古屋' }]);
  const it = marked.find((i) => i.title === '測試飯店 名古屋');
  assert.equal(it.checked, false);
  assert.equal(it.dup, true);
});

test('匯入：找不到標題列時說明', () => {
  const { error } = rowsToItems(parseTable('12/25\t飯店\t2700'), { members, today });
  assert.match(error, /標題列/);
});
