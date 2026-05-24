import pc from "picocolors";

let quietMode = false;
let jsonMode = false;
let verboseMode = false;

export function setLoggerOptions(opts: {
  quiet?: boolean;
  json?: boolean;
  verbose?: boolean;
}) {
  if (opts.quiet !== undefined) quietMode = opts.quiet;
  if (opts.json !== undefined) jsonMode = opts.json;
  if (opts.verbose !== undefined) verboseMode = opts.verbose;
}

export function info(msg: string) {
  if (quietMode || jsonMode) return;
  console.log(msg);
}

export function success(msg: string) {
  if (jsonMode) return;
  console.log(pc.green("✓") + " " + msg);
}

export function warn(msg: string) {
  if (jsonMode) return;
  console.log(pc.yellow("⚠") + " " + msg);
}

export function error(msg: string) {
  if (jsonMode) return;
  console.error(pc.red("✗") + " " + msg);
}

export function step(msg: string) {
  if (quietMode || jsonMode) return;
  console.log(pc.dim("  " + msg));
}

export function debug(msg: string) {
  if (!verboseMode || jsonMode) return;
  console.log(pc.dim("[debug] " + msg));
}

export function json(data: unknown) {
  console.log(JSON.stringify(data, null, 2));
}

export function box(lines: string[]) {
  if (jsonMode) return;
  const maxLen = Math.max(...lines.map((l) => stripAnsi(l).length));
  const border = "─".repeat(maxLen + 2);
  console.log();
  console.log(`  ╭${border}╮`);
  for (const line of lines) {
    const padding = " ".repeat(maxLen - stripAnsi(line).length);
    console.log(`  │ ${line}${padding} │`);
  }
  console.log(`  ╰${border}╯`);
  console.log();
}

export function titledBox(title: string, lines: string[]) {
  if (jsonMode) return;
  const maxLen = Math.max(
    stripAnsi(title).length + 2,
    ...lines.map((l) => stripAnsi(l).length),
  );
  const titleLen = stripAnsi(title).length;
  const topBorder = "─".repeat(maxLen - titleLen);
  const bottomBorder = "─".repeat(maxLen + 2);
  console.log();
  console.log(`  ╭─ ${pc.bold(pc.cyan(title))} ${topBorder}─╮`);
  for (const line of lines) {
    const padding = " ".repeat(maxLen - stripAnsi(line).length);
    console.log(`  │ ${line}${padding} │`);
  }
  console.log(`  ╰${bottomBorder}╯`);
  console.log();
}

export function banner() {
  if (quietMode || jsonMode) return;
  const art = [
    `   ___    _______ __`,
    `  / _ |  / _/ _(_) /____  ____`,
    ` / __ | / _/ _/ / __/ _ \\/ __/`,
    `/_/ |_|/_//_//_/\\__/\\___/_/`,
  ];
  console.log();
  for (const line of art) {
    console.log(`  ${pc.cyan(line)}`);
  }
  console.log(`  ${pc.dim("CLI-native affiliate tracking")}`);
  console.log();
}

export function progressStep(
  current: number,
  total: number,
  msg: string,
  done: boolean,
) {
  if (quietMode || jsonMode) return;
  const prefix = current === 1 ? "┌" : current === total ? "└" : "├";
  const counter = pc.dim(`[${current}/${total}]`);
  const status = done ? pc.green(" ✓") : pc.yellow(" …");
  console.log(`  ${pc.dim(prefix)} ${counter} ${msg}${status}`);
}

export function statusBadge(label: string, status: "ok" | "warn" | "error") {
  if (quietMode || jsonMode) return;
  const dot =
    status === "ok"
      ? pc.green("●")
      : status === "warn"
        ? pc.yellow("●")
        : pc.red("●");
  console.log(`  ${dot} ${label}`);
}

export function miniBar(
  value: number,
  max: number,
  width: number = 10,
): string {
  const ratio = max > 0 ? Math.min(value / max, 1) : 0;
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  return pc.cyan("█".repeat(filled)) + pc.dim("░".repeat(empty));
}

export function commandHelp(name: string, description: string) {
  if (quietMode || jsonMode) return;
  console.log(`    ${pc.cyan(name.padEnd(16))} ${pc.dim(description)}`);
}

export function sectionHeader(title: string) {
  if (quietMode || jsonMode) return;
  console.log();
  console.log(`  ${pc.bold(title)}`);
}

export function maskApiKey(key: string): string {
  if (key.length <= 10) return key;
  return key.slice(0, 6) + "…" + key.slice(-3);
}

export function newline() {
  if (quietMode || jsonMode) return;
  console.log();
}

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\u001b\[[0-9;]*m/g, "");
}

export const format = {
  bold: pc.bold,
  dim: pc.dim,
  green: pc.green,
  yellow: pc.yellow,
  red: pc.red,
  cyan: pc.cyan,
  blue: pc.blue,
};
