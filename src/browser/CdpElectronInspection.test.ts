import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { CdpCaptureCompleteness } from "./CdpCaptureCompleteness.js";
import { captureDom, captureFrames } from "./CdpElectronInspection.js";
import type { CdpConnection } from "./CdpConnection.js";
import {
  ingestElectronScriptEvent,
  type ElectronScriptDraft,
} from "./CdpElectronScriptEvents.js";
import { captureElectronScripts } from "./CdpElectronScripts.js";
import { inspectElectronPageInputSchema } from "../domain/javascript/electronObservation.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Electron frame capture", () => {
  it.each([7, undefined])(
    "classifies a malformed child frame ID as unavailable: %s",
    async (childId) => {
      const root = await mkdtemp(join(tmpdir(), "rea-electron-frame-"));
      temporary.push(root);
      const main = join(root, "index.html");
      const child = join(root, "child.html");
      await Promise.all([writeFile(main, "main"), writeFile(child, "child")]);
      const mainUrl = pathToFileURL(main).href;
      const childUrl = pathToFileURL(child).href;
      const completeness = new CdpCaptureCompleteness();

      const frames = await captureFrames(
        {
          frameTree: {
            frame: { id: "frame-main", url: mainUrl },
            childFrames: [
              {
                frame: {
                  ...(childId === undefined ? {} : { id: childId }),
                  url: childUrl,
                },
              },
            ],
          },
        },
        completeness,
      );

      expect(frames.map((frame) => frame.frame_id)).toEqual(["frame-main"]);
      expect(completeness.snapshot()).toMatchObject({
        unavailable_sections: ["frames"],
        excluded: [
          { section: "frames", reason: "invalid_protocol_value", count: 1 },
        ],
      });
      expect(completeness.snapshot().policy_filtered_sections).not.toContain(
        "frames",
      );
      expect(completeness.snapshot().conditions).toContain("attach_limited");
    },
  );

  it("preserves script records across context teardown and ID reuse", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-electron-script-frame-"));
    temporary.push(root);
    const scriptPath = join(root, "app.js");
    await writeFile(scriptPath, "export const app = true;");
    const scripts: ElectronScriptDraft[] = [];
    const executionContextFrames = new Map<string, string>();
    const completeness = new CdpCaptureCompleteness();
    const ingest = (method: string, params: unknown): void =>
      ingestElectronScriptEvent({
        event: { method, params },
        scripts,
        executionContextFrames,
        completeness,
      });
    const context = (frameId: string) => ({
      context: { id: 7, auxData: { frameId } },
    });
    const parsed = (
      scriptId: string,
      hash: string,
      url = pathToFileURL(scriptPath).href,
    ) => ({
      scriptId,
      url,
      hash,
      executionContextId: 7,
    });

    ingest("Runtime.executionContextCreated", context("frame-old"));
    ingest("Debugger.scriptParsed", parsed("script-old", "shared"));
    ingest("Runtime.executionContextDestroyed", { executionContextId: 7 });
    ingest("Runtime.executionContextCreated", context("frame-new"));
    ingest("Debugger.scriptParsed", parsed("script-new", "shared"));
    ingest("Runtime.executionContextsCleared", {});
    ingest("Debugger.scriptParsed", parsed("script-unknown", "unknown"));
    ingest("Runtime.executionContextCreated", context("frame-outside"));
    ingest("Debugger.scriptParsed", parsed("script-outside", "outside"));
    ingest(
      "Debugger.scriptParsed",
      parsed(
        "script-out-of-scope",
        "out-of-scope",
        "https://example.test/app.js",
      ),
    );

    const capture = await captureElectronScripts({
      connection: {
        send: async () => {
          throw new Error("Source capture must remain disabled in this test");
        },
      } as unknown as CdpConnection,
      sessionId: undefined,
      request: inspectElectronPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "page-1",
        observation_ms: 0,
        include_script_sources: false,
      }),
      scripts,
      frameIds: new Set(["frame-old", "frame-new"]),
      completeness,
    });

    expect(capture.total).toBe(4);
    const sharedScripts = capture.items.filter(
      (item) => item.cdp_hash === "shared",
    );
    expect(new Set(sharedScripts.map((item) => item.frame_id))).toEqual(
      new Set(["frame-old", "frame-new"]),
    );
    expect(new Set(sharedScripts.map((item) => item.script_key)).size).toBe(2);
    expect(
      Object.fromEntries(
        capture.items
          .filter((item) => item.cdp_hash !== "shared")
          .map((item) => [item.cdp_hash, item.frame_id]),
      ),
    ).toEqual({
      unknown: null,
      outside: null,
    });
    expect(completeness.snapshot().excluded).toContainEqual({
      section: "scripts",
      reason: "out_of_target_scope",
      count: 1,
    });
  });
});

