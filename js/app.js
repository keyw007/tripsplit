// tripsplit 主程式：畫面、路由、記帳流程。
import {
  initFirebase, waitForUser, watchMyTrips, watchTrip, watchExpenses, getTripOnce,
  createTrip, updateTrip, joinTrip, deleteTrip, saveExpense, deleteExpense, newId,
  accountInfo, linkGoogle, switchToGoogle, finishGoogleRedirect,
} from './firebase.js';
import {
  formatMoney, toBase, owedShares, amountSplitGap, computeBalances, settle,
  splitReceipt, roundShares, decimalsOf, missingRates,
  cashBalances, exchangeAverages, roundRate,
} from './money.js';
import { parseExpenseText, CATEGORIES, guessCategory } from './parse.js';
import { getMe, setMe, getPref, setPref, queueReceipt, listReceipts, removeReceipt } from './store.js';
import { APP_VERSION } from './config.js';
import { helpHtml, platform, isStandalone } from './help.js';
import { fetchRates } from './rates.js';

const CURRENCIES = ['TWD', 'JPY', 'USD', 'KRW', 'EUR', 'HKD', 'CNY', 'THB'];
const TABS = [
  { id: 'list', label: '開支', icon: '🧾' },
  { id: 'settle', label: '結算', icon: '⚖️' },
  { id: 'stats', label: '統計', icon: '📊' },
  { id: 'settings', label: '設定', icon: '⚙️' },
];

const S = {
  user: null,
  trips: [],
  tripId: null,
  trip: null,
  tripLoaded: false,
  expenses: [],
  cash: [], // 現金紀錄（換匯、清點），和開支存在同一個集合，type: 'cash'
  expensesFromCache: true,
  receipts: [],
  meId: null,
  online: navigator.onLine,
  unsubTrips: null,
  unsubTrip: null,
  unsubExp: null,
};

const $app = document.getElementById('app');
const $sheet = document.getElementById('sheet-root');

// ---------- 小工具 ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function fmtDay(s) {
  if (!s) return '未填日期';
  const d = new Date(`${s}T00:00:00`);
  const w = '日一二三四五六'[d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()}（${w}）`;
}
let toastTimer = null;
function toast(msg, ms = 2600) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}
function cat(id) {
  return CATEGORIES.find((c) => c.id === id) || CATEGORIES[CATEGORIES.length - 1];
}
function memberName(id) {
  return S.trip?.members?.find((m) => m.id === id)?.name ?? '（已移除）';
}
function base() {
  return S.trip?.baseCurrency || 'TWD';
}
function money(n, c) {
  return formatMoney(n, c || base());
}
function aiEnabled() {
  return getPref('ai', true);
}
function inviteLink(id) {
  return `${location.origin}${location.pathname}#/join/${id}`;
}
// 打開語音／拍明細畫面時先在背景準備 AI，按下解析時就不用等載入
function warmUpAiIfUsable() {
  if (S.online && aiEnabled()) import('./ai.js').then((m) => m.warmUpAi()).catch(() => {});
}
const secondsSince = (t0) => `${((performance.now() - t0) / 1000).toFixed(1)} 秒`;
const sec = (ms) => (ms / 1000).toFixed(1);
// 把 AI 時間拆成「準備」和每次模型呼叫，例如「準備 0.1＋gemini-3.6-flash 2.3（思考 0）」
function aiTimingText(aiMod) {
  const t = aiMod.getLastAiTiming?.();
  if (!t) return '';
  const calls = t.tries.map((c) => `${c.name}${c.ok ? '' : '✗'}${c.thinking ? '' : '(無思考設定)'} ${sec(c.ms)}`).join('＋');
  const thoughts = t.usage?.thoughtsTokenCount;
  return `準備 ${sec(t.prepMs)}＋${calls}${thoughts != null ? `，思考 ${thoughts} tokens` : ''}`;
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

// ---------- 下方視窗 ----------
let sheetCleanup = null;
function openSheet(render, onClose) {
  closeSheet();
  $sheet.innerHTML = '<div class="sheet-bg"></div><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div><div class="sheet-body"></div></div>';
  const body = $sheet.querySelector('.sheet-body');
  $sheet.querySelector('.sheet-bg').addEventListener('click', closeSheet);
  sheetCleanup = onClose || null;
  render(body);
  return body;
}
function closeSheet() {
  if (sheetCleanup) { const f = sheetCleanup; sheetCleanup = null; f(); }
  $sheet.innerHTML = '';
}

// ---------- 路由 ----------
function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const parts = h.split('/').filter(Boolean);
  if (parts[0] === 'help') return { view: 'help' };
  if (parts[0] === 'join' && parts[1]) return { view: 'join', tripId: parts[1] };
  if (parts[0] === 't' && parts[1]) return { view: 'trip', tripId: parts[1], tab: TABS.some((t) => t.id === parts[2]) ? parts[2] : 'list' };
  return { view: 'home' };
}
function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function enterTrip(tripId) {
  if (S.tripId === tripId) return;
  S.unsubTrip?.(); S.unsubExp?.();
  S.tripId = tripId;
  S.trip = null;
  S.tripLoaded = false;
  S.expenses = [];
  S.cash = [];
  S.receipts = [];
  S.meId = getMe(tripId);
  S.unsubTrip = watchTrip(tripId, (trip) => {
    S.trip = trip;
    S.tripLoaded = true;
    if (trip && !S.meId) {
      const mine = trip.members?.find((m) => m.uid === S.user.uid);
      if (mine) { S.meId = mine.id; setMe(tripId, mine.id); }
    }
    if (trip && !(trip.memberUids || []).includes(S.user.uid)) {
      S.unsubExp?.(); S.unsubExp = null;
      go(`#/join/${tripId}`);
      return;
    }
    if (trip && !S.unsubExp) {
      S.unsubExp = watchExpenses(tripId, (list, fromCache) => {
        S.expenses = list.filter((e) => e.type !== 'cash');
        S.cash = list.filter((e) => e.type === 'cash');
        S.expensesFromCache = fromCache;
        render();
      });
    }
    render();
  });
  refreshReceipts();
}
function leaveTrip() {
  S.unsubTrip?.(); S.unsubExp?.();
  S.unsubTrip = S.unsubExp = null;
  S.tripId = null; S.trip = null; S.expenses = []; S.cash = [];
}
async function refreshReceipts() {
  if (!S.tripId) return;
  S.receipts = await listReceipts(S.tripId);
  render();
}

// ---------- 畫面 ----------
function render() {
  const r = route();
  if (!S.user) return;
  if (r.view === 'home') { leaveTrip(); renderHome(); return; }
  if (r.view === 'join') { renderJoin(r.tripId); return; }
  if (r.view === 'help') { leaveTrip(); renderHelp(); return; }
  enterTrip(r.tripId);
  renderTrip(r.tab);
}

function syncBadge() {
  const pending = S.expenses.filter((e) => e._pending).length + (S.trip?._pending ? 1 : 0);
  if (!S.online) return `<span class="sync off">離線${pending ? `・${pending} 筆待同步` : ''}</span>`;
  if (pending) return `<span class="sync off">同步中 ${pending}</span>`;
  return '<span class="sync">已同步</span>';
}

function renderHome() {
  const trips = [...S.trips].sort((a, b) => (b.createdAt?.seconds || 9e12) - (a.createdAt?.seconds || 9e12));
  $app.innerHTML = `
    <header class="topbar"><h1>✈️ 旅行分帳</h1>${S.online ? '' : '<span class="sync off">離線</span>'}</header>
    <main>
      ${installBanner()}
      ${trips.length ? trips.map((t) => `
        <a class="card trip-card" href="#/t/${t.id}/list">
          <div class="name">${esc(t.name)}${t._pending ? '<span class="pending-dot"></span>' : ''}</div>
          <div class="muted small">${esc((t.members || []).map((m) => m.name).join('、'))}</div>
        </a>`).join('') : '<div class="empty">還沒有旅行。<br>新增一趟，或用旅伴傳來的邀請連結加入。<br><a href="#/help">第一次用？看使用說明</a></div>'}
      <button class="btn primary block" data-act="new-trip">＋ 新增旅行</button>
      <div style="height:10px"></div>
      <button class="btn block" data-act="join-paste">用邀請連結加入</button>
      <div style="height:16px"></div>
      ${renderAccountCard()}
      <a class="btn block" href="#/help">📖 使用說明</a>
      ${versionButton()}
    </main>`;
}

async function renderJoin(tripId) {
  leaveTrip();
  $app.innerHTML = `<header class="topbar"><a class="icon-btn" href="#/">‹</a><h1>加入旅行</h1></header><main><div class="empty"><span class="spinner"></span><br>讀取中…</div></main>`;
  let trip;
  try {
    trip = await getTripOnce(tripId);
  } catch (err) {
    console.error(err);
  }
  if (route().view !== 'join') return;
  if (!trip) {
    $app.querySelector('main').innerHTML = `<div class="empty">找不到這趟旅行。<br>${S.online ? '連結可能錯了。' : '加入需要網路，請連上網路再試。'}</div>`;
    return;
  }
  if ((trip.memberUids || []).includes(S.user.uid)) {
    const mine = trip.members.find((m) => m.uid === S.user.uid);
    if (mine && !getMe(tripId)) setMe(tripId, mine.id);
    go(`#/t/${tripId}/list`);
    return;
  }
  const free = trip.members.filter((m) => !m.uid);
  $app.querySelector('main').innerHTML = `
    ${platform() === 'ios' && !isStandalone() ? `<div class="banner"><div class="grow">你現在是在 Safari 或 LINE 裡打開。<b>請不要在這裡加入</b>，不然主畫面 App 會看不到這趟旅行。<br>請先把旅行分帳加入主畫面，再從主畫面 App 首頁按「用邀請連結加入」，貼上這個連結。</div><button class="btn" data-act="copy-here">複製連結</button></div>` : ''}
    <div class="card"><h2>邀請你加入</h2><div style="font-size:20px;font-weight:800">${esc(trip.name)}</div>
      <div class="muted small">成員：${esc(trip.members.map((m) => m.name).join('、'))}</div></div>
    <div class="card"><h2>你是哪一位？</h2>
      ${free.map((m) => `<button class="btn primary block" style="margin-bottom:8px" data-act="join-as" data-id="${m.id}">我是 ${esc(m.name)}</button>`).join('')}
      ${trip.members.filter((m) => m.uid).map((m) => `<button class="btn block" style="margin-bottom:8px;opacity:.7" data-act="join-as" data-id="${m.id}">我是 ${esc(m.name)}（換手機或重新加入）</button>`).join('')}
      <div class="row" style="margin-top:8px"><input class="grow" type="text" id="join-new" placeholder="都不是？輸入你的名字"><button class="btn primary" data-act="join-new">加入</button></div>
    </div>`;
  $app.querySelector('main').dataset.trip = JSON.stringify({ id: trip.id, members: trip.members, memberUids: trip.memberUids });
}

