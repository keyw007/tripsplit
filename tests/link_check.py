# 畫面測試：連結 Google 帳號流程（假 Firebase）。用法：python3 tests/link_check.py [輸出資料夾]
import sys, subprocess, time
from pathlib import Path
from playwright.sync_api import sync_playwright
REPO = Path(__file__).resolve().parents[1]; OUT = Path(sys.argv[1] if len(sys.argv) > 1 else '/tmp/tripsplit-ui'); OUT.mkdir(parents=True, exist_ok=True)
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8765'], cwd=REPO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errors = []
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=1, service_workers='block')
        page = ctx.new_page()
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.route('**/js/firebase.js', lambda r: r.fulfill(path=str(REPO / 'tests/mock/firebase.js'), content_type='application/javascript'))
        page.route('**/js/ai.js', lambda r: r.fulfill(path=str(REPO / 'tests/mock/ai.js'), content_type='application/javascript'))
        # 新增旅行會自動抓匯率：回傳固定的假匯率（測試環境連不到外網）
        for host in ['https://cdn.jsdelivr.net/**', 'https://latest.currency-api.pages.dev/**', 'https://open.er-api.com/**']:
            page.route(host, lambda r: r.fulfill(status=200, content_type='application/json', headers={'Access-Control-Allow-Origin': '*'},
                                                 body='{"date":"2026-12-20","twd":{"jpy":4.7531},"result":"success","rates":{"JPY":4.7531}}'))
        page.goto('http://localhost:8765/'); page.wait_for_selector('text=匿名帳號')
        page.screenshot(path=str(OUT / 'a_home.png'), full_page=True)
        page.click('[data-act=link-google]'); page.wait_for_selector('text=已綁定 Google')
        page.screenshot(path=str(OUT / 'b_linked.png'), full_page=True)
        page.click('text=＋ 新增旅行'); page.fill('#nt-name', 'X'); page.fill('#nt-me', '郁文'); page.fill('#nt-others', '吳薰')
        page.click('[data-act=nt-create]'); page.wait_for_selector('text=還沒有開支')
        page.goto(page.url.replace('/list', '/settings')); page.wait_for_selector('text=已綁定 Google')
        print('OK')
        b.close()
finally:
    srv.terminate()
print('errors:', errors)
