import { describe, expect, it } from "vitest";

import { singleCommandLineSchema } from "./singleCommandLineSchema.js";
import { cutterCommandInputSchema } from "./cutterToolContracts.js";
import { RIZIN_DEBUG_TOOL_CONTRACTS } from "./rizinDebugToolContracts.js";

const SESSION_ID = "27d3e3f1-f1e5-49ae-91ec-95af1f343a5a";

describe("singleCommandLineSchema", () => {
  it("rejects empty command strings", () => {
    const result = singleCommandLineSchema.safeParse("");
    expect(result.success).toBe(false);
  });

  it("rejects commands containing actual NUL bytes", () => {
    const invalidCommands = [
      "\u0000",
      "\0",
      "cmd\0",
      "\0cmd",
      "dr\0registers",
      "pdi\u0000extra",
      "px 20\0 @ rsp",
    ];
    for (const cmd of invalidCommands) {
      const result = singleCommandLineSchema.safeParse(cmd);
      expect(
        result.success,
        `Expected rejection for ${JSON.stringify(cmd)}`,
      ).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe(
          "A single command line is required",
        );
      }
    }
  });

  it("rejects commands containing CR, LF, or CRLF line terminators", () => {
    const invalidCommands = [
      "\r",
      "\n",
      "\r\n",
      "cmd\r",
      "cmd\n",
      "cmd\r\n",
      "cmd1\ncmd2",
      "cmd1\rcmd2",
      "cmd1\r\ncmd2",
      "dr\nquit",
      "pdi\rexit",
    ];
    for (const cmd of invalidCommands) {
      const result = singleCommandLineSchema.safeParse(cmd);
      expect(
        result.success,
        `Expected rejection for ${JSON.stringify(cmd)}`,
      ).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe(
          "A single command line is required",
        );
      }
    }
  });

  it("accepts valid single-line commands", () => {
    const validCommands = [
      "dr",
      "pdi",
      "px 20 @ rsp",
      "s sym.main",
      "iI",
      "pdf @ main",
      "af @ entry0",
    ];
    for (const cmd of validCommands) {
      const result = singleCommandLineSchema.safeParse(cmd);
      expect(result.success, `Expected acceptance for ${cmd}`).toBe(true);
      if (result.success) {
        expect(result.data).toBe(cmd);
      }
    }
  });

  it("accepts normal commands containing literal escape sequences", () => {
    const escapeLookingCommands = [
      "echo \\0",
      "echo \\n",
      "echo \\r",
      "print \\^@",
      'cmd "literal\\0string"',
      "cmd \\x00",
      "cmd \\r\\n",
      's "sym.foo\\nbar"',
    ];
    for (const cmd of escapeLookingCommands) {
      const result = singleCommandLineSchema.safeParse(cmd);
      expect(result.success, `Expected acceptance for ${cmd}`).toBe(true);
      if (result.success) {
        expect(result.data).toBe(cmd);
      }
    }
  });
});

describe("Cutter and Rizin tool contract integration", () => {
  const rizinDebugCommandContract = RIZIN_DEBUG_TOOL_CONTRACTS.find(
    (c) => c.name === "rizin_debug_command",
  );
  if (!rizinDebugCommandContract) {
    throw new Error("rizin_debug_command contract not found");
  }

  it("rejects NUL, CR, and LF in cutterCommandInputSchema", () => {
    for (const invalid of ["pdi\0", "pdi\n", "pdi\r", "pdi\r\n", "\0", "\n"]) {
      const result = cutterCommandInputSchema.safeParse({
        session_id: SESSION_ID,
        expected_generation: 0,
        command: invalid,
      });
      expect(
        result.success,
        `Expected cutterCommandInputSchema rejection for ${JSON.stringify(invalid)}`,
      ).toBe(false);
    }
  });

  it("accepts valid commands and literal escape sequences in cutterCommandInputSchema", () => {
    for (const valid of [
      "pdi",
      "echo \\0",
      "echo \\n",
      'cmd "literal\\0string"',
    ]) {
      const result = cutterCommandInputSchema.safeParse({
        session_id: SESSION_ID,
        expected_generation: 0,
        command: valid,
      });
      expect(
        result.success,
        `Expected cutterCommandInputSchema acceptance for ${valid}`,
      ).toBe(true);
    }
  });

  it("rejects NUL, CR, and LF in rizin_debug_command inputSchema", () => {
    for (const invalid of ["dr\0", "dr\n", "dr\r", "dr\r\n", "\0", "\n"]) {
      const result = rizinDebugCommandContract.inputSchema.safeParse({
        session_id: SESSION_ID,
        command: invalid,
      });
      expect(
        result.success,
        `Expected rizin_debug_command rejection for ${JSON.stringify(invalid)}`,
      ).toBe(false);
    }
  });

  it("accepts valid commands and literal escape sequences in rizin_debug_command inputSchema", () => {
    for (const valid of [
      "dr",
      "echo \\0",
      "echo \\n",
      'cmd "literal\\0string"',
    ]) {
      const result = rizinDebugCommandContract.inputSchema.safeParse({
        session_id: SESSION_ID,
        command: valid,
      });
      expect(
        result.success,
        `Expected rizin_debug_command acceptance for ${valid}`,
      ).toBe(true);
    }
  });
});
