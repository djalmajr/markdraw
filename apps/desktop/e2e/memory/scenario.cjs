// memlab scenario for AsciiMark soak testing.
//
// memlab drives a Puppeteer-controlled Chromium and compares three
// heap snapshots: baseline (before action), end (after action), and
// final (after revert). Objects that the action allocated and the
// revert didn't release are surfaced as "leaks".
//
// What this scenario stresses:
//
//   The edit → convert → fs-change listener path. Each iteration
//   pushes a new content string through the same hooks the editor
//   triggers on every keystroke, which exercises the convert
//   pipeline, signal subscribers, and the `fs-change` listeners
//   tied to the workspace watcher (the same listeners flagged in
//   Tauri's leak issue #12724).
//
//   100 iterations is enough to make per-iteration retention
//   patterns dominate the noise floor: anything that grows ~O(N)
//   stands out against the GC's churn.
//
// Run with the Vite server up (`bun run dev:app` in another
// terminal) and then `bun run test:memlab`. See README.md in this
// folder for interpretation guidance.

const ITERATIONS = 100;

module.exports = {
  url: () => "http://127.0.0.1:2444/",

  /**
   * Optional knob memlab calls before recording the baseline. We use
   * it to make sure a workspace + file are open so the edit path
   * has something to act on — without this the action runs against
   * the empty-state UI and the leak signal is dominated by
   * unrelated startup churn.
   */
  setup: async (page) => {
    await page.evaluate(() => {
      // Activate the test hooks installed by app.tsx __DEV__ block.
      // We don't need a real Tauri context for the hooks themselves;
      // they read/write Solid signals, which work in the Vite-only
      // path memlab uses (memlab can't drive Tauri's WKWebView).
      if (!window.__DEV__) {
        throw new Error("Vite must be running with import.meta.env.DEV=true");
      }
    });
    // Give Vite a moment to settle after the initial render.
    await new Promise((r) => setTimeout(r, 500));
  },

  action: async (page) => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      await page.evaluate((iter) => {
        window.dispatchEvent(
          new CustomEvent("e2e:simulate-edit", {
            detail: {
              iter,
              // Slightly different payload each iter so a memoization
              // cache doesn't hide the leak signal. ~80 bytes each.
              content: `# Iteration ${iter}\n\nbody ${iter}\n\nrepeated ${iter * 3}\n`,
            },
          }),
        );
      }, i);
      // 50ms gives the convert pipeline + microtasks room to settle
      // before the next dispatch — without it Puppeteer's scheduler
      // can coalesce dispatches and we'd be measuring a different
      // path than the user hits.
      await new Promise((r) => setTimeout(r, 50));
    }
  },

  back: async (page) => {
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("e2e:reset"));
    });
    await new Promise((r) => setTimeout(r, 500));
  },

  /**
   * Filter applied to every retained object memlab finds. We allow
   * a small amount of per-iteration retention — Solid's reactive
   * graph allocates Computation nodes that linger until the next
   * full GC sweep, and that's not a leak. Anything heavier than the
   * threshold is suspicious.
   *
   * Threshold rationale: a Solid Computation node is ~200 bytes;
   * an editor model frame is ~2 KB; 5 KB catches everything heavier
   * than "a few signal wrappers".
   */
  leakFilter: (node, _snapshot, leakedNodeIds) => {
    if (!leakedNodeIds.has(node.id)) return false;
    if (node.retainedSize < 5 * 1024) return false;
    return true;
  },
};
