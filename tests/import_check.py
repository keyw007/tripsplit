# 畫面測試：從試算表匯入（假 Firebase、假資料）。用法：python3 tests/import_check.py [輸出資料夾]
import sys, subprocess, time
from pathlib import Path
from playwright.sync_api import sync_playwright
REPO = Path(__file__).resolve().parents[1]
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else '/tmp/tripsplit-import'); OUT.mkdir(parents=True, exist_ok=True)
HEAD = ['日期', '項目', '類別', 'TWD', 'JPY', '約 TWD', '郁文 先付', '吳薰 先付', '付款方式', '狀態', '備註', '各自付']
ROWS = [
    ['', '來回機票 ×2', '機票', '30,000', '¥0', '30,000', 'FALSE', 'TRUE', '台幣刷卡', '已付', '吳薰刷卡', 'FALSE'],
    ['12/25', '測試飯店 名古屋', '住宿', '2,500', '¥0', '2,500', 'TRUE', 'FALSE', '台幣刷卡', '待付', '12/21 扣款', 'FALSE'],
    ['12/26', '測試溫泉飯店', '住宿', '3,000', '¥300', '3,063', 'TRUE', 'FALSE', '台幣刷卡', '待付', '', 'FALSE'],
    ['12/26', '測試特急', '交通', '0', '¥10,000', '2,100', 'FALSE', 'TRUE', '日圓刷卡', '待付', '', 'FALSE'],
    ['1/1', '測試鉱泉', '住宿', '0', '¥40,000', '8,400', 'TRUE', 'FALSE', '日圓現金', '待付', '', 'FALSE'],
    ['12/25', '晚餐', '餐費', '0', '¥2,000', '420', 'FALSE', 'FALSE', '日圓現金', '預估', '', 'FALSE'],
]
TSV = '\n'.join('\t'.join(r) for r in [HEAD] + ROWS)
CSV = '\n'.join(','.join(f'"{c}"' for c in r) for r in [HEAD] + ROWS)
(OUT / 'sheet.csv').write_text(CSV, encoding='utf-8')
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8771'], cwd=REPO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errors = []
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/opt/pw-browsers/chromium', args=['--no-sandbox'])
        ctx = b.new_context(**p.devices['iPhone 13'], service_workers='block', locale='zh-TW')
        page = ctx.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.route('**/js/firebase.js', lambda r: r.fulfill(path=str(REPO / 'tests/mock/firebase.js'), content_type='application/javascript'))
        page.route('**/js/ai.js', lambda r: r.fulfill(path=str(REPO / 'tests/mock/ai.js'), content_type='application/javascript'))
        for host in ['https://cdn.jsdelivr.net/**', 'https://latest.currency-api.pages.dev/**', 'https://open.er-api.com/**']:
            page.route(host, lambda r: r.fulfill(status=200, content_type='application/json', headers={'Access-Control-Allow-Origin': '*'},
                                                 body='{"date":"2026-12-20","twd":{"jpy":4.7531}}'))
        page.goto('http://localhost:8771/'); page.wait_for_selector('text=新增旅行')
        page.click('text=＋ 新增旅行'); page.fill('#nt-name', '日本'); page.fill('#nt-me', '郁文'); page.fill('#nt-others', '吳薰')
        page.click('[data-act=nt-create]'); page.wait_for_selector('text=還沒有開支')

        # 1. 空白開支頁的入口 → 貼上
        page.click('.empty [data-act=import]'); page.fill('#im-text', TSV); page.click('[data-act=im-read]')
        page.wait_for_selector('text=確認要匯入的開支')
        rows = page.locator('.im-row')
        print('1 讀到', rows.count(), '筆；按鈕：', page.inner_text('[data-act=im-save]'))
        for i in range(rows.count()):
            r = rows.nth(i)
            print('  ', '☑' if r.locator('input').is_checked() else '☐', r.inner_text().replace('\n', '｜'))
        page.screenshot(path=str(OUT / '1_review.png'), full_page=True)

        # 2. 取消一筆、勾一筆沒付款人的（要選付款人才能匯入）
        page.locator('.im-row:has-text("測試特急") input').uncheck()
        page.locator('.im-row:has-text("晚餐") input').check()
        page.click('[data-act=im-save]'); page.wait_for_selector('#toast:has-text("還沒選誰付")')
        print('2 沒選付款人：', page.inner_text('#toast'))
        page.locator('.im-row:has-text("晚餐") select').select_option(label='吳薰')
        print('  按鈕：', page.inner_text('[data-act=im-save]'))
        page.click('[data-act=im-save]'); page.wait_for_selector('#toast:has-text("已匯入")')
        print('  ', page.inner_text('#toast'))
        page.wait_for_selector('text=測試飯店 名古屋')
        print('  列表：', ' / '.join(page.locator('.exp .t').all_inner_texts()))
        print('  晚餐付款人與方式：', page.inner_text('.exp:has-text("晚餐") .s'))

        # 3. 用 CSV 檔再匯入一次：已匯入的標示重複、不勾
        page.click('text=設定'); page.click('[data-act=import]')
        page.set_input_files('#im-file', str(OUT / 'sheet.csv')); page.wait_for_selector('text=確認要匯入的開支')
        dups = page.locator('.im-row:has-text("已經匯入過")').count()
        print('3 CSV 再匯入：標示已經匯入過', dups, '筆；按鈕：', page.inner_text('[data-act=im-save]'))
        page.screenshot(path=str(OUT / '3_dups.png'), full_page=True)

        # 4. 沒有標題列
        page.click('.sheet-bg', position={'x': 20, 'y': 20})
        page.click('[data-act=import]'); page.fill('#im-text', '\n'.join('\t'.join(r) for r in ROWS)); page.click('[data-act=im-read]')
        page.wait_for_selector('#toast:has-text("標題列")'); print('4 沒標題列：', page.inner_text('#toast'))
        ctx.close(); b.close()
        print('OK')
finally:
    srv.terminate()
print('errors:', errors)
