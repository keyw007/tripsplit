// 手機本機資料：每趟旅行「我是誰」、沒網路時拍的收據照片佇列（IndexedDB）。

export function getMe(tripId) {
  return localStorage.getItem(`ts_me_${tripId}`);
}

export function setMe(tripId, memberId) {
  localStorage.setItem(`ts_me_${tripId}`, memberId);
}

export function getPref(key, fallback) {
  const v = localStorage.getItem(`ts_pref_${key}`);
  return v === null ? fallback : JSON.parse(v);
}

export function setPref(key, value) {
  localStorage.setItem(`ts_pref_${key}`, JSON.stringify(value));
}

let dbp = null;
function idb() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('tripsplit', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('receipts', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('receipts', mode);
    const store = t.objectStore('receipts');
    const out = fn(store);
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
  });
}

// 待辨識的收據：{ id, tripId, dataUrl, payerId, createdMs, error? }
export function queueReceipt(item) {
  return tx('readwrite', (s) => s.put(item));
}

export async function listReceipts(tripId) {
  const all = await tx('readonly', (s) => s.getAll());
  return (all || []).filter((r) => r.tripId === tripId).sort((a, b) => a.createdMs - b.createdMs);
}

export function removeReceipt(id) {
  return tx('readwrite', (s) => s.delete(id));
}
