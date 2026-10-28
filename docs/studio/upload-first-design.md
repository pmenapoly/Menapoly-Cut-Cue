# Upload-first Editing Room: audit, data model and plan (design only, awaiting approval)

This is a proposal for branch `menapoly-cue-studio-preview` (after `5fa790b`). No application code changes until you
approve. The designs are on the private canvas **Cue Upload-first Room**. Home stays exactly as it is.

## 1. Audit: how media, requests and rooms are linked today

| Thing | Today | Problem for upload-first |
|---|---|---|
| Upload (`svc.addLocalFile`) | Creates an `asset { id, ws, projectId?, folderId, name, kind, size, localUrl }` and a feed post. The playable file is a session-only object URL (`localMedia` map), lost on reload | No room is created. After a reload the footage can't play |
| Editing Room (`state.videos[]`) | Created only by `newRequest()` (the request form, Make more, translate, Maven proposals) or seeded. It needs a `reviewId` and a `requestId` | **A room can't exist without a request.** Its status is derived from the request and review |
| Brief | `video.instructions` (brief, brand, deliverables, look, sound, captions), copied once from the request form, template or source video | No draft state, no edit history, no "original vs later". A template overwrites the fields |
| Notes | `review.comments[]` (`version`, `t`, `shape` rect/pen, body, replies, resolved, assignee) | Nothing marks a note as an original instruction or as revision feedback. No arrows, circles, highlights, text notes or graphic zones. No voice |
| Request | `requests[]` (title, brief, type, aspect, length, `due`, `dueRev`, `dueHistory`, assignee, status, `key`) | `due` mixes "what the client asked for" with "what Menapoly estimates" |
| Checklist | `video.checklist[]`, from the template or defaults | Fine; it moves to the room |
| Voice | None (no MediaRecorder or IndexedDB anywhere) | Has to be built |
| Links | `asset.videoId`, `video.requestId`, `video.reviewId`; `#video-<id>`, `#review-<id>` and `#asset-<id>` redirect to the room | Keep these links working |

## 2. Proposed data model: rooms, briefs, notes, requests

```
MediaAsset   (exists)  id, ws, projectId?, roomId?, name, kind, size, by, at,
                       storage: "demo" | "session" | "device"   ← honest about where the bytes live
                       uploadKey  (name+size+lastModified+person → the same file picked twice = one asset)

EditingRoom  (new; today's videos[] become rooms, same ids)
                       id, ws, projectId, title, createdBy, createdAt,
                       sourceAssetIds[]   (several files per room; the first is the "main" footage)
                       briefId, requestId | null, reviewId | null, editorId | null,
                       stage   (derived, see §3), completedAt?, history[]
                       UNIQUE (ws, main source asset)  → one upload never makes two rooms

Brief        (new)     id, roomId, status: draft | ready | submitted, rev,
                       fields { title, outcome, instructions, platforms[], aspects[], references[{label,url|assetId}],
                                brand[], requestedDate, music, captions, checklist[] },
                       editLog[] { at, by, field, from, to }       ← audit of every change
                       submitted: { rev, at, by, snapshot }          ← frozen "original brief"; never overwritten

Note         (new; today's comments become notes)
                       id, roomId, phase: "brief" | "revision" | "question",
                       kind: "text" | "drawing" | "voice",
                       version (0 = original footage), t (seconds), frame?,
                       shapes[] { type: arrow|circle|box|highlight|pen|text|graphic-zone, geometry (0–1), label? },
                       body, voice? { blobKey, mime, duration, storage: "device", transcript: null },
                       by, at, status: draft | included | resolved, replies[], assignee?, editLog[]

EditingRequest (exists) id, roomId, briefRev (the snapshot it was made from), key (= briefId:rev → one request per submission),
                       requestedDate (from the client), estimateDate + estimateRev + estimateHistory (Menapoly's estimate; today's due/dueRev),
                       assignee, status, revision ledger (unchanged)
Review/versions (exist) unchanged; they now hang off the room
```

**Rules:**
- **Uploads:** an upload creates or opens its room (idempotent by `uploadKey`). Several files can be added to one
  room. A project can have many rooms.
