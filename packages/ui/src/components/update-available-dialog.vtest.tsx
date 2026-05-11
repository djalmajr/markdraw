import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { UpdateAvailableDialog } from "./update-available-dialog.tsx";

afterEach(cleanup);

const BASE = {
  open: true,
  version: "0.11.0",
  currentVersion: "0.10.0",
  notes: "## Notes\n\n- entry",
};

describe("UpdateAvailableDialog — pre-install state", () => {
  it("renders Later and Install buttons when no download is in flight", () => {
    render(() => (
      <UpdateAvailableDialog
        {...BASE}
        downloadProgress={null}
        onInstall={() => {}}
        onDismiss={() => {}}
      />
    ));
    expect(screen.getByRole("button", { name: /Later/i })).not.toBeNull();
    expect(screen.getByRole("button", { name: /Install and restart/i })).not.toBeNull();
    expect(screen.queryByTestId("update-progress-bar")).toBeNull();
  });

  it("Install button dispatches onInstall exactly once", () => {
    const onInstall = vi.fn();
    render(() => (
      <UpdateAvailableDialog
        {...BASE}
        downloadProgress={null}
        onInstall={onInstall}
        onDismiss={() => {}}
      />
    ));
    fireEvent.click(screen.getByRole("button", { name: /Install and restart/i }));
    expect(onInstall).toHaveBeenCalledTimes(1);
  });
});

describe("UpdateAvailableDialog — download progress (DJA-34)", () => {
  it("swaps the action footer for the progress bar when downloadProgress is set", () => {
    // Mutation captured: dropping the <Show when={downloadProgress}>
    // gate would leave the action buttons live during download and
    // the user could re-click "Install" mid-install — a double-click
    // hazard for the native updater.
    render(() => (
      <UpdateAvailableDialog
        {...BASE}
        downloadProgress={{
          phase: "downloading",
          downloaded: 10 * 1024 * 1024,
          total: 30 * 1024 * 1024,
          speed: 1024 * 1024,
        }}
        onInstall={() => {}}
        onDismiss={() => {}}
      />
    ));
    expect(screen.queryByRole("button", { name: /Install and restart/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Later/i })).toBeNull();
    expect(screen.getByTestId("update-progress-bar")).not.toBeNull();
  });

  it("renders the determinate copy with formatted sizes and speed", () => {
    // Mutation captured: swapping `formatBytes(progress.total)` for the
    // raw number would leak a "31457280" reading into the copy
    // instead of the human-readable "30.0 MB".
    render(() => (
      <UpdateAvailableDialog
        {...BASE}
        downloadProgress={{
          phase: "downloading",
          downloaded: 10 * 1024 * 1024,
          total: 30 * 1024 * 1024,
          speed: 1024 * 1024,
        }}
        onInstall={() => {}}
        onDismiss={() => {}}
      />
    ));
    const copy = screen.getByTestId("update-progress-copy").textContent ?? "";
    expect(copy).toContain("10.0 MB");
    expect(copy).toContain("30.0 MB");
    expect(copy).toContain("1.0 MB/s");
  });

  it("renders the indeterminate copy when total is null (no content-length)", () => {
    // Domain rule: a missing content-length must NOT render "X / 0".
    render(() => (
      <UpdateAvailableDialog
        {...BASE}
        downloadProgress={{
          phase: "downloading",
          downloaded: 5 * 1024 * 1024,
          total: null,
          speed: 512 * 1024,
        }}
        onInstall={() => {}}
        onDismiss={() => {}}
      />
    ));
    const copy = screen.getByTestId("update-progress-copy").textContent ?? "";
    expect(copy).toContain("5.0 MB");
    expect(copy).toContain("512.0 KB/s");
    expect(copy).not.toMatch(/0 B(?!\/)/);
    expect(copy).not.toMatch(/\/ 0/);
  });

  it("renders the Installing… copy after the download finishes", () => {
    // Mutation captured: rendering the downloading copy even when
    // phase === 'installing' would leave the user staring at "X / X"
    // instead of a clear "Installing…" signal during the install
    // phase.
    render(() => (
      <UpdateAvailableDialog
        {...BASE}
        downloadProgress={{
          phase: "installing",
          downloaded: 30 * 1024 * 1024,
          total: 30 * 1024 * 1024,
          speed: 0,
        }}
        onInstall={() => {}}
        onDismiss={() => {}}
      />
    ));
    expect(screen.getByText(/Installing/i)).not.toBeNull();
  });
});
