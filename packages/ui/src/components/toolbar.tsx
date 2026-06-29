import { For, Show } from "solid-js";
import type { RecentFile } from "@markdraw/core/recent-files.ts";
import type { RecentFolder } from "@markdraw/core/recent-folders.ts";
import IconArrowLeft from "~icons/lucide/arrow-left";
import IconArrowRight from "~icons/lucide/arrow-right";
import IconClock from "~icons/lucide/clock";
import IconCopy from "~icons/lucide/copy";
import IconDownload from "~icons/lucide/download";
import IconFileDown from "~icons/lucide/file-down";
import IconFileText from "~icons/lucide/file-text";
import IconFolder from "~icons/lucide/folder-open";
import IconLink from "~icons/lucide/link-2";
import IconPanelLeft from "~icons/lucide/panel-left";
import IconPanelRight from "~icons/lucide/panel-right";
import IconColumns from "~icons/lucide/columns-2";
import IconMenu from "~icons/lucide/menu";
import IconAppWindow from "~icons/lucide/app-window";
import IconRefreshCw from "~icons/lucide/refresh-cw";
import IconSettings from "~icons/lucide/settings";
import IconLogOut from "~icons/lucide/log-out";
import IconMinimize2 from "~icons/lucide/minimize-2";
import * as m from "@markdraw/i18n";
import { useLocale } from "@markdraw/i18n/solid";
import { detectPlatform } from "@markdraw/core/keyboard-shortcuts.ts";
import { effectiveKeys, formatBinding } from "@markdraw/core/keybindings.ts";
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

/** Display hint for the `app.settings` binding, resolved at render time so a
 *  user override (Settings → Keybindings) shows without a reload. */
function settingsShortcutHint(): string {
  const platform = detectPlatform(typeof navigator === "undefined" ? "" : navigator.platform);
  return formatBinding(effectiveKeys("app.settings", platform), platform);
}

