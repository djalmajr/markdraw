use super::*;
const READ_BYTES: usize = 1_048_576;
use crate::mcp_server::RootInput;
use std::fs;
struct Fixture {
    dir: tempfile::TempDir,
    registry: Registry,
    id: String,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
        let registry = Registry::default();
        registry
            .replace(vec![RootInput {
                name: "notes".into(),
                path: dir.path().canonicalize().unwrap(),
            }])
            .unwrap();
        let id = registry.list().unwrap()["roots"][0]["id"]
            .as_str()
            .unwrap()
            .into();
        Self { dir, registry, id }
    }
    fn call(&self, method: &str, mut args: Value) -> Result<Value> {
        args["root_id"] = json!(self.id);
        self.registry.disk(method, args)
    }
    fn write(&self, path: &str, text: impl AsRef<[u8]>) {
        fs::write(self.dir.path().join(path), text).unwrap();
    }
}
#[test]
fn boundaries_errors_and_identity() {
    let f = Fixture::new();
    f.write("a.md", "hello\nworld");
    assert_eq!(
        f.call("read_file", json!({"path":"a.md"})).unwrap()["content"],
        "hello\nworld"
    );
    for path in [
        "",
        "..",
        "../outside",
        "/etc/passwd",
        "a/../b",
        "a//b",
        "a/",
        "C:\\notes",
        "C:notes",
        "\\\\server\\share",
        "a\0b",
        "./a",
    ] {
        assert_eq!(
            f.call("read_file", json!({"path":path})).unwrap_err(),
            "not allowed",
            "{path:?}"
        );
    }
    assert_eq!(
        f.call("list_files", json!({"path":""})).unwrap_err(),
        "not allowed"
    );
    assert_eq!(
        f.call("read_file", json!({"path":"missing"})).unwrap_err(),
        "not found"
    );
    assert_eq!(
        f.call("read_file", json!({"path":"a.md","start_line":0}))
            .unwrap_err(),
        "invalid arguments"
    );
    for bytes in [vec![0, b'a'], vec![255], vec![b'a', b'\n', 255]] {
        f.write("bad", bytes);
        assert_eq!(
            f.call("read_file", json!({"path":"bad"})).unwrap_err(),
            "not a text file"
        );
    }
    for query in [String::new(), "q".repeat(crate::mcp_server::MAX_FRAME + 1)] {
        assert_eq!(
            f.call("search_workspace", json!({"query":query}))
                .unwrap_err(),
            "invalid arguments"
        );
    }
    assert_eq!(
        f.call("list_files", json!({"cursor":"forged"}))
            .unwrap_err(),
        "invalid cursor"
    );
    let other = Fixture::new();
    assert_eq!(
        other
            .registry
            .disk("read_file", json!({"root_id":f.id,"path":"a.md"}))
            .unwrap_err(),
        "root closed"
    );
    f.registry.replace(vec![]).unwrap();
    assert_eq!(
        f.call("read_file", json!({"path":"a.md"})).unwrap_err(),
        "root closed"
    );
}
#[test]
fn exact_line_and_byte_limits_ranges_and_utf8() {
    let f = Fixture::new();
    for count in [2000, 2001] {
        f.write("lines", vec!["x"; count].join("\n"));
        let r = f.call("read_file", json!({"path":"lines"})).unwrap();
        assert_eq!(r["total_lines"], count);
        assert_eq!(r["end_line"], 2000);
        assert_eq!(r["truncated"], count > 2000);
    }
    let r = f
        .call(
            "read_file",
            json!({"path":"lines","start_line":2000,"end_line":2001}),
        )
        .unwrap();
    assert_eq!(r["content"], "x\nx");
    assert_eq!(r["truncated"], false);
    for size in [READ_BYTES, READ_BYTES + 1] {
        f.write("large", "x".repeat(size));
        let r = f.call("read_file", json!({"path":"large"})).unwrap();
        assert_eq!(r["content"].as_str().unwrap().len(), READ_BYTES);
        assert_eq!(r["truncated"], size > READ_BYTES);
    }
    f.write("unicode", format!("{}é", "x".repeat(READ_BYTES - 1)));
    let r = f.call("read_file", json!({"path":"unicode"})).unwrap();
    assert!(r["content"].as_str().unwrap().len() <= READ_BYTES);
    assert_eq!(r["truncated"], true);
    f.write("empty", "");
    let r = f.call("read_file", json!({"path":"empty"})).unwrap();
    assert_eq!(r["total_lines"], 0);
}
#[test]
fn pagination_exact_pages_and_cursor_lifetime() {
    for count in [500, 501] {
        let f = Fixture::new();
        for i in 0..count {
            f.write(&format!("{i}.md"), "hit");
        }
        let r = f.call("list_files", json!({})).unwrap();
        assert_eq!(r["entries"].as_array().unwrap().len(), 500);
        assert_eq!(r.get("next_cursor").is_some(), count > 500);
        if count > 500 {
            let token = r["next_cursor"].clone();
            let next = f.call("list_files", json!({"cursor":token})).unwrap();
            assert_eq!(next["entries"].as_array().unwrap().len(), 1);
            assert!(next.get("next_cursor").is_none());
            let r = f.call("list_files", json!({})).unwrap();
            let token = r["next_cursor"].clone();
            f.registry.replace(vec![]).unwrap();
            f.registry
                .replace(vec![RootInput {
                    name: "notes".into(),
                    path: f.dir.path().canonicalize().unwrap(),
                }])
                .unwrap();
            let id = f.registry.list().unwrap()["roots"][0]["id"].clone();
            assert_eq!(
                f.registry
                    .disk("list_files", json!({"root_id":id,"cursor":token}))
                    .unwrap_err(),
                "invalid cursor"
            );
        }
    }
    for count in [200, 201, 400, 401] {
        let f = Fixture::new();
        f.write("a", vec!["hit"; count].join("\n"));
        let mut seen = 0;
        let mut cursor = None;
        loop {
            let mut a = json!({"query":"hit"});
            if let Some(token) = cursor {
                a["cursor"] = token;
            }
            let r = f.call("search_workspace", a).unwrap();
            let m = r["matches"].as_array().unwrap();
            assert!(m.len() <= 200);
            for hit in m {
                seen += 1;
                assert_eq!(hit["line"], seen);
            }
            cursor = r.get("next_cursor").cloned();
            assert_eq!(cursor.is_some(), seen < count);
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(seen, count);
    }
}
#[test]
fn secrets_names_search_filters_and_fixed_errors() {
    let f = Fixture::new();
    let secret = "sk-aaaaaaaaaaaaaaaaaaaa";
    f.write(&format!("{secret}.md"),format!("hit {secret}\n-----BEGIN PRIVATE KEY-----\nhit private-material\n-----END PRIVATE KEY-----\nhit {}", "é".repeat(600)));
    let list = f.call("list_files", json!({})).unwrap();
    assert_eq!(list["entries"][0]["name"], "[secret].md");
    assert!(!list.to_string().contains(secret));
    let read = f
        .call(
            "read_file",
            json!({"path":format!("{secret}.md"),"start_line":3,"end_line":3}),
        )
        .unwrap();
    assert!(!read.to_string().contains("private-material"));
    let read = f
        .call("read_file", json!({"path":format!("{secret}.md")}))
        .unwrap();
    assert!(!read.to_string().contains(secret));
    assert!(!read.to_string().contains("private-material"));
    for dir in crate::ALWAYS_IGNORED_DIRS
        .iter()
        .chain(crate::HIDDEN_TOOL_DIRS)
    {
        fs::create_dir(f.dir.path().join(dir)).unwrap();
        f.write(&format!("{dir}/a"), "hit ignored");
    }
    f.write(".hidden", "hit ignored");
    f.write("binary", [b'h', b'i', b't', 0]);
    f.write(
        "big",
        vec![b'x'; crate::FIND_IN_FILES_FILE_SIZE_LIMIT as usize + 1],
    );
    let search = f.call("search_workspace", json!({"query":"hit"})).unwrap();
    let hits = search["matches"].as_array().unwrap();
    assert_eq!(hits.len(), 2);
    for hit in hits {
        assert!(!hit.to_string().contains(secret));
        assert!(!hit.to_string().contains("private-material"));
        assert!(hit["text"].as_str().unwrap().chars().count() <= 500);
    }
    assert_eq!(
        f.call("search_workspace", json!({"query":"HIT"})).unwrap()["matches"],
        json!([])
    );
    assert!(!f
        .call("read_file", json!({"path":"absent"}))
        .unwrap_err()
        .contains(f.dir.path().to_str().unwrap()));
    f.write(
        "multi",
        "token\n=\nabcdefghijklmnop\nBearer\nabcdefghijklmnop",
    );
    let r = f
        .call("read_file", json!({"path":"multi","start_line":3}))
        .unwrap();
    assert!(!r.to_string().contains("abcdefghijklmnop"));
}
#[cfg(unix)]
#[test]
fn symlinks_special_files_and_directory_swap_are_confined() {
    use std::ffi::CString;
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let outside = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
    fs::write(outside.path().join("secret"), "OUTSIDE").unwrap();
    symlink(outside.path(), f.dir.path().join("link")).unwrap();
    symlink(f.dir.path(), f.dir.path().join("inside")).unwrap();
    symlink("/dev/zero", f.dir.path().join("zero")).unwrap();
    for path in ["link/secret", "inside/secret", "zero"] {
        assert!(f.call("read_file", json!({"path":path})).is_err());
    }
    let fifo = CString::new(f.dir.path().join("fifo").as_os_str().as_encoded_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    let started = Instant::now();
    assert!(f.call("read_file", json!({"path":"fifo"})).is_err());
    assert!(started.elapsed() < Duration::from_secs(1));
    let _socket = std::os::unix::net::UnixListener::bind(f.dir.path().join("socket")).unwrap();
    assert!(f.call("read_file", json!({"path":"socket"})).is_err());
    fs::create_dir(f.dir.path().join("dir")).unwrap();
    f.write("dir/secret", "INSIDE");
    let root = confined::root(&f.dir.path().canonicalize().unwrap()).unwrap();
    let pinned = confined::child(&root, "dir").unwrap();
    // Interleave replacement exactly after opening the intermediate handle,
    // before opening the final component relative to it.
    fs::rename(f.dir.path().join("dir"), f.dir.path().join("old")).unwrap();
    symlink(outside.path(), f.dir.path().join("dir")).unwrap();
    use std::io::Read;
    let mut text = String::new();
    confined::child(&pinned, "secret")
        .unwrap()
        .read_to_string(&mut text)
        .unwrap();
    assert_eq!(text, "INSIDE");
    assert!(f.call("read_file", json!({"path":"dir/secret"})).is_err());
}
#[test]
fn deadlines_do_not_return_unbounded_work() {
    let f = Fixture::new();
    f.write("a", "hit");
    let root = confined::root(&f.dir.path().canonicalize().unwrap()).unwrap();
    assert_eq!(
        f.registry
            .search(
                &root,
                SearchArgs {
                    root_id: f.id.clone(),
                    query: "hit".into(),
                    cursor: None
                },
                Instant::now() - Duration::from_secs(1)
            )
            .unwrap_err(),
        "timed out"
    );
    assert_eq!(
        read_file(
            &root,
            ReadArgs {
                _root_id: f.id.clone(),
                path: "a".into(),
                start_line: None,
                end_line: None
            },
            Instant::now() - Duration::from_secs(1)
        )
        .unwrap_err(),
        "timed out"
    );
}

#[test]
fn traversal_cannot_read_a_sibling_and_full_reads_preserve_newlines() {
    let f = Fixture::new();
    let outside = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
    fs::write(outside.path().join("secret"), "OUTSIDE").unwrap();
    let escape = format!(
        "../{}/secret",
        outside.path().file_name().unwrap().to_str().unwrap()
    );
    assert_eq!(
        f.call("read_file", json!({"path":escape})).unwrap_err(),
        "not allowed"
    );
    f.write("a", "first\r\nsecond\n");
    let r = f.call("read_file", json!({"path":"a"})).unwrap();
    assert_eq!(r["content"], "first\r\nsecond\n");
    assert_eq!(r["total_lines"], 2);
    f.write(
        "invalid-tail",
        [vec![b'x'; READ_BYTES + 100], vec![255]].concat(),
    );
    assert_eq!(
        f.call("read_file", json!({"path":"invalid-tail"}))
            .unwrap_err(),
        "not a text file"
    );
}

#[test]
fn huge_text_and_json_escaping_are_bounded() {
    use std::io::Write;
    let f = Fixture::new();
    let mut file = fs::File::create(f.dir.path().join("huge")).unwrap();
    let block = vec![b'x'; READ_BYTES];
    for _ in 0..64 {
        file.write_all(&block).unwrap();
    }
    drop(file);
    let r = f.call("read_file", json!({"path":"huge"})).unwrap();
    assert_eq!(r["content"].as_str().unwrap().len(), READ_BYTES);
    assert_eq!(r["truncated"], true);
    assert_eq!(r["total_lines"], 1);
    f.write("escaped", vec![1; READ_BYTES]);
    let r = f.call("read_file", json!({"path":"escaped"})).unwrap();
    assert!(serde_json::to_vec(&r).unwrap().len() < crate::mcp_server::MAX_RESPONSE - 128);
    assert_eq!(r["truncated"], true);
}

#[test]
fn multiline_assignment_prelude_never_leaks_across_requested_range() {
    let f = Fixture::new();
    f.write("a", "token\n: \"\nabcdefghijklmnop\"\nordinary");
    let r = f
        .call("read_file", json!({"path":"a","start_line":3,"end_line":3}))
        .unwrap();
    assert!(!r["content"].as_str().unwrap().contains("abcdefghijklmnop"));
    assert!(r["content"].as_str().unwrap().contains("[secret]"));
    let r = f
        .call("search_workspace", json!({"query":"abcdefghijklmnop"}))
        .unwrap();
    assert_eq!(r["matches"], json!([]));
    let visible = f
        .call("search_workspace", json!({"query":"ordinary"}))
        .unwrap();
    assert_eq!(visible["matches"][0]["line"], 4);
    let r = f
        .call("read_file", json!({"path":"a","start_line":4}))
        .unwrap();
    assert_eq!(r["content"], "ordinary");
}

#[test]
fn ordinary_keywords_and_short_assignments_remain_literal() {
    let f = Fixture::new();
    let input = "literal token\nordinary\ntoken\n: \"\nshort\"\nBearer\nshort";
    f.write("a", input);
    assert_eq!(
        f.call("read_file", json!({"path":"a"})).unwrap()["content"],
        input
    );
}

#[test]
fn amendment_all_patterns_hide_every_value_character_across_output_boundaries() {
    let payload = "ZQXJZQXJZQXJZQXJZQXJZQXJZQXJZQXJ";
    let cases = [
        ("openai", format!("sk-{payload}"), None),
        ("github", format!("ghp_{payload}"), None),
        ("slack", format!("xoxb-{payload}"), None),
        ("google", format!("AIza{payload}"), None),
        ("aws", format!("AKIA{}", &payload[..16]), None),
        (
            "bearer",
            format!("Bearer {payload}"),
            Some(format!("Bearer\n{payload}")),
        ),
        (
            "assignment",
            format!("api_key = \"{payload}\""),
            Some(format!("api_key\n=\n\"{payload}\"")),
        ),
        (
            "pem",
            format!("-----BEGIN PRIVATE KEY-----\n{payload}\n{payload}\n-----END PRIVATE KEY-----"),
            None,
        ),
        (
            "incomplete-pem",
            format!("-----BEGIN PRIVATE KEY-----\n{payload}\n{payload}"),
            None,
        ),
    ];
    // These four uppercase characters occur ONLY in the secret values, never
    // in a filename, marker, keyword or padding. Checking each character is
    // stronger than checking only a complete token or a long substring.
    let assert_hidden = |value: &Value, case: &str, boundary: &str| {
        for ch in ['Z', 'Q', 'X', 'J'] {
            assert!(
                !value.to_string().contains(ch),
                "{case}/{boundary}: leaked value character {ch}"
            );
        }
    };
    for (name, inline, multiline) in cases {
        let f = Fixture::new();
        let span = multiline.as_deref().unwrap_or(&inline);
        let span = if !span.contains('\n') {
            format!("{span}\n{span}")
        } else {
            span.to_owned()
        };
        f.write("a", format!("{}{span}\nvisible", "visible\n".repeat(1999)));
        let first = f.call("read_file", json!({"path":"a"})).unwrap();
        assert_hidden(&first, name, "read-first-page");
        assert_eq!(first["truncated"], true);
        assert!(first["content"].as_str().unwrap().starts_with("visible\n"));
        let next = f
            .call("read_file", json!({"path":"a","start_line":2001}))
            .unwrap();
        assert_hidden(&next, name, "read-second-page");
        let line = f
            .call(
                "read_file",
                json!({"path":"a","start_line":2001,"end_line":2001}),
            )
            .unwrap();
        assert_hidden(&line, name, "read-single-line-range");

        let searchable = span
            .lines()
            .map(|line| format!(" {line}\n"))
            .collect::<String>();
        f.write(
            "a",
            format!("{}{searchable}visible ", "visible \n".repeat(201)),
        );
        let mut cursor = None;
        let mut pages = 0;
        let mut seen = 0;
        loop {
            let mut args = json!({"query":" "});
            if let Some(token) = cursor {
                args["cursor"] = token;
            }
            let result = f.call("search_workspace", args).unwrap();
            assert_hidden(&result, name, "search-pages");
            let hits = result["matches"].as_array().unwrap();
            if pages == 0 {
                assert_eq!(hits.len(), 200);
                assert!(result.get("next_cursor").is_some());
            }
            seen += hits.len();
            pages += 1;
            cursor = result.get("next_cursor").cloned();
            if cursor.is_none() {
                break;
            }
        }
        assert!(pages >= 2 && seen > 200);
        let by_value = f.call("search_workspace", json!({"query":"ZQXJ"})).unwrap();
        assert!(by_value["matches"].as_array().unwrap().is_empty());
        assert_hidden(&by_value, name, "search-value-query");

        // Position the first value character at column 498: cutting raw text
        // to 500 before masking would leak two characters of every value.
        let cut500 = inline
            .lines()
            .map(|line| {
                let value_start = line.find("ZQXJ").unwrap_or(0);
                format!("visible {} {line}\n", "p".repeat(498 - 9 - value_start))
            })
            .collect::<String>();
        f.write("a", cut500);
        let result = f
            .call("search_workspace", json!({"query":"visible"}))
            .unwrap();
        assert_hidden(&result, name, "search-500-character-cut");
        assert!(!result["matches"].as_array().unwrap().is_empty());
        for hit in result["matches"].as_array().unwrap() {
            assert!(hit["text"].as_str().unwrap().chars().count() <= 500);
        }

        // Cross the raw retained-line boundary with only SIX value bytes in
        // the prefix. The full regex minimum must not expose a partial token.
        for (continuation, byte_source) in std::iter::once((false, inline.as_str()))
            .chain(multiline.as_deref().map(|value| (true, value)))
        {
            let cut_bytes = byte_source
                .lines()
                .enumerate()
                .map(|(index, line)| {
                    if continuation && index > 0 {
                        if let Some(start) = line.find("ZQXJ") {
                            format!("{}{line}\n", " ".repeat(READ_BYTES - 6 - start))
                        } else {
                            format!(" {line}\n")
                        }
                    } else if let Some(start) = line.find("ZQXJ") {
                        format!(
                            "visible {} {line}\n",
                            "p".repeat(READ_BYTES - 6 - 9 - start)
                        )
                    } else {
                        format!("visible {line}\n")
                    }
                })
                .collect::<String>();
            f.write("a", cut_bytes);
            let mut args = json!({"path":"a"});
            if continuation {
                // Select the value line alone: an earlier intro must still
                // affect masking, and its bytes cannot consume the output cap.
                args["start_line"] = json!(
                    byte_source
                        .lines()
                        .position(|line| line.contains("ZQXJ"))
                        .unwrap()
                        + 1
                );
            }
            let result = f.call("read_file", args).unwrap();
            assert_hidden(&result, name, "read-one-MiB-cut");
            assert_eq!(result["truncated"], true);
            let content = result["content"].as_str().unwrap();
            assert!(!content.is_empty());
            if continuation {
                assert!(content.starts_with(' '));
            } else {
                assert!(content.starts_with("visible "));
            }
        }
    }
}

#[test]
fn amendment_unc_roots_are_rejected_by_every_disk_tool() {
    let registry = Registry::default();
    registry
        .replace(vec![RootInput {
            name: "unc".into(),
            path: std::path::PathBuf::from("//server/share"),
        }])
        .unwrap();
    let id = registry.list().unwrap()["roots"][0]["id"].clone();
    for (method, mut arguments) in [
        ("list_files", json!({})),
        ("read_file", json!({"path":"a"})),
        ("search_workspace", json!({"query":"a"})),
    ] {
        arguments["root_id"] = id.clone();
        assert_eq!(
            registry.disk(method, arguments).unwrap_err(),
            "root not supported",
            "{method}"
        );
    }
}

#[test]
fn security_fix_incomplete_pem_metadata() {
    let f = Fixture::new();
    for name in [
        "-----BEGIN PRIVATE KEY-----CANARY.md",
        "-----BEGIN RSA PRIVATE KEY-----CANARY-----END RSA PRIVATE KEY-----.md",
    ] {
        f.write(name, "ordinary text");
    }
    let listed = f.call("list_files", json!({})).unwrap();
    assert!(!listed.to_string().contains("CANARY"), "{listed}");
    let searched = f
        .call("search_workspace", json!({"query":"ordinary"}))
        .unwrap();
    assert_eq!(searched["matches"].as_array().unwrap().len(), 2);
    assert!(!searched.to_string().contains("CANARY"), "{searched}");
    f.registry
        .replace(vec![RootInput {
            name: "-----BEGIN PRIVATE KEY-----CANARY".into(),
            path: f.dir.path().canonicalize().unwrap(),
        }])
        .unwrap();
    assert_eq!(f.registry.list().unwrap()["roots"][0]["name"], "[secret]");
}

#[test]
fn security_fix_search_matches_only_redacted_text() {
    let f = Fixture::new();
    f.write("note.md", "ordinary sk-abcdefghijklmnopqrst\n-----BEGIN PRIVATE KEY-----\nHIDDENPEMVALUE\n-----END PRIVATE KEY-----\nordinary control");
    for query in ["abcdefghijkl", "HIDDENPEMVALUE", "PRIVATE KEY"] {
        let result = f.call("search_workspace", json!({"query":query})).unwrap();
        assert_eq!(result["matches"], json!([]), "{query}: {result}");
    }
    let result = f
        .call("search_workspace", json!({"query":"ordinary"}))
        .unwrap();
    assert_eq!(result["matches"].as_array().unwrap().len(), 2);
    assert_eq!(result["matches"][0]["text"], "ordinary [secret]");
    assert_eq!(result["matches"][1]["text"], "ordinary control");
}
