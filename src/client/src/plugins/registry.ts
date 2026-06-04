import { html, svg } from "lit";
import type { AppState } from "../appState";
import type { Workspace } from "../api";
import type { PiWebPluginRegistration, PluginAction, PluginRuntimeContext, QualifiedContributionId, QualifiedPluginAction, QualifiedThemeContribution, QualifiedThemePairContribution, QualifiedWorkspaceLabelContribution, QualifiedWorkspacePanelContribution, ThemeContribution, ThemePairContribution, WorkspaceLabelContribution, WorkspaceLabelItem, WorkspacePanelContext, WorkspacePanelContribution } from "./types";

const idPattern = /^[a-z][a-z0-9.-]*$/u;
const localIdPattern = /^[a-z][a-z0-9.-]*$/u;
const pluginRuntimeScopes = new WeakMap<PluginRuntimeContext, (pluginId: string) => PluginRuntimeContext>();
const workspacePanelScopes = new WeakMap<WorkspacePanelContext, (pluginId: string) => WorkspacePanelContext>();

type RegisteredPluginAction = Omit<PluginAction, "id"> & {
  id: QualifiedContributionId;
  pluginId: string;
  localId: string;
};

export class PluginRegistry {
  private readonly actions: RegisteredPluginAction[] = [];
  private readonly workspacePanels: QualifiedWorkspacePanelContribution[] = [];
  private readonly workspaceLabels: QualifiedWorkspaceLabelContribution[] = [];
  private readonly themes: QualifiedThemeContribution[] = [];
  private readonly themePairs: QualifiedThemePairContribution[] = [];
  private readonly pluginIds = new Set<string>();
  private readonly contributionIds = new Set<QualifiedContributionId>();

  register(registration: PiWebPluginRegistration): void {
    const { id, plugin } = registration;
    this.validatePluginId(id);
    if (this.pluginIds.has(id)) throw new Error(`Duplicate plugin id: ${id}`);
    this.pluginIds.add(id);

    const apiVersion: unknown = plugin.apiVersion;
    if (apiVersion !== 1) throw new Error(`Unsupported plugin API version for ${id}: ${String(apiVersion)}`);
    const result = plugin.activate({ apiVersion: 1, pluginId: id, html, svg });
    const contributions = result.contributions;
    for (const action of contributions.actions ?? []) this.actions.push(this.qualifyAction(id, action));
    for (const panel of contributions.workspacePanels ?? []) this.workspacePanels.push(this.qualifyWorkspacePanel(id, panel));
    for (const contribution of contributions.workspaceLabels ?? []) this.workspaceLabels.push(this.qualifyWorkspaceLabelContribution(id, contribution));
    for (const theme of contributions.themes ?? []) this.themes.push(this.qualifyTheme(id, theme));
    for (const pair of contributions.themePairs ?? []) this.themePairs.push(this.qualifyThemePair(id, pair));
  }

  getActions(context: PluginRuntimeContext): QualifiedPluginAction[] {
    return this.actions.map((action) => {
      const scopedContext = pluginRuntimeContextFor(context, action.pluginId);
      const enabled = action.enabled?.(scopedContext);
      const qualified: QualifiedPluginAction = {
        id: action.id,
        pluginId: action.pluginId,
        localId: action.localId,
        title: action.title,
        run: () => action.run(scopedContext),
      };
      if (action.description !== undefined) qualified.description = action.description;
      if (action.shortcut !== undefined) qualified.shortcut = action.shortcut;
      if (action.group !== undefined) qualified.group = action.group;
      if (enabled !== undefined) qualified.enabled = enabled;
      return qualified;
    });
  }

  getWorkspacePanels(): QualifiedWorkspacePanelContribution[] {
    return [...this.workspacePanels].sort((left, right) => (left.order ?? 1000) - (right.order ?? 1000) || left.title.localeCompare(right.title));
  }

  getThemes(): QualifiedThemeContribution[] {
    return [...this.themes].sort((left, right) => (left.order ?? 1000) - (right.order ?? 1000) || left.name.localeCompare(right.name));
  }

