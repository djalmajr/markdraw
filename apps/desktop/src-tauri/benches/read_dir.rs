// Performance bench for read_dir_recursive with shapes that approximate
// real workspaces:
//   * flat_500    — single directory, 500 files (small note vault)
//   * flat_5k     — 5,000 files in one dir (Obsidian-class vault)
//   * flat_25k    — stress: 25,000 files in one dir (catches O(n²) regressions)
//   * deep_50     — 50 levels deep, 1 file each (tail-recursion pressure)
//   * wide_balanced_3x4   — 3 children per dir, depth 4, 3 files/dir (~360 files)
//   * wide_balanced_8x4   — 8 children per dir, depth 4, 5 files/dir (~25k files)
//   * monorepo_like       — mixed: 200 files at root, 30 subdirs × 100 files +
//                            node_modules (10k files, must be skipped)
//   * hidden_off vs hidden_on — same tree, both flag values, validates the
//     filter cost is acceptable
//
// Trees are built once per process (LazyLock) and reused across iterations
// — bench timing measures `read_dir_recursive`, not `mkdir`.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use markdraw_lib::read_dir_recursive;
use tempfile::TempDir;

// ─── Tree builders ──────────────────────────────────────────────────────────

fn build_flat(root: &Path, file_count: usize) {
    fs::create_dir_all(root).unwrap();
    for i in 0..file_count {
        fs::write(
            root.join(format!("note-{i:06}.md")),
            b"# bench\nbody line\n",
        )
        .unwrap();
    }
}

fn build_balanced(root: &Path, breadth: usize, depth: usize, files_per_dir: usize) {
    fs::create_dir_all(root).unwrap();
    for i in 0..files_per_dir {
        fs::write(root.join(format!("file-{i}.md")), b"# bench\n").unwrap();
    }
    if depth == 0 {
        return;
    }
    for i in 0..breadth {
        let sub = root.join(format!("dir-{i}"));
        build_balanced(&sub, breadth, depth - 1, files_per_dir);
    }
}

fn build_deep_chain(root: &Path, depth: usize) {
    fs::create_dir_all(root).unwrap();
    let mut path = root.to_path_buf();
    fs::write(path.join("leaf.md"), b"# top\n").unwrap();
    for level in 0..depth {
        path = path.join(format!("level-{level}"));
        fs::create_dir(&path).unwrap();
        fs::write(path.join("leaf.md"), b"# leaf\n").unwrap();
    }
}

/// 200 files at root + 30 subdirs (100 files each) + a fat `node_modules`
/// (must be filtered) + `.git` (filtered when hidden flag is off).
fn build_monorepo_like(root: &Path) {
    fs::create_dir_all(root).unwrap();
    for i in 0..200 {
        fs::write(root.join(format!("doc-{i:04}.md")), b"# top\n").unwrap();
    }
    for s in 0..30 {
        let sub = root.join(format!("section-{s:02}"));
        fs::create_dir(&sub).unwrap();
        for i in 0..100 {
            fs::write(sub.join(format!("note-{i:04}.md")), b"# section\n").unwrap();
        }
    }
    // The thing the IGNORED_DIRS filter MUST skip — 10k files.
    let nm = root.join("node_modules");
    fs::create_dir(&nm).unwrap();
    for i in 0..10_000 {
        fs::write(nm.join(format!("pkg-{i:05}.json")), b"{}\n").unwrap();
    }
    // Hidden tooling dir.
    let git = root.join(".git");
    fs::create_dir(&git).unwrap();
    fs::write(git.join("HEAD"), b"ref: refs/heads/main\n").unwrap();
    for i in 0..50 {
        fs::write(git.join(format!("obj-{i}.bin")), b"blob\n").unwrap();
    }
}

// ─── Static fixtures (built once) ───────────────────────────────────────────

struct Fixture {
    _dir: TempDir,
    path: PathBuf,
    file_count: u64,
}

fn make_flat(file_count: usize) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_path_buf();
    build_flat(&path, file_count);
    Fixture {
        _dir: dir,
        path,
        file_count: file_count as u64,
    }
}

