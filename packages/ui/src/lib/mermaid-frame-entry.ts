import mermaid from "mermaid";
import type { MermaidFrameWindow } from "./mermaid-frame.ts";

(window as MermaidFrameWindow).markdrawMermaid = {
  initialize: mermaid.initialize,
  render: mermaid.render,
};
