// Which platforms draw their own window frame. Pure on `navigator.platform`
// so the rule is testable without a Tauri runtime.

/**
 * Windows and Linux turn the native frame off (lib.rs setup) and draw the
 * caption buttons (`<WindowControls />`) at the right end of the toolbar.
 * macOS keeps the native traffic lights over its overlay title bar.
 */
export function usesCustomWindowFrame(platform: string): boolean {
  return platform.startsWith("Win") || platform.startsWith("Linux");
}

/**
 * Linux shows the app menu as a GTK menu bar inside the window, under the
 * toolbar. It must be hidden there (the toolbar menu replaces it), but stay
 * attached so its accelerators keep working. Windows needs nothing: without
 * the native frame its menu bar isn't drawn.
 */
export function hidesNativeMenuBar(platform: string): boolean {
  return platform.startsWith("Linux");
}

/** Window actions the compositor performs (`window_capabilities` command). */
export interface WindowCapabilities {
  minimize: boolean;
  maximize: boolean;
}

/** What every platform but some Linux compositors supports; also the fallback. */
export const ALL_WINDOW_CAPABILITIES: WindowCapabilities = { minimize: true, maximize: true };

/**
 * Right inset the toolbar reserves for the caption buttons: 46px each (the
 * Win11 size). Close is always there; minimize/maximize only when the
 * compositor performs them (tiling compositors such as Hyprland don't minimize).
 */
export function captionButtonsInset(caps: WindowCapabilities): string {
  const buttons = 1 + Number(caps.minimize) + Number(caps.maximize);
  return `${buttons * 46}px`;
}
