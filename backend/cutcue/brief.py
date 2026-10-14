"""Creative Brief Intelligence: turn client briefs into structured requirements and check edits
against them. Deterministic and local (labelled lines, bullets, quoted phrases, deliverable
phrases); Claude can refine the result through its ``set_brief_requirements`` tool.

Brief text is untrusted data: it is parsed, never executed or followed as instructions.
"""
from __future__ import annotations

import re
from typing import Any

NUMBER_WORDS = {"a": 1, "an": 1, "one": 1, "single": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
                "seven": 7, "eight": 8, "nine": 9, "ten": 10, "a couple of": 2, "a pair of": 2}
LABELS = {
    "client": ["client", "brand", "company", "customer"],
    "goals": ["goal", "goals", "objective", "objectives", "purpose", "aim"],
    "audience": ["audience", "target audience", "viewers", "target"],
    "tone": ["tone", "style", "voice", "mood", "feel"],
    "deliverables": ["deliverables", "deliverable", "outputs", "assets", "formats", "we need"],
    "key_messages": ["key message", "key messages", "messaging", "message", "takeaway", "takeaways", "talking points"],
    "must_include": ["must include", "include", "must mention", "mention", "feature", "must show", "highlight"],
    "must_avoid": ["avoid", "must avoid", "do not", "don't", "dont", "do not mention", "don't mention", "exclude",
                   "never", "no mention of", "off limits"],
    "cta": ["cta", "call to action", "call-to-action"],
    "platforms": ["platform", "platforms", "channels", "channel", "where"],
    "length": ["length", "duration", "runtime", "running time", "max length"],
    "deadline": ["deadline", "due", "due date", "delivery date"],
}
TONE_WORDS = {"warm", "confident", "practical", "playful", "energetic", "calm", "authoritative", "friendly", "fun", "bold",
              "professional", "upbeat", "inspiring", "serious", "casual", "witty", "honest", "premium", "educational", "punchy"}
PLATFORMS = {"instagram": "Instagram", "reels": "Instagram", "tiktok": "TikTok", "youtube shorts": "YouTube Shorts",
             "shorts": "YouTube Shorts", "youtube": "YouTube", "linkedin": "LinkedIn", "facebook": "Facebook",
             "twitter": "X", "spotify": "Spotify", "apple podcasts": "Apple Podcasts", "website": "Website"}
SOCIAL = {"Instagram", "TikTok", "YouTube Shorts", "LinkedIn", "Facebook", "X"}
STOP = {"the", "and", "for", "with", "that", "this", "from", "your", "you", "are", "our", "will", "should", "into", "about",
        "have", "make", "want", "video", "clip", "clips", "edit", "their", "they", "them", "who", "why", "what", "how",
        "every", "one", "two", "more", "most", "very", "really", "than", "then", "there", "here", "also", "just", "episode"}
CLIP_WORDS = r"(?:vertical\s+|square\s+|horizontal\s+|social\s+|short\s+|promo(?:tional)?\s+)*" \
             r"(?:clips?|reels?|shorts|tiktoks?|teasers?|promos?|stories|cutdowns?|snippets?|social posts?|videos?)"
FULL_WORDS = r"(?:rough cut|full episode|full edit|long[- ]form|main edit|full cut|episode edit|podcast edit|tight cut|edit|cut)"


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", text.replace("’", "'").replace("–", "-").replace("—", "-")).strip()


def _split_items(value: str) -> list[str]:
    parts = re.split(r";|\n|•|(?:^|\s)[-*]\s|,\s*(?=(?:and\s+)?(?:\d+|one|two|three|four|five|a|an)\b)|\bplus\b|\balso\b",
                     value, flags=re.I)
    return [p.strip(" .,-*\"\u201c\u201d") for p in parts if p and p.strip(" .,-*\"\u201c\u201d")]


