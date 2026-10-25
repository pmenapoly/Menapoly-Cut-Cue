# Editing Room and Project Workspace

Preview only: branch `menapoly-cue-studio-preview` holds fictional data and synthetic clips, with no production
connection. A client can open a video, see where it stands, review it, request changes, approve it and choose what
to do next.

## How people get there

| From | Opens |
|---|---|
| Studio → a project card | **Project Workspace** (`#project-<id>`): videos, editing requests, collaborators, files, progress, brief |
| A video card in the Project Workspace, Home uploads, the feed, Review, Library or search | **Editing Room** (`#video-<id>`) |
| Older links (`#review-<id>`, `#asset-<id>` of a video) | Redirect to the Editing Room with `location.replace`, so the back button stays clean |

## Editing Room layout

- **Header:** back to the project; the title; workspace · project; status (word, icon and colour); assigned editor; **More actions** (⋯).
- **Player** (`js/player.js`):
  - play/pause, a seek bar with comment pins, timecodes, volume and mute, speed (0.5–2×) and full screen;
  - a drawing layer for frame marks (box or freehand);
  - H.264 and VP9 sources, so the browser picks one it plays.
- **Under the player:** the comment composer (kept next to the frame so the drawing tools work on a phone), a version
  picker (Original plus each version), *Compare versions* and *Transcript*. The transcript states that none
  exists: the synthetic clips have no speech, and the preview never invents one.
- **Where it stands:** a plain-language status and the actions that fit it:
  - *Ready for review*: **Approve video** / **Request changes** (a note is required; *Help me write it* opens Maven).
  - *Approved*: **Make more from this video** (the main action), then Share on social, Add to sharing library, Make a template
    and All actions.
  - Otherwise, for the editing team: submit a new version (simulated).
  - Always: checklist progress.
- **Tabs:**
  - **Instructions:** brief, brand guidelines, deliverables, look, sound, captions, and the editing checklist.
  - **Comments:** open / resolved / assigned to me / all; per-version comments, or all versions.
  - **Versions:** list, watch any version, approval status and history.
  - **Files:** project and brand files.
  - **Activity:** the audit trail plus checklist history.
- **Phone:** one column, video first, tabs wrap (no sideways scroll), 44 px controls. **Desktop:** a large player,
  with a sticky right panel for the tabs.

**Editing checklist.** It has four sections: Before editing · Video and sound · Captions and graphics · Final checks.
Each task has an owner, optional source and output timecodes, notes, and a completion record (who and when).
- **Admins and the assigned editor** tick tasks.
- **Clients** see progress and can add notes. Their checkboxes are disabled, with an explanation.
- **"Only my tasks"** filters the list for whoever owns tasks.

**Templates (Make a template).** A template saves the look, sound and captions instructions, output formats, brand
rules and checklist tasks (without their progress).
- **Never included:** footage, files, comments or progress. The workspace and project names are replaced with
  neutral words.
- **Where it lives:** templates belong to one workspace. They're listed under Media Studio → Templates and reused
  through *Use for a new request* or *Start from a template* on the request form.

**Maven.** A header button on every screen opens Maven in a sheet over the page; the video's position, tab and version
are kept. Inside a room it offers seven requests:
- Summarize this video
- Suggest short clips
- Write a social caption
- Explain the editing instructions
- Help me request changes
- Suggest a new version
- Turn this video into a content idea

Its answers are deterministic, from data the role can see. Every change is a **proposal**. *Approve* runs the same
authorized service call as the button would; *Decline* changes nothing.

## Real, simulated and unavailable (in this preview)

| Works for real (stored on this device) | Simulated, and labelled | Unavailable, with the reason shown |
|---|---|---|
| Navigation between projects, rooms, versions and tabs; playback controls on the demo clips | **New version upload:** reuses a demo clip | **Copy video link:** private links come with the live service |
| Comments, frame marks, replies, assign, resolve and reopen, per version | **Uploads:** only the name and size are kept | **Download:** blocked by the preview frame |
| Approve and request changes, with history and revision limits | **Social:** preparation only, nothing posts | **Automatic translation:** a request for translated captions is sent to the team instead |
| Checklist ticks, notes and history, by permission | **Delivery and export presets:** recorded, not rendered | **Transcripts:** none exist for the synthetic clips |
| Templates: make, list, reuse; workspace-scoped and stripped of client details | | **Live AI model:** Maven is deterministic |
| Make more from this video, and captions in another language (both create editing requests) | | |
| Add to sharing library, add to feed | | |
| Home: announcements (dismiss persists), the 14-day spotlight from approved entries, upload filters, search | | |
| Role and workspace rules on every service call | | |

