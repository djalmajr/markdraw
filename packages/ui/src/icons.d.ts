declare module "~icons/*" {
  import type { Component, JSX } from "solid-js";
  const component: Component<JSX.SvgSVGAttributes<SVGSVGElement>>;
  export default component;
}

declare module "prismjs";
declare module "*?worker" {
  const WorkerCtor: { new (): Worker };
  export default WorkerCtor;
}
