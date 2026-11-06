// Firebase 串接：匿名登入、Firestore（含離線快取）、旅行與開支的讀寫。
// 寫入不等伺服器回應：沒網路時先存在手機，連上網路後 Firestore 會自動同步。
import { firebaseConfig, FIREBASE_SDK } from './config.js';

let fb = null; // { app, auth, db, fs, au }

export async function initFirebase() {
  if (fb) return fb;
  const [appMod, au, fs] = await Promise.all([
    import(`${FIREBASE_SDK}/firebase-app.js`),
    import(`${FIREBASE_SDK}/firebase-auth.js`),
    import(`${FIREBASE_SDK}/firebase-firestore.js`),
  ]);
  const app = appMod.initializeApp(firebaseConfig);
  const auth = au.initializeAuth(app, { persistence: [au.indexedDBLocalPersistence, au.browserLocalPersistence] });
  const db = fs.initializeFirestore(app, {
    localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
  });
  fb = { app, auth, db, fs, au };
  return fb;
}

export function getFb() {
  return fb;
}

// 取得登入使用者；第一次使用會建立匿名帳號（需要網路），之後離線也能用
export function waitForUser() {
  const { auth, au } = fb;
  return new Promise((resolve, reject) => {
    const off = au.onAuthStateChanged(auth, async (user) => {
      if (user) { off(); resolve(user); return; }
      try {
        const cred = await au.signInAnonymously(auth);
        off();
        resolve(cred.user);
      } catch (err) {
        off();
        reject(err);
      }
    });
  });
}

// ---------- Google 帳號備份 ----------

export function accountInfo() {
  const u = fb.auth.currentUser;
  const google = u?.providerData?.find((p) => p.providerId === 'google.com');
  return { uid: u?.uid, isAnonymous: !!u?.isAnonymous, email: google?.email || '' };
}

// 把目前的匿名帳號綁到 Google（uid 不變，旅行與帳目都留著）。
// 這個 Google 帳號若已綁過別的手機，回傳 { status: 'exists', cred }，由畫面詢問要不要改用它。
export async function linkGoogle() {
  const { auth, au } = fb;
  const provider = new au.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    if (auth.currentUser?.isAnonymous) {
      await au.linkWithPopup(auth.currentUser, provider);
      return { status: 'linked' };
    }
    await au.signInWithPopup(auth, provider);
    return { status: 'signed-in' };
  } catch (err) {
    if (err.code === 'auth/credential-already-in-use' || err.code === 'auth/email-already-in-use') {
      return { status: 'exists', cred: au.GoogleAuthProvider.credentialFromError(err) };
    }
    throw err;
  }
}

// 改用已綁過的 Google 帳號（換手機時用）
export async function switchToGoogle(cred) {
  const { auth, au } = fb;
  await au.signInWithCredential(auth, cred);
}

export function newId() {
  const { fs, db } = fb;
  return fs.doc(fs.collection(db, '_ids')).id;
}

function swallow(label) {
  return (err) => console.error(`[${label}]`, err);
}

// ---------- 旅行 ----------

export function watchMyTrips(uid, cb) {
  const { fs, db } = fb;
  const q = fs.query(fs.collection(db, 'trips'), fs.where('memberUids', 'array-contains', uid));
  return fs.onSnapshot(q, { includeMetadataChanges: true }, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data(), _pending: d.metadata.hasPendingWrites })));
  }, swallow('watchMyTrips'));
}

export function watchTrip(tripId, cb, onError) {
  const { fs, db } = fb;
  return fs.onSnapshot(fs.doc(db, 'trips', tripId), { includeMetadataChanges: true }, (d) => {
    cb(d.exists() ? { id: d.id, ...d.data(), _pending: d.metadata.hasPendingWrites, _fromCache: d.metadata.fromCache } : null);
  }, onError || swallow('watchTrip'));
}

export async function getTripOnce(tripId) {
  const { fs, db } = fb;
  const d = await fs.getDoc(fs.doc(db, 'trips', tripId));
  return d.exists() ? { id: d.id, ...d.data() } : null;
}

export function createTrip(uid, { name, baseCurrency, defaultCurrency, rates, memberNames, myIndex = 0 }) {
  const { fs, db } = fb;
  const ref = fs.doc(fs.collection(db, 'trips'));
  const members = memberNames.map((n, i) => ({ id: newId(), name: n.trim(), uid: i === myIndex ? uid : null }));
  const data = {
    name: name.trim(),
    baseCurrency,
    defaultCurrency,
    rates: rates || {},
    members,
    memberUids: [uid],
    createdBy: uid,
    createdAt: fs.serverTimestamp(),
  };
  fs.setDoc(ref, data).catch(swallow('createTrip'));
  return { id: ref.id, meId: members[myIndex].id };
}

export function updateTrip(tripId, patch) {
  const { fs, db } = fb;
  return fs.updateDoc(fs.doc(db, 'trips', tripId), patch).catch(swallow('updateTrip'));
}

// 加入旅行：把自己的 uid 綁到某位成員（memberId），或新增一位成員（newName）
export async function joinTrip(trip, uid, { memberId, newName }) {
  const { fs, db } = fb;
  let members = (trip.members || []).map((m) => ({ ...m }));
  let meId = memberId;
  if (newName) {
    meId = newId();
    members.push({ id: meId, name: newName.trim(), uid });
  } else {
    members = members.map((m) => (m.id === memberId ? { ...m, uid } : m));
  }
  await fs.updateDoc(fs.doc(db, 'trips', trip.id), {
    members,
    memberUids: fs.arrayUnion(uid),
  });
  return meId;
}

export function deleteTrip(tripId) {
  const { fs, db } = fb;
  return fs.deleteDoc(fs.doc(db, 'trips', tripId)).catch(swallow('deleteTrip'));
}

// ---------- 開支 ----------

export function watchExpenses(tripId, cb) {
  const { fs, db } = fb;
  const q = fs.collection(db, 'trips', tripId, 'expenses');
  return fs.onSnapshot(q, { includeMetadataChanges: true }, (snap) => {
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data(), _pending: d.metadata.hasPendingWrites }));
    list.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdMs || 0) - (a.createdMs || 0));
    cb(list, snap.metadata.fromCache);
  }, swallow('watchExpenses'));
}

export function saveExpense(tripId, uid, expense) {
  const { fs, db } = fb;
  const col = fs.collection(db, 'trips', tripId, 'expenses');
  const ref = expense.id ? fs.doc(col, expense.id) : fs.doc(col);
  const { id, _pending, ...data } = expense;
  const now = Date.now();
  const payload = {
    ...data,
    updatedBy: uid,
    updatedMs: now,
    ...(expense.id ? {} : { createdBy: uid, createdMs: now }),
  };
  fs.setDoc(ref, payload, { merge: true }).catch(swallow('saveExpense'));
  return ref.id;
}

export function deleteExpense(tripId, expenseId) {
  const { fs, db } = fb;
  return fs.deleteDoc(fs.doc(db, 'trips', tripId, 'expenses', expenseId)).catch(swallow('deleteExpense'));
}
