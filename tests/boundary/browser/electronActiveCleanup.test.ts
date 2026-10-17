import { describe, expect, it } from "vitest";

import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import {
  PlaywrightElectronActiveProvider,
  executableContainsApplication,
} from "../../../src/browser/PlaywrightElectronActiveProvider.js";
import { BrowserObservationError } from "../../../src/domain/browserObservationError.js";
import { ProviderAdapterError } from "../../../src/domain/providerAdapterError.js";
import { finishAnalysisCommand } from "../../../src/cli/finishAnalysisCommand.js";
import { err } from "../../../src/domain/result.js";

describe("PlaywrightElectronActiveProvider cleanup retry", () => {
  it("combines retry failure with outcome.error when primary capture fails", async () => {
    const scope = new ArtifactResourceScope();

    scope.retain({
      kind: "lease",
      resource: "/fake/app/package.json",
      lease: {
        release: async () => {
          throw new Error("EBUSY: resource locked");
        },
      },
    });

    const provider = new PlaywrightElectronActiveProvider(
      {},
      async () => {
        throw new Error("Process failed to launch!");
      },
      undefined,
      scope,
    );

    const result = await provider.capture({
      executable_path: "/nonexistent/electron",
      application_path: "/fake/app",
      application_root: "/fake/app",
      args: [],
      actions: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected capture to fail");

    expect(result.error).toBeInstanceOf(BrowserObservationError);
    expect((result.error as BrowserObservationError).reason).toBe(
      "cleanup_failed",
    );
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(result.error.cleanupResources).toContain("/fake/app/package.json");
    expect(result.error.cause).toBeDefined();

    result.error.resolveCleanup();
    expect(result.error.cleanupIncomplete).toBe(false);
  });

  it("finishAnalysisCommand combines close failure with primary result for CLI", async () => {
    const scope = new ArtifactResourceScope();
    scope.retain({
      kind: "lease",
      resource: "/fake/manifest.json",
      lease: {
        release: async () => {
          throw new Error("EBUSY: handle busy");
        },
      },
    });

    const failingService = {
      close: async () => {
        await scope.close();
      },
    };

    const finished = await finishAnalysisCommand(
      async () =>
        err(
          new ProviderAdapterError(
            "rea-playwright-electron-active",
            "capture_electron_scenario",
            {
              cause: new Error("Primary capture launch failed"),
            },
          ),
        ),
      failingService,
      "rea-playwright-electron-active",
      "capture_electron_scenario",
    );

    expect(finished).toMatchObject({
      code: "cleanup_incomplete",
      details: {
        provider_id: "rea-playwright-electron-active",
        operation: "capture_electron_scenario",
        diagnostics: {
          primary_error: expect.objectContaining({
            code: "execution_failure",
          }),
          cleanup_error: expect.objectContaining({
            code: "cleanup_incomplete",
            details: expect.objectContaining({
              resources: ["/fake/manifest.json"],
            }),
          }),
        },
      },
    });
  });

  it("rejects launch when package.json manifest cannot be verified instead of guessing arguments", async () => {
    const executable = "/opt/app/my-app";
    const appEntry = "/opt/app/resources/app/dist/main.js";

    const fileSystem = {
      lstat: async (path: string) => {
        if (path === "/opt/app/resources/app/package.json") {
          return {
            isFile: () => true,
            isSymbolicLink: () => true,
            size: 100n,
            dev: 1,
            ino: 1,
          } as any;
        }
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      open: async () => {
        throw new Error("unexpected open");
      },
    };

    await expect(
      executableContainsApplication(
        executable,
        appEntry,
        undefined,
        new ArtifactResourceScope(),
        fileSystem as any,
      ),
    ).rejects.toMatchObject({
      _tag: "BrowserObservationError",
      reason: "target_not_allowed",
    });
  });
});
