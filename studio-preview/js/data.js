// FICTIONAL DEMO DATA. Every company, person, number and clip here is invented for the preview.
// Nothing is imported from the production pilot, its database, its storage or any client.

const H = 3600e3, D = 24 * H;
const at = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const inDays = (d) => new Date(Date.now() + d * D).toISOString().slice(0, 10);

// Synthetic clips (tools/make_media.sh): H.264 for phones, VP9 for every Chromium. They contain a tone, no speech,
// so no transcript exists for them; the Editing Room says so instead of inventing one.
const clip = (name, duration) => ({ src: `media/${name}.mp4`, webm: `media/${name}.webm`, poster: `media/${name}.jpg`, duration, transcript: null });
export const MEDIA = {
  v1: clip("nw-launch-v1", 12), v2: clip("nw-launch-v2", 12), reel: clip("nw-reel", 10),
  podcast: clip("hb-podcast", 10), coaching: clip("mn-coaching", 8),
};

export const CHECKLIST_SECTIONS = ["Before editing", "Video and sound", "Captions and graphics", "Final checks"];

export const REQUEST_TYPES = [
  { id: "short", label: "Short-form social clips", hint: "15–60 s vertical cuts for Reels, Shorts and TikTok" },
  { id: "long", label: "Long-form video edit", hint: "Full edit from raw footage" },
  { id: "podcast", label: "Podcast episode", hint: "Multi-cam or audio episode, intro and outro" },
  { id: "promo", label: "Promotional video", hint: "Campaign spot with music and graphics" },
  { id: "captions", label: "Captions and subtitles", hint: "Burned-in or sidecar files" },
  { id: "aspect", label: "Aspect-ratio conversion", hint: "16:9 ↔ 9:16 ↔ 1:1 reframing" },
  { id: "audio", label: "Audio cleanup", hint: "Noise, levels and loudness" },
  { id: "graphics", label: "Branded graphics", hint: "Lower thirds, titles, end cards" },
  { id: "highlights", label: "Highlight extraction", hint: "Best moments from a long recording" },
  { id: "transcript", label: "Transcript-based edit", hint: "Cut by editing the transcript" },
];

export const EXPORT_PRESETS = [
  { id: "yt", label: "YouTube 1080p", spec: "16:9 · 1920×1080 · H.264 · −14 LUFS" },
  { id: "reels", label: "Reels / Shorts / TikTok", spec: "9:16 · 1080×1920 · H.264 · captions burned in" },
  { id: "li", label: "LinkedIn feed", spec: "1:1 · 1080×1080 · H.264" },
  { id: "master", label: "Archive master", spec: "Source resolution · high bitrate" },
];

export const PLATFORMS = [
  { id: "linkedin", label: "LinkedIn", limit: 3000 },
  { id: "instagram", label: "Instagram", limit: 2200 },
  { id: "facebook", label: "Facebook", limit: 5000 },
  { id: "youtube", label: "YouTube", limit: 5000 },
  { id: "tiktok", label: "TikTok", limit: 2200 },
  { id: "x", label: "X", limit: 280 },
];

