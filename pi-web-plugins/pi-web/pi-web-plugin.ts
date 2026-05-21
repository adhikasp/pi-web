import type { TemplateResult } from "lit";
import type { AppState } from "../../src/client/src/appState";
import type { HtmlTemplateTag, PiWebPlugin } from "../../src/client/src/plugins/types";
import type { PiWebComponentStatus, PiWebInstallationInfo, PiWebStatusMessage, PiWebStatusResponse } from "../../src/shared/apiTypes";

function messagesFor(state: AppState): PiWebStatusMessage[] {
  return state.piWebStatus?.messages ?? [];
}

function statusFor(state: AppState): PiWebStatusResponse | undefined {
  return state.piWebStatus;
}

function messageCount(state: AppState): number {
  return messagesFor(state).length;
}

function isLocalOrUnknownInstallation(installation: PiWebInstallationInfo | undefined): boolean {
  return installation === undefined || installation.kind === "local" || installation.kind === "unknown";
}

function shouldShowStatusPanel(state: AppState): boolean {
  const status = statusFor(state);
  if (messageCount(state) > 0) return true;
  if (status === undefined) return false;
  return isLocalOrUnknownInstallation(status.components.web.installation)
    || isLocalOrUnknownInstallation(status.components.sessiond.installation);
}

function formatVersion(version: string | undefined): string {
  return version === undefined || version === "" ? "unknown" : version;
}

function installationLabel(installation: PiWebInstallationInfo | undefined): string {
  if (installation === undefined) return "installation unknown";
  if (installation.kind === "pi-package") {
    const scope = installation.scope === undefined ? "" : ` · ${installation.scope}`;
    const source = installation.source ?? "Pi package";
    return `${source}${scope}`;
  }
  if (installation.kind === "npm-global") return "global npm package";
  if (installation.kind === "local") return "local checkout";
  return "installation unknown";
}

function renderComponent(html: HtmlTemplateTag, component: PiWebComponentStatus): TemplateResult {
  const status = !component.available
    ? "unavailable"
    : component.stale
      ? "restart needed"
      : "current";
  return html`
    <div class="pi-web-version-row">
      <strong>${component.label}</strong>
      <span>${status}</span>
      <small>running ${formatVersion(component.runtimeVersion)} · installed ${formatVersion(component.installedVersion)}</small>
      <small>${installationLabel(component.installation)}${component.installation?.path === undefined ? "" : ` · ${component.installation.path}`}</small>
    </div>
  `;
}

function renderCommand(html: HtmlTemplateTag, label: string, command: string): TemplateResult {
  return html`
    <div class="pi-web-command">
      <span>${label}</span>
      <code>${command}</code>
      <button @click=${() => { void navigator.clipboard.writeText(command); }}>Copy</button>
    </div>
  `;
}

function renderStatusPanel(html: HtmlTemplateTag, state: AppState): TemplateResult {
  const status = statusFor(state);
  if (status === undefined) {
    return html`
      <section class="toolbar"><strong>Pi Web</strong></section>
      <section class="viewer"><p class="muted">Checking Pi Web status…</p></section>
    `;
  }

  const messages = status.messages;
  return html`
    <style>
      .viewer.pi-web-status { flex: 1 1 auto; min-height: 0; box-sizing: border-box; display: flex; flex-direction: column; gap: 14px; padding: 12px; overflow-y: auto; overflow-x: hidden; }
      .viewer.pi-web-status section { flex: 0 0 auto; min-width: 0; display: grid; gap: 8px; }
      .pi-web-message { display: grid; gap: 5px; border: 1px solid var(--pi-border); border-radius: 8px; padding: 10px; background: var(--pi-surface); }
      .pi-web-message.warning { border-color: var(--pi-warning-border); background: var(--pi-warning-surface); }
      .pi-web-message.error { border-color: var(--pi-danger); }
      .pi-web-message-title { display: flex; gap: 8px; align-items: baseline; }
      .pi-web-message-title span { color: var(--pi-muted); font-size: 12px; text-transform: uppercase; }
      .pi-web-version-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 3px 10px; border-bottom: 1px solid var(--pi-border-muted); padding: 6px 0; }
      .pi-web-version-row small { grid-column: 1 / -1; color: var(--pi-muted); }
      .pi-web-command { min-width: 0; display: grid; grid-template-columns: minmax(90px, auto) minmax(0, 1fr) auto; gap: 8px; align-items: center; }
      .pi-web-command code { overflow: auto; border: 1px solid var(--pi-border-muted); border-radius: 6px; background: var(--pi-bg); padding: 5px 7px; white-space: nowrap; }
      .pi-web-meta { display: grid; gap: 2px; color: var(--pi-muted); font-size: 12px; }
      @media (max-width: 520px) {
        .pi-web-command { grid-template-columns: minmax(0, 1fr) auto; }
        .pi-web-command > span { grid-column: 1 / -1; }
      }
    </style>
    <section class="toolbar"><strong>Pi Web</strong><span class="stale">beta</span>${messages.length > 0 ? html`<span class="stale">${String(messages.length)}</span>` : null}</section>
    <section class="viewer pi-web-status">
      <section>
        ${messages.length === 0 ? html`<p class="muted">No Pi Web update or restart messages.</p>` : messages.map((message) => html`
          <article class=${`pi-web-message ${message.severity}`}>
            <div class="pi-web-message-title"><strong>${message.title}</strong><span>${message.severity}</span></div>
            <p>${message.body}</p>
            ${message.command === undefined ? null : html`<code>${message.command}</code>`}
          </article>
        `)}
      </section>

      <section>
        <strong>Installed services</strong>
        ${renderComponent(html, status.components.web)}
        ${renderComponent(html, status.components.sessiond)}
      </section>

      <section>
        <strong>Commands</strong>
        ${renderCommand(html, "Update", status.commands.update)}
        ${renderCommand(html, "Restart", status.commands.restart)}
        ${renderCommand(html, "systemd", status.commands.restartSystemd)}
        ${renderCommand(html, "dev", status.commands.restartDev)}
      </section>

      <section class="pi-web-meta">
        <span>Generated ${status.generatedAt}</span>
        ${status.release.latestVersion === undefined ? null : html`<span>Latest npm release ${status.release.latestVersion}</span>`}
        ${status.release.skipped === true ? html`<span>Remote version check skipped.</span>` : null}
        ${status.release.error === undefined ? null : html`<span>Remote version check failed: ${status.release.error}</span>`}
      </section>
    </section>
  `;
}

const plugin: PiWebPlugin = {
  apiVersion: 1,
  name: "Pi Web Status",
  activate: ({ html }) => ({
    contributions: {
      workspacePanels: [
        {
          id: "workspace.status",
          title: "Pi Web",
          order: 100,
          visible: (context) => shouldShowStatusPanel(context.state),
          badge: (context) => {
            const count = messageCount(context.state);
            return html`beta${count > 0 ? html` · ${String(count)}` : null}`;
          },
          render: (context) => renderStatusPanel(html, context.state),
        },
      ],
    },
  }),
};

export default plugin;
