import { Show, createMemo } from "solid-js";
import {
  commandShortcutLabel,
  filterCommands,
  getRecentCommandIds,
  recordCommandUse,
  type Command,
} from "@asciimark/core/command-palette.ts";
import { detectPlatform } from "@asciimark/core/keyboard-shortcuts.ts";
import * as m from "@asciimark/i18n";
import { useLocale } from "@asciimark/i18n/solid";
import { Palette } from "./palette.tsx";

export interface CommandPaletteProps {
  open: boolean;
  commands: readonly Command[];
  /** Override the auto-detected platform. Test-only. */
  platform?: "mac" | "other";
  onClose: () => void;
}

export function CommandPalette(props: CommandPaletteProps) {
  const platform = createMemo(() => {
    if (props.platform) return props.platform;
    return detectPlatform(typeof navigator === "undefined" ? "" : navigator.platform);
  });

  return (
    <Palette<Command>
      open={props.open}
      items={props.commands}
      filter={(query, items) => filterCommands(query, items, getRecentCommandIds())}
      getKey={(c) => c.id}
      placeholder={(useLocale(), m.find_command_placeholder())}
      ariaLabel={(useLocale(), m.find_command_placeholder())}
      emptyItemsMessage="No commands available"
      emptyResultsMessage="No matching command"
      renderRow={(command) => <Row command={command} platform={platform()} />}
      onSelect={(command) => {
        // Close BEFORE running so command side-effects (e.g. opening a
        // dialog of their own) don't fight with the palette's focus
        // restore on close.
        props.onClose();
        recordCommandUse(command.id);
        void command.run();
      }}
      onClose={props.onClose}
    />
  );
}

function Row(props: { command: Command; platform: "mac" | "other" }) {
  const label = () => commandShortcutLabel(props.command.shortcut, props.platform);
  return (
    <>
      <div class="quick-open-row-name">{props.command.title}</div>
      <div class="quick-open-row-meta">
        <span class="quick-open-row-root">{props.command.group}</span>
        <Show when={label().length > 0}>
          <span class="quick-open-row-sep">·</span>
          <span class="command-palette-shortcut">{label()}</span>
        </Show>
      </div>
    </>
  );
}
