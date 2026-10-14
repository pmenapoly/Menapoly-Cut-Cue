// Every keyboard shortcut in the app, in one place. The guide (ShortcutsDialog) renders this list, so it can't drift
// from what is documented; each entry names the component that implements it.
export type Shortcut = { keys: string[]; action: string; where: string };

const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = mac ? "⌘" : "Ctrl";

export const SHORTCUTS: { group: string; items: Shortcut[] }[] = [
  { group: "Anywhere", items: [
    { keys: [`${MOD} K`], action: "Search projects, files and spoken words", where: "shell" },
    { keys: ["?"], action: "Show keyboard shortcuts", where: "shell, editor" },
    { keys: ["G", "H"], action: "Go to Home", where: "shell" },
    { keys: ["G", "P"], action: "Go to Projects", where: "shell" },
    { keys: ["G", "C"], action: "Go to Cut Cue", where: "shell" },
    { keys: ["G", "I"], action: "Go to Inbox", where: "shell" },
    { keys: ["G", "L"], action: "Go to Library", where: "shell" },
    { keys: ["Esc"], action: "Close a dialog or panel", where: "dialogs" },
  ] },
  { group: "Player (Cut Cue)", items: [
    { keys: ["Space"], action: "Play / pause", where: "Player" },
    { keys: ["K"], action: "Play / pause", where: "Player" },
    { keys: ["J"], action: "Back 5 seconds", where: "Player" },
    { keys: ["L"], action: "Forward 5 seconds", where: "Player" },
    { keys: ["←"], action: "Back 1 second", where: "Player" },
    { keys: ["→"], action: "Forward 1 second", where: "Player" },
    { keys: ["Home"], action: "Jump to start", where: "Player" },
    { keys: ["End"], action: "Jump to end", where: "Player" },
    { keys: ["M"], action: "Mute / unmute", where: "Player" },
    { keys: ["C"], action: "Captions on / off", where: "Player" },
    { keys: ["F"], action: "Full screen", where: "Player" },
  ] },
  { group: "Editing (Cut Cue)", items: [
    { keys: [`${MOD} Z`], action: "Undo", where: "editor" },
    { keys: [`⇧ ${MOD} Z`], action: "Redo", where: "editor" },
    { keys: [`${MOD} Y`], action: "Redo", where: "editor" },
  ] },
  { group: "Cue Pro timeline", items: [
    { keys: ["S"], action: "Split at the playhead", where: "Pro" },
    { keys: ["Delete"], action: "Delete the selected cut", where: "Pro" },
    { keys: [`${MOD} S`], action: "Save as a new version", where: "Pro" },
    { keys: ["←", "→"], action: "Select previous / next cut (cut focused)", where: "Timeline" },
    { keys: ["Alt ←", "Alt →"], action: "Move the selected cut earlier / later", where: "Timeline" },
    { keys: ["⇧ ←", "⇧ →"], action: "Trim the cut's end by 0.1 s", where: "Timeline" },
    { keys: ["Enter"], action: "Jump the playhead to the selected cut", where: "Timeline" },
    { keys: ["← / →"], action: "Move the playhead 1 s (timeline ruler focused)", where: "Timeline" },
  ] },
];

export function isTypingTarget(el: EventTarget | null) {
  const t = el as HTMLElement | null;
  return !!t && (t.isContentEditable || ["TEXTAREA", "SELECT"].includes(t.tagName) || (t.tagName === "INPUT" && (t as HTMLInputElement).type !== "range"));
}
