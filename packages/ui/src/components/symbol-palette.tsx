import { Show } from "solid-js";
import type { Heading } from "@markdraw/core/headings.ts";
import * as m from "@markdraw/i18n";
import { useLocale } from "@markdraw/i18n/solid";
import { Palette } from "./palette.tsx";

export interface SymbolPaletteProps {
  open: boolean;
  headings: readonly Heading[];
  onSelect: (heading: Heading) => void;
  onClose: () => void;
}

export function SymbolPalette(props: SymbolPaletteProps) {
  return (
    <Palette<Heading>
      open={props.open}
      items={props.headings}
      filter={(query, items) => filterHeadings(query, items)}
      getKey={(h) => `${h.line}:${h.text}`}
      placeholder={(useLocale(), m.find_heading_placeholder())}
      ariaLabel={(useLocale(), m.find_heading_placeholder())}
      emptyItemsMessage="No headings in this document"
      emptyResultsMessage="No matching heading"
      renderRow={(heading) => <Row heading={heading} />}
      onSelect={props.onSelect}
      onClose={props.onClose}
    />
  );
}

function filterHeadings(query: string, items: readonly Heading[]): readonly Heading[] {
  if (query === "") return items;
  const q = query.toLowerCase();
  return items.filter((h) => h.text.toLowerCase().includes(q));
}

function Row(props: { heading: Heading }) {
  // 16px per indent level so the visual hierarchy mirrors the file.
  // Level 1 sits flush left.
  const indentPx = () => Math.max(0, props.heading.level - 1) * 16;
  const prefix = () => "#".repeat(props.heading.level);
  return (
    <>
      <div class="quick-open-row-name" style={{ "padding-left": `${indentPx()}px` }}>
        <span class="symbol-palette-prefix">{prefix()}</span>{" "}
        {props.heading.text}
      </div>
      <Show when={props.heading.line >= 0}>
        <div class="quick-open-row-meta">
          <span>line {props.heading.line + 1}</span>
        </div>
      </Show>
    </>
  );
}
