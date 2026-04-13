import { createEffect, createMemo, createSignal, For, Show, type JSX } from "solid-js";
import IconChevronDown from "~icons/lucide/chevron-down";
import IconText from "~icons/lucide/text";
import IconTag from "~icons/lucide/tag";
import IconHash from "~icons/lucide/hash";
import IconCalendar from "~icons/lucide/calendar";
import IconCalendarClock from "~icons/lucide/calendar-clock";
import IconLink2 from "~icons/lucide/link-2";
import IconListTree from "~icons/lucide/list-tree";
import IconActivity from "~icons/lucide/activity";
import IconUsers from "~icons/lucide/users";
import IconList from "~icons/lucide/list";
import { Badge } from "./ui/badge.tsx";
import { parseWikiLink, type Frontmatter } from "@asciimark/core/frontmatter.ts";

interface FrontmatterPanelProps {
  frontmatter: Frontmatter;
  currentFilePath: string | null;
  onNavigate: (path: string, fragment?: string | null) => void;
}

type IconComponent = (props: { width?: number; height?: number }) => JSX.Element;

// Display order + icons for known keys. Unknown keys fall through to the
// generic "list" icon and a key-as-label rendering.
const KNOWN_KEYS: { key: string; icon: IconComponent; label: string }[] = [
  { key: "title", icon: IconText, label: "title" },
  { key: "type", icon: IconTag, label: "type" },
  { key: "tags", icon: IconHash, label: "tags" },
  { key: "created", icon: IconCalendar, label: "created" },
  { key: "updated", icon: IconCalendarClock, label: "updated" },
  { key: "sources", icon: IconLink2, label: "sources" },
  { key: "related", icon: IconListTree, label: "related" },
  { key: "status", icon: IconActivity, label: "status" },
  { key: "audience", icon: IconUsers, label: "audience" },
];

/**
 * Keys whose value should always be rendered as chip(s) — same visual style
 * as `tags`. Single string values render as a single chip; arrays render as
 * multiple chips.
 */
const CHIP_KEYS = new Set(["tags", "status", "audience", "type", "category", "labels", "kind"]);

function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function toStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.map((x) => (x == null ? "" : String(x))).filter((s) => s.length > 0);
}

/** Heuristic: short, single-token strings (no whitespace) look like a tag. */
function looksLikeTag(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 32 && !/\s/.test(trimmed);
}

const COLLAPSE_KEY_PREFIX = "frontmatter-collapsed:";

