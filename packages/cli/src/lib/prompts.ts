import { input, select, confirm } from "@inquirer/prompts";
import type { CommissionType } from "../types.js";

export async function promptProgramName(): Promise<string> {
  return input({
    message: "Program name:",
    validate: (v) => (v.trim().length > 0 ? true : "Program name is required"),
  });
}

export async function promptDomain(): Promise<string> {
  return input({
    message: "Your domain (root):",
    validate: (v) => {
      const d = v.trim();
      if (!d) return "Domain is required";
      if (!d.includes(".")) return "Enter a valid domain (e.g., example.com)";
      if (d.startsWith("http")) return "Enter domain without http:// (e.g., example.com)";
      return true;
    },
    transformer: (v) => v.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, ""),
  });
}

export async function promptCommissionType(): Promise<CommissionType> {
  return select({
    message: "Commission type:",
    choices: [
      { value: "recurring_percent" as const, name: "Recurring percentage (e.g., 20% for 12 months)" },
      { value: "percent" as const, name: "One-time percentage (e.g., 20%)" },
      { value: "fixed" as const, name: "Fixed amount per sale (e.g., $50)" },
      { value: "recurring_fixed" as const, name: "Recurring fixed amount (e.g., $10/month)" },
    ],
  });
}

export async function promptCommissionRate(type: CommissionType): Promise<number> {
  const isPercent = type.includes("percent");
  return input({
    message: isPercent ? "Commission rate (%):" : "Commission amount ($):",
    default: isPercent ? "40" : undefined,
    validate: (v) => {
      const n = parseFloat(v);
      if (isNaN(n) || n <= 0) return "Enter a positive number";
      if (isPercent && n > 100) return "Percentage cannot exceed 100";
      return true;
    },
    transformer: (v) => v.trim(),
  }).then((v) => parseFloat(v));
}

export async function promptDurationMonths(): Promise<number> {
  return input({
    message: "Commission duration (months, 0 = lifetime):",
    default: "12",
    validate: (v) => {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < 0) return "Enter 0 or a positive number";
      return true;
    },
  }).then((v) => parseInt(v, 10));
}

export async function promptCookieDuration(): Promise<number> {
  return input({
    message: "Cookie duration (days):",
    default: "90",
    validate: (v) => {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < 1) return "Enter a positive number";
      if (n > 365) return "Maximum 365 days";
      return true;
    },
  }).then((v) => parseInt(v, 10));
}

export async function confirmAction(message: string): Promise<boolean> {
  return confirm({ message, default: true });
}
