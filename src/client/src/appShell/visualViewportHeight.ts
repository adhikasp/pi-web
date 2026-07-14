export const VISUAL_VIEWPORT_HEIGHT_PROPERTY = "--pi-visual-viewport-height";

export interface VisualViewportHeightSource {
  readonly height: number;
  addEventListener(type: "resize", listener: () => void): void;
  removeEventListener(type: "resize", listener: () => void): void;
}

export interface VisualViewportHeightStyleTarget {
  setProperty(property: string, value: string): void;
  removeProperty(property: string): void;
}

export interface VisualViewportHeightControllerOptions {
  visualViewport?: VisualViewportHeightSource | undefined;
  styleTarget?: VisualViewportHeightStyleTarget | undefined;
}

/**
 * Mirrors `window.visualViewport.height` into a CSS custom property so layout can shrink
 * to fit above the on-screen keyboard even when the browser/WebView keeps the layout
 * viewport (and `dvh` units) at full height while the keyboard is open (Android's default
 * `interactive-widget=resizes-visual` behavior, and older WebViews that ignore
 * `resizes-content` entirely).
 */
export class VisualViewportHeightController {
  private readonly visualViewport: VisualViewportHeightSource | undefined;
  private readonly styleTarget: VisualViewportHeightStyleTarget | undefined;
  private connected = false;

  constructor(options: VisualViewportHeightControllerOptions = {}) {
    this.visualViewport = options.visualViewport ?? browserVisualViewport();
    this.styleTarget = options.styleTarget ?? browserStyleTarget();
  }

  connect(): void {
    if (this.connected || this.visualViewport === undefined || this.styleTarget === undefined) return;
    this.connected = true;
    this.visualViewport.addEventListener("resize", this.onResize);
    this.applyHeight();
  }

  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.visualViewport?.removeEventListener("resize", this.onResize);
    this.styleTarget?.removeProperty(VISUAL_VIEWPORT_HEIGHT_PROPERTY);
  }

  private readonly onResize = (): void => {
    this.applyHeight();
  };

  private applyHeight(): void {
    if (this.visualViewport === undefined || this.styleTarget === undefined) return;
    this.styleTarget.setProperty(VISUAL_VIEWPORT_HEIGHT_PROPERTY, `${String(this.visualViewport.height)}px`);
  }
}

function browserVisualViewport(): VisualViewportHeightSource | undefined {
  return typeof window === "undefined" ? undefined : (window.visualViewport ?? undefined);
}

function browserStyleTarget(): VisualViewportHeightStyleTarget | undefined {
  return typeof document === "undefined" ? undefined : document.documentElement.style;
}
