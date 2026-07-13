import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createSubsessionToolDefinitions, type SubsessionToolDeps } from "./spawnSubsessionTool.js";

const dispatchModel = { provider: "anthropic", id: "claude-sonnet" };

function ctxFor(sessionId: string, sessionFile: string | undefined, model?: unknown): ExtensionContext {
  const sessionManager = { getSessionId: () => sessionId, getSessionFile: () => sessionFile };
  // The subsession tools only read sessionManager.getSessionId/getSessionFile and model.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub with the minimal surface the tools use.
  return { sessionManager, ...(model === undefined ? {} : { model }) } as unknown as ExtensionContext;
}

function tools(deps: Partial<SubsessionToolDeps>) {
  const full: SubsessionToolDeps = {
    spawn: deps.spawn ?? vi.fn(() => Promise.resolve({ sessionId: "x", cwd: "/repos/a" })),
    list: deps.list ?? vi.fn(() => Promise.resolve([])),
    check: deps.check ?? vi.fn(() => Promise.resolve({ sessionId: "x", cwd: "/repos/a", status: "idle" as const, finalText: "", messageCount: 0 })),
    read: deps.read ?? vi.fn(() => Promise.resolve({ sessionId: "x", cwd: "/repos/a", status: "idle" as const, entries: [], total: 0, matched: 0, start: 0, hasMore: false })),
  };
  const definitions = createSubsessionToolDefinitions("/repos/a", full);
  const find = (name: string) => {
    const tool = definitions.find((definition) => definition.name === name);
    if (tool === undefined) throw new Error(`missing tool ${name}`);
    return tool;
  };
  return {
    spawn: find("spawn_subsession"),
    list: find("list_subsessions"),
    check: find("check_subsession"),
    read: find("read_subsession"),
    yield: find("yield_to_subsessions"),
  };
}

function workingGuidance(sessionId: string): string {
  return `Subsession ${sessionId} is still working, so partial output is unavailable through agent-facing inspection. Continue independent work, or at the join point call yield_to_subsessions alone as the final action in its tool batch. Completion notifications wake the parent automatically; do not poll list_subsessions, check_subsession, or read_subsession.`;
}

function firstText(content: readonly (TextContent | ImageContent)[]): string {
  const first = content[0];
  return first?.type === "text" ? first.text : "";
}

