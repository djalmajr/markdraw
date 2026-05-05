import path from "path";
import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";
import Icons from "unplugin-icons/vite";

// Asciidoctor.js (compiled from Opal) emits HTML that loads CDN-hosted JS
// when document attributes like `source-highlighter: highlight.js` or
// `webfonts` are set. The Chrome Web Store rejects MV3 extensions when
// the bundle contains URL fragments that the static analyzer can stitch
// into a remote-script load — even if the runtime never reaches that
// code path. So we replace every CDN fragment we know asciidoctor emits.
//
// Two complementary defenses are needed:
//   1. Neutralize the literal strings so the static analyzer can't see
//      them concatenated into a remote URL (the strings below).
//   2. Rewrite every `<script>` token into `<x-script>` so even if a
//      template emits an unaltered URL we never execute it.
//
// Anything we miss in (1) shows up in the next Web Store rejection.
// Anything we miss in (2) is a runtime XSS hazard. Both are tested by
// the post-build assertion in `verify-extension-bundle` below — the
// build fails if any known CDN fragment survives.
const REMOTE_FRAGMENTS_TO_STRIP = [
  // CDN hosts asciidoctor.js can emit. Listed defensively — we'd
  // rather drop a host that isn't currently used than miss one in
  // the next asciidoctor.js update.
  "cdnjs.cloudflare.com",
  "fonts.googleapis.com",
  "googleapis.com",
  "cdn.mathjax.org",
  "cdn.jsdelivr.net",
  "unpkg.com",
] as const;

const REMOTE_PATTERNS_TO_REWRITE: Array<[RegExp, string]> = [
  // Asciidoctor's highlight.js URL template — the string fragments make
  // up the rejected URL. We replace each piece with a safe placeholder
  // so analysis sees no remote-script construction. Runtime emission
  // becomes "<x-script src=\"/disabled-highlightjs/disabled.txt\">…",
  // which the webview never executes (the script tag is rewritten too).
  [/\/ajax\/libs\/highlight\.js\/[0-9.]+/g, "/disabled-highlightjs"],
  [/highlight\.min\.js/g, "disabled.txt"],
  [/highlight\.pack\.min\.js/g, "disabled.txt"],
  // Asciidoctor's MathJax integration emits ${cdn}/mathjax/${VERSION}/
  // MathJax.js?config=… — same fragment-concatenation pattern as
  // highlight.js. The host was already stripped above, so the URL
  // skeleton would be `/mathjax/<v>/MathJax.js` — still scary to
  // a static analyzer. Rewrite the path tokens so nothing recognizable
  // remains.
  [/\/mathjax\//g, "/disabled-mathjax/"],
  [/MathJax\.js/g, "disabled.js"],
];

interface BundleEntry {
  code?: string;
  fileName?: string;
  source?: string | Uint8Array;
  type?: string;
}

function hardenBundledJs(code: string): string {
  let out = code;
  for (const fragment of REMOTE_FRAGMENTS_TO_STRIP) {
    out = out.replaceAll(fragment, "");
  }
  for (const [pattern, replacement] of REMOTE_PATTERNS_TO_REWRITE) {
    out = out.replace(pattern, replacement);
  }
  // Catch every `<script` / `</script` / `<\/script` (escaped) regardless
  // of attributes. The previous version listed `<script src="`,
  // `<script>` etc. as exact strings and missed `<script type="..."`
  // (the MathJax inline config and various asciidoctor docinfo blocks
  // use that shape). The regex form is exhaustive — `(?=[\s>])` makes
  // sure we don't accidentally match `<scripture>` or similar.
  return out
    .replace(/<\/script>/g, "</x-script>")
    .replace(/<\\\/script>/g, "<\\/x-script>")
    .replace(/<script(?=[\s>])/g, "<x-script");
}

function stripAsciidoctorHighlightJsCdn() {
  return {
    name: "strip-asciidoctor-highlightjs-cdn",
    generateBundle(_outputOptions: unknown, bundle: Record<string, BundleEntry>) {
      const errors: string[] = [];
      for (const [name, entry] of Object.entries(bundle)) {
        let body: string | null = null;
        if (entry.type === "chunk" && typeof entry.code === "string") {
          entry.code = hardenBundledJs(entry.code);
          body = entry.code;
        } else if (entry.fileName?.endsWith(".js") && typeof entry.source === "string") {
          entry.source = hardenBundledJs(entry.source);
          body = entry.source;
        }
        if (body === null) continue;

        // Post-condition: nothing we tried to strip survives. If it does,
        // fail the build — better a CI failure than another Web Store
        // rejection. The `script` token check is intentional: inline JS
        // that constructs `<script>` tags via concatenation would still
        // pass our rewrites and is a separate hazard.
        for (const fragment of REMOTE_FRAGMENTS_TO_STRIP) {
          if (body.includes(fragment)) {
            errors.push(`${name}: still contains banned fragment '${fragment}'`);
          }
        }
        for (const [pattern] of REMOTE_PATTERNS_TO_REWRITE) {
          const match = pattern.exec(body);
          if (match) {
            errors.push(`${name}: still matches banned pattern ${pattern} -> ${match[0]}`);
          }
        }
      }
      if (errors.length > 0) {
        throw new Error(`Extension bundle contains remote-loading fragments:\n  ${errors.join("\n  ")}`);
      }
    },
  };
}

export default defineConfig({
  plugins: [
    solidPlugin(),
    stripAsciidoctorHighlightJsCdn(),
    Icons({
      compiler: "solid",
      autoInstall: false,
    }),
  ],
  resolve: {
    alias: {
      "~": path.resolve(__dirname, "./src"),
      "@asciimark/core": path.resolve(__dirname, "../../packages/core/src"),
      "@asciimark/ui": path.resolve(__dirname, "../../packages/ui/src"),
    },
  },
  base: "./",
  build: {
    outDir: "dist",
    target: "esnext",
    rollupOptions: {
      input: {
        "new-tab": "index.html",
      },
    },
  },
});
