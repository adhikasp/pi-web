import type { Workspace } from "@jmfederico/pi-web/plugin-api";
import type { WorkspaceTask } from "./config.js";
import type { InternalTerminalCommandRunsRuntime } from "./piWebInternal.js";

export function runWorkspaceTaskInTerminal(terminal: InternalTerminalCommandRunsRuntime, workspace: Workspace, task: WorkspaceTask): ReturnType<InternalTerminalCommandRunsRuntime["runCommand"]> {
  return terminal.runCommand({
    workspace,
    title: task.title,
    command: task.command,
    open: true,
    metadata: {
      "pi.plugin": "workspace-tasks",
      "task.id": task.id,
    },
  });
}