def _labelled(text: str) -> dict[str, list[str]]:
    """Collect 'Label: value' lines, including bullet lists that follow a bare 'Label:' line."""
    found: dict[str, list[str]] = {}
    lines = text.splitlines()
    alias = sorted(((a, key) for key, names in LABELS.items() for a in names), key=lambda x: -len(x[0]))
    i = 0
    while i < len(lines):
        line = lines[i].strip().lstrip("#").strip()
        m = re.match(r"^([A-Za-z' -]{2,30}?)\s*[:\-–]\s*(.*)$", line)
        key = None
        if m:
            label = m.group(1).strip().lower()
            key = next((k for a, k in alias if label == a), None)
        if key:
            value = m.group(2).strip()
            j = i + 1
            while j < len(lines) and re.match(r"^\s*(?:[-*•]|\d+[.)])\s+", lines[j]):
                value += "\n" + re.sub(r"^\s*(?:[-*•]|\d+[.)])\s+", "", lines[j])
                j += 1
            found.setdefault(key, []).append(value.strip())
            i = j
        else:
            i += 1
    return found


def _count(text: str) -> int:
    t = text.lower()
    for m in re.finditer(r"\b(\d{1,2})\b(?!\s*(?:-|\s)?(?:s\b|secs?\b|seconds?\b|mins?\b|minutes?\b|%|:))", t):
        if 0 < int(m.group(1)) <= 20:
            return int(m.group(1))
    for phrase, n in sorted(NUMBER_WORDS.items(), key=lambda x: -len(x[0])):
        if re.search(rf"\b{phrase}\b", t):
            return n
    return 1


def _seconds(value: float, unit: str) -> float:
    return value * 60 if unit.lower().startswith("m") else value


def parse_duration(text: str) -> dict:
    """'15-45 seconds' -> {min_s:15,max_s:45}; 'under 60 seconds' -> {max_s:60}; '30-second' -> {min_s:18,max_s:30}."""
    t = text.lower().replace("–", "-")
    unit = r"(seconds?|secs?|s|minutes?|mins?|m)\b"
    if m := re.search(rf"(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)\s*{unit}", t):
        return {"min_s": _seconds(float(m.group(1)), m.group(3)), "max_s": _seconds(float(m.group(2)), m.group(3))}
    if m := re.search(rf"(?:under|less than|max(?:imum)?|up to|no (?:more|longer) than|at most|within)\s*(\d+(?:\.\d+)?)\s*{unit}", t):
        return {"max_s": _seconds(float(m.group(1)), m.group(2))}
    if m := re.search(rf"(?:at least|minimum|min\.?|over|more than)\s*(\d+(?:\.\d+)?)\s*{unit}", t):
        return {"min_s": _seconds(float(m.group(1)), m.group(2))}
    if m := re.search(rf"(\d+(?:\.\d+)?)\s*(?:-|\s)?(second|sec|minute|min)s?\b", t):
        target = _seconds(float(m.group(1)), m.group(2))
        return {"min_s": round(target * 0.6, 1), "max_s": target}
    return {}


def _platforms(text: str) -> list[str]:
    t = text.lower()
    out = []
    for key, name in PLATFORMS.items():
        if re.search(rf"\b{key}\b", t) and name not in out and not (name == "YouTube" and "YouTube Shorts" in out
                                                                     and "youtube" not in t.replace("youtube shorts", "")):
            out.append(name)
    return out


