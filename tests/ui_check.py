# 畫面測試：用 tests/mock 的假 Firebase／AI 跑完整流程並截圖。用法：python3 tests/ui_check.py [輸出資料夾]
import os, sys, subprocess, time
from pathlib import Path
from playwright.sync_api import sync_playwright
from PIL import Image, ImageDraw

REPO = Path(__file__).resolve().parents[1]
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else '/tmp/tripsplit-ui')
OUT.mkdir(parents=True, exist_ok=True)

img = Image.new('RGB', (600, 900), 'white')
d = ImageDraw.Draw(img)
for i, line in enumerate(['RECEIPT', 'Hida beef don 2800', 'Hoba miso 1800', 'Beer x2 800', 'TOTAL 5940']):
    d.text((40, 60 + i * 60), line, fill='black')
receipt = OUT / 'receipt.jpg'
img.save(receipt)

srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8765'], cwd=REPO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
errors = []
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, service_workers='block', locale='zh-TW')
        page = ctx.new_page()
        page.on('console', lambda m: errors.append(f'{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
        page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
        page.route('**/js/firebase.js', lambda r: r.fulfill(path=str(REPO / 'tests/mock/firebase.js'), content_type='application/javascript'))
        page.route('**/js/ai.js', lambda r: r.fulfill(path=str(REPO / 'tests/mock/ai.js'), content_type='application/javascript'))
        # 新增旅行會自動抓匯率：回傳固定的假匯率（測試環境連不到外網）
        for host in ['https://cdn.jsdelivr.net/**', 'https://latest.currency-api.pages.dev/**', 'https://open.er-api.com/**']:
            page.route(host, lambda r: r.fulfill(status=200, content_type='application/json', headers={'Access-Control-Allow-Origin': '*'},
                                                 body='{"date":"2026-12-20","twd":{"jpy":4.7531},"result":"success","rates":{"JPY":4.7531}}'))

        def shot(name):
            page.wait_for_timeout(250)
            page.screenshot(path=str(OUT / f'{name}.png'), full_page=False)

        page.goto('http://localhost:8765/')
        page.wait_for_selector('text=新增旅行')
        shot('01_home')

        page.click('text=＋ 新增旅行')
        page.fill('#nt-name', '2026 日本跨年')
        page.fill('#nt-me', '郁文')
        page.fill('#nt-others', '吳薰')
        shot('02_new_trip')
        page.click('[data-act=nt-create]')
        page.wait_for_selector('text=還沒有開支')
        shot('03_trip_empty')

        page.click('[data-act=add]')
        page.fill('[data-k=title]', '名鐵 ミュースカイ')
        page.fill('[data-k=amount]', '3400')
        page.click('[data-act=cat][data-v=transport]')
        shot('04_editor')
        page.click('[data-act=save-exp]')
        page.wait_for_selector('text=名鐵 ミュースカイ')

        page.click('[data-act=voice]')
        page.fill('#v-text', '晚餐燒肉 6000 日圓 吳薰付 平分')
        page.click('#v-parse')
        page.wait_for_selector('text=離線解析')
        shot('05_voice_parsed')
        page.click('[data-act=save-exp]')
        page.wait_for_selector('text=晚餐燒肉')

        page.click('[data-act=camera]')
        page.set_input_files('#album-input', str(receipt))
        page.wait_for_selector('text=依收據品項分配')
        page.click('[data-act=item-member][data-i="1"] >> nth=1')
        shot('06_receipt_items')
        page.locator('.sheet').evaluate('el => el.scrollTo(0, el.scrollHeight)')
        shot('07_receipt_items_bottom')
        page.click('[data-act=save-exp]')
        page.wait_for_selector('text=飛驒牛 午餐')
        shot('08_list')

        page.click('.tabs a:nth-child(2)')
        page.wait_for_selector('text=建議轉帳')
        shot('09_settle')
        page.on('dialog', lambda dlg: dlg.accept())
        if page.locator('[data-act=record-settle]').count():
            page.click('[data-act=record-settle]')
            page.wait_for_selector('text=大家都打平了')
        shot('10_settled')

        page.click('.tabs a:nth-child(3)')
        shot('11_stats')
        page.click('.tabs a:nth-child(4)')
        shot('12_settings')

        tid = page.evaluate('window.__seedForeignTrip()')
        page.goto(f'http://localhost:8765/#/join/{tid}')
        page.wait_for_selector('text=你是哪一位')
        shot('13_join')
        page.click('text=我是 吳薰')
        page.wait_for_selector('text=還沒有開支')
        shot('14_joined')
        b.close()
finally:
    srv.terminate()
print('\n'.join(errors) or 'no console errors')
