import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  ArtifactFileCleanupFailure,
  bindArtifactFileCleanup,
} from "../artifacts/ArtifactFileOperation.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { ElectronCaptureCleanup } from "./ElectronCaptureCleanup.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { electronFuseFailure } from "../electron/ElectronFuseFailures.js";
import { randomUUID } from "node:crypto";
import {
  basename,
  dirname,
  join,
  normalize,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

import type { _electron as electron } from "playwright-core";

import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../application/AnalysisProvider.js";
import type {
  CanonicalElectronActiveObservationInput,
  ElectronActiveObservationPort,
} from "../application/javascript/ElectronActiveObservationPort.js";
import type { ElectronActiveObservationResult } from "../domain/javascript/electronActiveObservation.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { err, ok, type Result } from "../domain/result.js";
import type {
  OwnedProcessGroup,
  ProcessLineageObservation,
} from "../process/ProcessOwnership.js";
import {
  observeOwnedProcessLineage,
  prepareProcessOwnershipInspection,
  systemProcessOwnershipHost,
} from "../process/ProcessOwnershipObservation.js";
import {
  runElectronActions,
  readApplicationState,
  readFinalApplicationState,
  runWithExecutionLimits,
} from "./PlaywrightElectronActiveActions.js";
import { projectElectronActiveCapture } from "./PlaywrightElectronActiveProjection.js";
import { readElectronFuseImage } from "../electron/ElectronFuseReader.js";
import { assertNodeCliInspectArgumentsSupported } from "./PlaywrightElectronActiveFuses.js";
import { isPathWithinRoot } from "../domain/localPath.js";
import {
  readStableArtifact,
  type StableArtifactFileSystem,
} from "../artifacts/readStableArtifact.js";

const OPERATION = "capture_electron_scenario" as const;
const STARTUP_TIMEOUT_MS = 60_000;

import { PLAYWRIGHT_ELECTRON_ACTIVE_PROVIDER_IDENTITY } from "./providerIdentities.js";

const hookPath = fileURLToPath(
  new URL("../../scripts/electron-active-hook.cjs", import.meta.url),
);

type ElectronApplication = Awaited<ReturnType<typeof electron.launch>>;
type ElectronPaths = {
  readonly executable: string;
  readonly application: string;
  readonly root: string;
};

const STANDARD_ENTRY_BASENAMES = new Set([
  "main",
  "index",
  "app",
  "entry",
  "bundle",
]);

const STANDARD_ENTRY_EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".html", ""]);

const isRecognizedEntryName = (filePath: string): boolean => {
  const base = basename(filePath).toLowerCase();
  for (const ext of STANDARD_ENTRY_EXTENSIONS) {
    if (ext === "" || base.endsWith(ext)) {
      const stem = ext === "" ? base : base.slice(0, -ext.length);
      if (STANDARD_ENTRY_BASENAMES.has(stem)) return true;
    }
  }
  return false;
};

const isMissing = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === "ENOENT";

const isBundledAppEntry = async (
  root: string,
  application: string,
  isDarwinOrWin: boolean,
  signal?: AbortSignal,
  resourceScope: ArtifactResourceScope = new ArtifactResourceScope(),
  fileSystem?: StableArtifactFileSystem,
): Promise<boolean> => {
  if (signal?.aborted) return false;

  const normRoot = normalize(root);
  const normApp = normalize(application);

  // Exact match with the bundled root (e.g. app directory or app.asar archive)
  const matchesRoot = isDarwinOrWin
    ? normRoot.toLowerCase() === normApp.toLowerCase()
    : normRoot === normApp;
  if (matchesRoot) return true;

  // Check if application is lexically contained within root
  const isWithin = isDarwinOrWin
    ? isPathWithinRoot(normRoot.toLowerCase(), normApp.toLowerCase())
    : isPathWithinRoot(normRoot, normApp);
  if (!isWithin) return false;

  // If root is an asar archive, any entry file path inside it is part of the packaged bundle
  if (normRoot.toLowerCase().endsWith(".asar")) {
    return true;
  }

  const pkgPath = join(normRoot, "package.json");
  // Try reading package.json using bounded, non-blocking regular-file reader
  try {
    const snapshot = await readStableArtifact(
      pkgPath,
      64 * 1024,
      signal,
      fileSystem,
      resourceScope,
    );
    const pkg = JSON.parse(snapshot.bytes.toString("utf-8")) as {
      main?: unknown;
    };
    const declaredMain =
      typeof pkg.main === "string" && pkg.main.trim().length > 0
        ? pkg.main.trim()
        : "index.js";
    const resolvedEntry = normalize(resolve(normRoot, declaredMain));
    return isDarwinOrWin
      ? resolvedEntry.toLowerCase() === normApp.toLowerCase()
      : resolvedEntry === normApp;
  } catch (cause) {
    if (signal?.aborted) return false;
    if (
      cause instanceof ArtifactFileCleanupFailure ||
      (cause instanceof ArtifactReaderFailure && cause.cleanup !== undefined)
    ) {
      throw cause;
    }
    // If package.json is missing, match conventional Electron entry file patterns.
    if (isMissing(cause)) {
      return isRecognizedEntryName(normApp);
    }
    // If package.json exists but is unreadable, oversized, or invalid, report the uncertain entry
    // rather than launching with a guessed argument.
    throw new BrowserObservationError(OPERATION, "target_not_allowed", {
      cause,
      detail: `Bundled application package manifest could not be verified: ${pkgPath}`,
    });
  }
};

