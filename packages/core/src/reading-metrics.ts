/**
 * Reading metrics for the active document — pure parsing, no DOM,
 * no Tauri. Surfaced in the status bar via `formatReadingTime`.
 *
 * Word counting strips fenced markdown blocks (```), asciidoc
 * listing blocks (----), inline code, and link-target URLs so the
 * "X min" estimate reflects actual prose, not source code in the
 * doc.
 */

export interface ReadingMetrics {
  words: number;
  readingTimeMs: number;
}

const DEFAULT_WPM = 220;

const FENCED_BLOCK = /```[\s\S]*?```/g;
const ASCIIDOC_LISTING = /^----\s*$[\s\S]*?^----\s*$/gm;
/** Strip the link target `](url)` but preserve the visible label
 *  before it — readers see "click [here](http://…)" as 2 words, not 1. */
const LINK_TARGET = /\]\([^)]*\)/g;
/** Inline backticks, asterisks, underscores, headings, blockquotes,
 *  and link brackets are all formatting noise — remove the chars
 *  themselves but keep the content they decorate. */
const MD_DECORATIONS = /[*_~#>`[\]]+/g;

export function computeReadingMetrics(
  content: string,
  wordsPerMinute: number = DEFAULT_WPM,
): ReadingMetrics {
  if (!content) return { words: 0, readingTimeMs: 0 };

  const stripped = content
    .replace(FENCED_BLOCK, "")
    .replace(ASCIIDOC_LISTING, "")
    .replace(LINK_TARGET, "")
    .replace(MD_DECORATIONS, " ");

  const words = stripped
    .split(/\s+/)
    .filter((token) => token.length > 0).length;

  const readingTimeMs = Math.round((words / wordsPerMinute) * 60_000);
  return { words, readingTimeMs };
}

/**
 * Same metrics as `computeReadingMetrics`, but counts against the
 * **rendered** HTML the user actually reads. Use this for documents
 * that pull in content via `include::` (asciidoc) or other render-
 * time expansions — `editorContent` would only see the literal
 * include directive, undercounting the real reading load.
 */
export function computeReadingMetricsFromHtml(
  html: string,
  wordsPerMinute: number = DEFAULT_WPM,
): ReadingMetrics {
  return computeReadingMetrics(htmlToPlainText(html), wordsPerMinute);
}

const HTML_BLOCK_TO_DROP = /<(script|style|pre)\b[^>]*>[\s\S]*?<\/\1>/gi;
const HTML_TAG = /<[^>]+>/g;
const HTML_ENTITY_NUMERIC = /&#(\d+);/g;
const HTML_ENTITY_NAMED: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

function htmlToPlainText(html: string): string {
  if (!html) return "";
  let text = html.replace(HTML_BLOCK_TO_DROP, " ").replace(HTML_TAG, " ");
  text = text.replace(HTML_ENTITY_NUMERIC, (_, code) =>
    String.fromCharCode(Number(code)),
  );
  for (const [entity, char] of Object.entries(HTML_ENTITY_NAMED)) {
    text = text.split(entity).join(char);
  }
  return text;
}

/**
 * "X min" pill for the status bar. Empty string when there's nothing
 * to show — callers can chain it into the bar without an explicit
 * conditional.
 */
export function formatReadingTime(ms: number): string {
  if (ms <= 0) return "";
  // Anything non-zero rounds up to "1 min" so very short docs still
  // get a hit in the status bar; longer durations round to nearest
  // minute.
  if (ms < 30_000) return "1 min";
  const minutes = Math.round(ms / 60_000);
  return `${Math.max(1, minutes)} min`;
}
