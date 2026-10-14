# Usability review — 2026-10-14

**Method:** I captured the real app on desktop (1440 px) and phone (390 px) through the critical journey: Home → New project → upload → ask Cue → proposal → approve → project details → reviews → delivery → inbox. I then fixed what slowed down or confused that journey. Every fix is covered by `frontend/e2e/cue-usability.spec.ts` or the earlier specs.

| # | Problem seen in the screenshots | Fix |
|---|---|---|
| 1 | **No way back from the editor.** Inside Cut Cue the only exits were unlabeled icons (scissors, folder). On phones, the app's tab bar disappears there. | A labelled **‹ Project** button (on phones, "Back to project" for screen readers) leads to the project's details. The logo still goes Home on large screens. |
| 2 | **New project buried the upload.** A large empty player filled the screen and the upload area sat below the fold. | With no media yet, the upload area comes first and the empty player is hidden. The player appears once there is media. |
| 3 | **Phone onboarding was long.** Seven steps wrapped to three lines. | Phones show "Step 2 of 7: Upload" plus the one-line hint. Wider screens keep the full trail. |
| 4 | **"Processing." told you nothing.** That was the project overview's whole next-step text. | It now says: "Cue is working on this project… you'll get a notification when it has actually finished." |
| 5 | **Reviews contradicted itself.** It said "Nothing is rendered yet" while a preview was rendering. | It now says "A preview is rendering now. As soon as it has finished, you can share it here." |
| 6 | **Two assistants, same name.** "Cue" (editor) and "Ask Cue" (Home), with jargon ("add a Claude key"). | Each says what it covers: "Edits this project" versus "Across all your projects". Modes are worded "simple built-in mode (connect Claude in Settings)". |
| 7 | **Unclear theme icon.** It used the compare icon for "match device". | A monitor icon, with the label "Theme: match device". |
| 8 | **No keyboard reference outside the player.** | A searchable **keyboard shortcut guide**: press `?` anywhere, or use the keyboard button in the header or player. `G` then `H`/`P`/`C`/`I`/`L` navigates. All shortcuts come from one list in `lib/shortcuts.ts`. |
| 9 | **Delivery dead end.** Publishing to the client and the state of email or backups were invisible. | Delivery tab: a "Client portal" section that publishes, with approval. Settings: Email notifications (with a test send), Client portal status, and Backups (Back up now plus a verified list). |

## Still worth doing (not done this round)

- **Merge the two assistants.** Ask Cue on Home could hand a project-specific request straight into that project's Cut Cue chat.
- **One persistent app shell.** Each page mounts its own shell, so a keystroke typed during navigation can be lost (seen with fast `G` chords in tests).
- **Drag-and-drop on the project card.** Dropping a file onto a project in the Projects list would upload it there.
- **A real phone test.** None of these changes has been tried on your iPhone yet (checklist step 15).
