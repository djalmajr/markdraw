import * as m from "@markdraw/i18n";
import { useLocale } from "@markdraw/i18n/solid";
import {
  filterWorkspaceSymbols,
  type WorkspaceSymbol,
} from "@markdraw/core/workspace-symbols.ts";
import { Palette } from "./palette.tsx";

export interface WorkspaceSymbolPaletteProps {
  open: boolean;
  symbols: readonly WorkspaceSymbol[];
  onSelect: (symbol: WorkspaceSymbol) => void;
  onClose: () => void;
}

/**
 * Cmd+T-style "Go to Symbol in Workspace" palette. Uses the same
 * generic `<Palette>` chassis as the local symbol palette and Quick
 * Open — only the row layout differs (we show file path + heading
 * level, since one heading text alone isn't disambiguated across
 * the workspace).
 */
export function WorkspaceSymbolPalette(props: WorkspaceSymbolPaletteProps) {
  return (
    <Palette<WorkspaceSymbol>
      open={props.open}
      items={props.symbols}
      filter={(query, items) => filterWorkspaceSymbols(query, items)}
      getKey={(s) => `${s.rootId}::${s.path}::${s.heading.line}:${s.heading.text}`}
      placeholder={(useLocale(), m.find_workspace_heading_placeholder())}
      ariaLabel={(useLocale(), m.find_workspace_heading_placeholder())}
      emptyItemsMessage="No headings in any document"
      emptyResultsMessage="No matching heading"
      renderRow={(s) => <Row symbol={s} />}
      onSelect={props.onSelect}
      onClose={props.onClose}
    />
  );
}

function Row(props: { symbol: WorkspaceSymbol }) {
  const indentPx = () => Math.max(0, props.symbol.heading.level - 1) * 12;
  const prefix = () => "#".repeat(props.symbol.heading.level);
  return (
    <>
      <div
        class="quick-open-row-name"
        style={{ "padding-left": `${indentPx()}px` }}
      >
        <span class="symbol-palette-prefix">{prefix()}</span>{" "}
        {props.symbol.heading.text}
      </div>
      <div class="quick-open-row-meta">
        <span>{props.symbol.path}</span>
      </div>
    </>
  );
}
