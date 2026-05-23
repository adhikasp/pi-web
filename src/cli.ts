#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defaultPiWebConfigPath, examplePiWebConfig } from "./config.js";

const serviceDir = join(homedir(), ".config", "systemd", "user");
const sessiondServiceName = "pi-web-sessiond.service";
const webServiceName = "pi-web.service";

interface InstallOptions {
  host: string;
  port: string;
  config?: string;
}

type Check = [string, string[]];
type SupportedShell = "bash" | "zsh" | "fish";

interface ServiceShell {
  name: SupportedShell;
  executable: string;
  detected?: string;
  fallback: boolean;
}

interface ServiceExecutable {
  command: string;
  checks: Check[];
}

interface ServiceExecutables {
  sessiond: ServiceExecutable;
  web: ServiceExecutable;
}

function run(command: string, args: string[], options: { check?: boolean } = {}): number {
  const result = spawnSync(command, args, { stdio: "inherit" });
  const status = result.status ?? 1;
  if (options.check === true && status !== 0) process.exit(status);
  return status;
}

function capture(command: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function hasCommand(command: string): boolean {
  return capture("/usr/bin/env", ["sh", "-c", `command -v ${command}`]).status === 0;
}

function isLingerEnabled(): boolean | undefined {
  if (!hasCommand("loginctl")) return undefined;
  const result = capture("loginctl", ["show-user", userInfo().username, "-p", "Linger"]);
  if (result.status !== 0) return undefined;
  const value = result.stdout.trim();
  if (value === "Linger=yes") return true;
  if (value === "Linger=no") return false;
  return undefined;
}

function parseInstallOptions(args: string[]): InstallOptions {
  const options: InstallOptions = { host: "127.0.0.1", port: "8504" };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--host") {
      const value = args[i + 1];
      if (value === undefined) throw new Error("--host requires a value");
      options.host = value;
      i += 1;
    } else if (arg.startsWith("--host=")) {
      options.host = arg.slice("--host=".length);
    } else if (arg === "--port") {
      const value = args[i + 1];
      if (value === undefined) throw new Error("--port requires a value");
      options.port = value;
      i += 1;
    } else if (arg.startsWith("--port=")) {
      options.port = arg.slice("--port=".length);
    } else if (arg === "--config") {
      const value = args[i + 1];
      if (value === undefined) throw new Error("--config requires a value");
      options.config = value;
      i += 1;
    } else if (arg.startsWith("--config=")) {
      options.config = arg.slice("--config=".length);
    } else if (arg === "--user-systemd") {
      // Accepted for readability; user systemd is the only installer target for now.
    } else {
      throw new Error(`Unknown install option: ${arg}`);
    }
  }
  return options;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function fishSingleQuote(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function systemdEscape(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function packageRootPath(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function packageEntrypointPath(name: "server" | "sessiond"): string {
  return join(packageRootPath(), "dist", "server", name === "server" ? "index.js" : "sessiond.js");
}

function detectServiceShell(): ServiceShell {
  const userShell = userInfo().shell ?? undefined;
  const envShell = process.env["SHELL"]?.trim();
  const detected = envShell === undefined || envShell === "" ? userShell : envShell;
  const name = basename(detected ?? "").replace(/^-/u, "");
  if (name === "bash" || name === "zsh" || name === "fish") {
    return { name, executable: detected ?? name, detected: detected ?? name, fallback: false };
  }
  return { name: "bash", executable: "bash", ...(detected === undefined ? {} : { detected }), fallback: true };
}

function serviceShellCommand(command: string): string[] {
  return ["/usr/bin/env", detectServiceShell().executable, "-lc", command];
}

function serviceShellExecPrefix(): string {
  return `/usr/bin/env ${detectServiceShell().executable} -lc`;
}

function serviceShellQuote(value: string): string {
  return detectServiceShell().name === "fish" ? fishSingleQuote(value) : shellSingleQuote(value);
}

function systemdServiceShellQuote(value: string): string {
  return serviceShellQuote(value.replaceAll("%", "%%").replaceAll("$", "$$"));
}

function checkSucceeds(command: string[]): boolean {
  const [bin, ...args] = command;
  return bin !== undefined && capture(bin, args).status === 0;
}

function serviceShellCanFindCommand(command: string): boolean {
  if (!checkSucceeds(serviceShellCommand(commandCheck(command)))) return false;
  return checkSucceeds(systemdUserServiceShellCommand(commandCheck(command)));
}

function readableFileCheck(path: string): string {
  const quoted = serviceShellQuote(path);
  return `test -r ${quoted} && printf '%s\\n' ${quoted}`;
}

function commandExecutable(command: string): ServiceExecutable {
  const shell = serviceShellLabel();
  return {
    command,
    checks: [
      [`${shell} can find ${command}`, serviceShellCommand(commandCheck(command))],
      [`systemd user ${shell} can find ${command}`, systemdUserServiceShellCommand(commandCheck(command))],
    ],
  };
}

function bundledExecutable(command: string, entrypointPath: string): ServiceExecutable {
  const shell = serviceShellLabel();
  const check = readableFileCheck(entrypointPath);
  return {
    command: `node ${serviceShellQuote(entrypointPath)}`,
    checks: [
      [`${shell} can access bundled ${command} entrypoint`, serviceShellCommand(check)],
      [`systemd user ${shell} can access bundled ${command} entrypoint`, systemdUserServiceShellCommand(check)],
    ],
  };
}

function serviceExecutable(envName: "PI_WEB_SERVER_EXEC" | "PI_WEB_SESSIOND_EXEC", command: string, entrypointPath: string): ServiceExecutable {
  const configured = process.env[envName]?.trim();
  if (configured !== undefined && configured !== "") return { command: configured, checks: [] };
  if (serviceShellCanFindCommand(command)) return commandExecutable(command);
  if (existsSync(entrypointPath)) return bundledExecutable(command, entrypointPath);
  return commandExecutable(command);
}

function resolveServiceExecutables(): ServiceExecutables {
  return {
    sessiond: serviceExecutable("PI_WEB_SESSIOND_EXEC", "pi-web-sessiond", packageEntrypointPath("sessiond")),
    web: serviceExecutable("PI_WEB_SERVER_EXEC", "pi-web-server", packageEntrypointPath("server")),
  };
}

function describeServiceShell(): string {
  const shell = detectServiceShell();
  if (shell.fallback) {
    return shell.detected === undefined
      ? "could not detect a supported login shell; using bash"
      : `detected ${shell.detected}; using bash because PI WEB currently supports bash, zsh, and fish`;
  }
  return shell.detected === undefined ? shell.name : `${shell.name} (${shell.detected})`;
}

function sessiondUnit(executables: ServiceExecutables): string {
  return `[Unit]
Description=PI WEB session daemon

[Service]
Type=simple
ExecStart=${serviceShellExecPrefix()} ${systemdServiceShellQuote(`exec ${executables.sessiond.command}`)}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
}

function webUnit(options: InstallOptions, executables: ServiceExecutables): string {
  const configEnvironment = options.config === undefined ? "" : `Environment="PI_WEB_CONFIG=${systemdEscape(resolve(options.config))}"\n`;
  return `[Unit]
Description=PI WEB server
After=${sessiondServiceName}
Wants=${sessiondServiceName}

[Service]
Type=simple
${configEnvironment}ExecStart=${serviceShellExecPrefix()} ${systemdServiceShellQuote(`exec ${executables.web.command}`)}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
}

async function writeInitialConfig(options: InstallOptions): Promise<string> {
  const configPath = options.config === undefined ? defaultPiWebConfigPath() : resolve(options.config);
  await mkdir(dirname(configPath), { recursive: true });
  if (!existsSync(configPath)) {
    await writeFile(configPath, examplePiWebConfig({ host: options.host, port: Number(options.port) }));
  }
  return configPath;
}

async function install(args: string[]): Promise<void> {
  const options = parseInstallOptions(args);

  const executables = resolveServiceExecutables();
  console.log("Running PI WEB install preflight checks...");
  console.log(`Service shell: ${describeServiceShell()}`);
  if (!runChecks(installPreflightChecks(executables))) {
    printPathSetupAdvice();
    throw new Error("Install preflight checks failed. Fix the failed checks above, then run `pi-web doctor` for more detail.");
  }

  const configPath = await writeInitialConfig(options);

  await mkdir(serviceDir, { recursive: true });
  await writeFile(join(serviceDir, sessiondServiceName), sessiondUnit(executables));
  await writeFile(join(serviceDir, webServiceName), webUnit(options, executables));

  run("systemctl", ["--user", "daemon-reload"], { check: true });
  run("systemctl", ["--user", "enable", "--now", sessiondServiceName], { check: true });
  run("systemctl", ["--user", "enable", "--now", webServiceName], { check: true });

  console.log(`\nPI WEB is installed and starting.`);
  console.log(`Config: ${configPath}`);
  console.log(`Open: http://${options.host === "0.0.0.0" ? "127.0.0.1" : options.host}:${options.port}`);

  const linger = isLingerEnabled();
  if (linger === false) {
    console.log("\nRecommended for server use: keep user services running after logout/reboot:");
    console.log(`  sudo loginctl enable-linger ${userInfo().username}`);
  } else if (linger === undefined) {
    console.log("\nRecommended for server use: enable systemd user lingering so services survive logout/reboot:");
    console.log(`  sudo loginctl enable-linger ${userInfo().username}`);
  }

  console.log("\nUseful commands:");
  console.log("  pi-web status");
  console.log("  pi-web logs");
  console.log("  pi-web restart");
}

async function uninstall(): Promise<void> {
  run("systemctl", ["--user", "disable", "--now", webServiceName]);
  run("systemctl", ["--user", "disable", "--now", sessiondServiceName]);
  await rm(join(serviceDir, webServiceName), { force: true });
  await rm(join(serviceDir, sessiondServiceName), { force: true });
  run("systemctl", ["--user", "daemon-reload"]);
  console.log("PI WEB systemd user services removed.");
}

function serviceAction(action: "start" | "stop" | "restart" | "status"): void {
  run("systemctl", ["--user", action, sessiondServiceName, webServiceName], { check: action !== "status" });
}

function logs(): void {
  run("journalctl", ["--user", "-u", sessiondServiceName, "-u", webServiceName, "-f"]);
}

function serviceShellLabel(): string {
  return `${detectServiceShell().name} -lc`;
}

function systemdUserServiceShellCommand(command: string): string[] {
  return [
    "systemd-run",
    "--user",
    "--wait",
    "--collect",
    "--pipe",
    "--quiet",
    ...serviceShellCommand(command),
  ];
}

function commandCheck(command: string): string {
  return `command -v ${command}`;
}

function nodeVersionCheck(): string {
  return [
    commandCheck("node"),
    "node -e \"const major = Number(process.versions.node.split('.')[0]); console.log(process.version); process.exit(major >= 22 ? 0 : 1);\"",
  ].join(" && ");
}

function installPreflightChecks(executables: ServiceExecutables = resolveServiceExecutables()): Check[] {
  const shell = serviceShellLabel();
  return [
    ["systemctl --user", ["systemctl", "--user", "--version"]],
    [`${shell} can find node >= 22`, serviceShellCommand(nodeVersionCheck())],
    [`systemd user ${shell} can find node >= 22`, systemdUserServiceShellCommand(nodeVersionCheck())],
    ...executables.web.checks,
    ...executables.sessiond.checks,
  ];
}

function doctorChecks(): Check[] {
  const shell = serviceShellLabel();
  const executables = resolveServiceExecutables();
  return [
    ...installPreflightChecks(executables),
    [`${shell} can find npm`, serviceShellCommand(commandCheck("npm"))],
    [`${shell} can find pi`, serviceShellCommand(commandCheck("pi"))],
    [`systemd user ${shell} can find pi`, systemdUserServiceShellCommand(commandCheck("pi"))],
  ];
}

function runChecks(checks: Check[]): boolean {
  let failed = false;
  for (const [label, command] of checks) {
    const [bin, ...args] = command;
    if (bin === undefined) continue;
    const result = capture(bin, args);
    const ok = result.status === 0;
    failed ||= !ok;
    console.log(`${ok ? "✓" : "✗"} ${label}`);
    const output = (result.stdout || result.stderr).trim();
    if (output !== "") {
      const lines = output.split("\n");
      for (const line of lines.slice(0, 3)) console.log(`  ${line}`);
      if (lines.length > 3) console.log("  ...");
    }
  }
  return !failed;
}

function printPathSetupAdvice(): void {
  const shell = detectServiceShell();
  console.log("\nPATH setup advice:");
  if (shell.name === "bash") {
    console.log("  Detected bash. Put PATH setup for node/version managers/tools in ~/.bash_profile or ~/.profile.");
    console.log("  If ~/.bash_profile exists, bash will not read ~/.profile unless you source it from ~/.bash_profile.");
    console.log("  Do not rely only on ~/.bashrc or prompt hooks for tools needed by services or agents.");
  } else if (shell.name === "zsh") {
    console.log("  Detected zsh. Put PATH setup for node/version managers/tools in ~/.zprofile, not only ~/.zshrc.");
    console.log("  Avoid relying on prompt hooks; PI WEB services run non-interactive login shells.");
  } else {
    console.log("  Detected fish. Prefer universal PATH setup such as `fish_add_path -U ...` for tools needed by services or agents.");
    console.log("  Avoid relying on prompt hooks; PI WEB services run non-interactive login shells.");
  }
}

function doctor(): void {
  console.log(`Service shell: ${describeServiceShell()}`);
  const ok = runChecks(doctorChecks());

  const linger = isLingerEnabled();
  if (linger === true) {
    console.log("✓ systemd user lingering enabled");
  } else if (linger === false) {
    console.log("✗ systemd user lingering disabled");
    console.log(`  Recommended on servers: sudo loginctl enable-linger ${userInfo().username}`);
  } else {
    console.log("? systemd user lingering unknown");
    console.log(`  Recommended on servers: sudo loginctl enable-linger ${userInfo().username}`);
  }

  if (!ok) {
    console.log("\nIf a command works in your terminal but fails here, make sure your service shell login files set PATH the same way.");
    console.log("If a bundled entrypoint is not accessible, reinstall or update the PI WEB package.");
    printPathSetupAdvice();
    process.exitCode = 1;
  }
}

function help(): void {
  console.log(`PI WEB

Usage:
  pi-web install [--host 127.0.0.1] [--port 8504] [--config ~/.config/pi-web/config.json]
  pi-web uninstall
  pi-web start|stop|restart|status|logs
  pi-web doctor

Recommended install:
  npm install -g @jmfederico/pi-web
  pi-web install
`);
}

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  if (command === "install") await install(args);
  else if (command === "uninstall") await uninstall();
  else if (command === "start" || command === "stop" || command === "restart" || command === "status") serviceAction(command);
  else if (command === "logs") logs();
  else if (command === "doctor") doctor();
  else if (command === "help" || command === "--help" || command === "-h") help();
  else throw new Error(`Unknown command: ${command}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
