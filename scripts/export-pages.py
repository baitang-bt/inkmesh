#!/usr/bin/env python3
"""Export Inkmesh static site for GitHub Pages (no FastAPI / login)."""

from __future__ import annotations

import json
import re
import shutil
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GAME = ROOT / "app" / "games" / "collab_canvas"
TEMPLATE = GAME / "templates" / "index.html"
OUT = ROOT / "dist" / "pages"
DEPLOY = ROOT / "deploy" / "pages"
BASE_PATH = "/inkmesh"


def read_asset_version() -> str:
    """Read COLLAB_ASSET_VERSION from routes.py."""
    text = (GAME / "routes.py").read_text(encoding="utf-8")
    match = re.search(r'COLLAB_ASSET_VERSION\s*=\s*"([^"]+)"', text)
    return match.group(1) if match else "0"


def expand_macro(html: str, name: str, prefix: str, version: str) -> str:
    """Replace Jinja macro calls like {{ cc('path') }} with versioned URLs."""
    pattern = re.compile(
        r"\{\{\s*" + re.escape(name) + r"\(\s*'([^']+)'\s*\)\s*\}\}"
    )
    return pattern.sub(lambda m: f"{prefix}/{m.group(1)}?v={version}", html)


def render_index(version: str) -> str:
    """Expand the Jinja template into a static HTML document for Pages."""
    html = TEMPLATE.read_text(encoding="utf-8")
    html = re.sub(
        r"\{%\s*macro\s+\w+\(path\)\s*%\}.*?\{%\s*endmacro\s*%\}\s*",
        "",
        html,
        flags=re.S,
    )
    html = expand_macro(html, "cc", f"{BASE_PATH}/static/games/inkmesh", version)
    html = expand_macro(html, "eng", f"{BASE_PATH}/static/packages/ink-engine", version)
    html = expand_macro(html, "net", f"{BASE_PATH}/static/packages/ink-net", version)
    html = html.replace("{{ game.name }}", "Inkmesh")
    html = html.replace('value="{{ initial_room }}"', 'value=""')
    html = re.sub(
        r"window\.COLLAB_BOOT\s*=\s*\{.*?\};",
        'window.COLLAB_BOOT = {\n'
        '      userId: "",\n'
        '      nickname: "Guest",\n'
        '      initialRoom: "",\n'
        f'      basePath: {json.dumps(BASE_PATH)},\n'
        '      staticMode: true\n'
        "    };",
        html,
        count=1,
        flags=re.S,
    )
    # Local template may still point at /static/css/site.css — rewrite for Pages.
    html = html.replace(
        'href="/static/css/site.css"',
        f'href="{BASE_PATH}/static/css/site.css?v={version}"',
    )
    html = html.replace(
        'href="/inkmesh/manifest.webmanifest"',
        f'href="{BASE_PATH}/manifest.webmanifest"',
    )
    html = html.replace(
        'href="/inkmesh/icons/',
        f'href="{BASE_PATH}/icons/',
    )
    return html


def copy_tree(src: Path, dest: Path) -> None:
    """Copy a directory tree, replacing the destination."""
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(src, dest)


def write_png(path: Path, size: int, rgb: tuple[int, int, int] = (26, 26, 26)) -> None:
    """Write a solid-color PNG with a light glyph block (no external deps)."""
    r, g, b = rgb
    rows = []
    for y in range(size):
        row = bytearray([0])  # filter none
        for x in range(size):
            # Simple "I" mark in the center for install icon visibility.
            in_stem = size * 0.28 <= x <= size * 0.42 and size * 0.22 <= y <= size * 0.78
            in_bar = size * 0.28 <= x <= size * 0.72 and (
                size * 0.22 <= y <= size * 0.34 or size * 0.66 <= y <= size * 0.78
            )
            if in_stem or in_bar:
                row.extend((232, 232, 232, 255))
            else:
                row.extend((r, g, b, 255))
        rows.append(bytes(row))
    raw = b"".join(rows)
    compressed = zlib.compress(raw, 9)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", compressed) + chunk(b"IEND", b"")
    path.write_bytes(png)


