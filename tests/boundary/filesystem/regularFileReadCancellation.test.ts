import type { FileHandle } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import { withRegularFile } from "../../../src/application/RegularFileRead.js";
import { OwnedFileHandle } from "../../../src/filesystem/OwnedFileHandle.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const fixture = async (prefix: string): Promise<string> => {
  const root = await createTestTempDirectory(prefix);
  const path = join(root, "input.txt");
  await writeFile(path, "fixture bytes");
  return path;
};

it("rejects with the caller's reason when cancellation arrives during final metadata checks", async () => {
  const path = await fixture("rea-regular-read-final-stat-");
  const controller = new AbortController();
  const reason = new Error("cancelled during final metadata checks");
  let opened: FileHandle | undefined;
  const read = withRegularFile(
    path,
    async (handle) => {
      opened = handle;
      // The helper stats the handle once more after this callback returns.
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementationOnce(async () => {
        const stats = await stat();
        controller.abort(reason);
        return stats;
      });
      return "fixture bytes";
    },
    { signal: controller.signal },
  );

  await expect(read).rejects.toBe(reason);
  expect(opened?.fd).toBe(-1);
});

it("rejects with the caller's reason when cancellation arrives during close", async () => {
  const path = await fixture("rea-regular-read-close-");
  const controller = new AbortController();
  const reason = new Error("cancelled during close");
  const originalClose = OwnedFileHandle.prototype.close;
  const close = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockImplementation(async function (this: OwnedFileHandle) {
      await originalClose.call(this);
      controller.abort(reason);
    });
  try {
    await expect(
      withRegularFile(path, async () => "fixture bytes", {
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  } finally {
    close.mockRestore();
  }
});

it("rejects with the caller's reason after the resource scope recovers a failed close", async () => {
  const path = await fixture("rea-regular-read-close-retry-");
  const controller = new AbortController();
  const reason = new Error("cancelled before close recovery");
  const resources = new ArtifactResourceScope();
  const originalClose = OwnedFileHandle.prototype.close;
  let attempts = 0;
  const close = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockImplementation(async function (this: OwnedFileHandle) {
      attempts += 1;
      if (attempts === 1) {
        controller.abort(reason);
        throw new Error("injected transient close failure");
      }
      await originalClose.call(this);
    });
  try {
    await expect(
      withRegularFile(path, async () => "fixture bytes", {
        signal: controller.signal,
        resources,
      }),
    ).rejects.toBe(reason);
    expect(attempts).toBe(2);
    expect(resources.hasPending).toBe(false);
  } finally {
    close.mockRestore();
    await resources.close();
  }
});

it("returns the value when the signal stays open", async () => {
  const path = await fixture("rea-regular-read-control-");
  const controller = new AbortController();
  await expect(
    withRegularFile(path, async () => "fixture bytes", {
      signal: controller.signal,
    }),
  ).resolves.toBe("fixture bytes");
});