- **No early assignment:** nothing is assigned on upload. A request is created **only** by *Submit editing request*,
  from a brief marked *Ready*, with the key `briefId:rev`. A double tap or a second tab can't create two.
- **Submission freezes the brief.** The submitted snapshot is the original brief. Later changes are `phase: "revision"`
  notes or a new brief revision; each is shown as *Added after submission* and never overwrites the original.
- **Requested vs estimated dates:** the client's requested date stays separate from Menapoly's production estimate
  (today's target-date flow, now called *estimate*).
- **Cue/Maven:** may propose an organised brief as a **proposal**. Approving it creates a new brief revision; the
  client's own words, drawings and recordings stay attached and visible to the editor.

## 3. Lifecycle (one room, start to finish)

| Stage | Entered when | Who acts | Room mode |
|---|---|---|---|
| Uploaded | A file is added (the room is created) | Client | Briefing |
| Preparing instructions | Any brief field or note is saved | Client | Briefing |
| Ready to submit | The client or admin marks it *Ready* (a checklist shows what's missing) | Client | Briefing |
| Submitted for editing | *Submit editing request* (creates the request; the brief is frozen) | Admin | Progress |
| Assigned | The admin assigns an editor | Editor | Editor workspace / client progress |
| Being edited | The editor starts | Editor | Editor workspace |
| Ready for review | The editor submits a version | Client | Review |
| Changes requested | The client requests changes (uses a revision round) | Editor | Editor workspace / client progress |
| Approved | The client approves the version on screen | Admin | Review (done) |
| Completed | The admin marks the deliverables handed over (new, explicit) | — | Archive, plus Make more |

**Request-first users keep working.** The request form becomes "create room + brief (already submitted) + request" in
one step, so `#request-new`, templates, Make more and Maven proposals behave as today.

## 4. Functional, simulated, missing

| Capability | Preview today | After this plan (preview) | Production needs |
|---|---|---|---|
| Upload | Simulated: name and size only; plays for this session only | **Simulated, more durable:** the file is kept in this browser's storage (IndexedDB) and labelled "Saved on this device only". Plays after a reload on the same device | Resumable upload to private R2, validation, processing on the worker |
| Room on upload | Missing | Functional (in the mock) | Server-side room record and permissions |
| Draft brief, autosave, edit log | Missing | Functional (local) | D1 tables (§7) |
| Text notes and timestamps | Functional (comments) | Functional, with phases | — |
| Drawings | Box and freehand | **Arrow, circle, box, highlight, freehand, text note, graphic zone.** Overlays only; the footage is untouched | Same as stored geometry |
| Voice notes | Missing | **Real browser recording (MediaRecorder), stored on this device only.** Microphone permission is asked only when you press Record. Each note is attached to a timestamp, with a text alternative | Upload to private storage; optional transcription, opt-in only |
| Voice in the hosted preview | — | Needs the artifact's microphone permission. If the frame blocks it, the button explains this and offers typed notes instead (no fake recordings) | — |
| Transcription and media analysis | Missing | **Not built**, and labelled "not available yet" | Server-side, opt-in, never invented |
| Maven brief organiser | Partly (explains instructions) | Proposals: organise the brief, list missing details, flag conflicting notes, draft handoff notes. Deterministic, from the client's own text | A server model that can only propose |
| Editor workspace | The same room with editor permissions | A dedicated layout: instruction timeline, original vs later, questions to the client, version submit | — |
| Rendering and editing timeline | Not real | **Out of scope.** Shown only as an "advanced timeline (concept)" label, never as working editing | Mac worker |

## 5. Phased implementation (after approval)

1. **Data and migration (no visible change):**
   - Rooms, briefs and notes in the service.
   - Migrate v6 → v7: `videos` become rooms with the same ids. Comments become notes (version 0 notes from the client
     before editing started become `brief`; the rest become `revision`). `video.instructions` and the request brief
     become a **submitted** brief snapshot.
   - All existing tests must pass unchanged.
2. **Upload → room:**
   - The Library upload and a new "Upload & brief" entry create rooms (idempotent).
   - Files are kept on this device (IndexedDB, honest label).
   - "Open Editing Room" appears on every upload.
3. **Client briefing mode:**
   - Brief editor with autosave and edit log, readiness checklist, *Mark ready*, *Submit editing request*.
   - Requested date separate from the estimate.
4. **Multimodal notes:** new drawing tools and text notes on frames, then voice notes (record, stop, preview,
   re-record, save, delete, timestamp, description), with an accessible typed alternative.
5. **Editor workspace:** instruction timeline with filters (original, later, voice, drawings), jump to timestamp,
   questions to the client, and the existing checklist and version submit.
6. **Review mode and completion:** same multimodal feedback for revision requests (revision rounds unchanged),
   *Completed* stage.
7. **Maven:** organise brief, missing details, conflicts, handoff notes, unresolved revision summary. All are
   proposals, and the originals are kept.
8. **Tests and publication:**
   - A new upload-first spec (upload → room → brief → draw → voice (fake microphone in Playwright) → ready → submit →
     assign → edit → review → approve → complete).
   - Regression across all existing specs, axe, the layout sweep and visual baselines (only intended room changes).
   - Publish the private preview.

## 6. Migration and regression risks

| Risk | Mitigation |
|---|---|
| Saved demo data (v6) from your phone | `migrate6()` like `migrate5()`. Rooms keep their ids, so links, notifications and tests (`#video-v_launch`) keep working. A test seeds v6 data and checks every room, comment and revision round survives |
| Duplicate rooms or requests | Unique main source per room; request key `briefId:rev`; tests double-tap, use two tabs and refresh |
| "Submitted" vs draft confusion | One stage chip and one primary action per stage. The submitted brief is read-only, with "Add a change" instead of editing |
| Voice permissions and storage | Ask only on Record. No upload. "Saved on this device only". Deleting removes the blob. The preview is clear about this |
| Browser storage limits | Device storage can fill up. Large files fall back to session-only, with a notice. Nothing pretends to be stored |
| Request-first regressions | The request form path uses the same room creation; the 23-step workflow and operations specs must pass |
| Visual baselines | Only the Editing Room baselines are expected to change; Home must match its baseline exactly |
| Editor sees partial instructions | The brief snapshot plus all `brief` and `revision` notes (and voice) are always shown to the assigned editor. Covered by tests |

## 7. Backend contracts for later (production)

```sql
editing_rooms(id PK, workspace_id, project_id, title, main_asset_id UNIQUE, created_by, created_at, request_id NULL, review_id NULL, completed_at NULL)
room_assets(room_id, asset_id, position, PRIMARY KEY (room_id, asset_id))
briefs(id PK, room_id UNIQUE, status CHECK(status IN ('draft','ready','submitted')), rev INT, fields_json, updated_at)
brief_edits(id PK, brief_id, rev, field, from_json, to_json, by, at)                 -- append-only
brief_snapshots(id PK, brief_id, rev, fields_json, submitted_by, submitted_at)       -- immutable original
notes(id PK, room_id, phase, kind, version INT, t_seconds REAL, shapes_json, body, voice_object_key NULL,
      voice_duration REAL NULL, by, at, status, UNIQUE(id))
requests.room_id, requests.brief_rev, requests.idempotency_key UNIQUE, requests.requested_date, requests.estimate_date
```

```
POST /v1/uploads (resumable) → asset + room (idempotent by upload key)    asset.upload
GET  /v1/rooms/:id                                                          project.view
PUT  /v1/rooms/:id/brief {fields, expected_rev}  → 409 stale               brief.edit (client of the workspace, admin)
POST /v1/rooms/:id/brief/ready                                              brief.edit
POST /v1/rooms/:id/submit {brief_rev, key}       → request (idempotent)    request.create
POST /v1/rooms/:id/notes {phase, kind, t, shapes, body}                     review.comment
POST /v1/rooms/:id/voice-notes → presigned PUT (private R2), then confirm   review.comment
POST /v1/rooms/:id/complete                                                 admin
```

Voice objects are private, reached by short-lived signed URLs, and readable only by people who can see the room. Any
transcription is opt-in per workspace and labelled as machine-generated.
