import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** `minimize`/`maximize` default to shown; Linux hides the ones its compositor
 *  doesn't perform (see `window_capabilities`). Close is always there. */
export function WindowControls(props: { minimize?: boolean; maximize?: boolean }) {
  const [isMax, setIsMax] = createSignal(false);

  onMount(() => {
    const win = getCurrentWindow();
    void win.isMaximized().then(setIsMax);
    const unlistenPromise = win.onResized(() => {
      void win.isMaximized().then(setIsMax);
    });
    onCleanup(() => {
      void unlistenPromise.then((fn) => fn());
    });
  });

  const win = () => getCurrentWindow();

  return (
    <div class="win-controls">
      <Show when={props.minimize ?? true}>
        <button
          class="win-controls-btn"
          aria-label="Minimize"
          title="Minimize"
          onClick={() => void win().minimize()}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1">
            <line x1="0" y1="5" x2="10" y2="5" />
          </svg>
        </button>
      </Show>
      <Show when={props.maximize ?? true}>
        <button
          class="win-controls-btn"
          aria-label={isMax() ? "Restore" : "Maximize"}
          title={isMax() ? "Restore" : "Maximize"}
          onClick={() => void win().toggleMaximize()}
        >
          {isMax() ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1">
              <rect x="0.5" y="2.5" width="7" height="7" />
              <path d="M2.5 2.5 V0.5 H9.5 V7.5 H7.5" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1">
              <rect x="0.5" y="0.5" width="9" height="9" />
            </svg>
          )}
        </button>
      </Show>
      <button
        class="win-controls-btn win-controls-btn-close"
        aria-label="Close"
        title="Close"
        onClick={() => void win().close()}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1">
          <line x1="0" y1="0" x2="10" y2="10" />
          <line x1="10" y1="0" x2="0" y2="10" />
        </svg>
      </button>
    </div>
  );
}
