// Tray glyphs and the rule that picks one. Pure on `navigator.platform` and
// the window theme so it is testable without a Tauri runtime.

// Black "A" on a transparent background (88x88 RGBA PNG, base64), generated
// from assets/brand/markdraw-icon-white.svg with the colors inverted.
// Embedded to avoid file path resolution issues between dev and production.
export const TRAY_ICON_BLACK_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAFgAAABYCAYAAABxlTA0AAAE2ElEQVR42u2cXYgVZRjHf0ezbSvT1cWMipQKYkvypi/ctBVLCiGSwIsuFI0uuqkg6OOqm76oQLrIIOjGAinTCwWlsqXUinCRaE0xjUAzN1sl0fKs7k4X8w4djmd35n2emXnmyPuDB5Y9O+/7f35wzs68886BQCAQCAQCgUAgEAgEAoHyqFkH8GAaMMf9/Bvwt3WgS4EO4GlgAIiaasC91mEdsl3pAQa5WGxzDbq/DXjQAwyTLjepYYLkzFwJ7Ce73KT2u2MDKbyGv9ykXrUOX3VuB+rIBdcJHxXjUgO+Qi43qW9or9PP0liNXm5Sq6ybqRrdwAnyE3wCmGndVJX4kPzkJvWBdVNVoRcYI3/BY8AD1s1ZcxnwI/nLbbzKm2LdpCUvUpzcpF6wbtKKm4AzGQRp6yww17pZCzYLZElro3WzZdOXkzifWmLddFlMAvaUILS59gKTrZsvg6cM5Ca1xrr5opkK/GEoeIj41tMly5uGcpN63VpCUcwFzlVAcB24xVpGEWysgNykPrWWkTcLKyC1uRZaS8mLSbS+7e5TPwErgdtcrXS/04w54LK1PWuUIj6j9d6HDveaZuzV1nK0XAUcUwg45MaYaPxDivGPpYxfeV5WNB8BD2aYow/devJL1pKkTMdv80hzrfeY6yPFPKeAGdayJGguKoaBWR5zae/ptd3Fx3XE67DShlcJ5nxSMd8/wA3W0nx4X9FsP7J9DTXga8W871lLy8qtwIiwyTrxea6UHsXcI7TJJfQGYYMR8EYO87+tmP9ja3lpzAdGhc0dBa7OIcNUN5Ykwyhwp7XEidgmbCwCVuSY4wlFjq3WEsfjfkVTRWzY61fkWWQtsxW7hc2MEG9bzZt5wHlhpp3WMptZJmwkAtYWmOtdRa6HraU28oOwiZNk3wU5D/jc1R0Zj+lCfrn+vbXUhEeEDUTAcxnnmA/81XDcKeCujMc+r8j3kLVcgF3C8L+S7Rm3Zrm+ki9HvqT5rbXcpcLgEfC4Qq6v5BWKnKY7gnYKQ39H+mlZmlwfyTXk77TdVnKXCAOPAQtykusj+V7kC/N9FoKlK1cbcpbrI/kTYeZdZcuV7o5M2/QxDTguHDsi3pZ1zQTjaza/LCpTcL8w5Fsp496jkJvU3SlzvCMcd0dZchcIA54k/d7XFcA+hdxB0k/9piP7CIooabPKl8Jwz2Qcfzbws2D8g8D1Ged4VtjDF0XLvU8Y7DB+X5zhK9lHLsRPHh0U9tJbpOAtwlCStd7ZZPu48JWbIL342FKU3GuBC4JAZ4gvV6VzTiRZKheXSfKU0wWXK3eWC8JEwAHlvONJ1shNOCDsaXnWCXx2F94obGImursVQ8Bi4s/khF+Iz8V/V4xbQ/7AeGYXPoLHhGG6Sb80TmOIWOhaV73o5OIydQuPHVXO3RLNXYs9QGcRoYR0onuUbFkRobrQPWOxztpqA+sUfZxzLgphvSJYlZ60lK4ERvjt+vRmDnBaEGqTtdEWbBL0cZr/v96xMB7Fb//XPgp8Synowm/dY8T1XgpLybasuB35f+oy6HYZ0/o47noulRnAK8TrDI1hzhMv7T1Ge3y9Vs1l3cHFG1UOux7FO+DzEjCL+OS77kL9a6ZLRydwM/HC1BHgT+tAgUAgEAgEAoFAIBAIBAI+/Ad6Ee3F+XKpvwAAAABJRU5ErkJggg==";

// The same glyph in white: assets/brand/markdraw-icon-white.svg rendered at
// 88x88 (`rsvg-convert -w 88 -h 88`). Inverting it gives the black one,
// pixel for pixel.
export const TRAY_ICON_WHITE_BASE64 =
  "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";

export type TrayTheme = "light" | "dark" | null;

/**
 * Which glyph the tray shows. macOS draws the black one as a template image
 * and tints it to the menu bar itself. Linux trays show the pixels as they
 * are, so there the glyph follows the desktop's color scheme (the window
 * theme, which Tauri reads from the freedesktop portal): white on a dark bar,
 * black on a light one or when the scheme is unknown. Windows keeps the black
 * glyph.
 */
export function trayIconFor(platform: string, theme: TrayTheme): "black" | "white" {
  return platform.startsWith("Linux") && theme === "dark" ? "white" : "black";
}

export function trayIconBase64(platform: string, theme: TrayTheme): string {
  return trayIconFor(platform, theme) === "white" ? TRAY_ICON_WHITE_BASE64 : TRAY_ICON_BLACK_BASE64;
}

/**
 * Where tray-icon writes the glyph's PNG on Linux, one directory per glyph.
 * Linux trays receive the icon as a file path, and bars such as Omarchy's
 * cache the image by that path for as long as they run. tray-icon names the
 * file after the tray id and a counter, so with a single directory the same
 * path held the black glyph in one run and the white one in the next, and the
 * bar kept showing the old one. Per-glyph directories make every path always
 * hold the same pixels.
 */
export function trayIconDir(base: string, glyph: "black" | "white"): string {
  return `${base.replace(/\/+$/, "")}/tray-icon/markdraw-${glyph}`;
}

/**
 * Keeps the tray glyph in step with the desktop scheme. `event` takes each
 * `system-theme-changed`; `reconcile` reads the scheme once more after the
 * listener is up, to catch a switch made while the tray was being created.
 * Updates run one at a time, in order, and skip the glyph already shown. A
 * reading that a newer event overtakes is dropped: its answer can reach the
 * page after that event, and would otherwise undo it.
 */
export function themeFollower(
  initial: TrayTheme,
  apply: (theme: TrayTheme) => Promise<void>,
): {
  event: (theme: TrayTheme) => Promise<void>;
  reconcile: (read: () => Promise<TrayTheme>) => Promise<void>;
} {
  let shown = initial;
  let events = 0;
  let queue: Promise<void> = Promise.resolve();
  const follow = (next: TrayTheme) => {
    queue = queue
      .then(async () => {
        if (next === shown) return;
        await apply(next);
        shown = next;
      })
      .catch(() => {});
    return queue;
  };
  return {
    event(next) {
      events += 1;
      return follow(next);
    },
    async reconcile(read) {
      const before = events;
      const now = await read();
      if (events === before) await follow(now);
    },
  };
}
