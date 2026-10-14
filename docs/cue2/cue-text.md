# Cue Text (SMS/MMS) — architecture and status

**Status: intake pipeline implemented and tested with a simulator and locally computed signatures. No provider account
was used, no real text was received, and nothing can be sent.**

## Flow

```
Phone ──SMS/MMS──▶ Provider (dedicated number) ──HTTPS POST (signed)──▶ /api/public/text/twilio
   1. 503 unless CUE_TEXT_PROVIDER/NUMBER/AUTH_TOKEN/WEBHOOK_URL are all set
   2. verify X-Twilio-Signature = base64(HMAC-SHA1(auth_token, webhook_url + sorted form fields)) → 403, store nothing
   3. dedupe on (provider, MessageSid) — provider retries are no-ops
   4. store message (audit history) → process:
        STOP/UNSUBSCRIBE/… → opt-out recorded       START → opt back in       HELP → help draft
        unknown or non-consented number → stored as rejected, owner notified once/day, nothing else
        opted-out number → stored, ignored
        "new project NAME"          → proposed create_project action (Inbox → Approvals)
        "changes: …" / "revise: …"  → proposed request_revision on the named (or most recent) project
        "status [project]"          → status reply drafted
        attachments                 → recorded (URLs + types); owner told to use an upload link
        anything else               → saved as a note, owner notified
   5. processing errors → status "error", retry from Inbox → Texts
   6. replies are stored as status draft_not_sent — never transmitted
```

## Consent and sender rules

- Approved senders are added in Settings → Cue Text with a mandatory confirmation that the person agreed to text with
  Menapoly Cue and knows about STOP. The consent time and note are stored.
- Only approved, non-opted-out numbers can create proposals; every proposal still needs owner approval.

## What is needed before real use

1. A provider account and a dedicated number (Twilio is the adapter shape implemented; others need an adapter).
2. A public HTTPS URL for this computer (e.g. a tunnel) → `CUE_TEXT_WEBHOOK_URL`, and the provider's signing secret →
   `CUE_TEXT_AUTH_TOKEN`.
3. US A2P 10DLC / toll-free verification or local equivalent, opt-in records, and a privacy statement.
4. Then a sender adapter (not written) that: checks consent and opt-out, rate-limits, requires the `send_text` action
   to be approved, and records provider message IDs and delivery callbacks.
5. MMS media download needs provider credentials; until then use upload links (Project → Media → Upload from a phone).

## Tests

`backend/tests/test_cue_text.py`: signature scheme, webhook 503/403/200 and dedupe, consent requirement, unknown senders,
STOP/START/HELP, intents → proposals, drafts never sent, failure recording and retry. `frontend/e2e/cue-workflow.spec.ts`
drives the Settings simulator and approves the resulting action from Inbox.
