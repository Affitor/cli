import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import * as logger from "./logger.js";
import { format } from "./logger.js";
import { confirmAction } from "./prompts.js";
import { detectStack, type Framework, type PackageManager } from "./stack-detect.js";
import { injectAppLayout, injectPagesApp, trackerComponentSource } from "./inject.js";

const SDK_PACKAGE = "@affitor/sdk";

export interface WizardOptions {
  cwd: string;
  programId: string | number;
  apiUrl: string;
  autoConfirm: boolean;
}

function rel(cwd: string, p: string): string {
  return relative(cwd, p) || basename(p);
}

function installCommand(pm: PackageManager): { cmd: string; args: string[] } {
  switch (pm) {
    case "yarn":
      return { cmd: "yarn", args: ["add", SDK_PACKAGE] };
    case "pnpm":
      return { cmd: "pnpm", args: ["add", SDK_PACKAGE] };
    default:
      return { cmd: "npm", args: ["install", SDK_PACKAGE] };
  }
}

/**
 * Auto-install wizard: detect the stack, install @affitor/sdk, create the
 * tracker component, and wire it into the app entry — with a diff preview and
 * confirmation. Never edits auth/checkout code (signup() is printed as a
 * snippet). Any failure degrades gracefully to printed instructions.
 */
export async function runInstallWizard(opts: WizardOptions): Promise<void> {
  const stack = detectStack(opts.cwd);

  logger.titledBox("Auto-install", [
    "",
    `  Framework:  ${stack.framework === "unknown" ? format.yellow("not detected") : format.green(stack.framework)}`,
    `  Installer:  ${format.cyan(stack.packageManager)}`,
    "",
  ]);

  if (stack.framework === "unknown" || !stack.entryFile || !stack.componentDir) {
    logger.step("Stack not auto-detectable — set up tracking manually:");
    printScriptTagInstructions(opts);
    printSignupSnippet();
    return;
  }

  // 1. Install the SDK (confirmed; graceful fallback on failure).
  const installed = await installSdk(stack.packageManager, opts.cwd, opts.autoConfirm);
  if (!installed) {
    logger.warn(`Skipped/failed installing ${SDK_PACKAGE} — use the script tag instead:`);
    printScriptTagInstructions(opts);
    printSignupSnippet();
    return;
  }

  // 2. Create the tracker component (new file — always safe).
  const componentPath = join(stack.componentDir, "affitor-tracker.tsx");
  if (existsSync(componentPath)) {
    logger.step(`${rel(opts.cwd, componentPath)} already exists — skipped`);
  } else {
    const useClient = stack.framework === "next-app";
    writeFileSync(componentPath, trackerComponentSource(opts.programId, useClient), "utf8");
    logger.success(`Created ${rel(opts.cwd, componentPath)}`);
  }

  // 3. Wire <AffitorTracker /> into the entry (diff preview + confirm).
  const original = readFileSync(stack.entryFile, "utf8");
  const result =
    stack.framework === "next-app"
      ? injectAppLayout(original, "./affitor-tracker")
      : injectPagesApp(original, "./affitor-tracker");

  const entryLabel = rel(opts.cwd, stack.entryFile);
  if (result.status === "already") {
    logger.step(`${entryLabel} already wired — skipped`);
  } else if (result.status === "unrecognized") {
    logger.warn(`Couldn't safely edit ${entryLabel}. Add this yourself:`);
    printEntrySnippet(stack.framework);
  } else {
    showAddedDiff(entryLabel, result.added);
    const ok = opts.autoConfirm || (await confirmAction(`Apply this change to ${basename(stack.entryFile)}?`));
    if (ok) {
      writeFileSync(stack.entryFile, result.content, "utf8");
      logger.success(`Wired tracking into ${entryLabel}`);
    } else {
      logger.step("Skipped. Add <AffitorTracker /> at the app root when ready.");
    }
  }

  // 4. signup() — guided snippet only. Never auto-edits auth/checkout code.
  printSignupSnippet();
}

async function installSdk(pm: PackageManager, cwd: string, autoConfirm: boolean): Promise<boolean> {
  const { cmd, args } = installCommand(pm);
  const ok = autoConfirm || (await confirmAction(`Install ${SDK_PACKAGE} with \`${cmd} ${args.join(" ")}\`?`));
  if (!ok) return false;

  logger.step(`Running ${cmd} ${args.join(" ")} …`);
  try {
    const res = spawnSync(cmd, args, { cwd, stdio: "inherit" });
    return res.status === 0;
  } catch {
    return false;
  }
}

function showAddedDiff(file: string, added: string[]): void {
  logger.newline();
  logger.info(`  ${format.dim("Proposed change to")} ${format.cyan(file)}${format.dim(":")}`);
  for (const line of added) {
    logger.info(`    ${format.green("+ " + line)}`);
  }
  logger.newline();
}

function printEntrySnippet(framework: Framework): void {
  if (framework === "next-pages") {
    logger.info(`    ${format.cyan("import { AffitorTracker } from './affitor-tracker';")}`);
    logger.info(`    ${format.dim("// render <AffitorTracker /> alongside <Component {...pageProps} />")}`);
  } else {
    logger.info(`    ${format.cyan("import { AffitorTracker } from './affitor-tracker';")}`);
    logger.info(`    ${format.dim("// render <AffitorTracker /> inside <body> of app/layout.tsx")}`);
  }
  logger.newline();
}

function printScriptTagInstructions(opts: WizardOptions): void {
  logger.info(`    ${format.cyan(`<script src="${opts.apiUrl}/js/affitor-tracker.js"`)}`);
  logger.info(`    ${format.cyan(`  data-affitor-program-id="${opts.programId}"></script>`)}`);
  logger.info(`    ${format.dim("(add to your site's <head>)")}`);
  logger.newline();
}

function printSignupSnippet(): void {
  logger.titledBox("Track signups", [
    "",
    "  Call this right after a user registers (replace the args):",
    "",
    `  ${format.cyan("import { signup } from '@affitor/sdk';")}`,
    `  ${format.cyan('await signup("customer_id", "user@example.com");')}`,
    "",
    `  ${format.dim("Add it yourself — the wizard never edits your auth/checkout code.")}`,
    "",
  ]);
}
