import type { BundlerErrorCategory } from "./types.js";

export interface BundlerClassifiedError {
  category: BundlerErrorCategory;
  message: string;
}

function hasAny(text: string, needles: string[]): boolean {
  return needles.some((n) => text.includes(n));
}

export function classifyBundlerError(error: unknown): BundlerClassifiedError {
  const message = error instanceof Error ? error.message : String(error);
  const msg = message.toLowerCase();

  if (hasAny(msg, ["429", "rate limit", "too many requests"])) {
    return { category: "rate_limit", message };
  }

  if (hasAny(msg, ["timeout", "timed out", "econnreset", "ehostunreach", "503", "502", "504", "network"])) {
    return { category: "retryable", message };
  }

  if (hasAny(msg, ["underpriced", "fee too low", "max fee per gas less than block base fee"])) {
    return { category: "underpriced", message };
  }

  if (hasAny(msg, ["aa", "simulatevalidation", "validation", "invalid signature", "insufficient prefund", "paymaster"])) {
    return { category: "validation", message };
  }

  return { category: "fatal", message };
}

export function isFailoverWorthy(error: unknown): boolean {
  const { category } = classifyBundlerError(error);
  return category === "retryable" || category === "rate_limit";
}
