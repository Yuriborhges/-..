import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

// #3924: a relative input_path selected content under the server's cwd.
it("rejects relative input_path values independent of the server working directory", async () => {
  const root = await createTestTempDirectory("rea-relative-input-");
  const app = join(root, "app");
  const home = join(root, "home");
  await mkdir(app);
  await mkdir(home);
  await writeFile(join(app, "main.js"), "export const value = 1;\n");
  const client = new Client({ name: "relative-input-check", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("scripts/rea.mjs"), "mcp"],
    cwd: root,
    env: { PATH: process.env.PATH ?? "", HOME: home },
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  try {
    await client.connect(transport);
    for (const input_path of ["app", "missing-app"]) {
      const response = await client.callTool({
        name: "analyze_javascript_application",
        arguments: { input_path, format: "directory" },
      });
      expect(response.isError, input_path).toBe(true);
      expect(JSON.stringify(response.content)).toContain(
        "input_path must be an absolute local filesystem path",
      );
    }
    const absolute = await client.callTool({
      name: "analyze_javascript_application",
      arguments: { input_path: app, format: "directory" },
    });
    expect(absolute.isError, JSON.stringify(absolute.content)).not.toBe(true);
    const result = javascriptApplicationAnalysisResultSchema.parse(
      parseEvidence(absolute.structuredContent).normalized_result,
    );
    expect(result.input_path).toBe(await realpath(app));
    expect(result.statistics.parsed_javascript_files).toBe(1);
  } finally {
    await client.close();
    await transport.close();
  }
}, 60_000);
