import { LitElement, html, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { FileContentResponse, FileTreeEntry, GitDiffResponse, GitStatusResponse, Workspace } from "../api";
import { workspacePanelStyles } from "./shared";
import "./CodeViewer";

@customElement("workspace-panel")
export class WorkspacePanel extends LitElement {
  @property({ attribute: false }) workspace: Workspace | undefined;
  @property() tool: "files" | "git" = "files";
  @property({ attribute: false }) fileTree: FileTreeEntry[] = [];
  @property({ attribute: false }) expandedDirs: Record<string, FileTreeEntry[]> = {};
  @property({ attribute: false }) selectedFilePath: string | undefined;
  @property({ attribute: false }) selectedFileContent: FileContentResponse | undefined;
  @property({ type: Boolean }) fileTreeStale = false;
  @property({ attribute: false }) gitStatus: GitStatusResponse | undefined;
  @property({ attribute: false }) selectedDiffPath: string | undefined;
  @property({ attribute: false }) selectedDiff: GitDiffResponse | undefined;
  @property({ type: Boolean }) gitStale = false;
  @property({ attribute: false }) onSelectTool: (tool: "files" | "git") => void = () => undefined;
  @property({ attribute: false }) onRefreshFiles: () => void = () => undefined;
  @property({ attribute: false }) onExpandDir: (path: string) => void = () => undefined;
  @property({ attribute: false }) onSelectFile: (path: string) => void = () => undefined;
  @property({ attribute: false }) onRefreshGit: () => void = () => undefined;
  @property({ attribute: false }) onSelectDiff: (path: string) => void = () => undefined;

  override render() {
    if (!this.workspace) return html`<section class="empty">Select a workspace.</section>`;
    return html`
      <header>
        <div class="tabs">
          <button class=${this.tool === "files" ? "selected" : ""} @click=${() => { this.onSelectTool("files"); }}>Files</button>
          <button class=${this.tool === "git" ? "selected" : ""} @click=${() => { this.onSelectTool("git"); }}>Git</button>
        </div>
        <small title=${this.workspace.path}>${this.workspace.label}</small>
      </header>
      ${this.tool === "files" ? this.renderFiles() : this.renderGit()}
    `;
  }

  private renderFiles() {
    return html`
      <section class="toolbar">
        <strong>Files</strong>
        ${this.fileTreeStale ? html`<span class="stale">stale</span>` : null}
        <button @click=${this.onRefreshFiles}>Refresh</button>
      </section>
      <section class="split">
        <div class="list tree">
          ${this.fileTree.length === 0 ? html`<p class="muted">No files loaded.</p>` : this.fileTree.map((entry) => this.renderTreeEntry(entry, 0))}
        </div>
        <div class="viewer">
          ${this.renderFileViewer()}
        </div>
      </section>
    `;
  }

  private renderTreeEntry(entry: FileTreeEntry, depth: number): TemplateResult {
    const children = this.expandedDirs[entry.path];
    const hasChildren = children !== undefined;
    return html`
      <button class="row" style=${`--depth:${String(depth)}`} @click=${() => { this.selectTreeEntry(entry); }}>
        <span>${entry.type === "directory" ? (hasChildren ? "▾" : "▸") : "·"}</span>
        <span>${entry.name}</span>
      </button>
      ${hasChildren ? children.map((child) => this.renderTreeEntry(child, depth + 1)) : null}
    `;
  }

  private selectTreeEntry(entry: FileTreeEntry): void {
    if (entry.type === "directory") this.onExpandDir(entry.path);
    else this.onSelectFile(entry.path);
  }

  private renderFileViewer() {
    const file = this.selectedFileContent;
    if (this.selectedFilePath === undefined || this.selectedFilePath === "") return html`<p class="muted">Select a file.</p>`;
    if (file === undefined) return html`<p class="muted">Loading ${this.selectedFilePath}…</p>`;
    if (file.binary) return html`<p class="muted">Binary file: ${file.path}</p>`;
    return html`
      <div class="viewer-header"><strong>${file.path}</strong><small>${file.language ?? "text"}${file.truncated ? " · truncated" : ""}</small></div>
      <code-viewer .content=${file.content} .language=${file.language}></code-viewer>
    `;
  }

  private renderGit() {
    const status = this.gitStatus;
    return html`
      <section class="toolbar">
        <strong>Git</strong>
        ${this.gitStale ? html`<span class="stale">stale</span>` : null}
        <button @click=${this.onRefreshGit}>Refresh</button>
      </section>
      <section class="split">
        <div class="list">
          ${status === undefined ? html`<p class="muted">No status loaded.</p>` : !status.isGitRepo ? html`<p class="muted">Not a git repository.</p>` : html`
            <p class="summary">${this.gitSummary(status)}</p>
            ${status.files.length === 0 ? html`<p class="muted">No changes.</p>` : status.files.map((file) => html`
              <button class="row ${this.selectedDiffPath === file.path ? "selected" : ""}" @click=${() => { this.onSelectDiff(file.path); }}>
                <span>${stateLabel(file.index, file.workingTree)}</span>
                <span>${file.path}</span>
              </button>
            `)}
          `}
        </div>
        <div class="viewer">
          ${this.renderDiffViewer()}
        </div>
      </section>
    `;
  }

  private renderDiffViewer() {
    if (this.selectedDiffPath === undefined || this.selectedDiffPath === "") return html`<p class="muted">Select a changed file.</p>`;
    const diff = this.selectedDiff;
    if (diff === undefined) return html`<p class="muted">Loading diff…</p>`;
    return html`
      <div class="viewer-header"><strong>${diff.path ?? "diff"}</strong><small>${diff.staged ? "staged" : "unstaged"}${diff.truncated ? " · truncated" : ""}</small></div>
      <code-viewer .content=${diff.diff !== "" ? diff.diff : "No unstaged diff."}></code-viewer>
    `;
  }

  private gitSummary(status: GitStatusResponse): string {
    const branch = status.branch ?? "detached";
    const ahead = status.ahead ?? 0;
    const behind = status.behind ?? 0;
    return ahead === 0 && behind === 0 ? branch : `${branch} · ↑${String(ahead)} ↓${String(behind)}`;
  }

  static override styles = workspacePanelStyles;
}

function stateLabel(index: string, workingTree: string): string {
  const label = workingTree !== "unmodified" ? workingTree : index;
  return label.slice(0, 1).toUpperCase();
}
