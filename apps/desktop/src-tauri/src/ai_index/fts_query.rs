//! FTS5 `MATCH` query preparation for user/agent-supplied search text.
//!
//! Ported near-verbatim from ai-memory (MIT, Fabio Akita) — the same sanitizer
//! that keeps natural-language queries from erroring against an FTS5 table.
//!
//! FTS5 treats `column:term` as a column-qualified search; bare colons
//! (`pick: handoff`) make SQLite error with `no such column: pick`. Punctuated
//! tokens (`current.md`, `ui-refresh`) are quoted as phrases so they match the
//! `unicode61 remove_diacritics 2 tokenchars '/_-'` content tokens AND the
//! space-split `path_search` index. Deliberate FTS5 operators (OR/AND/NOT/NEAR,
//! quotes, parens) are preserved verbatim.

/// Sanitize free-text for use in `WHERE documents_fts MATCH ?`.
///
/// Returns an empty string when `raw` is empty/whitespace-only; callers should
/// skip the SQL query in that case. Bare multi-word queries are joined with
/// **`OR`** (broad recall under bm25 ranking); explicit FTS5 syntax is kept.
#[must_use]
pub fn prepare_fts5_query(raw: &str) -> String {
    let explicit_syntax = raw.contains('"')
        || raw.contains('(')
        || raw.contains(')')
        || raw
            .split_whitespace()
            .any(|t| matches!(t, "OR" | "AND" | "NOT" | "NEAR"));
    let tokens: Vec<String> = raw
        .split_whitespace()
        .flat_map(prepare_fts5_token)
        .collect();
    if tokens.is_empty() {
        return String::new();
    }
    let separator = if explicit_syntax { " " } else { " OR " };
    tokens.join(separator)
}

fn prepare_fts5_token(token: &str) -> Vec<String> {
    if has_unknown_bare_column(token) {
        return token
            .replace(':', " ")
            .split_whitespace()
            .map(quote_fts5_token)
            .collect();
    }

    if should_quote_fts5_token(token) {
        vec![quote_fts5_token(token)]
    } else {
        vec![token.to_string()]
    }
}

fn has_unknown_bare_column(token: &str) -> bool {
    token.contains(':')
        && !token.contains('"')
        && !token.starts_with("title:")
        && !token.starts_with("body:")
}

fn should_quote_fts5_token(token: &str) -> bool {
    if token.starts_with('"') && token.ends_with('"') {
        return false;
    }
    // Quote any token carrying ASCII punctuation so FTS5 treats it as a literal
    // phrase. A trailing `*` (the FTS5 prefix operator) stays bare; accented
    // letters/digits are unicode (not ASCII punctuation) so accents survive.
    let core = token.strip_suffix('*').unwrap_or(token);
    core.chars().any(|c| c.is_ascii_punctuation() && c != ':')
}

fn quote_fts5_token(token: &str) -> String {
    if token.contains('"') {
        return format!("\"{}\"", token.replace('"', "\"\""));
    }
    // Emit BOTH the whole token and a punctuation-stripped sub-token phrase,
    // OR'd, because the content tokenizer (keeps `/ _ -` inside tokens) and the
    // space-split path index disagree on punctuation. With no punctuation the
    // two coincide and we emit a single phrase.
    let split = token
        .chars()
        .map(|c| if c.is_ascii_punctuation() { ' ' } else { c })
        .collect::<String>();
    let split = split.split_whitespace().collect::<Vec<_>>().join(" ");
    if split.is_empty() || split == token {
        format!("\"{token}\"")
    } else {
        format!("(\"{token}\" OR \"{split}\")")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colon_is_not_column_syntax() {
        let q = prepare_fts5_query("pick: handoff ai-memory");
        assert_eq!(q, "\"pick\" OR handoff OR (\"ai-memory\" OR \"ai memory\")");
    }

    #[test]
    fn bare_multi_word_is_or_joined() {
        assert_eq!(
            prepare_fts5_query("cross project search strategy"),
            "cross OR project OR search OR strategy"
        );
    }

    #[test]
    fn portuguese_accented_terms_or_join_and_keep_accents() {
        assert_eq!(
            prepare_fts5_query("descrição testes commits"),
            "descrição OR testes OR commits"
        );
    }

    #[test]
    fn single_word_has_no_or() {
        assert_eq!(prepare_fts5_query("handoff"), "handoff");
    }

    #[test]
    fn dotted_filename_token_is_quoted() {
        assert_eq!(
            prepare_fts5_query("current.md"),
            "(\"current.md\" OR \"current md\")"
        );
        assert_eq!(
            prepare_fts5_query("a/b/c.md"),
            "(\"a/b/c.md\" OR \"a b c md\")"
        );
    }

    #[test]
    fn hyphenated_token_quotes_as_subtoken_phrase() {
        assert_eq!(
            prepare_fts5_query("ui-refresh"),
            "(\"ui-refresh\" OR \"ui refresh\")"
        );
    }

    #[test]
    fn prefix_star_token_stays_bare() {
        assert_eq!(prepare_fts5_query("curr*"), "curr*");
    }

    #[test]
    fn empty_yields_empty() {
        assert_eq!(prepare_fts5_query("   "), "");
    }

    #[test]
    fn boolean_operators_are_preserved() {
        assert_eq!(prepare_fts5_query("quick OR slow"), "quick OR slow");
    }

    #[test]
    fn explicit_and_operator_is_preserved() {
        assert_eq!(prepare_fts5_query("foo AND bar"), "foo AND bar");
    }

    #[test]
    fn quoted_phrase_query_is_not_or_joined() {
        let q = prepare_fts5_query("\"exact phrase\" baz");
        assert!(
            !q.contains(" OR "),
            "quoted-phrase query must not be OR-joined; got {q}"
        );
    }

    #[test]
    fn known_columns_are_preserved() {
        assert_eq!(prepare_fts5_query("title:handoff"), "title:handoff");
    }
}
