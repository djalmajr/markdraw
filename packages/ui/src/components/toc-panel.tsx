import { Show, createSignal, type JSX } from "solid-js";
import IconCheck from "~icons/lucide/check";
import IconSlidersHorizontal from "~icons/lucide/sliders-horizontal";
import IconSparkles from "~icons/lucide/sparkles";
import * as m from "@asciimark/i18n";
import { useLocale } from "@asciimark/i18n/solid";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs.tsx";

export type TocPanelTab = "toc" | "backlinks" | "ai";

export interface TocPanelProps {
  /** Toolbar toggle. Drives panel visibility — only `false` should
   *  hide the gutter, since users disable it intentionally to reclaim
   *  space. */
  tocVisible: boolean;
  /** Workspace state. The home screen (no workspace) hides the panel
   *  too because the dropzone fills the canvas and there's nothing on
   *  the right to anchor a gutter against. */
  hasRoot: boolean;
  /** True when the active pane's preview produced a `#toc` block.
   *  When false the placeholder takes over so the gutter doesn't
   *  flicker between docs that do/don't render headings. */
  hasToc: boolean;
  /** Visible heading depth (1-4). Bound to a CSS attribute selector
   *  that hides deeper levels — see `[data-toc-levels]` in
   *  `index.css`. */
  tocLevels: number;
  setTocLevels: (n: number) => void;
  /** Bulk expand/collapse for nested toc-collapsible items. */
  setTocExpanded: (expanded: boolean) => void;
  /** Where Preview moves the `#toc` node. AppShell forwards a single
   *  shared ref bound to whichever pane is active. */
  contentRef: (el: HTMLDivElement) => void;
  /** Optional ref to the panel root for callers that need to scope
   *  queries (e.g. setTocExpanded operating on toggles). */
  panelRef?: (el: HTMLElement) => void;
  /** Number of inbound references for the active doc — drives the
   *  count badge on the Backlinks tab. */
  backlinksCount?: number;
  /** Backlinks list rendered when the Backlinks segment is active.
   *  Always mounted (just visually hidden when on the TOC tab) so
   *  the empty-state stays stable across switches. */
  backlinksSlot?: JSX.Element;
  /** AI panel content rendered in the third segment (DJA-12). When omitted the
   *  AI segment is not shown — keeps the panel two-up for hosts without AI. */
  aiSlot?: JSX.Element;
  /** Controlled active tab. When provided (with `onActiveTabChange`) the host
   *  owns which segment is fronted — needed so ⌘L can front the AI segment.
   *  Falls back to internal state when omitted. */
  activeTab?: TocPanelTab;
  onActiveTabChange?: (tab: TocPanelTab) => void;
  /** Panel width in px (user-resizable). Falls back to the CSS default. */
  width?: number;
}

/**
 * Sticky right gutter with two segments at the top — Summary
 * (TOC) and References (Backlinks). Each pane keeps its own
 * SECTION header below the segment row (uppercase title + the
 * pane-specific action), matching the layout pattern of the main
 * editor-mode segmented control in the toolbar.
 *
 * Both subtrees stay mounted regardless of which tab is visible —
 * Preview moves the `#toc` node into the toc tree via `contentRef`
 * and a re-mount would lose that wiring.
 */
