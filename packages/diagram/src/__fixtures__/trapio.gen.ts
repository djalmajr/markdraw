// Headless CLI harness — the static-docs use case (the Trapio prototype's
// original job). Builds the trapio spec through the SAME pipeline the app uses,
// applies the validation gate, and writes a committed `.excalidraw` artifact.
// The only environment-specific code in the package lives here: node:fs +
// import.meta.dir. Run: `bun run gen:trapio` (from packages/diagram).

import { mkdirSync, writeFileSync } from "node:fs";
import { generateToFile } from "../generate.ts";
import { formatReport } from "../validate.ts";
import { trapioSpec } from "./trapio.spec.ts";

const result = generateToFile(trapioSpec, { gate: true, serialize: { source: "asciimark/diagram", pretty: true } });

if (!result.ok) {
  console.error("✗ diagram failed the gate:\n" + result.issues.join("\n"));
  process.exit(1);
}

const out = `${import.meta.dir}/trapio-architecture.excalidraw`;
mkdirSync(import.meta.dir, { recursive: true });
writeFileSync(out, result.content);
console.log(`escrito: ${out}`);
console.log(formatReport(result.report));
