import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type {
  SafeTunnelCommandOutput,
  SafeTunnelConfigStatus,
  SafeTunnelLoginRequest,
  SafeTunnelLoginResponse,
  SafeTunnelOperationResponse,
  SafeTunnelRuntimeStatus,
  SafeTunnelStartRequest,
  SafeTunnelStartResponse,
  SafeTunnelStatusResponse,
  SafeTunnelStopResponse,
} from "../../shared/apiTypes.js";

const defaultConnectorCommand = "pi-web-tunnel";
const localDevelopmentConnectorCommand = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "pi-web-tunnel-dev.sh");
const connectorCommandEnvVar = "PI_WEB_SAFE_TUNNEL_CONNECTOR_COMMAND";
const connectorConfigDirectoryName = "pi-web-tunnel";
const connectorConfigFileName = "config.json";
const connectorPidFileName = "connector.pid";
const statusCommandTimeoutMs = 5_000;
const stopCommandTimeoutMs = 15_000;
const loginCommandTimeoutMs = 15 * 60_000;
const maxCapturedOutputCharacters = 24_000;

interface PathApi {
  dirname(path: string): string;
  join(...paths: string[]): string;
}

export interface SafeTunnelCommandInvocation {
  readonly args: readonly string[];
  readonly command: string;
}

export interface SafeTunnelCommandRunOptions {
  readonly maxOutputCharacters: number;
  readonly timeoutMs: number;
  readonly onStderr?: (chunk: string) => void;
  readonly onStdout?: (chunk: string) => void;
}

export interface SafeTunnelCommandRunResult extends SafeTunnelCommandOutput {
  readonly timedOut: boolean;
}

export interface SafeTunnelDetachedCommandResult {
  readonly processId?: number;
}

export interface SafeTunnelCommandRunner {
  run(invocation: SafeTunnelCommandInvocation, options: SafeTunnelCommandRunOptions): Promise<SafeTunnelCommandRunResult>;
  startDetached(invocation: SafeTunnelCommandInvocation): Promise<SafeTunnelDetachedCommandResult>;
}

export interface SafeTunnelBridgeService {
  status(): Promise<SafeTunnelStatusResponse>;
  login(request: SafeTunnelLoginRequest): Promise<SafeTunnelLoginResponse>;
  operation(operationId: string): SafeTunnelOperationResponse | undefined;
  start(request: SafeTunnelStartRequest): Promise<SafeTunnelStartResponse>;
  stop(): Promise<SafeTunnelStopResponse>;
}

export interface SafeTunnelBridgeDependencies {
  readonly commandRunner: SafeTunnelCommandRunner;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fileExists: (path: string) => boolean;
  readonly homeDirectory: string;
  readonly now: () => Date;
  readonly platform: NodeJS.Platform;
  readonly processExists: (pid: number) => boolean;
  readonly readFile: (path: string) => string;
}

interface SafeTunnelOperationState {
  readonly id: string;
  readonly kind: "login";
  readonly startedAt: string;
  status: "running" | "succeeded" | "failed";
  stdout: string;
  stderr: string;
  error?: string;
  exitCode?: number | null;
  finishedAt?: string;
  publicUrl?: string;
  signal?: string;
  userCode?: string;
  verificationUriComplete?: string;
}

export class SafeTunnelBridgeError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

export class DefaultSafeTunnelBridgeService implements SafeTunnelBridgeService {
  private activeOperation: SafeTunnelOperationState | undefined;
  private readonly operations = new Map<string, SafeTunnelOperationState>();

  constructor(private readonly dependencies: SafeTunnelBridgeDependencies) {}

  async status(): Promise<SafeTunnelStatusResponse> {
    const command = this.connectorCommand();
    const configDirectory = discoverConnectorConfigDirectory(this.dependencies);
    const configPath = pathApiForPlatform(this.dependencies.platform).join(configDirectory, connectorConfigFileName);
    const connector = await this.connectorStatus(command);
    const config = readConnectorConfigStatus(configPath, this.dependencies);
    const runtime = readConnectorRuntimeStatus(configDirectory, this.dependencies);
    const activeOperation = this.activeOperation === undefined ? undefined : snapshotOperation(this.activeOperation);

    return {
      connector,
      config,
      runtime,
      ...(activeOperation === undefined ? {} : { activeOperation }),
    };
  }

