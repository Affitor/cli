import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "dotenv";

const ENV_NAMES = [".env", ".env.local", ...["production", "development", "test"].flatMap(mode => [`.env.${mode}`, `.env.${mode}.local`])];
type Reason = "certain" | "no_runtime_key" | "unknown_layer" | "unreadable_layer" | "duplicate_assignment" | "conflicting_keys";
export interface ProjectEnvironment { envName: string; hasTargetKey: boolean; certain: boolean; reason: Reason }

// Only assignment boundaries are shared with the pinned dotenv parser so duplicate
// counting respects quoted multiline values. Values always come from dotenv.parse.
// Grammar from dotenv17.3.1; the required redistribution notice follows.
/*
Copyright (c) 2015, Scott Motte
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/
const DOTENV_ASSIGNMENT = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/mg;

export function inspectProjectEnvironment(cwd: string, expectedKey: string): ProjectEnvironment {
  const envName = existsSync(join(cwd, ".env.local")) ? ".env.local" : ".env";
  const result = (reason: Reason, hasTargetKey = false): ProjectEnvironment => ({ envName, hasTargetKey, certain: reason === "certain", reason });
  let names: string[];
  try { names = readdirSync(cwd); } catch { return result("unreadable_layer"); }
  // No inference about custom loaders, templates or nonstandard runtime modes.
  if (names.some(name => name.toLowerCase().startsWith(".env") && !ENV_NAMES.includes(name))) return result("unknown_layer");
  const keys: string[] = [];
  if (process.env.AFFITOR_API_KEY !== undefined) keys.push(process.env.AFFITOR_API_KEY);
  let hasTargetKey = false;
  for (const name of ENV_NAMES) {
    let text: string;
    try {
      const path = join(cwd, name);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) return result("unreadable_layer");
      const bytes = readFileSync(path);
      text = bytes.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(bytes)) return result("unreadable_layer");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return result("unreadable_layer");
    }
    const normalized = text.replace(/\r\n?/g, "\n");
    const assignments = [...normalized.matchAll(DOTENV_ASSIGNMENT)].filter(match => match[1] === "AFFITOR_API_KEY");
    if (assignments.length > 1) return result("duplicate_assignment");
    const values = parse(text);
    if (Object.hasOwn(values, "AFFITOR_API_KEY")) {
      keys.push(values.AFFITOR_API_KEY);
      if (name === envName) hasTargetKey = true;
    }
  }
  if (!keys.length) return result("no_runtime_key");
  if (keys.some(key => !/^[A-Za-z0-9_-]+$/.test(key)) || new Set(keys).size !== 1 || keys[0] !== expectedKey) return result("conflicting_keys", hasTargetKey);
  return result("certain", hasTargetKey);
}
