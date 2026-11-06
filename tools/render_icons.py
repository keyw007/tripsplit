# 從 icons/icon.svg 重新產生 App 圖示 PNG。用法：python3 tools/render_icons.py
# icon-maskable.svg 是同一張圖縮到 76%（Android 會裁成圓形，要留安全邊界），改 icon.svg 時一起改。
import pathlib
from playwright.sync_api import sync_playwright
from PIL import Image

d = pathlib.Path(__file__).resolve().parents[1] / 'icons'
jobs = [('icon.svg', 180, 'apple-touch-icon.png'), ('icon.svg', 192, 'icon-192.png'),
        ('icon.svg', 512, 'icon-512.png'), ('icon-maskable.svg', 512, 'icon-maskable-512.png')]
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/opt/pw-browsers/chromium', args=['--no-sandbox'])
    for src, size, out in jobs:
        html = d / f'_render_{size}.html'
        html.write_text(f'<html><body style="margin:0"><img src="{src}" style="width:{size}px;height:{size}px;display:block"></body></html>')
        pg = b.new_page(viewport={'width': size, 'height': size})
        pg.goto(html.as_uri())
        pg.wait_for_function('document.images[0].complete && document.images[0].naturalWidth > 0')
        pg.screenshot(path=str(d / out))
        pg.close()
        html.unlink()
        Image.open(d / out).convert('RGB').save(d / out, optimize=True)  # iOS 圖示不要透明
        print(out, size)
    b.close()