  getThemePairs(): QualifiedThemePairContribution[] {
    return [...this.themePairs].sort((left, right) => (left.order ?? 1000) - (right.order ?? 1000) || left.name.localeCompare(right.name));
  }

  getWorkspaceLabelItems(state: AppState, workspace: Workspace): WorkspaceLabelItem[] {
    const context = { state, workspace };
    return [...this.workspaceLabels]
      .sort((left, right) => (left.order ?? 1000) - (right.order ?? 1000) || left.id.localeCompare(right.id))
      .flatMap((contribution) => {
        if (contribution.visible?.(context) === false) return [];
        return contribution.items(context);
      });
  }

  private qualifyAction(pluginId: string, action: PluginAction): RegisteredPluginAction {
    const id = this.qualify(pluginId, action.id);
    return { ...action, id, pluginId, localId: action.id };
  }

  private qualifyWorkspacePanel(pluginId: string, panel: WorkspacePanelContribution): QualifiedWorkspacePanelContribution {
    const id = this.qualify(pluginId, panel.id);
    const badge = panel.badge;
    return {
      ...panel,
      id,
      pluginId,
      localId: panel.id,
      ...(badge === undefined ? {} : { badge: (context: WorkspacePanelContext) => badge(workspacePanelContextFor(context, pluginId)) }),
      render: (context: WorkspacePanelContext) => panel.render(workspacePanelContextFor(context, pluginId)),
    };
  }

  private qualifyWorkspaceLabelContribution(pluginId: string, contribution: WorkspaceLabelContribution): QualifiedWorkspaceLabelContribution {
    const id = this.qualify(pluginId, contribution.id);
    return { ...contribution, id, pluginId, localId: contribution.id };
  }

  private qualifyTheme(pluginId: string, theme: ThemeContribution): QualifiedThemeContribution {
    const id = this.qualify(pluginId, theme.id);
    return { ...theme, id, pluginId, localId: theme.id };
  }

  private qualifyThemePair(pluginId: string, pair: ThemePairContribution): QualifiedThemePairContribution {
    const id = this.qualify(pluginId, pair.id);
    return {
      ...pair,
      id,
      pluginId,
      localId: pair.id,
      light: this.qualifyReference(pluginId, pair.light),
      dark: this.qualifyReference(pluginId, pair.dark),
    };
  }

  private qualify(pluginId: string, localId: string): QualifiedContributionId {
    this.validateLocalId(localId);
    const qualified: QualifiedContributionId = `${pluginId}:${localId}`;
    if (this.contributionIds.has(qualified)) throw new Error(`Duplicate contribution id: ${qualified}`);
    this.contributionIds.add(qualified);
    return qualified;
  }

  private qualifyReference(pluginId: string, localId: string): QualifiedContributionId {
    this.validateLocalId(localId);
    return `${pluginId}:${localId}`;
  }

  private validatePluginId(pluginId: string): void {
    if (!idPattern.test(pluginId)) throw new Error(`Invalid plugin id: ${pluginId}`);
  }

  private validateLocalId(localId: string): void {
    if (!localIdPattern.test(localId)) throw new Error(`Invalid contribution id: ${localId}`);
  }
}

function pluginRuntimeContextFor(context: PluginRuntimeContext, pluginId: string): PluginRuntimeContext {
  return pluginRuntimeScopes.get(context)?.(pluginId) ?? context;
}

function workspacePanelContextFor(context: WorkspacePanelContext, pluginId: string): WorkspacePanelContext {
  return workspacePanelScopes.get(context)?.(pluginId) ?? context;
}

export function installPluginRuntimeScope(context: PluginRuntimeContext, scope: (pluginId: string) => PluginRuntimeContext): PluginRuntimeContext {
  pluginRuntimeScopes.set(context, scope);
  return context;
}

export function installWorkspacePanelScope(context: WorkspacePanelContext, scope: (pluginId: string) => WorkspacePanelContext): WorkspacePanelContext {
  workspacePanelScopes.set(context, scope);
  return context;
}
