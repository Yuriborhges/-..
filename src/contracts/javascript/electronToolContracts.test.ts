import { describe, expect, it } from "vitest";

import { analyzeJavaScriptApplicationRequestSchema } from "./electronToolContracts.js";

describe("analyze_javascript_application request input_path", () => {
  it.each(["app", "missing-app", "./app", "../app/app.asar"])(
    "rejects relative path %j with the absolute-path requirement",
    (input_path) => {
      const parsed = analyzeJavaScriptApplicationRequestSchema.safeParse({
        input_path,
      });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues).toEqual([
        expect.objectContaining({
          path: ["input_path"],
          message: expect.stringContaining("must be an absolute"),
        }),
      ]);
    },
  );

  it("keeps an absolute path and the request defaults", () => {
    expect(
      analyzeJavaScriptApplicationRequestSchema.parse({
        input_path: "/tmp/app.asar",
      }),
    ).toMatchObject({ input_path: "/tmp/app.asar", format: "auto" });
  });

  it("still rejects an empty path", () => {
    expect(
      analyzeJavaScriptApplicationRequestSchema.safeParse({ input_path: "" })
        .success,
    ).toBe(false);
  });
});
