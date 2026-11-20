use regex::Regex;
use std::sync::LazyLock;

// ECMAScript WhiteSpace + LineTerminator: FEFF is included, 0085 is not.
const JS_SPACE: &str = r"[\t\n\x0B\x0C\r \u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]";
fn expression(pattern: &str) -> Regex {
    Regex::new(&pattern.replace(r"\s", JS_SPACE)).expect("static secret expression")
}
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\x0B' | '\x0C' | '\r' | ' ' | '\u{00A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

// Metadata is a complete short string, so an unterminated PEM is hidden
// through its end using the same conservative state machine as file reads.
pub(super) fn short_text(input: &str) -> String {
    Stream::default().line(input)
}

/// `short_text`, unless the user turned masking off for the MCP server.
pub(super) fn text(mask: bool, input: &str) -> String {
    if mask {
        short_text(input)
    } else {
        input.to_owned()
    }
}

/// A whole text (a document or selection) with its lines scrubbed in order,
/// line endings kept. `cut` means the text was clipped at its end: the last
/// line may stop halfway through a secret, so hide trailing prefixes of one
/// before returning a single value character.
pub(super) fn block(mask: bool, input: &str, cut: bool) -> String {
    block_tracked(mask, input, cut).text
}

/// A masked text, and which bytes of the unmasked input survived into it
/// unchanged. A byte that is not `visible` was part of something hidden (a
/// secret, a PEM body): whoever cuts a range out of the input uses this to
/// hide it too, so a secret selected on its own is hidden by the context
/// around it.
pub(super) struct Masked {
    pub(super) text: String,
    pub(super) visible: Vec<bool>,
}

/// `block`, remembering what survived. `input` must be under `u32::MAX` bytes.
pub(super) fn block_tracked(mask: bool, input: &str, cut: bool) -> Masked {
    if !mask {
        return Masked {
            text: input.to_owned(),
            visible: vec![true; input.len()],
        };
    }
    let mut visible = vec![false; input.len()];
    let mut stream = Stream::default();
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while !rest.is_empty() {
        let at = input.len() - rest.len();
        let (line, tail) = match rest.find('\n') {
            Some(index) => rest.split_at(index + 1),
            None => (rest, ""),
        };
        let (body, ending) = if let Some(body) = line.strip_suffix("\r\n") {
            (body, "\r\n")
        } else if let Some(body) = line.strip_suffix('\n') {
            (body, "\n")
        } else {
            (line, "")
        };
        let masked = stream.line_tracked(body, at, cut && tail.is_empty());
        for origin in &masked.origin {
            if *origin != MARK {
                visible[*origin as usize] = true;
            }
        }
        out.push_str(&masked.text);
        out.push_str(ending);
        visible[at + body.len()..at + line.len()].fill(true);
        rest = tail;
    }
    Masked { text: out, visible }
}

// Keep these eight patterns in the same order as packages/ai/src/secret-scrub.ts.
// JS's word boundaries are ASCII, even when the surrounding text is Unicode.
static PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"(?-u:\b)sk-[A-Za-z0-9_-]{16,}(?-u:\b)",
        r"(?-u:\b)gh[pousr]_[A-Za-z0-9]{20,}(?-u:\b)",
        r"(?-u:\b)xox[baprs]-[A-Za-z0-9-]{10,}(?-u:\b)",
        r"(?-u:\b)AIza[A-Za-z0-9_-]{30,}(?-u:\b)",
        r"(?-u:\b)AKIA[0-9A-Z]{16}(?-u:\b)",
        r"(?-u:\b)Bearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}",
        r"-----BEGIN [A-Z ]*PRIVATE KEY-----(?s:.*?)-----END [A-Z ]*PRIVATE KEY-----",
        r#"(?i)(?-u:\b)(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{12,}["']?"#,
    ].into_iter().map(expression).collect()
});

#[cfg(test)]
pub(super) fn scrub(input: &str) -> String {
    PATTERNS.iter().fold(input.to_owned(), |text, pattern| {
        pattern.replace_all(&text, "[secret]").into_owned()
    })
}

const MARK: u32 = u32::MAX;

/// Text that remembers, per byte, where it came from in the unmasked input
/// (`MARK` for the bytes a replacement put there).
#[derive(Default)]
struct Tracked {
    text: String,
    origin: Vec<u32>,
}
impl Tracked {
    fn push_raw(&mut self, text: &str, base: usize) {
        self.text.push_str(text);
        self.origin
            .extend((base..base + text.len()).map(|at| at as u32));
    }
    fn push_mark(&mut self) {
        self.text.push_str("[secret]");
        self.origin.extend([MARK; 8]);
    }
    fn replace_range(&mut self, range: std::ops::Range<usize>) {
        self.text.replace_range(range.clone(), "[secret]");
        self.origin.splice(range, [MARK; 8]);
    }
    /// Replace every match (or only the first) in one pass.
    fn replace(&mut self, pattern: &Regex, first_only: bool) {
        let found: Vec<_> = if first_only {
            pattern
                .find(&self.text)
                .into_iter()
                .map(|m| m.range())
                .collect()
        } else {
            pattern.find_iter(&self.text).map(|m| m.range()).collect()
        };
        if found.is_empty() {
            return;
        }
        let mut next = Tracked::default();
        let mut last = 0;
        for range in found {
            next.text.push_str(&self.text[last..range.start]);
            next.origin
                .extend_from_slice(&self.origin[last..range.start]);
            next.push_mark();
            last = range.end;
        }
        next.text.push_str(&self.text[last..]);
        next.origin.extend_from_slice(&self.origin[last..]);
        *self = next;
    }
}

