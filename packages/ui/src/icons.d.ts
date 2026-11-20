declare module "~icons/*" {
  import { Component } from "solid-js";
import type { JSX } from "@solidjs/web";
  const component: Component<JSX.SvgSVGAttributes<SVGSVGElement>>;
  export default component;
}

declare module "prismjs";
declare module "*?worker" {
  const WorkerCtor: { new (): Worker };
  export default WorkerCtor;
}

declare module "*?worker&url" {
  const src: string;
  export default src;
}

// pdf.js ships an `exports` map without this `?url` subpath, so under
// `moduleResolution: bundler` TS errors before falling back to vite's
// `*?url` wildcard (which the desktop/extension programs don't load —
// they include this file, not env.d.ts). Vite emits the worker as a
// standalone asset and resolves this import to its URL at build time.
declare module "pdfjs-dist/build/pdf.worker.min.mjs?url" {
  const src: string;
  export default src;
}