fn make_balanced(breadth: usize, depth: usize, files_per_dir: usize) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_path_buf();
    build_balanced(&path, breadth, depth, files_per_dir);
    // Total files = files_per_dir * (breadth^0 + breadth^1 + ... + breadth^depth)
    let mut total = 0u64;
    let mut level_count = 1u64;
    for _ in 0..=depth {
        total += level_count * files_per_dir as u64;
        level_count *= breadth as u64;
    }
    Fixture {
        _dir: dir,
        path,
        file_count: total,
    }
}

fn make_deep(depth: usize) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_path_buf();
    build_deep_chain(&path, depth);
    Fixture {
        _dir: dir,
        path,
        file_count: depth as u64 + 1,
    }
}

fn make_monorepo() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_path_buf();
    build_monorepo_like(&path);
    // Visible files when hidden=false: 200 root + 30*100 = 3,200.
    // node_modules (10k) and .git (51) skipped.
    Fixture {
        _dir: dir,
        path,
        file_count: 3_200,
    }
}

static FLAT_500: LazyLock<Fixture> = LazyLock::new(|| make_flat(500));
static FLAT_5K: LazyLock<Fixture> = LazyLock::new(|| make_flat(5_000));
static FLAT_25K: LazyLock<Fixture> = LazyLock::new(|| make_flat(25_000));
static DEEP_50: LazyLock<Fixture> = LazyLock::new(|| make_deep(50));
static WIDE_3X4: LazyLock<Fixture> = LazyLock::new(|| make_balanced(3, 4, 3));
static WIDE_8X4: LazyLock<Fixture> = LazyLock::new(|| make_balanced(8, 4, 5));
static MONOREPO: LazyLock<Fixture> = LazyLock::new(make_monorepo);

// ─── Bench groups ───────────────────────────────────────────────────────────

fn bench_flat(c: &mut Criterion) {
    let mut group = c.benchmark_group("read_dir/flat");
    for fx in [&*FLAT_500, &*FLAT_5K, &*FLAT_25K] {
        group.throughput(Throughput::Elements(fx.file_count));
        group.bench_with_input(
            BenchmarkId::from_parameter(fx.file_count),
            &fx.path,
            |b, path| b.iter(|| read_dir_recursive(path, path, false, None).unwrap()),
        );
    }
    group.finish();
}

fn bench_shapes(c: &mut Criterion) {
    let mut group = c.benchmark_group("read_dir/shapes");
    for (name, fx) in [
        ("deep_50", &*DEEP_50),
        ("wide_3x4", &*WIDE_3X4),
        ("wide_8x4", &*WIDE_8X4),
    ] {
        group.throughput(Throughput::Elements(fx.file_count));
        group.bench_with_input(BenchmarkId::from_parameter(name), &fx.path, |b, path| {
            b.iter(|| read_dir_recursive(path, path, false, None).unwrap())
        });
    }
    group.finish();
}

fn bench_filters(c: &mut Criterion) {
    let mut group = c.benchmark_group("read_dir/filters");
    let fx = &*MONOREPO;
    group.throughput(Throughput::Elements(fx.file_count));
    group.bench_function("monorepo_hidden_off", |b| {
        b.iter(|| read_dir_recursive(&fx.path, &fx.path, false, None).unwrap())
    });
    group.bench_function("monorepo_hidden_on", |b| {
        b.iter(|| read_dir_recursive(&fx.path, &fx.path, true, None).unwrap())
    });
    group.finish();
}

criterion_group! {
    name = benches;
    // Configure for stability on large fixtures: longer warm-up so the OS
    // page cache is hot, fewer samples on the heaviest cases (auto-scaled
    // by criterion based on measurement_time).
    config = Criterion::default()
        .warm_up_time(std::time::Duration::from_secs(2))
        .measurement_time(std::time::Duration::from_secs(5));
    targets = bench_flat, bench_shapes, bench_filters
}
criterion_main!(benches);
