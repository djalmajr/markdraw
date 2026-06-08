import { Show, createSignal, type JSX } from "solid-js";
import * as m from "@asciimark/i18n";
import { useLocale } from "@asciimark/i18n/solid";
import {
  RightPanelTabs,
  type RightPanelOverflowItem,
  type RightPanelTab,
} from "./right-panel-tabs.tsx";

/** Encoded right-panel tab: the pinned TOC tab, the References (backlinks)
 *  view fronted from the overflow menu, or a specific chat session. */
export type TocPanelTab = "toc" | "backlinks" | `chat:${string}`;

export interface TocPanelProps {
  /** Toolbar toggle. Drives panel visibility — only `false` should
   *  hide the gutter, since users disable it intentionally to reclaim
   *  space. */
  tocVisible: boolean;
  /** Workspace state. The home screen (no workspace) hides the panel
   *  too because the dropzone fills the canvas and there's nothing on
   *  the right to anchor a gutter against. */
  hasRoot: boolean;
  /** True when the active pane's preview produced a `#toc` block. */
  hasToc: boolean;
  /** Visible heading depth (1-4). Bound to a CSS attribute selector. */
  tocLevels: number;
  setTocLevels: (n: number) => void;
  /** Bulk expand/collapse for nested toc-collapsible items. */
  setTocExpanded: (expanded: boolean) => void;
  /** Where Preview moves the `#toc` node. MUST stay mounted across tab
   *  switches (the TOC pane is hidden, never unmounted). */
  contentRef: (el: HTMLDivElement) => void;
  /** Optional ref to the panel root for query scoping. */
  panelRef?: (el: HTMLElement) => void;
  /** Inbound reference count for the active doc — badges the References
   *  entry in the "…" overflow menu. */
  backlinksCount?: number;
  /** Backlinks list, rendered in the (always-mounted) References pane. */
  backlinksSlot?: JSX.Element;
  /** Controlled active tab (encoded string). Falls back to internal state. */
  activeTab?: string;
  onActiveTabChange?: (tab: string) => void;
  /** Open chat sessions for the strip (host builds from the session manager). */
  chatSessions?: Array<{ id: string; title: string; streaming?: boolean }>;
  /** AiPanel bound to the active chat — rendered only when a chat tab is active. */
  aiSlot?: JSX.Element;
  onNewChat?: () => void;
  onCloseChat?: (id: string) => void;
  /** ChatHistoryMenu element, rendered in the strip's actions cluster. */
  historySlot?: JSX.Element;
  /** Localized fallback title for untitled chats. */
  defaultChatTitle?: string;
  /** Panel width in px (user-resizable). Falls back to the CSS default. */
  width?: number;
}

/**
 * The right gutter. A single unified tab strip (pinned TOC + N chat tabs, plus
 * `+`/history/overflow/collapse controls) sits above three content panes. The
 * TOC and References panes stay MOUNTED at all times (hidden via attribute) —
 * Preview moves the `#toc` node into the TOC tree imperatively and a re-mount
 * would lose that wiring; References must keep its empty-state stable. Only the
 * active chat pane mounts/unmounts (chat content has no imperative DOM
 * contract). References is reachable from the "…" overflow, not a strip tab.
 */
export function TocPanel(props: TocPanelProps) {
  // Controlled-with-fallback so the host can drive the active tab (⌘L fronts a
  // chat); otherwise the panel keeps its own state for standalone rendering.
  const [localTab, setLocalTab] = createSignal<string>("toc");
  const activeTab = (): string => props.activeTab ?? localTab();
  const changeTab = (tab: string): void => {
    setLocalTab(tab);
    props.onActiveTabChange?.(tab);
  };
  const isChatActive = (): boolean => activeTab().startsWith("chat:");

  const tabs = (): RightPanelTab[] => [
    { id: "toc", kind: "toc", title: (useLocale(), m.toc_tab_outline()) },
    ...(props.chatSessions ?? []).map((s) => ({
      id: s.id,
      kind: "chat" as const,
      title: s.title || props.defaultChatTitle || (useLocale(), m.ai_chat_default_title()),
      streaming: s.streaming,
    })),
  ];

  const overflowItems = (): RightPanelOverflowItem[] => {
    useLocale();
    const items: RightPanelOverflowItem[] = [
      {
        id: "references",
        label: m.toc_tab_references(),
        count: props.backlinksCount,
        onSelect: () => changeTab("backlinks"),
      },
    ];
    // The TOC depth/expand controls live in the overflow only while the TOC tab
    // is active (they don't apply to chats or references).
    if (activeTab() === "toc") {
      items.push(
        { id: "expand", label: m.toc_expand_all(), separatorBefore: true, onSelect: () => props.setTocExpanded(true) },
        { id: "collapse", label: m.toc_collapse_all(), onSelect: () => props.setTocExpanded(false) },
      );
      for (const lvl of [1, 2, 3, 4] as const) {
        items.push({
          id: `lvl${lvl}`,
          label: m.toc_show_levels({ n: String(lvl) }),
          separatorBefore: lvl === 1,
          checked: props.tocLevels === lvl,
          onSelect: () => props.setTocLevels(lvl),
        });
      }
    }
    return items;
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
      <RightPanelTabs
        tabs={tabs()}
        activeId={activeTab()}
        onSelect={changeTab}
        onCloseChat={(id) => props.onCloseChat?.(id)}
        onNewChat={props.onNewChat}
        overflowItems={overflowItems()}
        historySlot={props.historySlot}
      />

      <div class="toc-panel-panes" data-active-tab={activeTab()}>
        {/* TOC pane — ALWAYS mounted; hidden via attribute. Preview moves the
            `#toc` node into `.toc-panel-tree`, so it must never unmount. */}
        <div class="toc-panel-pane" data-pane="toc" role="tabpanel" hidden={activeTab() !== "toc"}>
          <div class="toc-panel-scroll">
            {/* Placeholder must NOT live inside `.toc-panel-tree`: Preview wipes
                that node's textContent on re-bind, which would remove a child
                fallback. Sibling placement keeps the `<Show>` independent. */}
            <Show when={!props.hasToc}>
              <p class="toc-panel-empty">{(useLocale(), m.toc_no_headings())}</p>
            </Show>
            <div class="toc-panel-tree" ref={(el) => props.contentRef(el)} />
          </div>
        </div>

        {/* References pane — ALWAYS mounted; fronted from the "…" overflow. */}
        <div class="toc-panel-pane" data-pane="backlinks" role="tabpanel" hidden={activeTab() !== "backlinks"}>
          <div class="toc-panel-section-header">
            <span class="toc-panel-section-title">{(useLocale(), m.backlinks_title())}</span>
          </div>
          <div class="toc-panel-scroll">{props.backlinksSlot}</div>
        </div>

        {/* Chat pane — only the ACTIVE chat session mounts. AiPanel owns its own
            header + scroll + composer, so it fills the pane directly. */}
        <Show when={isChatActive()}>
          <div class="toc-panel-pane toc-panel-pane-ai" data-pane="ai" role="tabpanel">
            {props.aiSlot}
          </div>
        </Show>
      </div>
    </aside>
  );
}
