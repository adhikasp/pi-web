import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DefaultSafeTunnelBridgeService,
  type SafeTunnelCommandRunner,
  type SafeTunnelCommandRunResult,
} from "./safeTunnelBridgeService.js";

let tempDir: string;
let runner: FakeCommandRunner;
let service: DefaultSafeTunnelBridgeService;
let existingPids: Set<number>;
let nowIndex: number;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-web-safe-tunnel-test-"));
  runner = new FakeCommandRunner();
  existingPids = new Set<number>();
  nowIndex = 0;
  service = new DefaultSafeTunnelBridgeService({
    commandRunner: runner,
    env: { XDG_CONFIG_HOME: tempDir, PI_WEB_SAFE_TUNNEL_CONNECTOR_COMMAND: "/usr/local/bin/pi-web-tunnel" },
    fileExists: (path) => runner.fileExists(path),
    homeDirectory: tempDir,
    now: () => new Date(`2026-07-03T00:00:0${(nowIndex += 1).toString()}.000Z`),
    platform: "linux",
    processExists: (pid) => existingPids.has(pid),
    readFile: (path) => runner.readFile(path),
  });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("DefaultSafeTunnelBridgeService", () => {
  it("reports connector availability, missing config, and stopped runtime without failing the status endpoint", async () => {
    runner.nextRunError = new Error("spawn ENOENT");

    const status = await service.status();

    expect(status.connector).toEqual({ command: "/usr/local/bin/pi-web-tunnel", state: "unavailable", error: "spawn ENOENT" });
    expect(status.config).toEqual({ exists: false, path: join(tempDir, "pi-web-tunnel", "config.json"), state: "missing" });
    expect(status.runtime).toEqual({ pidFilePath: join(tempDir, "pi-web-tunnel", "connector.pid"), state: "stopped" });
    expect(runner.runCalls).toEqual([{ command: "/usr/local/bin/pi-web-tunnel", args: ["status"] }]);
  });

  it("uses the first-party source-tree connector wrapper when no command override is configured", async () => {
    const defaultedService = new DefaultSafeTunnelBridgeService({
      commandRunner: runner,
      env: { XDG_CONFIG_HOME: tempDir },
      fileExists: (path) => runner.fileExists(path),
      homeDirectory: tempDir,
      now: () => new Date("2026-07-03T00:00:01.000Z"),
      platform: "linux",
      processExists: (pid) => existingPids.has(pid),
      readFile: (path) => runner.readFile(path),
    });

    const status = await defaultedService.status();
    const expectedCommand = join(process.cwd(), "scripts", "pi-web-tunnel-dev.sh");

    expect(status.connector).toEqual({ command: expectedCommand, state: "available" });
    expect(runner.runCalls).toEqual([{ command: expectedCommand, args: ["status"] }]);
  });

  it("reports registered connector config and running state without exposing the machine token", async () => {
    const configDirectory = join(tempDir, "pi-web-tunnel");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(join(configDirectory, "config.json"), JSON.stringify({
      schemaVersion: 2,
      localPiWebUrl: "http://127.0.0.1:8504",
      frpcPath: "/opt/frpc",
      machine: {
        controlApiBaseUrl: "https://control.example.test",
        machineId: "mach_123",
        machineToken: "piwt_mtok_v1_secret",
      },
    }));
    await writeFile(join(configDirectory, "connector.pid"), "4242\n");
    existingPids.add(4242);

    const status = await service.status();

    expect(status.connector).toEqual({ command: "/usr/local/bin/pi-web-tunnel", state: "available" });
    expect(status.config).toEqual({
      exists: true,
      path: join(configDirectory, "config.json"),
      state: "registered",
      localPiWebUrl: "http://127.0.0.1:8504",
      frpcPathConfigured: true,
      machine: { controlApiBaseUrl: "https://control.example.test", machineId: "mach_123" },
    });
    expect(status.runtime).toEqual({ pid: 4242, pidFilePath: join(configDirectory, "connector.pid"), state: "running" });
    expect(JSON.stringify(status)).not.toContain("piwt_mtok_v1_secret");
  });

  it("starts login as a tracked operation and extracts browser approval details from command output", async () => {
    const loginDeferred = createDeferred<SafeTunnelCommandRunResult>();
    runner.loginDeferred = loginDeferred;

    const response = await service.login({
      controlApiUrl: "https://control.example.test",
      machineName: "My Dev Box",
      machineSlug: "my-dev-box",
      localPiWebUrl: "http://127.0.0.1:8504",
      frpcPath: "/opt/frpc",
    });

    expect(runner.runCalls[0]).toEqual({
      command: "/usr/local/bin/pi-web-tunnel",
      args: [
        "login",
        "--control-api-url",
        "https://control.example.test",
        "--machine-name",
        "My Dev Box",
        "--machine-slug",
        "my-dev-box",
        "--local-pi-web-url",
        "http://127.0.0.1:8504",
        "--frpc-path",
        "/opt/frpc",
      ],
    });
    expect(response.operation.status).toBe("running");
    expect(response.status.activeOperation?.id).toBe(response.operation.id);

    const loginOptions = runner.loginOptions;
    if (loginOptions === undefined) throw new Error("Expected login command options");
    loginOptions.onStdout?.("Starting PI WEB Safe Tunnel login.\nOpen this URL to authorize the connector:\nhttps://control.example.test/device?user_code=ABCD-EFGH\nUser code: ABCD-EFGH\n");

    expect(service.operation(response.operation.id)).toMatchObject({
      status: "running",
      verificationUriComplete: "https://control.example.test/device?user_code=ABCD-EFGH",
      userCode: "ABCD-EFGH",
    });

    loginDeferred.resolve(commandResult({
      stdout: "Starting PI WEB Safe Tunnel login.\nPublic URL: https://my-dev-box.ns.tunnels.example.test\n",
    }));
    await Promise.resolve();

    expect(service.operation(response.operation.id)).toMatchObject({
      status: "succeeded",
      exitCode: 0,
      publicUrl: "https://my-dev-box.ns.tunnels.example.test",
    });
  });

  it("rejects starting the connector before a registered config exists", async () => {
    await expect(service.start({ frpcPath: "/opt/frpc" })).rejects.toMatchObject({
      message: "Register or log in to PI WEB Safe Tunnels before starting the connector.",
      statusCode: 409,
    });
  });

  it("starts the connector as a detached foreground connector process", async () => {
    const configDirectory = join(tempDir, "pi-web-tunnel");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(join(configDirectory, "config.json"), JSON.stringify({
      schemaVersion: 2,
      localPiWebUrl: "http://127.0.0.1:8504",
      frpcPath: "/opt/frpc",
      machine: {
        controlApiBaseUrl: "https://control.example.test",
        machineId: "mach_123",
        machineToken: "piwt_mtok_v1_secret",
      },
    }));
    runner.detachedResult = { processId: 1234 };

    const response = await service.start({});

    expect(runner.detachedCalls).toEqual([{ command: "/usr/local/bin/pi-web-tunnel", args: ["start"] }]);
    expect(response.accepted).toBe(true);
    expect(response.connectorProcessId).toBe(1234);
  });

  it("runs stop through the connector command and returns redacted command output", async () => {
    runner.stopResult = commandResult({ stdout: "No running PI WEB Safe Tunnel connector was found.\n" });

    const response = await service.stop();

    expect(runner.runCalls[0]).toEqual({ command: "/usr/local/bin/pi-web-tunnel", args: ["stop"] });
    expect(response.command).toEqual({ exitCode: 0, stdout: "No running PI WEB Safe Tunnel connector was found.\n", stderr: "" });
  });
});