def parse_deliverable(part: str, default_platforms: list[str]) -> dict | None:
    t = part.lower()
    is_clip = re.search(CLIP_WORDS, t) and not re.search(r"\bfull episode\b|\brough cut\b|\blong[- ]form\b", t)
    is_full = re.search(FULL_WORDS, t) or "episode" in t
    if not (is_clip or is_full):
        return None
    # Clips inherit the brief's platforms; a full edit only inherits long-form ones (never Reels/TikTok).
    platforms = _platforms(part) or ([p for p in default_platforms if p not in SOCIAL] if not is_clip else default_platforms)
    if re.search(r"vertical|9\s*:\s*16|\breels?\b|tiktok|shorts|stories|story", t):
        aspect = "9:16"
    elif re.search(r"square|1\s*:\s*1|\bfeed\b", t):
        aspect = "1:1"
    elif re.search(r"horizontal|landscape|16\s*:\s*9|youtube(?!\s*shorts)", t):
        aspect = "16:9"
    else:
        aspect = "9:16" if is_clip and (set(platforms) & SOCIAL) else "16:9"
    captions = None
    if re.search(r"\bno (?:captions|subtitles)\b|without (?:captions|subtitles)", t):
        captions = False
    elif re.search(r"caption|subtitle", t):
        captions = True
    elif is_clip and aspect == "9:16":
        captions = True  # vertical social clips are watched muted by default
    return {"kind": "clip" if is_clip else "full", "count": _count(part), "aspect": aspect, **parse_duration(part),
            "captions": captions, "platforms": platforms, "text": part.strip()[:200]}


def _keywords(phrases: list[str]) -> list[str]:
    words: list[str] = []
    for p in phrases:
        for w in re.findall(r"[a-z][a-z']{3,}", p.lower()):
            if w not in STOP and w not in words:
                words.append(w)
    return words[:40]


def extract_requirements(text: str) -> dict[str, Any]:
    text = text.replace("\r", "")
    flat = _norm(text)
    labelled = _labelled(text)
    get = lambda key: labelled.get(key, [])
    platforms = _platforms(" ".join(get("platforms"))) or _platforms(flat)

    deliverable_text = get("deliverables") or [s for s in re.split(r"(?<=[.!?])\s+", flat)
                                              if re.search(CLIP_WORDS + "|" + FULL_WORDS, s, re.I)
                                              and re.search(r"\b(?:need|want|deliver|create|make|produce|plus|cut)\b", s, re.I)]
    deliverables = []
    for value in deliverable_text:
        current = ""
        for part in _split_items(value):
            # Fragments like "20-45 seconds each" or "with captions" belong to the item before them.
            if current and parse_deliverable(part, platforms) is None:
                current = f"{current}, {part}"
                deliverables[-1] = parse_deliverable(current, platforms)
            elif d := parse_deliverable(part, platforms):
                current = part
                deliverables.append(d)
    length = parse_duration(" ".join(get("length")))
    if length:
        full = next((d for d in deliverables if d["kind"] == "full"), None)
        if full:
            full.update({k: v for k, v in length.items() if k not in full})

    key_messages = [p for v in get("key_messages") for p in _split_items(v)]
    quoted = re.findall(r"[\"“]([^\"”]{3,80})[\"”]", text)
    must_include = list(dict.fromkeys([q.strip() for q in quoted] + [p for v in get("must_include") for p in _split_items(v)]))
    avoid_lines = [p for v in get("must_avoid") for p in _split_items(v)]
    for m in re.finditer(r"\b(?:do not|don't|never|avoid)\s+(?:mention(?:ing)?|say(?:ing)?|show(?:ing)?|use|using|include)\s+([^.;\n]{2,60})", text, re.I):
        avoid_lines.append(m.group(1).strip())
    must_avoid = list(dict.fromkeys(re.sub(r"^(?:mention(?:ing)?|any|the)\s+", "", a, flags=re.I).strip(" .") for a in avoid_lines if a))
    tone_values = [p.lower() for v in get("tone") for p in re.split(r",|/|\band\b", v) if p.strip()]
    tone = [t.strip(" .") for t in tone_values] or sorted({w for w in re.findall(r"[a-z]+", flat.lower()) if w in TONE_WORDS})
    cta = (get("cta") or [""])[0]
    goals = [p for v in get("goals") for p in _split_items(v)]
    social = bool(set(platforms) & SOCIAL) or any(d["aspect"] == "9:16" for d in deliverables)
    req = {
        "client": (get("client") or [""])[0][:120],
        "goals": goals,
        "audience": (get("audience") or [""])[0][:200],
        "tone": tone[:8],
        "platforms": platforms,
        "deliverables": deliverables,
        "key_messages": key_messages,
        "must_include": must_include[:20],
        "must_avoid": must_avoid[:20],
        "cta": cta[:200],
        "deadline": (get("deadline") or [""])[0][:80],
        "loudness_target": -14.0 if social else -16.0,
    }
    req["keywords"] = _keywords(key_messages + goals + must_include + ([cta] if cta else []))
    return req


