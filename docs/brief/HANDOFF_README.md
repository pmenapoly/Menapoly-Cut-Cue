# Menapoly Cut Cue — Phase 2 handoff

This package preserves the original FFmpeg starter and includes a Phase 2 implementation brief for Claude Code. It is not a complete application.

## Use
1. Unzip in a new project directory.
2. Open that directory in Claude Code.
3. Paste `CLAUDE_PHASE2.md` into Claude Code and ask it to implement the milestones.
4. Install Python 3.10+, FFmpeg and FFprobe for the starter engine.

Run the starter only after replacing example paths with real media paths:
`python edit_engine.py example-edit.json output.mp4`

The current engine requires source video files with audio. Never expose arbitrary source paths as a public API.

## Fast track
For the private 14-day MVP, have Claude Code read `CLAUDE_FAST_TRACK.md` first and `CLAUDE_PHASE2.md` second. Prioritize the working end-to-end editing slice over future integrations.
