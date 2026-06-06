#!/usr/bin/env node
// Prepares the Excalidraw guest as a static asset bundled into the app.
//
// The guest (the real Excalidraw editor, `@zomme/app-excalidraw`) lives in the
// sibling `djalmajr/frame` repo, NOT in this one. In dev it used to run as a
// standalone vite server on :4204; in production there is no such server, so
// the `<z-frame>` iframe had nothing to load. This script makes the guest work
// in BOTH dev and prod with no server: it clones+builds the guest and copies
// its output into `public/excalidraw/`, which vite serves verbatim (dev) and
// Tauri ships in `frontendDist` (prod). The iframe then loads it same-origin
// from `/excalidraw/index.html`.
//
// Idempotent: skips when the output already exists (fast `tauri dev` restarts).
// Force a refresh with `--force` or `FORCE_EXCALIDRAW_GUEST=1`.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_URL = "https://github.com/djalmajr/frame.git";
const REPO_REF = "main";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const cacheRoot = join(desktopRoot, ".cache", "frame");
const guestDir = join(cacheRoot, "apps", "app-excalidraw");
const outDir = join(desktopRoot, "public", "excalidraw");

const force = process.argv.includes("--force") || process.env.FORCE_EXCALIDRAW_GUEST === "1";

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

function log(msg) {
  console.log(`[excalidraw-guest] ${msg}`);
}

if (existsSync(join(outDir, "index.html")) && !force) {
  log("guest already present in public/excalidraw — skipping (use --force to refresh)");
  process.exit(0);
}

log(force ? "refreshing guest bundle…" : "guest bundle missing — building it…");

// 1) Clone (or update) the sibling frame repo into a git-ignored cache.
if (existsSync(join(cacheRoot, ".git"))) {
  log(`updating ${REPO_URL} (${REPO_REF})`);
  run("git", ["fetch", "--depth", "1", "origin", REPO_REF], cacheRoot);
  run("git", ["reset", "--hard", `origin/${REPO_REF}`], cacheRoot);
} else {
  log(`cloning ${REPO_URL} (${REPO_REF})`);
  rmSync(cacheRoot, { recursive: true, force: true });
  mkdirSync(dirname(cacheRoot), { recursive: true });
  run("git", ["clone", "--depth", "1", "--branch", REPO_REF, REPO_URL, cacheRoot]);
}

// 2) Install workspace deps, build the frame packages the guest depends on
//    (@zomme/frame-react → ./dist/index.js etc., which only exist once built),
//    then build the guest with a relative base so its asset URLs resolve under
//    the /excalidraw/ subpath.
log("installing frame deps (bun install)…");
run("bun", ["install"], cacheRoot);

// Build only the two packages the guest actually needs. The repo-wide build
// also compiles frame-solid/-vue/-angular, whose unrelated d.ts emit can fail
// and would needlessly break us.
//
// Build them SEQUENTIALLY, frame first: frame-react's `tsc --emitDeclarationOnly`
// resolves `@zomme/frame/*` against frame's emitted .d.ts, which only exist once
// frame's own build finishes. A single multi-filter run builds them in parallel
// and races — it passed locally but failed in CI with TS7016 ("Could not find a
// declaration file for module '@zomme/frame/sdk'").
log("building @zomme/frame…");
run("bun", ["run", "--filter", "@zomme/frame", "build"], cacheRoot);
log("building @zomme/frame-react…");
run("bun", ["run", "--filter", "@zomme/frame-react", "build"], cacheRoot);

log("building guest (vite build --base=./)…");
run("bunx", ["vite", "build", "--base=./"], guestDir);

// 3) Copy the built guest into the app's public dir.
const builtDist = join(guestDir, "dist");
if (!existsSync(join(builtDist, "index.html"))) {
  console.error("[excalidraw-guest] build produced no dist/index.html — aborting");
  process.exit(1);
}
rmSync(outDir, { recursive: true, force: true });
mkdirSync(dirname(outDir), { recursive: true });
cpSync(builtDist, outDir, { recursive: true });

log(`done → ${outDir}`);