/**
 * Determine whether the executable is a packaged application binary that already
 * bundles and launches the target application entry point automatically without CLI arguments.
 * Generic Electron binaries (such as `electron`, `electron.exe`, or `Electron.app`) and
 * separate applications living under resource directories require passing the application path.
 */
export const executableContainsApplication = async (
  executable: string,
  application: string,
  signal?: AbortSignal,
  resourceScope: ArtifactResourceScope = new ArtifactResourceScope(),
  fileSystem?: StableArtifactFileSystem,
): Promise<boolean> => {
  if (executable === application) return true;

  const normalizedExecutable = normalize(executable);
  const normalizedApplication = normalize(application);
  const exeDir = dirname(normalizedExecutable);
  const exeBase = basename(normalizedExecutable)
    .toLowerCase()
    .replace(/\.exe$/, "");

  // Generic stock Electron runner executables never package a target application.
  if (exeBase === "electron") {
    return false;
  }

  const candidateRoots: string[] = [
    join(exeDir, "resources", "app.asar"),
    join(exeDir, "resources", "app"),
    join(exeDir, "Resources", "app.asar"),
    join(exeDir, "Resources", "app"),
  ];

  let bundleRoot: string | undefined;

  // macOS app bundle: <App>.app/Contents/MacOS/<exec>
  const parent = dirname(exeDir);
  const grandparent = dirname(parent);
  if (
    basename(exeDir).toLowerCase() === "macos" &&
    basename(parent).toLowerCase() === "contents" &&
    basename(grandparent).toLowerCase().endsWith(".app")
  ) {
    // If the bundle itself is generic Electron.app, it is not a packaged app.
    if (basename(grandparent).toLowerCase() === "electron.app") {
      return false;
    }
    bundleRoot = grandparent;
    candidateRoots.push(
      join(parent, "Resources", "app.asar"),
      join(parent, "Resources", "app"),
      join(parent, "resources", "app.asar"),
      join(parent, "resources", "app"),
    );
  }

  const isDarwinOrWin =
    process.platform === "win32" || process.platform === "darwin";

  // 1. Matches macOS .app bundle root
  if (bundleRoot !== undefined) {
    const bundleMatches = isDarwinOrWin
      ? normalize(bundleRoot).toLowerCase() ===
        normalizedApplication.toLowerCase()
      : normalize(bundleRoot) === normalizedApplication;
    if (bundleMatches) return true;
  }

  // 2. Matches bundled app archive/directory or its entry file inside
  for (const root of candidateRoots) {
    if (
      await isBundledAppEntry(
        root,
        normalizedApplication,
        isDarwinOrWin,
        signal,
        resourceScope,
        fileSystem,
      )
    ) {
      return true;
    }
  }

  return false;
};

/** Launch an owned Electron application through the official Playwright API. */
export class PlaywrightElectronActiveProvider implements ElectronActiveObservationPort {
  readonly #resources: ArtifactResourceScope;
  readonly #fileSystem: StableArtifactFileSystem | undefined;
  readonly #shutdown = new AbortController();