export function seed() {
  return {
    version: 6,
    workspaces: [
      { id: "ws_nw", name: "Northwind Roasters", industry: "Specialty coffee", plan: "growth", monogram: "NR" },
      { id: "ws_hb", name: "Harborline Fitness", industry: "Boutique gyms", plan: "essentials", monogram: "HF" },
    ],
    users: [
      { id: "u_admin", name: "Avery Hart", role: "admin", title: "Producer, Menapoly Digital", initials: "AH" },
      { id: "u_jordan", name: "Jordan Lee", role: "client", title: "Marketing lead, Northwind Roasters", workspaceIds: ["ws_nw"], initials: "JL" },
      { id: "u_priya", name: "Priya Shah", role: "client", title: "Owner, Harborline Fitness", workspaceIds: ["ws_hb"], initials: "PS" },
      { id: "u_sam", name: "Sam Rivera", role: "editor", title: "Video editor", initials: "SR" },
      { id: "u_mika", name: "Mika Chen", role: "editor", title: "Motion designer", initials: "MC" },
    ],
    projects: [
      { id: "p_launch", ws: "ws_nw", name: "Spring Launch Campaign", status: "In review", editorIds: ["u_sam"], due: inDays(5),
        brief: "Hero spot plus cut-downs for the new single-origin line. Warm, confident, product-first." },
      { id: "p_reels", ws: "ws_nw", name: "Brew Tips Reels", status: "Editing", editorIds: ["u_mika"], due: inDays(9),
        brief: "Six 30-second brewing tips for Reels and Shorts, captions burned in.", revisionsIncluded: 2 }, // contracted override: 2 rounds instead of the Growth plan's 3
      { id: "p_podcast", ws: "ws_hb", name: "Harborline Talks — Ep. 12", status: "Requested", editorIds: ["u_sam"], due: inDays(12),
        brief: "45-minute interview with two coaches. Clean audio, chapter markers, three highlight clips." },
      { id: "p_promo", ws: "ws_hb", name: "January Membership Promo", status: "Brief", editorIds: [], due: inDays(30),
        brief: "15- and 30-second promo for the January membership push." },
    ],
    folders: [
      { id: "f_nw_raw", ws: "ws_nw", name: "Raw footage" }, { id: "f_nw_brand", ws: "ws_nw", name: "Brand kit" },
      { id: "f_nw_final", ws: "ws_nw", name: "Approved finals" },
      { id: "f_hb_raw", ws: "ws_hb", name: "Recordings" }, { id: "f_hb_brand", ws: "ws_hb", name: "Brand kit" },
    ],
    assets: [
      { id: "a_launch_v1", videoId: "v_launch", ws: "ws_nw", projectId: "p_launch", folderId: "f_nw_raw", name: "spring-launch-cut-v1.mp4", kind: "video", media: "v1",
        size: 196836, tags: ["launch", "hero"], by: "u_sam", at: at(3 * D), channel: false },
      { id: "a_launch_v2", videoId: "v_launch", ws: "ws_nw", projectId: "p_launch", folderId: "f_nw_final", name: "spring-launch-cut-v2.mp4", kind: "video", media: "v2",
        size: 209257, tags: ["launch", "hero", "approved"], by: "u_sam", at: at(6 * H), channel: true },
      { id: "a_reel", videoId: "v_reel", ws: "ws_nw", projectId: "p_reels", folderId: "f_nw_final", name: "brew-tips-reel-01.mp4", kind: "video", media: "reel",
        size: 211632, tags: ["reels", "tips"], by: "u_mika", at: at(20 * H), channel: true },
      { id: "a_logo", ws: "ws_nw", projectId: null, folderId: "f_nw_brand", name: "northwind-logo-pack.zip", kind: "document",
        size: 2_400_000, tags: ["brand"], by: "u_jordan", at: at(12 * D), channel: false },
      { id: "a_style", ws: "ws_nw", projectId: null, folderId: "f_nw_brand", name: "brand-voice-guide.pdf", kind: "document",
        size: 860_000, tags: ["brand", "voice"], by: "u_jordan", at: at(12 * D), channel: false },
      { id: "a_pod_raw", videoId: "v_pod", ws: "ws_hb", projectId: "p_podcast", folderId: "f_hb_raw", name: "talks-ep12-raw.mp4", kind: "video", media: "podcast",
        size: 149281, tags: ["podcast"], by: "u_priya", at: at(30 * H), channel: false },
      { id: "a_pod_audio", ws: "ws_hb", projectId: "p_podcast", folderId: "f_hb_raw", name: "talks-ep12-lav-mic.wav", kind: "audio",
        size: 52_000_000, tags: ["podcast", "audio"], by: "u_priya", at: at(30 * H), channel: false },
      { id: "a_hb_photo", ws: "ws_hb", projectId: null, folderId: "f_hb_brand", name: "studio-floor.jpg", kind: "image", media: "podcast",
        size: 1_200_000, tags: ["brand"], by: "u_priya", at: at(8 * D), channel: false },
    ],
    requests: [
      { id: "r_launch", ws: "ws_nw", projectId: "p_launch", type: "promo", title: "Spring Launch hero spot", status: "In review",
        brief: "60-second hero spot. Open on the roastery, end on the bag shot. Keep the founder line at 0:08.",
        aspect: "16:9", length: "60 s", due: inDays(5), assigneeId: "u_sam", by: "u_jordan", at: at(6 * D), dueRev: 0, dueHistory: [] },
      { id: "r_reels", ws: "ws_nw", projectId: "p_reels", type: "short", title: "Brew Tips — six reels", status: "In progress",
        brief: "Six tips, 30 s each, captions on, end card with the shop link.", aspect: "9:16", length: "30 s each", due: inDays(9),
        assigneeId: "u_mika", by: "u_jordan", at: at(4 * D), dueRev: 0, dueHistory: [] },
      { id: "r_pod", ws: "ws_hb", projectId: "p_podcast", type: "podcast", title: "Episode 12 edit + 3 highlights", status: "Submitted",
        brief: "Clean the lav audio, cut the 4-minute tangent at 12:30, three highlight clips for Instagram.", aspect: "16:9 + 9:16",
        length: "45 min + 3 × 45 s", due: inDays(12), assigneeId: "u_sam", by: "u_priya", at: at(30 * H), dueRev: 0, dueHistory: [] },
    ],
    reviews: [
      { id: "rv_launch", ws: "ws_nw", projectId: "p_launch", requestId: "r_launch", title: "Spring Launch hero spot", status: "In review",
        versions: [{ n: 1, media: "v1", by: "u_sam", at: at(3 * D), note: "First assembly" },
                   { n: 2, media: "v2", by: "u_sam", at: at(6 * H), note: "Tighter open, new end card" }],
        comments: [
          { id: "c1", version: 1, t: 2.4, shape: { type: "rect", x: 0.06, y: 0.28, w: 0.55, h: 0.2 }, body: "Title feels heavy here. Can it ease in?",
            by: "u_jordan", at: at(2 * D), resolved: true, replies: [{ by: "u_sam", body: "Softened in v2 with a 12-frame fade.", at: at(40 * H) }] },
          { id: "c2", version: 2, t: 7.8, shape: null, body: "Love the pacing. Hold the bag shot half a second longer?",
            by: "u_jordan", at: at(3 * H), resolved: false, replies: [] },
        ],
        audit: [
          { at: at(3 * D), by: "u_sam", action: "Uploaded version 1" },
          { at: at(2 * D), by: "u_jordan", action: "Requested changes", detail: "Ease in the title" },
          { at: at(6 * H), by: "u_sam", action: "Uploaded version 2" },
          { at: at(6 * H), by: "u_sam", action: "Submitted for review" },
        ],
        // Revision rounds: one per formal change request against a submitted version (comments don't count).
        rounds: [{ version: 1, at: at(2 * D), by: "u_jordan", note: "Ease in the title", kind: "included" }], extraRounds: [], extraAsks: [] },
      { id: "rv_reel", ws: "ws_nw", projectId: "p_reels", requestId: "r_reels", title: "Brew Tips — reel 01", status: "Approved",
        versions: [{ n: 1, media: "reel", by: "u_mika", at: at(20 * H), note: "Reel 01 of 6" }],
        comments: [], audit: [{ at: at(20 * H), by: "u_mika", action: "Uploaded version 1" }, { at: at(16 * H), by: "u_jordan", action: "Approved" }],
        rounds: [], extraRounds: [], extraAsks: [] },
      { id: "rv_pod", ws: "ws_hb", projectId: "p_podcast", requestId: "r_pod", title: "Harborline Talks — Ep. 12", status: "Waiting to start",
        versions: [], comments: [{ id: "c_pod1", version: 0, t: 3.2, shape: null, body: "Please cut the tangent that starts around here.", by: "u_priya", at: at(29 * H), resolved: false, replies: [], assigneeId: "u_sam" }],
        audit: [{ at: at(30 * H), by: "u_priya", action: "Uploaded the original recording" }], rounds: [], extraRounds: [], extraAsks: [] },
    ],
    videos: [
      { id: "v_launch", ws: "ws_nw", projectId: "p_launch", reviewId: "rv_launch", requestId: "r_launch", title: "Spring Launch hero spot", editorId: "u_sam",
        original: { media: "v1", label: "First assembly (original)" },
        instructions: {
          brief: "60-second hero spot for the spring single-origin line. Open on the roastery, end on the bag shot. Keep the founder line at 0:08.",
          brand: ["End card with the logo for the last 2 seconds", "Warm grade; no cool or teal looks", "Titles in the brand serif, sentence case"],
          deliverables: [{ label: "Hero spot, 16:9", preset: "yt" }, { label: "Three 20-second verticals", preset: "reels" }],
          visual: "Slow push-ins on product shots. No more than three cuts per 5 seconds in the open.",
          audio: "Licensed track from the brand kit, ducked under the founder line. Final loudness −14 LUFS.",
          captions: "Burned-in captions on the verticals only. White, sentence case, lower third.",
        },
        checklist: [
          { id: "t1", section: "Before editing", text: "Watch all footage and mark the best takes", owner: "u_sam", done: true, doneBy: "u_sam", doneAt: at(4 * D), src: "", out: "", notes: [] },
          { id: "t2", section: "Before editing", text: "Confirm music licence from the brand kit", owner: "u_admin", done: true, doneBy: "u_admin", doneAt: at(4 * D), src: "", out: "", notes: [] },
          { id: "t3", section: "Video and sound", text: "Keep the founder line", owner: "u_sam", done: true, doneBy: "u_sam", doneAt: at(3 * D), src: "02:14:05", out: "00:00:08", notes: [] },
          { id: "t4", section: "Video and sound", text: "Mix to −14 LUFS and duck music under dialogue", owner: "u_sam", done: true, doneBy: "u_sam", doneAt: at(7 * H), src: "", out: "", notes: [] },
          { id: "t5", section: "Video and sound", text: "Hold the bag shot half a second longer", owner: "u_sam", done: false, src: "03:41:10", out: "00:00:52", notes: [{ by: "u_jordan", body: "This is the one I care most about.", at: at(3 * H) }] },
          { id: "t6", section: "Captions and graphics", text: "Add the logo end card", owner: "u_sam", done: true, doneBy: "u_sam", doneAt: at(6 * H), src: "", out: "00:00:58", notes: [] },
          { id: "t7", section: "Captions and graphics", text: "Captions on the vertical cut-downs", owner: "u_mika", done: false, src: "", out: "", notes: [] },
          { id: "t8", section: "Final checks", text: "Spell-check titles and captions", owner: "u_sam", done: false, src: "", out: "", notes: [] },
          { id: "t9", section: "Final checks", text: "Export every deliverable and play each one through", owner: "u_sam", done: false, src: "", out: "", notes: [] },
        ],
        history: [{ at: at(6 * D), by: "u_jordan", action: "Requested this video" }, { at: at(5 * D), by: "u_admin", action: "Assigned Sam Rivera" }] },
      { id: "v_reel", ws: "ws_nw", projectId: "p_reels", reviewId: "rv_reel", requestId: "r_reels", title: "Brew Tips — reel 01", editorId: "u_mika",
        original: { media: "reel", label: "Original recording" },
        instructions: { brief: "Tip 1 of 6: weigh your beans. 30 seconds, vertical, captions on.", brand: ["Logo bug top-right", "Captions in brand cream"],
          deliverables: [{ label: "Vertical reel", preset: "reels" }], visual: "Overhead scale shot first.", audio: "Voice only, light room tone.", captions: "Burned in, two lines maximum." },
        checklist: [
          { id: "t1", section: "Before editing", text: "Pick the clearest take", owner: "u_mika", done: true, doneBy: "u_mika", doneAt: at(1 * D), src: "", out: "", notes: [] },
          { id: "t2", section: "Video and sound", text: "Level the voice", owner: "u_mika", done: true, doneBy: "u_mika", doneAt: at(1 * D), src: "", out: "", notes: [] },
          { id: "t3", section: "Captions and graphics", text: "Burn in captions", owner: "u_mika", done: true, doneBy: "u_mika", doneAt: at(22 * H), src: "", out: "", notes: [] },
          { id: "t4", section: "Final checks", text: "Play through on a phone", owner: "u_mika", done: true, doneBy: "u_mika", doneAt: at(21 * H), src: "", out: "", notes: [] },
        ],
        history: [{ at: at(4 * D), by: "u_jordan", action: "Requested this video" }] },
      { id: "v_pod", ws: "ws_hb", projectId: "p_podcast", reviewId: "rv_pod", requestId: "r_pod", title: "Harborline Talks — Ep. 12", editorId: "u_sam",
        original: { media: "podcast", label: "Original recording" },
        instructions: { brief: "45-minute interview with two coaches. Clean the lav audio, cut the 4-minute tangent at 12:30, add chapter markers.",
          brand: ["Harborline teal lower thirds", "Intro sting from the brand kit"], deliverables: [{ label: "Full episode, 16:9", preset: "yt" }, { label: "Three 45-second highlights", preset: "reels" }],
          visual: "Two-camera switch on the speaker; wide shot for laughs.", audio: "Noise reduction on the lav; −16 LUFS for the episode.", captions: "Captions on highlights only." },
        checklist: [
          { id: "t1", section: "Before editing", text: "Sync cameras and lav audio", owner: "u_sam", done: false, src: "", out: "", notes: [] },
          { id: "t2", section: "Video and sound", text: "Cut the tangent", owner: "u_sam", done: false, src: "00:12:30", out: "", notes: [] },
          { id: "t3", section: "Captions and graphics", text: "Lower thirds for both coaches", owner: "u_sam", done: false, src: "", out: "", notes: [] },
          { id: "t4", section: "Final checks", text: "Chapter markers in the description", owner: "u_sam", done: false, src: "", out: "", notes: [] },
        ],
        history: [{ at: at(30 * H), by: "u_priya", action: "Requested this video" }] },
    ],
    templates: [
      { id: "tpl_reels", ws: "ws_nw", name: "Reel cut-down pack", by: "u_admin", at: at(10 * D),
        instructions: { visual: "Product in the first two seconds. Three cuts per 5 seconds maximum.", audio: "Music ducked under voice; −14 LUFS.", captions: "Burned in, white, sentence case." },
        outputs: ["reels"], brand: ["Logo bug top-right"], checklist: [
          { section: "Before editing", text: "Pick three strongest moments" }, { section: "Captions and graphics", text: "Burn in captions" }, { section: "Final checks", text: "Play through on a phone" }] },
    ],
    announcements: [
      { id: "an_tut", kind: "Tutorial", title: "New tutorial: giving frame-accurate feedback", body: "Pause, draw a box, say what should change. Five minutes.", link: "lesson-l_review", at: at(1 * D) },
      { id: "an_trend", kind: "Trending", title: "Trending: “how it's made” clips", body: "Behind-the-scenes process clips are getting saved and shared more this month (fictional demo trend).", link: "ask", at: at(2 * D) },
    ],
    dismissed: {},
    // Thought-leadership spotlight: approved, scheduled entries; each runs for 14 days from its start date.
    spotlights: [
      { id: "sp_1", title: "Why every brand needs a point of view on video", author: "Avery Hart, Menapoly Digital", start: inDays(-20), approved: true,
        body: "Audiences remember a perspective, not a product list. Start each piece with the opinion only you can hold.", lessonId: "l_hooks" },
      { id: "sp_2", title: "Write for the question, not the keyword", author: "Avery Hart, Menapoly Digital", start: inDays(-6), approved: true,
        body: "AI assistants quote pages that answer a question in the first two sentences. Lead with the answer, then the proof.", lessonId: "l_aiv" },
      { id: "sp_3", title: "One shoot, twelve posts", author: "Menapoly Digital", start: inDays(8), approved: true,
        body: "Plan the cut-downs before you film so every recording feeds a month of content.", lessonId: "l_repurpose" },
      { id: "sp_draft", title: "Draft: video trends for 2027", author: "Menapoly Digital", start: inDays(-3), approved: false, body: "Not approved yet — never shown." },
    ],
    posts: [
      { id: "s_launch", ws: "ws_nw", assetId: "a_launch_v2", status: "Draft", rev: 1, scheduledFor: inDays(6), by: "u_jordan", at: at(5 * H), submittedBy: null, reviewerId: null,
        captions: { linkedin: "Meet our Spring single-origin line, roasted in small batches in Portland. #specialtycoffee",
          instagram: "Spring is in the cup ☕️ Our new single-origin line lands this week.", x: "Spring single-origin line lands this week ☕️" },
        platforms: ["linkedin", "instagram", "x"], history: [{ at: at(5 * H), by: "u_jordan", action: "Created draft", rev: 1 }] },
      { id: "s_reel", ws: "ws_nw", assetId: "a_reel", status: "Approved", rev: 1, scheduledFor: inDays(2), by: "u_admin", at: at(14 * H), submittedBy: "u_admin", reviewerId: "u_jordan",
        captions: { instagram: "Tip 1: weigh your beans. 18 g in, 300 g out.", tiktok: "Brew tip #1: weigh it, don't scoop it.", youtube: "Brew Tips #1 — weigh your beans" },
        platforms: ["instagram", "tiktok", "youtube"], history: [{ at: at(15 * H), by: "u_admin", action: "Submitted for review", rev: 1 }, { at: at(14 * H), by: "u_jordan", action: "Approved", rev: 1 }] },
    ],
    feed: [
      { id: "fd1", ws: "ws_nw", kind: "deliverable", by: "u_sam", at: at(6 * H), text: "Version 2 of the Spring Launch hero spot is ready for review.",
        assetId: "a_launch_v2", reviewId: "rv_launch", comments: [{ by: "u_jordan", body: "Watching now!", at: at(5 * H) }], saves: [] },
      { id: "fd2", ws: "ws_nw", kind: "approved", by: "u_jordan", at: at(16 * H), text: "Approved Brew Tips reel 01. On to the next five.",
        assetId: "a_reel", comments: [], saves: ["u_admin"] },
      { id: "fd3", ws: "ws_hb", kind: "upload", by: "u_priya", at: at(30 * H), text: "Uploaded the Episode 12 recordings (video + lav mic).",
        assetId: "a_pod_raw", comments: [], saves: [] },
      { id: "fd4", ws: "ws_nw", kind: "coaching", by: "u_admin", at: at(2 * D), text: "October coaching recap: lead with the product in the first two seconds of every reel.",
        lessonId: "l_hooks", comments: [], saves: [] },
    ],
    lessons: [
      { id: "l_start", track: "Onboarding", title: "Your first week in Menapoly Cue", minutes: 6, kind: "video", media: "coaching",
        body: "Tour the Studio, upload your first footage, and send an editing request." },
      { id: "l_brief", track: "Media Studio", title: "Writing a brief editors love", minutes: 8, kind: "guide",
        body: "State the goal, the audience, must-keep moments, the deadline and where it will run. One sentence each." },
      { id: "l_review", track: "Media Studio", title: "Giving frame-accurate feedback", minutes: 5, kind: "guide",
        body: "Pause on the frame, draw a box around what should change, and say what it should become." },
      { id: "l_hooks", track: "Content strategy", title: "Hooks for the first two seconds", minutes: 7, kind: "video", media: "coaching",
        body: "Lead with the product or the payoff, then explain. Test two openings per reel." },
      { id: "l_repurpose", track: "Content strategy", title: "One shoot, twelve posts", minutes: 9, kind: "guide",
        body: "Plan cut-downs, quotes, stills and captions before the shoot so every recording feeds a month of posts." },
      { id: "l_aiv", track: "AI Visibility", title: "How AI assistants pick sources", minutes: 10, kind: "guide",
        body: "Assistants cite pages that answer a question directly, show expertise and are easy to quote. Write for the question." },
      { id: "l_reports", track: "AI Visibility", title: "Reading your visibility report", minutes: 6, kind: "guide",
        body: "Start with the trend, then the prompts you're missing, then the recommended actions." },
      { id: "l_session", track: "Monthly sessions", title: "November coaching session pack", minutes: 4, kind: "guide",
        body: "Agenda, last month's numbers (fictional in this preview) and three questions to bring." },
    ],
    progress: { u_jordan: { l_start: 100, l_brief: 100, l_hooks: 40 }, u_priya: { l_start: 60 } },
    notifications: [
      { id: "n1", to: "u_jordan", at: at(6 * H), text: "Version 2 of Spring Launch is ready for your review.", link: "review-rv_launch", read: false },
      { id: "n2", to: "u_admin", at: at(30 * H), text: "Harborline submitted an editing request: Episode 12.", link: "studio", read: false },
      { id: "n3", to: "u_sam", at: at(30 * H), text: "You were assigned: Harborline Talks — Ep. 12.", link: "project-p_podcast", read: false },
      { id: "n4", to: "u_jordan", at: at(2 * D), text: "New coaching lesson: Hooks for the first two seconds.", link: "lesson-l_hooks", read: true },
      { id: "n5", to: "u_priya", at: at(28 * H), text: "Your request for Episode 12 was received.", link: "project-p_podcast", read: false },
    ],
    activity: [],
    chat: {},
    proposals: [],
  };
}

