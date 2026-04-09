import { For, Show } from "solid-js";
import type { RecentFile } from "@asciimark/core/recent-files.ts";
import type { RecentFolder } from "@asciimark/core/recent-folders.ts";
import IconArrowLeft from "~icons/lucide/arrow-left";
import IconArrowRight from "~icons/lucide/arrow-right";
import IconClock from "~icons/lucide/clock";
import IconFileDown from "~icons/lucide/file-down";
import IconFileText from "~icons/lucide/file-text";
import IconFolder from "~icons/lucide/folder-open";
import IconListTree from "~icons/lucide/list-tree";
import IconMonitor from "~icons/lucide/monitor";
import IconMoon from "~icons/lucide/moon";
import IconPanelLeft from "~icons/lucide/panel-left";
import IconMenu from "~icons/lucide/menu";
import IconSun from "~icons/lucide/sun";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs.tsx";
import { Toggle } from "./ui/toggle.tsx";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";

interface ToolbarProps {
  canGoBack?: boolean;
  canGoForward?: boolean;
  darkMode: boolean;
  editorMode: "edit" | "split" | "preview";
  hasFile: boolean;
  hasRoot: boolean;
  /** Whether the current file supports preview (markdown / asciidoc). */
  supportsPreview: boolean;
  inWindowFrame?: boolean;
  recentFiles?: RecentFile[];
  recentFolders?: RecentFolder[];
  showEditorTabs: boolean;
  showNavButtons?: boolean;
  showRecentHistory?: boolean;
  sidebarVisible: boolean;
  themeMode: string;
  tocVisible: boolean;
  onEditorModeChange: (mode: "edit" | "split" | "preview") => void;
  onExportPdf?: () => void;
  onGoBack?: () => void;
  onGoForward?: () => void;
  onOpenFolder?: () => void;
  onOpenRecentFile?: (recentFile: RecentFile) => void | Promise<void>;
  onOpenRecentFolder?: (path: string) => void | Promise<void>;
  onThemeChange: (mode: string) => void;
  onToggleSidebar: () => void;
  onToggleToc: () => void;
  onWindowDragStart?: () => void | Promise<void>;
  onWindowTitleDoubleClick?: () => void | Promise<void>;
}