  /** Stop admitting work, cancel and join captures, then retry exact retained resource owners. */
  async close(): Promise<void> {
    this.#shutdown.abort(new Error("Electron active provider is closing"));
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw providerError(cause);
    }
  }

  constructor(
    private readonly environment: Readonly<Record<string, string | undefined>>,
    // Load Playwright only when a capture launches; MCP startup stays off its module graph.
    private readonly launch: typeof electron.launch = async (options) =>
      (await import("playwright-core"))._electron.launch(options),
    private readonly readFuseImage: typeof readElectronFuseImage = readElectronFuseImage,
    resources?: ArtifactResourceScope,
    fileSystem?: StableArtifactFileSystem,
  ) {
    this.#resources = resources ?? new ArtifactResourceScope();
    this.#fileSystem = fileSystem;
  }

  identity(): ProviderIdentity {
    return PLAYWRIGHT_ELECTRON_ACTIVE_PROVIDER_IDENTITY;
  }

  async capture(
    input: CanonicalElectronActiveObservationInput,
    options: ExecutionOptions = {},
  ): Promise<Result<ElectronActiveObservationResult, AnalysisError>> {
    const signal = AbortSignal.any([
      this.#shutdown.signal,
      ...(options.signal === undefined ? [] : [options.signal]),
    ]);
    try {
      return await this.#resources.run(() =>
        this.#capture(input, { ...options, signal }),
      );
    } catch (cause: unknown) {
      return err(providerError(cause));
    }
  }

  async #capture(
    input: CanonicalElectronActiveObservationInput,
    options: ExecutionOptions,
  ): Promise<Result<ElectronActiveObservationResult, AnalysisError>> {
    let application: ElectronApplication | undefined;
    let ownership: OwnedProcessGroup | undefined;
    let lineage: ProcessLineageObservation | undefined;
    let capture: ElectronActiveObservationResult | undefined;
    let paths: ElectronPaths | undefined;
    let initialState:
      | Awaited<ReturnType<typeof readApplicationState>>
      | undefined;
    let actions: ElectronActiveObservationResult["actions"] = [];
    let outcome: Result<ElectronActiveObservationResult, AnalysisError>;
    const runId = randomUUID();
    try {
      if (options.signal?.aborted === true)
        throw new BrowserObservationError(OPERATION, "cancelled");
      await prepareProcessOwnershipInspection(options.signal);
      const startupDeadline = performance.now() + STARTUP_TIMEOUT_MS;
      paths = {
        executable: input.executable_path,
        application: input.application_path,
        root: input.application_root,
      };
      const preflight = assertNodeCliInspectArgumentsSupported(
        input.executable_path,
        {
          resources: this.#resources,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          readFuseImage: this.readFuseImage,
        },
      ).catch((cause: unknown) => {
        throw electronFuseFailure(cause, input.executable_path, OPERATION);
      });
      try {
        await runWithExecutionLimits(
          preflight,
          options.signal,
          startupDeadline,
        );
      } catch (interruption: unknown) {
        // A startup interruption cannot abandon an admitted descriptor's final
        // close. Its physical/cleanup failure takes precedence over the race.
        await preflight;
        throw interruption;
      }
      const captureBaseline =
        await systemProcessOwnershipHost.captureBaseline?.(options.signal);
      if (options.signal?.aborted)
        throw new BrowserObservationError(OPERATION, "cancelled");
      const containsApp = await runWithExecutionLimits(
        executableContainsApplication(
          paths.executable,
          paths.application,
          options.signal,
          this.#resources,
          this.#fileSystem,
        ),
        options.signal,
        startupDeadline,
      );
      const launchOptions: Parameters<typeof electron.launch>[0] = {
        executablePath: paths.executable,
        cwd: paths.root,
        env: safeElectronEnvironment(this.environment, runId),
        args: [
          "-r",
          hookPath,
          ...(containsApp ? [] : [paths.application]),
          ...input.args,
        ],
        timeout: Math.max(1, startupDeadline - performance.now()),
      };
      application = await containLaunchRejections(() => {
        options.signal?.throwIfAborted();
        return this.launch(launchOptions);
      });
      const leaderPid = application.process().pid;
      if (
        typeof leaderPid !== "number" ||
        !Number.isSafeInteger(leaderPid) ||
        leaderPid <= 0
      )
        throw new BrowserObservationError(
          OPERATION,
          "process_ownership_unavailable",
        );
      ownership = {
        runId,
        leaderPid,
        processGroupId: leaderPid,
        expectedParentPid: process.pid,
        expectedCommand: paths.executable,
        sweepTokenOwnedProcesses: true,
        ...(captureBaseline === undefined ? {} : { captureBaseline }),
      };
      lineage = await observeOwnedProcessLineage(ownership);
      initialState = await runWithExecutionLimits(
        readApplicationState(application),
        options.signal,
        startupDeadline,
      );
      actions = await runElectronActions(application, input, options);
      const state = await readFinalApplicationState(
        application,
        options.signal,
      );
      capture = projectElectronActiveCapture(paths, actions, state);
      // Preserve a cancellation already observed before finalization so a
      // later cleanup failure keeps its cause. Late cancellation is checked below.
      outcome = options.signal?.aborted
        ? err(cancelledCapture(capture, options.signal.reason))
        : ok(capture);
    } catch (cause: unknown) {
      if (paths !== undefined && initialState !== undefined) {
        const retainedCapture = projectElectronActiveCapture(
          paths,
          actions,
          initialState,
        );
        capture = {
          ...retainedCapture,
          limitations: [
            ...retainedCapture.limitations,
            `Capture stopped after the initial pre-action snapshot: ${cause instanceof Error ? cause.message : String(cause)}. Final Windows, metrics, IPC, and timeline state is unknown; the retained snapshot may omit action effects.`,
          ],
        };
      }
      if (cause instanceof AnalysisError && cause.cleanupIncomplete)
        outcome = err(cause);
      else if (options.signal?.aborted === true)
        outcome = err(
          new BrowserObservationError(OPERATION, "cancelled", {
            ...cancellationCause(cause, options.signal),
            ...(capture === undefined
              ? {}
              : {
                  partialObservation: {
                    kind: "electron-active-observation" as const,
                    capture,
                  },
                }),
          }),
        );
      else {
        const error = providerError(cause);
        if (capture !== undefined)
          error.retainPartialObservation({
            kind: "electron-active-observation",
            capture,
          });
        outcome = err(error);
      }
    }
    if (application !== undefined) {
      const owner = new ElectronCaptureCleanup(application, ownership, lineage);
      const released = await owner.release(this.#resources);
      const cleanup = owner.processResult;
      if (outcome.ok && options.signal?.aborted === true)
        outcome = err(cancelledCapture(outcome.value, options.signal.reason));
      if (
        released.processes.kind === "failed" ||
        released.transport.kind === "failed"
      ) {
        const processFailure = released.processes.kind === "failed";
        const failures = [released.processes, released.transport].flatMap(
          (attempt) => (attempt.kind === "failed" ? [attempt.cause] : []),
        );
        const cause =
          failures.length === 1
            ? failures[0]
            : new AggregateError(
                failures,
                "Electron process and transport cleanup failed",
              );
        const reason = failures
          .map((failure) =>
            failure instanceof Error ? failure.message : String(failure),
          )
          .join("; ");
        const failure = new BrowserObservationError(
          OPERATION,
          "cleanup_failed",
          {
            cause,
            detail: `${processFailure ? "Electron process cleanup could not be verified" : "Electron transport teardown failed after process cleanup"}: ${reason}. Collected observations are retained when available.`,
            cleanup: { reason, resources: owner.pendingResources },
            ...(capture === undefined
              ? {}
              : {
                  partialObservation: {
                    kind: "electron-active-observation" as const,
                    capture: processFailure
                      ? {
                          ...capture,
                          application: {
                            ...capture.application,
                            cleanup: "unverified" as const,
                          },
                        }
                      : capture,
                  },
                }),
          },
        );
        owner.bind(failure);
        if (outcome.ok) return err(failure);
        const composed = analysisErrorWithCleanupFailure(
          outcome.error,
          failure,
          OPERATION,
        ).bindCleanupDependencies([outcome.error, failure]);
        if (failure.partialObservation !== undefined)
          composed.partialObservation = failure.partialObservation;
        return err(composed);
      }
      if (outcome.ok && cleanup?.cleaned && cleanup.unverified !== undefined)
        outcome = ok({
          ...outcome.value,
          limitations: [
            ...outcome.value.limitations,
            ...cleanup.unverified.map(
              ({ pid, diagnostic }) =>
                `Ownership of unrelated process ${String(pid)} could not be verified; it was left untouched: ${diagnostic}`,
            ),
          ],
        });
    }

    // Cleanup failures returned above keep precedence; a completed capture
    // observed under late cancellation is retained as partial Evidence.
    if (outcome.ok && options.signal?.aborted === true)
      return err(cancelledCapture(outcome.value, options.signal.reason));
    return outcome;
  }
}

