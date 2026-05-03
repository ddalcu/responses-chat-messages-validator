import type { z } from "zod";

/**
 * Spec-agnostic helper that turns a `z.ZodError` into a list of human-readable
 * issue strings. Each issue is prefixed with `prefix` and a dotted path (or
 * `(root)` if the error is on the root object).
 */
export const formatZodIssues = (prefix: string, error: z.ZodError) =>
  error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${prefix}${path}: ${issue.message}`;
  });
