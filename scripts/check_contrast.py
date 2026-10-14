#!/usr/bin/env python3
"""Check WCAG AA contrast of the Menapoly Cue design tokens (reads frontend/app/globals.css). Exit 1 on failure."""
import re
import sys
from pathlib import Path

CSS = (Path(__file__).resolve().parents[1] / "frontend/app/globals.css").read_text()


def block(selector: str) -> dict[str, str]:
    body = CSS[CSS.index(selector):]
    body = body[body.index("{") + 1: body.index("}")]
    return dict(re.findall(r"--([\w-]+):\s*(#[0-9A-Fa-f]{6})", body))


def lum(h: str) -> float:
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (1, 3, 5))
    f = lambda c: c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4  # noqa: E731
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)


def ratio(a: str, b: str) -> float:
    hi, lo = sorted((lum(a), lum(b)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)


failed = False
for name, sel in (("dark", ':root, [data-theme="dark"]'), ("light", '[data-theme="light"]')):
    t = block(sel)
    checks = [(fg, bg) for fg in ("text", "muted", "faint", "violet", "ok", "warn", "danger") for bg in ("ink", "panel", "panel2", "panel3")]
    checks += [("on-accent", "accent-strong")]
    for fg, bg in checks:
        r = ratio(t[fg], t[bg])
        if r < 4.5:
            failed = True
        print(f"{name:5} {fg:10} on {bg:13} {r:5.2f} {'ok' if r >= 4.5 else 'FAIL'}")
sys.exit(1 if failed else 0)