const cancelledCapture = (
  capture: ElectronActiveObservationResult,
  reason: unknown,
): BrowserObservationError =>
  new BrowserObservationError(OPERATION, "cancelled", {
    cause: reason,
    partialObservation: { kind: "electron-active-observation", capture },
  });

/**
 * A cancellation wrapper stands in for the caller's abort reason and keeps its
 * producer diagnostics; any other failure observed with cancellation stays the
 * primary cause.
 */
const cancellationCause = (
  cause: unknown,
  signal: AbortSignal,
): {
  readonly cause: unknown;
  readonly diagnostics?: AnalysisError["diagnostics"];
} =>
  cause instanceof AnalysisCancelledError ||
  (cause instanceof AnalysisError && cause.userCategory === "cancelled")
    ? {
        cause: signal.reason,
        ...(cause.diagnostics === undefined
          ? {}
          : { diagnostics: cause.diagnostics }),
      }
    : { cause };

export const safeElectronEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
  runId: string,
  platform = process.platform,
): Record<string, string> =>
  Object.fromEntries([
    ...[
      "HOME",
      "LANG",
      "PATH",
      "TMP",
      "TMPDIR",
      "USER",
      "DISPLAY",
      "WAYLAND_DISPLAY",
      ...(platform === "win32"
        ? [
            "SYSTEMROOT",
            "TEMP",
            "APPDATA",
            "LOCALAPPDATA",
            "USERPROFILE",
            "COMSPEC",
            "PATHEXT",
            "PROGRAMDATA",
            "ALLUSERSPROFILE",
            "USERNAME",
            "SYSTEMDRIVE",
            "HOMEDRIVE",
            "HOMEPATH",
          ]
        : []),
    ]
      .map((name) => [name, environment[name]] as const)
      .filter(
        (entry): entry is readonly [string, string] => entry[1] !== undefined,
      ),
    ["REA_PROCESS_RUN_ID", runId] as const,
  ]);

