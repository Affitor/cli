import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Framework =
  | "next-app"
  | "next-pages"
  | "fastify"
  | "express"
  | "node"
  | "unknown";
export type PackageManager = "npm" | "yarn" | "pnpm";

export interface StackInfo {
  framework: Framework;
  packageManager: PackageManager;
  /**
   * Absolute path to the entry file to wire (layout.tsx / _app.tsx), or null.
   * For server frameworks (fastify/express/node) this is the detected server
   * entry if findable (best-effort), else null — the wizard only auto-wires the
   * Next entry files, so a null here routes the new stacks to printed snippets.
   */
  entryFile: string | null;
  /** Directory to create the tracker component in, or null. */
  componentDir: string | null;
}

function readDeps(cwd: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    return { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  } catch {
    return {};
  }
}

export function detectPackageManager(cwd: string): PackageManager {
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}

function firstExisting(cwd: string, candidates: string[]): string | null {
  for (const c of candidates) {
    const full = join(cwd, c);
    if (existsSync(full)) return full;
  }
  return null;
}

/** Common server entry candidates, in priority order, for non-Next stacks. */
const SERVER_ENTRY_CANDIDATES = [
  "src/server.ts",
  "src/server.js",
  "src/index.ts",
  "src/index.js",
  "src/app.ts",
  "src/app.js",
  "src/main.ts",
  "src/main.js",
  "server.ts",
  "server.js",
  "index.ts",
  "index.js",
  "app.ts",
  "app.js",
];

/** Best-effort server entry: the package.json `main`, then common filenames. */
function findServerEntry(cwd: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    if (typeof pkg.main === "string" && pkg.main) {
      const mainPath = join(cwd, pkg.main);
      if (existsSync(mainPath)) return mainPath;
    }
  } catch {
    /* fall through to filename probing */
  }
  return firstExisting(cwd, SERVER_ENTRY_CANDIDATES);
}

/** Heuristic: does this look like a runnable Node service (no framework dep)? */
function hasNodeServerSignal(cwd: string, deps: Record<string, string>): boolean {
  if (deps["stripe"]) return true; // server-ish: payment provider implies a backend
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    if (typeof pkg.main === "string" && pkg.main) return true;
    if (pkg.bin) return true;
    if (pkg.scripts && (pkg.scripts.start || pkg.scripts.serve)) return true;
  } catch {
    return false;
  }
  return false;
}

/**
 * Detect the framework + package manager + entry file of the project at `cwd`.
 * Order is most-specific first: next-app → next-pages → fastify → express →
 * node (a package.json + a server signal but no framework) → unknown. Next.js
 * is the only stack the wizard auto-wires; server frameworks expose a
 * best-effort `entryFile` but `componentDir: null` keeps them on the printed
 * snippet path (auto-injection is a later task).
 */
export function detectStack(cwd: string): StackInfo {
  const packageManager = detectPackageManager(cwd);
  const deps = readDeps(cwd);

  if (deps["next"]) {
    const appLayout = firstExisting(cwd, [
      "app/layout.tsx",
      "app/layout.jsx",
      "src/app/layout.tsx",
      "src/app/layout.jsx",
    ]);
    if (appLayout) {
      return { framework: "next-app", packageManager, entryFile: appLayout, componentDir: dirname(appLayout) };
    }

    const pagesApp = firstExisting(cwd, [
      "pages/_app.tsx",
      "pages/_app.jsx",
      "src/pages/_app.tsx",
      "src/pages/_app.jsx",
    ]);
    if (pagesApp) {
      return { framework: "next-pages", packageManager, entryFile: pagesApp, componentDir: dirname(pagesApp) };
    }
  }

  // Server frameworks (Echoly-class: Fastify + TS + Postgres + Stripe webhook).
  // entryFile is best-effort; componentDir stays null (no browser component to
  // scaffold on a backend), which keeps these stacks on the printed-snippet path.
  if (deps["fastify"]) {
    return { framework: "fastify", packageManager, entryFile: findServerEntry(cwd), componentDir: null };
  }
  if (deps["express"]) {
    return { framework: "express", packageManager, entryFile: findServerEntry(cwd), componentDir: null };
  }
  if (hasNodeServerSignal(cwd, deps)) {
    return { framework: "node", packageManager, entryFile: findServerEntry(cwd), componentDir: null };
  }

  return { framework: "unknown", packageManager, entryFile: null, componentDir: null };
}
