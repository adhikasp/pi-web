interface Updatable {
  requestUpdate: () => void;
}

export function requestPiWebRender(): void {
  const app = document.querySelector("pi-web-app");
  if (isUpdatable(app)) app.requestUpdate();
}

function isUpdatable(value: unknown): value is Updatable {
  return isRecord(value) && typeof value["requestUpdate"] === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
