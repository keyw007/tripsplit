// tripsplit 主程式：畫面、路由、記帳流程。
import {
  initFirebase, waitForUser, watchMyTrips, watchTrip, watchExpenses, getTripOnce,
  createTrip, updateTrip, joinTrip, deleteTrip, saveExpense, deleteExpense, newId,
  accountInfo, linkGoogle, switchToGoogle, prepareGoogleLink,
} from './firebase.js';
import {
  formatMoney, toBase, owedShares, amountSplitGap, computeBalances, settle,
  splitReceipt, roundShares, decimalsOf, missingRates,
} from './money.js';
import { parseExpenseText, CATEGORIES, guessCategory } from './parse.js';
import { getMe, setMe, getPref, setPref, queueReceipt, listReceipts, removeReceipt } from './store.js';
import { APP_VERSION } from './config.js';

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
        S.expenses = list;
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
  S.tripId = null; S.trip = null; S.expenses = [];
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
      ${trips.length ? trips.map((t) => `
        <a class="card trip-card" href="#/t/${t.id}/list">
          <div class="name">${esc(t.name)}${t._pending ? '<span class="pending-dot"></span>' : ''}</div>
          <div class="muted small">${esc((t.members || []).map((m) => m.name).join('、'))}</div>
        </a>`).join('') : '<div class="empty">還沒有旅行。<br>新增一趟，或打開旅伴傳來的邀請連結加入。</div>'}
      <button class="btn primary block" data-act="new-trip">＋ 新增旅行</button>
      <div style="height:10px"></div>
      <button class="btn block" data-act="join-paste">用邀請連結加入</button>
      <div style="height:16px"></div>
      ${renderAccountCard()}
      <p class="muted small" style="text-align:center;margin-top:24px">v${APP_VERSION}</p>
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
      <div class="mid"><div class="t">${esc(memberName(e.payerId))} → ${esc(memberName(e.toId))}</div><div class="s">轉帳還款${e._pending ? '<span class="pending-dot"></span>' : ''}</div></div>
      <div class="amt"><div class="a">${formatMoney(e.amount, e.currency)}</div></div></div>`;
  }
  const owed = owedShares(e);
  const ids = Object.keys(owed);
  const who = ids.length === t.members.length ? '全部人' : ids.map(memberName).join('、');
  const mine = S.meId && owed[S.meId] != null ? `我 ${formatMoney(owed[S.meId], e.currency)}` : '';
  const conv = e.currency !== base() ? `<div class="s">≈ ${money(toBase(e.amount, e.currency, t))}</div>` : '';
  return `<div class="exp" data-act="edit" data-id="${e.id}"><div class="ico">${cat(e.category).icon}</div>
    <div class="mid"><div class="t">${esc(e.title || cat(e.category).label)}</div>
      <div class="s">${esc(memberName(e.payerId))} 付・${esc(who)}${mine ? `・${mine}` : ''}${e._pending ? '<span class="pending-dot"></span>' : ''}</div></div>
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
  const used = new Set([t.defaultCurrency, ...S.expenses.map((e) => e.currency), ...Object.keys(t.rates || {})]);
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
      ${[...used].map((c) => `<label class="field"><span>1 ${c} =</span><input type="number" inputmode="decimal" step="any" data-rate="${c}" value="${t.rates?.[c] ?? ''}" placeholder="例如 0.21"></label>`).join('') || '<p class="muted small">目前只用結算幣別，不需要匯率。</p>'}
      <button class="btn primary block" data-act="save-trip">儲存</button></div>
    <div class="card"><h2>AI 辨識</h2>
      <label class="row"><input type="checkbox" id="set-ai" ${aiEnabled() ? 'checked' : ''}><span class="grow">有網路時，拍明細與語音用 AI 解析</span></label>
      <p class="muted small">關掉時，語音改用手機內建規則解析；拍明細只能存起來手動輸入。</p></div>
    <div class="card"><h2>資料</h2>
      <button class="btn block" data-act="export">匯出 CSV（可匯入 Google 試算表）</button>
      ${isOwner ? '<div style="height:8px"></div><button class="btn danger block" data-act="delete-trip">刪除這趟旅行</button>' : ''}
      <p class="muted small">v${APP_VERSION}・帳號 ${esc(S.user.uid.slice(0, 6))}</p></div>
    ${renderAccountCard()}`;
}

// ---------- 帳號（Google 備份） ----------
function isStandalone() {
  return navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
}

function renderAccountCard() {
  const a = accountInfo();
  if (!a.isAnonymous) {
    return `<div class="card"><h2>帳號</h2>
      <div>✅ 已綁定 Google${a.email ? `：${esc(a.email)}` : ''}</div>
      <p class="muted small">換手機時，在新手機打開 tripsplit，按「連結 Google 帳號」選同一個 Google 帳號，就能拿回所有旅行。</p></div>`;
  }
  prepareGoogleLink();
  return `<div class="card"><h2>帳號</h2>
    <div>匿名帳號（只存在這支手機）</div>
    <p class="muted small">綁定 Google 後，換手機或清掉瀏覽器資料，用同一個 Google 帳號登入就能拿回所有旅行與帳目。平常照樣不用登入。</p>
    <button class="btn block" data-act="link-google">連結 Google 帳號</button>
    ${isStandalone() ? '<p class="muted small">若 Google 視窗登入後沒有自動回到 App，回到 App 再按一次即可。請在這個 App 裡綁定，不要在 Safari 分頁綁定（兩邊的帳號是分開的）。</p>' : ''}
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
  // 必須在點擊當下就開視窗，否則會被瀏覽器擋住
  const p = linkGoogle();
  try {
    const r = await p;
    if (r.status === 'exists') {
      const ok = confirm('這個 Google 帳號已經綁過另一個 tripsplit 帳號（例如舊手機）。\n\n要改用它嗎？改用後會看到舊帳號的旅行；這支手機目前加入的旅行，之後可以用邀請連結重新加入。');
      if (!ok) return;
      await switchToGoogle(r.cred);
      location.reload();
      return;
    }
    toast('已綁定 Google 帳號');
    render();
  } catch (err) {
    console.error('[linkGoogle]', err);
    toast(LINK_ERRORS[err.code] || `綁定失敗：${err.code || err.message}`, 4000);
  }
}

