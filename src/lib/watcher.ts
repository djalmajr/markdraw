// Auto-refresh watcher using polling
import { getFileLastModified, resolveFileByPath } from "./fs.ts";

export interface WatchTarget {
  /** The main file handle */
  fileHandle: FileSystemFileHandle;
  /** Additional file paths to watch (includes) */
  includePaths: string[];
  /** Root directory handle for resolving include paths */
  rootHandle: FileSystemDirectoryHandle;
}

export type OnChangeCallback = () => void;

export class FileWatcher {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private lastModifiedMap = new Map<string, number>();
  private target: WatchTarget | null = null;
  private onChange: OnChangeCallback;
  private intervalMs: number;

  constructor(onChange: OnChangeCallback, intervalMs = 2000) {
    this.onChange = onChange;
    this.intervalMs = intervalMs;
  }

  setTarget(target: WatchTarget) {
    this.target = target;
    this.lastModifiedMap.clear();
  }

  start() {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => this.poll(), this.intervalMs);
    // Also poll immediately
    this.poll();
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  get isRunning(): boolean {
    return this.intervalId !== null;
  }

  private async poll() {
    if (!this.target) return;

    let changed = false;

    // Check main file
    try {
      const ts = await getFileLastModified(this.target.fileHandle);
      const key = "__main__";
      const prev = this.lastModifiedMap.get(key);
      if (prev !== undefined && prev !== ts) {
        changed = true;
      }
      this.lastModifiedMap.set(key, ts);
    } catch {
      // File might have been deleted/moved
    }

    // Check include files
    for (const path of this.target.includePaths) {
      try {
        const handle = await resolveFileByPath(this.target.rootHandle, path);
        if (handle) {
          const ts = await getFileLastModified(handle);
          const prev = this.lastModifiedMap.get(path);
          if (prev !== undefined && prev !== ts) {
            changed = true;
          }
          this.lastModifiedMap.set(path, ts);
        }
      } catch {
        // Skip unresolvable includes
      }
    }

    if (changed) {
      this.onChange();
    }
  }

  destroy() {
    this.stop();
    this.target = null;
    this.lastModifiedMap.clear();
  }
}
