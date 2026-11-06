# tripsplit 旅行分帳

離線也能用的多人旅行分帳 PWA。

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

## 測試

```bash
node --test tests/core.test.mjs
```

`tests/mock/` 是畫面測試用的假 Firebase 與假 AI。
