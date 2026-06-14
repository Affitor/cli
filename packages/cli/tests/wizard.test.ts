import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { detectStack } from "../src/lib/stack-detect";
import { injectAppLayout, injectPagesApp, trackerComponentSource } from "../src/lib/inject";

const dirs: string[] = [];

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "affitor-cli-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("detectStack", () => {
  it("detects Next.js App Router + npm", () => {
    const dir = project({
      "package.json": JSON.stringify({ dependencies: { next: "15.0.0" } }),
      "package-lock.json": "{}",
      "app/layout.tsx": "export default function L() { return null; }",
    });
    const s = detectStack(dir);
    expect(s.framework).toBe("next-app");
    expect(s.packageManager).toBe("npm");
    expect(s.entryFile).toContain(join("app", "layout.tsx"));
  });

  it("detects Next.js Pages Router + yarn", () => {
    const dir = project({
      "package.json": JSON.stringify({ dependencies: { next: "14" } }),
      "yarn.lock": "",
      "pages/_app.tsx": "export default function App() { return null; }",
    });
    const s = detectStack(dir);
    expect(s.framework).toBe("next-pages");
    expect(s.packageManager).toBe("yarn");
  });

  it("detects pnpm + src/app layout", () => {
    const dir = project({
      "package.json": JSON.stringify({ dependencies: { next: "15" } }),
      "pnpm-lock.yaml": "",
      "src/app/layout.tsx": "x",
    });
    const s = detectStack(dir);
    expect(s.framework).toBe("next-app");
    expect(s.packageManager).toBe("pnpm");
  });

  it("returns unknown for non-Next projects", () => {
    const dir = project({ "package.json": JSON.stringify({ dependencies: { express: "4" } }) });
    expect(detectStack(dir).framework).toBe("unknown");
  });
});

describe("injectAppLayout", () => {
  const layout = `import './globals.css';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`;

  it("adds the import and renders <AffitorTracker /> after <body>", () => {
    const r = injectAppLayout(layout, "./affitor-tracker");
    expect(r.status).toBe("injected");
    expect(r.content).toContain("import { AffitorTracker } from './affitor-tracker';");
    expect(r.content).toMatch(/<body>\s*\n\s*<AffitorTracker \/>/);
    expect(r.added).toHaveLength(2);
  });

  it("is idempotent (already wired)", () => {
    const once = injectAppLayout(layout, "./affitor-tracker").content;
    const twice = injectAppLayout(once, "./affitor-tracker");
    expect(twice.status).toBe("already");
    expect(twice.content).toBe(once);
  });

  it("returns unrecognized when there is no <body>", () => {
    const r = injectAppLayout("export default function X() { return null; }", "./affitor-tracker");
    expect(r.status).toBe("unrecognized");
  });
});

describe("injectPagesApp", () => {
  const app = `import type { AppProps } from 'next/app';

export default function App({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />;
}
`;

  it("wraps <Component {...pageProps} /> and adds the import", () => {
    const r = injectPagesApp(app, "./affitor-tracker");
    expect(r.status).toBe("injected");
    expect(r.content).toContain("import { AffitorTracker } from './affitor-tracker';");
    expect(r.content).toContain("<AffitorTracker />");
    expect(r.content).toContain("<Component {...pageProps} />");
  });

  it("returns unrecognized when the Component usage is absent", () => {
    const r = injectPagesApp("export default function App() { return null; }", "./affitor-tracker");
    expect(r.status).toBe("unrecognized");
  });
});

describe("trackerComponentSource", () => {
  it("emits 'use client' for App Router and an unquoted numeric programId", () => {
    const src = trackerComponentSource(123, true);
    expect(src.startsWith("'use client';")).toBe(true);
    expect(src).toContain("init({ programId: 123 })");
    expect(src).toContain("from '@affitor/sdk'");
  });

  it("omits 'use client' for Pages Router and quotes string ids", () => {
    const src = trackerComponentSource("prog_abc", false);
    expect(src.startsWith("'use client';")).toBe(false);
    expect(src).toContain('init({ programId: "prog_abc" })');
  });
});