def main() -> None:
    """Build dist/pages for GitHub Pages deployment."""
    version = read_asset_version()
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)

    copy_tree(GAME / "static", OUT / "static" / "games" / "inkmesh")
    copy_tree(ROOT / "packages" / "ink-engine" / "js", OUT / "static" / "packages" / "ink-engine" / "js")
    copy_tree(ROOT / "packages" / "ink-net" / "js", OUT / "static" / "packages" / "ink-net" / "js")

    css_dir = OUT / "static" / "css"
    css_dir.mkdir(parents=True)
    shutil.copy2(DEPLOY / "site.css", css_dir / "site.css")

    icons_out = OUT / "icons"
    icons_out.mkdir(parents=True)
    shutil.copy2(DEPLOY / "icons" / "icon.svg", icons_out / "icon.svg")
    write_png(icons_out / "icon-192.png", 192)
    write_png(icons_out / "icon-512.png", 512)

    config_src = DEPLOY / "config.json"
    config = json.loads(config_src.read_text(encoding="utf-8"))
    config.setdefault("basePath", BASE_PATH)
    (OUT / "config.json").write_text(
        json.dumps(config, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    manifest = {
        "name": "Inkmesh",
        "short_name": "Inkmesh",
        "description": "多人实时共画",
        "start_url": f"{BASE_PATH}/",
        "scope": f"{BASE_PATH}/",
        "display": "standalone",
        "background_color": "#121212",
        "theme_color": "#1a1a1a",
        "icons": [
            {
                "src": f"{BASE_PATH}/icons/icon-192.png",
                "sizes": "192x192",
                "type": "image/png",
                "purpose": "any",
            },
            {
                "src": f"{BASE_PATH}/icons/icon-512.png",
                "sizes": "512x512",
                "type": "image/png",
                "purpose": "any maskable",
            },
        ],
    }
    (OUT / "manifest.webmanifest").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    sw = f"""/* Inkmesh service worker: cache app shell for offline open / install. */
const CACHE = 'inkmesh-shell-{version}';
const SHELL = [
  '{BASE_PATH}/',
  '{BASE_PATH}/index.html',
  '{BASE_PATH}/manifest.webmanifest',
  '{BASE_PATH}/static/css/site.css?v={version}'
];
const CONFIG_PATH = '{BASE_PATH}/config.json';
const HTML_PATHS = new Set(['{BASE_PATH}/', '{BASE_PATH}/index.html']);

self.addEventListener('install', event => {{
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
}});

self.addEventListener('activate', event => {{
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
}});

self.addEventListener('fetch', event => {{
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith('{BASE_PATH}')) return;
  // config / HTML 导航网络优先，避免壳页长期卡在旧「我的画板」布局。
  const isHtmlNav = req.mode === 'navigate' || HTML_PATHS.has(url.pathname);
  if (url.pathname === CONFIG_PATH || isHtmlNav) {{
    event.respondWith(
      fetch(req).then(res => {{
        if (res && res.ok) {{
          const copy = res.clone();
          caches.open(CACHE).then(cache => cache.put(req, copy));
        }}
        return res;
      }}).catch(() => caches.match(req))
    );
    return;
  }}
  event.respondWith(
    caches.match(req).then(cached => {{
      const fetched = fetch(req).then(res => {{
        if (res && res.ok && url.pathname.match(/\\.(js|css|webmanifest|svg|png|html)$/)) {{
          const copy = res.clone();
          caches.open(CACHE).then(cache => cache.put(req, copy));
        }}
        return res;
      }}).catch(() => cached);
      return cached || fetched;
    }})
  );
}});
"""
    (OUT / "sw.js").write_text(sw, encoding="utf-8")

    index_html = render_index(version)
    (OUT / "index.html").write_text(index_html, encoding="utf-8")
    # SPA deep-link fallback for /inkmesh/<room>
    (OUT / "404.html").write_text(index_html, encoding="utf-8")

    print(f"Exported {OUT} (asset_version={version})")


if __name__ == "__main__":
    main()
