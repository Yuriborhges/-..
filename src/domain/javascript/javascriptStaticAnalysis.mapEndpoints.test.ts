import { expect, it } from "vitest";
import * as t from "@babel/types";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import { inspectCall } from "./javascriptStaticAnalysisCalls.js";
import { createJavaScriptAnalysisAccumulator } from "./javascriptStaticAnalysisState.js";
import { indexJavaScriptBindingsWithReceiversSteps } from "./javascriptSemanticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { createJavaScriptRpcScan } from "./javascriptRpcEndpoints.js";
import {
  completeSemanticSteps,
  traverseJavaScriptAst,
} from "./javascriptSemanticTraversal.js";

it("does not classify a local Map lookup as a network endpoint", () => {
  const analysis = analyzeJavaScriptStaticSource(`
    const records = new Map([["/accounts", { name: "Alice" }]]);
    console.log(records.get("/accounts"));
    fetch("/network");
  `);
  expect(analysis.endpoints).toMatchObject([
    { kind: "network", value: "/network", mechanism: "call:fetch" },
  ]);
  expect(analysis.endpoints[0]?.interpretation).toBeUndefined();
});

it.each([
  'new Map().get("/accounts")',
  'new Map().delete("https://example.test/accounts")',
  'const records = new Map(); const alias = records; alias.get("/accounts")',
  'const records = new globalThis.Map(); records?.["get"]("/accounts")',
  'function inspect() { const records = new Map(); return records.get("/accounts"); }',
  'const inspect = () => { const records = new Map(); const alias = records; return alias.delete("/accounts"); }',
  'const browser = window; browser.open("about:blank"); new Map().get("/accounts")',
  'const box = {}; box.value = { name: "Alice" }; inspect(box); new Map().get("/accounts")',
  'patch(() => ({ name: "Alice" })); new Map().get("/accounts")',
  'const box = {}; box.prototype = Map.prototype; new Map().get("/accounts")',
  'const box = {}; const alias = box; alias.prototype = Map.prototype; inspect({}); new Map().get("/accounts")',
  'const box = {}; box.make = () => Map.prototype; new Map().get("/accounts")',
  'let box = {}; const first = box; box = {}; box.p = Map.prototype; patch(first); new Map().get("/accounts")',
  'const box = {}; box.a = {}; box.a.p = Map.prototype; box.safe = {}; patch(box.safe); new Map().get("/accounts")',
  'const records = new Map(); records.get = fetch; new Map().get("/accounts")',
  'const factory = { make() { return {}; } }; factory.make = () => ({}); patch(factory.make()); new Map().get("/accounts")',
])("omits a proven Map operation: %s", (source) => {
  expect(analyzeJavaScriptStaticSource(source).endpoints).toEqual([]);
});

