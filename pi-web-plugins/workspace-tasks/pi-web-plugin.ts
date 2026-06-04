import type { PiWebPlugin } from "@jmfederico/pi-web/plugin-api";
import { TASKS_CONFIG_PATH } from "./config.js";
import { defineTasksPanelElement, tasksPanelBadge } from "./tasksPanelElement.js";
import { terminalCommandRunsFromContext } from "./piWebInternal.js";

const plugin: PiWebPlugin = {
  apiVersion: 1,
  name: "Workspace Tasks",
  activate: ({ pluginId, html, svg }) => {
    defineTasksPanelElement();

    return {
      contributions: {
        actions: [
          {
            id: "workspace.open-tasks",
            title: "Open Workspace Tasks",
            description: `Open the workspace Tasks tab. Configure tasks in ${TASKS_CONFIG_PATH}.`,
            group: "Workspace",
            enabled: (context) => context.state.selectedWorkspace !== undefined,
            run: (context) => {
              if (context.state.selectedWorkspace === undefined) return;
              context.selectWorkspaceTool(`${pluginId}:workspace.tasks`);
            },
          },
        ],
        workspacePanels: [
          {
            id: "workspace.tasks",
            title: "Tasks",
            icon: svg`
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 6h11"></path>
                <path d="M9 12h11"></path>
                <path d="M9 18h11"></path>
                <path d="m4 6 .8 .8L6.5 5"></path>
                <path d="m4 12 .8 .8 1.7-1.8"></path>
                <path d="m4 18 .8 .8 1.7-1.8"></path>
              </svg>
            `,
            order: 40,
            badge: ({ workspace }) => tasksPanelBadge(workspace),
            render: (context) => html`<pi-web-workspace-tasks-panel .workspace=${context.workspace} .terminalCommandRuns=${terminalCommandRunsFromContext(context)} .openTerminal=${context.openTerminal}></pi-web-workspace-tasks-panel>`,
          },
        ],
      },
    };
  },
};

export default plugin;
