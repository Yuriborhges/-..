import { expect, it, onTestFinished, vi } from "vitest";
import { writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactFileCleanupFailure } from "../artifacts/ArtifactFileOperation.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import {
  BOUNDED_PRODUCER_LIMITS,
  readLinuxResourceLimits,
} from "./LinuxResourceLimits.js";

const state = vi.hoisted(() => ({
  path: "",
  denied: false,
  handle: undefined as FileHandle | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const filesystem = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...filesystem,
    open: async (...args: Parameters<typeof filesystem.open>) => {
      if (args[0] !== "/proc/self/limits") return filesystem.open(...args);
      const handle = await filesystem.open(state.path, args[1], args[2]);
      state.handle = handle;
      const close = handle.close.bind(handle);
      handle.close = async () => {
        if (state.denied && handle.fd >= 0)
          throw new Error("Descriptor close deliberately denied");
        await close();
      };
      return handle;
    },
  };
});

it.each([false, true])(
  "retains the exact kernel descriptor cleanup capability with malformed report=%s",
  async (malformed) => {
    const directory = await createTestTempDirectory(
      "rea-kernel-limits-cleanup-",
    );
    state.path = join(directory, "limits");
    await writeFile(
      state.path,
      malformed
        ? "malformed"
        : "Max address space unlimited unlimited bytes\nMax file size unlimited unlimited bytes\nMax cpu time unlimited unlimited seconds\n",
    );
    const scope = new ArtifactResourceScope();
    state.denied = true;
    onTestFinished(async () => {
      state.denied = false;
      await scope.close();
      await state.handle?.close();
    });
    const failure = await readLinuxResourceLimits(
      BOUNDED_PRODUCER_LIMITS,
      scope,
    ).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ArtifactFileCleanupFailure);
    if (!(failure instanceof ArtifactFileCleanupFailure))
      throw new Error("Missing descriptor capability");
    expect(failure.cleanupLeases).toEqual([failure.cleanupLease]);
    expect(scope.cleanupResources).toEqual(["/proc/self/limits"]);
    expect(state.handle?.fd).toBeGreaterThanOrEqual(0);
    if (malformed)
      expect(failure.fileCleanupFailure.outcome).toMatchObject({
        kind: "failed",
        cause: {
          message: "Cannot establish inherited Linux limit: Max address space",
        },
      });
    await expect(scope.retryCleanup()).rejects.toMatchObject({
      cleanup: { resources: ["/proc/self/limits"] },
    });
    state.denied = false;
    await scope.retryCleanup();
    expect(failure.cleanupLease.released).toBe(true);
    expect(state.handle?.fd).toBe(-1);
    expect(scope.hasPending).toBe(false);
  },
);
