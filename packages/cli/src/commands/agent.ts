import type { Command } from "commander";
import { checkbox, confirm } from "@inquirer/prompts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CLIENTS, applySetup, callerClient, doctor, planSetup, selectedClients } from "../lib/agent-setup.js";
import { getFlags } from "../lib/flags.js";

interface SetupOptions { client?: string[]; dryRun?: boolean; yes?: boolean }

export function registerAgentCommands(program: Command) {
  program.command("agent").description("Configure an AI coding agent for this project")
    .command("setup")
    .description("Preview and install project-scoped MCP configuration and an Affitor skill")
    .option("--client <name>", "claude_code, cursor or codex (repeat to select)", (value: string, prior: string[]) => [...prior, value], [])
    .option("--dry-run", "Show the plan without writing files")
    .option("--yes", "Apply the selected client's plan")
    .action(async (opts: SetupOptions, cmd: Command) => {
      const flags = getFlags(cmd);
      try {
        let clients = selectedClients(opts.client ?? [], process.env);
        const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && !flags.noInteractive && !flags.json);
        if (!clients.length && interactive && !opts.dryRun) {
          clients = selectedClients(await checkbox({
            message: "Which agents should get Affitor in this project?",
            choices: CLIENTS.map(value => ({ value, name: `${value}${existsSync(join(process.cwd(), value === "claude_code" ? ".claude" : value === "cursor" ? ".cursor" : ".agents")) ? " (project directory found)" : ""}`, checked: false })),
          }), process.env);
        }
        const plan = planSetup(process.cwd(), clients);
        // Never serialize plan.actions.content: existing configs can contain
        // unrelated credentials that must stay local, including in a dry-run.
        const preview = {
          project: plan.project, clients, caller: callerClient(process.env) ?? null,
          entry: plan.entry, mcpVersion: plan.mcpVersion,
          actions: plan.actions.map(({ path, operation, backup }) => ({ path, operation, backup })),
          manual: plan.manual,
        };
        let status = opts.dryRun ? "planned" : "needs_confirmation";
        if (!flags.json) process.stdout.write(JSON.stringify(preview, null, 2) + "\n");
        let approved = Boolean(opts.yes || flags.autoConfirm);
        if (!opts.dryRun && clients.length && !approved && interactive) {
          approved = await confirm({ message: "Apply this plan? Existing files are backed up first.", default: false });
        }
        if (!opts.dryRun && approved && clients.length) {
          applySetup(plan);
          status = "needs_human";
        }
        const next = !clients.length
          ? "Select --client claude_code, cursor or codex. Detected agents are not selected automatically."
          : status === "needs_confirmation"
            ? "Review the plan, then run affitor agent setup --client <name> --yes."
            : "Installed is not verified. Configure the program key privately as AFFITOR_API_KEY or in .affitor/.env; restart the selected agent, then ask it to call affitor_readiness. For Codex, first follow the printed manual configuration instructions.";
        if (flags.json) process.stdout.write(JSON.stringify({ status, ...preview, next }) + "\n");
        else process.stdout.write(`${status}\n${next}\n`);
        process.exitCode = status === "needs_confirmation" || (!clients.length && !opts.dryRun) ? 1 : 0;
      } catch (error) {
        // Expected installer errors contain only fixed messages and relative
        // client paths. Do not print arbitrary fs/JSON/credential exceptions.
        const message = error instanceof Error && /^(Unknown client|An agent can only|\.mcp\.json |\.cursor\/mcp\.json |Setup failed|A setup file|Unsafe setup|Setup target)/.test(error.message)
          ? error.message : "Agent setup could not finish. Check the project paths and run a fresh dry-run.";
        process.stdout.write(JSON.stringify({ status: "error", message }) + "\n");
        process.exitCode = 1;
      }
    });

  program.command("doctor").description("Read-only static check of local agent configuration; does not verify a running session")
    .option("--client <name>", "Check one client (repeat to select)", (value: string, prior: string[]) => [...prior, value], [])
    .action((opts: SetupOptions, cmd: Command) => {
      try {
        const clients = selectedClients(opts.client ?? [], process.env);
        const configured = CLIENTS.filter(client => client !== "codex" && existsSync(join(process.cwd(), client === "claude_code" ? ".mcp.json" : ".cursor/mcp.json")));
        const results = doctor(process.cwd(), clients.length ? clients : configured.length ? configured : ["claude_code", "cursor"]);
        const healthy = results.every(result => result.status === "aligned" && result.credential === "present_unverified");
        const result = { status: healthy ? "aligned" : "needs_attention", mode: "static", clients: results, next: "Restart the selected agent and call affitor_readiness. Static checks do not prove a live connection or integration readiness." };
        if (getFlags(cmd).json) process.stdout.write(JSON.stringify(result) + "\n");
        else process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        process.exitCode = healthy ? 0 : 1;
      } catch {
        process.stdout.write(JSON.stringify({ status: "error", message: "Doctor could not check the selected client. Use claude_code, cursor or codex." }) + "\n");
        process.exitCode = 1;
      }
    });
}