export function FrontmatterPanel(props: FrontmatterPanelProps) {
  const storageKey = createMemo(
    () => `${COLLAPSE_KEY_PREFIX}${props.currentFilePath ?? "__no_file__"}`,
  );
  const [collapsed, setCollapsed] = createSignal(false);

  // Restore collapse state when the file (storage key) changes
  createEffect(() => {
    const key = storageKey();
    try {
      setCollapsed(localStorage.getItem(key) === "1");
    } catch {
      setCollapsed(false);
    }
  });

  function toggle() {
    const next = !collapsed();
    setCollapsed(next);
    try {
      localStorage.setItem(storageKey(), next ? "1" : "0");
    } catch {
      // localStorage may be unavailable (private mode, etc.) — keep state in memory
    }
  }

  // Order: known keys first (in defined order), then any extras alphabetically
  const orderedEntries = createMemo(() => {
    const fm = props.frontmatter;
    const seen = new Set<string>();
    const entries: { key: string; icon: IconComponent; label: string; value: unknown }[] = [];
    for (const k of KNOWN_KEYS) {
      if (k.key in fm && fm[k.key] != null) {
        entries.push({ ...k, value: fm[k.key] });
        seen.add(k.key);
      }
    }
    const extras = Object.keys(fm)
      .filter((k) => !seen.has(k) && fm[k] != null)
      .sort();
    for (const k of extras) {
      entries.push({ key: k, icon: IconList, label: k, value: fm[k] });
    }
    return entries;
  });

  function navigateWiki(name: string) {
    // Best-effort: hand the bare name to onNavigate. The file-loader chain
    // is responsible for matching it against existing files. We don't try
    // .md/.adoc fallbacks here to keep the panel decoupled from filesystem
    // lookup.
    props.onNavigate(name);
  }

  /** Render a list of strings as `secondary` chips — the canonical "tag" look. */
  function renderChips(items: string[]): JSX.Element {
    if (items.length === 0) return <span class="frontmatter-empty">—</span>;
    return (
      <div class="frontmatter-chips">
        <For each={items}>
          {(item) => <Badge variant="secondary">{item}</Badge>}
        </For>
      </div>
    );
  }

  function renderValue(key: string, value: unknown): JSX.Element {
    // Sources / related: array of wiki-links or URLs (always rendered as links)
    if (key === "sources" || key === "related") {
      const arr = toStringArray(value);
      if (!arr || arr.length === 0) return <span class="frontmatter-empty">—</span>;
      return (
        <div class="frontmatter-links">
          <For each={arr}>
            {(item) => {
              const wiki = parseWikiLink(item);
              if (wiki) {
                return (
                  <a
                    class="frontmatter-link"
                    href={`#${wiki}`}
                    onClick={(e) => {
                      e.preventDefault();
                      navigateWiki(wiki);
                    }}
                  >
                    {wiki}
                  </a>
                );
              }
              if (isUrl(item)) {
                return (
                  <a class="frontmatter-link" href={item} target="_blank" rel="noopener noreferrer">
                    {item}
                  </a>
                );
              }
              return <span class="frontmatter-text">{item}</span>;
            }}
          </For>
        </div>
      );
    }

    // Explicit chip-style keys: render as chips regardless of scalar/array shape
    if (CHIP_KEYS.has(key)) {
      const arr = toStringArray(value);
      if (arr) return renderChips(arr);
      if (typeof value === "string" && value.trim().length > 0) {
        return renderChips([value.trim()]);
      }
      if (value == null || value === "") return <span class="frontmatter-empty">—</span>;
      return renderChips([String(value)]);
    }

    // Generic array → chips
    if (Array.isArray(value)) {
      const arr = toStringArray(value);
      return renderChips(arr ?? []);
    }

    // Scalar
    if (value == null || value === "") return <span class="frontmatter-empty">—</span>;
    if (typeof value === "string") {
      if (isUrl(value)) {
        return (
          <a class="frontmatter-link" href={value} target="_blank" rel="noopener noreferrer">
            {value}
          </a>
        );
      }
      // Tag-like single tokens (no whitespace, short) render as chips for
      // visual consistency with `tags`/`status`/`audience`.
      if (looksLikeTag(value)) {
        return renderChips([value.trim()]);
      }
    }
    // Nested objects: render as key: value list
    if (typeof value === "object") {
      return (
        <div class="frontmatter-nested">
          <For each={Object.entries(value as Record<string, unknown>)}>
            {([k, v]) => (
              <div class="frontmatter-nested-row">
                <span class="frontmatter-nested-key">{k}:</span>
                <span class="frontmatter-nested-value">{renderValue(k, v)}</span>
              </div>
            )}
          </For>
        </div>
      );
    }
    return <span class="frontmatter-text">{String(value)}</span>;
  }

  return (
    <div class="frontmatter-panel" classList={{ "frontmatter-collapsed": collapsed() }}>
      <button
        type="button"
        class="frontmatter-header"
        aria-expanded={!collapsed()}
        onClick={toggle}
      >
        <IconChevronDown class="frontmatter-chevron" width={14} height={14} />
        <span class="frontmatter-title">Properties</span>
      </button>
      <Show when={!collapsed()}>
        <div class="frontmatter-body">
          <For each={orderedEntries()}>
            {(entry) => (
              <div class="frontmatter-row">
                <span class="frontmatter-key">
                  <entry.icon width={14} height={14} />
                  <span>{entry.label}</span>
                </span>
                <div class="frontmatter-value">{renderValue(entry.key, entry.value)}</div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