  async login(request: SafeTunnelLoginRequest): Promise<SafeTunnelLoginResponse> {
    if (this.activeOperation?.status === "running") {
      throw new SafeTunnelBridgeError("A Safe Tunnel operation is already running.", 409);
    }

    const operation = this.createLoginOperation();
    const invocation: SafeTunnelCommandInvocation = {
      command: this.connectorCommand(),
      args: loginArgs(request),
    };

    const completion = this.dependencies.commandRunner.run(invocation, {
      maxOutputCharacters: maxCapturedOutputCharacters,
      timeoutMs: loginCommandTimeoutMs,
      onStdout: (chunk) => {
        appendOperationStdout(operation, chunk);
      },
      onStderr: (chunk) => {
        appendOperationStderr(operation, chunk);
      },
    }).then(
      (result) => {
        this.finishOperation(operation, result);
      },
      (error: unknown) => {
        this.failOperation(operation, error);
      },
    );
    void completion;

    return {
      operation: snapshotOperation(operation),
      status: await this.status(),
    };
  }

  operation(operationId: string): SafeTunnelOperationResponse | undefined {
    const operation = this.operations.get(operationId);
    return operation === undefined ? undefined : snapshotOperation(operation);
  }

  async start(request: SafeTunnelStartRequest): Promise<SafeTunnelStartResponse> {
    const currentStatus = await this.status();

    if (currentStatus.runtime.state === "running") {
      throw new SafeTunnelBridgeError("The PI WEB Safe Tunnel connector is already running.", 409);
    }

    if (currentStatus.config.state !== "registered") {
      throw new SafeTunnelBridgeError("Register or log in to PI WEB Safe Tunnels before starting the connector.", 409);
    }

    if (request.frpcPath === undefined && currentStatus.config.frpcPathConfigured !== true) {
      throw new SafeTunnelBridgeError("Configure an frpc executable path before starting the connector.", 400);
    }

    const started = await this.dependencies.commandRunner.startDetached({
      command: this.connectorCommand(),
      args: startArgs(request),
    });

    return {
      accepted: true,
      ...(started.processId === undefined ? {} : { connectorProcessId: started.processId }),
      status: await this.status(),
    };
  }

  async stop(): Promise<SafeTunnelStopResponse> {
    const result = await this.dependencies.commandRunner.run({ command: this.connectorCommand(), args: ["stop"] }, {
      maxOutputCharacters: maxCapturedOutputCharacters,
      timeoutMs: stopCommandTimeoutMs,
    });

    return {
      command: commandOutput(result),
      status: await this.status(),
    };
  }

  private async connectorStatus(command: string): Promise<SafeTunnelStatusResponse["connector"]> {
    try {
      const result = await this.dependencies.commandRunner.run({ command, args: ["status"] }, {
        maxOutputCharacters: maxCapturedOutputCharacters,
        timeoutMs: statusCommandTimeoutMs,
      });

      if (result.exitCode === 0) {
        return { command, state: "available" };
      }

      return {
        command,
        state: "unavailable",
        error: nonEmptyString(result.stderr) ?? nonEmptyString(result.stdout) ?? `Connector status exited with code ${formatExitCode(result.exitCode)}.`,
      };
    } catch (error) {
      return {
        command,
        state: "unavailable",
        error: errorMessage(error),
      };
    }
  }

  private connectorCommand(): string {
    return nonEmptyString(this.dependencies.env[connectorCommandEnvVar])
      ?? discoveredDevelopmentConnectorCommand(this.dependencies)
      ?? defaultConnectorCommand;
  }

