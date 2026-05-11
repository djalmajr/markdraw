import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { ReleaseNotesDialog } from "./release-notes-dialog.tsx";

afterEach(cleanup);

const baseProps = {
  open: true,
  version: "0.10.0",
  htmlUrl: "https://example.test/v0.10.0",
};

describe("ReleaseNotesDialog", () => {
  it("does not render when open=false", () => {
    render(() => (
      <ReleaseNotesDialog
        {...baseProps}
        open={false}
        loading={false}
        notes=""
        error={null}
        onClose={() => {}}
        onOpenInBrowser={() => {}}
      />
    ));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("renders the loading copy when loading=true and skips the body", () => {
    // Mutation captured: short-circuiting the loading branch (rendering
    // the empty body fallback instead) would surface the "No release
    // notes" copy here, failing this assertion.
    render(() => (
      <ReleaseNotesDialog
        {...baseProps}
        loading
        notes={null}
        error={null}
        onClose={() => {}}
        onOpenInBrowser={() => {}}
      />
    ));
    expect(screen.getByText(/Fetching release notes/i)).not.toBeNull();
    expect(screen.queryByText(/No release notes were published/i)).toBeNull();
  });

  it("renders the error message and keeps the Open on GitHub button visible", () => {
    // Mutation captured: dropping `props.error` from the visible
    // branch would leave the user staring at a blank body while
    // believing the request actually returned.
    render(() => (
      <ReleaseNotesDialog
        {...baseProps}
        loading={false}
        notes={null}
        error="boom"
        onClose={() => {}}
        onOpenInBrowser={() => {}}
      />
    ));
    expect(screen.getByText(/boom/i)).not.toBeNull();
    expect(screen.getByRole("button", { name: /Open on GitHub/i })).not.toBeNull();
  });

  it("renders the no-notes fallback when notes resolve to an empty string", () => {
    render(() => (
      <ReleaseNotesDialog
        {...baseProps}
        loading={false}
        notes=""
        error={null}
        onClose={() => {}}
        onOpenInBrowser={() => {}}
      />
    ));
    expect(screen.getByText(/No release notes were published/i)).not.toBeNull();
  });

  it("renders the markdown body when notes are non-empty", () => {
    // Mutation captured: changing `(props.notes?.trim()?.length ?? 0) > 0`
    // to `< 0` would render the empty-fallback instead of the parsed
    // markdown — and this assertion looks for the actual heading text.
    render(() => (
      <ReleaseNotesDialog
        {...baseProps}
        loading={false}
        notes="## What's new\n\n- entry one"
        error={null}
        onClose={() => {}}
        onOpenInBrowser={() => {}}
      />
    ));
    expect(screen.getByText(/What's new/i)).not.toBeNull();
    expect(screen.getByText(/entry one/i)).not.toBeNull();
  });

  it("Close button calls onClose without invoking onOpenInBrowser", () => {
    // Mutation captured: swapping the two footer buttons would fail
    // here because the Close handler would never get called.
    const onClose = vi.fn();
    const onOpenInBrowser = vi.fn();
    render(() => (
      <ReleaseNotesDialog
        {...baseProps}
        loading={false}
        notes="ok"
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
        notes="ok"
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
