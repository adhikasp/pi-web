import { describe, expect, it, vi } from "vitest";
import type { Workspace } from "@jmfederico/pi-web/plugin-api";
import { runWorkspaceTaskInTerminal } from "./taskRunner";
import type { WorkspaceTask } from "./config";
import type { InternalTerminalCommandRun, InternalTerminalCommandRunsRuntime } from "./piWebInternal";

const workspace: Workspace = {
  id: "workspace 1",
  projectId: "project/1",
  path: "/repo",
  label: "repo",
  isMain: false,
  isGitRepo: true,
  isGitWorktree: true,
};

const run: InternalTerminalCommandRun = {
  id: "run1",
  origin: "workspace-tasks",
  projectId: workspace.projectId,
  workspaceId: workspace.id,
  terminalId: "term1",
  title: "Build",
  command: "npm run build",
  status: "running",
  createdAt: "2026-05-25T00:00:00.000Z",
  metadata: { "pi.plugin": "workspace-tasks", "task.id": "build" },
};

describe("task runner", () => {
  it("starts workspace tasks through the internal terminal command-run helper", async () => {
    const task: WorkspaceTask = { id: "build", title: "Build", command: "npm run build", confirm: false };
    const runCommand = vi.fn<InternalTerminalCommandRunsRuntime["runCommand"]>(() => Promise.resolve({ run, completed: Promise.resolve(run) }));
    const terminal: InternalTerminalCommandRunsRuntime = {
      runCommand,
      open: vi.fn(),
    };

    const handle = await runWorkspaceTaskInTerminal(terminal, workspace, task);

    expect(handle.run).toEqual(run);
    await expect(handle.completed).resolves.toEqual(run);
    expect(runCommand).toHaveBeenCalledWith({
      workspace,
      title: "Build",
      command: "npm run build",
      open: true,
      metadata: { "pi.plugin": "workspace-tasks", "task.id": "build" },
    });
  });
});
