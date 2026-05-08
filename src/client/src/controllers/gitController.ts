import { api } from "../api";
import type { GetState, SetState, UpdateUrl } from "./types";

export class GitController {
  private pollTimer: number | undefined;

  constructor(private readonly getState: GetState, private readonly setState: SetState, private readonly updateUrl: UpdateUrl) {}

  dispose(): void {
    if (this.pollTimer !== undefined) window.clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  async refreshGit(): Promise<void> {
    const project = this.getState().selectedProject;
    const workspace = this.getState().selectedWorkspace;
    if (project === undefined || workspace === undefined) return;
    try {
      const status = await api.gitStatus(project.id, workspace.id);
      this.setState({ gitStatus: status, gitStale: false, error: "" });
      const selectedDiffPath = this.getState().selectedDiffPath;
      if (selectedDiffPath !== undefined) {
        if (status.files.some((file) => file.path === selectedDiffPath)) await this.refreshDiff(selectedDiffPath);
        else {
          this.setState({ selectedDiffPath: undefined, selectedDiff: undefined });
          this.updateUrl();
        }
      }
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async selectDiff(path: string): Promise<void> {
    this.setState({ selectedDiffPath: path, selectedDiff: undefined, workspaceTool: "git", mainView: this.getState().mainView === "chat" ? "chat" : "git" });
    this.updateUrl();
    await this.refreshDiff(path);
  }

  async refreshDiff(path: string): Promise<void> {
    const project = this.getState().selectedProject;
    const workspace = this.getState().selectedWorkspace;
    if (project === undefined || workspace === undefined) return;
    try {
      this.setState({ selectedDiff: await api.gitDiff(project.id, workspace.id, { path }), error: "" });
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  updatePolling(): void {
    this.dispose();
    const state = this.getState();
    if (state.workspaceTool === "git" || state.mainView === "git") {
      this.pollTimer = window.setInterval(() => { void this.refreshGit(); }, 8000);
    }
  }
}
