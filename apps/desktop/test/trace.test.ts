import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { TraceLogger, newTraceContext } from "../src/trace.js";

it("bounds diagnostic bursts, rotates files, and strips sensitive attributes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-log-"));
  const path = join(directory, "trace.jsonl");
  try {
    await writeFile(path, "x".repeat(5 * 1024 * 1024));
    const logger = new TraceLogger(path);
    for (let index = 0; index < 2000; index++)
      logger.record({
        ...newTraceContext(),
        name: "desktop.poll",
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        attributes: { token: "never-persist", tasks: String(index) },
      });
    await logger.flush();
    const text = await readFile(path, "utf8");
    expect(text).not.toContain("never-persist");
    expect(
      text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .at(-1).attributes.tasks,
    ).toBe("1999");
    expect(logger.dropped).toBeGreaterThan(0);
    expect((await stat(`${path}.1`)).size).toBe(5 * 1024 * 1024);
    expect((await stat(path)).size).toBeLessThan(5 * 1024 * 1024);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("isolates local log write failures from the caller", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-log-failure-"));
  try {
    const logger = new TraceLogger(directory);
    logger.record({
      ...newTraceContext(),
      name: "desktop.poll",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    });
    await expect(logger.flush()).resolves.toBeUndefined();
    expect(logger.dropped).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
