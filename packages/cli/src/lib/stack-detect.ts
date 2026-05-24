import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Framework = "next-app" | "next-pages" | "unknown";
export type PackageManager = "npm" | "yarn" | "pnpm";

export interface StackInfo {
  framework: Framework;
  packageManager: PackageManager;
  /** Absolute path to the entry file to wire (layout.tsx / _app.tsx), or null. */
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

/**
 * Detect the framework + package manager + entry file of the project at `cwd`.
 * Next.js only for now (App Router preferred, then Pages Router); everything
 * else is `unknown` so the wizard falls back to printed instructions.
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

  return { framework: "unknown", packageManager, entryFile: null, componentDir: null };
}
