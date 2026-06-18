import { For, Show } from "solid-js";
import type { IndexedFile } from "@markdraw/core/file-index.ts";
import { fuzzyFilter, type RankedResult } from "@markdraw/core/fuzzy.ts";
import * as m from "@markdraw/i18n";
import { useLocale } from "@markdraw/i18n/solid";
import { Palette } from "./palette.tsx";

export interface QuickOpenProps {
  open: boolean;
  files: readonly IndexedFile[];
  /** Set of `${rootId}::${path}` keys; the caller passes the recents map
   *  built from `getRecentFiles()` so recently-opened files surface ahead
   *  of equal-quality matches. */
  recents?: ReadonlySet<string>;
  onSelect: (file: IndexedFile) => void;
  onClose: () => void;
}

const VISIBLE_LIMIT = 50;

export function QuickOpen(props: QuickOpenProps) {
  return (
    <Palette<RankedResult>
      open={props.open}
      items={
        // Wrap the file list as ranked results so the filter and the row
        // renderer share the same shape (with name/path positions).
        props.files.map<RankedResult>((file) => ({
          file,
          score: 0,
          namePositions: [],
          pathPositions: [],
        }))
      }
      filter={(query) =>
        fuzzyFilter(query, props.files, {
          recents: props.recents,
          limit: VISIBLE_LIMIT,
        })
      }
      getKey={(result) => `${result.file.rootId}::${result.file.path}`}
      placeholder={(useLocale(), m.find_placeholder())}
      ariaLabel={(useLocale(), m.find_placeholder())}
      emptyItemsMessage="No files in workspace"
      emptyResultsMessage="No matches"
      renderRow={(result) => <Row result={result} />}
      onSelect={(result) => props.onSelect(result.file)}
      onClose={props.onClose}
    />
  );
}

function Row(props: { result: RankedResult }) {
  return (
    <>
      <div class="quick-open-row-name">
        {renderHighlighted(props.result.file.name, props.result.namePositions)}
      </div>
      <div class="quick-open-row-meta">
        {renderRowMeta(props.result)}
      </div>
    </>
  );
}

function renderHighlighted(text: string, positions: readonly number[]) {
  if (positions.length === 0) return <>{text}</>;
  const chunks: Array<{ text: string; mark: boolean }> = [];
  let cursor = 0;
  let i = 0;
  // Coalesce contiguous positions into a single <mark> so adjacent matched
  // characters render as one continuous highlight (avoids the inline gap
  // between sibling <mark> elements that produces a "m e t r i c" look).
  while (i < positions.length) {
    const start = positions[i]!;
    let end = start + 1;
    while (i + 1 < positions.length && positions[i + 1] === end) {
      end += 1;
      i += 1;
    }
    if (start > cursor) chunks.push({ text: text.slice(cursor, start), mark: false });
    chunks.push({ text: text.slice(start, end), mark: true });
    cursor = end;
    i += 1;
  }
  if (cursor < text.length) chunks.push({ text: text.slice(cursor), mark: false });
  return (
    <>
      <For each={chunks}>
        {(chunk) => chunk.mark ? <mark class="quick-open-hit">{chunk.text}</mark> : <>{chunk.text}</>}
      </For>
    </>
  );
}

function renderRowMeta(result: RankedResult) {
  const file = result.file;
  if (result.pathPositions.length > 0) {
    return (
      <>
        <span class="quick-open-row-root">{file.rootName}</span>
        <span class="quick-open-row-sep">·</span>
        {renderHighlighted(file.path, result.pathPositions)}
      </>
    );
  }
  return (
    <>
      <span class="quick-open-row-root">{file.rootName}</span>
      <Show when={file.parentDir.length > 0}>
        <span class="quick-open-row-sep">·</span>
        <span>{file.parentDir}</span>
      </Show>
    </>
  );
}