describe("Electron DOM capture", () => {
  it("excludes nodes with out-of-range parent indices and reports invalid evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-electron-dom-"));
    temporary.push(root);
    const main = join(root, "index.html");
    await writeFile(
      main,
      "<!doctype html><html><body><div></div><span></span></body></html>",
    );
    const mainUrl = pathToFileURL(main).href;
    const completeness = new CdpCaptureCompleteness();

    const dom = await captureDom(
      {
        connection: {
          send: async (method) => {
            if (method !== "DOMSnapshot.captureSnapshot") {
              throw new Error(`Unexpected method: ${method}`);
            }
            return {
              strings: [
                mainUrl,
                "#document",
                "HTML",
                "BODY",
                "DIV",
                "SPAN",
                "",
              ],
              documents: [
                {
                  documentURL: 0,
                  nodes: {
                    nodeType: [9, 1, 1, 1, 1],
                    nodeName: [1, 2, 3, 4, 5],
                    nodeValue: [6, 6, 6, 6, 6],
                    parentIndex: [-1, 0, 1, 99999, 2],
                    attributes: [[], [], [], [], []],
                  },
                },
              ],
            };
          },
        },
        sessionId: undefined,
      },
      completeness,
    );

    expect(dom.total_nodes).toBe(5);
    expect(dom.nodes.map((node) => node.index)).toEqual([0, 1, 2, 4]);
    expect(dom.nodes.map((node) => node.node_name)).toEqual([
      "#document",
      "HTML",
      "BODY",
      "SPAN",
    ]);
    expect(dom.nodes.map((node) => node.parent_index)).toEqual([-1, 0, 1, 2]);
    expect(completeness.snapshot().excluded).toContainEqual({
      section: "dom",
      reason: "invalid_protocol_value",
      count: 1,
    });
  });

  it.each([-2, 2, 99999, undefined])(
    "excludes node when parentIndex is invalid or self-referential: %s",
    async (parentIndex) => {
      const root = await mkdtemp(join(tmpdir(), "rea-electron-dom-invalid-"));
      temporary.push(root);
      const main = join(root, "index.html");
      await writeFile(main, "<!doctype html>");
      const mainUrl = pathToFileURL(main).href;
      const completeness = new CdpCaptureCompleteness();

      const dom = await captureDom(
        {
          connection: {
            send: async () => ({
              strings: [mainUrl, "#document", "DIV", "SPAN", ""],
              documents: [
                {
                  documentURL: 0,
                  nodes: {
                    nodeType: [9, 1, 1],
                    nodeName: [1, 2, 3],
                    nodeValue: [4, 4, 4],
                    parentIndex: [-1, 0, parentIndex],
                    attributes: [[], [], []],
                  },
                },
              ],
            }),
          },
        },
        completeness,
      );

      expect(dom.total_nodes).toBe(3);
      expect(dom.nodes.map((node) => node.index)).toEqual([0, 1]);
      expect(dom.nodes.map((node) => node.node_name)).toEqual([
        "#document",
        "DIV",
      ]);
      expect(completeness.snapshot().excluded).toContainEqual({
        section: "dom",
        reason: "invalid_protocol_value",
        count: 1,
      });
    },
  );
});

describe("Electron DOM multi-document capture", () => {
  it("preserves stable document node indices across multiple documents when earlier nodes are excluded", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-electron-dom-multi-"));
    temporary.push(root);
    const doc1 = join(root, "doc1.html");
    const doc2 = join(root, "doc2.html");
    await Promise.all([writeFile(doc1, "doc1"), writeFile(doc2, "doc2")]);
    const doc1Url = pathToFileURL(doc1).href;
    const doc2Url = pathToFileURL(doc2).href;
    const completeness = new CdpCaptureCompleteness();

    const dom = await captureDom(
      {
        connection: {
          send: async () => ({
            strings: [doc1Url, doc2Url, "#document", "DIV", "SPAN", ""],
            documents: [
              {
                documentURL: 0,
                nodes: {
                  nodeType: [9, 1, 1],
                  nodeName: [2, 3, 4],
                  nodeValue: [5, 5, 5],
                  parentIndex: [-1, 99999, 0],
                  attributes: [[], [], []],
                },
              },
              {
                documentURL: 1,
                nodes: {
                  nodeType: [9, 1],
                  nodeName: [2, 3],
                  nodeValue: [5, 5],
                  parentIndex: [-1, 0],
                  attributes: [[], []],
                },
              },
            ],
          }),
        },
      },
      completeness,
    );

    expect(dom.total_nodes).toBe(5);
    expect(dom.nodes.map((node) => node.index)).toEqual([0, 2, 3, 4]);
    expect(dom.nodes.map((node) => node.parent_index)).toEqual([-1, 0, -1, 3]);
    expect(completeness.snapshot().excluded).toContainEqual({
      section: "dom",
      reason: "invalid_protocol_value",
      count: 1,
    });
  });
});
