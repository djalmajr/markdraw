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
