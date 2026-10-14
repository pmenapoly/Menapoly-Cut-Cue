"""AI Clip Factory, local part: find compelling, self-contained moments for short vertical clips.

Candidates are windows of whole transcript segments (they start and end on sentence
boundaries). Each window gets an explainable score:

* hook: the first line opens strongly (secret/mistake/why/how/numbers/"you"/a question);
* proof: concrete results (numbers, "doubled", percentages);
* intensity: emotionally loaded words;
* brief: keywords and must-include phrases from the creative brief;
* structure: ends on a complete sentence, Q->A between two speakers, few turns;
* penalties: openers that depend on earlier context ("And", "So", "It", "That"), fillers.

Windows containing a must-avoid phrase are excluded. The best non-overlapping windows win.
Claude, when connected, can review these candidates and choose differently.
"""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field

HOOK = re.compile(r"\b(secret|mistake|biggest|never|always|truth|nobody|everyone|why|how to|here is|here's|the reason|"
                  r"changed everything|stop|don't|you need|lesson|problem|wrong|surprising|best|worst|first)\b", re.I)
PROOF = re.compile(r"\b(\d[\d,.]*%?|doubled|tripled|halved|percent|million|thousand|times|grew|growth|increase[ds]?|"
                   r"sales|revenue|results?)\b", re.I)
INTENSITY = re.compile(r"\b(incredible|amazing|love|hate|crazy|honestly|shocked|insane|huge|massive|powerful|"
                       r"terrified|proud|finally|everything|perfection|consistency)\b", re.I)
WEAK_OPENERS = {"and", "but", "so", "because", "which", "that", "it", "this", "they", "he", "she", "also", "then", "or",
                "um", "uh", "yeah", "well"}
TERMINAL = re.compile(r"[.!?][\"')\]]*$")


@dataclass
class Candidate:
    asset_id: str
    start: float
    end: float
    est_duration: float
    score: float
    first_line: str
    text: str
    speakers: list[str]
    dominant_speaker: str | None
    reasons: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def _contains(text: str, phrase: str) -> bool:
    norm = lambda s: " ".join(re.findall(r"[a-z0-9']+", s.lower()))
    return f" {norm(phrase)} " in f" {norm(text)} "


def _tightened(window: list[dict], max_pause: float = 0.3) -> float:
    """Estimated duration after the clip's own pause tightening (max_pause=inf: untouched length)."""
    total = window[-1]["end"] - window[0]["start"]
    for a, b in zip(window, window[1:]):
        total -= max(0.0, b["start"] - a["end"] - max_pause)
    return total


def score_window(window: list[dict], req: dict, target: float) -> tuple[float, list[str]] | None:
    text = " ".join(s["text"] for s in window)
    for phrase in req.get("must_avoid", []):
        if _contains(text, phrase):
            return None
    first = window[0]["text"].strip()
    first_word = re.sub(r"[^a-z']", "", first.split()[0].lower()) if first.split() else ""
    reasons, score = [], 0.0
    hooks = HOOK.findall(first)
    if hooks or first.endswith("?"):
        score += 3.0 + 0.5 * min(len(hooks), 2)
        reasons.append(f"strong opener: \"{first[:70]}\"")
    proof = sorted({m.lower() for m in PROOF.findall(text)})
    if proof:
        score += min(2.5, 1.0 + 0.5 * len(proof))
        reasons.append(f"concrete proof: {', '.join(proof[:4])}")
    intense = sorted({m.lower() for m in INTENSITY.findall(text)})
    if intense:
        score += min(1.5, 0.5 * len(intense))
        reasons.append(f"emphasis: {', '.join(intense[:4])}")
    keywords = [k for k in req.get("keywords", []) if re.search(rf"\b{re.escape(k)}", text.lower())]
    if keywords:
        score += min(3.0, 0.6 * len(keywords))
        reasons.append(f"brief keywords: {', '.join(keywords[:6])}")
    includes = [p for p in req.get("must_include", []) if _contains(text, p)]
    if includes:
        score += 3.0
        reasons.append(f"brief must-include: \"{includes[0]}\"")
    if first_word in WEAK_OPENERS:
        score -= 2.5
        reasons.append(f"weak opener \"{first_word}\" (needs earlier context)")
    if TERMINAL.search(window[-1]["text"].strip()):
        score += 1.0
        reasons.append("ends on a complete sentence")
    else:
        score -= 1.0
    speakers = [s.get("speaker") for s in window]
    turns = sum(1 for a, b in zip(speakers, speakers[1:]) if a and b and a != b)
    question = next((i for i, s in enumerate(window) if s["text"].strip().endswith("?")), None)
    if question is not None and question < len(window) - 1 and speakers[question] != speakers[question + 1]:
        score += 1.5
        reasons.append("question answered by the other speaker")
    if turns > 3:
        score -= 1.0 * (turns - 3)
    duration = _tightened(window)
    score -= abs(duration - target) / max(target, 1.0)
    return round(score, 3), reasons