export function Toolbar(props: ToolbarProps) {
  const hasRecentItems = () =>
    !!props.showRecentHistory &&
    ((props.recentFolders?.length ?? 0) > 0 || (props.recentFiles?.length ?? 0) > 0);

  function isInteractiveTarget(target: HTMLElement) {
    return target.closest(
      "button,[role='button'],[role='tab'],a,input,select,textarea,[data-no-window-drag]"
    );
  }

  function handleMouseDown(e: MouseEvent) {
    if (!props.inWindowFrame) return;
    if (e.button !== 0) return;
    if (e.detail > 1) return;

    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (isInteractiveTarget(target)) return;

    void props.onWindowDragStart?.();
  }

  function handleDoubleClick(e: MouseEvent) {
    if (!props.inWindowFrame) return;
    if (e.button !== 0) return;

    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (isInteractiveTarget(target)) return;

    void props.onWindowTitleDoubleClick?.();
  }

  return (
    <header
      class="toolbar no-print"
      classList={{ "toolbar-window-frame": !!props.inWindowFrame }}
      onMouseDown={handleMouseDown}
      onDblClick={handleDoubleClick}
      ref={(el) => {
        const update = () => {
          const h = el.offsetHeight;
          document.documentElement.style.setProperty("--toolbar-h", `${h}px`);
        };
        update();
        // Update on resize in case toolbar wraps
        new ResizeObserver(update).observe(el);
      }}
    >
      <div class="toolbar-left">
        <Show when={props.showNavButtons}>
          <Tooltip>
            <TooltipTrigger
              as="button"
              class="inline-flex items-center justify-center rounded-md h-7 w-7 text-sm hover:bg-accent hover:text-accent-foreground disabled:opacity-30 disabled:pointer-events-none"
              aria-label="Go back"
              disabled={!props.canGoBack}
              onClick={props.onGoBack}
            >
              <IconArrowLeft width={16} height={16} />
            </TooltipTrigger>
            <TooltipContent>Go back</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              as="button"
              class="inline-flex items-center justify-center rounded-md h-7 w-7 text-sm hover:bg-accent hover:text-accent-foreground disabled:opacity-30 disabled:pointer-events-none"
              aria-label="Go forward"
              disabled={!props.canGoForward}
              onClick={props.onGoForward}
            >
              <IconArrowRight width={16} height={16} />
            </TooltipTrigger>
            <TooltipContent>Go forward</TooltipContent>
          </Tooltip>
        </Show>
      </div>
      <Show when={props.showEditorTabs}>
        <div class="toolbar-center">
          <Tabs
            value={props.editorMode}
            onChange={(v) => props.onEditorModeChange(v as "edit" | "split" | "preview")}
          >
            <TabsList>
              <TabsTrigger disabled={!props.hasFile} value="edit">Edit</TabsTrigger>
              <TabsTrigger
                disabled={!props.hasFile || !props.supportsPreview}
                value="split"
              >
                Edit & Preview
              </TabsTrigger>
              <TabsTrigger
                disabled={!props.hasFile || !props.supportsPreview}
                value="preview"
              >
                Preview
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </Show>
      <div class="toolbar-right">
        <Show when={props.hasRoot}>
          <Tooltip>
            <TooltipTrigger
              as={Toggle}
              size="sm"
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
              pressed={props.tocVisible}
              onChange={props.onToggleToc}
              aria-label="Toggle table of contents"
            >
              <IconListTree width={16} height={16} />
            </TooltipTrigger>
            <TooltipContent>Toggle table of contents</TooltipContent>
          </Tooltip>
        </Show>
        {/* Menu dropdown */}
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger
              as={DropdownMenuTrigger}
              class="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 hover:bg-accent hover:text-accent-foreground h-8 w-8"
            >
              <IconMenu width={16} height={16} />
            </TooltipTrigger>
            <TooltipContent>Menu</TooltipContent>
          </Tooltip>
          <DropdownMenuContent class="w-48">
            <Show when={props.onOpenFolder}>
              <DropdownMenuItem onSelect={props.onOpenFolder}>
                <IconFolder width={14} height={14} />
                Open Folder
              </DropdownMenuItem>
            </Show>
            <Show when={hasRecentItems()}>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <IconClock width={14} height={14} />
                  Open Recent
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent class="w-56 max-h-64 overflow-y-auto">
                  <Show when={(props.recentFolders?.length ?? 0) > 0}>
                    <For each={props.recentFolders}>
                      {(folder) => (
                        <DropdownMenuItem onSelect={() => props.onOpenRecentFolder?.(folder.path)}>
                          <IconFolder width={14} height={14} />
                          {folder.name}
                        </DropdownMenuItem>
                      )}
                    </For>
                  </Show>
                  <Show when={(props.recentFolders?.length ?? 0) > 0 && (props.recentFiles?.length ?? 0) > 0}>
                    <DropdownMenuSeparator />
                  </Show>
                  <Show when={(props.recentFiles?.length ?? 0) > 0}>
                    <For each={props.recentFiles}>
                      {(file) => (
                        <DropdownMenuItem onSelect={() => props.onOpenRecentFile?.(file)}>
                          <IconFileText width={14} height={14} />
                          {file.name}
                        </DropdownMenuItem>
                      )}
                    </For>
                  </Show>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </Show>
            <Show when={props.onOpenFolder || hasRecentItems()}>
              <DropdownMenuSeparator />
            </Show>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Show when={props.darkMode} fallback={<IconSun width={14} height={14} />}>
                  <IconMoon width={14} height={14} />
                </Show>
                Theme
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent class="w-40">
                <DropdownMenuRadioGroup
                  value={props.themeMode}
                  onChange={props.onThemeChange}
                >
                  <DropdownMenuRadioItem value="system">
                    <IconMonitor width={14} height={14} />
                    System
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="light">
                    <IconSun width={14} height={14} />
                    Light
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="dark">
                    <IconMoon width={14} height={14} />
                    Dark
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <Show when={props.hasFile && props.onExportPdf}>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={props.onExportPdf}>
                <IconFileDown width={14} height={14} />
                Export PDF
              </DropdownMenuItem>
            </Show>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
