import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { ReleaseNotesDialog, type ReleaseNotesEntry } from "./release-notes-dialog.tsx";

afterEach(cleanup);

function entry(overrides: Partial<ReleaseNotesEntry> = {}): ReleaseNotesEntry {
  return {
    name: "Markdraw v0.10.0",
    version: "0.10.0",
    body: "## Features\n\n- thing",
    htmlUrl: "https://example.test/v0.10.0",
    publishedAt: "2026-05-06T23:46:24Z",
    ...overrides,
  };
}

const baseProps = {
  open: true,
  currentVersion: "0.10.0",
};

describe("ReleaseNotesDialog", () => {
  it("does not render when open=false", () => {
    render(() => (
      <ReleaseNotesDialog
        {...baseProps}
        open={false}
        loading={false}
        entries={[]}
        error={null}
        onClose={() => {}}
        onOpenInBrowser={() => {}}
      />
    ));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("renders the loading copy when loading=true and skips the entry list", () => {
    // Mutation captured: short-circuiting the loading branch would
    // surface the "No release notes" copy here.
    render(() => (
      <ReleaseNotesDialog
        {...baseProps}
        loading
        entries={null}
        error={null}
        onClose={() => {}}
        onOpenInBrowser={() => {}}
      />
    ));
    expect(screen.getByText(/Fetching release notes/i)).not.toBeNull();
    expect(screen.queryAllByTestId("release-notes-entry")).toHaveLength(0);
  });

  it("renders the error message and keeps the Open on GitHub button visible", () => {
    render(() => (
      <ReleaseNotesDialog
        {...baseProps}
        loading={false}
        entries={null}
        error="boom"
        onClose={() => {}}
        onOpenInBrowser={() => {}}
      />
    ));
    expect(screen.getByText(/boom/i)).not.toBeNull();
    expect(screen.getByRole("button", { name: /Open on GitHub/i })).not.toBeNull();
  });

  it("renders the no-notes fallback when the entries array is empty", () => {
    render(() => (
      <ReleaseNotesDialog
        {...baseProps}
        loading={false}
        entries={[]}
        error={null}
        onClose={() => {}}
        onOpenInBrowser={() => {}}
      />
    ));
    expect(screen.getByText(/No release notes were published/i)).not.toBeNull();
  });

  it("renders one card per entry with name + date + markdown body", () => {
    // Mutation captured: dropping the For loop or hard-coding to the
    // first entry would shrink the rendered list and fail the count.
    render(() => (
      <ReleaseNotesDialog
        {...baseProps}
        loading={false}
        entries={[
          entry({ name: "Markdraw v0.10.0", version: "0.10.0", body: "## Features\n\n- alpha" }),
          entry({ name: "Markdraw v0.9.1", version: "0.9.1", body: "## Fixes\n\n- beta" }),
        ]}
        error={null}
        onClose={() => {}}
        onOpenInBrowser={() => {}}
      />
    ));
    const cards = screen.getAllByTestId("release-notes-entry");
    expect(cards).toHaveLength(2);
    expect(screen.getByText("Markdraw v0.10.0")).not.toBeNull();
    expect(screen.getByText("Markdraw v0.9.1")).not.toBeNull();
    expect(screen.getByText(/alpha/)).not.toBeNull();
    expect(screen.getByText(/beta/)).not.toBeNull();
  });

  it("marks the entry that matches currentVersion as current", () => {
    // Mutation captured: dropping the `version === currentVersion`
    // check would leave every row unmarked and the locator would
    // come up empty.
    render(() => (
      <ReleaseNotesDialog
        {...baseProps}
        currentVersion="0.10.0"
        loading={false}
        entries={[
          entry({ name: "v0.10.0", version: "0.10.0", body: "x" }),
          entry({ name: "v0.9.1", version: "0.9.1", body: "y" }),
        ]}
        error={null}
        onClose={() => {}}
        onOpenInBrowser={() => {}}
      />
    ));
    const cards = screen.getAllByTestId("release-notes-entry");
    expect(cards[0]?.className).toContain("release-notes-entry-current");
    expect(cards[1]?.className).not.toContain("release-notes-entry-current");
  });

  it("falls back to the italic 'no notes' copy for an entry with empty body", () => {
    render(() => (
      <ReleaseNotesDialog
        {...baseProps}
        loading={false}
        entries={[entry({ body: "" })]}
        error={null}
        onClose={() => {}}
        onOpenInBrowser={() => {}}
      />
    ));
    expect(screen.getByText(/No release notes were published/i)).not.toBeNull();
  });

  it("Close button calls onClose without invoking onOpenInBrowser", () => {
    const onClose = vi.fn();
    const onOpenInBrowser = vi.fn();
    render(() => (
      <ReleaseNotesDialog
        {...baseProps}
        loading={false}
        entries={[entry()]}
        error={null}
        onClose={onClose}
        onOpenInBrowser={onOpenInBrowser}
      />
    ));
    fireEvent.click(screen.getByRole("button", { name: /^Close$/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpenInBrowser).not.toHaveBeenCalled();
  });

  it("Open on GitHub button calls onOpenInBrowser without closing", () => {
    const onClose = vi.fn();
    const onOpenInBrowser = vi.fn();
    render(() => (
      <ReleaseNotesDialog
        {...baseProps}
        loading={false}
        entries={[entry()]}
        error={null}
        onClose={onClose}
        onOpenInBrowser={onOpenInBrowser}
      />
    ));
    fireEvent.click(screen.getByRole("button", { name: /Open on GitHub/i }));
    expect(onOpenInBrowser).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});
