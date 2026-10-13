import pytest

from cutcue.documents import format_srt_time, parse_captions, to_srt
from cutcue.timeline import Clip, Timeline, TimelineError, caption_cues, remove_pauses, validate_timeline

ASSETS = {
    "ast_aaaaaaaaaaaaaaaa": {"kind": "video", "status": "ready", "duration": 60.0},
    "ast_bbbbbbbbbbbbbbbb": {"kind": "document", "status": "ready", "duration": None},
}


def tl(*clips, **kw):
    return Timeline(clips=[Clip(asset_id=a, start=s, end=e) for a, s, e in clips], **kw)


def test_valid_timeline_passes():
    validate_timeline(tl(("ast_aaaaaaaaaaaaaaaa", 1.0, 5.0), ("ast_aaaaaaaaaaaaaaaa", 10, 20)), ASSETS)


@pytest.mark.parametrize("clip,needle", [
    (("ast_cccccccccccccccc", 0, 5), "unknown asset"),
    (("ast_bbbbbbbbbbbbbbbb", 0, 5), "not video or audio"),
    (("ast_aaaaaaaaaaaaaaaa", -1, 5), "negative"),
    (("ast_aaaaaaaaaaaaaaaa", 5, 5.05), "at least"),
    (("ast_aaaaaaaaaaaaaaaa", 50, 61), "exceeds source duration"),
])
def test_invalid_clips_rejected(clip, needle):
    with pytest.raises(TimelineError) as err:
        validate_timeline(tl(clip), ASSETS)
    assert any(needle in p for p in err.value.problems)


def test_empty_timeline_rejected():
    with pytest.raises(TimelineError):
        validate_timeline(Timeline(), ASSETS)


def test_extra_fields_rejected():
    with pytest.raises(ValueError):
        Timeline(clips=[{"asset_id": "ast_aaaaaaaaaaaaaaaa", "start": 0, "end": 1, "path": "/etc/passwd"}])


def test_remove_pauses_splits_around_long_silences():
    clips = [Clip(asset_id="a", start=0, end=20)]
    silences = {"a": [{"start": 5.0, "end": 7.0}, {"start": 10.0, "end": 10.3}, {"start": 15.0, "end": 18.0}]}
    out = remove_pauses(clips, silences, min_pause=0.7, keep_padding=0.15)
    assert [(c.start, c.end) for c in out] == [(0, 5.15), (6.85, 15.15), (17.85, 20)]


def test_caption_cues_map_to_output_time():
    timeline = tl(("a", 10, 12), ("a", 2, 4))
    segs = {"a": [
        {"start": 2, "end": 4, "text": "hello there", "words": [{"start": 2.0, "end": 2.5, "word": " hello"},
                                                               {"start": 2.6, "end": 3.0, "word": " there"}]},
        {"start": 10, "end": 12, "text": "first", "words": [{"start": 10.2, "end": 10.8, "word": " first"}]},
    ]}
    cues = caption_cues(timeline, segs)
    assert cues[0]["text"] == "first" and cues[0]["start"] == pytest.approx(0.2)
    assert cues[1]["text"] == "hello there" and cues[1]["start"] == pytest.approx(2.0)


def test_srt_roundtrip():
    cues = [{"start": 0.5, "end": 1.25, "text": "One"}, {"start": 3661.0, "end": 3662.0, "text": "Two"}]
    parsed = parse_captions(to_srt(cues))
    assert [(c["start"], c["end"], c["text"]) for c in parsed] == [(0.5, 1.25, "One"), (3661.0, 3662.0, "Two")]
    assert format_srt_time(3661.0) == "01:01:01,000"


def test_vtt_parse():
    vtt = "WEBVTT\n\n00:01.000 --> 00:02.500 align:start\n<v Host>Hi there\n"
    assert parse_captions(vtt) == [{"start": 1.0, "end": 2.5, "text": "Hi there", "words": []}]