  private createLoginOperation(): SafeTunnelOperationState {
    const operation: SafeTunnelOperationState = {
      id: randomUUID(),
      kind: "login",
      startedAt: this.dependencies.now().toISOString(),
      status: "running",
      stdout: "",
      stderr: "",
    };
    this.activeOperation = operation;
    this.operations.set(operation.id, operation);
    return operation;
  }

  private finishOperation(operation: SafeTunnelOperationState, result: SafeTunnelCommandRunResult): void {
    operation.stdout = result.stdout;
    operation.stderr = result.stderr;
    operation.exitCode = result.exitCode;
    operation.finishedAt = this.dependencies.now().toISOString();
    if (result.signal !== undefined) operation.signal = result.signal;
    updateOperationDerivedFields(operation);

    if (result.exitCode === 0 && !result.timedOut) {
      operation.status = "succeeded";
    } else {
      operation.status = "failed";
      operation.error = result.timedOut
        ? "Safe Tunnel login timed out."
        : `Safe Tunnel login exited with code ${formatExitCode(result.exitCode)}.`;
    }

    if (this.activeOperation?.id === operation.id) {
      this.activeOperation = undefined;
    }
  }

  private failOperation(operation: SafeTunnelOperationState, error: unknown): void {
    operation.status = "failed";
    operation.error = errorMessage(error);
    operation.finishedAt = this.dependencies.now().toISOString();
    if (this.activeOperation?.id === operation.id) {
      this.activeOperation = undefined;
    }
  }
}

export function createDefaultSafeTunnelBridgeService(): SafeTunnelBridgeService {
  return new DefaultSafeTunnelBridgeService({
    commandRunner: createNodeSafeTunnelCommandRunner(),
    env: process.env,
    fileExists: existsSync,
    homeDirectory: homedir(),
    now: () => new Date(),
    platform: process.platform,
    processExists: defaultProcessExists,
    readFile: (path) => readFileSync(path, "utf8"),
  });
}

export function createNodeSafeTunnelCommandRunner(): SafeTunnelCommandRunner {
  return {
    run(invocation, options) {
      return runNodeCommand(invocation, options);
    },
    startDetached(invocation) {
      return startDetachedNodeCommand(invocation);
    },
  };
}

function runNodeCommand(
  invocation: SafeTunnelCommandInvocation,
  options: SafeTunnelCommandRunOptions,
): Promise<SafeTunnelCommandRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, [...invocation.args], {
      env: process.env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);

    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      finish();
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = appendCapped(stdout, chunk, options.maxOutputCharacters);
      options.onStdout?.(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendCapped(stderr, chunk, options.maxOutputCharacters);
      options.onStderr?.(chunk);
    });
    child.once("error", (error) => {
      settle(() => {
        reject(error);
      });
    });
    child.once("close", (exitCode, signal) => {
      settle(() => {
        resolve({
          exitCode,
          stdout,
          stderr,
          timedOut,
          ...(signal === null ? {} : { signal }),
        });
      });
    });
  });
}

function startDetachedNodeCommand(invocation: SafeTunnelCommandInvocation): Promise<SafeTunnelDetachedCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, [...invocation.args], {
      detached: true,
      env: process.env,
      stdio: "ignore",
      windowsHide: true,
    });
    let settled = false;

    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      finish();
    };

    child.once("error", (error) => {
      settle(() => {
        reject(error);
      });
    });
    child.once("spawn", () => {
      child.unref();
      settle(() => {
        resolve(child.pid === undefined ? {} : { processId: child.pid });
      });
    });
  });
}

function loginArgs(request: SafeTunnelLoginRequest): string[] {
  return [
    "login",
    "--control-api-url",
    request.controlApiUrl,
    "--machine-name",
    request.machineName,
    "--machine-slug",
    request.machineSlug,
    ...optionalFlag("--local-pi-web-url", request.localPiWebUrl),
    ...optionalFlag("--frpc-path", request.frpcPath),
  ];
}