## Component and state architecture

| Layer | File | Role |
|---|---|---|
| Rules | `js/policy.js` | Pure `can(user, action, ctx)`, deny-by-default. New actions: `checklist.update`, `checklist.comment`, `review.assign`, `template.view`, `template.create`, `video.share`, `video.feed`, `video.library`, `video.another`, `video.translate`, `video.download` |
| Service (mock API) | `js/service.js` | Every call runs `enforce()`, validates, audits, and has simulated latency and an outage switch. Editing Room: `videos`, `video`, `toggleTask`, `noteTask`, `assignComment`, `templates`, `saveTemplate`, `videoAction`, `announcements`, `dismiss`, `spotlight`, `uploaders` |
| Fixtures | `js/data.js` | Fictional videos, checklists, templates, announcements, spotlight schedule |
| Player | `js/player.js` | `createPlayer({ media, markers, onMarker, onTime })` returns `{ el, video, setMedia, seek, annotate }` |
| Assistant | `js/maven.js`, `js/assistant.js` | Header launcher; contextual answers; proposals through `svc.propose` / `svc.decideProposal` |
| Views | `js/views-room.js` (Project Workspace, Editing Room, actions, templates), `views-home.js`, `views-studio.js`, … | View state per person and video (tab, version, playhead, filters) in memory, so actions and Maven don't lose the viewer's place |

## Backend contract for the real implementation (designed; nothing connected)

New D1 migration, after the tenancy step in [integration-plan.md](integration-plan.md):

```sql
videos(id, workspace_id, project_id, title, editor_email, original_asset_id, request_id, created_at)
video_instructions(video_id PK, brief, brand_json, deliverables_json, visual, audio, captions, updated_by, updated_at)
checklist_tasks(id, video_id, section, text, owner_email, src_tc, out_tc, done_at, done_by, position)
task_notes(id, task_id, author_email, body, created_at)
annotations(id, video_id, version_number, t_seconds, shape_json, body, author_email, assignee_email, resolved_at, created_at)
annotation_replies(id, annotation_id, author_email, body, created_at)
templates(id, workspace_id, name, instructions_json, outputs_json, brand_json, checklist_json, created_by, created_at)
announcements(id, scope, kind, title, body, link, starts_at, ends_at)   -- dismissals: announcement_dismissals(user, id)
spotlights(id, scope, title, author, body, lesson_id, starts_at, approved_by, approved_at)  -- live = approved and starts_at ≤ now < starts_at + 14 days
```

Routes (all through the ported `policy.ts`, with JSON validation, rate limits and idempotency keys):

```
GET  /v1/videos?project=… · GET /v1/videos/:id               (project.view)
POST /v1/videos/:id/annotations · /annotations/:id/replies    (review.comment)
POST /v1/annotations/:id/resolve|reopen|assign                (review.resolve / review.assign)
POST /v1/videos/:id/tasks/:task/done|undone                   (checklist.update)
POST /v1/videos/:id/tasks/:task/notes                         (checklist.comment)
POST /v1/versions/:id/decision                                (review.decide; exists today)
POST /v1/videos/:id/templates · GET /v1/templates?workspace=… (template.create / template.view; server strips names and asset ids)
POST /v1/videos/:id/actions/{library|feed|another|translate}  (video.*; another and translate create editing requests)
GET  /v1/home/announcements · POST /v1/home/announcements/:id/dismiss · GET /v1/home/spotlight
```

Media plays and downloads through the existing short-lived signed R2 links. Transcripts come only from the editing
engine's output. Nothing here posts to social networks, translates automatically or renders without the worker.