function renderTrip(tab) {
  const t = S.trip;
  if (!S.tripLoaded) {
    $app.innerHTML = `<header class="topbar"><a class="icon-btn" href="#/">‹</a><h1>載入中…</h1></header><main><div class="empty"><span class="spinner"></span></div></main>`;
    return;
  }
  if (!t) {
    $app.innerHTML = `<header class="topbar"><a class="icon-btn" href="#/">‹</a><h1>找不到旅行</h1></header><main><div class="empty">這趟旅行不存在或已被刪除。</div></main>`;
    return;
  }
  const body = { list: tabList, settle: tabSettle, stats: tabStats, settings: tabSettings }[tab]();
  $app.innerHTML = `
    <header class="topbar"><a class="icon-btn" href="#/" aria-label="回旅行列表">‹</a><h1>${esc(t.name)}</h1>${syncBadge()}</header>
    <main>${body}</main>
    ${tab === 'list' ? `<div class="actions">
      <button data-act="voice">🎤 語音</button>
      <button data-act="camera">📷 拍明細</button>
      <button class="primary" data-act="add">＋ 新增</button></div>` : ''}
    <nav class="tabs">${TABS.map((x) => `<a href="#/t/${t.id}/${x.id}" class="${x.id === tab ? 'on' : ''}"><span class="i">${x.icon}</span>${x.label}</a>`).join('')}</nav>`;
}

function meWarning() {
  if (S.meId && S.trip.members.some((m) => m.id === S.meId)) return '';
  return `<div class="banner"><div class="grow">還沒選「我是誰」，語音記帳和我的餘額需要知道你是哪位成員。</div><a class="btn" href="#/t/${S.tripId}/settings">去設定</a></div>`;
}

function tabList() {
  const t = S.trip;
  const exps = S.expenses;
  const bal = computeBalances(t, exps);
  const myBal = S.meId ? bal[S.meId]?.balance || 0 : null;
  const total = exps.filter((e) => e.type !== 'transfer').reduce((s, e) => s + toBase(e.amount, e.currency, t), 0);
  const miss = missingRates(t, exps);
  let html = meWarning();
  if (miss.length) html += `<div class="banner"><div class="grow">${esc(miss.join('、'))} 還沒設匯率，暫時以 1:1 計算。</div><a class="btn" href="#/t/${t.id}/settings">設定</a></div>`;
  if (S.receipts.length) {
    html += `<div class="banner"><div class="grow">📷 有 ${S.receipts.length} 張明細還沒辨識${S.online ? '' : '（有網路時再辨識）'}</div>
      <button class="btn" data-act="receipts">${S.online ? '辨識' : '查看'}</button></div>`;
  }
  html += `<div class="card summary">
      <div><div class="muted small">總花費</div><div class="big">${money(total)}</div></div>
      <div><div class="muted small">我的餘額</div><div class="big ${myBal > 0.5 ? 'pos' : myBal < -0.5 ? 'neg' : ''}">${myBal === null ? '—' : money(myBal)}</div>
      <div class="muted small">${myBal === null ? '' : myBal > 0.5 ? '別人欠你' : myBal < -0.5 ? '你欠別人' : '剛好打平'}</div></div>
    </div>`;
  html += myCashCard();
  if (!exps.length) {
    html += `<div class="empty">還沒有開支。<br>按下面的按鈕新增，或用語音、拍明細。</div>`;
    return html;
  }
  const byDay = new Map();
  for (const e of exps) {
    const k = e.date || '';
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(e);
  }
  for (const [day, list] of byDay) {
    const dayTotal = list.filter((e) => e.type !== 'transfer').reduce((s, e) => s + toBase(e.amount, e.currency, t), 0);
    html += `<div class="day-head">${fmtDay(day)}・${money(dayTotal)}</div><div class="exp-group">`;
    for (const e of list) html += expRow(e);
    html += '</div>';
  }
  return html;
}

function expRow(e) {
  const t = S.trip;
  if (e.type === 'transfer') {
    return `<div class="exp" data-act="edit" data-id="${e.id}"><div class="ico">💸</div>
      <div class="mid"><div class="t">${esc(memberName(e.payerId))} → ${esc(memberName(e.toId))}</div><div class="s">轉帳還款${e.payMethod === 'cash' ? '・💴 現金' : ''}${e._pending ? '<span class="pending-dot"></span>' : ''}</div></div>
      <div class="amt"><div class="a">${formatMoney(e.amount, e.currency)}</div></div></div>`;
  }
  const owed = owedShares(e);
  const ids = Object.keys(owed);
  const who = ids.length === t.members.length ? '全部人' : ids.map(memberName).join('、');
  const mine = S.meId && owed[S.meId] != null ? `我 ${formatMoney(owed[S.meId], e.currency)}` : '';
  const conv = e.currency !== base() ? `<div class="s">≈ ${money(toBase(e.amount, e.currency, t))}</div>` : '';
  return `<div class="exp" data-act="edit" data-id="${e.id}"><div class="ico">${cat(e.category).icon}</div>
    <div class="mid"><div class="t">${esc(e.title || cat(e.category).label)}</div>
      <div class="s">${esc(memberName(e.payerId))} 付${e.payMethod === 'cash' ? '💴' : ''}・${esc(who)}${mine ? `・${mine}` : ''}${e._pending ? '<span class="pending-dot"></span>' : ''}</div></div>
    <div class="amt"><div class="a">${formatMoney(e.amount, e.currency)}</div>${conv}</div></div>`;
}

function tabSettle() {
  const t = S.trip;
  const bal = computeBalances(t, S.expenses);
  const sug = settle(bal, decimalsOf(base()));
  let html = meWarning();
  html += `<div class="card"><h2>每人餘額（${base()}）</h2>${t.members.map((m) => {
    const b = bal[m.id] || { paid: 0, owed: 0, balance: 0 };
    return `<div class="settle-row"><div class="grow"><b>${esc(m.name)}</b>${m.id === S.meId ? '（我）' : ''}
      <div class="muted small">付出 ${money(b.paid)}・應負擔 ${money(b.owed)}</div></div>
      <div class="${b.balance > 0.5 ? 'pos' : b.balance < -0.5 ? 'neg' : ''}" style="font-weight:800">${b.balance > 0.5 ? '+' : ''}${money(b.balance)}</div></div>`;
  }).join('')}</div>`;
  html += `<div class="card"><h2>建議轉帳</h2>${sug.length ? sug.map((s, i) => `
    <div class="settle-row"><div class="grow"><b>${esc(memberName(s.from))}</b> 給 <b>${esc(memberName(s.to))}</b><div style="font-size:20px;font-weight:800">${money(s.amount)}</div></div>
    <button class="btn" data-act="record-settle" data-i="${i}">已付款</button></div>`).join('') : '<div class="muted">大家都打平了 🎉</div>'}</div>
    <p class="muted small">正數代表別人欠他，負數代表他欠別人。按「已付款」會記一筆轉帳，餘額就會歸零。</p>`;
  html += allCashCard();
  return html;
}

function tabStats() {
  const t = S.trip;
  const exps = S.expenses.filter((e) => e.type !== 'transfer');
  const total = exps.reduce((s, e) => s + toBase(e.amount, e.currency, t), 0);
  const byCat = {};
  for (const e of exps) byCat[e.category || 'other'] = (byCat[e.category || 'other'] || 0) + toBase(e.amount, e.currency, t);
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const bal = computeBalances(t, exps);
  const byDay = {};
  for (const e of exps) byDay[e.date || ''] = (byDay[e.date || ''] || 0) + toBase(e.amount, e.currency, t);
  const max = Math.max(1, ...cats.map((c) => c[1]));
  return `
    <div class="card"><h2>總花費</h2><div style="font-size:26px;font-weight:800">${money(total)}</div>
      <div class="muted small">每人平均 ${money(total / Math.max(1, t.members.length))}・共 ${exps.length} 筆</div></div>
    <div class="card"><h2>各類別</h2>${cats.length ? cats.map(([c, v]) => `
      <div class="stat-row"><div class="row"><span>${cat(c).icon} ${cat(c).label}</span><b>${money(v)}</b></div>
      <div class="bar-bg"><div class="bar" style="width:${(v / max) * 100}%"></div></div></div>`).join('') : '<div class="muted">還沒有資料</div>'}</div>
    <div class="card"><h2>每人實際花費（自己負擔的部分）</h2>${t.members.map((m) => `
      <div class="settle-row"><div class="grow">${esc(m.name)}</div><b>${money(bal[m.id]?.owed || 0)}</b></div>`).join('')}</div>
    <div class="card"><h2>每天</h2>${Object.keys(byDay).sort().map((d) => `
      <div class="settle-row"><div class="grow">${fmtDay(d)}</div><b>${money(byDay[d])}</b></div>`).join('') || '<div class="muted">還沒有資料</div>'}</div>`;
}

