//! Shared frontmatter/Markdown parsing helpers used by both the skill and rule
//! discovery modules. Keeping them here (instead of duplicated per module)
//! guarantees the two paths normalize metadata identically — including block
//! (`|`) and folded (`>`) scalar values.

/// Strip a single pair of matching single/double quotes (and surrounding
/// whitespace) from a scalar frontmatter value. Unquoted values are returned
/// trimmed.
pub(crate) fn unquote(s: &str) -> String {
    let trimmed = s.trim();
    if trimmed.len() >= 2 {
        let bytes = trimmed.as_bytes();
        if (bytes[0] == b'"' && bytes[trimmed.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[trimmed.len() - 1] == b'\'')
        {
            return trimmed[1..trimmed.len() - 1].trim().to_string();
        }
    }
    trimmed.to_string()
}

/// Read the first scalar value for `key` from the leading `---` frontmatter
/// block. Supports block (`|`) and folded (`>`) scalars that span the lines
/// following the key. Returns `None` when there is no frontmatter fence or the
/// key is absent/empty.
pub(crate) fn frontmatter_value(content: &str, key: &str) -> Option<String> {
    let mut lines = content.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    let prefix = format!("{key}:");
    let mut frontmatter = Vec::new();
    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            break;
        }
        frontmatter.push(line);
    }

    for (index, line) in frontmatter.iter().enumerate() {
        let trimmed = line.trim();
        if let Some(value) = trimmed.strip_prefix(&prefix) {
            let value = unquote(value);
            if matches!(value.as_bytes().first(), Some(b'>') | Some(b'|')) {
                let value =
                    frontmatter_block_value(&frontmatter[index + 1..], value.starts_with('>'));
                if !value.is_empty() {
                    return Some(value);
                }
            }
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

fn is_frontmatter_key(line: &str) -> bool {
    if line.starts_with(' ') || line.starts_with('\t') {
        return false;
    }
    let Some((key, _)) = line.split_once(':') else {
        return false;
    };
    !key.is_empty()
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn frontmatter_block_value(lines: &[&str], folded: bool) -> String {
    let mut block = Vec::new();
    for line in lines {
        if is_frontmatter_key(line) {
            break;
        }
        block.push(line.trim().to_string());
    }
    if folded {
        block
            .join(" ")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        block.join("\n").trim().to_string()
    }
}

/// The first Markdown H1 (`# Heading`) in `content`, trimmed — used as a name
/// fallback when there is no frontmatter `name`.
pub(crate) fn first_heading(content: &str) -> Option<String> {
    content.lines().find_map(|line| {
        let trimmed = line.trim();
        let heading = trimmed.strip_prefix("# ")?;
        let heading = heading.trim();
        (!heading.is_empty()).then(|| heading.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unquote_strips_matching_quotes() {
        assert_eq!(unquote("  \"hello\"  "), "hello");
        assert_eq!(unquote("'world'"), "world");
        assert_eq!(unquote("bare"), "bare");
        assert_eq!(unquote("\"mismatched'"), "\"mismatched'");
    }

    #[test]
    fn frontmatter_value_reads_scalar() {
        let content = "---\nname: demo\ndescription: A tool\n---\n# Title";
        assert_eq!(frontmatter_value(content, "name").as_deref(), Some("demo"));
        assert_eq!(
            frontmatter_value(content, "description").as_deref(),
            Some("A tool")
        );
        assert_eq!(frontmatter_value(content, "missing"), None);
    }

    #[test]
    fn frontmatter_value_requires_leading_fence() {
        assert_eq!(frontmatter_value("name: demo\n", "name"), None);
    }

    #[test]
    fn frontmatter_value_reads_folded_scalar() {
        let content =
            "---\ndescription: >\n  Run a strict review\n  before shipping.\nmeta: x\n---\n";
        assert_eq!(
            frontmatter_value(content, "description").as_deref(),
            Some("Run a strict review before shipping.")
        );
    }

    #[test]
    fn frontmatter_value_reads_block_scalar() {
        let content = "---\ndescription: |\n  Line one\n  Line two\nnext: x\n---\n";
        assert_eq!(
            frontmatter_value(content, "description").as_deref(),
            Some("Line one\nLine two")
        );
    }

    #[test]
    fn first_heading_returns_first_h1() {
        assert_eq!(
            first_heading("intro\n# Heading\nmore").as_deref(),
            Some("Heading")
        );
        assert_eq!(first_heading("no heading here"), None);
    }
}
