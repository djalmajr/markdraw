use regex::Regex;
use std::sync::LazyLock;

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
        r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----",
        r#"(?i)(?-u:\b)(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{12,}["']?"#,
    ].into_iter().map(|p| Regex::new(p).expect("static secret expression")).collect()
});

pub(super) fn scrub(input: &str) -> String {
    PATTERNS.iter().fold(input.to_owned(), |text, pattern| {
        pattern.replace_all(&text, "[secret]").into_owned()
    })
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
        static BEGIN: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"-----BEGIN [A-Z ]*PRIVATE KEY-----").unwrap());
        static END: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"-----END [A-Z ]*PRIVATE KEY-----").unwrap());
        static INTRO: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(r#"(?-u:\b)(?:(Bearer)\s*|(?i:(api[_-]?key|secret|token|password))\s*([:=])?\s*(["'])?\s*)$"#).unwrap()
        });
        static ASSIGN_VALUE: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r#"^[A-Za-z0-9._~+/-]{12,}["']?"#).unwrap());
        static BEARER_VALUE: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"^[A-Za-z0-9._~+/-]{16,}={0,2}").unwrap());
        let mut rest = input;
        let mut text = String::new();
        while !rest.is_empty() {
            if self.pem {
                if let Some(end) = END.find(rest) {
                    rest = &rest[end.end()..];
                    self.pem = false;
                } else {
                    rest = "";
                }
            } else if let Some(begin) = BEGIN.find(rest) {
                text.push_str(&rest[..begin.start()]);
                text.push_str("[secret]");
                rest = &rest[begin.end()..];
                self.pem = true;
            } else {
                text.push_str(rest);
                rest = "";
            }
        }
        if let Some(mut prefix) = self.continuation.take() {
            let mut value = text.trim_start();
            if !prefix.bearer && !prefix.separator {
                if let Some(after) = value.strip_prefix([':', '=']) {
                    value = after.trim_start();
                    prefix.separator = true;
                } else if value.is_empty() {
                    self.continuation = Some(prefix);
                    return text;
                }
            }
            if prefix.bearer || prefix.separator {
                if !prefix.bearer && !prefix.quoted {
                    if let Some(after) = value.strip_prefix(['\"', '\'']) {
                        value = after.trim_start();
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
                    let offset = text.len() - value.len();
                    text.replace_range(offset..offset + found.end(), "[secret]");
                }
            }
        }
        if let Some(found) = INTRO.captures(&text) {
            self.continuation = Some(Prefix {
                bearer: found.get(1).is_some(),
                separator: found.get(3).is_some(),
                quoted: found.get(4).is_some(),
            });
        }
        let safe = scrub(&text);
        if cut {
            // A retained raw line can end halfway through a secret, below the
            // ordinary regex minimum. Hide recognizable trailing prefixes
            // BEFORE returning even one value character to the caller.
            static TAIL: LazyLock<Regex> = LazyLock::new(|| {
                Regex::new(
                r#"(?-u:\b)(?:sk-[A-Za-z0-9_-]*|gh[pousr]_[A-Za-z0-9]*|xox[baprs]-[A-Za-z0-9-]*|AIza[A-Za-z0-9_-]*|AKIA[0-9A-Z]*|Bearer\s+[A-Za-z0-9._~+/-]*={0,2}|(?i:(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9._~+/-]*["']?))$"#
            ).unwrap()
            });
            TAIL.replace(&safe, "[secret]").into_owned()
        } else {
            safe
        }
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