def find_moments(asset_id: str, segments: list[dict], req: dict | None = None, *, count: int = 3, min_s: float = 15.0,
                 max_s: float = 60.0, target_s: float | None = None, exclude: list[tuple[float, float]] | None = None,
                 max_candidates: int = 12, pause_cap: float = 0.3) -> tuple[list[Candidate], list[Candidate]]:
    """Return (chosen, ranked_candidates). ``segments`` = transcript of one asset (with speakers if known)."""
    req = req or {}
    target = target_s or (min_s + max_s) / 2
    exclude = exclude or []
    segs = [s for s in segments if s["text"].strip()]
    filler_only = lambda seg: all(re.sub(r"[^a-z']", "", w.lower()) in WEAK_OPENERS for w in seg["text"].split())
    windows: list[Candidate] = []
    for i in range(len(segs)):
        if filler_only(segs[i]):
            continue
        for j in range(i, len(segs)):
            window = segs[i: j + 1]
            est = _tightened(window, pause_cap)
            if est > max_s:
                break
            if est < min_s or not (TERMINAL.search(window[-1]["text"].strip()) or j == len(segs) - 1):
                continue
            if any(window[0]["start"] < b and window[-1]["end"] > a for a, b in exclude):
                continue
            scored = score_window(window, req, target)
            if scored is None:
                continue
            score, reasons = scored
            talk: dict[str, float] = {}
            for seg in window:
                if seg.get("speaker"):
                    talk[seg["speaker"]] = talk.get(seg["speaker"], 0.0) + seg["end"] - seg["start"]
            windows.append(Candidate(asset_id, window[0]["start"], window[-1]["end"], round(est, 2), score,
                                     window[0]["text"].strip(), " ".join(seg["text"] for seg in window),
                                     sorted(talk), max(talk, key=talk.get) if talk else None, reasons))
    ordered = sorted(windows, key=lambda c: (-c.score, c.start, c.end))
    pool = [c for c in windows if c.score > 0]
    chosen = select_non_overlapping(pool, count)
    if len(chosen) < count:  # not enough positive-scoring moments: allow weaker ones to meet the count
        chosen = select_non_overlapping(windows, count)
    # For review: the best window for each distinct opening line.
    seen, ranked = set(), []
    for cand in ordered:
        if cand.start not in seen:
            seen.add(cand.start)
            ranked.append(cand)
    return sorted(chosen, key=lambda c: c.start), ranked[:max_candidates]


def select_non_overlapping(windows: list[Candidate], count: int, gap: float = 1.0) -> list[Candidate]:
    """Weighted interval scheduling: as many clips as possible (up to count), then the highest total score."""
    items = sorted(windows, key=lambda c: (c.end, c.start))
    if not items or count <= 0:
        return []
    ends = [c.end for c in items]
    import bisect

    prev = [bisect.bisect_right(ends, c.start - gap) for c in items]  # windows 0..prev-1 end early enough
    n = len(items)
    # best[k][i] = (clips, score) using the first i windows and at most k clips
    best = [[(0, 0.0)] * (n + 1) for _ in range(count + 1)]
    take = [[False] * (n + 1) for _ in range(count + 1)]
    for k in range(1, count + 1):
        row, below = best[k], best[k - 1]
        for i in range(1, n + 1):
            c = items[i - 1]
            with_c = (below[prev[i - 1]][0] + 1, below[prev[i - 1]][1] + c.score)
            if with_c > row[i - 1]:
                row[i], take[k][i] = with_c, True
            else:
                row[i] = row[i - 1]
    chosen, k, i = [], count, n
    while k > 0 and i > 0:
        if take[k][i]:
            chosen.append(items[i - 1])
            i, k = prev[i - 1], k - 1
        else:
            i -= 1
    return sorted(chosen, key=lambda c: c.start)


def title_from(first_line: str, limit: int = 42) -> str:
    """Short on-screen title from the opening line (whole words, no trailing punctuation clutter)."""
    sentence = re.split(r"(?<=[.!?:])\s", first_line.strip())[0].rstrip(":.!,;")
    if len(sentence) <= limit:
        return sentence
    words, out = sentence.split(), ""
    for w in words:
        if len(out) + len(w) + 1 > limit - 1:
            break
        out = f"{out} {w}".strip()
    return out + "…"