function startArgs(request: SafeTunnelStartRequest): string[] {
  return ["start", ...optionalFlag("--frpc-path", request.frpcPath)];
}

function optionalFlag(flag: string, value: string | undefined): string[] {
  return value === undefined ? [] : [flag, value];
}

function discoveredDevelopmentConnectorCommand(dependencies: Pick<SafeTunnelBridgeDependencies, "fileExists" | "platform">): string | undefined {
  if (dependencies.platform === "win32") return undefined;
  return dependencies.fileExists(localDevelopmentConnectorCommand) ? localDevelopmentConnectorCommand : undefined;
}

function discoverConnectorConfigDirectory(dependencies: Pick<SafeTunnelBridgeDependencies, "env" | "homeDirectory" | "platform">): string {
  const homeDirectory = requireHomeDirectory(dependencies.homeDirectory);
  const pathApi = pathApiForPlatform(dependencies.platform);

  if (dependencies.platform === "win32") {
    const configRoot = nonEmptyString(dependencies.env["APPDATA"]) ?? pathApi.join(homeDirectory, "AppData", "Roaming");
    return pathApi.join(configRoot, connectorConfigDirectoryName);
  }

  const configRoot = nonEmptyString(dependencies.env["XDG_CONFIG_HOME"]) ?? pathApi.join(homeDirectory, ".config");
  return pathApi.join(configRoot, connectorConfigDirectoryName);
}

function readConnectorConfigStatus(configPath: string, dependencies: Pick<SafeTunnelBridgeDependencies, "fileExists" | "readFile">): SafeTunnelConfigStatus {
  if (!dependencies.fileExists(configPath)) {
    return { exists: false, path: configPath, state: "missing" };
  }

  try {
    const config = parseConnectorConfig(dependencies.readFile(configPath));
    return {
      exists: true,
      path: configPath,
      state: config.machine === undefined ? "unregistered" : "registered",
      localPiWebUrl: config.localPiWebUrl,
      frpcPathConfigured: config.frpcPath !== undefined,
      ...(config.machine === undefined ? {} : { machine: config.machine }),
    };
  } catch (error) {
    return {
      exists: true,
      path: configPath,
      state: "invalid",
      error: errorMessage(error),
    };
  }
}

function readConnectorRuntimeStatus(configDirectory: string, dependencies: Pick<SafeTunnelBridgeDependencies, "fileExists" | "platform" | "processExists" | "readFile">): SafeTunnelRuntimeStatus {
  const pidFilePath = pathApiForPlatform(dependencies.platform).join(configDirectory, connectorPidFileName);

  if (!dependencies.fileExists(pidFilePath)) {
    return { pidFilePath, state: "stopped" };
  }

  try {
    const pid = parsePidFile(dependencies.readFile(pidFilePath));
    return dependencies.processExists(pid)
      ? { pid, pidFilePath, state: "running" }
      : { pid, pidFilePath, state: "stale" };
  } catch (error) {
    return { pidFilePath, state: "unknown", error: errorMessage(error) };
  }
}

interface ParsedConnectorConfig {
  readonly frpcPath?: string;
  readonly localPiWebUrl: string;
  readonly machine?: {
    readonly controlApiBaseUrl: string;
    readonly machineId: string;
  };
}

function parseConnectorConfig(contents: string): ParsedConnectorConfig {
  const parsed: unknown = JSON.parse(contents);

  if (!isRecord(parsed)) {
    throw new Error("Connector config must be a JSON object.");
  }

  const localPiWebUrl = requireNonEmptyString(parsed["localPiWebUrl"], "Connector config localPiWebUrl");
  const frpcPath = optionalNonEmptyString(parsed["frpcPath"], "Connector config frpcPath");
  const machine = parseMachineCredentials(parsed["machine"]);

  return {
    localPiWebUrl,
    ...(frpcPath === undefined ? {} : { frpcPath }),
    ...(machine === undefined ? {} : { machine }),
  };
}

