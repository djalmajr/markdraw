import { expect, it } from "bun:test";

it("runs the real navigation and tab transition tests in isolation", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", "./src/desktop-tab-actions.vtest.ts"],
    cwd: `${import.meta.dir}/..`,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
  console.log(output);
  expect(result.exitCode).toBe(0);
  expect(output).toContain("2 pass");
  expect(output).toContain("0 fail");
});
