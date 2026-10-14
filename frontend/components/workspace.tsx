"use client";
// UI state shared by Cue Simple and Cue Pro (what the player shows, which panel is open).
import { createContext, useContext } from "react";

export type PreviewTarget = { kind: "edit" } | { kind: "proposal"; id: string; index: number } | { kind: "render"; id: string };
export type MobileTab = "cue" | "preview" | "files";
export type Mode = "simple" | "pro";

export type Workspace = {
  mode: Mode; setMode: (m: Mode) => void;
  preview: PreviewTarget; setPreview: (p: PreviewTarget) => void;
  mobileTab: MobileTab; setMobileTab: (t: MobileTab) => void;
  openBrief: () => void; openExport: () => void; openVersions: () => void;
};

export const WorkspaceCtx = createContext<Workspace | null>(null);
export const useWorkspace = () => {
  const w = useContext(WorkspaceCtx);
  if (!w) throw new Error("useWorkspace outside provider");
  return w;
};
