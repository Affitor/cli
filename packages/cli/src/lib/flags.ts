import type { Command } from "commander";
import type { CLIFlags } from "../types.js";

/**
 * Walk up the command chain to the root program and read global flags.
 */
export function getFlags(cmd: Command): CLIFlags {
  let root = cmd;
  while (root.parent) {
    root = root.parent;
  }
  const opts = root.opts();
  return {
    json: opts.json ?? false,
    noInteractive: opts.interactive === false,
    autoConfirm: opts.autoConfirm ?? false,
    quiet: opts.quiet ?? false,
    apiKey: opts.apiKey,
    apiUrl: opts.apiUrl,
    verbose: opts.verbose ?? false,
  };
}
