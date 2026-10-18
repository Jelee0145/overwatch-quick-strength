"""Offline PNG rendering of authenticated website charts; no external image service."""
import asyncio
from pathlib import Path
import re
import time
import uuid
import xml.etree.ElementTree as ET

from .api_client import UserError

def chart_svg(chart):
    if not isinstance(chart, dict) or chart.get("version") != 1 or chart.get("format") != "svg":
        raise UserError("网站未提供图片数据，请更新网站接口")
    svg = chart.get("svg")
    if not isinstance(svg, str) or len(svg.encode()) > 8 * 1024 * 1024 or re.search(r"<!DOCTYPE|<!ENTITY", svg, re.I):
        raise UserError("网站图片数据格式异常")
    try:
        root = ET.fromstring(svg)
        if root.tag != "{http://www.w3.org/2000/svg}svg" or root.get("width") != "1440" or root.get("height") != "1100":
            raise ValueError()
        allowed = {"svg", "defs", "clipPath", "rect", "pattern", "path", "linearGradient", "radialGradient", "stop", "g", "image", "title", "text", "tspan", "line", "circle", "ellipse", "polyline"}
        for node in root.iter():
            if node.tag.removeprefix("{http://www.w3.org/2000/svg}") not in allowed:
                raise ValueError()
            for name, value in node.attrib.items():
                if name.lower().startswith("on") or re.search(r"javascript:|@import|url\(\s*[^#]", value, re.I):
                    raise ValueError()
                if name.endswith("href") and not re.fullmatch(r"data:image/webp;base64,[A-Za-z0-9+/=]+", value):
                    raise ValueError()
    except (ET.ParseError, ValueError):
        raise UserError("网站图片包含不支持的内容") from None
    return svg

class Renderer:
    def __init__(self, directory):
        self.directory = Path(directory).resolve() / "images"
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.directory.chmod(0o700)
        self.browser = self.playwright = None
        self.lock = asyncio.Lock()

    def cleanup(self):
        for file in self.directory.glob("*.png"):
            if re.fullmatch(r"[a-f0-9]{32}\.png", file.name) and not file.is_symlink() and file.resolve().parent == self.directory and file.stat().st_mtime < time.time() - 86400:
                file.unlink()

    async def render(self, chart):
        svg = chart_svg(chart)
        return await self._render_html('<!doctype html><meta charset="utf-8"><style>body{margin:0}svg{font-family:"Noto Sans CJK SC",sans-serif!important}</style>' + svg, 'svg')

    async def render_data(self, detail):
        from .documents import data_document
        return await self._render_html(data_document(detail), '.sheet')

    async def render_review(self, detail, review):
        from .documents import review_documents
        return [await self._render_html(html,'.sheet') for html in review_documents(detail,review)]

    async def _render_html(self, html, selector):
        async with self.lock:
            self.cleanup()
            target = self.directory / (uuid.uuid4().hex + ".png")
            context = None
            try:
                if not self.browser or not self.browser.is_connected():
                    await self._close()
                    from playwright.async_api import async_playwright
                    self.playwright = await async_playwright().start()
                    self.browser = await self.playwright.chromium.launch()
                context = await self.browser.new_context(viewport={"width":1440,"height":1100}, device_scale_factor=1, offline=True, service_workers="block", accept_downloads=False)
                await context.route("**/*", lambda route: route.abort())
                page = await context.new_page()
                await page.set_content(html, timeout=15000)
                await page.evaluate("async () => { await document.fonts.ready; await Promise.all([...document.querySelectorAll('svg image')].map(el => new Promise((resolve,reject) => { const img=new Image();img.onload=resolve;img.onerror=reject;img.src=el.getAttribute('href'); }))); }")
                if await page.locator(selector).evaluate('(el)=>el.getBoundingClientRect().height') > 12000:
                    raise ValueError('Image height limit')
                await page.locator(selector).screenshot(path=str(target), timeout=30000)
                target.chmod(0o600)
                return str(target)
            except asyncio.CancelledError:
                target.unlink(missing_ok=True)
                raise
            except Exception:
                target.unlink(missing_ok=True)
                raise UserError("图片生成失败，请检查 Playwright Chromium 和中文字体") from None
            finally:
                if context:
                    await context.close()

    async def _close(self):
        try:
            if self.browser:
                await self.browser.close()
        finally:
            self.browser = None
            if self.playwright:
                await self.playwright.stop()
                self.playwright = None

    async def close(self):
        async with self.lock:
            await self._close()
