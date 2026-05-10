import { existsSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { piWebDataDir } from "../config.js";

const pluginIdPattern = /^[a-z][a-z0-9.-]*$/u;
const defaultEntryFile = "pi-web-plugin.js";

export interface PiWebPluginManifest {
  plugins: { id: string; module: string }[];
}

interface PluginRecord {
  id: string;
  root: string;
  entryFile: string;
}

export class PiWebPluginService {
  constructor(private readonly roots = defaultPluginRoots()) {}

  async manifest(): Promise<PiWebPluginManifest> {
    const plugins = await this.discoverPlugins();
    return {
      plugins: plugins.map((plugin) => ({
        id: plugin.id,
        module: `/pi-web-plugins/${encodeURIComponent(plugin.id)}/${plugin.entryFile}`,
      })),
    };
  }

  async readAsset(pluginId: string, assetPath: string): Promise<{ content: Buffer; contentType: string } | undefined> {
    if (!pluginIdPattern.test(pluginId)) return undefined;
    const plugin = (await this.discoverPlugins()).find((candidate) => candidate.id === pluginId);
    if (plugin === undefined) return undefined;

    const resolved = resolve(plugin.root, assetPath);
    const [realRoot, realAsset] = await Promise.all([
      realpath(plugin.root),
      realpath(resolved).catch(() => undefined),
    ]);
    if (realAsset === undefined || !isWithin(realRoot, realAsset)) return undefined;

    const assetStat = await stat(realAsset).catch(() => undefined);
    if (assetStat?.isFile() !== true) return undefined;

    return { content: await readFile(realAsset), contentType: contentTypeFor(realAsset) };
  }

  private async discoverPlugins(): Promise<PluginRecord[]> {
    const records = new Map<string, PluginRecord>();
    for (const root of this.roots) {
      for (const plugin of await discoverRoot(root)) {
        if (!records.has(plugin.id)) records.set(plugin.id, plugin);
      }
    }
    return [...records.values()].sort((left, right) => left.id.localeCompare(right.id));
  }
}

function defaultPluginRoots(): string[] {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return [
    join(moduleDir, "..", "..", "pi-web-plugins"),
    join(piWebDataDir(), "plugins"),
  ];
}

async function discoverRoot(root: string): Promise<PluginRecord[]> {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const plugins: PluginRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !pluginIdPattern.test(entry.name)) continue;
    const plugin = await discoverPlugin(join(root, entry.name), entry.name);
    if (plugin !== undefined) plugins.push(plugin);
  }
  return plugins;
}

async function discoverPlugin(root: string, fallbackId: string): Promise<PluginRecord | undefined> {
  const metadata = await readPluginPackage(root);
  const id = metadata?.id ?? fallbackId;
  const entryFile = metadata?.entryFile ?? defaultEntryFile;
  if (!pluginIdPattern.test(id) || entryFile.includes("..") || entryFile.startsWith("/")) return undefined;
  const entryPath = join(root, entryFile);
  const entryStat = await stat(entryPath).catch(() => undefined);
  if (entryStat?.isFile() !== true) return undefined;
  return { id, root, entryFile };
}

async function readPluginPackage(root: string): Promise<{ id?: string; entryFile?: string } | undefined> {
  const packagePath = join(root, "package.json");
  const content = await readFile(packagePath, "utf8").catch(() => undefined);
  if (content === undefined) return undefined;
  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed)) return undefined;
  const pi = parsed["pi"];
  const piWeb = isRecord(parsed["piWeb"]) ? parsed["piWeb"] : isRecord(pi) && isRecord(pi["piWeb"]) ? pi["piWeb"] : undefined;
  if (!isRecord(piWeb)) return undefined;
  return {
    ...(typeof piWeb["id"] === "string" ? { id: piWeb["id"] } : {}),
    ...(typeof piWeb["plugin"] === "string" ? { entryFile: piWeb["plugin"] } : {}),
  };
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
}

function contentTypeFor(path: string): string {
  if (path.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  return "application/octet-stream";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