// Streaming reads must also hide blocks crossing the requested line range,
// and introducers separated from their value by arbitrary newlines. Carry
// only state, never an unbounded secret/whitespace buffer. In these boundary
// cases redaction is deliberately conservative (an incomplete PEM is hidden).
#[derive(Clone, Copy)]
struct Prefix {
    bearer: bool,
    separator: bool,
    quoted: bool,
}
#[derive(Default)]
pub(super) struct Stream {
    pem: bool,
    continuation: Option<Prefix>,
}
impl Stream {
    pub(super) fn line(&mut self, input: &str) -> String {
        self.line_with_cut(input, false)
    }
    pub(super) fn line_with_cut(&mut self, input: &str, cut: bool) -> String {
        self.line_tracked(input, 0, cut).text
    }
    /// One line, where `base` is the offset of `input` in the unmasked text.
    fn line_tracked(&mut self, input: &str, base: usize, cut: bool) -> Tracked {
        static BEGIN: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"-----BEGIN [A-Z ]*PRIVATE KEY-----").unwrap());
        static END: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"-----END [A-Z ]*PRIVATE KEY-----").unwrap());
        static INTRO: LazyLock<Regex> = LazyLock::new(|| {
            expression(
                r#"(?-u:\b)(?:(Bearer)\s*|(?i:(api[_-]?key|secret|token|password))\s*([:=])?\s*(["'])?\s*)$"#,
            )
        });
        static ASSIGN_VALUE: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r#"^[A-Za-z0-9._~+/-]{12,}["']?"#).unwrap());
        static BEARER_VALUE: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"^[A-Za-z0-9._~+/-]{16,}={0,2}").unwrap());
        let mut at = 0;
        let mut text = Tracked::default();
        while at < input.len() {
            let rest = &input[at..];
            if self.pem {
                if let Some(end) = END.find(rest) {
                    at += end.end();
                    self.pem = false;
                } else {
                    at = input.len();
                }
            } else if let Some(begin) = BEGIN.find(rest) {
                text.push_raw(&rest[..begin.start()], base + at);
                text.push_mark();
                at += begin.end();
                self.pem = true;
            } else {
                text.push_raw(rest, base + at);
                at = input.len();
            }
        }
        if let Some(mut prefix) = self.continuation.take() {
            let mut value = text.text.trim_start_matches(js_space);
            if !prefix.bearer && !prefix.separator {
                if let Some(after) = value.strip_prefix([':', '=']) {
                    value = after.trim_start_matches(js_space);
                    prefix.separator = true;
                } else if value.is_empty() {
                    self.continuation = Some(prefix);
                    return text;
                }
            }
            if prefix.bearer || prefix.separator {
                if !prefix.bearer && !prefix.quoted {
                    if let Some(after) = value.strip_prefix(['\"', '\'']) {
                        value = after.trim_start_matches(js_space);
                        prefix.quoted = true;
                    }
                }
                if value.is_empty() {
                    self.continuation = Some(prefix);
                    return text;
                }
                static CUT_VALUE: LazyLock<Regex> =
                    LazyLock::new(|| Regex::new(r#"^[A-Za-z0-9._~+/-]+={0,2}["']?"#).unwrap());
                let pattern = if cut {
                    &CUT_VALUE
                } else if prefix.bearer {
                    &BEARER_VALUE
                } else {
                    &ASSIGN_VALUE
                };
                if let Some(found) = pattern.find(value) {
                    let offset = text.text.len() - value.len();
                    text.replace_range(offset..offset + found.end());
                }
            }
        }
        if let Some(found) = INTRO.captures(&text.text) {
            self.continuation = Some(Prefix {
                bearer: found.get(1).is_some(),
                separator: found.get(3).is_some(),
                quoted: found.get(4).is_some(),
            });
        }
        for pattern in PATTERNS.iter() {
            text.replace(pattern, false);
        }
        if cut {
            // A retained raw line can end halfway through a secret, below the
            // ordinary regex minimum. Hide recognizable trailing prefixes
            // BEFORE returning even one value character to the caller.
            static TAIL: LazyLock<Regex> = LazyLock::new(|| {
                expression(
                    r#"(?-u:\b)(?:sk-[A-Za-z0-9_-]*|gh[pousr]_[A-Za-z0-9]*|xox[baprs]-[A-Za-z0-9-]*|AIza[A-Za-z0-9_-]*|AKIA[0-9A-Z]*|Bearer\s+[A-Za-z0-9._~+/-]*={0,2}|(?i:(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9._~+/-]*["']?))$"#,
                )
            });
            text.replace(&TAIL, true);
        }
        text
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_vectors() {
        let vectors: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../packages/ai/src/secret-scrub.vectors.json"
        ))
        .unwrap();
        for case in vectors.as_array().unwrap() {
            if case["masked"] == false {
                let mut stream = Stream::default();
                let input = case["input"].as_str().unwrap();
                let output = input
                    .split_inclusive('\n')
                    .map(|part| {
                        let body = part.strip_suffix('\n').unwrap_or(part);
                        let mut safe = stream.line(body);
                        if part.ends_with('\n') {
                            safe.push('\n');
                        }
                        safe
                    })
                    .collect::<String>();
                assert_eq!(
                    output, input,
                    "secret-free streaming vector {}",
                    case["name"]
                );
            }
            assert_eq!(
                scrub(case["input"].as_str().unwrap()),
                case["expected"].as_str().unwrap(),
                "{}",
                case["name"]
            );
        }
    }
}

