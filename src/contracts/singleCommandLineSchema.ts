import { z } from "zod";

/**
 * Validates one single-line command input. Rejects CR, LF, and embedded NUL
 * bytes to protect provider processes from command injection, truncated
 * transmission, and premature line termination.
 */
export const singleCommandLineSchema = z
  .string()
  .min(1)
  .refine(
    (value) => !/[\r\n\u0000]/u.test(value),
    "A single command line is required",
  );
