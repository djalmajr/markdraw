import { For, Show } from "solid-js";
import IconMinus from "~icons/lucide/minus";
import IconPlus from "~icons/lucide/plus";
import IconRefreshCw from "~icons/lucide/refresh-cw";
import IconSearch from "~icons/lucide/search";

import type { FontPrefs } from "@asciimark/core/font-prefs.ts";
import { Toggle } from "./ui/toggle.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";
import { Separator } from "./ui/separator.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";

interface ContentToolbarProps {
  autoRefresh: boolean;
  fontFamilies: readonly { readonly id: string; readonly label: string }[];
  fontPrefs: FontPrefs;
  fontSizes: readonly number[];
  onFind?: () => void;
  searchOpen?: boolean;
  onToggleFind?: () => void;
  onFontPrefsChange: (prefs: Partial<FontPrefs>) => void;
  onToggleAutoRefresh: () => void;
}

export function ContentToolbar(props: ContentToolbarProps) {
  function currentSizeIndex() {
    return props.fontSizes.indexOf(props.fontPrefs.fontSize);
  }

  function decreaseFont() {
    const idx = currentSizeIndex();
    if (idx > 0) {
      props.onFontPrefsChange({ fontSize: props.fontSizes[idx - 1] });
    }
  }

  function increaseFont() {
    const idx = currentSizeIndex();
    if (idx < props.fontSizes.length - 1) {
      props.onFontPrefsChange({ fontSize: props.fontSizes[idx + 1] });
    }
  }

  function currentFontLabel() {
    const found = props.fontFamilies.find((f) => f.id === props.fontPrefs.fontFamily);
    return found?.label ?? props.fontPrefs.fontFamily;
  }

  return (
    <div class="content-toolbar no-print space-x-0.5">
      {/* Auto-refresh */}
      <Tooltip>
        <TooltipTrigger
          as={Toggle}
          size="sm"
          pressed={props.autoRefresh}
          onChange={props.onToggleAutoRefresh}
          aria-label="Auto-refresh"
        >
          <IconRefreshCw width={14} height={14} />
        </TooltipTrigger>
        <TooltipContent>Auto-refresh</TooltipContent>
      </Tooltip>
      <Show when={props.onFind || props.onToggleFind}>
        <Tooltip>
          <TooltipTrigger
            as={Toggle}
            size="sm"
            pressed={!!props.searchOpen}
            aria-label="Find in preview"
            onChange={() => {
              if (props.onToggleFind) {
                props.onToggleFind();
                return;
              }
              props.onFind?.();
            }}
          >
            <IconSearch width={14} height={14} />
          </TooltipTrigger>
          <TooltipContent>Find in preview</TooltipContent>
        </Tooltip>
      </Show>
      <Separator orientation="vertical" class="content-toolbar-separator" />
      {/* Font size */}
      <div class="content-toolbar-group">
        <Tooltip>
          <TooltipTrigger
            as="button"
            class="content-toolbar-btn"
            disabled={currentSizeIndex() <= 0}
            aria-label="Decrease font size"
            onClick={decreaseFont}
          >
            <IconMinus width={12} height={12} />
          </TooltipTrigger>
          <TooltipContent>Decrease font size</TooltipContent>
        </Tooltip>
        <span class="content-toolbar-value">{props.fontPrefs.fontSize}</span>
        <Tooltip>
          <TooltipTrigger
            as="button"
            class="content-toolbar-btn"
            disabled={currentSizeIndex() >= props.fontSizes.length - 1}
            aria-label="Increase font size"
            onClick={increaseFont}
          >
            <IconPlus width={12} height={12} />
          </TooltipTrigger>
          <TooltipContent>Increase font size</TooltipContent>
        </Tooltip>
      </div>
      <Separator orientation="vertical" class="content-toolbar-separator" />
      {/* Font family */}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            as={DropdownMenuTrigger}
            class="content-toolbar-select"
          >
            {currentFontLabel()}
          </TooltipTrigger>
          <TooltipContent>Font family</TooltipContent>
        </Tooltip>
        <DropdownMenuContent class="w-48">
          <DropdownMenuRadioGroup
            value={props.fontPrefs.fontFamily}
            onChange={(v) => props.onFontPrefsChange({ fontFamily: v })}
          >
            <For each={[...props.fontFamilies]}>
              {(fam) => (
                <DropdownMenuRadioItem value={fam.id}>
                  {fam.label}
                </DropdownMenuRadioItem>
              )}
            </For>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
