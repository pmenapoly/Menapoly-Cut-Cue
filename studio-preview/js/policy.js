// Authorization rules for Menapoly Cue (pure functions, no DOM, no storage).
// In this preview they run in the browser on fictional data; the same rules are the contract the production server
// must enforce (docs/studio/integration-plan.md). Everything is deny-by-default.

export const ROLES = ["admin", "client", "editor"];

// Plan entitlements gate premium modules (AI Visibility depth, reports). Unknown plans get nothing extra.
// revisionsIncluded: formal change-request rounds included per video. A workspace or a project can override it
// (the most specific setting wins); administrators can approve additional rounds with a recorded reason.
export const PLANS = {
  essentials: { label: "Essentials", revisionsIncluded: 2, visibility: ["overview", "search", "website"] },
  growth: { label: "Growth", revisionsIncluded: 3, visibility: ["overview", "search", "website", "social", "video", "competitive", "reports", "actions"] },
};

const inWorkspace = (user, wsId) => user?.role === "client" && (user.workspaceIds || []).includes(wsId);
const assigned = (user, project) => user?.role === "editor" && (project?.editorIds || []).includes(user.id);

/** Can this user see this project at all? */
export function canViewProject(user, project) {
  if (!user || !project) return false;
  if (user.role === "admin") return true;
  if (user.role === "client") return inWorkspace(user, project.ws);
  if (user.role === "editor") return assigned(user, project);
  return false;
}

/** Workspace-level visibility (feed, folders, analytics). Editors only reach workspaces through assigned projects. */
export function canViewWorkspace(user, wsId, projects = []) {
  if (!user) return false;
  if (user.role === "admin") return true;
  if (user.role === "client") return inWorkspace(user, wsId);
  if (user.role === "editor") return projects.some((p) => p.ws === wsId && assigned(user, p));
  return false;
}

/** Media: through its project; workspace-library items (no project) only for admins and that workspace's clients. */
export function canViewAsset(user, asset, project) {
  if (!user || !asset) return false;
  if (asset.projectId) return canViewProject(user, project);
  if (user.role === "admin") return true;
  return inWorkspace(user, asset.ws);
}

/**
 * can(user, action, ctx) — ctx carries the resource and, where needed, its project/workspace.
 * Returns true only for combinations listed here.
 */
export function can(user, action, ctx = {}) {
  if (!user || !ROLES.includes(user.role)) return false;
  const admin = user.role === "admin";
  const client = (ws) => inWorkspace(user, ws);
  const ws = ctx.ws ?? ctx.project?.ws ?? ctx.resource?.ws;
  switch (action) {
    case "project.view": return canViewProject(user, ctx.project);
    case "project.assign": return admin;
    case "asset.view": return canViewAsset(user, ctx.resource, ctx.project);
    case "asset.upload":
      return admin || client(ws) || (ctx.project ? assigned(user, ctx.project) : false);
    case "folder.create": case "folder.move": return admin || client(ws);
    case "request.create": return admin || client(ws);
    case "request.view": return canViewProject(user, ctx.project);
    case "request.assign": return admin;
    case "request.start": return admin || assigned(user, ctx.project);
    // Production board: administrators see every request; editors see only their own queue (filtered by the service).
    case "production.view": return admin || user.role === "editor";
    case "review.view": return canViewProject(user, ctx.project);
    case "review.comment": return canViewProject(user, ctx.project);
    case "review.resolve": return admin || assigned(user, ctx.project) || (client(ws) && ctx.resource?.by === user.id);
    case "review.upload_version": case "review.submit": return admin || assigned(user, ctx.project);
    case "review.decide": return admin || client(ws); // editors never approve their own work
    case "review.assign": return admin || assigned(user, ctx.project); // route feedback to a teammate
    // Editing checklist: production tasks belong to the editing team; clients follow progress and comment.
    case "checklist.update": return admin || assigned(user, ctx.project);
    case "checklist.comment": return canViewProject(user, ctx.project);
    // Templates hold reusable instructions only (never footage or client details), scoped to one workspace.
    case "template.view": return admin || client(ws) || (ctx.projects || []).some((p) => p.ws === ws && assigned(user, p));
    case "template.create": return admin || client(ws) || assigned(user, ctx.project);
    // What happens to a finished video: sharing, feed and new versions are client/admin decisions.
    case "video.share": case "video.feed": case "video.library": return admin || client(ws);
    case "video.another": case "video.translate": return admin || client(ws);
    case "video.download": return canViewProject(user, ctx.project);
    case "feed.view": return canViewWorkspace(user, ws, ctx.projects);
    case "feed.comment": return canViewWorkspace(user, ws, ctx.projects);
    case "post.create": case "post.edit": return admin || client(ws);
    // Social review: reviewers are the workspace's clients and Menapoly admins. The service also refuses self-review:
    // whoever submitted a post can't approve it or request changes on it.
    case "post.review": case "post.approve": return admin || client(ws);
    case "post.schedule": case "post.prepare": return admin;
    // Revision allowances: clients ask for an extra round; only administrators approve one (no billing in the preview).
    case "revision.ask": return admin || client(ws);
    case "revision.grant": return admin;
    // Target delivery dates are estimates set by Menapoly administrators; everyone on the project can see them.
    case "request.schedule": return admin;
    // Upload-first rooms. A room is owned by its project's workspace. Before submission it is the client's draft:
    // editors only see a room once it has an editing request on a project they're assigned to.
    case "room.view": return canViewProject(user, ctx.project) && (user.role !== "editor" || Boolean(ctx.room?.requestId));
    case "room.create": case "brief.edit": case "room.submit": return admin || client(ws);
    case "room.note": return admin || client(ws) || (assigned(user, ctx.project) && Boolean(ctx.room?.requestId));
    case "room.complete": return admin;
    case "visibility.view": {
      if (!(admin || client(ws))) return false;
      const plan = PLANS[ctx.plan];
      return !ctx.module || Boolean(plan?.visibility.includes(ctx.module));
    }
    case "coaching.view": return true;
    case "clients.view": case "team.view": case "audit.view": return admin;
    case "assistant.use": return true;
    default: return false;
  }
}

export class Denied extends Error {
  constructor(action) { super(`Not allowed: ${action}`); this.code = 403; this.action = action; }
}

/** Throwing variant used by the service layer. */
export function enforce(user, action, ctx) {
  if (!can(user, action, ctx)) throw new Denied(action);
}