#[cfg(test)]
mod security_fix_tests {
    use super::*;
    #[test]
    fn security_fix_stream_ecmascript_spaces() {
        for (space, masks) in [
            ("\u{FEFF}", true),
            ("\u{0085}", false),
            ("\u{00A0}", true),
            (" ", true),
        ] {
            for prefix in [
                "Bearer",
                "api_key=",
                "api-key=",
                "apikey=",
                "secret=",
                "token=",
                "password=",
                "API_KEY:",
            ] {
                let input = format!("{prefix}{space}abcdefghijklmnop");
                assert_eq!(
                    Stream::default().line(&input),
                    if masks { "[secret]" } else { &input },
                    "{input:?}"
                );
                if prefix != "Bearer" {
                    for (prelude, value) in [
                        ("token", format!("={space}abcdefghijklmnop")),
                        ("token=", format!("'{space}abcdefghijklmnop")),
                    ] {
                        let mut stream = Stream::default();
                        stream.line(prelude);
                        let output = stream.line(&value);
                        assert_eq!(
                            output.contains("abcdefghijklmnop"),
                            !masks,
                            "separator/quote {value:?}: {output:?}"
                        );
                    }
                }
                let mut prelude = Stream::default();
                prelude.line(&format!("{prefix}{space}"));
                let output = prelude.line("abcdefghijklmnop");
                assert_eq!(
                    output.contains("abcdefghijklmnop"),
                    !masks,
                    "prelude {input:?}: {output:?}"
                );
                let mut stream = Stream::default();
                stream.line(prefix);
                let value = format!("{space}abcdefghijklmnop");
                let output = stream.line(&value);
                assert_eq!(
                    output.contains("abcdefghijklmnop"),
                    !masks,
                    "continuation {input:?}: {output:?}"
                );
                let output = Stream::default().line_with_cut(&format!("{prefix}{space}abc"), true);
                assert_eq!(output.contains("abc"), !masks, "cut {input:?}: {output:?}");
            }
        }
    }

    fn kept(input: &str, masked: &Masked) -> String {
        input
            .char_indices()
            .filter(|(at, _)| masked.visible[*at])
            .map(|(_, ch)| ch)
            .collect()
    }
    #[test]
    fn what_survives_is_tracked_byte_for_byte() {
        let key = "sk-aaaaaaaaaaaaaaaaaaaa";
        let pem = "-----BEGIN PRIVATE KEY-----\nMIIEbody\nmore\n-----END PRIVATE KEY-----";
        for (input, survivors) in [
            (format!("a {key} b"), "a  b".to_owned()),
            (format!("é {key} ü"), "é  ü".to_owned()),
            (
                "password = hunter2hunter2\nnext".to_owned(),
                "\nnext".to_owned(),
            ),
            (format!("x\n{pem}\ny\n"), "x\n\n\n\n\ny\n".to_owned()),
            // Introducer on one line, value on the next.
            (
                "token =\nabcdefghijklmnop\nz".to_owned(),
                "token =\n\nz".to_owned(),
            ),
            ("plain text".to_owned(), "plain text".to_owned()),
        ] {
            let masked = block_tracked(true, &input, false);
            assert_eq!(masked.text, block(true, &input, false), "{input:?}");
            assert_eq!(kept(&input, &masked), survivors, "{input:?}");
            assert_eq!(masked.visible.len(), input.len());
            // Control: with masking off nothing is hidden.
            let raw = block_tracked(false, &input, false);
            assert_eq!(kept(&input, &raw), input);
        }
        // A cut hides a trailing prefix of a secret too.
        let masked = block_tracked(true, "go sk-", true);
        assert_eq!(kept("go sk-", &masked), "go ");
    }
}
