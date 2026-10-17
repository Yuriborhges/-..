import { expect, it, vi } from "vitest";

import { captureProcessScenario } from "../../src/process/capture/ProcessHarness.js";
import { parseProcessScenario } from "../../src/domain/process/processScenario.js";
import { emptyProcessCapture } from "../../src/domain/process/processCapture.fixture.js";

const control = vi.hoisted(() => ({
  abortPath: undefined as string | undefined,
  controller: undefined as AbortController | undefined,
}));

const launch = vi.hoisted(() => ({ calls: 0 }));

/**
 * Intercept the native PTY launch. The launch decision is what this regression
 * covers; no target process may be created, so the sentinel throws before any
 * child exists.
 */
vi.mock("@lydell/node-pty", () => ({
  spawn: () => {
    launch.calls += 1;
    throw new Error("PTY launch sentinel: a target would have been started");
  },
}));

/**
 * Abort during the descriptor close that ends executable sampling. Real
 * `open`/`stat`/`close` still run, so the sampler's completed digest stays
 * genuine; only the cancellation schedule is injected.
 */
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      const handle = await original.open(...args);
      if (control.abortPath === undefined || args[0] !== control.abortPath)
        return handle;
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        control.controller?.abort();
      };
      return handle;
    },
  };
});

it("does not launch the target when cancellation lands during executable sampling", async () => {
  const controller = new AbortController();
  control.abortPath = process.execPath;
  control.controller = controller;
  launch.calls = 0;
  try {
    const result = await captureProcessScenario(
      parseProcessScenario({
        executable: process.execPath,
        arguments: ["--eval", "process.exit(0)"],
        working_directory: process.cwd(),
        timeout_ms: 5_000,
        idle_timeout_ms: 5_000,
        settle_ms: 0,
      }),
      controller.signal,
      // The portable startup logic is platform-independent; the controlled
      // Linux platform keeps the harness's own admission gate out of the way.
      "linux",
      {},
      async () => ({
        files: [],
        truncated: false,
        completeRoots: [],
        coverage: emptyProcessCapture().truncation_details.filesystem_before,
      }),
    );
    expect(launch.calls).toBe(0);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected cancellation");
    expect(result.error).toMatchObject({ reason: "cancelled" });
  } finally {
    control.abortPath = undefined;
    control.controller = undefined;
  }
});

it("still launches when executable sampling completes without cancellation", async () => {
  control.abortPath = undefined;
  launch.calls = 0;
  const result = await captureProcessScenario(
    parseProcessScenario({
      executable: process.execPath,
      arguments: ["--eval", "process.exit(0)"],
      working_directory: process.cwd(),
      timeout_ms: 5_000,
      idle_timeout_ms: 5_000,
      settle_ms: 0,
    }),
    undefined,
    "linux",
    {},
    async () => ({
      files: [],
      truncated: false,
      completeRoots: [],
      coverage: emptyProcessCapture().truncation_details.filesystem_before,
    }),
  );
  expect(launch.calls).toBe(1);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected the launch sentinel failure");
  expect(String(result.error.cause)).toContain("PTY launch sentinel");
});
