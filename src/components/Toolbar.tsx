import { Show } from "solid-js";
import IconFolder from "~icons/lucide/folder-open";
import IconFileDown from "~icons/lucide/file-down";
import IconPanelLeft from "~icons/lucide/panel-left";
import IconListTree from "~icons/lucide/list-tree";
import { Button } from "./ui/button.tsx";
import { Toggle } from "./ui/toggle.tsx";
import { Switch, SwitchControl, SwitchThumb, SwitchLabel } from "./ui/switch.tsx";
import { Separator } from "./ui/separator.tsx";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip.tsx";

interface ToolbarProps {
  rootName: string;
  fileName: string | null;
  filePath: string | null;
  autoRefresh: boolean;
  hasFile: boolean;
  sidebarVisible: boolean;
  tocVisible: boolean;
  onToggleAutoRefresh: () => void;
  onToggleSidebar: () => void;
  onToggleToc: () => void;
  onOpenFolder: () => void;
  onExportPdf: () => void;
}

export function Toolbar(props: ToolbarProps) {
  return (
    <header class="toolbar no-print">
      <div class="toolbar-left">
        <Tooltip>
          <TooltipTrigger as={Button} size="sm" onClick={props.onOpenFolder}>
            <IconFolder width={16} height={16} />
            <span>Open Folder</span>
          </TooltipTrigger>
          <TooltipContent>Open a folder containing .adoc files</TooltipContent>
        </Tooltip>

        <Show when={props.rootName}>
          <Separator orientation="vertical" class="mx-2 h-5" />
          <span class="breadcrumb">
            <span class="breadcrumb-root">{props.rootName}</span>
            <Show when={props.filePath}>
              <span class="breadcrumb-sep">/</span>
              <span class="breadcrumb-file">{props.filePath}</span>
            </Show>
          </span>
        </Show>
      </div>

      <div class="toolbar-right">
        <Show when={props.rootName}>
          <Tooltip>
            <TooltipTrigger
              as={Toggle}
              size="sm"
              variant="outline"
              pressed={props.sidebarVisible}
              onChange={props.onToggleSidebar}
              aria-label="Toggle sidebar"
            >
              <IconPanelLeft width={16} height={16} />
            </TooltipTrigger>
            <TooltipContent>Toggle sidebar</TooltipContent>
          </Tooltip>
        </Show>

        <Show when={props.hasFile}>
          <Tooltip>
            <TooltipTrigger
              as={Toggle}
              size="sm"
              variant="outline"
              pressed={props.tocVisible}
              onChange={props.onToggleToc}
              aria-label="Toggle table of contents"
            >
              <IconListTree width={16} height={16} />
            </TooltipTrigger>
            <TooltipContent>Toggle table of contents</TooltipContent>
          </Tooltip>
        </Show>

        <Separator orientation="vertical" class="mx-1 h-5" />

        <Switch
          class="flex items-center gap-2"
          checked={props.autoRefresh}
          onChange={props.onToggleAutoRefresh}
        >
          <SwitchControl>
            <SwitchThumb />
          </SwitchControl>
          <SwitchLabel class="text-xs">Auto-refresh</SwitchLabel>
        </Switch>

        <Show when={props.hasFile}>
          <Separator orientation="vertical" class="mx-1 h-5" />
          <Tooltip>
            <TooltipTrigger as={Button} variant="outline" size="sm" onClick={props.onExportPdf}>
              <IconFileDown width={16} height={16} />
              <span>PDF</span>
            </TooltipTrigger>
            <TooltipContent>Export as PDF (print)</TooltipContent>
          </Tooltip>
        </Show>
      </div>
    </header>
  );
}
