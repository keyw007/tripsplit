# tripsplit 旅行分帳

離線也能用的多人旅行分帳 PWA。

**使用說明**：打開 https://keyw007.github.io/tripsplit/ → 首頁最下面「📖 使用說明」（網址 `#/help`）。

- **離線記帳**：沒網路時記的帳先存在手機，連上網路自動同步（Firestore 離線快取）
- **多人、多趟旅行**：用邀請連結加入，每趟只有成員看得到
- **多幣別**：每筆用當地幣別記，結算時依匯率換成結算幣別
- **語音記帳**：說「午餐拉麵 2400 日圓 吳薰付 平分」自動拆成標題、金額、幣別、支付者、分攤對象；離線用內建規則，有網路時用 Gemini 解析
- **拍明細**：拍收據後 Gemini 自動辨識店名、品項、總額，可以逐項指定由誰分攤，稅金按比例分配；沒網路時照片先存著，有網路再辨識
- **結算**：自動算出最少筆數的轉帳，按「已付款」記一筆轉帳
- **匯出 CSV**：可以匯入 Google 試算表
- **Google 備份**：平常匿名使用；按「連結 Google 帳號」綁定後，換手機用同一個 Google 帳號就能拿回所有旅行

## 架構

純前端，不需要建置工具，直接放在 GitHub Pages。

| 檔案 | 用途 |
|---|---|
| `js/app.js` | 畫面、路由、記帳流程 |
| `js/help.js` | App 內使用說明頁 |
| `js/money.js` | 換匯、分攤、餘額、結算（純函式） |
| `js/parse.js` | 語音／文字離線解析（純函式） |
| `js/firebase.js` | 匿名登入、Google 綁定、Firestore 讀寫 |
| `js/ai.js` | Firebase AI Logic（Gemini）收據與文字辨識 |
| `js/store.js` | 本機設定、待辨識照片佇列（IndexedDB） |
| `sw.js` | 離線殼快取 |
| `firestore.rules` | Firestore 安全規則 |

## Firebase 設定

1. Authentication → 登入方式 → 啟用 **匿名**（Anonymous）和 **Google**
2. Authentication → 設定 → 授權網域 → 加入 `keyw007.github.io`
3. Firestore Database → 建立資料庫（正式環境模式）→ 規則：貼上 `firestore.rules` 內容並發布
4. AI Logic → 開始使用 → Gemini Developer API
5. Google 登入用 redirect，登入元件要和 App 同網域：`keyw007/keyw007.github.io` repo 放 `__/auth/`（用該 repo 的 Action「更新 Firebase 登入元件」從 firebaseapp.com 抓）與 `__/firebase/init.json`，`js/config.js` 的 `authDomain` 設 `keyw007.github.io`
6. Google Cloud → API 和服務 → 憑證 → OAuth 用戶端「Web client (auto created by Google Service)」：重新導向 URI 加 `https://keyw007.github.io/__/auth/handler`，JavaScript 來源加 `https://keyw007.github.io`
7. App Check（AI Logic 自 2026/11/2 起強制）：在 Google Cloud Fraud Defense（舊稱 reCAPTCHA Enterprise）建立網站金鑰（網域 keyw007.github.io、不用核取方塊），在 App Check → 應用程式用 Fraud Defense 註冊網頁 App，再把金鑰填進 `js/config.js` 的 `APP_CHECK.key`

## 測試

```bash
node --test tests/core.test.mjs
python3 tests/ui_check.py /tmp/ui
python3 tests/link_check.py /tmp/link
```

`tests/mock/` 是畫面測試用的假 Firebase 與假 AI。
