# 畫面測試：自動檢查更新（真的 service worker ＋ 假 Firebase）。用法：python3 tests/update_check.py [輸出資料夾]
# 會把 repo 複製到暫存資料夾，在那裡把 APP_VERSION 改成 9.9.9 模擬伺服器有新版。
import sys, subprocess, time, re, shutil, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
SRC = Path(__file__).resolve().parents[1]
REPO = Path(tempfile.mkdtemp()) / 'repo'
shutil.copytree(SRC, REPO, ignore=shutil.ignore_patterns('.git'))
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else '/tmp/tripsplit-update'); OUT.mkdir(parents=True, exist_ok=True)
cfg = REPO / 'js/config.js'; orig = cfg.read_text()
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8768'], cwd=REPO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errors = []
def setup(ctx):
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    ctx.route('**/js/firebase.js', lambda r: r.fulfill(path=str(REPO / 'tests/mock/firebase.js'), content_type='application/javascript'))
    ctx.route('**/js/ai.js', lambda r: r.fulfill(path=str(REPO / 'tests/mock/ai.js'), content_type='application/javascript'))
    return page
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/opt/pw-browsers/chromium', args=['--no-sandbox'])
        # 真的 service worker：先裝好、離線快取
        ctx = b.new_context(**p.devices['iPhone 13'])
        page = setup(ctx)
        page.goto('http://localhost:8768/'); page.wait_for_selector('text=匿名帳號')
        page.evaluate('navigator.serviceWorker.ready'); page.reload(); page.wait_for_selector('text=匿名帳號')
        assert page.evaluate('!!navigator.serviceWorker.controller'), 'SW 沒接管'
        page.wait_for_timeout(3500)
        print('同版本時有提示？', page.locator('#update-bar').count())
        page.click('[data-act=check-update]'); page.wait_for_selector('#toast:has-text("已是最新版")', timeout=5000)
        print('點版本號（同版本）：', page.inner_text('#toast'))
        page.screenshot(path=str(OUT / 'latest_toast.png'))
        # 伺服器換成新版本
        cfg.write_text(re.sub(r"APP_VERSION = '[\d.]+'", "APP_VERSION = '9.9.9'", orig))
        page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")  # 一分鐘內會被略過
        page.wait_for_timeout(500)
        print('一分鐘內重複檢查被略過？', page.locator('#update-bar').count() == 0)
        page.click('[data-act=check-update]')  # 點版本號立刻檢查
        page.wait_for_selector('#update-bar', timeout=5000)
        print('提示文字：', page.inner_text('#update-bar').replace('\n', ' '))
        page.screenshot(path=str(OUT / 'update_bar.png'))
        page.click('[data-upd=later]'); print('稍後後提示消失？', page.locator('#update-bar').count() == 0)
        page.evaluate("window.dispatchEvent(new Event('online'))"); page.wait_for_selector('#update-bar')
        page.click('[data-upd=go]'); page.wait_for_selector('text=匿名帳號')
        print('更新後版本：', re.search(r'v[\d.]+', page.inner_text('main')).group(0))
        # 離線時打開仍正常（快取沒被 vcheck 弄壞）
        ctx.set_offline(True); page.reload(); page.wait_for_selector('text=匿名帳號', timeout=8000)
        print('離線重開正常')
        page.click('[data-act=check-update]'); page.wait_for_selector('#toast:has-text("沒有網路")', timeout=5000)
        print('離線點版本號：', page.inner_text('#toast'))
        ctx.close(); b.close()
finally:
    srv.terminate(); shutil.rmtree(REPO.parent, ignore_errors=True)
print('errors:', errors)