const PLAYWRIGHT_INTERNAL_FRAME = /playwright-core[\\/]lib[\\/]/;
interface LaunchRejectionScope {
  failure?: unknown;
}
const activeLaunches = new Set<LaunchRejectionScope>();
const heldLaunchRejections = new Map<
  Promise<unknown>,
  {
    readonly reason: Error;
    readonly candidates: Set<LaunchRejectionScope>;
    readonly hadExternalListener: boolean;
  }
>();

const holdLaunchRejection = (
  reason: unknown,
  promise: Promise<unknown>,
): void => {
  if (
    !(reason instanceof Error) ||
    !PLAYWRIGHT_INTERNAL_FRAME.test(reason.stack ?? "")
  )
    throw reason;
  if (!heldLaunchRejections.has(promise))
    heldLaunchRejections.set(promise, {
      reason,
      candidates: new Set(activeLaunches),
      hadExternalListener: process
        .listeners("unhandledRejection")
        .some((listener) => listener !== holdLaunchRejection),
    });
};

const forwardLaunchRejection = (
  reason: Error,
  hadExternalListener: boolean,
): void => {
  // Listeners present at the original event already observed it. When the
  // holding listener was the only listener, restore Node's fatal behavior.
  if (!hadExternalListener)
    process.nextTick(() => {
      throw reason;
    });
};

/** Playwright leaves rejected launch promises unhandled; absorb only those that repeat this launch's failure. */
const containLaunchRejections = async <T>(
  launch: () => Promise<T>,
): Promise<T> => {
  const scope: LaunchRejectionScope = {};
  if (activeLaunches.size === 0)
    process.on("unhandledRejection", holdLaunchRejection);
  activeLaunches.add(scope);
  try {
    return await launch();
  } catch (cause: unknown) {
    scope.failure = cause;
    throw cause;
  } finally {
    await new Promise<void>((resolve) => setImmediate(resolve));
    activeLaunches.delete(scope);
    if (activeLaunches.size === 0)
      process.off("unhandledRejection", holdLaunchRejection);
    for (const [
      promise,
      { reason, candidates, hadExternalListener },
    ] of heldLaunchRejections) {
      if (!candidates.delete(scope)) continue;
      if (
        scope.failure instanceof Error &&
        reason.message !== "" &&
        scope.failure.message.includes(reason.message)
      )
        heldLaunchRejections.delete(promise);
      else if (candidates.size === 0) {
        heldLaunchRejections.delete(promise);
        forwardLaunchRejection(reason, hadExternalListener);
      }
    }
  }
};

const providerError = (cause: unknown): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  if (
    cause instanceof ArtifactFileCleanupFailure ||
    (cause instanceof ArtifactReaderFailure && cause.cleanup !== undefined)
  ) {
    const error = new BrowserObservationError(OPERATION, "cleanup_failed", {
      cause,
      cleanup: cause.cleanup,
      detail: `Electron application entry manifest cleanup failed: ${cause.cleanup?.reason ?? cause.message}`,
    });
    bindArtifactFileCleanup(cause, error);
    return error;
  }
  return new ProviderAdapterError(
    PLAYWRIGHT_ELECTRON_ACTIVE_PROVIDER_IDENTITY.id,
    OPERATION,
    {
      cause,
      diagnostics: {
        message: cause instanceof Error ? cause.message : String(cause),
      },
    },
  );
};
