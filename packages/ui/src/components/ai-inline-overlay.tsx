import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createSignal,
  onCleanup,
  type JSX,
} from "solid-js";
import * as m from "@markdraw/i18n";
import { useLocale } from "@markdraw/i18n/solid";
import IconSparkles from "~icons/lucide/sparkles";
import { INLINE_ACTIONS } from "@markdraw/ai/actions.ts";
import type { AiInlineStore } from "../composables/create-ai-inline-store.ts";
import { Button } from "./ui/button.tsx";

const messages = m as unknown as Record<string, () => string>;
const label = (key: string): string => messages[key]?.() ?? key;

const TRANSLATE_LANGS: ReadonlyArray<{ code: string; label: string }> = [
  { code: "English", label: "EN" },
  { code: "pt-BR", label: "PT" },
  { code: "Spanish", label: "ES" },
];

export interface AiInlineOverlayProps {
  store: AiInlineStore;
}

/**
 * Floating AI widget anchored to the editor selection (DJA-13, ⌘I) — the
 * VSCode/Zed inline surface coexisting with the sidebar chat. Pick an action,
 * watch the result stream, then Accept (apply edit) or Reject.
 */
export function AiInlineOverlay(props: AiInlineOverlayProps): JSX.Element {
  const s = props.store;
  const [diagramPrompt, setDiagramPrompt] = createSignal("");

  // Close on Escape while open.
  createEffect(() => {
    if (!s.open()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        s.close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });

  const style = (): JSX.CSSProperties => {
    const a = s.anchor();
    if (!a) return { top: "72px", right: "360px" };
    // Anchor just below the selection; clamp to keep it on-screen.
    const left = Math.min(a.left, window.innerWidth - 380);
    return { top: `${a.bottom + 6}px`, left: `${Math.max(8, left)}px` };
  };

  return (
    <Show when={s.open()}>
      <div class="ai-inline-overlay" style={style()}>
        <div class="ai-inline-header">
          <IconSparkles width={13} height={13} />
          <span>{(useLocale(), label("ai_panel_title"))}</span>
        </div>

        <Switch>
          <Match when={s.status() === "menu" && s.mode() === "diagram"}>
            <textarea
              class="ai-composer-input"
              rows={2}
              placeholder={(useLocale(), label("ai_diagram_placeholder"))}
              value={diagramPrompt()}
              onInput={(e) => setDiagramPrompt(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (diagramPrompt().trim()) void s.runDiagram(diagramPrompt());
                }
              }}
            />
            <div class="ai-inline-row">
              <Button
                size="sm"
                disabled={!diagramPrompt().trim()}
                onClick={() => void s.runDiagram(diagramPrompt())}
              >
                {(useLocale(), label("ai_diagram_generate"))}
              </Button>
            </div>
          </Match>

          <Match when={s.status() === "menu"}>
            <div class="ai-inline-menu">
              <For each={INLINE_ACTIONS}>
                {(a) => (
                  <Show
                    when={a.needsTargetLang}
                    fallback={
                      <button class="ai-inline-action" onClick={() => void s.run(a.id)}>
                        {(useLocale(), label(a.labelKey))}
                      </button>
                    }
                  >
                    <div class="ai-inline-translate">
                      <span class="ai-inline-translate-label">
                        {(useLocale(), label(a.labelKey))}
                      </span>
                      <For each={TRANSLATE_LANGS}>
                        {(lng) => (
                          <button
                            class="ai-inline-lang"
                            onClick={() => void s.run("translate", lng.code)}
                          >
                            {lng.label}
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                )}
              </For>
            </div>
          </Match>

          <Match when={s.status() === "streaming" || s.status() === "done"}>
            <div class="ai-inline-result">
              {s.result()}
              <Show when={s.status() === "streaming"}>
                <span class="ai-message-cursor" aria-hidden="true" />
              </Show>
            </div>
            <div class="ai-inline-row">
              <Show
                when={s.status() === "done"}
                fallback={
                  <Button size="sm" variant="secondary" onClick={() => s.cancel()}>
                    {(useLocale(), label("ai_composer_stop"))}
                  </Button>
                }
              >
                <Button size="sm" onClick={() => s.accept()}>
                  {(useLocale(),
                  label(s.mode() === "diagram" ? "ai_diagram_insert" : "ai_inline_accept"))}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => s.close()}>
                  {(useLocale(), label("ai_inline_reject"))}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const a = s.action();
                    if (a) void s.run(a);
                  }}
                >
                  {(useLocale(), label("ai_message_regenerate"))}
                </Button>
              </Show>
            </div>
          </Match>

          <Match when={s.status() === "error"}>
            <div class="ai-error">{s.error() || (useLocale(), label("ai_error_generic"))}</div>
            <div class="ai-inline-row">
              <Button size="sm" variant="ghost" onClick={() => s.close()}>
                {(useLocale(), label("ai_inline_reject"))}
              </Button>
            </div>
          </Match>
        </Switch>
      </div>
    </Show>
  );
}