export function TocPanel(props: TocPanelProps) {
  // Controlled-with-fallback: the host may drive the active tab (so ⌘L can
  // front the AI segment); otherwise the panel keeps its own state.
  const [localTab, setLocalTab] = createSignal<TocPanelTab>("toc");
  const activeTab = (): TocPanelTab => props.activeTab ?? localTab();
  const changeTab = (tab: TocPanelTab): void => {
    setLocalTab(tab);
    props.onActiveTabChange?.(tab);
  };

  return (
    <aside
      class="toc-panel"
      classList={{
        "toc-hidden": !props.tocVisible || !props.hasRoot,
        "toc-empty": !props.hasToc,
      }}
      data-toc-levels={props.tocLevels}
      style={props.width != null ? { "--toc-width": `${props.width}px` } : undefined}
      ref={(el) => props.panelRef?.(el)}
    >
      <div class="toc-panel-tabs">
        <Tabs
          value={activeTab()}
          onChange={(v) => changeTab(v as TocPanelTab)}
        >
          <TabsList>
            <TabsTrigger value="toc">
              {(useLocale(), m.toc_tab_summary())}
            </TabsTrigger>
            <TabsTrigger value="backlinks">
              <span>{(useLocale(), m.toc_tab_references())}</span>
              <Show when={(props.backlinksCount ?? 0) > 0}>
                <span class="toc-panel-tab-count">{props.backlinksCount}</span>
              </Show>
            </TabsTrigger>
            <Show when={props.aiSlot}>
              <TabsTrigger value="ai">
                <IconSparkles width={12} height={12} class="toc-panel-tab-icon" />
                <span>{(useLocale(), m.toc_tab_ai())}</span>
              </TabsTrigger>
            </Show>
          </TabsList>
        </Tabs>
      </div>
      <div class="toc-panel-panes" data-active-tab={activeTab()}>
        {/* Each pane is its own flex column so the section header
            stays put while only the inner `.toc-panel-scroll` scrolls.
            Sticky-positioning the header inside a single shared scroll
            container kept the TOC tree leaking under a translucent
            edge — restructuring per-pane scroll fixed it. */}
        <div
          class="toc-panel-pane"
          data-pane="toc"
          role="tabpanel"
          hidden={activeTab() !== "toc"}
        >
          <div class="toc-panel-section-header">
            <span class="toc-panel-section-title">
              {(useLocale(), m.toc_title())}
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger
                as="button"
                class="toc-panel-options"
                aria-label="TOC options"
                title="TOC options"
              >
                <IconSlidersHorizontal width={14} height={14} />
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={() => props.setTocExpanded(true)}>
                  {(useLocale(), m.toc_expand_all())}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => props.setTocExpanded(false)}>
                  {(useLocale(), m.toc_collapse_all())}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => props.setTocLevels(1)}>
                  <span class="flex-1">{(useLocale(), m.toc_show_levels({ n: "1" }))}</span>
                  <Show when={props.tocLevels === 1}>
                    <IconCheck width={14} height={14} />
                  </Show>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => props.setTocLevels(2)}>
                  <span class="flex-1">{(useLocale(), m.toc_show_levels({ n: "2" }))}</span>
                  <Show when={props.tocLevels === 2}>
                    <IconCheck width={14} height={14} />
                  </Show>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => props.setTocLevels(3)}>
                  <span class="flex-1">{(useLocale(), m.toc_show_levels({ n: "3" }))}</span>
                  <Show when={props.tocLevels === 3}>
                    <IconCheck width={14} height={14} />
                  </Show>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => props.setTocLevels(4)}>
                  <span class="flex-1">{(useLocale(), m.toc_show_levels({ n: "4" }))}</span>
                  <Show when={props.tocLevels === 4}>
                    <IconCheck width={14} height={14} />
                  </Show>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div class="toc-panel-scroll">
            {/* Placeholder must NOT live inside `.toc-panel-tree`:
                Preview wipes that node with `textContent = ""` whenever
                a pane re-binds the active TOC, which would also remove
                this fallback. Sibling placement keeps the reactive
                `<Show>` independent of the move. */}
            <Show when={!props.hasToc}>
              <p class="toc-panel-empty">{(useLocale(), m.toc_no_headings())}</p>
            </Show>
            <div class="toc-panel-tree" ref={(el) => props.contentRef(el)} />
          </div>
        </div>
        <div
          class="toc-panel-pane"
          data-pane="backlinks"
          role="tabpanel"
          hidden={activeTab() !== "backlinks"}
        >
          <div class="toc-panel-section-header">
            <span class="toc-panel-section-title">
              {(useLocale(), m.backlinks_title())}
            </span>
          </div>
          <div class="toc-panel-scroll">{props.backlinksSlot}</div>
        </div>
        {/* AI pane is self-contained: AiPanel owns its header + scroll +
            composer layout, so it fills the pane directly (no shared
            section-header / single-scroll wrapper). */}
        <Show when={props.aiSlot}>
          <div
            class="toc-panel-pane toc-panel-pane-ai"
            data-pane="ai"
            role="tabpanel"
            hidden={activeTab() !== "ai"}
          >
            {props.aiSlot}
          </div>
        </Show>
      </div>
    </aside>
  );
}
