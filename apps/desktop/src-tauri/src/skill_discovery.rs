//! Discovery of agent skills that other local tools already expose (Claude,
//! Codex/Agents, OpenCode). This module only reads `SKILL.md` files from known
//! global/project roots and normalizes basic metadata for the JS host.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

use crate::frontmatter::{first_heading, frontmatter_value};

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredSkillFile {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub content: String,
    /// `"claude"` | `"codex"` | `"opencode"`.
    pub tool: String,
    /// `"global"` | `"project"`.
    pub scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    pub source_path: String,
}

fn skill_name(path: &Path, content: &str) -> Option<String> {
    frontmatter_value(content, "name")
        .or_else(|| first_heading(content))
        .or_else(|| {
            path.parent()
                .and_then(|p| p.file_name())
                .map(|n| n.to_string_lossy().to_string())
        })
        .filter(|name| !name.trim().is_empty())
}

fn read_skill(
    path: &Path,
    tool: &str,
    scope: &str,
    root: Option<&str>,
) -> Option<DiscoveredSkillFile> {
    let content = std::fs::read_to_string(path).ok()?;
    let name = skill_name(path, &content)?;
    Some(DiscoveredSkillFile {
        name,
        description: frontmatter_value(&content, "description"),
        content,
        tool: tool.to_string(),
        scope: scope.to_string(),
        root: root.map(str::to_string),
        source_path: path.to_string_lossy().to_string(),
    })
}

fn collect_skill_files(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    if depth > 8 {
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
            collect_skill_files(&path, out, depth + 1);
        } else if meta.is_file()
            && path
                .file_name()
                .map(|name| name.to_string_lossy().eq_ignore_ascii_case("SKILL.md"))
                .unwrap_or(false)
        {
            out.push(path);
        }
    }
}

fn discover_dir(
    dir: &Path,
    tool: &str,
    scope: &str,
    root: Option<&str>,
) -> Vec<DiscoveredSkillFile> {
    let mut paths = Vec::new();
    collect_skill_files(dir, &mut paths, 0);
    paths.sort();
    paths
        .iter()
        .filter_map(|path| read_skill(path, tool, scope, root))
        .collect()
}

#[tauri::command]
pub async fn skills_discover<R: Runtime>(
    app: AppHandle<R>,
    roots: Vec<String>,
    tools: Vec<String>,
) -> Result<Vec<DiscoveredSkillFile>, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("home dir: {e}"))?;
    let want = |t: &str| tools.iter().any(|x| x == t);
    let mut out: Vec<DiscoveredSkillFile> = Vec::new();

    if want("claude") {
        out.extend(discover_dir(
            &home.join(".claude").join("skills"),
            "claude",
            "global",
            None,
        ));
        for root in &roots {
            out.extend(discover_dir(
                &Path::new(root).join(".claude").join("skills"),
                "claude",
                "project",
                Some(root),
            ));
        }
    }

    if want("codex") {
        for dir in [
            home.join(".codex").join("skills"),
            home.join(".agents").join("skills"),
        ] {
            out.extend(discover_dir(&dir, "codex", "global", None));
        }
        for root in &roots {
            for dir in [
                Path::new(root).join(".codex").join("skills"),
                Path::new(root).join(".agents").join("skills"),
            ] {
                out.extend(discover_dir(&dir, "codex", "project", Some(root)));
            }
        }
    }

    if want("opencode") {
        out.extend(discover_dir(
            &home.join(".config").join("opencode").join("skills"),
            "opencode",
            "global",
            None,
        ));
        for root in &roots {
            out.extend(discover_dir(
                &Path::new(root).join(".opencode").join("skills"),
                "opencode",
                "project",
                Some(root),
            ));
        }
    }

    out.sort_by(|a, b| a.source_path.cmp(&b.source_path));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn parses_frontmatter_name_and_description() {
        let dir = tempdir().unwrap();
        let skill_dir = dir.path().join("skills").join("agile-proto");
        std::fs::create_dir_all(&skill_dir).unwrap();
        let path = skill_dir.join("SKILL.md");
        std::fs::write(
            &path,
            "---\nname: \"agile-proto\"\ndescription: Build prototypes\n---\n# Title\nBody",
        )
        .unwrap();

        let got = discover_dir(&dir.path().join("skills"), "codex", "global", None);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "agile-proto");
        assert_eq!(got[0].description.as_deref(), Some("Build prototypes"));
        assert_eq!(got[0].tool, "codex");
        assert_eq!(got[0].scope, "global");
    }

    #[test]
    fn parses_folded_frontmatter_description() {
        let dir = tempdir().unwrap();
        let skill_dir = dir.path().join("skills").join("work-review");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: work-review\ndescription: >\n  Run a strict review\n  before shipping.\nmetadata:\n  short-description: Review\n---\n# Work Review",
        )
        .unwrap();

        let got = discover_dir(&dir.path().join("skills"), "codex", "global", None);
        assert_eq!(
            got[0].description.as_deref(),
            Some("Run a strict review before shipping.")
        );
    }

    #[test]
    fn falls_back_to_parent_directory_name() {
        let dir = tempdir().unwrap();
        let skill_dir = dir.path().join("skills").join("plain");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(skill_dir.join("SKILL.md"), "No frontmatter").unwrap();

        let got = discover_dir(
            &dir.path().join("skills"),
            "claude",
            "project",
            Some("/repo"),
        );
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "plain");
        assert_eq!(got[0].root.as_deref(), Some("/repo"));
    }

    #[test]
    fn recursively_finds_hidden_system_skills_without_following_symlinks() {
        let dir = tempdir().unwrap();
        let nested = dir.path().join("skills").join(".system").join("docs");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("SKILL.md"), "# Docs\nBody").unwrap();

        let got = discover_dir(&dir.path().join("skills"), "codex", "global", None);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "Docs");
    }
}
