# tripsplit 開發說明（給接手的 Claude 與開發者）

郁文（Nick）自用的旅行分帳 PWA，類似 Tricount。第一個實際用途：2026/12/25–2027/01/03 日本旅行（郁文、吳薰兩人）。之後也想給更多人的旅行用。

- 網址：https://keyw007.github.io/tripsplit/ （GitHub Pages，main 分支根目錄，推上去約 1–2 分鐘生效）
- 回覆使用繁體中文；程式註解、介面文字也用繁體中文。
- commit 直接推 main。

## 需求與已做決定

- **離線優先**：旅途中常沒網路（山上），記帳要能離線，連上網路自動同步 → Firestore 離線快取（`persistentLocalCache`），寫入不 await。
- **語音記帳**：zh-TW 規則解析（`js/parse.js`，離線可用），有網路且開 AI 時改用 Gemini 解析。
- **拍明細自動拆帳**：Gemini 辨識店名、品項、稅、總額；每個品項可指定誰分攤，稅按比例分。離線拍的照片先存 IndexedDB「待辨識」。
- **Firebase**：選它是為了日後多人同步。登入用**匿名**（iOS 主畫面 PWA 的 Google 彈窗不可靠），另有可選的「連結 Google 帳號」做跨手機備份（`linkWithPopup`；Google 帳號已綁過別台時用 `signInWithCredential` 切換）。
- **多幣別**：每筆用當地幣別，結算依 `trip.rates` 換成結算幣別；結算用貪婪法算最少轉帳筆數。
- 沒有建置工具：純 ES modules，Firebase JS SDK 13.2.0 從 gstatic 動態載入。

## 檔案

| 檔案 | 用途 |
|---|---|
| `js/app.js` | 畫面、路由（`#/`、`#/join/<id>`、`#/t/<id>/<list\|settle\|stats\|settings>`）、記帳流程；全域狀態 `S`，事件用 `data-act` 統一分派 |
| `js/money.js` | 換匯、分攤（equal/amount/shares）、餘額、結算、收據拆分（純函式，有單元測試） |
| `js/parse.js` | 語音／文字離線解析（純函式，有單元測試） |
| `js/firebase.js` | 匿名登入、Google 綁定、Firestore 讀寫 |
| `js/ai.js` | Firebase AI Logic（Gemini Developer API）＋ App Check；模型依序嘗試 `AI_MODELS` |
| `js/store.js` | localStorage 設定、IndexedDB 待辨識照片佇列 |
| `js/config.js` | Firebase 設定、`APP_CHECK` 金鑰、`AI_MODELS`、`APP_VERSION` |
| `sw.js` | 離線殼：App 檔案網路優先（`cache: 'no-cache'`）、SDK 快取優先 |
| `firestore.rules` | 安全規則：成員（`memberUids`）才能讀寫帳；非成員只能把自己加入 |

## Firebase 專案（tripsplit-86d7e，Spark 免費方案）— 已全部設定完成

- Authentication：匿名 ＋ Google 已啟用；授權網域含 `keyw007.github.io`
- Firestore：asia-east1，正式環境模式，規則＝`firestore.rules`（改規則後要提醒使用者到主控台重新貼上發布）
- AI Logic：Gemini Developer API；AI 監控關閉
- **App Check**：Firebase AI Logic 自 2026/11/2 起**強制** App Check。用 Fraud Defense（舊稱 reCAPTCHA Enterprise）`ReCaptchaEnterpriseProvider`，金鑰建在 tripsplit-86d7e 這個 Google Cloud 專案裡（`js/config.js` 的 `APP_CHECK.key`）。
  - 傳統版 reCAPTCHA v3 已淘汰，不要用。
  - 從 google.com/recaptcha/admin 建的金鑰會落在別的 Cloud 專案 → `appCheck/initial-throttle`。金鑰必須在 tripsplit-86d7e 建。
  - 只對 AI Logic 強制；Firestore／Auth **不要**強制（會影響離線）。

## 改版注意

- 每次改動要同時調高 `js/config.js` 的 `APP_VERSION` 與 `sw.js` 的 `VERSION`，首頁最下面會顯示版本，方便確認手機拿到新版。
- iPhone 主畫面 App 要「滑掉重開兩次」才會用到新版（第一次在背景更新）。
- iOS 主畫面 App 與 Safari 分頁的儲存空間是分開的（匿名帳號不同），Google 綁定要在主畫面 App 裡做。

## 測試

```bash
node --test tests/core.test.mjs            # money.js、parse.js 單元測試
python3 tests/ui_check.py /tmp/ui          # 完整畫面流程（tests/mock 假 Firebase／AI）截圖
python3 tests/link_check.py /tmp/link      # 連結 Google 帳號流程
```

畫面測試用 Playwright 攔截 `js/firebase.js`、`js/ai.js` 換成 `tests/mock/`；新增 firebase.js 匯出函式時，mock 也要加同名函式。

## 目前狀態（2026-11-06）

- 已在 iPhone 實測：建立旅行、記帳、同步、收據辨識（AI＋App Check）成功。
- 尚未實測：語音 AI 解析、連結 Google 帳號（iOS 主畫面 App 彈窗是否能回到 App）、邀請連結加入。
- 可能的下一步：若 iOS 彈窗不行，改用 `linkWithRedirect`；日幣現金追蹤；匯率自動抓取。
