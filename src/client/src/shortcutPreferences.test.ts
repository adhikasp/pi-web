import { describe, expect, it } from "vitest";
import type { AppAction } from "./actions";
import { applyShortcutPreferences } from "./shortcutPreferences";

const noop = () => undefined;

describe("shortcut preferences", () => {
  it("keeps default shortcuts when there is no matching preference", () => {
    const actions = [action({ id: "core:view.chat", shortcut: "mod+1" })];

    expect(applyShortcutPreferences(actions, { "core:view.files": "mod+2" })).toEqual(actions);
  });

  it("overrides action shortcuts by action id", () => {
    expect(applyShortcutPreferences([
      action({ id: "core:view.chat", shortcut: "mod+1" }),
    ], { "core:view.chat": "mod+shift+1" })).toEqual([
      action({ id: "core:view.chat", shortcut: "mod+shift+1" }),
    ]);
  });

  it("removes shortcuts with null preferences", () => {
    expect(applyShortcutPreferences([
      action({ id: "core:view.chat", shortcut: "mod+1" }),
    ], { "core:view.chat": null })).toEqual([
      action({ id: "core:view.chat" }),
    ]);
  });
});

function action(patch: Partial<AppAction>): AppAction {
  return { id: "action", title: "Action", run: noop, ...patch };
}
