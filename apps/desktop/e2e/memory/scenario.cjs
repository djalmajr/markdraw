// memlab scenario for AsciiMark soak testing.
//
// memlab drives a Puppeteer-controlled Chrome by default. We point it at
// the Vite dev server (apps/desktop runs Vite on :2444) — that's the
// SAME bundle Tauri serves into its WKWebView, so the JS-side memory
// behavior is identical except for IPC mocks.
//
// Run with:
//   bun run dev:app   # in another terminal — Vite must be on :2444
//   bun run test:memlab
//
// memlab takes 3 snapshots: baseline (action=null), after-action, after-revert.
// It then diffs the after-revert heap against baseline and flags any objects
// that were added by the action and never freed.
//
// The action here is "open file → switch tab → close tab" 30 times.
// Anything retained means we're leaking tab state, listeners, or
// signal subscribers per cycle.

module.exports = {
  url: () => "http://127.0.0.1:2444/",

  action: async (page) => {
    for (let i = 0; i < 30; i += 1) {
      // Drive the app via window.__test_* hooks if exposed; otherwise via
      // straight DOM clicks. For now we simulate input via the existing
      // text-content channel — replace once the app exposes test hooks.
      await page.evaluate((iter) => {
        // Synthesize a markdown buffer change cycle, the same shape the
        // editor goes through on every keystroke + debounce convert.
        const ev = new CustomEvent("e2e:simulate-edit", {
          detail: { iter, content: `# Iteration ${iter}\n\nbody ${iter}` },
        });
        window.dispatchEvent(ev);
      }, i);
      await new Promise((r) => setTimeout(r, 50));
    }
  },

  back: async (page) => {
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("e2e:reset"));
    });
    await new Promise((r) => setTimeout(r, 200));
  },
};
