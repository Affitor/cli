import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import * as logger from "./logger.js";
import { format } from "./logger.js";
import { confirmAction } from "./prompts.js";
import { detectStack, type Framework, type PackageManager } from "./stack-detect.js";
import { injectAppLayout, injectPagesApp, trackerComponentSource } from "./inject.js";
import {
  affitorClientSource,
  detectPaymentProvider,
  serverTrackingSnippets,
  type TrackingSnippets,
} from "./server-tracking.js";

const SDK_PACKAGE = "affitor-sdk";
const NODE_PACKAGE = "affitor-node";

export interface WizardOptions {
  cwd: string;
  programId: string | number;
  apiUrl: string;
  autoConfirm: boolean;
}

function rel(cwd: string, p: string): string {
  return relative(cwd, p) || basename(p);
}

function installCommand(pm: PackageManager, pkg: string): { cmd: string; args: string[] } {
  switch (pm) {
    case "yarn":
      return { cmd: "yarn", args: ["add", pkg] };
    case "pnpm":
      return { cmd: "pnpm", args: ["add", pkg] };
    default:
      return { cmd: "npm", args: ["install", pkg] };
  }
}

/**
 * Auto-install wizard: detect the stack, install affitor-sdk, create the
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

  // ── Browser tracking (affitor-sdk) — click capture ──
  if (stack.framework === "unknown" || !stack.entryFile || !stack.componentDir) {
    logger.step("Framework not auto-detectable — add the browser tracker manually:");
    printScriptTagInstructions(opts);
  } else if (!(await installPackage(stack.packageManager, opts.cwd, SDK_PACKAGE, opts.autoConfirm))) {
    logger.warn(`Skipped/failed installing ${SDK_PACKAGE} — use the script tag instead:`);
    printScriptTagInstructions(opts);
  } else {
    // Create the tracker component (new file — always safe).
    const componentPath = join(stack.componentDir, "affitor-tracker.tsx");
    if (existsSync(componentPath)) {
      logger.step(`${rel(opts.cwd, componentPath)} already exists — skipped`);
    } else {
      const useClient = stack.framework === "next-app";
      writeFileSync(componentPath, trackerComponentSource(opts.programId, useClient), "utf8");
      logger.success(`Created ${rel(opts.cwd, componentPath)}`);
    }

    // Wire <AffitorTracker /> into the entry (diff preview + confirm).
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
  }

  // ── Server-side conversion (affitor-node) — lead binding + sale ──
  // Install + scaffold the client; print guided snippets. Never edits auth/payment code.
  await setupServerTracking(opts, stack.packageManager);
}

async function setupServerTracking(opts: WizardOptions, pm: PackageManager): Promise<void> {
  const provider = detectPaymentProvider(opts.cwd);

  logger.titledBox("Server-side conversion (affitor-node)", [
    "",
    `  Payment provider:  ${provider === "unknown" ? format.yellow("not detected") : format.green(provider)}`,
    "",
  ]);

  const installed = await installPackage(pm, opts.cwd, NODE_PACKAGE, opts.autoConfirm);
  if (installed) {
    const clientDir = existsSync(join(opts.cwd, "src")) ? join(opts.cwd, "src", "lib") : join(opts.cwd, "lib");
    const clientPath = join(clientDir, "affitor.ts");
    if (existsSync(clientPath)) {
      logger.step(`${rel(opts.cwd, clientPath)} already exists — skipped`);
    } else {
      mkdirSync(clientDir, { recursive: true });
      writeFileSync(clientPath, affitorClientSource(), "utf8");
      logger.success(`Created ${rel(opts.cwd, clientPath)}`);
    }
  } else {
    const { cmd, args } = installCommand(pm, NODE_PACKAGE);
    logger.warn(`Skipped/failed installing ${NODE_PACKAGE} — install it when ready: ${cmd} ${args.join(" ")}`);
  }

  printServerSnippets(serverTrackingSnippets(provider));
}

function printServerSnippets(s: TrackingSnippets): void {
  const lines: string[] = ["", `  ${format.dim("1) At signup — bind the customer (server-side):")}`];
  for (const l of s.lead.split("\n")) lines.push(`  ${format.cyan(l)}`);
  lines.push("", `  ${format.dim(`2) At purchase — ${s.saleContext}:`)}`);
  for (const l of s.sale.split("\n")) lines.push(`  ${format.cyan(l)}`);
  lines.push("", `  ${format.dim("3) On refund — reverse the commission:")}`);
  for (const l of s.refund.split("\n")) lines.push(`  ${format.cyan(l)}`);
  lines.push("", `  ${format.dim("Paste these in — the wizard never edits your auth/payment code.")}`, "");
  logger.titledBox("Track conversions (add to your backend)", lines);
}

async function installPackage(
  pm: PackageManager,
  cwd: string,
  pkg: string,
  autoConfirm: boolean,
): Promise<boolean> {
  const { cmd, args } = installCommand(pm, pkg);
  const ok = autoConfirm || (await confirmAction(`Install ${pkg} with \`${cmd} ${args.join(" ")}\`?`));
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

