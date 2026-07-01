use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

use crate::frontmatter::{first_heading, frontmatter_value, unquote};

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredRuleFile {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub always_apply: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub condition: Option<String>,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub globs: Option<Vec<String>>,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    pub scope: String,
    pub source: String,
    pub source_path: String,
}

fn bool_value(content: &str, key: &str) -> Option<bool> {
    frontmatter_value(content, key).and_then(|value| match value.to_lowercase().as_str() {
        "true" | "yes" | "1" => Some(true),
        "false" | "no" | "0" => Some(false),
        _ => None,
    })
}

fn list_value(content: &str, key: &str) -> Option<Vec<String>> {
    let value = frontmatter_value(content, key)?;
    let trimmed = value.trim();
    let inner = trimmed
        .strip_prefix('[')
        .and_then(|v| v.strip_suffix(']'))
        .unwrap_or(trimmed);
    let values: Vec<String> = inner
        .split(',')
        .map(unquote)
        .filter(|item| !item.is_empty())
        .collect();
    (!values.is_empty()).then_some(values)
}

fn fallback_name(path: &Path, content: &str) -> Option<String> {
    frontmatter_value(content, "name")
        .or_else(|| first_heading(content))
        .or_else(|| path.file_stem().map(|name| name.to_string_lossy().to_string()))
        .filter(|name| !name.trim().is_empty())
}

fn read_rule(
    path: &Path,
    source: &str,
    scope: &str,
    root: Option<&str>,
    default_name: Option<&str>,
    default_always_apply: bool,
) -> Option<DiscoveredRuleFile> {
    let content = std::fs::read_to_string(path).ok()?;
    let name = fallback_name(path, &content).or_else(|| default_name.map(str::to_string))?;
    Some(DiscoveredRuleFile {
        always_apply: bool_value(&content, "alwaysApply")
            .or_else(|| bool_value(&content, "always_apply"))
            .or(Some(default_always_apply)),
        condition: frontmatter_value(&content, "condition"),
        description: frontmatter_value(&content, "description"),
        globs: list_value(&content, "globs"),
        content,
        name,
        root: root.map(str::to_string),
        scope: scope.to_string(),
        source: source.to_string(),
        source_path: path.to_string_lossy().to_string(),
    })
}

fn collect_markdown_files(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    if depth > 4 {
        return;
    }
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in read.flatten() {
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            collect_markdown_files(&path, out, depth + 1);
            continue;
        }
        if !meta.is_file() {
            continue;
        }
        let ext = path
            .extension()
            .map(|ext| ext.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if matches!(ext.as_str(), "md" | "mdc" | "markdown" | "") {
            out.push(path);
        }
    }
}

fn collect_rule_dir(
    dir: &Path,
    source: &str,
    scope: &str,
    root: Option<&str>,
    default_always_apply: bool,
) -> Vec<DiscoveredRuleFile> {
    let mut paths = Vec::new();
    collect_markdown_files(dir, &mut paths, 0);
    paths.sort();
    paths
        .iter()
        .filter_map(|path| read_rule(path, source, scope, root, None, default_always_apply))
        .collect()
}

fn collect_project_rules(root: &str) -> Vec<DiscoveredRuleFile> {
    let base = Path::new(root);
    let mut out = Vec::new();
    for (path, source, name, always_apply) in [
        (base.join(".markdraw").join("RULES.md"), "markdraw", "Markdraw rules", true),
        (base.join(".markdraw").join("WATCHDOG.md"), "markdraw", "Markdraw watchdog", false),
        (base.join("AGENTS.md"), "agents", "AGENTS.md", true),
        (base.join("CLAUDE.md"), "claude", "CLAUDE.md", true),
        (base.join(".clinerules"), "cline", ".clinerules", true),
    ] {
        if path.is_file() {
            if let Some(rule) = read_rule(&path, source, "project", Some(root), Some(name), always_apply) {
                out.push(rule);
            }
        }
    }
    out.extend(collect_rule_dir(
        &base.join(".markdraw").join("rules"),
        "markdraw",
        "project",
        Some(root),
        false,
    ));
    out.extend(collect_rule_dir(
        &base.join(".cursor").join("rules"),
        "cursor",
        "project",
        Some(root),
        false,
    ));
    out.extend(collect_rule_dir(
        &base.join(".windsurf").join("rules"),
        "windsurf",
        "project",
        Some(root),
        false,
    ));
    out
}

#[tauri::command]
pub async fn rules_discover<R: Runtime>(
    app: AppHandle<R>,
    roots: Vec<String>,
) -> Result<Vec<DiscoveredRuleFile>, String> {
    let home = app.path().home_dir().map_err(|e| format!("home dir: {e}"))?;
    let config = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app config dir: {e}"))?;
    let mut out = Vec::new();

    for (path, source, name, always_apply) in [
        (config.join("RULES.md"), "markdraw", "Markdraw user rules", true),
        (config.join("WATCHDOG.md"), "markdraw", "Markdraw user watchdog", false),
        (home.join(".codex").join("AGENTS.md"), "codex", "Codex user rules", true),
        (home.join(".agents").join("AGENTS.md"), "agents", "Agents user rules", true),
        (home.join(".claude").join("CLAUDE.md"), "claude", "Claude user rules", true),
        (home.join(".clinerules"), "cline", ".clinerules", true),
    ] {
        if path.is_file() {
            if let Some(rule) = read_rule(&path, source, "global", None, Some(name), always_apply) {
                out.push(rule);
            }
        }
    }
    out.extend(collect_rule_dir(&config.join("rules"), "markdraw", "global", None, false));
    out.extend(collect_rule_dir(
        &home.join(".cursor").join("rules"),
        "cursor",
        "global",
        None,
        false,
    ));
    out.extend(collect_rule_dir(
        &home.join(".windsurf").join("rules"),
        "windsurf",
        "global",
        None,
        false,
    ));
    for root in roots {
        out.extend(collect_project_rules(&root));
    }
    out.sort_by(|a, b| a.source_path.cmp(&b.source_path));
    Ok(out)
}