// ---------- 新增旅行 ----------
function sheetNewTrip() {
  openSheet((b) => {
    b.innerHTML = `<h3>新增旅行</h3>
      <label class="field"><span>旅行名稱</span><input type="text" id="nt-name" placeholder="例如 2026 日本跨年"></label>
      <label class="field"><span>我的名字</span><input type="text" id="nt-me" placeholder="例如 郁文"></label>
      <div class="field"><span class="muted small">旅伴（一行一位，之後也能再加）</span><textarea id="nt-others" placeholder="吳薰"></textarea></div>
      <div class="row">
        <label class="field grow"><span>結算幣別</span><select id="nt-base">${CURRENCIES.map((c) => `<option ${c === 'TWD' ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
        <label class="field grow"><span>當地幣別</span><select id="nt-local">${CURRENCIES.map((c) => `<option ${c === 'JPY' ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span>匯率：1 當地幣 = 多少結算幣</span><input type="number" inputmode="decimal" step="any" id="nt-rate" value="0.21"></label>
      <div class="foot"><button class="btn" data-act="close">取消</button><button class="btn primary" data-act="nt-create">建立</button></div>`;
  });
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
    note: '',
    items: null,
    useItems: false,
  };
}

function sheetEditor(draftIn, { queueId = null, source = '' } = {}) {
  const t = S.trip;
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
      <h3>${isNew ? (ed.type === 'transfer' ? '記錄轉帳' : '新增開支') : '編輯'}${source ? ` <span class="muted small">${esc(source)}</span>` : ''}</h3>
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
    if (act === 'close') closeSheet();
    else if (act === 'type') { ed.type = b.dataset.v; if (ed.type === 'transfer') { ed.title = '轉帳'; ed.currency = base(); } draw(body); }
    else if (act === 'cat') { ed.category = b.dataset.v; draw(body); }
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
      };
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
}

// ---------- 語音記帳 ----------
function sheetVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  const body = openSheet((b) => {
    b.innerHTML = `<h3>🎤 語音記帳</h3>
      <p class="muted small" style="margin-top:-6px">說一句話，例如「午餐拉麵 2400 日圓 吳薰付 平分」「伴手禮 1580 台幣 我付 只算我」。
      ${SR ? '' : '<br>這個瀏覽器不支援直接收音，請點輸入框後用<b>鍵盤上的麥克風</b>說話。'}</p>
      <textarea id="v-text" placeholder="點這裡，用鍵盤麥克風說話，或直接打字"></textarea>
      <div class="foot">
        ${SR ? '<button class="btn" data-act="v-mic" id="v-mic">● 開始收音</button>' : '<button class="btn" data-act="close">取消</button>'}
        <button class="btn primary" data-act="v-parse" id="v-parse">解析</button></div>`;
  }, () => { try { rec?.stop(); } catch { /* ignore */ } });
  const ta = body.querySelector('#v-text');
  if (!SR) setTimeout(() => ta.focus(), 250);
  body.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'close') closeSheet();
    if (b.dataset.act === 'v-mic') {
      if (rec) { rec.stop(); return; }
      rec = new SR();
      rec.lang = 'zh-TW';
      rec.interimResults = true;
      rec.continuous = false;
      const startText = ta.value ? `${ta.value} ` : '';
      rec.onresult = (e) => { ta.value = startText + [...e.results].map((r) => r[0].transcript).join(''); };
      rec.onerror = (e) => {
        toast(e.error === 'not-allowed' ? '沒有麥克風權限' : '收音失敗，可改用鍵盤上的麥克風');
      };
      rec.onend = () => { rec = null; b.textContent = '● 開始收音'; b.classList.remove('mic-on'); };
      b.textContent = '■ 停止';
      b.classList.add('mic-on');
      try { rec.start(); } catch { toast('收音失敗，可改用鍵盤上的麥克風'); }
    }
    if (b.dataset.act === 'v-parse') {
      const text = ta.value.trim();
      if (!text) { toast('請先說一句話或打字'); return; }
      b.disabled = true;
      b.innerHTML = '<span class="spinner"></span>';
      const draft = await parseVoice(text);
      sheetEditor(draft.draft, { source: draft.source });
      if (draft.aiError) toast(`AI 解析失敗，改用離線解析：${draft.aiError}`, 6000);
    }
  });
}