type CommandInvocation = Parameters<SafeTunnelCommandRunner["run"]>[0];
type CommandRunOptions = Parameters<SafeTunnelCommandRunner["run"]>[1];
type DetachedCommandResult = Awaited<ReturnType<SafeTunnelCommandRunner["startDetached"]>>;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly reject: (error: unknown) => void;
  readonly resolve: (value: T) => void;
}

class FakeCommandRunner implements SafeTunnelCommandRunner {
  detachedCalls: CommandInvocation[] = [];
  detachedResult: DetachedCommandResult = {};
  loginDeferred: Deferred<SafeTunnelCommandRunResult> | undefined;
  loginOptions: CommandRunOptions | undefined;
  nextRunError: Error | undefined;
  runCalls: CommandInvocation[] = [];
  stopResult: SafeTunnelCommandRunResult = commandResult({});

  run(invocation: CommandInvocation, options: CommandRunOptions): Promise<SafeTunnelCommandRunResult> {
    this.runCalls.push(invocation);
    if (this.nextRunError !== undefined) {
      const error = this.nextRunError;
      this.nextRunError = undefined;
      return Promise.reject(error);
    }

    const command = invocation.args[0];
    if (command === "login") {
      this.loginOptions = options;
      return this.loginDeferred?.promise ?? Promise.resolve(commandResult({}));
    }

    if (command === "stop") return Promise.resolve(this.stopResult);
    return Promise.resolve(commandResult({}));
  }

  startDetached(invocation: CommandInvocation): Promise<DetachedCommandResult> {
    this.detachedCalls.push(invocation);
    return Promise.resolve(this.detachedResult);
  }

  fileExists(path: string): boolean {
    return existsSync(path);
  }

  readFile(path: string): string {
    return readFileSync(path, "utf8");
  }
}

function commandResult(overrides: Partial<SafeTunnelCommandRunResult>): SafeTunnelCommandRunResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    ...overrides,
  };
}

function createDeferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {
    throw new Error("Deferred resolver was not initialized");
  };
  let reject: (error: unknown) => void = () => {
    throw new Error("Deferred rejecter was not initialized");
  };
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