function tabSettings() {
  const t = S.trip;
  const used = new Set([t.defaultCurrency, ...S.expenses.map((e) => e.currency), ...S.cash.map((r) => r.currency), ...Object.keys(t.rates || {})]);
  const avg = exchangeAverages(S.cash, t.baseCurrency);
  used.delete(t.baseCurrency);
  used.delete(undefined);
  const isOwner = t.createdBy === S.user.uid;
  return `
    <div class="card"><h2>我是</h2>
      <select id="set-me">${['<option value="">（請選擇）</option>', ...t.members.map((m) => `<option value="${m.id}" ${m.id === S.meId ? 'selected' : ''}>${esc(m.name)}</option>`)].join('')}</select>
      <p class="muted small">只存在這支手機上，用來判斷「我付」「只算我」。</p></div>
    <div class="card"><h2>邀請旅伴</h2>
      <div class="row"><input class="grow" type="text" readonly value="${esc(inviteLink(t.id))}"><button class="btn" data-act="share-link">${navigator.share ? '分享' : '複製'}</button></div>
      <p class="muted small">對方打開連結、選自己是哪位成員就能一起記帳。拿到連結的人都能加入，請只傳給旅伴。</p></div>
    <div class="card"><h2>成員</h2>
      ${t.members.map((m) => `<div class="row" style="margin-bottom:8px"><input class="grow" type="text" data-member="${m.id}" value="${esc(m.name)}"><span class="muted small" style="width:56px">${m.uid ? '已加入' : '未加入'}</span></div>`).join('')}
      <div class="row"><input class="grow" type="text" id="new-member" placeholder="新增成員名字"><button class="btn" data-act="add-member">新增</button></div>
      <div style="height:8px"></div><button class="btn block" data-act="save-members">儲存成員名字</button></div>
    <div class="card"><h2>旅行</h2>
      <label class="field"><span>名稱</span><input type="text" id="set-name" value="${esc(t.name)}"></label>
      <label class="field"><span>結算幣別（餘額、統計都用這個幣別）</span><select id="set-base">${CURRENCIES.map((c) => `<option ${c === t.baseCurrency ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      <label class="field"><span>記帳預設幣別</span><select id="set-default">${CURRENCIES.map((c) => `<option ${c === t.defaultCurrency ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      <h2 style="margin-top:6px">匯率（1 單位外幣 = 多少 ${t.baseCurrency}）</h2>
      ${t.ratesInfo ? `<p class="muted small" style="margin-top:-4px">上次自動抓取：${esc(t.ratesInfo.date || '')}（${esc(t.ratesInfo.source || '')}）</p>` : ''}
      ${[...used].map((c) => `<label class="field"><span>1 ${c} =</span><input type="number" inputmode="decimal" step="any" data-rate="${c}" value="${t.rates?.[c] ?? ''}" placeholder="例如 0.21"></label>
        ${avg[c] ? `<p class="muted small" style="margin:-6px 0 10px">你們換匯平均 ${roundRate(avg[c].rate)} <button class="link-btn" data-act="use-avg-rate" data-c="${c}" data-v="${roundRate(avg[c].rate)}">用這個</button></p>` : ''}`).join('') || '<p class="muted small">目前只用結算幣別，不需要匯率。</p>'}
      ${used.size ? `<button class="btn block" data-act="fetch-rates" ${S.online ? '' : 'disabled'}>🌐 抓最新匯率${S.online ? '' : '（需要網路）'}</button><div id="rate-preview"></div><div style="height:8px"></div>` : ''}
      <button class="btn primary block" data-act="save-trip">儲存</button></div>
    <div class="card"><h2>AI 辨識</h2>
      <label class="row"><input type="checkbox" id="set-ai" ${aiEnabled() ? 'checked' : ''}><span class="grow">有網路時，拍明細與語音用 AI 解析</span></label>
      <p class="muted small">關掉時，語音改用手機內建規則解析；拍明細只能存起來手動輸入。</p></div>
    <div class="card"><h2>資料</h2>
      <button class="btn block" data-act="export">匯出 CSV（可匯入 Google 試算表）</button>
      ${isOwner ? '<div style="height:8px"></div><button class="btn danger block" data-act="delete-trip">刪除這趟旅行</button>' : ''}
      <p class="muted small"><button class="link-btn" data-act="check-update">v${APP_VERSION}（點此檢查更新）</button>・帳號 ${esc(S.user.uid.slice(0, 6))}</p></div>
    ${renderAccountCard()}
    <a class="btn block" href="#/help">📖 使用說明</a>`;
}

function versionButton() {
  return `<p class="muted small" style="text-align:center;margin-top:24px"><button class="link-btn" data-act="check-update">v${APP_VERSION}・點此檢查更新</button></p>`;
}

// ---------- 使用說明 ----------
function renderHelp() {
  $app.innerHTML = `
    <header class="topbar"><a class="icon-btn" href="#/" data-act="back" aria-label="返回">‹</a><h1>使用說明</h1></header>
    <main>${helpHtml()}${versionButton()}</main>`;
}

// 還沒加入主畫面時，在首頁提醒（iPhone 的 Safari 分頁和主畫面 App 是不同帳號，特別重要）
function installBanner() {
  if (isStandalone()) return '';
  const p = platform();
  if (p === 'ios') return '<div class="banner"><div class="grow">建議先加入主畫面：按 Safari 下方的分享鈕 →「加入主畫面」，之後從主畫面打開。<b>Safari 分頁和主畫面 App 的帳號是分開的</b>，請只用其中一個。</div><a class="btn" href="#/help">說明</a></div>';
  if (p === 'android') return '<div class="banner"><div class="grow">建議安裝到主畫面：Chrome 右上角 ⋮ →「安裝應用程式」或「加到主畫面」。</div><a class="btn" href="#/help">說明</a></div>';
  return '';
}

// ---------- 帳號（Google 備份） ----------

function renderAccountCard() {
  const a = accountInfo();
  if (!a.isAnonymous) {
    return `<div class="card"><h2>帳號</h2>
      <div>✅ 已綁定 Google${a.email ? `：${esc(a.email)}` : ''}</div>
      <p class="muted small">換手機時，在新手機打開 tripsplit，按「連結 Google 帳號」選同一個 Google 帳號，就能拿回所有旅行。</p></div>`;
  }
  return `<div class="card"><h2>帳號</h2>
    <div>匿名帳號（只存在這支手機）</div>
    <p class="muted small">綁定 Google 後，換手機或清掉瀏覽器資料，用同一個 Google 帳號登入就能拿回所有旅行與帳目。平常照樣不用登入。</p>
    <button class="btn block" data-act="link-google">連結 Google 帳號</button>
    ${isStandalone() ? '<p class="muted small">請在這個 App 裡綁定，不要在 Safari 分頁綁定（兩邊的帳號是分開的）。</p>' : ''}
  </div>`;
}

const LINK_ERRORS = {
  'auth/popup-blocked': '登入視窗被擋住了，請再按一次',
  'auth/popup-closed-by-user': '已取消',
  'auth/cancelled-popup-request': '已取消',
  'auth/network-request-failed': '需要網路才能綁定 Google',
  'auth/operation-not-allowed': 'Firebase 還沒啟用 Google 登入方式',
  'auth/unauthorized-domain': '這個網址還沒加入 Firebase 授權網域',
};

async function doLinkGoogle() {
  if (!S.online) { toast('需要網路才能綁定 Google'); return; }
  toast('前往 Google 登入…');
  try {
    await linkGoogle(); // 成功的話頁面會跳到 Google，回來後由 handleGoogleRedirect() 接手
  } catch (err) {
    console.error('[linkGoogle]', err);
    toast(LINK_ERRORS[err.code] || `綁定失敗：${err.code || err.message}`, 4000);
  }
}

// 從 Google 登入頁回到 App 時，完成綁定或詢問是否改用已綁過的帳號
async function handleGoogleRedirect() {
  let r;
  try {
    r = await finishGoogleRedirect();
  } catch (err) {
    console.error('[googleRedirect]', err);
    toast(LINK_ERRORS[err.code] || `綁定失敗：${err.code || err.message}`, 5000);
    return;
  }
  if (!r) return;
  if (r.status === 'exists') {
    const ok = confirm('這個 Google 帳號已經綁過另一個 tripsplit 帳號（例如舊手機）。\n\n要改用它嗎？改用後會看到舊帳號的旅行；這支手機目前加入的旅行，之後可以用邀請連結重新加入。');
    if (!ok) return;
    try {
      await switchToGoogle(r.cred);
    } catch (err) {
      toast(`切換失敗：${err.code || err.message}`, 4000);
      return;
    }
    location.reload();
    return;
  }
  toast('已綁定 Google 帳號');
  render();
}

// ---------- 自動抓匯率 ----------
let fetchedRates = null;
async function doFetchRates() {
  const t = S.trip;
  const curs = [...document.querySelectorAll('[data-rate]')].map((el) => el.dataset.rate);
  const box = document.getElementById('rate-preview');
  box.innerHTML = '<p class="muted small"><span class="spinner"></span> 抓取中…</p>';
  try {
    fetchedRates = await fetchRates(t.baseCurrency, curs);
  } catch (err) {
    fetchedRates = null;
    box.innerHTML = `<p class="small neg">${esc(err.message)}</p>`;
    return;
  }
  const rows = Object.entries(fetchedRates.rates).map(([c, r]) => {
    const cur = Number(t.rates?.[c]);
    const diff = cur ? ` <span class="muted">（目前 ${cur}，${r > cur ? '+' : ''}${((r / cur - 1) * 100).toFixed(1)}%）</span>` : ' <span class="muted">（目前沒設）</span>';
    return `<div>1 ${c} = <b>${r}</b> ${t.baseCurrency}${diff}</div>`;
  }).join('');
  box.innerHTML = `<div class="card" style="box-shadow:none;background:var(--bg);margin-top:8px">
    <div class="muted small">${esc(fetchedRates.date)}・${esc(fetchedRates.source)}</div>${rows}
    <p class="muted small">套用後，<b>所有開支</b>（包括之前記的）都會用新匯率重新換算。實際換匯或刷卡的匯率可能不同，可以再手動調整。</p>
    <button class="btn primary block" data-act="apply-rates">套用</button></div>`;
}

function applyFetchedRates() {
  const t = S.trip;
  if (!fetchedRates) return;
  updateTrip(t.id, {
    rates: { ...(t.rates || {}), ...fetchedRates.rates },
    ratesInfo: { date: fetchedRates.date, source: fetchedRates.source, fetchedMs: Date.now() },
  });
  fetchedRates = null;
  toast('已套用新匯率');
}

// 新增旅行時自動填今天的匯率（使用者自己改過就不覆蓋）
async function prefillNewTripRate() {
  const el = document.getElementById('nt-rate');
  const info = document.getElementById('nt-rate-info');
  if (!el || el.dataset.edited) return;
  const baseC = document.getElementById('nt-base').value;
  const local = document.getElementById('nt-local').value;
  if (baseC === local) { info.textContent = '當地幣別和結算幣別相同，不需要匯率'; return; }
  if (!S.online) { info.textContent = '沒有網路，請手動填匯率（之後可以在設定裡抓）'; return; }
  info.textContent = '抓今天的匯率中…';
  try {
    const r = await fetchRates(baseC, [local]);
    if (el.dataset.edited || document.getElementById('nt-local')?.value !== local) return;
    el.value = r.rates[local];
    info.textContent = `今天的匯率（${r.date}・${r.source}）`;
  } catch {
    info.textContent = '抓不到匯率，請手動填（之後可以在設定裡再抓）';
  }
}

// ---------- 新增旅行 ----------
function sheetNewTrip() {
  const body = openSheet((b) => {
    b.innerHTML = `<h3>新增旅行</h3>
      <label class="field"><span>旅行名稱</span><input type="text" id="nt-name" placeholder="例如 2026 日本跨年"></label>
      <label class="field"><span>我的名字</span><input type="text" id="nt-me" placeholder="例如 郁文"></label>
      <div class="field"><span class="muted small">旅伴（一行一位，之後也能再加）</span><textarea id="nt-others" placeholder="吳薰"></textarea></div>
      <div class="row">
        <label class="field grow"><span>結算幣別</span><select id="nt-base">${CURRENCIES.map((c) => `<option ${c === 'TWD' ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
        <label class="field grow"><span>當地幣別</span><select id="nt-local">${CURRENCIES.map((c) => `<option ${c === 'JPY' ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span>匯率：1 當地幣 = 多少結算幣</span><input type="number" inputmode="decimal" step="any" id="nt-rate" value="0.21"></label>
      <div class="muted small" id="nt-rate-info" style="margin:-6px 0 10px"></div>
      <div class="foot"><button class="btn" data-act="close">取消</button><button class="btn primary" data-act="nt-create">建立</button></div>`;
  });
  body.addEventListener('input', (ev) => { if (ev.target.id === 'nt-rate') ev.target.dataset.edited = '1'; });
  body.addEventListener('change', (ev) => { if (ev.target.id === 'nt-base' || ev.target.id === 'nt-local') prefillNewTripRate(); });
  prefillNewTripRate();
}

function doCreateTrip() {
  const v = (id) => document.getElementById(id).value.trim();
  const name = v('nt-name');
  const me = v('nt-me');
  if (!name || !me) { toast('請填旅行名稱和你的名字'); return; }
  const others = v('nt-others').split(/\n|、|,|，/).map((s) => s.trim()).filter(Boolean);
  const baseC = v('nt-base');
  const local = v('nt-local');
  const rate = parseFloat(v('nt-rate'));
  const { id, meId } = createTrip(S.user.uid, {
    name,
    baseCurrency: baseC,
    defaultCurrency: local,
    rates: local !== baseC && rate > 0 ? { [local]: rate } : {},
    memberNames: [me, ...others],
    myIndex: 0,
  });
  setMe(id, meId);
  closeSheet();
  go(`#/t/${id}/list`);
}

// ---------- 付款方式 ----------
const lastPayMethod = () => getPref(`pay_${S.tripId}`, 'card');
const PAY_LABEL = { cash: '💴 現金', card: '💳 刷卡・其他' };

// ---------- 現金 ----------
const cashBal = () => cashBalances(S.expenses, S.cash);
// 這個人有用到的現金幣別（有紀錄或有付過現金），預設幣別排第一
function cashCurrencies(memberId) {
  const t = S.trip;
  const set = new Set();
  for (const r of S.cash) if (!memberId || r.memberId === memberId) set.add(r.currency);
  for (const e of S.expenses) if (e.payMethod === 'cash' && (!memberId || e.payerId === memberId || e.toId === memberId)) set.add(e.currency);
  const def = t.defaultCurrency || base();
  return [...set].sort((a, b) => (a === def ? -1 : b === def ? 1 : a.localeCompare(b)));
}

function myCashCard() {
  if (!S.meId) return '';
  const curs = cashCurrencies(S.meId);
  if (!curs.length) {
    return `<div class="card cash-card"><div class="row"><div class="grow"><b>💴 現金</b><div class="muted small">記下換匯或領了多少，付現金時自動扣，隨時知道身上還剩多少。</div></div>
      <button class="btn" data-act="cash-in">＋ 換匯</button></div></div>`;
  }
  const mine = cashBal()[S.meId] || {};
  return `<div class="card cash-card">
    <div class="row"><b class="grow">💴 我的現金</b><a class="muted small" href="#/t/${S.tripId}/settle">全部人 ›</a></div>
    <div class="cash-amounts">${curs.map((c) => `<div class="big ${(mine[c] || 0) < 0 ? 'neg' : ''}">${formatMoney(mine[c] || 0, c)}</div>`).join('')}</div>
    ${curs.some((c) => (mine[c] || 0) < 0) ? '<div class="muted small neg">比 0 還少：可能有換匯沒記，按「清點」照實際數到的修正。</div>' : ''}
    <div class="row" style="margin-top:8px"><button class="btn grow" data-act="cash-in">＋ 換匯／領錢</button><button class="btn grow" data-act="cash-count">清點</button></div></div>`;
}

function allCashCard() {
  const t = S.trip;
  const curs = cashCurrencies(null);
  if (!curs.length) return '';
  const bal = cashBal();
  const avg = exchangeAverages(S.cash, base());
  const kindLabel = (r) => (r.kind === 'adj' ? `清點（數到 ${formatMoney(r.counted, r.currency)}）` : r.note || '換匯／領錢');
  const hist = [...S.cash].sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdMs || 0) - (a.createdMs || 0));
  return `<div class="card"><h2>💴 現金</h2>
    ${t.members.map((m) => `<div class="settle-row"><div class="grow"><b>${esc(m.name)}</b>${m.id === S.meId ? '（我）' : ''}</div>
      <div style="text-align:right;font-weight:800">${curs.map((c) => `<div class="${(bal[m.id]?.[c] || 0) < 0 ? 'neg' : ''}">${formatMoney(bal[m.id]?.[c] || 0, c)}</div>`).join('')}</div></div>`).join('')}
    ${Object.entries(avg).map(([c, a]) => `<p class="muted small">換匯平均：1 ${c} = ${roundRate(a.rate)} ${base()}（${formatMoney(a.amount, c)} 花了 ${money(a.cost)}）</p>`).join('')}
    <div class="row" style="margin:8px 0"><button class="btn grow" data-act="cash-in">＋ 換匯／領錢</button><button class="btn grow" data-act="cash-count">清點</button></div>
    <details class="cash-hist"><summary class="muted small">換匯與清點紀錄（${hist.length}）</summary>
      ${hist.map((r) => `<div class="settle-row"><div class="grow"><div>${esc(memberName(r.memberId))}・${esc(kindLabel(r))}</div>
        <div class="muted small">${esc(r.date || '')}${Number(r.cost) > 0 ? `・花了 ${money(r.cost)}・1 ${r.currency} = ${roundRate(r.cost / r.amount)}` : ''}${r._pending ? '<span class="pending-dot"></span>' : ''}</div></div>
        <div style="font-weight:700">${Number(r.amount) > 0 ? '+' : ''}${formatMoney(r.amount, r.currency)}</div>
        <button class="icon-btn small-x" data-act="cash-del" data-id="${r.id}" aria-label="刪除">✕</button></div>`).join('') || '<div class="muted small">沒有紀錄</div>'}
    </details></div>`;
}

function memberSelect(id, sel) {
  return `<select id="${id}">${S.trip.members.map((m) => `<option value="${m.id}" ${m.id === sel ? 'selected' : ''}>${esc(m.name)}${m.id === S.meId ? '（我）' : ''}</option>`).join('')}</select>`;
}
function currencySelect(id, sel) {
  return `<select id="${id}">${CURRENCIES.map((c) => `<option ${c === sel ? 'selected' : ''}>${c}</option>`).join('')}</select>`;
}

function sheetCashIn() {
  const t = S.trip;
  openSheet((b) => {
    b.innerHTML = `<h3>💴 換匯／領錢</h3>
      <p class="muted small" style="margin-top:-6px">記下拿到多少現金。之後付現金的開支會自動從這裡扣。</p>
      <div class="row"><label class="field grow"><span>誰拿到現金</span>${memberSelect('ci-who', S.meId)}</label>
        <label class="field" style="width:110px"><span>幣別</span>${currencySelect('ci-cur', t.defaultCurrency || base())}</label></div>
      <label class="field"><span>拿到多少</span><input type="number" inputmode="decimal" step="any" id="ci-amount" placeholder="例如 30000"></label>
      <label class="field"><span>花了多少 ${base()}（可不填，填了會算出實際匯率）</span><input type="number" inputmode="decimal" step="any" id="ci-cost" placeholder="例如 6300"></label>
      <div class="muted small" id="ci-rate" style="margin:-6px 0 10px"></div>
      <div class="row"><label class="field grow"><span>說明</span><input type="text" id="ci-note" placeholder="例如 機場換匯、7-11 ATM"></label>
        <label class="field grow"><span>日期</span><input type="date" id="ci-date" value="${todayStr()}"></label></div>
      <div class="foot"><button class="btn" data-act="close">取消</button><button class="btn primary" data-act="cash-save-in">儲存</button></div>`;
  }).addEventListener('input', () => {
    const a = parseFloat(document.getElementById('ci-amount').value);
    const c = parseFloat(document.getElementById('ci-cost').value);
    const cur = document.getElementById('ci-cur').value;
    document.getElementById('ci-rate').textContent = a > 0 && c > 0 && cur !== base() ? `實際匯率：1 ${cur} = ${roundRate(c / a)} ${base()}` : '';
  });
}

function sheetCashCount() {
  const t = S.trip;
  const who0 = S.meId || t.members[0]?.id;
  const cur0 = cashCurrencies(who0)[0] || t.defaultCurrency || base();
  const body = openSheet((b) => {
    b.innerHTML = `<h3>💴 清點現金</h3>
      <p class="muted small" style="margin-top:-6px">數一下身上的現金，填實際的金額。和帳面不一樣時會記一筆差額（例如忘了記的小額花費）。</p>
      <div class="row"><label class="field grow"><span>誰的現金</span>${memberSelect('cc-who', who0)}</label>
        <label class="field" style="width:110px"><span>幣別</span>${currencySelect('cc-cur', cur0)}</label></div>
      <div class="muted small" id="cc-book"></div>
      <label class="field"><span>實際數到</span><input type="number" inputmode="decimal" step="any" id="cc-counted" placeholder="例如 12340"></label>
      <div class="muted small" id="cc-diff" style="margin:-6px 0 10px"></div>
      <div class="foot"><button class="btn" data-act="close">取消</button><button class="btn primary" data-act="cash-save-count">儲存</button></div>`;
  });
  const refresh = () => {
    const who = document.getElementById('cc-who').value;
    const cur = document.getElementById('cc-cur').value;
    const book = cashBal()[who]?.[cur] || 0;
    document.getElementById('cc-book').textContent = `帳面上有 ${formatMoney(book, cur)}`;
    const counted = parseFloat(document.getElementById('cc-counted').value);
    document.getElementById('cc-diff').textContent = Number.isFinite(counted) ? `差 ${formatMoney(counted - book, cur)}` : '';
  };
  body.addEventListener('input', refresh);
  body.addEventListener('change', refresh);
  refresh();
}

function saveCashIn() {
  const v = (id) => document.getElementById(id).value;
  const amount = parseFloat(v('ci-amount'));
  if (!(amount > 0)) { toast('請輸入拿到多少'); return; }
  const cost = parseFloat(v('ci-cost'));
  const cur = v('ci-cur');
  saveExpense(S.tripId, S.user.uid, {
    type: 'cash', kind: 'in', memberId: v('ci-who'), currency: cur, amount,
    cost: cost > 0 && cur !== base() ? cost : null, note: v('ci-note').trim(), date: v('ci-date') || todayStr(),
  });
  closeSheet();
  toast(`已記錄 ${formatMoney(amount, cur)}`);
}

function saveCashCount() {
  const v = (id) => document.getElementById(id).value;
  const who = v('cc-who');
  const cur = v('cc-cur');
  const counted = parseFloat(v('cc-counted'));
  if (!Number.isFinite(counted) || counted < 0) { toast('請輸入實際數到的金額'); return; }
  const book = cashBal()[who]?.[cur] || 0;
  const diff = counted - book;
  closeSheet();
  if (Math.abs(diff) < 10 ** -decimalsOf(cur) / 2) { toast('和帳面一樣，不用修正 👍'); return; }
  saveExpense(S.tripId, S.user.uid, { type: 'cash', kind: 'adj', memberId: who, currency: cur, amount: diff, counted, date: todayStr(), note: '清點' });
  toast(`已修正 ${formatMoney(diff, cur)}`);
}

// ---------- 開支編輯 ----------
function blankDraft() {
  const t = S.trip;
  return {
    type: 'expense',
    title: '',
    amount: '',
    currency: t.defaultCurrency || t.baseCurrency,
    payerId: S.meId || t.members[0]?.id,
    toId: '',
    date: todayStr(),
    category: 'food',
    splitMode: 'equal',
    shares: Object.fromEntries(t.members.map((m) => [m.id, 1])),
    payMethod: lastPayMethod(),
    note: '',
    items: null,
    useItems: false,
  };
}

function sheetEditor(draftIn, { queueId = null, source: sourceIn = '', detail: detailIn = '' } = {}) {
  const t = S.trip;
  let source = sourceIn;
  let detail = detailIn;
  let touched = false; // 使用者改過任何欄位後，AI 結果就不自動覆蓋
  let pendingAi = null;
  const ed = { ...blankDraft(), ...draftIn };
  if (ed.items?.length && draftIn.useItems === undefined) ed.useItems = true;
  if (!ed.shares || !Object.keys(ed.shares).length) ed.shares = Object.fromEntries(t.members.map((m) => [m.id, 1]));
  const isNew = !ed.id;
  const dec = () => decimalsOf(ed.currency);

  function applyItems() {
    if (!ed.useItems || !ed.items?.length) return;
    // 品項沒指定人時由全部成員平分
    const per = splitReceipt(ed.items, Number(ed.amount) || 0, t.members.map((m) => m.id));
    ed.splitMode = 'amount';
    ed.shares = roundShares(per, Number(ed.amount) || 0, dec());
    for (const m of t.members) if (ed.shares[m.id] == null) ed.shares[m.id] = 0;
  }

  function splitSection() {
    if (ed.type === 'transfer') return '';
    const owed = owedShares(ed);
    const gap = amountSplitGap(ed);
    const itemsBlock = ed.items?.length ? `
      <div class="card" style="padding:12px;background:var(--bg);box-shadow:none">
        <label class="row"><input type="checkbox" data-k="useItems" ${ed.useItems ? 'checked' : ''}><span class="grow"><b>依收據品項分配</b>（${ed.items.length} 項）</span></label>
        ${ed.useItems ? ed.items.map((it, i) => `<div class="item-row"><div class="top"><div class="n"><div>${esc(it.nameZh || it.name)}</div>${it.nameZh && it.name !== it.nameZh ? `<div class="muted small">${esc(it.name)}</div>` : ''}</div>
          <div style="white-space:nowrap">${formatMoney(it.price, ed.currency)}${Number(it.quantity) > 1 ? ` ×${it.quantity}` : ''}</div></div>
          <div class="chips">${t.members.map((m) => `<button class="chip ${it.memberIds?.includes(m.id) ? 'on' : ''}" data-act="item-member" data-i="${i}" data-m="${m.id}">${esc(m.name)}</button>`).join('')}
          <span class="muted small" style="align-self:center">${it.memberIds?.length ? '' : '沒選＝大家平分'}</span></div></div>`).join('') : ''}
      </div>` : '';
    const modeSeg = ed.useItems ? '' : `<div class="seg" style="margin-bottom:8px">
        ${[['equal', '平均'], ['amount', '指定金額'], ['shares', '份數']].map(([k, l]) => `<button data-act="mode" data-v="${k}" class="${ed.splitMode === k ? 'on' : ''}">${l}</button>`).join('')}</div>`;
    const rows = t.members.map((m) => {
      const on = Number(ed.shares[m.id]) > 0 || (ed.splitMode !== 'equal' && ed.shares[m.id] !== undefined && ed.shares[m.id] !== 0);
      const input = ed.useItems ? '' : ed.splitMode === 'equal'
        ? ''
        : `<input type="number" inputmode="decimal" step="any" data-share="${m.id}" value="${ed.shares[m.id] ?? ''}" placeholder="${ed.splitMode === 'amount' ? '金額' : '份數'}">`;
      return `<div class="split-row">
        ${ed.splitMode === 'equal' && !ed.useItems ? `<input type="checkbox" data-member-on="${m.id}" ${Number(ed.shares[m.id]) > 0 ? 'checked' : ''}>` : ''}
        <span class="name">${esc(m.name)}${m.id === S.meId ? '（我）' : ''}</span>${input}
        <span class="calc" data-calc="${m.id}">${owed[m.id] != null ? formatMoney(owed[m.id], ed.currency) : on ? '' : '—'}</span></div>`;
    }).join('');
    return `<div class="field"><span class="muted small">分攤</span>${itemsBlock}${modeSeg}<div class="card" style="padding:4px 12px">${rows}</div>
      <div class="small neg" id="gap-note">${ed.splitMode === 'amount' && Math.abs(gap) > 10 ** -dec() / 2 ? `各人金額加總和總額差 ${formatMoney(gap, ed.currency)}` : ''}</div></div>`;
  }

  function draw(body) {
    applyItems();
    const memberOpts = (sel) => t.members.map((m) => `<option value="${m.id}" ${m.id === sel ? 'selected' : ''}>${esc(m.name)}${m.id === S.meId ? '（我）' : ''}</option>`).join('');
    body.innerHTML = `
      <h3>${isNew ? (ed.type === 'transfer' ? '記錄轉帳' : '新增開支') : '編輯'}${source ? ` <span class="muted small" id="ed-source">${esc(source)}</span>` : ''}</h3><p class="muted small" id="ed-detail" style="margin:-8px 0 8px">${esc(detail)}</p>
      <div id="ai-ready"></div>
      ${ed._thumb ? `<img class="receipt-thumb" src="${ed._thumb}" alt="收據照片">` : ''}
      <div class="seg" style="margin-bottom:12px">
        <button data-act="type" data-v="expense" class="${ed.type !== 'transfer' ? 'on' : ''}">開支</button>
        <button data-act="type" data-v="transfer" class="${ed.type === 'transfer' ? 'on' : ''}">轉帳還款</button></div>
      ${ed.type === 'transfer' ? '' : `<label class="field"><span>標題</span><input type="text" data-k="title" value="${esc(ed.title)}" placeholder="例如 午餐拉麵"></label>`}
      <div class="row">
        <label class="field grow"><span>金額</span><input type="number" inputmode="decimal" step="any" data-k="amount" value="${ed.amount}" placeholder="0"></label>
        <label class="field" style="width:110px"><span>幣別</span><select data-k="currency">${CURRENCIES.map((c) => `<option ${c === ed.currency ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      </div>
      <div class="muted small" id="conv" style="margin:-6px 0 10px">${ed.currency !== base() && Number(ed.amount) ? `≈ ${money(toBase(ed.amount, ed.currency, t))}` : ''}</div>
      <div class="row">
        <label class="field grow"><span>${ed.type === 'transfer' ? '誰付給' : '誰付的'}</span><select data-k="payerId">${memberOpts(ed.payerId)}</select></label>
        ${ed.type === 'transfer' ? `<label class="field grow"><span>付給誰</span><select data-k="toId">${['<option value="">選擇</option>', memberOpts(ed.toId)].join('')}</select></label>` : ''}
        <label class="field grow"><span>日期</span><input type="date" data-k="date" value="${ed.date || ''}"></label>
      </div>
      <div class="field"><span class="muted small">付款方式${ed.type === 'transfer' ? '' : '（付現金會從付款人的現金扣掉）'}</span><div class="seg">
        ${['cash', 'card'].map((k) => `<button data-act="pay" data-v="${k}" class="${(ed.payMethod || 'card') === k ? 'on' : ''}">${PAY_LABEL[k]}</button>`).join('')}</div></div>
      ${ed.type === 'transfer' ? '' : `<div class="field"><span class="muted small">類別</span><div class="chips">${CATEGORIES.map((c) => `<button class="chip ${ed.category === c.id ? 'on' : ''}" data-act="cat" data-v="${c.id}">${c.icon} ${c.label}</button>`).join('')}</div></div>`}
      ${splitSection()}
      ${ed.type === 'transfer' ? '' : `<label class="field"><span>備註</span><input type="text" data-k="note" value="${esc(ed.note || '')}"></label>`}
      <div class="foot">
        ${isNew ? '<button class="btn" data-act="close">取消</button>' : '<button class="btn danger" data-act="del-exp">刪除</button>'}
        <button class="btn primary" data-act="save-exp">儲存</button></div>`;
  }

  function updateCalc(body) {
    applyItems();
    const owed = owedShares(ed);
    body.querySelectorAll('[data-calc]').forEach((el) => {
      const id = el.dataset.calc;
      el.textContent = owed[id] != null ? formatMoney(owed[id], ed.currency) : '—';
    });
    const conv = body.querySelector('#conv');
    if (conv) conv.textContent = ed.currency !== base() && Number(ed.amount) ? `≈ ${money(toBase(ed.amount, ed.currency, t))}` : '';
    const gap = amountSplitGap(ed);
    const g = body.querySelector('#gap-note');
    if (g) g.textContent = ed.splitMode === 'amount' && Math.abs(gap) > 10 ** -dec() / 2 ? `各人金額加總和總額差 ${formatMoney(gap, ed.currency)}` : '';
  }

  const body = openSheet((b) => draw(b));
  body.addEventListener('input', (ev) => {
    const el = ev.target;
    touched = true;
    if (el.dataset.k && el.type !== 'checkbox') {
      ed[el.dataset.k] = el.value;
      if (el.tagName === 'SELECT' && el.dataset.k === 'currency') { draw(body); return; }
      if (el.dataset.k === 'amount' && ed.useItems) {
        draw(body);
        const a = body.querySelector('[data-k="amount"]');
        a.focus();
        return;
      }
      updateCalc(body);
    } else if (el.dataset.share) {
      ed.shares[el.dataset.share] = el.value === '' ? 0 : Number(el.value);
      updateCalc(body);
    }
  });
  body.addEventListener('change', (ev) => {
    const el = ev.target;
    touched = true;
    if (el.dataset.memberOn) { ed.shares[el.dataset.memberOn] = el.checked ? 1 : 0; draw(body); }
    else if (el.dataset.k === 'useItems') {
      ed.useItems = el.checked;
      if (!ed.useItems) { ed.splitMode = 'equal'; ed.shares = Object.fromEntries(t.members.map((m) => [m.id, 1])); }
      draw(body);
    }
  });
  body.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (['type', 'cat', 'mode', 'item-member', 'pay'].includes(act)) touched = true;
    if (act === 'close') closeSheet();
    else if (act === 'ai-apply') { Object.assign(ed, pendingAi); pendingAi = null; touched = false; draw(body); }
    else if (act === 'type') { ed.type = b.dataset.v; if (ed.type === 'transfer') { ed.title = '轉帳'; ed.currency = base(); } draw(body); }
    else if (act === 'cat') { ed.category = b.dataset.v; draw(body); }
    else if (act === 'pay') { ed.payMethod = b.dataset.v; draw(body); }
    else if (act === 'mode') {
      const v = b.dataset.v;
      if (v === 'equal') ed.shares = Object.fromEntries(t.members.map((m) => [m.id, Number(ed.shares[m.id]) > 0 ? 1 : 0]));
      if (v === 'shares') ed.shares = Object.fromEntries(t.members.map((m) => [m.id, Number(ed.shares[m.id]) > 0 ? 1 : 0]));
      if (v === 'amount') {
        const owed = owedShares({ ...ed, splitMode: ed.splitMode });
        ed.shares = roundShares(Object.fromEntries(t.members.map((m) => [m.id, owed[m.id] || 0])), Number(ed.amount) || 0, dec());
      }
      ed.splitMode = v;
      draw(body);
    } else if (act === 'item-member') {
      const it = ed.items[Number(b.dataset.i)];
      it.memberIds ||= [];
      const m = b.dataset.m;
      it.memberIds = it.memberIds.includes(m) ? it.memberIds.filter((x) => x !== m) : [...it.memberIds, m];
      draw(body);
    } else if (act === 'del-exp') {
      if (confirm('確定刪除這筆？')) { deleteExpense(S.tripId, ed.id); closeSheet(); toast('已刪除'); }
    } else if (act === 'save-exp') {
      const amount = Number(ed.amount);
      if (!(amount > 0)) { toast('請輸入金額'); return; }
      if (!ed.payerId) { toast('請選誰付的'); return; }
      const out = {
        id: ed.id,
        type: ed.type,
        title: ed.type === 'transfer' ? '轉帳' : (ed.title || '').trim() || cat(ed.category).label,
        amount,
        currency: ed.currency,
        payerId: ed.payerId,
        date: ed.date || todayStr(),
        note: ed.note || '',
        payMethod: ed.payMethod || 'card',
      };
      setPref(`pay_${S.tripId}`, out.payMethod);
      if (ed.type === 'transfer') {
        if (!ed.toId || ed.toId === ed.payerId) { toast('請選付給誰'); return; }
        Object.assign(out, { toId: ed.toId, splitMode: null, shares: {}, category: 'transfer', items: null });
      } else {
        const shares = Object.fromEntries(Object.entries(ed.shares).map(([k, v]) => [k, Number(v) || 0]));
        if (!Object.values(shares).some((v) => v > 0)) { toast('至少要有一人分攤'); return; }
        const check = { ...ed, amount, shares };
        if (ed.splitMode === 'amount' && Math.abs(amountSplitGap(check)) > 10 ** -dec() / 2) { toast('各人金額加總要等於總額'); return; }
        Object.assign(out, {
          category: ed.category,
          splitMode: ed.splitMode,
          shares,
          items: ed.items?.length ? ed.items.map((it) => ({ name: it.name || '', nameZh: it.nameZh || '', price: Number(it.price) || 0, quantity: Number(it.quantity) || 1, memberIds: it.memberIds || [] })) : null,
          useItems: !!ed.useItems,
          store: ed.store || '',
        });
      }
      saveExpense(S.tripId, S.user.uid, out);
      if (queueId) removeReceipt(queueId).then(refreshReceipts);
      closeSheet();
      toast(S.online ? '已儲存' : '已存在手機，連上網路後會同步');
    }
  });

  // 背景的 AI 解析完成後呼叫：還沒改過就直接套用；改過了就顯示「套用 AI 結果」讓使用者決定
  return {
    apply(patch, meta = {}) {
      if (!body.isConnected) return; // 已經儲存或關掉了
      if (meta.source != null) source = meta.source;
      if (meta.detail != null) detail = meta.detail;
      if (patch && !touched) { Object.assign(ed, patch); draw(body); return; }
      const src = body.querySelector('#ed-source'); if (src) src.textContent = source;
      const det = body.querySelector('#ed-detail'); if (det) det.textContent = detail;
      if (patch) {
        pendingAi = patch;
        body.querySelector('#ai-ready').innerHTML = '<div class="banner"><div class="grow">AI 解析好了，要用 AI 的結果取代目前的內容嗎？</div><button class="btn primary" data-act="ai-apply">套用</button></div>';
      }
    },
  };
}

// ---------- 語音記帳 ----------
// iPhone 的網頁語音辨識會讓整個 App 卡死（實測 1.3.3：要滑掉 App 才能用，WebKit 已知問題），
// 所以 iPhone 一律用鍵盤上的麥克風（就是 iOS 系統的聽寫，穩定）。
// 其他平台（Android Chrome）保留收音鈕；萬一卡住，3 秒後自動停掉，這次開 App 期間改用鍵盤麥克風。
let micBroken = false;

function sheetVoice() {
  const ios = platform() === 'ios';
  const SR = ios || micBroken ? null : (window.SpeechRecognition || window.webkitSpeechRecognition);
  let rec = null;
  let watchdog = null;
  warmUpAiIfUsable();
  const hint = ios
    ? '<br>按<b>鍵盤上的 🎤 麥克風</b>說話，說完按「解析」。'
    : micBroken
      ? '<br>收音剛剛沒有反應，這次請點輸入框，用<b>鍵盤上的麥克風</b>說話（重開 App 後會恢復）。'
      : SR ? '' : '<br>這個瀏覽器不支援直接收音，請點輸入框後用<b>鍵盤上的麥克風</b>說話。';
  const body = openSheet((b) => {
    b.innerHTML = `<h3>🎤 語音記帳</h3>
      <p class="muted small" style="margin-top:-6px">說一句話，例如「午餐拉麵 2400 日圓 吳薰付 平分」「伴手禮 1580 台幣 我付 只算我」。${hint}</p>
      <textarea id="v-text" placeholder="點這裡，用鍵盤麥克風說話，或直接打字"></textarea>
      <div class="foot">
        ${SR ? '<button class="btn" data-act="v-mic" id="v-mic">● 開始收音</button>' : '<button class="btn" data-act="close">取消</button>'}
        <button class="btn primary" data-act="v-parse" id="v-parse">解析</button></div>`;
  }, () => resetMic());
  const ta = body.querySelector('#v-text');
  const micBtn = body.querySelector('#v-mic');
  // 要在按下「語音」的同一個點擊裡 focus，iPhone 才會直接跳出鍵盤（用 setTimeout 會被擋）
  if (!SR) ta.focus();

  // 不論收音是正常結束、出錯還是卡住，都回到可以再按的狀態
  function resetMic(msg) {
    clearTimeout(watchdog);
    const r = rec;
    rec = null;
    if (r) { r.onresult = r.onerror = r.onend = r.onstart = r.onaudiostart = null; try { r.abort(); } catch { /* ignore */ } }
    if (micBtn) { micBtn.textContent = '● 開始收音'; micBtn.classList.remove('mic-on'); }
    if (msg) toast(msg, 4500);
  }
  function micHung() {
    micBroken = true;
    resetMic('收音沒有反應。請點輸入框，用鍵盤上的麥克風說話');
    if (micBtn) micBtn.remove();
    ta.focus();
  }

  body.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'close') closeSheet();
    if (b.dataset.act === 'v-mic') {
      if (rec) {
        // 按停止：正常會觸發 onend；1.5 秒內沒結束就強制停掉
        try { rec.stop(); } catch { /* ignore */ }
        clearTimeout(watchdog);
        watchdog = setTimeout(() => resetMic(), 1500);
        return;
      }
      let started = false;
      rec = new SR();
      rec.lang = 'zh-TW';
      rec.interimResults = true;
      rec.continuous = false;
      const startText = ta.value ? `${ta.value} ` : '';
      rec.onstart = rec.onaudiostart = () => {
        started = true;
        clearTimeout(watchdog);
        watchdog = setTimeout(() => resetMic(), 20000); // 一次最多收 20 秒
      };
      rec.onresult = (e) => { started = true; ta.value = startText + [...e.results].map((r) => r[0].transcript).join(''); };
      rec.onerror = (e) => {
        if (e.error === 'aborted') return;
        resetMic(e.error === 'not-allowed' ? '沒有麥克風權限，請到「設定」允許，或用鍵盤上的麥克風'
          : e.error === 'no-speech' ? '沒聽到聲音，請再按一次開始收音' : '收音失敗，可改用鍵盤上的麥克風');
      };
      rec.onend = () => resetMic();
      b.textContent = '■ 停止';
      b.classList.add('mic-on');
      // 3 秒內完全沒開始，就是卡住了
      watchdog = setTimeout(() => { if (!started) micHung(); }, 3000);
      try { rec.start(); } catch { micHung(); }
    }
    if (b.dataset.act === 'v-parse') {
      const text = ta.value.trim();
      if (!text) { toast('請先說一句話或打字'); return; }
      resetMic();
      const useAi = S.online && aiEnabled();
      // 先用離線解析馬上打開記帳畫面，AI 的結果回來再補上
      const ctl = sheetEditor(localVoiceDraft(text), { source: useAi ? '離線解析・AI 解析中…' : '離線解析' });
      if (!useAi) return;
      aiVoiceDraft(text).then((r) => {
        ctl.apply(r.draft, { source: r.source, detail: r.detail });
      }).catch((err) => {
        console.warn('AI 解析失敗，改用離線解析', err);
        const msg = String(err?.message || err?.code || err);
        ctl.apply(null, { source: '離線解析' });
        if (document.getElementById('ed-source')) toast(`AI 解析失敗，保留離線解析：${msg === 'timeout' ? '等太久（超過 20 秒）' : msg.slice(0, 120)}`, 6000);
      });
    }
  });
}

function voiceContext() {
  const t = S.trip;
  const members = t.members.map((m) => ({ id: m.id, name: m.name }));
  return { t, members, meId: S.meId || members[0]?.id };
}

// 解析結果 → 記帳畫面的欄位
function voiceDraftFrom(p, text) {
  const { t, meId } = voiceContext();
  const ids = p.participantIds || t.members.map((m) => m.id);
  return {
    title: p.title,
    amount: p.amount ?? '',
    currency: p.currency,
    payerId: p.payerId || meId,
    date: p.date,
    category: p.category,
    splitMode: 'equal',
    shares: Object.fromEntries(t.members.map((m) => [m.id, ids.includes(m.id) ? 1 : 0])),
    note: `🎤 ${text}`,
    ...(p.payMethod ? { payMethod: p.payMethod } : {}), // 沒講就用上次的付款方式
  };
}

function localVoiceParse(text) {
  const { t, members, meId } = voiceContext();
  return parseExpenseText(text, { members, meId, defaultCurrency: t.defaultCurrency || base() });
}

function localVoiceDraft(text) {
  return voiceDraftFrom(localVoiceParse(text), text);
}

// AI 解析；AI 沒給的欄位用離線解析補
async function aiVoiceDraft(text) {
  const { t, members, meId } = voiceContext();
  const local = localVoiceParse(text);
  const t0 = performance.now();
  const aiMod = await import('./ai.js');
  const r = await withTimeout(aiMod.parseTextWithAi(text, {
    memberNames: members.map((m) => m.name),
    meName: memberName(meId),
    defaultCurrency: t.defaultCurrency || base(),
    today: todayStr(),
  }), 20000);
  const findId = (n) => members.find((m) => n && (m.name === n || m.name.includes(n) || n.includes(m.name)))?.id;
  const partIds = (r.participantNames || []).map(findId).filter(Boolean);
  const p = {
    title: r.title || local.title,
    amount: Number(r.amount) || local.amount,
    currency: CURRENCIES.includes(r.currency) ? r.currency : local.currency,
    payerId: findId(r.payerName) || local.payerId,
    participantIds: partIds.length ? [...new Set(partIds)] : null,
    category: CATEGORIES.some((c) => c.id === r.category) ? r.category : local.category,
    date: /^\d{4}-\d{2}-\d{2}$/.test(r.date || '') ? r.date : local.date,
    payMethod: local.payMethod,
  };
  return { draft: voiceDraftFrom(p, text), source: `AI 解析・${secondsSince(t0)}`, detail: aiTimingText(aiMod) };
}

// ---------- 拍明細 ----------
function sheetCameraChoice() {
  warmUpAiIfUsable();
  openSheet((b) => {
    b.innerHTML = `<h3>📷 拍明細</h3>
      <p class="muted small" style="margin-top:-6px">${S.online && aiEnabled() ? '拍好後 AI 會自動辨識金額和品項，你可以再調整每個品項由誰分攤。' : '目前沒有網路，照片會先存在手機，有網路時再辨識。'}</p>
      <button class="btn primary block" data-act="pick-camera">拍照</button><div style="height:8px"></div>
      <button class="btn block" data-act="pick-album">從相簿選</button>`;
  });
}

async function handlePhoto(file) {
  if (!file) return;
  const { compressImage } = await import('./ai.js');
  let img;
  try { img = await compressImage(file); } catch { toast('照片讀取失敗'); return; }
  const item = { id: newId(), tripId: S.tripId, dataUrl: img.dataUrl, payerId: S.meId, createdMs: Date.now() };
  if (!S.online || !aiEnabled()) {
    await queueReceipt(item);
    await refreshReceipts();
    closeSheet();
    toast(aiEnabled() ? '照片已存起來，有網路時再辨識' : '照片已存起來');
    return;
  }
  await recognizeAndEdit(item, false);
}

async function recognizeAndEdit(item, fromQueue) {
  const t = S.trip;
  openSheet((b) => {
    b.innerHTML = `<h3>辨識中…</h3><img class="receipt-thumb" src="${item.dataUrl}" alt="收據照片"><p class="muted" style="text-align:center"><span class="spinner"></span> AI 正在讀收據</p>`;
  });
  const t0 = performance.now();
  try {
    const aiMod = await import('./ai.js');
    const { recognizeReceipt } = aiMod;
    const r = await withTimeout(recognizeReceipt(item.dataUrl.split(',')[1], {
      defaultCurrency: t.defaultCurrency || base(),
      memberNames: t.members.map((m) => m.name),
    }), 45000);
    const currency = CURRENCIES.includes(r.currency) ? r.currency : (t.defaultCurrency || base());
    const items = (r.items || []).filter((it) => Number(it.price)).map((it) => ({ ...it, memberIds: [] }));
    const total = Number(r.total) || items.reduce((s, it) => s + Number(it.price) * (Number(it.quantity) || 1), 0);
    sheetEditor({
      title: r.titleZh || r.store || '',
      store: r.store || '',
      amount: total || '',
      currency,
      payerId: item.payerId || S.meId,
      date: /^\d{4}-\d{2}-\d{2}$/.test(r.date || '') ? r.date : todayStr(),
      category: CATEGORIES.some((c) => c.id === r.category) ? r.category : guessCategory(`${r.store} ${r.titleZh}`),
      items,
      _thumb: item.dataUrl,
    }, { queueId: fromQueue ? item.id : null, source: `收據辨識・${secondsSince(t0)}`, detail: aiTimingText(aiMod) });
  } catch (err) {
    console.error(err);
    if (!fromQueue) { await queueReceipt(item); await refreshReceipts(); }
    openSheet((b) => {
      b.innerHTML = `<h3>辨識失敗</h3><img class="receipt-thumb" src="${item.dataUrl}" alt="收據照片">
        <p class="muted small">${esc(String(err?.message || err)).slice(0, 200)}</p>
        <p>照片已存在「待辨識」，可以稍後再試，或現在手動輸入。</p>
        <div class="foot"><button class="btn" data-act="close">稍後</button><button class="btn primary" data-act="manual-from" data-id="${item.id}">手動輸入</button></div>`;
    });
  }
}

function sheetReceipts() {
  openSheet((b) => {
    b.innerHTML = `<h3>待辨識的明細</h3>${S.receipts.map((r) => `
      <div class="card" style="box-shadow:none;background:var(--bg)"><img class="receipt-thumb" src="${r.dataUrl}" alt="">
      <div class="row" style="margin-top:8px">
        <button class="btn grow" data-act="rq-del" data-id="${r.id}">刪除</button>
        <button class="btn grow" data-act="manual-from" data-id="${r.id}">手動輸入</button>
        ${S.online ? `<button class="btn primary grow" data-act="rq-run" data-id="${r.id}">AI 辨識</button>` : ''}
      </div></div>`).join('') || '<div class="muted">沒有待辨識的照片</div>'}`;
  });
}

// ---------- 事件 ----------
document.addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-act]');
  if (!b || b.closest('.sheet-body') && ['type', 'cat', 'mode', 'item-member', 'del-exp', 'save-exp', 'v-mic', 'v-parse', 'ai-apply', 'pay'].includes(b.dataset.act)) return;
  const act = b.dataset.act;
  const t = S.trip;
  switch (act) {
    case 'close': closeSheet(); break;
    case 'new-trip': sheetNewTrip(); break;
    case 'nt-create': doCreateTrip(); break;
    case 'check-update': checkForUpdateNow(); break;
    case 'cash-in': sheetCashIn(); break;
    case 'cash-count': sheetCashCount(); break;
    case 'cash-save-in': saveCashIn(); break;
    case 'cash-save-count': saveCashCount(); break;
    case 'cash-del':
      if (confirm('刪除這筆現金紀錄？')) { deleteExpense(S.tripId, b.dataset.id); toast('已刪除'); }
      break;
    case 'fetch-rates': doFetchRates(); break;
    case 'apply-rates': applyFetchedRates(); break;
    case 'use-avg-rate': {
      const el = document.querySelector(`[data-rate="${b.dataset.c}"]`);
      if (el) { el.value = b.dataset.v; toast('已填入，按「儲存」才會生效'); }
      break;
    }
    case 'back': {
      // 從 App 內其他頁面進來就回上一頁，直接打開說明頁時回首頁
      ev.preventDefault();
      if (S.navCount > 0) history.back(); else go('#/');
      break;
    }
    case 'copy-here': {
      try { await navigator.clipboard.writeText(location.href); toast('已複製，到主畫面 App 首頁按「用邀請連結加入」貼上'); }
      catch { prompt('請複製這個連結', location.href); }
      break;
    }
    case 'join-paste': {
      const url = prompt('貼上旅伴傳來的邀請連結');
      const m = url && url.match(/join\/([A-Za-z0-9]+)/);
      if (m) go(`#/join/${m[1]}`); else if (url) toast('連結格式不對');
      break;
    }
    case 'join-as':
    case 'join-new': {
      const info = JSON.parse($app.querySelector('main').dataset.trip || 'null');
      if (!info) return;
      const newName = act === 'join-new' ? document.getElementById('join-new').value.trim() : '';
      if (act === 'join-new' && !newName) { toast('請輸入名字'); return; }
      b.disabled = true;
      try {
        const meId = await joinTrip(info, S.user.uid, act === 'join-as' ? { memberId: b.dataset.id } : { newName });
        setMe(info.id, meId);
        go(`#/t/${info.id}/list`);
      } catch (err) {
        console.error(err);
        toast(S.online ? '加入失敗，請再試一次' : '加入需要網路');
        b.disabled = false;
      }
      break;
    }
    case 'add': sheetEditor({}); break;
    case 'edit': {
      const e = S.expenses.find((x) => x.id === b.dataset.id);
      if (e) sheetEditor({ ...e, shares: { ...(e.shares || {}) }, items: e.items ? e.items.map((it) => ({ ...it })) : null });
      break;
    }
    case 'voice': sheetVoice(); break;
    case 'camera': sheetCameraChoice(); break;
    case 'pick-camera': document.getElementById('camera-input').click(); break;
    case 'pick-album': document.getElementById('album-input').click(); break;
    case 'receipts': sheetReceipts(); break;
    case 'rq-del': await removeReceipt(b.dataset.id); await refreshReceipts(); sheetReceipts(); break;
    case 'rq-run': {
      const r = S.receipts.find((x) => x.id === b.dataset.id);
      if (r) recognizeAndEdit(r, true);
      break;
    }
    case 'manual-from': {
      const r = S.receipts.find((x) => x.id === b.dataset.id);
      if (r) sheetEditor({ _thumb: r.dataUrl, payerId: r.payerId || S.meId }, { queueId: r.id, source: '手動輸入' });
      break;
    }
    case 'record-settle': {
      const sug = settle(computeBalances(t, S.expenses), decimalsOf(base()))[Number(b.dataset.i)];
      if (!sug) return;
      if (!confirm(`記錄 ${memberName(sug.from)} 已付給 ${memberName(sug.to)} ${money(sug.amount)}？`)) return;
      saveExpense(S.tripId, S.user.uid, { type: 'transfer', title: '轉帳', amount: sug.amount, currency: base(), payerId: sug.from, toId: sug.to, date: todayStr(), shares: {}, splitMode: null, category: 'transfer' });
      toast('已記錄轉帳');
      break;
    }
    case 'share-link': {
      const link = inviteLink(t.id);
      if (navigator.share) {
        navigator.share({ title: `加入「${t.name}」分帳`, text: `用這個連結加入「${t.name}」一起記帳`, url: link }).catch(() => {});
      } else {
        await navigator.clipboard?.writeText(link);
        toast('已複製邀請連結');
      }
      break;
    }
    case 'add-member': {
      const name = document.getElementById('new-member').value.trim();
      if (!name) return;
      updateTrip(t.id, { members: [...t.members, { id: newId(), name, uid: null }] });
      toast(`已新增 ${name}`);
      break;
    }
    case 'save-members': {
      const members = t.members.map((m) => {
        const input = document.querySelector(`[data-member="${m.id}"]`);
        return { ...m, name: input?.value.trim() || m.name };
      });
      updateTrip(t.id, { members });
      toast('已儲存');
      break;
    }
    case 'save-trip': {
      const rates = { ...(t.rates || {}) };
      document.querySelectorAll('[data-rate]').forEach((el) => {
        const v = parseFloat(el.value);
        if (v > 0) rates[el.dataset.rate] = v; else delete rates[el.dataset.rate];
      });
      const newBase = document.getElementById('set-base').value;
      if (newBase !== t.baseCurrency && !confirm('換結算幣別後，匯率要改成「1 外幣 = 多少新結算幣」，確定要換？')) return;
      updateTrip(t.id, {
        name: document.getElementById('set-name').value.trim() || t.name,
        baseCurrency: newBase,
        defaultCurrency: document.getElementById('set-default').value,
        rates,
      });
      toast('已儲存');
      break;
    }
    case 'link-google': doLinkGoogle(); break;
    case 'export': exportCsv(); break;
    case 'delete-trip':
      if (confirm(`確定刪除「${t.name}」？所有人都會看不到這趟旅行。`)) { deleteTrip(t.id); go('#/'); }
      break;
    default: break;
  }
});

document.addEventListener('change', (ev) => {
  const el = ev.target;
  if (el.id === 'set-me') { S.meId = el.value || null; setMe(S.tripId, el.value); render(); toast('已設定'); }
  if (el.id === 'set-ai') { setPref('ai', el.checked); }
  if (el.id === 'camera-input' || el.id === 'album-input') {
    const f = el.files?.[0];
    el.value = '';
    handlePhoto(f);
  }
});

function exportCsv() {
  const t = S.trip;
  const head = ['日期', '類別', '標題', '金額', '幣別', `約${base()}`, '支付者', '轉給', '分攤方式', ...t.members.map((m) => `${m.name}負擔(${base()})`), '付款方式', '備註'];
  const rows = [...S.expenses].reverse().map((e) => {
    const owed = e.type === 'transfer' ? {} : owedShares(e);
    return [
      e.date, e.type === 'transfer' ? '轉帳' : cat(e.category).label, e.title, e.amount, e.currency,
      Math.round(toBase(e.amount, e.currency, t) * 100) / 100,
      memberName(e.payerId), e.toId ? memberName(e.toId) : '',
      { equal: '平均', amount: '指定金額', shares: '份數' }[e.splitMode] || '',
      ...t.members.map((m) => (owed[m.id] != null ? Math.round(toBase(owed[m.id], e.currency, t) * 100) / 100 : '')),
      e.payMethod === 'cash' ? '現金' : '刷卡・其他',
      e.note || '',
    ];
  });
  // 現金紀錄（換匯、清點）放在最後，不算進分帳
  for (const r of [...S.cash].sort((a, b) => (a.date || '').localeCompare(b.date || ''))) {
    rows.push([
      r.date, r.kind === 'adj' ? '現金清點' : '換匯／領錢', r.note || '', r.amount, r.currency,
      r.cost ? r.cost : '', memberName(r.memberId), '', '', ...t.members.map(() => ''), '現金',
      r.kind === 'adj' ? `數到 ${r.counted}` : r.cost ? `實際匯率 ${roundRate(r.cost / r.amount)}` : '',
    ]);
  }
  const csv = [head, ...rows].map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${t.name}-分帳.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- 啟動 ----------
window.addEventListener('hashchange', () => { S.navCount = (S.navCount || 0) + 1; closeSheet(); render(); });
window.addEventListener('online', () => { S.online = true; render(); if (S.receipts.length) toast(`有 ${S.receipts.length} 張明細可以辨識了`); });
window.addEventListener('offline', () => { S.online = false; render(); });

// ---------- 自動檢查更新 ----------
// App 在背景放著時不會重新載入（iPhone 可能好幾天都是同一個畫面），
// 所以回到前景、每 30 分鐘、重新連上網路時，直接問伺服器目前的版本號。
// 有新版只顯示提示，由使用者按「更新」才重新載入，避免打到一半的開支不見。
function isNewer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

let lastUpdateCheck = 0;
// 回傳 { status: 'newer'|'latest'|'offline'|'skipped'|'error', server, detail }
async function checkForUpdate(force = false) {
  if (!navigator.onLine) return { status: 'offline' };
  if (!force && (document.visibilityState !== 'visible' || Date.now() - lastUpdateCheck < 60 * 1000)) return { status: 'skipped' }; // 一分鐘內不重複檢查
  lastUpdateCheck = Date.now();
  navigator.serviceWorker?.getRegistration().then((r) => r?.update()).catch(() => {});
  try {
    const res = await fetch(`js/config.js?vcheck=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return { status: 'error', detail: `HTTP ${res.status}` };
    const m = (await res.text()).match(/APP_VERSION\s*=\s*'([\d.]+)'/);
    if (!m) return { status: 'error', detail: '找不到版本號' };
    if (isNewer(m[1], APP_VERSION)) { showUpdateBar(m[1]); return { status: 'newer', server: m[1] }; }
    return { status: 'latest', server: m[1] };
  } catch (err) {
    return { status: 'error', detail: String(err?.message || err) }; // 沒網路或連不上，下次再試
  }
}

// 點版本號：立刻檢查一次並告訴使用者結果
async function checkForUpdateNow() {
  toast('檢查更新中…', 1500);
  const r = await checkForUpdate(true);
  if (r.status === 'latest') toast(`已是最新版 v${APP_VERSION}`);
  else if (r.status === 'offline') toast('目前沒有網路，無法檢查更新');
  else if (r.status === 'error') toast(`檢查更新失敗：${r.detail}`, 4000);
  // newer：上方已顯示「有新版本」
}

function showUpdateBar(version) {
  let bar = document.getElementById('update-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'update-bar';
    bar.setAttribute('role', 'status');
    document.body.appendChild(bar);
    bar.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-upd=later]')) { bar.remove(); return; }
      if (ev.target.closest('[data-upd=go]')) location.reload();
    });
  }
  bar.innerHTML = `<span class="grow">有新版本 v${esc(version)}</span><button class="btn" data-upd="later">稍後</button><button class="btn primary" data-upd="go">更新</button>`;
}

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForUpdate(); });
window.addEventListener('online', () => checkForUpdate(true));
setInterval(() => checkForUpdate(true), 30 * 60 * 1000);

async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
  try {
    await initFirebase();
    S.user = await waitForUser();
  } catch (err) {
    console.error(err);
    $app.innerHTML = `<div class="boot"><div class="boot-logo">tripsplit</div>
      <div>第一次使用需要網路建立帳號。<br><span class="muted small">${esc(err?.code || err?.message || err)}</span></div>
      <button class="btn primary" onclick="location.reload()">重試</button></div>`;
    return;
  }
  S.unsubTrips = watchMyTrips(S.user.uid, (trips) => {
    S.trips = trips;
    if (route().view === 'home') renderHome();
  });
  render();
  if (S.online) handleGoogleRedirect();
  setTimeout(() => checkForUpdate(true), 3000);
}

boot();
