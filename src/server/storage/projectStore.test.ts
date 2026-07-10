import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectStore, projectStorePath } from "./projectStore.js";

describe("projectStorePath", () => {
  it("uses PI_WEB_DATA_DIR by default", () => {
    expect(projectStorePath({ PI_WEB_DATA_DIR: "demo-data" }, "/tmp/pi-web")).toBe(resolve("/tmp/pi-web", "demo-data", "projects.json"));
  });

  it("uses PI_WEB_PROJECTS_FILE when configured", () => {
    expect(projectStorePath({ PI_WEB_PROJECTS_FILE: "demo/projects.json" }, "/tmp/pi-web")).toBe(resolve("/tmp/pi-web", "demo/projects.json"));
  });
});

describe("ProjectStore", () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pi-web-project-store-test-"));
    filePath = join(tempDir, "projects.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("derives the name from the path's leaf segment on both platforms' separators", async () => {
    const store = new ProjectStore(filePath);
    const posix = await store.add({ path: "/home/user/my-project" });
    const windows = await store.add({ path: "C:\\Workspace\\pi-web" });
    expect(posix.name).toBe("my-project");
    expect(windows.name).toBe("pi-web");
  });

  it("heals previously-stored projects whose name was wrongly set to the full path", async () => {
    await writeFile(filePath, JSON.stringify({
      projects: [{ id: "p1", name: "C:\\Workspace\\pi-web", path: "C:\\Workspace\\pi-web", createdAt: new Date().toISOString() }],
    }));
    const store = new ProjectStore(filePath);
    const [healed] = await store.list();
    expect(healed?.name).toBe("pi-web");
  });

  it("renames a project", async () => {
    const store = new ProjectStore(filePath);
    const project = await store.add({ path: "/home/user/my-project" });
    const renamed = await store.rename(project.id, "  Custom Name  ");
    expect(renamed.name).toBe("Custom Name");
    expect((await store.get(project.id))?.name).toBe("Custom Name");
  });

  it("rejects renaming an unknown project or to an empty name", async () => {
    const store = new ProjectStore(filePath);
    const project = await store.add({ path: "/home/user/my-project" });
    await expect(store.rename("missing", "New")).rejects.toThrow("Project not found");
    await expect(store.rename(project.id, "  ")).rejects.toThrow("Project name must not be empty");
  });
});
