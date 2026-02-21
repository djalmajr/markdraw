import { For, Show } from "solid-js";
import IconArrowLeft from "~icons/lucide/arrow-left";
import IconArrowRight from "~icons/lucide/arrow-right";
import IconClock from "~icons/lucide/clock";
import IconCode from "~icons/lucide/code";
import IconDownload from "~icons/lucide/download";
import IconFileDown from "~icons/lucide/file-down";
import IconFolder from "~icons/lucide/folder-open";
import IconListTree from "~icons/lucide/list-tree";
import IconMonitor from "~icons/lucide/monitor";
import IconMoon from "~icons/lucide/moon";
import IconPalette from "~icons/lucide/palette";
import IconPanelLeft from "~icons/lucide/panel-left";
import IconSettings from "~icons/lucide/settings";
import IconSun from "~icons/lucide/sun";
import IconType from "~icons/lucide/type";

import type { CodeTheme } from "../lib/code-theme.ts";
import type { FontPrefs } from "../lib/font-prefs.ts";
import type { RecentFile } from "../lib/recent-files.ts";
import { Toggle } from "./ui/toggle.tsx";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip.tsx";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
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
  autoRefresh: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
  codeTheme: string;
  codeThemes: CodeTheme[];
  darkMode: boolean;
  editorVisible: boolean;
  fileName: string | null;
  filePath: string | null;
  fontFamilies: readonly { readonly id: string; readonly label: string }[];
  fontPrefs: FontPrefs;
  fontSizes: readonly number[];
  hasFile: boolean;
  recentFiles: RecentFile[];
  rootName: string;
  showNavButtons?: boolean;
  sidebarVisible: boolean;
  themeMode: string;
  tocVisible: boolean;
  onClearRecent: () => void;
  onCodeThemeChange: (id: string) => void;
  onDownloadPdf: () => void;
  onExportPdf: () => void;
  onFontPrefsChange: (prefs: Partial<FontPrefs>) => void;
  onGoBack?: () => void;
  onGoForward?: () => void;
  onOpenFolder: () => void;
  onOpenRecent: (path: string) => void;
  onThemeChange: (mode: string) => void;
  onToggleEditor: () => void;
  onToggleAutoRefresh: () => void;
  onToggleSidebar: () => void;
  onToggleToc: () => void;
}

export function Toolbar(props: ToolbarProps) {
  return (
    <header
      class="toolbar no-print"
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
        <Show when={props.rootName || props.filePath}>
          <span class="breadcrumb">
            <Show when={props.rootName}>
              <span class="breadcrumb-root">{props.rootName}</span>
            </Show>
            <Show when={props.filePath}>
              <Show when={props.rootName}>
                <span class="breadcrumb-sep">/</span>
              </Show>
              <span class="breadcrumb-file">{props.filePath}</span>
            </Show>
          </span>
        </Show>
      </div>
      <div class="toolbar-right">
        <Show when={props.hasFile}>
          <Tooltip>
            <TooltipTrigger
              as={Toggle}
              size="sm"
              pressed={props.editorVisible}
              onChange={props.onToggleEditor}
              aria-label="Toggle editor"
            >
              <IconCode width={16} height={16} />
            </TooltipTrigger>
            <TooltipContent>Toggle editor</TooltipContent>
          </Tooltip>
        </Show>
        <Show when={props.rootName}>
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
        {/* Settings dropdown */}
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger
              as={DropdownMenuTrigger}
              class="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 hover:bg-accent hover:text-accent-foreground h-8 w-8"
            >
              <IconSettings width={16} height={16} />
            </TooltipTrigger>
            <TooltipContent>Settings</TooltipContent>
          </Tooltip>
          <DropdownMenuContent class="w-48">
            <DropdownMenuItem onSelect={props.onOpenFolder}>
              <IconFolder width={14} height={14} />
              Open Folder
            </DropdownMenuItem>
            <Show when={props.recentFiles.length > 0}>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <IconClock width={14} height={14} />
                  Recent Files
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent class="w-56">
                  <For each={props.recentFiles}>
                    {(file) => (
                      <DropdownMenuItem onSelect={() => props.onOpenRecent(file.path)}>
                        {file.name}
                      </DropdownMenuItem>
                    )}
                  </For>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={props.onClearRecent}>
                    Clear recent files
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </Show>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={props.autoRefresh}
              onChange={props.onToggleAutoRefresh}
            >
              Auto-refresh
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
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
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <IconPalette width={14} height={14} />
                Code Theme
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent class="w-48">
                <DropdownMenuRadioGroup
                  value={props.codeTheme}
                  onChange={props.onCodeThemeChange}
                >
                  <DropdownMenuRadioItem value="auto">Auto</DropdownMenuRadioItem>
                  <DropdownMenuSeparator />
                  <For each={props.codeThemes}>
                    {(theme) => (
                      <DropdownMenuRadioItem value={theme.id}>
                        {theme.label}
                      </DropdownMenuRadioItem>
                    )}
                  </For>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <IconType width={14} height={14} />
                Font
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent class="w-40">
                <DropdownMenuRadioGroup
                  value={String(props.fontPrefs.fontSize)}
                  onChange={(v) => props.onFontPrefsChange({ fontSize: Number(v) })}
                >
                  <For each={[...props.fontSizes]}>
                    {(size) => (
                      <DropdownMenuRadioItem value={String(size)}>
                        {size}px
                      </DropdownMenuRadioItem>
                    )}
                  </For>
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
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
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <Show when={props.hasFile}>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={props.onExportPdf}>
                <IconFileDown width={14} height={14} />
                Print to PDF
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={props.onDownloadPdf}>
                <IconDownload width={14} height={14} />
                Download PDF
              </DropdownMenuItem>
            </Show>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
