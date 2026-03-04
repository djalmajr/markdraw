import IconFileText from "~icons/lucide/file-text";
import IconIndentIncrease from "~icons/lucide/indent-increase";
import IconListOrdered from "~icons/lucide/list-ordered";
import IconPilcrow from "~icons/lucide/pilcrow";
import IconRedo2 from "~icons/lucide/redo-2";
import IconSearch from "~icons/lucide/search";
import IconArrowUpDown from "~icons/lucide/arrow-up-down";
import IconUndo2 from "~icons/lucide/undo-2";
import { Toggle } from "./ui/toggle.tsx";
import { Separator } from "./ui/separator.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

type IndentMode = "tabs" | "spaces";

interface EditorToolbarProps {
  searchOpen: boolean;
  showInvisibles: boolean;
  showLineNumbers: boolean;
  indentMode: IndentMode;
  indentSize: number;
  syncScroll: boolean;
  wrapText: boolean;
  canRedo: boolean;
  canUndo: boolean;
  onRedo: () => void;
  onToggleFind: () => void;
  onIndentChange: (mode: IndentMode, size: number) => void;
  onUndo: () => void;
  onToggleShowInvisibles: () => void;
  onToggleShowLineNumbers: () => void;
  onToggleWrapText: () => void;
  onToggleSyncScroll: () => void;
}

export function EditorToolbar(props: EditorToolbarProps) {
  function indentLabel() {
    const mode = props.indentMode === "tabs" ? "Tabs" : "Spaces";
    return `${mode}: ${props.indentSize}`;
  }

  return (
    <div class="editor-toolbar no-print space-x-0.5">
      <Tooltip>
        <TooltipTrigger
          as={Toggle}
          size="sm"
          pressed={props.searchOpen}
          aria-label="Find in editor"
          onChange={() => props.onToggleFind()}
        >
          <IconSearch width={14} height={14} />
        </TooltipTrigger>
        <TooltipContent>Find in editor</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          as="button"
          class="content-toolbar-btn"
          aria-label="Undo"
          disabled={!props.canUndo}
          onClick={props.onUndo}
        >
          <IconUndo2 width={14} height={14} />
        </TooltipTrigger>
        <TooltipContent>Undo</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          as="button"
          class="content-toolbar-btn"
          aria-label="Redo"
          disabled={!props.canRedo}
          onClick={props.onRedo}
        >
          <IconRedo2 width={14} height={14} />
        </TooltipTrigger>
        <TooltipContent>Redo</TooltipContent>
      </Tooltip>
      <Separator orientation="vertical" class="content-toolbar-separator" />
      <Tooltip>
        <TooltipTrigger
          as={Toggle}
          size="sm"
          pressed={props.showLineNumbers}
          onChange={props.onToggleShowLineNumbers}
          aria-label="Show line numbers"
        >
          <IconListOrdered width={14} height={14} />
        </TooltipTrigger>
        <TooltipContent>Line numbers</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          as={Toggle}
          size="sm"
          pressed={props.showInvisibles}
          onChange={props.onToggleShowInvisibles}
          aria-label="Show invisibles"
        >
          <IconPilcrow width={14} height={14} />
        </TooltipTrigger>
        <TooltipContent>Show invisibles</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          as={Toggle}
          size="sm"
          pressed={props.wrapText}
          onChange={props.onToggleWrapText}
          aria-label="Wrap text"
        >
          <IconFileText width={14} height={14} />
        </TooltipTrigger>
        <TooltipContent>Wrap text</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          as={Toggle}
          size="sm"
          pressed={props.syncScroll}
          onChange={props.onToggleSyncScroll}
          aria-label="Sync scroll"
        >
          <IconArrowUpDown width={14} height={14} />
        </TooltipTrigger>
        <TooltipContent>Sync scroll</TooltipContent>
      </Tooltip>
      <Separator orientation="vertical" class="content-toolbar-separator" />
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            as={DropdownMenuTrigger}
            class="content-toolbar-btn"
            aria-label={`Indent settings (${indentLabel()})`}
          >
            <IconIndentIncrease width={14} height={14} />
          </TooltipTrigger>
          <TooltipContent>{indentLabel()}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent>
          <DropdownMenuRadioGroup
            value={`${props.indentMode}:${props.indentSize}`}
            onChange={(value) => {
              const [modeRaw, sizeRaw] = value.split(":");
              const mode = modeRaw === "tabs" ? "tabs" : "spaces";
              const size = Number(sizeRaw) === 4 ? 4 : 2;
              props.onIndentChange(mode, size);
            }}
          >
            <DropdownMenuRadioItem value="spaces:2">Spaces: 2</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="spaces:4">Spaces: 4</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="tabs:2">Tabs: 2</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="tabs:4">Tabs: 4</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
