#!/usr/bin/env python3
"""Local server for the Studio preview, used by the Playwright tests and for trying it on a laptop.

Serves studio-preview/ and wraps index.html in the same minimal skeleton the artifact host adds (doctype, charset,
viewport with viewport-fit=cover, small reset), so local runs match the published preview.

    python3 studio-preview/tools/serve.py --port 8799
"""
from __future__ import annotations

import argparse
import functools
import http.server
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKELETON = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>
</head><body>
{body}
</body></html>"""


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        if self.path.split("?")[0] in ("/", "/index.html"):
            body = SKELETON.replace("{body}", (ROOT / "index.html").read_text()).encode()
            self.send_response(200)
            self.send_header("content-type", "text/html; charset=utf-8")
            self.send_header("content-length", str(len(body)))
            self.send_header("cache-control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def log_message(self, *args):  # quiet
        pass


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8799)
    ap.add_argument("--host", default="127.0.0.1")
    a = ap.parse_args()
    http.server.ThreadingHTTPServer((a.host, a.port), functools.partial(Handler, directory=str(ROOT))).serve_forever()


if __name__ == "__main__":
    main()
