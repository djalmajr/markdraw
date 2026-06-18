import { For, Show } from "solid-js";
import MarkdownIt from "markdown-it";
import * as m from "@markdraw/i18n";
import { useLocale } from "@markdraw/i18n/solid";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "./ui/alert-dialog.tsx";
import { Button } from "./ui/button.tsx";

// Same configuration the UpdateAvailableDialog uses — keep them in
// sync so a notes body that renders correctly on the update flow keeps
// rendering correctly when read from the "Release notes" menu entry.
const md = new MarkdownIt({ html: false, breaks: true, linkify: false });

/** One row in the release-history list rendered by the dialog. */
export interface ReleaseNotesEntry {
  /** Display name (e.g. "Markdraw v0.10.0"). */
  name: string;
  /** Bare version (e.g. "0.10.0") — compared against the installed
   *  version to mark the current row. */
  version: string;
  /** Markdown body of the release. Empty string for releases that
   *  shipped without notes. */
  body: string;
  /** Public URL of the release page on GitHub. */
  htmlUrl: string;
  /** ISO timestamp from GitHub. Empty string if unknown. */
  publishedAt: string;
}

export interface ReleaseNotesDialogProps {
  open: boolean;
  /** Currently installed version — used to mark the matching entry
   *  as "current" so users can tell at a glance which row matches
   *  their build. */
  currentVersion: string;
  /** Loading state — when true, the body renders the localized
   *  spinner copy. */
  loading: boolean;
  /** Full history fetched from GitHub. `null` while still loading
   *  or on an error. The dialog renders each entry as a header
   *  (version + date) followed by the markdown body. */
  entries: ReleaseNotesEntry[] | null;
  /** Localized error message. Renders alongside the "Open on
   *  GitHub" CTA when set. */
  error: string | null;
  onClose: () => void;
  /** Opens the public release index in the system browser. */
  onOpenInBrowser: () => void;
}

function formatDate(iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Standalone read-only dialog that shows the recent release history
 * for Markdraw — used by the "Release notes" menu entry and Command
 * Palette command. Pulls the last ~10 entries from
 * djalmajr/markdraw and lays them out as a scrollable
 * stack; the entry that matches the currently-installed version is
 * highlighted so users can locate "what's mine".
 */
export function ReleaseNotesDialog(props: ReleaseNotesDialogProps) {
  return (
    <AlertDialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <AlertDialogContent class="flex max-h-[80vh] w-full max-w-xl flex-col gap-0 overflow-hidden p-0">
        <header class="flex flex-col gap-1 border-b border-border px-6 py-4">
          <AlertDialogTitle class="text-lg font-semibold">
            {(useLocale(), m.release_notes_title())}
          </AlertDialogTitle>
          <AlertDialogDescription class="text-sm text-muted-foreground">
            {(useLocale(), m.release_notes_subtitle({ version: props.currentVersion }))}
          </AlertDialogDescription>
        </header>

        <div class="flex-1 overflow-y-auto px-6 py-4">
          <Show when={props.loading}>
            <p class="text-sm text-muted-foreground">
              {(useLocale(), m.release_notes_loading())}
            </p>
          </Show>
          <Show when={!props.loading && props.error}>
            <p class="text-sm text-destructive">
              {(useLocale(), m.release_notes_error({ message: props.error ?? "" }))}
            </p>
          </Show>
          <Show
            when={
              !props.loading
              && !props.error
              && (props.entries?.length ?? 0) === 0
            }
          >
            <p class="text-sm text-muted-foreground">
              {(useLocale(), m.release_notes_no_notes())}
            </p>
          </Show>
          <Show when={!props.loading && !props.error && (props.entries?.length ?? 0) > 0}>
            <div class="release-notes-history flex flex-col gap-5">
              <For each={props.entries ?? []}>
                {(entry) => (
                  <article
                    class="release-notes-entry rounded-md border border-border px-4 py-3"
                    classList={{ "release-notes-entry-current": entry.version === props.currentVersion }}
                    data-testid="release-notes-entry"
                  >
                    <header class="flex items-baseline justify-between gap-2 mb-2">
                      <h3 class="text-sm font-semibold">{entry.name}</h3>
                      <span class="text-xs text-muted-foreground" data-testid="release-notes-date">
                        {formatDate(entry.publishedAt)}
                      </span>
                    </header>
                    <Show
                      when={entry.body.length > 0}
                      fallback={
                        <p class="text-xs text-muted-foreground italic">
                          {(useLocale(), m.release_notes_no_notes())}
                        </p>
                      }
                    >
                      {/* Safe: md.render runs with `html: false`. */}
                      <div
                        class="release-notes-body text-sm leading-relaxed text-foreground"
                        innerHTML={md.render(entry.body)}
                      />
                    </Show>
                  </article>
                )}
              </For>
            </div>
          </Show>
        </div>

        <footer class="flex justify-end gap-2 border-t border-border px-6 py-4">
          <Button variant="outline" onClick={props.onOpenInBrowser}>
            {(useLocale(), m.release_notes_open_github())}
          </Button>
          <Button onClick={props.onClose}>
            {(useLocale(), m.release_notes_close())}
          </Button>
        </footer>
      </AlertDialogContent>
    </AlertDialog>
  );
}
