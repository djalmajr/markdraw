import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export class FileWatcher {
  private onChange: () => void;
  private unlisten: UnlistenFn | null = null;
  private watchedPaths: string[] = [];
  private running = false;
  private generation = 0;

  constructor(onChange: () => void) {
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

    const unlisten = await listen("fs-change", () => {
      if (generation === this.generation) this.onChange();
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

  async stop() {
    if (!this.running) return;
    this.generation++;
    this.running = false;

    if (this.unlisten) {
      this.unlisten();
      this.unlisten = null;
    }

    await invoke("stop_watching");
  }

  private async sendWatchPaths() {
    if (this.watchedPaths.length > 0) {
      await invoke("watch_paths", { paths: this.watchedPaths });
    }
  }

  async destroy() {
    this.watchedPaths = [];
    await this.stop();
  }
}
