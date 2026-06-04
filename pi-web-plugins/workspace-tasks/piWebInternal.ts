import type { Workspace } from "@jmfederico/pi-web/plugin-api";

export interface InternalRunTerminalCommandInput {
  workspace: Workspace;
  title: string;
  command: string;
  metadata?: Record<string, string>;
  open?: boolean;
}

export interface InternalTerminalCommandRun {
  id: string;
  origin: string;
  projectId: string;
  workspaceId: string;
  terminalId: string;
  title: string;
  command: string;
  status: "queued" | "running" | "succeeded" | "failed";
  exitCode?: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  metadata: Record<string, string>;
}

export interface InternalTerminalCommandRunHandle {
  run: InternalTerminalCommandRun;
  completed: Promise<InternalTerminalCommandRun>;
}

export interface InternalTerminalCommandRunsRuntime {
  runCommand(input: InternalRunTerminalCommandInput): Promise<InternalTerminalCommandRunHandle>;
  open(options?: { terminalId?: string | undefined }): void;
}

export function terminalCommandRunsFromContext(context: unknown): InternalTerminalCommandRunsRuntime | undefined {
  if (!isRecord(context)) return undefined;
  const internal = context["piWebInternal"];
  if (!isRecord(internal)) return undefined;
  const terminalCommandRuns = internal["terminalCommandRuns"];
  if (!isRecord(terminalCommandRuns)) return undefined;
  const runCommand = terminalCommandRuns["runCommand"];
  const open = terminalCommandRuns["open"];
  if (!isRunCommand(runCommand) || !isOpen(open)) return undefined;
  return {
    runCommand: (input) => runCommand(input),
    open: (options) => { open(options); },
  };
}

function isRunCommand(value: unknown): value is InternalTerminalCommandRunsRuntime["runCommand"] {
  return typeof value === "function";
}

function isOpen(value: unknown): value is InternalTerminalCommandRunsRuntime["open"] {
  return typeof value === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
