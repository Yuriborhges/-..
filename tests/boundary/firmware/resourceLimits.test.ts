import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { createFirmwareAnalysisProvider } from "../../../src/composition/firmware.js";
import { FirmwareAnalysisService } from "../../../src/application/firmware/FirmwareAnalysisService.js";
import { firmwareResultSchemas } from "../../../src/domain/firmware/firmwareAnalysis.js";
import { FIRMWARE_LIMITS } from "../../../src/firmware/FirmwareRelease.js";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";
import { assertFirmwareCleanup } from "../../fixtures/firmware/provider.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const linux = it.skipIf(process.platform !== "linux");

// Real kernel-limit verification with a synthetic Unblob producer; real Unblob
// has its own verifier. Python keeps SIGXFSZ ignored, so an over-limit write
// fails with EFBIG and leaves a truncated file, as the real producer would.
const firmwareService = async (
  stagedBytes: number,
  extractionFileBytes: number,
) => {
  const directory = await createTestTempDirectory("rea-firmware-limits-");
  const command = join(directory, "unblob-probe");
  await writeFile(
    command,
    `#!/usr/bin/python3
import hashlib, json, os, resource, sys
if '--version' in sys.argv:
    assert resource.getrlimit(resource.RLIMIT_FSIZE) == (${String(FIRMWARE_LIMITS.reportBytes)}, ${String(FIRMWARE_LIMITS.reportBytes)})
    print('26.6.4')
    sys.exit(0)
assert resource.getrlimit(resource.RLIMIT_FSIZE) == (${String(extractionFileBytes)}, ${String(extractionFileBytes)})
args = sys.argv[1:]
report = args[args.index('--report') + 1]
log = args[args.index('--log') + 1]
source = args[-1]
child = os.path.join(args[args.index('--extract-dir') + 1], 'rootfs', 'config')
with open(source, 'rb') as handle:
    data = handle.read()
content = b'x' * ${String(stagedBytes)}
os.makedirs(os.path.dirname(child))
with open(child, 'wb') as handle:
    handle.write(content)
with open(log, 'w') as handle:
    handle.write('resource fixture log\\n')
def stat(path, size):
    return {'__typename__': 'StatReport', 'path': path, 'size': size, 'is_file': True, 'is_dir': False, 'is_link': False, 'link_target': None}
def task(path, depth, blob_id):
    return {'path': path, 'depth': depth, 'blob_id': blob_id, 'is_multi_file': False}
def digest(value):
    return {'__typename__': 'HashReport', 'sha256': hashlib.sha256(value).hexdigest()}
child_task = task(child, 1, 'gzip-id')
chunk = {'__typename__': 'ChunkReport', 'id': 'gzip-id', 'start_offset': 0, 'end_offset': len(data), 'size': len(data), 'handler_name': 'gzip', 'is_encrypted': False, 'extraction_reports': []}
with open(report, 'w') as handle:
    json.dump([
        {'task': child_task, 'reports': [stat(child, len(content)), digest(content)], 'subtasks': []},
        {'task': task(source, 0, ''), 'reports': [stat(source, len(data)), digest(data), chunk], 'subtasks': [child_task]},
    ], handle)
`,
    { mode: 0o700 },
  );
  const path = join(directory, "input.bin");
  await writeFile(path, "fixture-input-data");
  const launches: Parameters<typeof assertFirmwareCleanup>[0] = [];
  const service = new FirmwareAnalysisService(
    createFirmwareAnalysisProvider(
      { ...process.env, REA_UNBLOB_COMMAND: command },
      async (options) => {
        const spawned = await spawnOwnedProviderProcess(options);
        launches.push({
          cwd: options.cwd,
          pid: spawned.process.pid,
          args: options.arguments,
        });
        return spawned;
      },
    ),
  );
  onTestFinished(() => service.close());
  return { service, path, output: join(directory, "output"), launches };
};

linux.each([
  [1, 1, FIRMWARE_LIMITS.reportBytes],
  [16 * 1024 * 1024, 14, 16 * 1024 * 1024],
])(
  "keeps the mandatory producer report writable under a %i-byte staging budget",
  async (budget, stagedBytes, extractionFileBytes) => {
    const fixture = await firmwareService(stagedBytes, extractionFileBytes);
    const outcome = await fixture.service.execute("extract_firmware", {
      path: fixture.path,
      output_directory: fixture.output,
      max_output_bytes: budget,
    });
    if (!outcome.ok) throw outcome.error;
    const result = firmwareResultSchemas.extract_firmware.parse(
      outcome.value.normalized_result,
    );
    expect(result.files).toEqual([
      expect.objectContaining({
        relative_path: "rootfs/config",
        size: stagedBytes,
      }),
    ]);
    await assertFirmwareCleanup(fixture.launches);
  },
);

linux(
  "rejects staged output beyond the aggregate budget below the report ceiling",
  async () => {
    const fixture = await firmwareService(1000, FIRMWARE_LIMITS.reportBytes);
    const outcome = await fixture.service.execute("extract_firmware", {
      path: fixture.path,
      output_directory: fixture.output,
      max_output_bytes: 64,
    });
    expect(outcome).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisOutputError",
        reason: "Staging byte budget exceeded (64)",
      },
    });
    await expect(access(fixture.output)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await assertFirmwareCleanup(fixture.launches);
  },
);
