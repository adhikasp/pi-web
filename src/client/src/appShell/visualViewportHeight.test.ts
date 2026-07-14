import { describe, expect, it } from "vitest";
import { VISUAL_VIEWPORT_HEIGHT_PROPERTY, VisualViewportHeightController, type VisualViewportHeightSource, type VisualViewportHeightStyleTarget } from "./visualViewportHeight";

class FakeVisualViewport implements VisualViewportHeightSource {
  height: number;
  private listeners = new Set<() => void>();

  constructor(height: number) {
    this.height = height;
  }

  addEventListener(_type: "resize", listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "resize", listener: () => void): void {
    this.listeners.delete(listener);
  }

  triggerResize(height: number): void {
    this.height = height;
    for (const listener of this.listeners) listener();
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

class FakeStyleTarget implements VisualViewportHeightStyleTarget {
  properties = new Map<string, string>();

  setProperty(property: string, value: string): void {
    this.properties.set(property, value);
  }

  removeProperty(property: string): void {
    this.properties.delete(property);
  }
}

describe("VisualViewportHeightController", () => {
  it("applies the initial visual viewport height on connect", () => {
    const visualViewport = new FakeVisualViewport(700);
    const styleTarget = new FakeStyleTarget();
    const controller = new VisualViewportHeightController({ visualViewport, styleTarget });

    controller.connect();

    expect(styleTarget.properties.get(VISUAL_VIEWPORT_HEIGHT_PROPERTY)).toBe("700px");
    expect(visualViewport.listenerCount).toBe(1);
  });

  it("updates the property when the visual viewport resizes", () => {
    const visualViewport = new FakeVisualViewport(700);
    const styleTarget = new FakeStyleTarget();
    const controller = new VisualViewportHeightController({ visualViewport, styleTarget });

    controller.connect();
    visualViewport.triggerResize(420);

    expect(styleTarget.properties.get(VISUAL_VIEWPORT_HEIGHT_PROPERTY)).toBe("420px");
  });

  it("removes the listener and the property on disconnect", () => {
    const visualViewport = new FakeVisualViewport(700);
    const styleTarget = new FakeStyleTarget();
    const controller = new VisualViewportHeightController({ visualViewport, styleTarget });

    controller.connect();
    controller.disconnect();

    expect(visualViewport.listenerCount).toBe(0);
    expect(styleTarget.properties.has(VISUAL_VIEWPORT_HEIGHT_PROPERTY)).toBe(false);

    visualViewport.triggerResize(420);
    expect(styleTarget.properties.has(VISUAL_VIEWPORT_HEIGHT_PROPERTY)).toBe(false);
  });

  it("is idempotent when connected or disconnected more than once", () => {
    const visualViewport = new FakeVisualViewport(700);
    const styleTarget = new FakeStyleTarget();
    const controller = new VisualViewportHeightController({ visualViewport, styleTarget });

    controller.connect();
    controller.connect();
    expect(visualViewport.listenerCount).toBe(1);

    controller.disconnect();
    controller.disconnect();
    expect(visualViewport.listenerCount).toBe(0);
  });
});