function parseMachineCredentials(value: unknown): ParsedConnectorConfig["machine"] {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Connector config machine must be a JSON object.");

  const machine = {
    controlApiBaseUrl: requireNonEmptyString(value["controlApiBaseUrl"], "Connector config machine.controlApiBaseUrl"),
    machineId: requireNonEmptyString(value["machineId"], "Connector config machine.machineId"),
  };
  requireNonEmptyString(value["machineToken"], "Connector config machine.machineToken");
  return machine;
}

function parsePidFile(contents: string): number {
  const trimmed = contents.trim();
  if (!/^[1-9]\d*$/u.test(trimmed)) {
    throw new Error("Connector PID file is malformed.");
  }
  return Number.parseInt(trimmed, 10);
}

function snapshotOperation(operation: SafeTunnelOperationState): SafeTunnelOperationResponse {
  return {
    id: operation.id,
    kind: operation.kind,
    startedAt: operation.startedAt,
    status: operation.status,
    stdout: operation.stdout,
    stderr: operation.stderr,
    ...(operation.error === undefined ? {} : { error: operation.error }),
    ...(operation.exitCode === undefined ? {} : { exitCode: operation.exitCode }),
    ...(operation.finishedAt === undefined ? {} : { finishedAt: operation.finishedAt }),
    ...(operation.publicUrl === undefined ? {} : { publicUrl: operation.publicUrl }),
    ...(operation.signal === undefined ? {} : { signal: operation.signal }),
    ...(operation.userCode === undefined ? {} : { userCode: operation.userCode }),
    ...(operation.verificationUriComplete === undefined ? {} : { verificationUriComplete: operation.verificationUriComplete }),
  };
}

function appendOperationStdout(operation: SafeTunnelOperationState, chunk: string): void {
  operation.stdout = appendCapped(operation.stdout, chunk, maxCapturedOutputCharacters);
  updateOperationDerivedFields(operation);
}

function appendOperationStderr(operation: SafeTunnelOperationState, chunk: string): void {
  operation.stderr = appendCapped(operation.stderr, chunk, maxCapturedOutputCharacters);
}

function updateOperationDerivedFields(operation: SafeTunnelOperationState): void {
  const lines = operation.stdout.split(/\r?\n/u);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    const previousLine = index === 0 ? "" : (lines[index - 1]?.trim() ?? "");

    if (previousLine === "Open this URL to authorize the connector:" && line.length > 0) {
      operation.verificationUriComplete = line;
      continue;
    }

    if (line.startsWith("User code:")) {
      operation.userCode = line.slice("User code:".length).trim();
      continue;
    }

    if (line.startsWith("Public URL:")) {
      operation.publicUrl = line.slice("Public URL:".length).trim();
    }
  }
}

function commandOutput(result: SafeTunnelCommandRunResult): SafeTunnelCommandOutput {
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.signal === undefined ? {} : { signal: result.signal }),
  };
}

function appendCapped(existing: string, chunk: string, maxCharacters: number): string {
  const next = `${existing}${chunk}`;
  if (next.length <= maxCharacters) return next;
  return next.slice(next.length - maxCharacters);
}

function pathApiForPlatform(platform: NodeJS.Platform): PathApi {
  return platform === "win32" ? win32 : posix;
}

function defaultProcessExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (!(error instanceof Error)) return false;
    return reflectString(error, "code") === "EPERM";
  }
}

function optionalNonEmptyString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  return requireNonEmptyString(value, fieldName);
}

function requireNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }
  return value.trim();
}

function requireHomeDirectory(homeDirectory: string): string {
  const normalized = nonEmptyString(homeDirectory);
  if (normalized === undefined) {
    throw new Error("Unable to discover a home directory for the PI WEB Safe Tunnel connector config.");
  }
  return normalized;
}

function nonEmptyString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function formatExitCode(exitCode: number | null): string {
  return exitCode === null ? "unknown" : exitCode.toString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reflectString(source: object, key: string): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (descriptor === undefined || !("value" in descriptor)) return undefined;
  const value: unknown = descriptor.value;
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
