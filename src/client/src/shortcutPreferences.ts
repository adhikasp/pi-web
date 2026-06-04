import type { AppAction } from "./actions";
import type { PiWebShortcutConfig } from "./api";

export function applyShortcutPreferences(actions: AppAction[], shortcuts: PiWebShortcutConfig | undefined): AppAction[] {
  if (shortcuts === undefined) return actions;
  return actions.map((action) => applyShortcutPreference(action, shortcuts));
}

export function applyShortcutPreference(action: AppAction, shortcuts: PiWebShortcutConfig): AppAction {
  if (!Object.hasOwn(shortcuts, action.id)) return action;
  const shortcut = shortcuts[action.id];
  if (shortcut === undefined) return action;
  if (shortcut === null) return withoutShortcut(action);
  return { ...action, shortcut };
}

function withoutShortcut(action: AppAction): AppAction {
  const copy = { ...action };
  delete copy.shortcut;
  return copy;
}
