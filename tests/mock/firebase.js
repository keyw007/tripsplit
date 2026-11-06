// 測試用：記憶體版 Firebase，介面和 js/firebase.js 相同，只在本機畫面測試時使用。
const db = { trips: new Map(), expenses: new Map() };
const tripSubs = new Set();
const expSubs = new Set();
const mySubs = new Set();
let seq = 0;
const user = { uid: 'user-me' };

export async function initFirebase() { return { app: {} }; }
export function getFb() { return { app: {} }; }
export async function waitForUser() { return user; }
let linkedEmail = '';
export function accountInfo() { return { uid: user.uid, isAnonymous: !linkedEmail, email: linkedEmail }; }
// 假的 redirect：直接綁好，並讓下一次 finishGoogleRedirect() 回報成功
let redirectPending = false;
export async function linkGoogle() { linkedEmail = 'keyw007@gmail.com'; redirectPending = true; window.dispatchEvent(new HashChangeEvent('hashchange')); }
export async function switchToGoogle() {}
export async function finishGoogleRedirect() { return redirectPending ? (redirectPending = false, { status: 'linked' }) : null; }
export function newId() { seq += 1; return `id${seq}${Math.random().toString(36).slice(2, 6)}`; }

function emitTrips() {
  for (const s of mySubs) s.cb([...db.trips.values()].filter((t) => t.memberUids.includes(s.uid)).map((t) => ({ ...t })));
  for (const s of tripSubs) { const t = db.trips.get(s.id); s.cb(t ? { ...t } : null); }
}
function emitExp(tripId) {
  for (const s of expSubs) {
    if (s.id !== tripId) continue;
    const list = [...(db.expenses.get(tripId)?.values() || [])].map((e) => ({ ...e }));
    list.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdMs || 0) - (a.createdMs || 0));
    s.cb(list, false);
  }
}

export function watchMyTrips(uid, cb) {
  const s = { uid, cb };
  mySubs.add(s);
  setTimeout(emitTrips, 0);
  return () => mySubs.delete(s);
}
export function watchTrip(id, cb) {
  const s = { id, cb };
  tripSubs.add(s);
  setTimeout(() => { const t = db.trips.get(id); cb(t ? { ...t } : null); }, 0);
  return () => tripSubs.delete(s);
}
export async function getTripOnce(id) { const t = db.trips.get(id); return t ? { ...t } : null; }
export function createTrip(uid, { name, baseCurrency, defaultCurrency, rates, memberNames, myIndex = 0 }) {
  const id = newId();
  const members = memberNames.map((n, i) => ({ id: newId(), name: n, uid: i === myIndex ? uid : null }));
  db.trips.set(id, { id, name, baseCurrency, defaultCurrency, rates, members, memberUids: [uid], createdBy: uid, createdAt: { seconds: Date.now() / 1000 } });
  db.expenses.set(id, new Map());
  setTimeout(emitTrips, 0);
  return { id, meId: members[myIndex].id };
}
export function updateTrip(id, patch) {
  Object.assign(db.trips.get(id), patch);
  setTimeout(emitTrips, 0);
  return Promise.resolve();
}
export async function joinTrip(trip, uid, { memberId, newName }) {
  const t = db.trips.get(trip.id);
  let meId = memberId;
  if (newName) { meId = newId(); t.members.push({ id: meId, name: newName, uid }); }
  else t.members = t.members.map((m) => (m.id === memberId ? { ...m, uid } : m));
  if (!t.memberUids.includes(uid)) t.memberUids.push(uid);
  emitTrips();
  return meId;
}
export function deleteTrip(id) { db.trips.delete(id); setTimeout(emitTrips, 0); return Promise.resolve(); }
export function watchExpenses(id, cb) {
  const s = { id, cb };
  expSubs.add(s);
  setTimeout(() => emitExp(id), 0);
  return () => expSubs.delete(s);
}
export function saveExpense(tripId, uid, expense) {
  const map = db.expenses.get(tripId);
  const { id: given, _pending, ...data } = expense;
  const id = given || newId();
  const prev = map.get(id) || { createdMs: Date.now(), createdBy: uid };
  map.set(id, { ...prev, ...data, id, updatedMs: Date.now() });
  setTimeout(() => emitExp(tripId), 0);
  return id;
}
export function deleteExpense(tripId, id) { db.expenses.get(tripId).delete(id); setTimeout(() => emitExp(tripId), 0); return Promise.resolve(); }

// 測試用：塞一個「別人建立」的旅行，用來測邀請連結
window.__seedForeignTrip = () => {
  const id = 'foreignTrip1';
  db.trips.set(id, {
    id, name: '測試邀請', baseCurrency: 'TWD', defaultCurrency: 'JPY', rates: { JPY: 0.21 },
    members: [{ id: 'm1', name: '小明', uid: 'other' }, { id: 'm2', name: '吳薰', uid: null }],
    memberUids: ['other'], createdBy: 'other', createdAt: { seconds: 1 },
  });
  db.expenses.set(id, new Map());
  return id;
};
