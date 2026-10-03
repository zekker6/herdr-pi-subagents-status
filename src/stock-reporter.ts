import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, matchesGlob, relative, resolve } from "node:path";

// Best-effort check of herdr's conventional install location, not a second
// implementation of Pi's package discovery. Renamed/package copies need manual review.
export function stockReporterEnabled(
  extensions: readonly string[],
  agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
): string | undefined {
  const base = resolve(agentDir.replace(/^~(?=\/|$)/, homedir()));
  const stock = join(base, "extensions", "herdr-agent-state.ts");
  if (!existsSync(stock)) return;

  const exact = (pattern: string) => {
    const normalized = pattern.replace(/^\.\//, "");
    return normalized === stock || normalized === relative(base, stock);
  };
  const excluded = extensions.some((entry) => entry.startsWith("!") &&
    [stock, relative(base, stock), "herdr-agent-state.ts"].some((candidate) =>
      matchesGlob(candidate, entry.slice(1))));
  const included = extensions.some((entry) => entry.startsWith("+") && exact(entry.slice(1)));
  const disabled = extensions.some((entry) => entry.startsWith("-") && exact(entry.slice(1)));
  return !disabled && (!excluded || included) ? stock : undefined;
}
