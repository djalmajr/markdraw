import { For, Show } from "solid-js";
import type { RecentFile } from "@asciimark/core/recent-files.ts";
import type { RecentFolder } from "@asciimark/core/recent-folders.ts";
import IconArrowLeft from "~icons/lucide/arrow-left";
import IconArrowRight from "~icons/lucide/arrow-right";
import IconClock from "~icons/lucide/clock";
import IconCopy from "~icons/lucide/copy";
import IconDownload from "~icons/lucide/download";
import IconFileDown from "~icons/lucide/file-down";
import IconFileText from "~icons/lucide/file-text";
import IconFolder from "~icons/lucide/folder-open";
import IconInfo from "~icons/lucide/info";
import IconKeyboard from "~icons/lucide/keyboard";
import IconLink from "~icons/lucide/link-2";
import IconListTree from "~icons/lucide/list-tree";
import IconMonitor from "~icons/lucide/monitor";
import IconMoon from "~icons/lucide/moon";
import IconPanelLeft from "~icons/lucide/panel-left";
import IconColumns from "~icons/lucide/columns-2";
import IconMenu from "~icons/lucide/menu";
import IconRefreshCw from "~icons/lucide/refresh-cw";
import IconSun from "~icons/lucide/sun";
import * as m from "@asciimark/i18n";
import { useLocale } from "@asciimark/i18n/solid";
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
  /**
   * Render sidebar/TOC toggles and the menu dropdown on the left side of the
   * toolbar instead of the right. Used on Windows, where the right side is
   * occupied by the in-app caption buttons (min/max/close).
   */
  controlsOnLeft?: boolean;
  recentFiles?: RecentFile[];
  recentFolders?: RecentFolder[];
  showEditorTabs: boolean;
  showNavButtons?: boolean;
  showRecentHistory?: boolean;
  sidebarVisible: boolean;
  themeMode: string;
  tocVisible: boolean;
  onEditorModeChange: (mode: "edit" | "split" | "preview") => void;
  onCheckForUpdates?: () => void;
  /** Open the keyboard shortcuts help modal. Wired to a menu item; if
   *  omitted the item is hidden. */
  onShortcutsHelp?: () => void;
  /** Open the About dialog. Wired to a menu item; if omitted the
   *  item is hidden (extension passes nothing). */
  onAbout?: () => void;
  /** Toggle the split editor (open second pane / collapse). When
   *  omitted, the toolbar split button is hidden — handy for
   *  platforms that don't support the feature. */
  onToggleSplit?: () => void;
  /** Truthy when there are 2 panes open. Drives the Toggle's pressed
   *  state on the toolbar split button. */
  isSplit?: boolean;
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
  /**
   * Reload the active document. When supplied, a refresh button shows
   * in the top toolbar. URL mode re-fetches; folder mode re-reads from
   * disk. Hidden when omitted.
   */
  onReload?: () => void;
  /**
   * Copy the URL of the current document to the clipboard. Wired by the
   * extension in URL mode. Hidden when omitted.
   */
  onCopySource?: () => void;
  /**
   * Copy the raw text content (markdown/asciidoc source) of the active
   * document to the clipboard. Hidden when omitted.
   */
  onCopyContent?: () => void;
}