describe("createSubsessionToolDefinitions", () => {
  it("spawn_subsession forwards parent identity and params from the live context", async () => {
    const spawn = vi.fn(() => Promise.resolve({ sessionId: "child-1", cwd: "/repos/a-feature" }));
    const { spawn: spawnTool } = tools({ spawn });

    const result = await spawnTool.execute("call-1", { prompt: "do it", cwd: "/repos/a-feature" }, undefined, undefined, ctxFor("parent-1", "/sessions/parent-1.jsonl", dispatchModel));

    expect(spawn).toHaveBeenCalledWith({
      spawningCwd: "/repos/a",
      parentSessionId: "parent-1",
      parentSessionFile: "/sessions/parent-1.jsonl",
      prompt: "do it",
      cwd: "/repos/a-feature",
      model: dispatchModel,
    });
    expect(result.details).toEqual({ sessionId: "child-1", cwd: "/repos/a-feature" });
    expect(firstText(result.content)).toContain("Started tracked subsession child-1");
  });

  it("guides the parent to continue independent work and use the explicit join action", async () => {
    const { spawn: spawnTool } = tools({
      spawn: vi.fn(() => Promise.resolve({ sessionId: "child-1", cwd: "/repos/a-feature" })),
    });

    expect(spawnTool.description).toBe("Start a tracked child and return after dispatch. Tracked children are join-oriented: continue independent work, then call yield_to_subsessions at the join point. Completion notifications wake the parent automatically; do not poll.");
    expect(spawnTool.promptSnippet).toBe("spawn_subsession: delegate join-oriented work; continue independently, then use yield_to_subsessions at the join point");

    const result = await spawnTool.execute("call-contract", { prompt: "do it" }, undefined, undefined, ctxFor("parent-1", undefined));
    expect(firstText(result.content)).toBe("Started tracked subsession child-1 in /repos/a-feature. Continue independent work, then at the join point call yield_to_subsessions rather than polling for completion.");
  });

  it("distinguishes status inspection from yielding in tool metadata", () => {
    const definitions = tools({});

    expect(definitions.list.description).toBe("Return tracked child statuses for deliberate inspection. This never yields or changes control flow and is not a completion-polling mechanism.");
    expect(definitions.list.promptSnippet).toBe("list_subsessions: deliberately inspect tracked child status without yielding");
    expect(definitions.check.description).toBe("Return status, message count, and latest output for a non-working tracked child. A working child returns guidance instead of partial output. This never yields or changes control flow.");
    expect(definitions.check.promptSnippet).toBe("check_subsession: inspect a non-working child's latest output without yielding");
    expect(definitions.read.description).toBe("Return a filtered, paginated transcript for a non-working tracked child. A working child returns guidance instead of partial transcript entries. This never yields or changes control flow.");
    expect(definitions.read.promptSnippet).toBe("read_subsession: inspect a non-working child's transcript without yielding");
  });

  it("registers the parameterless yield action with terminal-batch guidance", () => {
    const { yield: yieldTool } = tools({});

    expect(yieldTool.parameters).toMatchObject({ type: "object", properties: {} });
    expect(yieldTool.description).toBe("End the current agent run at a tracked-subsession join point when any child is still working, allowing completion notifications to wake the parent. If none are working, remain active and report that there is nothing to wait for. Call alone as the final action in its tool batch; do not poll.");
    expect(yieldTool.promptSnippet).toBe("yield_to_subsessions: at a join point, end this run while tracked children work; call alone as the final tool action");
    expect(yieldTool.promptGuidelines).toEqual([
      "Use yield_to_subsessions only at a join point after all independent parent work is done; tracked subsessions are join-oriented, while optional fire-and-forget work belongs in spawn_session.",
      "Call yield_to_subsessions alone as the final action in its tool batch. Pi ends the run only when every finalized result in that batch is terminating.",
      "Do not poll list_subsessions, check_subsession, or read_subsession for completion; completion notifications wake the parent automatically.",
    ]);
  });

  it("spawn_subsession omits the inherited model when the dispatching session has no current model", async () => {
    const spawn = vi.fn(() => Promise.resolve({ sessionId: "child-2", cwd: "/repos/a" }));
    const { spawn: spawnTool } = tools({ spawn });

    await spawnTool.execute("call-modeless", { prompt: "do it" }, undefined, undefined, ctxFor("parent-1", undefined));

    expect(spawn).toHaveBeenCalledWith({
      spawningCwd: "/repos/a",
      parentSessionId: "parent-1",
      parentSessionFile: undefined,
      prompt: "do it",
      cwd: undefined,
    });
  });

  it("list_subsessions reports the caller's subsessions and their status", async () => {
    const list = vi.fn(() => Promise.resolve([
      { sessionId: "child-1", cwd: "/repos/a", status: "working" as const },
      { sessionId: "child-2", cwd: "/repos/a", status: "idle" as const },
    ]));
    const { list: listTool } = tools({ list });

    const result = await listTool.execute("call-2", {}, undefined, undefined, ctxFor("parent-1", "/sessions/parent-1.jsonl"));

    expect(list).toHaveBeenCalledWith("parent-1", "/sessions/parent-1.jsonl");
    expect(result.details).toEqual({ subsessions: [
      { sessionId: "child-1", cwd: "/repos/a", status: "working" },
      { sessionId: "child-2", cwd: "/repos/a", status: "idle" },
    ] });
    expect(firstText(result.content)).toContain("child-1 [working]");
    expect(result.terminate).toBeUndefined();
  });

  it("list_subsessions reports an empty state", async () => {
    const { list: listTool } = tools({ list: vi.fn(() => Promise.resolve([])) });
    const result = await listTool.execute("call-3", {}, undefined, undefined, ctxFor("parent-1", undefined));
    expect(result.content[0]).toMatchObject({ type: "text", text: "No tracked subsessions." });
    expect(result.terminate).toBeUndefined();
  });

  it("yield_to_subsessions terminates when tracked children are working", async () => {
    const subsessions = [
      { sessionId: "child-1", cwd: "/repos/a", status: "working" as const },
      { sessionId: "child-2", cwd: "/repos/a", status: "idle" as const },
      { sessionId: "child-3", cwd: "/repos/a", status: "working" as const },
    ];
    const list = vi.fn(() => Promise.resolve(subsessions));
    const { yield: yieldTool } = tools({ list });

    const result = await yieldTool.execute("call-yield", {}, undefined, undefined, ctxFor("parent-1", "/sessions/parent-1.jsonl"));

    expect(list).toHaveBeenCalledWith("parent-1", "/sessions/parent-1.jsonl");
    expect(result.details).toEqual({ subsessions });
    expect(firstText(result.content)).toBe("Yielding to working tracked subsessions: child-1, child-3. The current agent run is ending; completion notifications will wake the parent as children stop working.");
    expect(result.terminate).toBe(true);
  });

  it.each([
    { label: "an empty list", subsessions: [] },
    {
      label: "only non-working children",
      subsessions: [
        { sessionId: "child-idle", cwd: "/repos/a", status: "idle" as const },
        { sessionId: "child-error", cwd: "/repos/a", status: "error" as const },
        { sessionId: "child-unknown", cwd: "/repos/a", status: "unknown" as const },
      ],
    },
  ])("yield_to_subsessions remains active with $label", async ({ subsessions }) => {
    const { yield: yieldTool } = tools({ list: vi.fn(() => Promise.resolve(subsessions)) });

    const result = await yieldTool.execute("call-no-yield", {}, undefined, undefined, ctxFor("parent-1", undefined));

    expect(result.details).toEqual({ subsessions });
    expect(firstText(result.content)).toBe("No tracked subsessions are currently working. Nothing was yielded; continue without waiting.");
    expect(result.terminate).toBeUndefined();
  });

  it("check_subsession scopes by parent and returns the final result", async () => {
    const check = vi.fn(() => Promise.resolve({ sessionId: "child-1", cwd: "/repos/a", status: "idle" as const, finalText: "all done", messageCount: 4 }));
    const { check: checkTool } = tools({ check });

    const result = await checkTool.execute("call-4", { sessionId: "child-1" }, undefined, undefined, ctxFor("parent-1", "/sessions/parent-1.jsonl"));

    expect(check).toHaveBeenCalledWith("parent-1", "child-1", "/sessions/parent-1.jsonl");
    expect(result.details).toMatchObject({ sessionId: "child-1", status: "idle", finalText: "all done" });
    expect(firstText(result.content)).toContain("all done");
    expect(result.terminate).toBeUndefined();
  });

  it("check_subsession withholds partial working output without yielding", async () => {
    const partial = { sessionId: "child-1", cwd: "/repos/a", status: "working" as const, finalText: "SECRET PARTIAL OUTPUT", messageCount: 4 };
    const check = vi.fn(() => Promise.resolve(partial));
    const { check: checkTool } = tools({ check });

    const result = await checkTool.execute("call-working-check", { sessionId: "child-1" }, undefined, undefined, ctxFor("parent-1", "/sessions/parent-1.jsonl"));

    expect(check).toHaveBeenCalledWith("parent-1", "child-1", "/sessions/parent-1.jsonl");
    expect(firstText(result.content)).toBe(workingGuidance("child-1"));
    expect(firstText(result.content)).not.toContain("SECRET PARTIAL OUTPUT");
    expect(result.details).toEqual(partial);
    expect(result.terminate).toBeUndefined();
  });

  it("check_subsession preserves non-working error output without yielding", async () => {
    const { check: checkTool } = tools({
      check: vi.fn(() => Promise.resolve({ sessionId: "child-1", cwd: "/repos/a", status: "error" as const, finalText: "child failed", messageCount: 3 })),
    });

    const result = await checkTool.execute("call-error-check", { sessionId: "child-1" }, undefined, undefined, ctxFor("parent-1", undefined));

    expect(firstText(result.content)).toBe("Subsession child-1 [error]:\n\nchild failed");
    expect(result.terminate).toBeUndefined();
  });

  it("check_subsession propagates scope errors so the agent loop reports them", async () => {
    const check = vi.fn(() => Promise.reject(new Error("Session child-9 is not one of your subsessions")));
    const { check: checkTool } = tools({ check });

    await expect(checkTool.execute("call-5", { sessionId: "child-9" }, undefined, undefined, ctxFor("parent-1", undefined)))
      .rejects.toThrow("not one of your subsessions");
  });

  it("read_subsession forwards filter params and renders the transcript", async () => {
    const read = vi.fn(() => Promise.resolve({
      sessionId: "child-1", cwd: "/repos/a", status: "idle" as const,
      entries: [{ index: 2, role: "assistant" as const, parts: [{ kind: "text" as const, text: "the answer" }] }],
      total: 5, matched: 1, start: 2, hasMore: false,
    }));
    const { read: readTool } = tools({ read });

    const result = await readTool.execute("call-6", { sessionId: "child-1", roles: ["assistant"], maxChars: 200 }, undefined, undefined, ctxFor("parent-1", "/sessions/parent-1.jsonl"));

    expect(read).toHaveBeenCalledWith("parent-1", "child-1", { roles: ["assistant"], maxChars: 200 }, "/sessions/parent-1.jsonl");
    expect(result.details).toMatchObject({ sessionId: "child-1", matched: 1 });
    expect(firstText(result.content)).toContain("the answer");
    expect(result.terminate).toBeUndefined();
  });

  it("read_subsession withholds partial working transcripts without yielding", async () => {
    const partial = {
      sessionId: "child-1", cwd: "/repos/a", status: "working" as const,
      entries: [{ index: 2, role: "assistant" as const, parts: [{ kind: "text" as const, text: "SECRET TRANSCRIPT ENTRY" }] }],
      total: 3, matched: 1, start: 2, hasMore: false,
    };
    const read = vi.fn(() => Promise.resolve(partial));
    const { read: readTool } = tools({ read });

    const result = await readTool.execute("call-working-read", { sessionId: "child-1" }, undefined, undefined, ctxFor("parent-1", "/sessions/parent-1.jsonl"));

    expect(read).toHaveBeenCalledWith("parent-1", "child-1", {}, "/sessions/parent-1.jsonl");
    expect(firstText(result.content)).toBe(workingGuidance("child-1"));
    expect(firstText(result.content)).not.toContain("SECRET TRANSCRIPT ENTRY");
    expect(result.details).toEqual(partial);
    expect(result.terminate).toBeUndefined();
  });

  it("read_subsession renders raw tool-call args and the truncation marker in the model-facing text", async () => {
    const read = vi.fn(() => Promise.resolve({
      sessionId: "child-1", cwd: "/repos/a", status: "idle" as const,
      entries: [{
        index: 1, role: "assistant" as const, parts: [
          { kind: "tool_call" as const, toolName: "bash", summary: "ls", args: { command: "ls -la" } },
          { kind: "text" as const, text: "clipped", truncated: { shown: 7, full: 50 } },
        ],
      }],
      total: 3, matched: 1, start: 1, hasMore: false,
    }));
    const { read: readTool } = tools({ read });

    const result = await readTool.execute("call-7", { sessionId: "child-1", includeToolArgs: true }, undefined, undefined, ctxFor("parent-1", undefined));
    const text = firstText(result.content);
    expect(text).toContain("command"); // raw args surfaced in text, not only details
    expect(text).toContain("ls -la");
    expect(text).toContain("[+43 chars truncated"); // 50 - 7
    expect(result.terminate).toBeUndefined();
  });

  it("read_subsession distinguishes an empty page-window from a zero-match result", async () => {
    const read = vi.fn(() => Promise.resolve({
      sessionId: "child-1", cwd: "/repos/a", status: "idle" as const,
      entries: [], total: 5, matched: 4, start: 0, hasMore: false,
    }));
    const { read: readTool } = tools({ read });

    const result = await readTool.execute("call-8", { sessionId: "child-1", before: 0 }, undefined, undefined, ctxFor("parent-1", undefined));
    const text = firstText(result.content);
    expect(text).toContain("4 matched"); // not "nothing matched"
    expect(text).not.toContain("nothing matched");
    expect(result.terminate).toBeUndefined();
  });

  it("read_subsession propagates scope errors so the agent loop reports them", async () => {
    const read = vi.fn(() => Promise.reject(new Error("Session child-9 is not one of your subsessions")));
    const { read: readTool } = tools({ read });

    await expect(readTool.execute("call-9", { sessionId: "child-9" }, undefined, undefined, ctxFor("parent-1", undefined)))
      .rejects.toThrow("not one of your subsessions");
  });
});
