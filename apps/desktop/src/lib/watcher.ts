import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export class FileWatcher {
  private onChange: () => void;
  private unlisten: UnlistenFn | null = null;
  private watchedPaths: string[] = [];
  private running = false;

  constructor(onChange: () => void) {
    this.onChange = onChange;
  }

  setTarget(params: {
    filePath: string;
    includePaths: string[];
    rootPath: string;
  }) {
    const { filePath, includePaths, rootPath } = params;
    this.watchedPaths = [filePath];
    for (const relPath of includePaths) {
      this.watchedPaths.push(`${rootPath}/${relPath}`);
    }
  }

  async start() {
    if (this.running) return;
    this.running = true;

    this.unlisten = await listen("fs-change", () => {
      this.onChange();
    });

    if (this.watchedPaths.length > 0) {
      await invoke("watch_paths", { paths: this.watchedPaths });
    }
  }

  async stop() {
    if (!this.running) return;
    this.running = false;

    if (this.unlisten) {
      this.unlisten();
      this.unlisten = null;
    }

    await invoke("stop_watching");
  }

  async destroy() {
    await this.stop();
    this.watchedPaths = [];
  }
}
