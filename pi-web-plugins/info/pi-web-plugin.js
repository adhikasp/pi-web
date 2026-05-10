const { html } = globalThis.piWebPluginApi;

export default {
  id: "info",
  name: "Info Plugin",
  activate: () => ({
    actions: [
      {
        id: "workspace.show-path",
        title: "Show Current Workspace Path",
        group: "Info",
        enabled: (context) => context.state.selectedWorkspace !== undefined,
        run: (context) => {
          const path = context.state.selectedWorkspace?.path ?? "No workspace selected";
          window.alert(path);
        },
      },
    ],
    workspacePanels: [
      {
        id: "workspace.info",
        title: "Info",
        order: 100,
        render: (context) => html`
          <section class="toolbar"><strong>Info</strong></section>
          <section class="viewer">
            <p><strong>Workspace</strong></p>
            <p class="muted">${context.workspace.label}</p>
            <p class="muted">${context.workspace.path}</p>
          </section>
        `,
      },
    ],
  }),
};
