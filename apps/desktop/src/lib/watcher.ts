import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Absolute paths a `fs-change` event names; empty when the payload has none. */
export function eventPaths(payload: unknown): string[] {
  const paths = (payload as { paths?: unknown } | null | undefined)?.paths;
  return Array.isArray(paths) ? paths.filter((p): p is string => typeof p === "string") : [];
}

export class FileWatcher {
  private onChange: (paths: string[]) => void;
  private unlisten: UnlistenFn | null = null;
  private watchedPaths: string[] = [];
  private running = false;
  private generation = 0;
  private ipcQueue = Promise.resolve();
  private latestRequest = 0;

  constructor(onChange: (paths: string[]) => void) {
    this.onChange = onChange;
  }

  setTarget(params: {
    filePath: string;
    includePaths: string[];
    rootPath: string;
  }) {
    const { filePath, includePaths, rootPath } = params;
    const newPaths = [filePath];
    for (const relPath of includePaths) {
      newPaths.push(`${rootPath}/${relPath}`);
    }

    const changed =
      newPaths.length !== this.watchedPaths.length ||
      newPaths.some((p, i) => p !== this.watchedPaths[i]);

    this.watchedPaths = newPaths;

    // A pending registration publishes the latest target once it is ready.
    if (this.unlisten && changed) {
      void this.sendWatchPaths();
    }
  }

  async start() {
    if (this.running) return;
    const generation = ++this.generation;
    this.running = true;

    const unlisten = await listen("fs-change", (event) => {
      if (generation === this.generation) this.onChange(eventPaths(event.payload));
    }).catch((error) => {
      if (generation === this.generation) this.running = false;
      throw error;
    });
    if (generation !== this.generation) {
      await unlisten();
      return;
    }

    this.unlisten = unlisten;
    void this.sendWatchPaths();
  }

  stop() {
    if (!this.running) return this.ipcQueue;
    this.generation++;
    this.running = false;

    if (this.unlisten) {
      this.unlisten();
      this.unlisten = null;
    }

    return this.enqueue(null);
  }

  private sendWatchPaths() {
    if (this.watchedPaths.length > 0) {
      void this.enqueue(this.watchedPaths);
    }
  }

  private enqueue(paths: string[] | null) {
    const request = ++this.latestRequest;
    const operation = this.ipcQueue.then(async () => {
      // Skip superseded requests that have not reached the backend yet.
      if (request !== this.latestRequest) return;
      if (paths) {
        await invoke("watch_paths", { paths });
      } else {
        await invoke("stop_watching");
      }
    });
    this.ipcQueue = operation.catch(() => undefined);
    return operation;
  }

  destroy() {
    this.watchedPaths = [];
    return this.running ? this.stop() : this.enqueue(null);
  }
}
