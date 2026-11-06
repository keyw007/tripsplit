# 畫面測試：現金追蹤與自動抓匯率（假 Firebase、模擬匯率 API）。用法：python3 tests/cash_check.py [輸出資料夾]
import sys, subprocess, time, json
from pathlib import Path
from playwright.sync_api import sync_playwright
REPO = Path(__file__).resolve().parents[1]
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else '/tmp/tripsplit-cash'); OUT.mkdir(parents=True, exist_ok=True)
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8770'], cwd=REPO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errors = []
api = {'mode': 'ok'}  # ok：第一個來源 503、第二個成功；fail：全部失敗

def rate_route(route):
    u = route.request.url
    if api['mode'] == 'ok' and 'currency-api.pages.dev' in u:
        return route.fulfill(status=200, content_type='application/json', headers={'Access-Control-Allow-Origin': '*'},
                             body=json.dumps({'date': '2026-12-20', 'twd': {'jpy': 4.7531, 'usd': 0.03081}}))
    return route.fulfill(status=503, body='down', headers={'Access-Control-Allow-Origin': '*'})

try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/opt/pw-browsers/chromium', args=['--no-sandbox'])
        ctx = b.new_context(**p.devices['iPhone 13'], service_workers='block', locale='zh-TW')
        page = ctx.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.route('**/js/firebase.js', lambda r: r.fulfill(path=str(REPO / 'tests/mock/firebase.js'), content_type='application/javascript'))
        page.route('**/js/ai.js', lambda r: r.fulfill(path=str(REPO / 'tests/mock/ai.js'), content_type='application/javascript'))
        for host in ['https://cdn.jsdelivr.net/**', 'https://latest.currency-api.pages.dev/**', 'https://open.er-api.com/**']:
            page.route(host, rate_route)
        def close_sheet():
            page.click('.sheet-bg', position={'x': 20, 'y': 20}); page.wait_for_selector('.sheet-body', state='detached')
        cash_text = lambda: page.inner_text('.cash-card')

        page.goto('http://localhost:8770/'); page.wait_for_selector('text=新增旅行')
        # 1. 新增旅行自動填匯率
        page.click('text=＋ 新增旅行'); page.wait_for_selector('#nt-rate-info:has-text("今天的匯率")', timeout=8000)
        print('1 新增旅行匯率：', page.input_value('#nt-rate'), '｜', page.inner_text('#nt-rate-info'))
        page.fill('#nt-name', '日本'); page.fill('#nt-me', '郁文'); page.fill('#nt-others', '吳薰')
        page.click('[data-act=nt-create]'); page.wait_for_selector('text=還沒有開支')
        print('  開支頁現金卡：', cash_text().replace('\n', ' '))

        # 2. 換匯
        page.click('.cash-card [data-act=cash-in]'); page.fill('#ci-amount', '30000'); page.fill('#ci-cost', '6300')
        print('2 換匯畫面：', page.inner_text('#ci-rate')); page.fill('#ci-note', '機場換匯')
        page.click('[data-act=cash-save-in]'); page.wait_for_selector('.cash-card:has-text("¥30,000")')
        print('  換匯後：', cash_text().split('\n')[1])

        # 3. 現金付款扣、刷卡不扣
        page.click('[data-act=add]'); page.fill('[data-k=title]', '拉麵'); page.fill('[data-k=amount]', '2400')
        page.click('[data-act=pay][data-v=cash]'); page.click('[data-act=save-exp]'); page.wait_for_selector('.cash-card:has-text("¥27,600")')
        page.click('[data-act=add]')
        print('3 再新增時預設付款方式：', page.inner_text('[data-act=pay].on'))
        page.fill('[data-k=title]', '藥妝'); page.fill('[data-k=amount]', '5000')
        page.click('[data-act=pay][data-v=card]'); page.click('[data-act=save-exp]'); page.wait_for_selector('text=藥妝')
        print('  現金付 2400、刷卡 5000 後：', cash_text().split('\n')[1], '｜列表：', page.inner_text('.exp:has-text("拉麵") .s'))

        # 4. 語音「現金」
        page.click('[data-act=voice]'); page.fill('#v-text', '咖啡 500 現金'); page.click('#v-parse'); page.wait_for_selector('#ed-source')
        print('4 語音「咖啡 500 現金」付款方式：', page.inner_text('[data-act=pay].on'))
        page.click('[data-act=save-exp]'); page.wait_for_selector('.cash-card:has-text("¥27,100")')

        # 5. 清點
        page.click('.cash-card [data-act=cash-count]'); page.fill('#cc-counted', '26800')
        print('5 清點：', page.inner_text('#cc-book'), '｜', page.inner_text('#cc-diff'))
        page.click('[data-act=cash-save-count]'); page.wait_for_selector('.cash-card:has-text("¥26,800")')
        page.screenshot(path=str(OUT / '5_list_cash.png'))

        # 6. 結算頁：全部人現金、換匯平均、紀錄
        page.click('text=結算'); page.wait_for_selector('text=💴 現金')
        card = page.locator('.card:has(h2:has-text("💴 現金"))')
        print('6 結算頁現金：', card.inner_text().split('換匯與清點紀錄')[0].replace('\n', ' '))
        card.locator('summary').click(); page.screenshot(path=str(OUT / '6_settle_cash.png'), full_page=True)

        # 7. 設定：抓匯率（第一個來源失敗、第二個成功）→ 套用
        page.click('text=設定'); page.wait_for_selector('[data-act=fetch-rates]')
        print('7 換匯平均提示：', page.locator('[data-act=use-avg-rate]').count() == 1)
        page.click('[data-act=fetch-rates]'); page.wait_for_selector('[data-act=apply-rates]', timeout=8000)
        print('  預覽：', page.inner_text('#rate-preview').split('套用後')[0].replace('\n', ' '))
        page.screenshot(path=str(OUT / '7_rates_preview.png'), full_page=True)
        page.click('[data-act=apply-rates]'); page.wait_for_selector('text=上次自動抓取')
        print('  套用後輸入框：', page.input_value('[data-rate=JPY]'), '｜', page.inner_text('p:has-text("上次自動抓取")'))

        # 8. 全部來源失敗
        api['mode'] = 'fail'
        page.click('[data-act=fetch-rates]'); page.wait_for_selector('#rate-preview .neg', timeout=8000)
        print('8 全部失敗：', page.inner_text('#rate-preview'))

        # 9. 匯出 CSV 有付款方式和現金紀錄
        with page.expect_download() as dl:
            page.click('[data-act=export]')
        csv = Path(dl.value.path()).read_text(encoding='utf-8-sig')
        print('9 CSV：付款方式欄', '付款方式' in csv.splitlines()[0], '｜換匯列', '換匯／領錢' in csv, '｜清點列', '現金清點' in csv)
        ctx.close(); b.close()
        print('OK')
finally:
    srv.terminate()
print('errors:', errors)
