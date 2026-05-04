// Approval / golden-master testing of the markdown pipeline. Each input
// in `inputs/*.md` is rendered and compared byte-for-byte against the
// committed `outputs/*.html`. Whitespace, attribute order, anchor IDs —
// every detail of the rendered HTML is locked. Diff anywhere = failure.
//
// To regenerate after an intentional change:
//   APPROVE=1 bun test packages/core/src/__golden__
//
// The reviewer should diff `outputs/` in the resulting commit to confirm
// the change was intended.
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { convertMarkdown } from "../markdown.ts";

const INPUTS_DIR = join(import.meta.dir, "inputs");
const OUTPUTS_DIR = join(import.meta.dir, "outputs");

const noopRead = async () => null;
const APPROVE = process.env.APPROVE === "1";

const inputFiles = readdirSync(INPUTS_DIR)
  .filter((f) => f.endsWith(".md"))
  .sort();

describe("golden-master: convertMarkdown", () => {
  for (const file of inputFiles) {
    it(`matches output/${file.replace(/\.md$/, ".html")}`, async () => {
      const input = readFileSync(join(INPUTS_DIR, file), "utf8");
      const { html } = await convertMarkdown({
        filePath: file,
        fileContent: input,
        readFile: noopRead,
      });
      const goldenPath = join(OUTPUTS_DIR, file.replace(/\.md$/, ".html"));

      if (APPROVE) {
        writeFileSync(goldenPath, html);
        return;
      }

      let golden: string;
      try {
        golden = readFileSync(goldenPath, "utf8");
      } catch {
        throw new Error(
          `Missing golden file: ${goldenPath}. Re-run with APPROVE=1 to create it.`,
        );
      }
      expect(html).toBe(golden);
    });
  }
});