async function parseVoice(text) {
  const t = S.trip;
  const members = t.members.map((m) => ({ id: m.id, name: m.name }));
  const meId = S.meId || members[0]?.id;
  const local = parseExpenseText(text, { members, meId, defaultCurrency: t.defaultCurrency || base() });
  let p = local;
  let source = '離線解析';
  let aiError = '';
  if (S.online && aiEnabled()) {
    try {
      const { parseTextWithAi } = await import('./ai.js');
      const r = await withTimeout(parseTextWithAi(text, {
        memberNames: members.map((m) => m.name),
        meName: memberName(meId),
        defaultCurrency: t.defaultCurrency || base(),
        today: todayStr(),
      }), 20000);
      const findId = (n) => members.find((m) => n && (m.name === n || m.name.includes(n) || n.includes(m.name)))?.id;
      const partIds = (r.participantNames || []).map(findId).filter(Boolean);
      p = {
        title: r.title || local.title,
        amount: Number(r.amount) || local.amount,
        currency: CURRENCIES.includes(r.currency) ? r.currency : local.currency,
        payerId: findId(r.payerName) || local.payerId,
        participantIds: partIds.length ? [...new Set(partIds)] : null,
        category: CATEGORIES.some((c) => c.id === r.category) ? r.category : local.category,
        date: /^\d{4}-\d{2}-\d{2}$/.test(r.date || '') ? r.date : local.date,
      };
      source = 'AI 解析';
    } catch (err) {
      console.warn('AI 解析失敗，改用離線解析', err);
      const msg = String(err?.message || err?.code || err);
      aiError = msg === 'timeout' ? '等太久（超過 20 秒）' : msg.slice(0, 120);
    }
  }
  const ids = p.participantIds || t.members.map((m) => m.id);
  return {
    source,
    aiError,
    draft: {
      title: p.title,
      amount: p.amount ?? '',
      currency: p.currency,
      payerId: p.payerId || meId,
      date: p.date,
      category: p.category,
      splitMode: 'equal',
      shares: Object.fromEntries(t.members.map((m) => [m.id, ids.includes(m.id) ? 1 : 0])),
      note: `🎤 ${text}`,
    },
  };
}

// ---------- 拍明細 ----------
function sheetCameraChoice() {
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
  try {
    const { recognizeReceipt } = await import('./ai.js');
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
    }, { queueId: fromQueue ? item.id : null, source: '收據辨識' });
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
  if (!b || b.closest('.sheet-body') && ['type', 'cat', 'mode', 'item-member', 'del-exp', 'save-exp', 'v-mic', 'v-parse'].includes(b.dataset.act)) return;
  const act = b.dataset.act;
  const t = S.trip;
  switch (act) {
    case 'close': closeSheet(); break;
    case 'new-trip': sheetNewTrip(); break;
    case 'nt-create': doCreateTrip(); break;
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
  const head = ['日期', '類別', '標題', '金額', '幣別', `約${base()}`, '支付者', '轉給', '分攤方式', ...t.members.map((m) => `${m.name}負擔(${base()})`), '備註'];
  const rows = [...S.expenses].reverse().map((e) => {
    const owed = e.type === 'transfer' ? {} : owedShares(e);
    return [
      e.date, e.type === 'transfer' ? '轉帳' : cat(e.category).label, e.title, e.amount, e.currency,
      Math.round(toBase(e.amount, e.currency, t) * 100) / 100,
      memberName(e.payerId), e.toId ? memberName(e.toId) : '',
      { equal: '平均', amount: '指定金額', shares: '份數' }[e.splitMode] || '',
      ...t.members.map((m) => (owed[m.id] != null ? Math.round(toBase(owed[m.id], e.currency, t) * 100) / 100 : '')),
      e.note || '',
    ];
  });
  const csv = [head, ...rows].map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${t.name}-分帳.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- 啟動 ----------
window.addEventListener('hashchange', () => { closeSheet(); render(); });
window.addEventListener('online', () => { S.online = true; render(); if (S.receipts.length) toast(`有 ${S.receipts.length} 張明細可以辨識了`); });
window.addEventListener('offline', () => { S.online = false; render(); });

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
}

boot();
