import { describe, expect, it } from "vitest";
import type { Workspace } from "@jmfederico/pi-web/plugin-api";
import { TASKS_CONFIG_PATH } from "./config";
import { loadWorkspaceTasksConfig, parseWorkspaceFileResponse, workspaceFileUrl, type FetchLike } from "./workspaceTasksClient";

const workspace: Workspace = {
  id: "workspace 1",
  projectId: "project/1",
  path: "/repo",
  label: "repo",
  isMain: false,
  isGitRepo: true,
  isGitWorktree: true,
};

describe("workspace tasks client", () => {
  it("builds the private workspace file URL", () => {
    expect(workspaceFileUrl(workspace, TASKS_CONFIG_PATH)).toBe("/api/projects/project%2F1/workspaces/workspace%201/file?path=.pi-web%2Ftasks.json");
  });

  it("loads and parses a valid tasks config", async () => {
    const fetcher: FetchLike = () => Promise.resolve(jsonResponse({
      content: JSON.stringify({ version: 1, tasks: [{ id: "build", title: "Build", command: "npm run build" }] }),
      truncated: false,
      binary: false,
    }));

    await expect(loadWorkspaceTasksConfig(workspace, { fetch: fetcher })).resolves.toEqual({
      kind: "loaded",
      path: TASKS_CONFIG_PATH,
      config: {
        version: 1,
        tasks: [{ id: "build", title: "Build", command: "npm run build", confirm: false }],
      },
    });
  });

  it("treats a missing optional tasks config as unconfigured", async () => {
    const fetcher: FetchLike = () => Promise.resolve(missingResponse());

    await expect(loadWorkspaceTasksConfig(workspace, { fetch: fetcher })).resolves.toEqual({
      kind: "missing",
      message: "No workspace tasks configured here.",
      hint: `${TASKS_CONFIG_PATH} is optional. Create it in this workspace if you want custom tasks.`,
    });
  });

  it("returns a visible unavailable state instead of throwing on request failures", async () => {
    const fetcher: FetchLike = () => Promise.resolve(new Response(JSON.stringify({ error: "nope" }), { status: 400 }));

    await expect(loadWorkspaceTasksConfig(workspace, { fetch: fetcher })).resolves.toMatchObject({
      kind: "unavailable",
      message: "Could not load workspace tasks.",
      hint: `Fix ${TASKS_CONFIG_PATH}, then click Refresh.`,
      detail: `Unable to read ${TASKS_CONFIG_PATH}: HTTP 400: nope`,
    });
  });

  it("returns parser details for invalid config files", async () => {
    const fetcher: FetchLike = () => Promise.resolve(jsonResponse({
      content: JSON.stringify({ version: 2, tasks: [] }),
      truncated: false,
      binary: false,
    }));

    await expect(loadWorkspaceTasksConfig(workspace, { fetch: fetcher })).resolves.toMatchObject({
      kind: "unavailable",
      detail: "Config version must be 1",
    });
  });

  it("validates workspace file responses", () => {
    expect(parseWorkspaceFileResponse({ content: "{}", truncated: false, binary: false })).toEqual({ content: "{}", truncated: false, binary: false });
    expect(parseWorkspaceFileResponse({ content: "{}", truncated: "no", binary: false })).toBeUndefined();
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function missingResponse(): Response {
  return new Response(JSON.stringify({ error: "Path does not exist" }), { status: 400 });
}