def merge(requirements: list[dict], overrides: dict | None = None) -> dict:
    """Combine several briefs (lists concatenated, first non-empty scalar wins), then apply overrides."""
    out: dict[str, Any] = {}
    for req in requirements:
        for key, value in req.items():
            if isinstance(value, list):
                existing = out.setdefault(key, [])
                for item in value:
                    if item not in existing:
                        existing.append(item)
            elif not out.get(key):
                out[key] = value
    for key, value in (overrides or {}).items():
        out[key] = value
    if overrides and any(k in overrides for k in ("key_messages", "goals", "must_include", "cta")):
        out["keywords"] = _keywords(out.get("key_messages", []) + out.get("goals", []) + out.get("must_include", [])
                                    + ([out["cta"]] if out.get("cta") else []))
    return out


EDITABLE = {"client": str, "goals": list, "audience": str, "tone": list, "platforms": list, "deliverables": list,
            "key_messages": list, "must_include": list, "must_avoid": list, "cta": str, "deadline": str,
            "loudness_target": float}


def clean_overrides(data: dict) -> dict:
    out: dict[str, Any] = {}
    for key, value in (data or {}).items():
        kind = EDITABLE.get(key)
        if kind is None:
            raise ValueError(f"Unknown brief field '{key}'")
        if kind is str:
            out[key] = str(value)[:300]
        elif kind is float:
            out[key] = max(-24.0, min(-9.0, float(value)))
        elif key == "deliverables":
            items = []
            for d in value[:12]:
                kind_ = d.get("kind") if d.get("kind") in ("clip", "full") else "clip"
                aspect = d.get("aspect") if d.get("aspect") in ("16:9", "9:16", "1:1") else ("9:16" if kind_ == "clip" else "16:9")
                item = {"kind": kind_, "count": max(1, min(20, int(d.get("count", 1)))), "aspect": aspect,
                        "captions": d.get("captions") if isinstance(d.get("captions"), bool) else None,
                        "platforms": [str(p)[:30] for p in d.get("platforms", [])][:5], "text": str(d.get("text", ""))[:200]}
                for bound in ("min_s", "max_s"):
                    if d.get(bound) is not None:
                        item[bound] = max(1.0, min(6 * 3600.0, float(d[bound])))
                items.append(item)
            out[key] = items
        else:
            out[key] = [str(v)[:200] for v in value][:30]
    return out


def _contains(haystack: str, phrase: str) -> bool:
    norm = lambda s: " ".join(re.findall(r"[a-z0-9']+", s.lower()))
    return f" {norm(phrase)} " in f" {norm(haystack)} "


def deliverable_loudness(deliverable: dict | None) -> float:
    """-14 LUFS for social/YouTube or vertical clips, otherwise the podcast standard -16 LUFS."""
    if not deliverable:
        return -16.0
    if set(deliverable.get("platforms", [])) & (SOCIAL | {"YouTube", "YouTube Shorts"}) or deliverable.get("aspect") == "9:16":
        return -14.0
    return -16.0


def classify(aspect: str, duration: float, req: dict | None) -> str:
    """'clip' or 'full' for a timeline, judged against the brief's deliverables when there are any."""
    pool = [d for d in (req or {}).get("deliverables", []) if d["aspect"] == aspect]
    kinds = {d["kind"] for d in pool}
    if len(kinds) == 1:
        return kinds.pop()
    return "clip" if aspect != "16:9" or duration <= 90 else "full"


