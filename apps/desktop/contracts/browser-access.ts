import type { PiDesktopApi } from "./ipc";

/**
 * How a browser client reaches each `window.piApp` member.
 *
 * - `call`: the browser sends the call to its bridge window, which invokes the real preload
 *   method and returns the result.
 * - `event`: the bridge window subscribes once and forwards every event to the browser.
 * - `local`: the browser answers without the host (static values or browser equivalents).
 * - `blocked`: the member acts on the host's own screen or devices (native pickers, Finder,
 *   OS permissions, window controls), so the browser rejects it.
 *
 * The `satisfies` clause makes every member of `PiDesktopApi` choose a policy.
 */
export type BrowserAccessPolicy = "call" | "event" | "local" | "blocked";

export const browserAccessPolicy = {
  platform: "local",
  drawsWindowControls: "local",
  versions: "local",
  ping: "call",
  getState: "call",
  getTaskWorkbenchTemplate: "call",
  saveTaskWorkbenchTemplate: "call",
  onStateChanged: "event",
  getSelectedTranscript: "call",
  onSelectedTranscriptChanged: "event",
  resendSelectedTranscript: "call",
  onExtensionUiChanged: "event",
  onCommand: "event",
  onWorkspacePicked: "event",
  onClipboardImagePasted: "event",
  getPathForFile: "local",
  addWorkspacePath: "call",
  pickWorkspace: "blocked",
  selectWorkspace: "call",
  renameWorkspace: "call",
  removeWorkspace: "call",
  reorderWorkspaces: "call",
  reorderPinnedSessions: "call",
  openWorkspaceInFinder: "blocked",
  listEditors: "call",
  setPreferredEditor: "call",
  openWorkspaceInEditor: "blocked",
  createWorktree: "call",
  removeWorktree: "call",
  openSkillInFinder: "blocked",
  openExtensionInFinder: "blocked",
  syncCurrentWorkspace: "call",
  selectSession: "call",
  renameSession: "call",
  archiveSession: "call",
  unarchiveSession: "call",
  markSessionRead: "call",
  setSessionPinned: "call",
  createSession: "call",
  startThread: "call",
  forkThread: "call",
  sendChildThreadFollowUp: "call",
  setChildSupervisionLoop: "call",
  createScheduledTask: "call",
  updateScheduledTask: "call",
  deleteScheduledTask: "call",
  beginScheduledTaskInterview: "call",
  cancelCurrentRun: "call",
  setActiveView: "call",
  setSidebarCollapsed: "call",
  setThreadGrouping: "call",
  setWorkspaceCollapsed: "call",
  refreshRuntime: "call",
  setModelSettingsScopeMode: "call",
  setDefaultModel: "call",
  setDefaultThinkingLevel: "call",
  setSessionModel: "call",
  setSessionThinkingLevel: "call",
  loginProvider: "blocked",
  logoutProvider: "call",
  setProviderApiKey: "call",
  listCustomProviders: "call",
  setCustomProvider: "call",
  deleteCustomProvider: "call",
  probeCustomProviderModels: "call",
  setEnableSkillCommands: "call",
  setScopedModelPatterns: "call",
  setSkillEnabled: "call",
  setExtensionEnabled: "call",
  listMcpServers: "call",
  addMcpServer: "call",
  removeMcpServer: "call",
  setMcpServerEnabled: "call",
  setCodemodeAlwaysOn: "call",
  respondToHostUiRequest: "call",
  setNotificationPreferences: "call",
  setIntegratedTerminalShell: "call",
  setEnableTransparency: "call",
  setThemePresetId: "call",
  ensureTerminalPanel: "call",
  createTerminalSession: "call",
  setActiveTerminalSession: "call",
  writeTerminal: "call",
  resizeTerminal: "call",
  restartTerminalSession: "call",
  closeTerminalSession: "call",
  setTerminalTitle: "call",
  setTerminalFocused: "call",
  setSidePanelFocused: "call",
  onTerminalData: "event",
  onTerminalExit: "event",
  onTerminalError: "event",
  getNotificationPermissionStatus: "local",
  requestNotificationPermission: "local",
  openSystemNotificationSettings: "blocked",
  onNotificationPermissionStatusChanged: "local",
  pickComposerAttachments: "blocked",
  readClipboardImage: "local",
  addComposerAttachments: "call",
  removeComposerAttachment: "call",
  editQueuedComposerMessage: "call",
  cancelQueuedComposerEdit: "call",
  removeQueuedComposerMessage: "call",
  steerQueuedComposerMessage: "call",
  persistComposerDraft: "call",
  updateComposerDraft: "call",
  onPendingComposerDraftFlush: "local",
  submitComposer: "call",
  getSessionTree: "call",
  navigateSessionTree: "call",
  listWorkspaceFiles: "call",
  readWorkspaceFile: "call",
  revealWorkspaceFile: "blocked",
  getChangedFiles: "call",
  getFileDiff: "call",
  stageFile: "call",
  onExtensionViewOpenFile: "local",
  runExtensionAction: "call",
  listExtensionViews: "local",
  openExtensionView: "blocked",
  sendExtensionViewMessage: "blocked",
  closeExtensionView: "local",
  onExtensionViewMessage: "local",
  onExtensionViewCatalogChanged: "local",
  getTurnChanges: "call",
  getReview: "call",
  getReviewFile: "call",
  setReviewFileReviewed: "call",
  changeReviewFileStage: "call",
  toggleWindowMaximize: "local",
  minimizeWindow: "local",
  closeWindow: "local",
  openExternal: "local",
  getThemeMode: "call",
  getResolvedTheme: "call",
  setThemeMode: "call",
  onThemeChanged: "event",
  onWindowFocused: "local",
  relaunchApplication: "blocked",
} as const satisfies Record<keyof PiDesktopApi, BrowserAccessPolicy>;

export type BrowserAccessMember = keyof typeof browserAccessPolicy;

function membersWithPolicy(policy: BrowserAccessPolicy): readonly BrowserAccessMember[] {
  return (Object.keys(browserAccessPolicy) as BrowserAccessMember[]).filter(
    (member) => browserAccessPolicy[member] === policy,
  );
}

export const browserAccessCallMembers = membersWithPolicy("call");
export const browserAccessEventMembers = membersWithPolicy("event");
export const browserAccessBlockedMembers = membersWithPolicy("blocked");

/** Path prefix the host reserves for browser access; the renderer build lives outside it. */
export const BROWSER_ACCESS_PREFIX = "/__pi-browser";

/**
 * Frames on both sockets. A browser tab and its bridge window exchange the same shapes, so the
 * host only relays them. `id` correlates a call with its result.
 */
export type BrowserAccessFrame =
  | { readonly t: "call"; readonly id: number; readonly m: string; readonly a: readonly unknown[] }
  | {
      readonly t: "result";
      readonly id: number;
      readonly ok: boolean;
      readonly v?: unknown;
      readonly e?: string;
    }
  | { readonly t: "event"; readonly m: string; readonly p: readonly unknown[] }
  /** Host to browser: the tab is attached to a bridge window (`resumed` when reattached). */
  | { readonly t: "ready"; readonly resumed: boolean };