export function Toolbar(props: ToolbarProps) {
  const hasRecentItems = () =>
    !!props.showRecentHistory &&
    ((props.recentFolders?.length ?? 0) > 0 || (props.recentFiles?.length ?? 0) > 0);

  const renderSidebarToggle = () => (
    <Show when={props.hasRoot}>
      <Tooltip>
        <TooltipTrigger
          as={Toggle}
          size="sm"
          pressed={props.sidebarVisible}
          onChange={props.onToggleSidebar}
          aria-label={(useLocale(), m.toolbar_toggle_sidebar())}
        >
          <IconPanelLeft width={16} height={16} />
        </TooltipTrigger>
        <TooltipContent>{(useLocale(), m.toolbar_toggle_sidebar())}</TooltipContent>
      </Tooltip>
    </Show>
  );

  const renderTocToggle = () => (
    <Tooltip>
      <TooltipTrigger
        as={Toggle}
        size="sm"
        pressed={props.tocVisible}
        onChange={props.onToggleToc}
        aria-label={(useLocale(), m.toolbar_toggle_toc())}
      >
        <IconListTree width={16} height={16} />
      </TooltipTrigger>
      <TooltipContent>{(useLocale(), m.toolbar_toggle_toc())}</TooltipContent>
    </Tooltip>
  );

  const renderSplitToggle = () => (
    <Show when={props.onToggleSplit && props.hasRoot}>
      <Tooltip>
        <TooltipTrigger
          as={Toggle}
          size="sm"
          pressed={!!props.isSplit}
          onChange={() => props.onToggleSplit?.()}
          aria-label={(useLocale(), m.toolbar_split_editor())}
        >
          <IconColumns width={16} height={16} />
        </TooltipTrigger>
        <TooltipContent>{(useLocale(), m.toolbar_split_editor())}</TooltipContent>
      </Tooltip>
    </Show>
  );

  const renderReload = () => (
    <Show when={props.onReload && props.hasFile}>
      <Tooltip>
        <TooltipTrigger
          as="button"
          class="inline-flex items-center justify-center rounded-md h-7 w-7 text-sm hover:bg-accent hover:text-accent-foreground"
          aria-label={(useLocale(), m.toolbar_reload_document())}
          onClick={props.onReload}
        >
          <IconRefreshCw width={16} height={16} />
        </TooltipTrigger>
        <TooltipContent>{(useLocale(), m.toolbar_reload_document())}</TooltipContent>
      </Tooltip>
    </Show>
  );

  const renderCopySource = () => (
    <Show when={props.onCopySource && props.hasFile}>
      <Tooltip>
        <TooltipTrigger
          as="button"
          class="inline-flex items-center justify-center rounded-md h-7 w-7 text-sm hover:bg-accent hover:text-accent-foreground"
          aria-label={(useLocale(), m.toolbar_copy_source_url())}
          onClick={props.onCopySource}
        >
          <IconLink width={16} height={16} />
        </TooltipTrigger>
        <TooltipContent>{(useLocale(), m.toolbar_copy_source_url())}</TooltipContent>
      </Tooltip>
    </Show>
  );

  const renderCopyContent = () => (
    <Show when={props.onCopyContent && props.hasFile}>
      <Tooltip>
        <TooltipTrigger
          as="button"
          class="inline-flex items-center justify-center rounded-md h-7 w-7 text-sm hover:bg-accent hover:text-accent-foreground"
          aria-label={(useLocale(), m.toolbar_copy_document_content())}
          onClick={props.onCopyContent}
        >
          <IconCopy width={16} height={16} />
        </TooltipTrigger>
        <TooltipContent>{(useLocale(), m.toolbar_copy_document_content())}</TooltipContent>
      </Tooltip>
    </Show>
  );

  // Surface "Open Folder" as a visible button when nothing's open yet,
  // so first-time users on the welcome screen don't have to dig through
  // the hamburger menu to discover the folder picker.
  const renderOpenFolderButton = () => (
    <Show when={props.onOpenFolder && !props.hasRoot && !props.hasFile}>
      <Tooltip>
        <TooltipTrigger
          as="button"
          class="inline-flex items-center justify-center rounded-md h-7 w-7 text-sm hover:bg-accent hover:text-accent-foreground"
          aria-label={(useLocale(), m.toolbar_open_folder())}
          onClick={props.onOpenFolder}
        >
          <IconFolder width={16} height={16} />
        </TooltipTrigger>
        <TooltipContent>{(useLocale(), m.toolbar_open_folder())}</TooltipContent>
      </Tooltip>
    </Show>
  );

  const renderMenu = () => (
    <DropdownMenu>
      {/* No Tooltip here: Kobalte tooltips open on focus (a11y) and the
            trigger receives focus when the dropdown opens, so tooltip +
            menu would appear together. The icon + aria-label are enough. */}
      <DropdownMenuTrigger
        aria-label={(useLocale(), m.toolbar_menu())}
        class="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 hover:bg-accent hover:text-accent-foreground h-8 w-8"
      >
        <IconMenu width={16} height={16} />
      </DropdownMenuTrigger>
      <DropdownMenuContent class="w-48">
        <Show when={props.onOpenFolder}>
          <DropdownMenuItem onSelect={props.onOpenFolder}>
            <IconFolder width={14} height={14} />
            {(useLocale(), m.menu_open_folder())}
          </DropdownMenuItem>
        </Show>
        <Show when={hasRecentItems()}>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <IconClock width={14} height={14} />
              {(useLocale(), m.menu_open_recent())}
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
            {(useLocale(), m.menu_theme())}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent class="w-40">
            <DropdownMenuRadioGroup
              value={props.themeMode}
              onChange={props.onThemeChange}
            >
              <DropdownMenuRadioItem value="system">
                <IconMonitor width={14} height={14} />
                {(useLocale(), m.menu_theme_system())}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="light">
                <IconSun width={14} height={14} />
                {(useLocale(), m.menu_theme_light())}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">
                <IconMoon width={14} height={14} />
                {(useLocale(), m.menu_theme_dark())}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {/* Action group — Export, Shortcuts, Updates, About all
              belong to "things you do from the menu" so they read as
              a single block. One separator before the group divides
              it from the open/recent/theme cluster above; items
              inside the group are flat. */}
        <Show when={
          (props.hasFile && props.onExportPdf)
          || props.onShortcutsHelp
          || props.onCheckForUpdates
          || props.onAbout
        }>
          <DropdownMenuSeparator />
        </Show>
        <Show when={props.hasFile && props.onExportPdf}>
          <DropdownMenuItem onSelect={props.onExportPdf}>
            <IconFileDown width={14} height={14} />
            {(useLocale(), m.menu_export_pdf())}
          </DropdownMenuItem>
        </Show>
        <Show when={props.onShortcutsHelp}>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={props.onShortcutsHelp}>
            <IconKeyboard width={14} height={14} />
            {(useLocale(), m.menu_keyboard_shortcuts())}
          </DropdownMenuItem>
        </Show>
        <Show when={props.onCheckForUpdates}>
          <DropdownMenuItem onSelect={props.onCheckForUpdates}>
            <IconDownload width={14} height={14} />
            {(useLocale(), m.menu_check_for_updates())}
          </DropdownMenuItem>
        </Show>
        <Show when={props.onAbout}>
          <DropdownMenuItem onSelect={props.onAbout}>
            <IconInfo width={14} height={14} />
            {(useLocale(), m.menu_about())}
          </DropdownMenuItem>
        </Show>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <header
      class="toolbar no-print"
      classList={{ "toolbar-window-frame": !!props.inWindowFrame }}
      data-tauri-drag-region={props.inWindowFrame ? "" : undefined}
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
      <div class="toolbar-left" data-tauri-drag-region={props.inWindowFrame ? "" : undefined}>
        <Show when={props.controlsOnLeft}>
          {renderMenu()}
          {renderSidebarToggle()}
          {renderTocToggle()}
          {renderSplitToggle()}
          {renderReload()}
          {renderCopySource()}
          {renderCopyContent()}
        </Show>
        <Show when={props.showNavButtons}>
          <Tooltip>
            <TooltipTrigger
              as="button"
              class="inline-flex items-center justify-center rounded-md h-7 w-7 text-sm hover:bg-accent hover:text-accent-foreground disabled:opacity-30 disabled:pointer-events-none"
              aria-label={(useLocale(), m.toolbar_go_back())}
              disabled={!props.canGoBack}
              onClick={props.onGoBack}
            >
              <IconArrowLeft width={16} height={16} />
            </TooltipTrigger>
            <TooltipContent>{(useLocale(), m.toolbar_go_back())}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              as="button"
              class="inline-flex items-center justify-center rounded-md h-7 w-7 text-sm hover:bg-accent hover:text-accent-foreground disabled:opacity-30 disabled:pointer-events-none"
              aria-label={(useLocale(), m.toolbar_go_forward())}
              disabled={!props.canGoForward}
              onClick={props.onGoForward}
            >
              <IconArrowRight width={16} height={16} />
            </TooltipTrigger>
            <TooltipContent>{(useLocale(), m.toolbar_go_forward())}</TooltipContent>
          </Tooltip>
        </Show>
      </div>
      <Show when={props.showEditorTabs}>
        <div class="toolbar-center" data-tauri-drag-region={props.inWindowFrame ? "" : undefined}>
          <Tabs
            value={props.editorMode}
            onChange={(v) => props.onEditorModeChange(v as "edit" | "split" | "preview")}
          >
            <TabsList>
              <TabsTrigger disabled={!props.hasFile} value="edit">{(useLocale(), m.toolbar_editor_mode_edit())}</TabsTrigger>
              <TabsTrigger
                disabled={!props.hasFile || !props.supportsPreview}
                value="split"
              >
                {(useLocale(), m.toolbar_editor_mode_split())}
              </TabsTrigger>
              <TabsTrigger
                disabled={!props.hasFile || !props.supportsPreview}
                value="preview"
              >
                {(useLocale(), m.toolbar_editor_mode_preview())}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </Show>
      <div class="toolbar-right" data-tauri-drag-region={props.inWindowFrame ? "" : undefined}>
        <Show when={!props.controlsOnLeft}>
          {renderOpenFolderButton()}
          {renderReload()}
          {renderCopyContent()}
          {renderCopySource()}
          {renderSidebarToggle()}
          {renderTocToggle()}
          {renderSplitToggle()}
          {renderMenu()}
        </Show>
      </div>
    </header>
  );
}