it.each([
  'client.get("/accounts")',
  'const records = new Map(); records.get = request; records.get("/accounts")',
  'let records = new Map(); records = client; records.get("/accounts")',
  'function inspect(Map) { new Map().get("/accounts"); }',
  'Map.prototype.get = request; const records = new Map(); records.get("/accounts")',
  'const records = new Map(); records.__proto__ = { get: fetch }; records.get("/accounts")',
  'const records = new Map(); const alias = records; alias.__proto__ = { get: fetch }; records.get("/accounts")',
  'const records = new Map(); records["__proto__"] = { delete: fetch }; records.delete("/accounts")',
  'function inspect() { records.get("/accounts"); const records = new Map(); }',
  'const alias = records; const records = new Map(); alias.get("/accounts")',
  'function inspect() { const alias = records; const records = new Map(); alias.get("/accounts"); }',
  'function inspect() { const records = new Map(); records.get = fetch; records.get("/accounts"); }',
  'patch(Map.prototype); const records = new Map(); records.get("/accounts")',
  'const prototype = Map.prototype; patch(prototype); new Map().get("/accounts")',
  'patch(Map); new Map().get("/accounts")',
  'new Patch(Map.prototype); new Map().get("/accounts")',
  'Map.prototype.patch = function () { this.get = fetch; }; Map.prototype.patch(); new Map().get("/accounts")',
  'Map.patch(); new Map().get("/accounts")',
  'globalThis.patch = function () { this.Map.prototype.get = fetch; }; globalThis.patch(); new Map().get("/accounts")',
  'window.open = function () { this.Map.prototype.get = fetch; }; window.open(); new Map().get("/accounts")',
  'function invoke() { window.open(); } window.open = patch; invoke(); new Map().get("/accounts")',
  'patch`prototype ${Map.prototype}`; new Map().get("/accounts")',
  'const box = { prototype: Map.prototype }; patch(box); new Map().get("/accounts")',
  'patch((() => Map.prototype)()); new Map().get("/accounts")',
  'const prototype = (() => Map.prototype)(); prototype.get = fetch; new Map().get("/accounts")',
  'const box = {}; box.prototype = Map.prototype; box.prototype.get = fetch; new Map().get("/accounts")',
  'const box = {}; box.p = (anything(), Map.prototype); patch(box); new Map().get("/accounts")',
  'window.prototype = Map.prototype; new Map().get("/accounts")',
  'const box = new ExternalBox(); box.prototype = Map.prototype; new Map().get("/accounts")',
  'function expose(box) { box.prototype = Map.prototype; } new Map().get("/accounts")',
  'const factory = { make() { return Map.prototype; } }; factory.make().get = fetch; new Map().get("/accounts")',
  'new Map().__proto__.get = fetch; new Map().get("/accounts")',
  'const records = new Map(); Object.getPrototypeOf(records).get = fetch; new Map().get("/accounts")',
  'const getPrototype = Reflect.getPrototypeOf; getPrototype(new Map()).get = fetch; new Map().get("/accounts")',
  'patch(() => Map.prototype); new Map().get("/accounts")',
  'const factory = { make() { return {}; } }; factory.make = () => Map.prototype; patch(factory.make()); new Map().get("/accounts")',
  'function make() { return { prototype: Map.prototype }; } patch(make()); new Map().get("/accounts")',
  'const factory = { prototype() { return Map.prototype; } }; patch(factory.prototype()); new Map().get("/accounts")',
  'patch([Map.prototype]); new Map().get("/accounts")',
  'Object.setPrototypeOf(Map.prototype, custom); new Map().get("/accounts")',
])("keeps unresolved lookup semantics as a candidate: %s", (source) => {
  expect(analyzeJavaScriptStaticSource(source).endpoints).toMatchObject([
    { kind: "network", value: "/accounts", interpretation: "candidate" },
  ]);
});

it.each([
  "box.prototype = Map.prototype;",
  'const alias = box; const prototype = Map.prototype; alias["prototype"] = prototype;',
  "({ value: box.prototype } = { value: Map.prototype });",
  "({ value: box.prototype = Map.prototype } = {});",
  "for (box.prototype of [Map.prototype]) {}",
])(
  "retains prototype identities stored after container initialization: %s",
  (store) => {
    const source = `const box = {}; ${store}
    function patch(b) { b.prototype.get = fetch; }
    patch(box); new Map().get("/accounts");`;
    expect(analyzeJavaScriptStaticSource(source).endpoints).toMatchObject([
      { kind: "network", value: "/accounts", interpretation: "candidate" },
    ]);
  },
);

it.each([
  ['new Headers().get("content-type")', 0],
  ['new URLSearchParams().delete("q")', 0],
  ['new Map().get("/accounts")', 0],
  ['new Map().delete("/accounts")', 0],
  ['client.get("/accounts")', 0],
  ['const client = createClient(); client.get("/accounts")', 0],
  ['const records = new Map(); records.get("/accounts")', 1],
] as const)(
  "requests mutation facts only for unresolved local receivers: %s",
  (source, pending) => {
    const file = parseJavaScriptSource(source);
    if (file === null) throw new Error("Expected parsed source");
    const index = completeSemanticSteps(
      indexJavaScriptBindingsWithReceiversSteps(file.program),
    );
    completeSemanticSteps(index.indexAmbientWritesSteps());
    const accumulator = createJavaScriptAnalysisAccumulator(source.length);
    const context = {
      source,
      accumulator,
      vitePreloadDependencyTable: null,
      openReceiverFacts: index.receivers.openReceivers,
      rpcScan: createJavaScriptRpcScan(
        source,
        index.receivers.rpcClientRoots,
        index,
      ),
    };
    traverseJavaScriptAst(file.program, {
      enter(node) {
        if (
          t.isCallExpression(node) ||
          t.isOptionalCallExpression(node) ||
          t.isNewExpression(node)
        )
          inspectCall(source, node, context, index.bindings);
      },
    });
    expect(accumulator.pendingNetworkCalls).toHaveLength(pending);
  },
);
