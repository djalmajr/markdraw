import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { flush } from "solid-js";

import { showToast, Toaster } from "./toast.tsx";
import { toast } from "@ui-sdk/solid/toast";

afterEach(() => {
  toast.dismiss();
  flush();
  cleanup();
});

describe("Toaster + showToast — public API", () => {
  it("mounts the region once and shows title, description and a close button", () => {
    const { baseElement } = render(() => <Toaster />);
    const region = baseElement.querySelector('[data-slot="toast-region"]');
    expect(region).toBeTruthy();
    expect(baseElement.querySelectorAll('[data-slot="toast-region"]').length).toBe(1);

    showToast({
      title: "File not found",
      description: "/docs/missing.md",
      duration: Infinity,
    });
    flush();

    const item = baseElement.querySelector('[data-slot="toast"]') as HTMLElement;
    expect(item).toBeTruthy();
    expect(item.textContent).toContain("File not found");
    expect(item.textContent).toContain("/docs/missing.md");
    expect(item.getAttribute("data-type")).toBe("default");
    expect(item.querySelector('[data-slot="toast-close"]')).toBeTruthy();
    expect(item.querySelector('[data-slot="toast-title"]')!.textContent).toBe("File not found");
    expect(item.querySelector('[data-slot="toast-description"]')!.textContent).toBe("/docs/missing.md");
  });

  it("maps variants to SDK types with text-only title and description", () => {
    const { baseElement } = render(() => <Toaster />);
    showToast({
      title: "Broken",
      description: "details",
      variant: "destructive",
      duration: Infinity,
    });
    flush();
    const item = baseElement.querySelector('[data-slot="toast"]') as HTMLElement;
    expect(item.getAttribute("data-type")).toBe("error");
    expect(item.querySelector('[data-slot="toast-title"]')!.textContent).toBe("Broken");
    expect(item.querySelector('[data-slot="toast-description"]')!.textContent).toBe("details");
  });

  it("keeps the public variant set usable and dismisses on close", () => {
    const { baseElement } = render(() => <Toaster />);
    showToast({ title: "Saved", variant: "success", duration: Infinity });
    flush();
    let item = baseElement.querySelector('[data-slot="toast"]') as HTMLElement;
    expect(item.getAttribute("data-type")).toBe("success");

    fireEvent.click(item.querySelector('[data-slot="toast-close"]') as HTMLElement);
    flush();
    item = baseElement.querySelector('[data-slot="toast"]') as HTMLElement;
    expect(item).toBeNull();
  });

  it("shows the newest toast first (stack contract)", () => {
    const { baseElement } = render(() => <Toaster />);
    showToast({ title: "First", duration: Infinity });
    showToast({ title: "Second", duration: Infinity });
    flush();
    const region = baseElement.querySelector('[data-slot="toast-region"]') as HTMLElement;
    const titles = Array.from(region.querySelectorAll('[data-slot="toast-title"]')).map(
      (el) => el.textContent,
    );
    expect(titles).toEqual(["Second", "First"]);
  });
});
