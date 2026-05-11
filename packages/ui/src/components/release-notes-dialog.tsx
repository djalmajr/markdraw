import { Show, createMemo } from "solid-js";
import MarkdownIt from "markdown-it";
import * as m from "@asciimark/i18n";
import { useLocale } from "@asciimark/i18n/solid";
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

export interface ReleaseNotesDialogProps {
  open: boolean;
  /** Version whose notes are being viewed (e.g. "0.10.0"). */
  version: string;
  /** Loading state from the caller's fetch — when true, the body
   *  renders the localized spinner copy. */
  loading: boolean;
  /** Raw markdown body. `null` while the caller hasn't loaded it yet
   *  (loading=true) or hit an error (error≠null). */
  notes: string | null;
  /** Localized error message. Renders the "Open on GitHub" CTA when
   *  set. */
  error: string | null;
  /** Public URL of the release page (always provided so the user can
   *  fall back to the browser, even on success). */
  htmlUrl: string;
  onClose: () => void;
  /** Opens the release page in the system browser. Implementation is
   *  host-specific (Tauri opener / window.open). */
  onOpenInBrowser: () => void;
}

/**
 * Standalone read-only dialog that shows release notes for any
 * version — used by the "Release notes" menu entry and Command
 * Palette command. The shape mirrors UpdateAvailableDialog
 * (scrollable body + sticky footer) so users see a consistent layout
 * across the two flows.
 */
export function ReleaseNotesDialog(props: ReleaseNotesDialogProps) {
  const renderedNotes = createMemo(() => {
    const body = props.notes?.trim();
    return body ? md.render(body) : "";
  });

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
            {(useLocale(), m.release_notes_subtitle({ version: props.version }))}
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
            when={!props.loading && !props.error && (props.notes?.trim()?.length ?? 0) === 0}
          >
            <p class="text-sm text-muted-foreground">
              {(useLocale(), m.release_notes_no_notes())}
            </p>
          </Show>
          <Show when={!props.loading && !props.error && (props.notes?.trim()?.length ?? 0) > 0}>
            {/* Safe: md.render runs with `html: false`. */}
            <div
              class="release-notes-body text-sm leading-relaxed text-foreground"
              innerHTML={renderedNotes()}
            />
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
