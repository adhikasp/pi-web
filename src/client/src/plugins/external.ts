import { html } from "lit";
import type { PiWebPlugin } from "./types";

interface PluginManifestEntry {
  module: string;
}

interface PluginManifest {
  plugins: PluginManifestEntry[];
}

declare global {
  interface Window {
    piWebPluginApi?: {
      apiVersion: 1;
      html: typeof html;
    };
  }
}

export async function loadExternalPlugins(manifestUrl = "/pi-web-plugins/manifest.json"): Promise<PiWebPlugin[]> {
  window.piWebPluginApi = { apiVersion: 1, html };

  const manifest = await fetchPluginManifest(manifestUrl);
  if (manifest === undefined) return [];

  const plugins: PiWebPlugin[] = [];
  for (const entry of manifest.plugins) {
    try {
      const moduleUrl = new URL(entry.module, new URL(manifestUrl, window.location.href)).toString();
      const module: unknown = await import(/* @vite-ignore */ moduleUrl);
      const plugin = parsePluginModule(module, moduleUrl);
      if (plugin !== undefined) plugins.push(plugin);
    } catch (error) {
      console.warn(`Failed to load Pi Web plugin ${entry.module}`, error);
    }
  }
  return plugins;
}

async function fetchPluginManifest(manifestUrl: string): Promise<PluginManifest | undefined> {
  const response = await fetch(manifestUrl, { cache: "no-store" });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Failed to load plugin manifest: ${response.statusText}`);
  return parseManifest(await response.json());
}

function parseManifest(value: unknown): PluginManifest {
  if (!isRecord(value) || !Array.isArray(value["plugins"])) throw new Error("Invalid plugin manifest");
  return {
    plugins: value["plugins"].map((entry) => {
      if (!isRecord(entry) || typeof entry["module"] !== "string" || entry["module"] === "") throw new Error("Invalid plugin manifest entry");
      return { module: entry["module"] };
    }),
  };
}

function parsePluginModule(module: unknown, moduleUrl: string): PiWebPlugin | undefined {
  if (!isRecord(module)) throw new Error(`Plugin module ${moduleUrl} did not export an object`);
  const plugin = module["default"];
  if (!isPiWebPlugin(plugin)) throw new Error(`Plugin module ${moduleUrl} default export is not a PiWebPlugin`);
  return plugin;
}

function isPiWebPlugin(value: unknown): value is PiWebPlugin {
  return isRecord(value) && typeof value["id"] === "string" && typeof value["name"] === "string" && typeof value["activate"] === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
