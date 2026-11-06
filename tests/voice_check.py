# 畫面測試：語音記帳（先顯示離線解析、AI 在背景補上；Android 收音卡住的處理；iPhone 改用鍵盤麥克風）。用法：python3 tests/voice_check.py [輸出資料夾]
import sys, subprocess, time
from pathlib import Path
from playwright.sync_api import sync_playwright
REPO = Path(__file__).resolve().parents[1]
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else '/tmp/tripsplit-voice'); OUT.mkdir(parents=True, exist_ok=True)
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8769'], cwd=REPO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errors = []

# 假的語音辨識：hang=True 時 start() 之後什麼事件都不發生（模擬 iPhone 卡住）
FAKE_SR = """
window.__srMode = 'ok';
window.webkitSpeechRecognition = class {
  start() {
    window.__srStarts = (window.__srStarts || 0) + 1;
    if (window.__srMode === 'hang') return;
    setTimeout(() => this.onstart?.(), 50);
    setTimeout(() => this.onresult?.({ results: [[{ transcript: '咖啡 500 日圓 我付 只算我' }]] }), 150);
    setTimeout(() => this.onend?.(), 250);
  }
  stop() {} abort() { window.__srAborts = (window.__srAborts || 0) + 1; }
};
window.SpeechRecognition = window.webkitSpeechRecognition;
"""
AI_RESULT = {'title': '一蘭拉麵', 'amount': 2400, 'currency': 'JPY', 'payerName': '吳薰', 'participantNames': [], 'category': 'food', 'date': '2026-12-26'}
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/opt/pw-browsers/chromium', args=['--no-sandbox'])
        ctx = b.new_context(**p.devices['Pixel 7'], service_workers='block', locale='zh-TW')
        ctx.add_init_script(FAKE_SR)
        page = ctx.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.route('**/js/firebase.js', lambda r: r.fulfill(path=str(REPO / 'tests/mock/firebase.js'), content_type='application/javascript'))
        page.route('**/js/ai.js', lambda r: r.fulfill(path=str(REPO / 'tests/mock/ai.js'), content_type='application/javascript'))
        def close_sheet():
            page.click('.sheet-bg', position={'x': 20, 'y': 20})
            page.wait_for_selector('.sheet-body', state='detached')

        page.goto('http://localhost:8769/'); page.wait_for_selector('text=新增旅行')
        page.click('text=＋ 新增旅行'); page.fill('#nt-name', 'T'); page.fill('#nt-me', '郁文'); page.fill('#nt-others', '吳薰')
        page.click('[data-act=nt-create]'); page.wait_for_selector('text=還沒有開支')

        # 1. 正常收音
        page.click('[data-act=voice]'); page.click('#v-mic')
        page.wait_for_function("document.querySelector('#v-text').value.includes('咖啡')")
        page.wait_for_function("document.querySelector('#v-mic').textContent.includes('開始收音')")
        print('1 正常收音：', page.input_value('#v-text'))
        close_sheet()

        # 2. AI 慢：馬上顯示離線解析，AI 回來後自動換成 AI 結果
        page.evaluate(f"window.__mockVoiceAi = {{ delay: 1500, result: {AI_RESULT!r} }}".replace("'", '"'))
        page.click('[data-act=voice]'); page.fill('#v-text', '拉麵 2400 日圓 吳薰付 平分')
        t0 = time.time(); page.click('#v-parse'); page.wait_for_selector('#ed-source')
        print('2 打開記帳畫面花了 %.2f 秒，標示：%s，標題：%s' % (time.time() - t0, page.inner_text('#ed-source'), page.input_value('[data-k=title]')))
        page.screenshot(path=str(OUT / '2a_offline_first.png'))
        page.wait_for_selector('#ed-source:has-text("AI 解析・")', timeout=5000)
        print('  AI 回來後標示：%s，標題：%s' % (page.inner_text('#ed-source'), page.input_value('[data-k=title]')))
        page.screenshot(path=str(OUT / '2b_ai_applied.png'))
        close_sheet()

        # 3. AI 回來前已經改了標題：不覆蓋，顯示「套用」
        page.click('[data-act=voice]'); page.fill('#v-text', '拉麵 2400 日圓 吳薰付 平分')
        page.click('#v-parse'); page.wait_for_selector('#ed-source')
        page.fill('[data-k=title]', '我自己改的標題')
        page.wait_for_selector('[data-act=ai-apply]', timeout=5000)
        print('3 改過後 AI 回來，標題仍是：%s，出現套用按鈕' % page.input_value('[data-k=title]'))
        page.screenshot(path=str(OUT / '3_apply_banner.png'))
        page.click('[data-act=ai-apply]')
        print('  按套用後標題：%s' % page.input_value('[data-k=title]'))
        close_sheet()

        # 4. AI 失敗：保留離線解析並提示
        page.evaluate("window.__mockVoiceAi = null")
        page.click('[data-act=voice]'); page.fill('#v-text', '巴士 2000')
        page.click('#v-parse'); page.wait_for_selector('#toast:has-text("AI 解析失敗")', timeout=5000)
        print('4 AI 失敗：標示 %s；提示 %s' % (page.inner_text('#ed-source'), page.inner_text('#toast')))
        close_sheet()

        # 5. 收音卡住：3 秒後自動停掉、提示用鍵盤麥克風、這次開 App 期間不再顯示收音鈕
        page.evaluate("window.__srMode = 'hang'")
        page.click('[data-act=voice]'); page.click('#v-mic')
        page.wait_for_selector('#toast:has-text("收音沒有反應")', timeout=6000)
        print('5 卡住：提示「%s」，收音鈕還在？%s，abort 次數 %s' % (page.inner_text('#toast'), page.locator('#v-mic').count() > 0, page.evaluate('window.__srAborts')))
        page.screenshot(path=str(OUT / '5_mic_hung.png'))
        close_sheet()
        page.click('[data-act=voice]')
        print('  再打開語音：收音鈕？%s；說明：%s' % (page.locator('#v-mic').count() > 0, '鍵盤上的麥克風' in page.inner_text('.sheet-body')))
        ctx.close()

        # 6. iPhone：沒有收音鈕、輸入框直接 focus（鍵盤會跳出）、照樣能解析
        ctx = b.new_context(**p.devices['iPhone 13'], service_workers='block', locale='zh-TW')
        ctx.add_init_script(FAKE_SR)
        page = ctx.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.route('**/js/firebase.js', lambda r: r.fulfill(path=str(REPO / 'tests/mock/firebase.js'), content_type='application/javascript'))
        page.route('**/js/ai.js', lambda r: r.fulfill(path=str(REPO / 'tests/mock/ai.js'), content_type='application/javascript'))
        page.goto('http://localhost:8769/'); page.wait_for_selector('text=新增旅行')
        page.click('text=＋ 新增旅行'); page.fill('#nt-name', 'T'); page.fill('#nt-me', '郁文'); page.fill('#nt-others', '吳薰')
        page.click('[data-act=nt-create]'); page.wait_for_selector('text=還沒有開支')
        page.click('[data-act=voice]'); page.wait_for_selector('#v-text')
        print('6 iPhone：收音鈕？%s；輸入框已 focus？%s；有取消鈕？%s；SR 被呼叫次數 %s' % (
            page.locator('#v-mic').count() > 0, page.evaluate("document.activeElement?.id") == 'v-text',
            page.locator('.sheet-body [data-act=close]').count() > 0, page.evaluate('window.__srStarts || 0')))
        page.screenshot(path=str(OUT / '6_ios_voice.png'))
        page.keyboard.type('咖啡 500 日圓 我付 只算我'); page.click('#v-parse'); page.wait_for_selector('#ed-source')
        print('  解析後：%s，金額 %s' % (page.inner_text('#ed-source'), page.input_value('[data-k=amount]')))
        ctx.close(); b.close()
        print('OK')
finally:
    srv.terminate()
print('errors:', errors)