def match_deliverable(aspect: str, duration: float, req: dict) -> dict | None:
    deliverables = req.get("deliverables", [])
    kind = classify(aspect, duration, req)
    same = [d for d in deliverables if d["aspect"] == aspect and d["kind"] == kind]
    return (same or [d for d in deliverables if d["kind"] == kind] or deliverables or [None])[0]


def compliance(timeline: dict, duration: float, cut_text: str, req: dict, sequence_count_by_kind: dict | None = None) -> dict:
    """Check one timeline against brief requirements. Returns {deliverable, checks: [{check,status,detail}]}."""
    checks: list[dict] = []
    add = lambda check, status, detail: checks.append({"check": check, "status": status, "detail": detail})
    if not req:
        return {"deliverable": None, "checks": [], "summary": "no brief"}
    aspect = timeline.get("aspect", "16:9")
    deliverable = match_deliverable(aspect, duration, req)
    if deliverable:
        add("aspect", "pass" if deliverable["aspect"] == aspect else "fail",
            f"brief asks for {deliverable['aspect']} ({deliverable['text'][:60]}), this is {aspect}")
        lo, hi = deliverable.get("min_s"), deliverable.get("max_s")
        if lo or hi:
            ok = (lo is None or duration >= lo - 0.5) and (hi is None or duration <= hi + 0.5)
            add("duration", "pass" if ok else "fail",
                f"{duration:.1f}s; brief range {lo or 0:g}-{hi if hi else '∞'}s")
        if deliverable.get("captions") is not None:
            burned = bool(timeline.get("burn_captions"))
            add("captions", "pass" if burned == deliverable["captions"] else "fail",
                f"captions {'burned in' if burned else 'off'}; brief wants them {'on' if deliverable['captions'] else 'off'}")
        if sequence_count_by_kind is not None:
            have = sequence_count_by_kind.get(deliverable["kind"], 0)
            add("deliverable count", "pass" if have >= deliverable["count"] else "info",
                f"{have} of {deliverable['count']} {deliverable['kind']} deliverable(s) in the project")
    else:
        add("deliverable", "info", "brief lists no matching deliverable")
    for phrase in req.get("must_include", []):
        add(f"include: {phrase[:40]}", "pass" if _contains(cut_text, phrase) else "warn",
            "spoken in this cut" if _contains(cut_text, phrase) else "not spoken in this cut")
    for phrase in req.get("must_avoid", []):
        add(f"avoid: {phrase[:40]}", "fail" if _contains(cut_text, phrase) else "pass",
            "appears in this cut, remove it" if _contains(cut_text, phrase) else "absent")
    keywords = req.get("keywords", [])
    if keywords:
        hits = [k for k in keywords if re.search(rf"\b{re.escape(k)}", cut_text.lower())]
        share = len(hits) / len(keywords)
        add("key messages", "pass" if share >= 0.3 else "warn",
            f"{len(hits)}/{len(keywords)} brief keywords present ({', '.join(hits[:6]) or 'none'})")
    if req.get("cta"):
        spoken = _contains(cut_text, req["cta"]) or _contains(timeline.get("title", ""), req["cta"])
        add("call to action", "pass" if spoken else "warn",
            "present" if spoken else f"'{req['cta'][:50]}' is not in this cut; consider the title or an end card")
    target = deliverable_loudness(deliverable) if deliverable else req.get("loudness_target")
    if target is not None and timeline.get("normalize_audio", True):
        have = (timeline.get("audio") or {}).get("loudness_target", -16.0)
        add("loudness", "pass" if abs(have - target) < 0.6 else "warn", f"{have:g} LUFS; this deliverable's platform suggests {target:g} LUFS")
    fails = sum(c["status"] == "fail" for c in checks)
    warns = sum(c["status"] == "warn" for c in checks)
    return {"deliverable": deliverable, "checks": checks,
            "summary": "meets the brief" if not fails and not warns else f"{fails} failing, {warns} to review"}
