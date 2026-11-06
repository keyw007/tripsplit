// 使用說明頁（#/help）。純文字內容，依手機平台把對應的安裝步驟預設展開。

export function platform() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'other';
}

export function isStandalone() {
  return navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
}

const APP_URL = 'https://keyw007.github.io/tripsplit/';

function section(title, body, open = false) {
  return `<details class="card help"${open ? ' open' : ''}><summary>${title}</summary><div class="help-body">${body}</div></details>`;
}

export function helpHtml() {
  const p = platform();
  return [
    section('📲 安裝到手機', `
      <p>旅行分帳是網頁 App，不用到 App Store／Play 商店下載。加入主畫面後就像一般 App，沒網路也能打開。</p>
      <h4>iPhone</h4>
      <ol>
        <li>用 <b>Safari</b> 打開 <span class="mono">${APP_URL}</span></li>
        <li>按下方的<b>分享</b>鈕（方框加向上箭頭）→ <b>加入主畫面</b></li>
        <li>之後都從主畫面的「旅行分帳」打開</li>
      </ol>
      <p class="note">⚠️ iPhone 上，Safari 分頁和主畫面 App 的資料是<b>分開的</b>，是兩個不同的帳號。請一開始就加入主畫面，之後只用主畫面 App，不要兩邊混用。</p>
      <h4>Android</h4>
      <ol>
        <li>用 <b>Chrome</b> 打開 <span class="mono">${APP_URL}</span></li>
        <li>按右上角 <b>⋮</b> → <b>安裝應用程式</b>或<b>加到主畫面</b>（有時畫面下方會直接跳出安裝提示）</li>
        <li>之後從主畫面的「旅行分帳」打開</li>
      </ol>
      <p class="muted small">Android 請用 Chrome。其他瀏覽器沒有測試過，Firefox 不能直接收音。</p>`, p !== 'other'),

    section('🧳 開始一趟旅行', `
      <h4>自己建立</h4>
      <p>首頁按 <b>＋ 新增旅行</b>，輸入旅行名稱、你的名字、旅伴名字、幣別和匯率。</p>
      <h4>邀請旅伴</h4>
      <p>進入旅行 → <b>⚙️ 設定</b> → <b>邀請旅伴</b> → 分享連結（例如傳 LINE）。拿到連結的人都能加入，請只傳給旅伴。</p>
      <h4>用邀請連結加入</h4>
      <ol>
        <li>先照「安裝到手機」把 App 加入主畫面</li>
        <li>長按旅伴傳來的連結 → <b>複製</b></li>
        <li>從主畫面打開旅行分帳 → 首頁按 <b>用邀請連結加入</b> → 貼上</li>
        <li>選「我是 ○○」，就能一起記帳</li>
      </ol>
      <p class="note">iPhone 上直接點連結，會在 LINE 或 Safari 裡打開，不會進主畫面 App。在那裡加入的話，主畫面 App 看不到這趟旅行，所以請用上面「複製 → 貼上」的方式。</p>
      <h4>設定「我是誰」</h4>
      <p>每支手機要在 <b>⚙️ 設定 → 我是</b> 選自己，語音記帳的「我付」「只算我」才知道是誰。</p>`),

    section('🧾 記帳', `
      <p>旅行畫面下方有三個按鈕：</p>
      <h4>＋ 新增</h4>
      <p>手動輸入標題、金額、幣別、誰付的、類別，再選分攤方式：</p>
      <ul>
        <li><b>平均</b>：勾選的人平分</li>
        <li><b>指定金額</b>：每個人各自負擔多少</li>
        <li><b>份數</b>：例如大人 2 份、小孩 1 份</li>
      </ul>
      <p>上方切到<b>轉帳還款</b>，可以記錄誰還了誰錢。</p>
      <h4>🎤 語音</h4>
      <p>按「● 開始收音」說一句話，再按<b>解析</b>，會自動填好記帳畫面，確認後儲存。例如：</p>
      <ul class="examples">
        <li>午餐拉麵 2400 日圓 吳薰付 平分</li>
        <li>伴手禮 1580 台幣 我付 只算我</li>
        <li>昨天晚餐燒肉兩千四百塊 郁文先付</li>
        <li>巴士 2000（沒講誰付就是我、沒講幣別用預設幣別）</li>
        <li>門票 1400 小明付 只有小明和吳薰</li>
      </ul>
      <p>名字換成你們旅伴的名字。有網路時用 AI 解析，比較聽得懂口語；沒網路時用手機內建規則解析。記帳畫面標題旁會顯示是「AI 解析」還是「離線解析」。</p>
      <p class="muted small">按「開始收音」沒反應時，可以點輸入框，用鍵盤上的麥克風說話。</p>
      <h4>📷 拍明細</h4>
      <p>拍收據或明細，AI 會辨識店名、品項和總額。每個品項可以指定由誰分攤，稅金按比例分配。</p>
      <p>沒網路時照片會先存在「待辨識」，有網路後再辨識，或改成手動輸入。</p>`),

    section('📶 沒有網路時', `
      <ul>
        <li>可以照常打開 App、記帳、修改、看結算</li>
        <li>上方會顯示「離線・N 筆待同步」，連上網路後自動同步，不用做任何事</li>
        <li>語音改用離線解析；拍明細的照片先存起來</li>
        <li>建立旅行可以離線；加入別人的旅行、綁定 Google 需要網路</li>
      </ul>
      <p class="note">記完帳後，盡量在有網路的地方打開一次 App，讓資料同步上去。還沒同步的資料只存在這支手機。</p>`),

    section('💱 幣別與匯率', `
      <p>每一筆用當地付款的幣別記（例如日圓），結算時再依匯率換成<b>結算幣別</b>（例如台幣）。</p>
      <p>匯率在 <b>⚙️ 設定 → 旅行 → 匯率</b> 調整，填「1 外幣 = 多少結算幣別」，例如 1 JPY = 0.21 TWD。改匯率後，所有開支會一起重新換算。</p>
      <p class="muted small">還沒設匯率的幣別會先用 1:1 計算，開支列表上方會提醒。</p>`),

    section('⚖️ 結算', `
      <p><b>⚖️ 結算</b> 頁會列出每個人的餘額：正數是別人欠他，負數是他欠別人。</p>
      <p>下方是建議的轉帳方式（用最少筆數讓大家打平）。實際付錢後按 <b>已付款</b>，會記一筆轉帳，餘額就會歸零。</p>
      <p><b>📊 統計</b> 頁可以看各類別、每人、每天的花費。<b>⚙️ 設定 → 匯出 CSV</b> 可以匯入 Google 試算表。</p>`),

    section('🔐 換手機與備份', `
      <p>平常不用登入。帳目存在雲端，同一趟旅行的成員都看得到。</p>
      <p>建議到首頁的<b>帳號</b>區按 <b>連結 Google 帳號</b>。綁定後，換手機或刪掉 App 時：</p>
      <ol>
        <li>在新手機加入主畫面、打開 App</li>
        <li>按 <b>連結 Google 帳號</b>，選同一個 Google 帳號</li>
        <li>出現「這個 Google 帳號已經綁過另一個 tripsplit 帳號」時按<b>好</b>，原本的旅行就會回來</li>
      </ol>
      <p class="muted small">iPhone 請在主畫面 App 裡綁定，不要在 Safari 分頁綁定。沒綁 Google 也沒關係，可以請旅伴再傳一次邀請連結，加入時選「我是 ○○（換手機或重新加入）」。</p>`),

    section('❓ 常見問題', `
      <h4>怎麼更新？</h4>
      <p>App 有網路時會自動檢查，有新版本時畫面上方會出現「有新版本」，按<b>更新</b>就好。首頁最下面可以看目前的版本號。</p>
      <p class="muted small">如果一直沒出現，從多工畫面把 App 滑掉、重新打開也會拿到新版。</p>
      <h4>看不到旅伴記的帳？</h4>
      <p>看上方是不是「離線」或「同步中」。雙方都要連上網路打開 App，資料才會同步。</p>
      <h4>首頁看不到旅行？</h4>
      <p>iPhone 請確認是從主畫面 App 打開，而不是 Safari 分頁。換過手機的話，照「換手機與備份」拿回來。</p>`),
  ].join('');
}
