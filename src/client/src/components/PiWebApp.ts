import { LitElement, html } from "lit";
import { customElement, query, state } from "lit/decorators.js";
import { api, type Project, type SessionInfo, type Workspace } from "../api";
import { initialAppState, type AppState } from "../appState";
import { ProjectController } from "../controllers/projectController";
import { SessionController } from "../controllers/sessionController";
import { WorkspaceController } from "../controllers/workspaceController";
import { readRoute, writeRoute } from "../route";
import "./ProjectList";
import "./WorkspaceList";
import "./SessionList";
import "./ChatView";
import type { ChatView } from "./ChatView";
import "./PromptEditor";
import type { PromptEditor } from "./PromptEditor";
import "./StatusBar";
import "./CommandPicker";
import "./WorkspacePanel";
import { appStyles } from "./shared";

@customElement("pi-web-poc")
export class PiWebApp extends LitElement {
  @state() private state: AppState = initialAppState();
  @query("chat-view") private chatView?: ChatView;
  @query("prompt-editor") private promptEditor?: PromptEditor;

  private readonly sessions = new SessionController(
    () => this.state,
    (patch) => { this.setState(patch); },
    () => { this.updateUrl(); },
  );
  private readonly workspaces = new WorkspaceController(
    () => this.state,
    (patch) => { this.setState(patch); },
    () => { this.updateUrl(); },
    this.sessions,
  );
  private readonly projects = new ProjectController(
    () => this.state,
    (patch) => { this.setState(patch); },
    this.workspaces,
  );
  private readonly onPopState = () => void this.withChatScrollTransition(() => this.restoreRoute(false));
  private gitPollTimer: number | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("popstate", this.onPopState);
    this.sessions.connectStatusUpdates();
    void this.loadProjectsAndRestoreRoute();
  }

  override disconnectedCallback(): void {
    window.removeEventListener("popstate", this.onPopState);
    this.sessions.dispose();
    if (this.gitPollTimer !== undefined) window.clearInterval(this.gitPollTimer);
    super.disconnectedCallback();
  }

  private setState(patch: Partial<AppState>) {
    const previous = this.state;
    this.state = { ...this.state, ...patch };
    this.handleActivityTransition(previous, this.state);
    this.handleWorkspaceChange(previous, this.state);
  }

  private async loadProjectsAndRestoreRoute() {
    await this.projects.loadProjects();
    await this.withChatScrollTransition(() => this.restoreRoute(false));
  }

  private async restoreRoute(updateUrl: boolean) {
    const route = readRoute();
    this.setState({ workspaceTool: route.tool ?? this.state.workspaceTool, mainView: route.view ?? this.state.mainView, selectedFilePath: route.file, selectedDiffPath: route.diff });
    if (route.projectId === undefined || route.projectId === "") return;
    const project = this.state.projects.find((p) => p.id === route.projectId);
    if (!project) return;
    await this.workspaces.selectProject(project, { workspaceId: route.workspaceId, sessionId: route.sessionId, updateUrl });
    if (route.tool === "files") await this.refreshFiles();
    if (route.file !== undefined) await this.selectFile(route.file);
    if (route.tool === "git") await this.refreshGit();
    if (route.diff !== undefined) await this.selectDiff(route.diff);
    this.updateGitPolling();
  }

  private async withChatScrollTransition(action: () => Promise<void>) {
    this.chatView?.saveScrollPosition();
    await action();
    await this.updateComplete;
    await this.chatView?.updateComplete;
    await nextFrame();
    this.chatView?.restoreScrollPosition();
    this.promptEditor?.focusInput();
  }

  private async withChatPrependTransition(action: () => Promise<void>) {
    const anchor = this.chatView?.capturePrependScrollAnchor();
    await action();
    await this.updateComplete;
    await this.chatView?.updateComplete;
    await nextFrame();
    this.chatView?.restorePrependScrollAnchor(anchor);
  }

  private updateUrl() {
    writeRoute({
      projectId: this.state.selectedProject?.id,
      workspaceId: this.state.selectedWorkspace?.id,
      sessionId: this.state.selectedSession?.id,
      tool: this.state.workspaceTool,
      view: this.state.mainView,
      file: this.state.selectedFilePath,
      diff: this.state.selectedDiffPath,
    });
  }

  private selectWorkspaceTool(tool: "files" | "git") {
    this.setState({ workspaceTool: tool, mainView: tool });
    this.updateUrl();
    if (tool === "files") void this.refreshFiles();
    else void this.refreshGit();
    this.updateGitPolling();
  }

  private selectMainView(view: "chat" | "files" | "git") {
    this.setState({ mainView: view, workspaceTool: view === "chat" ? this.state.workspaceTool : view });
    this.updateUrl();
    if (view === "files") void this.refreshFiles();
    if (view === "git") void this.refreshGit();
    this.updateGitPolling();
  }

  private async refreshFiles() {
    const project = this.state.selectedProject;
    const workspace = this.state.selectedWorkspace;
    if (!project || !workspace) return;
    try {
      const root = await api.workspaceTree(project.id, workspace.id);
      const expanded = { ...this.state.expandedDirs };
      await Promise.all(Object.keys(expanded).map(async (path) => { expanded[path] = (await api.workspaceTree(project.id, workspace.id, path)).entries; }));
      this.setState({ fileTree: root.entries, expandedDirs: expanded, fileTreeStale: false, error: "" });
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  private async expandDir(path: string) {
    const project = this.state.selectedProject;
    const workspace = this.state.selectedWorkspace;
    if (!project || !workspace) return;
    if (this.state.expandedDirs[path] !== undefined) {
      this.setState({ expandedDirs: omitKey(this.state.expandedDirs, path) });
      return;
    }
    try {
      const response = await api.workspaceTree(project.id, workspace.id, path);
      this.setState({ expandedDirs: { ...this.state.expandedDirs, [path]: response.entries }, error: "" });
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  private async selectFile(path: string) {
    const project = this.state.selectedProject;
    const workspace = this.state.selectedWorkspace;
    if (!project || !workspace) return;
    this.setState({ selectedFilePath: path, selectedFileContent: undefined, workspaceTool: "files", mainView: this.state.mainView === "chat" ? "chat" : "files" });
    this.updateUrl();
    try {
      this.setState({ selectedFileContent: await api.workspaceFile(project.id, workspace.id, path), error: "" });
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  private async refreshGit() {
    const project = this.state.selectedProject;
    const workspace = this.state.selectedWorkspace;
    if (!project || !workspace) return;
    try {
      const status = await api.gitStatus(project.id, workspace.id);
      this.setState({ gitStatus: status, gitStale: false, error: "" });
      if (this.state.selectedDiffPath !== undefined && status.files.some((file) => file.path === this.state.selectedDiffPath)) await this.refreshDiff(this.state.selectedDiffPath);
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  private async selectDiff(path: string) {
    this.setState({ selectedDiffPath: path, selectedDiff: undefined, workspaceTool: "git", mainView: this.state.mainView === "chat" ? "chat" : "git" });
    this.updateUrl();
    await this.refreshDiff(path);
  }

  private async refreshDiff(path: string) {
    const project = this.state.selectedProject;
    const workspace = this.state.selectedWorkspace;
    if (!project || !workspace) return;
    try {
      this.setState({ selectedDiff: await api.gitDiff(project.id, workspace.id, { path }), error: "" });
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  private handleWorkspaceChange(previous: AppState, next: AppState) {
    if (previous.selectedWorkspace?.id === next.selectedWorkspace?.id || next.selectedWorkspace === undefined) return;
    if (next.workspaceTool === "files") void this.refreshFiles();
    if (next.workspaceTool === "git") void this.refreshGit();
    this.updateGitPolling();
  }

  private handleActivityTransition(previous: AppState, next: AppState) {
    const wasActive = isActive(previous.status);
    const nowActive = isActive(next.status);
    if (wasActive && !nowActive) {
      this.setState({ fileTreeStale: true, gitStale: true });
      if (this.state.workspaceTool === "files") void this.refreshFiles();
      if (this.state.workspaceTool === "git") void this.refreshGit();
    }
  }

  private updateGitPolling() {
    if (this.gitPollTimer !== undefined) window.clearInterval(this.gitPollTimer);
    this.gitPollTimer = undefined;
    if (this.state.workspaceTool === "git" || this.state.mainView === "git") {
      this.gitPollTimer = window.setInterval(() => { void this.refreshGit(); }, 8000);
    }
  }

  private renderWorkspacePanel() {
    return html`<workspace-panel .workspace=${this.state.selectedWorkspace} .tool=${this.state.workspaceTool} .fileTree=${this.state.fileTree} .expandedDirs=${this.state.expandedDirs} .selectedFilePath=${this.state.selectedFilePath} .selectedFileContent=${this.state.selectedFileContent} .fileTreeStale=${this.state.fileTreeStale} .gitStatus=${this.state.gitStatus} .selectedDiffPath=${this.state.selectedDiffPath} .selectedDiff=${this.state.selectedDiff} .gitStale=${this.state.gitStale} .onSelectTool=${(tool: "files" | "git") => { this.selectWorkspaceTool(tool); }} .onRefreshFiles=${() => this.refreshFiles()} .onExpandDir=${(path: string) => this.expandDir(path)} .onSelectFile=${(path: string) => this.selectFile(path)} .onRefreshGit=${() => this.refreshGit()} .onSelectDiff=${(path: string) => this.selectDiff(path)}></workspace-panel>`;
  }

  override render() {
    const state = this.state;
    return html`
      <div class="shell">
        <aside>
          <header>
            <strong>Pi Web POC</strong>
            <button @click=${() => this.projects.addProject()}>+ Project</button>
          </header>
          <project-list .projects=${state.projects} .selected=${state.selectedProject} .onSelect=${(project: Project) => this.withChatScrollTransition(() => this.workspaces.selectProject(project))}></project-list>
          <workspace-list .workspaces=${state.workspaces} .selected=${state.selectedWorkspace} .onSelect=${(workspace: Workspace) => this.withChatScrollTransition(() => this.workspaces.selectWorkspace(workspace))}></workspace-list>
          <session-list .sessions=${state.sessions} .statuses=${state.sessionStatuses} .activities=${state.sessionActivities} .selected=${state.selectedSession} .canStart=${!!state.selectedWorkspace} .onStart=${() => this.withChatScrollTransition(() => this.sessions.startSession())} .onSelect=${(session: SessionInfo) => this.withChatScrollTransition(() => this.sessions.selectSession(session))} .onArchive=${(session: SessionInfo) => this.sessions.archiveSession(session)} .onRestore=${(session: SessionInfo) => this.sessions.restoreSession(session)}></session-list>
        </aside>
        <main class=${`${state.mainView}-view`}>
          <div class="mobile-tabs">
            <button class=${state.mainView === "chat" ? "selected" : ""} @click=${() => { this.selectMainView("chat"); }}>Chat</button>
            <button class=${state.mainView === "files" ? "selected" : ""} @click=${() => { this.selectMainView("files"); }}>Files</button>
            <button class=${state.mainView === "git" ? "selected" : ""} @click=${() => { this.selectMainView("git"); }}>Git</button>
          </div>
          ${state.error ? html`<div class="error">${state.error}</div>` : null}
          ${state.selectedSession ? html`
            <chat-view .sessionId=${state.selectedSession.id} .messages=${state.messages} .messageStart=${state.messagePageStart} .messageTotal=${state.messagePageTotal} .hasMore=${state.messagePageStart > 0} .loadingMore=${state.isLoadingEarlierMessages} .isCompacting=${state.status?.isCompacting === true} .pendingMessageCount=${state.status?.pendingMessageCount ?? 0} .onLoadMore=${() => this.withChatPrependTransition(() => this.sessions.loadEarlierMessages())}></chat-view>
            <prompt-editor .sessionId=${state.selectedSession.id} .cwd=${state.selectedWorkspace?.path} .disabled=${state.selectedSession.archived === true} .canSteer=${state.status?.isStreaming === true} .isCompacting=${state.status?.isCompacting === true} .canStop=${state.status?.isStreaming === true || state.status?.isBashRunning === true || state.status?.isCompacting === true} .onSend=${(text: string, streamingBehavior?: "steer" | "followUp") => this.sessions.send(text, streamingBehavior)} .onStop=${() => this.sessions.stopActiveWork()}></prompt-editor>
            <status-bar .status=${state.status} .activity=${state.activity} .workspace=${state.selectedWorkspace}></status-bar>
            ${state.commandDialog !== undefined ? html`<command-picker .title=${state.commandDialog.title} .options=${state.commandDialog.options} .onPick=${(value: string) => this.sessions.respondToCommand(state.commandDialog?.requestId ?? "", value)} .onCancel=${() => { this.sessions.cancelCommand(); }}></command-picker>` : null}
          ` : html`<div class="empty">Select or start a session.</div>`}
          <div class="mobile-panel">${this.renderWorkspacePanel()}</div>
        </main>
        ${this.renderWorkspacePanel()}
      </div>
    `;
  }

  static override styles = appStyles;
}

function isActive(status: AppState["status"]): boolean {
  return status?.isStreaming === true || status?.isBashRunning === true || status?.isCompacting === true;
}

function omitKey<T>(record: Record<string, T>, keyToOmit: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== keyToOmit));
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => { resolve(); }));
}
