import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Framework } from "./stack-detect.js";

/**
 * Webhook-locator: finds where an advertiser already verifies Stripe webhooks
 * so the wizard can point the agent at the exact injection site for trackSale.
 *
 * The canonical Stripe webhook-verification call is `stripe.webhooks.constructEvent`
 * (Node SDK). When we find it, the conversion-tracking call belongs right after
 * it — the event has been verified and parsed at that point. Dependency-light: a
 * plain fs walk, no globbing libs. Returns null when not found so the caller
 * falls back to printing a snippet.
 */

/** The canonical Stripe webhook signature-verification call (Node SDK). */
const STRIPE_WEBHOOK_NEEDLE = "stripe.webhooks.constructEvent";

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  ".next",
  "build",
  "coverage",
  ".turbo",
  ".vercel",
]);

/** Source extensions worth scanning (skip binaries, maps, lockfiles, etc.). */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

export interface StripeWebhookLocation {
  /** Path to the file containing the call, relative to projectRoot. */
  file: string;
  /** 1-based line number of the `constructEvent` call. */
  line: number;
  /** Framework the hint is tailored for (falls back to "unknown"). */
  framework: Framework | "unknown";
  /** Human-readable description of where to inject the trackSale call. */
  handlerHint: string;
}

function isSourceFile(name: string): boolean {
  return SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/** Collect candidate source files under `dir`, skipping vendored/build dirs. */
function collectSourceFiles(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir, { withFileTypes: false }) as string[];
  } catch {
    return; // unreadable dir — skip
  }
  for (const name of entries) {
    const full = join(dir, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue; // broken symlink, etc.
    }
    if (stat.isDirectory()) {
      if (IGNORED_DIRS.has(name) || name.startsWith(".")) continue;
      collectSourceFiles(full, out);
    } else if (stat.isFile() && isSourceFile(name)) {
      out.push(full);
    }
  }
}

/**
 * Tailor the injection-point hint to the detected framework. The trackSale call
 * always goes *after* constructEvent (the event is verified + parsed there).
 */
function handlerHintFor(framework: Framework | "unknown"): string {
  switch (framework) {
    case "fastify":
      return "inside the fastify.post('/webhooks/stripe', …) handler, right after constructEvent verifies the event";
    case "express":
      return "after constructEvent in the app.post('/webhooks/stripe', …) Express handler";
    case "next-app":
      return "in app/api/webhooks/stripe/route.ts, in the POST handler after constructEvent";
    case "next-pages":
      return "in pages/api/webhooks/stripe.ts, after constructEvent in the API route handler";
    case "node":
      return "after constructEvent in your Stripe webhook HTTP handler";
    default:
      return "after constructEvent, where you handle the verified Stripe webhook event";
  }
}

/**
 * Scan the project source for the canonical Stripe webhook-verification call and
 * return its location + a framework-tailored injection hint. Returns null when
 * no match is found (caller falls back to printing a generic snippet).
 *
 * @param projectRoot Absolute path to the project to scan.
 * @param framework   Detected framework, used to tailor the hint (default "unknown").
 */
export function detectStripeWebhook(
  projectRoot: string,
  framework: Framework | "unknown" = "unknown",
): StripeWebhookLocation | null {
  const files: string[] = [];
  collectSourceFiles(projectRoot, files);

  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue; // unreadable file — skip
    }
    const idx = content.indexOf(STRIPE_WEBHOOK_NEEDLE);
    if (idx === -1) continue;

    // 1-based line number of the first occurrence.
    const line = content.slice(0, idx).split("\n").length;
    return {
      file: relative(projectRoot, file),
      line,
      framework,
      handlerHint: handlerHintFor(framework),
    };
  }

  return null;
}