/* ---------- AI Visibility fixtures (FICTIONAL DEMO DATA) ---------- */
// Deterministic pseudo-random series so the charts look plausible but are obviously invented and stable across reloads.
function series(seedNum, n, base, drift, noise) {
  let s = seedNum, out = [];
  for (let i = 0; i < n; i++) {
    s = (s * 9301 + 49297) % 233280;
    out.push(Math.max(0, Math.round(base + drift * i + (s / 233280 - 0.5) * noise)));
  }
  return out;
}

export function visibilityFixtures(wsId, weeks) {
  const k = wsId === "ws_nw" ? 1 : 0.55;
  const n = weeks;
  return {
    weeks: Array.from({ length: n }, (_, i) => `W${i + 1}`),
    mentions: series(11 * k * 100, n, 40 * k, 2.4 * k, 18 * k),
    citations: series(23 * k * 100, n, 12 * k, 1.1 * k, 8 * k),
    visits: series(37 * k * 100, n, 2400 * k, 60 * k, 600 * k),
    aiReferrals: series(41 * k * 100, n, 60 * k, 6 * k, 30 * k),
    prompts: [
      { category: wsId === "ws_nw" ? "Best single-origin coffee" : "Boutique gym near me", covered: 7, total: 12 },
      { category: wsId === "ws_nw" ? "How to brew pour-over" : "Beginner strength classes", covered: 9, total: 10 },
      { category: wsId === "ws_nw" ? "Ethical coffee roasters" : "Gym membership pricing", covered: 3, total: 9 },
      { category: wsId === "ws_nw" ? "Coffee gift ideas" : "Personal training benefits", covered: 2, total: 8 },
    ],
    sources: [
      { title: wsId === "ws_nw" ? "Pour-over guide (your site)" : "Class schedule page (your site)", type: "Owned", share: 34 },
      { title: "Local news feature", type: "Earned", share: 22 },
      { title: "Review platform listing", type: "Third-party", share: 19 },
      { title: "YouTube tutorial (your channel)", type: "Owned", share: 15 },
      { title: "Forum thread", type: "Community", share: 10 },
    ],
    competitors: wsId === "ws_nw"
      ? [{ name: "You (Northwind)", sov: 31 }, { name: "Competitor A", sov: 27 }, { name: "Competitor B", sov: 22 }, { name: "Competitor C", sov: 20 }]
      : [{ name: "You (Harborline)", sov: 18 }, { name: "Competitor A", sov: 35 }, { name: "Competitor B", sov: 29 }, { name: "Competitor C", sov: 18 }],
    social: [
      { platform: "Instagram", engagement: 4.8 * k, posts: Math.round(14 * k), growth: 3.1 },
      { platform: "LinkedIn", engagement: 2.9 * k, posts: Math.round(8 * k), growth: 1.6 },
      { platform: "TikTok", engagement: 6.2 * k, posts: Math.round(10 * k), growth: 5.4 },
      { platform: "YouTube", engagement: 3.4 * k, posts: Math.round(4 * k), growth: 0.9 },
    ],
    formats: [{ format: "Short vertical", value: 62 }, { format: "Long-form", value: 21 }, { format: "Stills", value: 17 }],
    video: { produced: Math.round(18 * k), avgWatch: Math.round(41 * k), completion: Math.round(48 * k) },
    actions: wsId === "ws_nw"
      ? [{ p: "High", t: "Publish a 'How to brew pour-over' answer page with your v2 hero clip embedded", why: "You're cited on 9 of 10 brewing prompts but not on gifting." },
         { p: "High", t: "Cut the Spring Launch hero into three 20-second reels", why: "Short vertical is 62% of engagement in this demo data." },
         { p: "Medium", t: "Add an FAQ on sourcing and fair pay", why: "Lowest coverage: 'Ethical coffee roasters' (3 of 9 prompts)." },
         { p: "Low", t: "Refresh the YouTube channel description", why: "Owned video is 15% of cited sources." }]
      : [{ p: "High", t: "Publish a clear pricing page", why: "Lowest coverage: 'Gym membership pricing'." },
         { p: "Medium", t: "Turn Episode 12 into three highlight clips", why: "Repurposes footage you already have." }],
  };
}
