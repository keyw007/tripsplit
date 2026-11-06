# tripsplit 開發說明（給接手的 Claude 與開發者）

郁文（Nick）自用的旅行分帳 PWA，類似 Tricount。第一個實際用途：2026/12/25–2027/01/03 日本旅行（郁文、吳薰兩人）。之後也想給更多人的旅行用。

- 網址：https://keyw007.github.io/tripsplit/ （GitHub Pages，main 分支根目錄，推上去約 1–2 分鐘生效）
- 回覆使用繁體中文；程式註解、介面文字也用繁體中文。
- commit 直接推 main。

## 需求與已做決定

- **離線優先**：旅途中常沒網路（山上），記帳要能離線，連上網路自動同步 → Firestore 離線快取（`persistentLocalCache`），寫入不 await。
- **語音記帳**：zh-TW 規則解析（`js/parse.js`，離線可用），有網路且開 AI 時改用 Gemini 解析。
- **拍明細自動拆帳**：Gemini 辨識店名、品項、稅、總額；每個品項可指定誰分攤，稅按比例分。離線拍的照片先存 IndexedDB「待辨識」。
- **Firebase**：選它是為了日後多人同步。登入用**匿名**（iOS 主畫面 PWA 的 Google 彈窗不可靠），另有可選的「連結 Google 帳號」做跨手機備份（`linkWithRedirect`，見「改版注意」；Google 帳號已綁過別台時用 `signInWithCredential` 切換）。
- **多幣別**：每筆用當地幣別，結算依 `trip.rates` 換成結算幣別；結算用貪婪法算最少轉帳筆數。
- 沒有建置工具：純 ES modules，Firebase JS SDK 13.2.0 從 gstatic 動態載入。

## 檔案

| 檔案 | 用途 |
|---|---|
| `js/help.js` | 使用說明頁內容（`#/help`）、`platform()`、`isStandalone()`。**改了操作流程或介面文字，要一併更新這裡的說明** |
| `js/app.js` | 畫面、路由（`#/`、`#/help`、`#/join/<id>`、`#/t/<id>/<list\|settle\|stats\|settings>`）、記帳流程；全域狀態 `S`，事件用 `data-act` 統一分派 |
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
- 自動檢查更新（1.3.0 起）：回到前景、每 30 分鐘、重新連網時抓 `js/config.js?vcheck=…`（`sw.js` 對 `vcheck` 不走快取）比對 `APP_VERSION`，較新就在上方顯示「有新版本・更新」，按了才 `location.reload()`。所以 **`APP_VERSION` 的格式要維持 `export const APP_VERSION = 'x.y.z';`**。點首頁、說明頁或旅行設定頁的版本號會立刻檢查（`checkForUpdateNow`），顯示「已是最新版」、沒網路或失敗原因。手機上也可以滑掉 App 重開拿新版。
- `initializeAuth` 必須帶 `popupRedirectResolver`，否則 Google 登入直接丟 `auth/argument-error`。用子類別關掉 `_shouldInitProactively`，避免 iOS 啟動時連網路拖慢離線開 App。畫面測試用 mock，抓不到這類 SDK 設定錯誤。
- 連結 Google 用 **redirect**（`linkWithRedirect` ＋ 啟動時 `getRedirectResult`）。popup 在 iOS 主畫面 App 會開到 Safari，儲存空間不同，App 收不到結果（1.2.6 實測失敗）。redirect 要求登入元件與 App 同網域，所以 `authDomain` 是 `keyw007.github.io`，登入元件放在 `keyw007/keyw007.github.io` repo 的 `__/auth/`，Google Cloud OAuth 用戶端已加轉址 `https://keyw007.github.io/__/auth/handler`。
- App 圖示：原稿 `icons/icon.svg`（行李箱＋日圓硬幣），`icons/icon-maskable.svg` 是縮到 76% 的版本。改完執行 `python3 tools/render_icons.py` 產生 PNG，並把 `index.html`、`manifest.webmanifest` 裡的 `?v=` 加一。iPhone 主畫面圖示是加入當下存下來的，要刪掉主畫面 App 再重新加入才會換。
- AI 速度（1.3.1）：語音用最少思考（Gemini 3 `thinkingLevel: MINIMAL`／2.5 `thinkingBudget: 0`），收據用 `LOW`／`1024`；模型不接受思考設定時拿掉再試一次（`js/ai.js` 的 `thinkingFor`）。打開語音／拍明細畫面時 `warmUpAi()` 先載入 SDK 和 App Check token。記帳畫面標題會顯示花了幾秒（「AI 解析・2.1 秒」）。照片長邊 1600、JPEG 品質 0.72。
- 語音流程（1.3.4）：按解析後**馬上**用離線解析打開記帳畫面（「離線解析・AI 解析中…」），AI 在背景跑，回來後 `sheetEditor` 回傳的 `apply()` 套用；使用者已改過欄位就不覆蓋，改顯示「套用」。實測模型回應 2.4–5.4 秒（準備 0 秒），所以不等 AI。
- iOS 收音（WebKit 已知問題）：`webkitSpeechRecognition` 偶爾 start 後沒有任何事件、也不結束。看門狗：3 秒沒開始就 `abort()`、提示用鍵盤麥克風、這次開 App 期間（`micBroken`）不再顯示收音鈕；一次最多 20 秒；按停止 1.5 秒沒結束就強制停。
- iOS 主畫面 App 與 Safari 分頁的儲存空間是分開的（匿名帳號不同），Google 綁定要在主畫面 App 裡做。

## 測試

```bash
node --test tests/core.test.mjs            # money.js、parse.js 單元測試
python3 tests/ui_check.py /tmp/ui          # 完整畫面流程（tests/mock 假 Firebase／AI）截圖
python3 tests/link_check.py /tmp/link      # 連結 Google 帳號流程
python3 tests/update_check.py /tmp/upd      # 自動檢查更新（真的 service worker）
python3 tests/voice_check.py /tmp/voice    # 語音：先離線再 AI、套用、收音卡住
```

畫面測試用 Playwright 攔截 `js/firebase.js`、`js/ai.js` 換成 `tests/mock/`；新增 firebase.js 匯出函式時，mock 也要加同名函式。

## 目前狀態（2026-11-06）

- 已在 iPhone 主畫面 App 實測成功：建立旅行、記帳、同步、收據辨識（AI＋App Check）、語音 AI 解析、連結 Google 帳號（1.2.7，redirect）、刪掉主畫面 App 重新加入後用同一個 Google 帳號拿回旅行（1.2.8，`credential-already-in-use` → 確認 → 切換帳號）。
- 1.2.9 加了 App 內使用說明（`#/help`）。iPhone 用 Safari 分頁打開時，首頁和邀請加入頁會提醒「先加入主畫面、在主畫面 App 用『用邀請連結加入』貼上」（Safari 分頁和主畫面 App 帳號不同）。
- 尚未實測：邀請連結加入（吳薰的手機）、Android（安裝、語音、拍明細、Google 綁定）。
- 可能的下一步：日幣現金追蹤；匯率自動抓取。