interface ToolbarProps {
  canGoBack?: boolean;
  canGoForward?: boolean;
  editorMode: "edit" | "split" | "preview";
  hasFile: boolean;
  hasRoot: boolean;
  /** Whether the current file has a rendered preview (markdown/asciidoc
   *  document, or an image/PDF in the media viewer). */
  supportsPreview: boolean;
  /** Whether the current file's text can be edited (document or plain
   *  text — false for images/PDF and unsupported binaries). */
  supportsEdit: boolean;
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
  /** Desktop-only: which behaviour the OS close gesture takes. The
   *  submenu is hidden when this prop is undefined (Chrome extension
   *  has no tray, no window lifecycle to manage). */
  closeBehavior?: "tray" | "quit";
  tocVisible: boolean;
  onEditorModeChange: (mode: "edit" | "split" | "preview") => void;
  onCheckForUpdates?: () => void;
  /** Open the app Settings dialog. Wired to a menu item; if omitted
   *  the item is hidden (extension passes nothing). Theme, keyboard
   *  shortcuts, release notes and about now live inside this dialog. */
  onOpenSettings?: () => void;
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
  /** Desktop-only: change the OS-close behaviour. Paired with
   *  `closeBehavior`; both undefined hides the submenu. */
  onCloseBehaviorChange?: (value: "tray" | "quit") => void;
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
          <IconPanelLeft width={14} height={14} />
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
        <IconPanelRight width={14} height={14} />
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
          <IconColumns width={14} height={14} />
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
          class="inline-flex h-6 w-6 items-center justify-center rounded-[2px] text-xs hover:bg-accent hover:text-accent-foreground"
          aria-label={(useLocale(), m.toolbar_reload_document())}
          onClick={props.onReload}
        >
          <IconRefreshCw width={14} height={14} />
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
          class="inline-flex h-6 w-6 items-center justify-center rounded-[2px] text-xs hover:bg-accent hover:text-accent-foreground"
          aria-label={(useLocale(), m.toolbar_copy_source_url())}
          onClick={props.onCopySource}
        >
          <IconLink width={14} height={14} />
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
          class="inline-flex h-6 w-6 items-center justify-center rounded-[2px] text-xs hover:bg-accent hover:text-accent-foreground"
          aria-label={(useLocale(), m.toolbar_copy_document_content())}
          onClick={props.onCopyContent}
        >
          <IconCopy width={14} height={14} />
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
          class="inline-flex h-6 w-6 items-center justify-center rounded-[2px] text-xs hover:bg-accent hover:text-accent-foreground"
          aria-label={(useLocale(), m.toolbar_open_folder())}
          onClick={props.onOpenFolder}
        >
          <IconFolder width={14} height={14} />
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
        class="inline-flex h-6 w-6 items-center justify-center whitespace-nowrap rounded-[2px] text-xs font-medium ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1"
      >
        <IconMenu width={14} height={14} />
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
        {/* Window-close behaviour submenu — desktop only. Hidden
            in the extension where there's no tray / no window
            lifecycle to choose between. Items mirror the Theme
            submenu's radio-group pattern so the affordance is
            consistent across the toolbar dropdown. */}
        <Show when={props.closeBehavior !== undefined && props.onCloseBehaviorChange}>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <IconAppWindow width={14} height={14} />
              {(useLocale(), m.menu_window())}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent class="w-44">
              <DropdownMenuRadioGroup
                value={props.closeBehavior!}
                onChange={(value) =>
                  props.onCloseBehaviorChange?.(value as "tray" | "quit")
                }
              >
                <DropdownMenuRadioItem value="tray">
                  <IconMinimize2 width={14} height={14} />
                  {(useLocale(), m.menu_window_close_tray())}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="quit">
                  <IconLogOut width={14} height={14} />
                  {(useLocale(), m.menu_window_close_quit())}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </Show>
        {/* Action group — Settings + Export. Theme, Keyboard shortcuts,
            Release notes and About moved into the Settings dialog (their
            own sections); only the genuinely menu-first actions remain. */}
        <Show when={(props.hasFile && props.onExportPdf) || props.onOpenSettings}>
          <DropdownMenuSeparator />
        </Show>
        {/* App settings — opens the Settings dialog. Hidden when the host
            doesn't provide a handler (e.g. the Chrome extension). */}
        <Show when={props.onOpenSettings}>
          <DropdownMenuItem onSelect={props.onOpenSettings}>
            <IconSettings width={14} height={14} />
            {(useLocale(), m.menu_settings())}
            {/* Resolved through the keybindings catalog (not hardcoded) so a
                user override shows here too — ⌘, on macOS, Ctrl+, elsewhere. */}
            <kbd class="menu-shortcut-kbd ml-auto">{settingsShortcutHint()}</kbd>
          </DropdownMenuItem>
        </Show>
        <Show when={props.hasFile && props.onExportPdf}>
          <DropdownMenuItem onSelect={props.onExportPdf}>
            <IconFileDown width={14} height={14} />
            {(useLocale(), m.menu_export_pdf())}
          </DropdownMenuItem>
        </Show>
        {/* Updates — lower-traffic, kept in its own block. */}
        <Show when={props.onCheckForUpdates}>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={props.onCheckForUpdates}>
            <IconDownload width={14} height={14} />
            {(useLocale(), m.menu_check_for_updates())}
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
              class="inline-flex h-6 w-6 items-center justify-center rounded-[2px] text-xs hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-30"
              aria-label={(useLocale(), m.toolbar_go_back())}
              disabled={!props.canGoBack}
              onClick={props.onGoBack}
            >
              <IconArrowLeft width={14} height={14} />
            </TooltipTrigger>
            <TooltipContent>{(useLocale(), m.toolbar_go_back())}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              as="button"
              class="inline-flex h-6 w-6 items-center justify-center rounded-[2px] text-xs hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-30"
              aria-label={(useLocale(), m.toolbar_go_forward())}
              disabled={!props.canGoForward}
              onClick={props.onGoForward}
            >
              <IconArrowRight width={14} height={14} />
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
              <TabsTrigger disabled={!props.hasFile || !props.supportsEdit} value="edit">{(useLocale(), m.toolbar_editor_mode_edit())}</TabsTrigger>
              <TabsTrigger
                disabled={!props.hasFile || !props.supportsEdit || !props.supportsPreview}
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
