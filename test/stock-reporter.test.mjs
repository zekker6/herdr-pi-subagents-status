import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stockReporterEnabled } from "../src/stock-reporter.ts";

test("detects the stock install and respects Pi's exclusion precedence", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-stock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stock = join(dir, "extensions", "herdr-agent-state.ts");
  assert.equal(stockReporterEnabled([], dir), undefined);
  mkdirSync(join(dir, "extensions"));
  writeFileSync(stock, "// stock reporter\n");
  assert.equal(stockReporterEnabled([], dir), stock);
  assert.equal(stockReporterEnabled(["-extensions/herdr-agent-state.ts"], dir), undefined);
  assert.equal(stockReporterEnabled(["-./extensions/herdr-agent-state.ts"], dir), undefined);
  assert.equal(stockReporterEnabled([`-${stock}`], dir), undefined);
  assert.equal(stockReporterEnabled(["!**/herdr-agent-state.ts"], dir), undefined);
  assert.equal(stockReporterEnabled(["!herdr-agent-state.ts"], dir), undefined);
  assert.equal(stockReporterEnabled(["!**/*.ts", "+extensions/herdr-agent-state.ts"], dir), stock);
  assert.equal(stockReporterEnabled(["+extensions/herdr-agent-state.ts", "-extensions/herdr-agent-state.ts"], dir), undefined);
  assert.equal(stockReporterEnabled(["-extensions/something-else.ts"], dir), stock);
});

test("uses the isolated Pi profile instead of the default home directory", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-profile-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.PI_CODING_AGENT_DIR = dir;
  mkdirSync(join(dir, "extensions"));
  const stock = join(dir, "extensions", "herdr-agent-state.ts");
  writeFileSync(stock, "// stock reporter\n");
  assert.equal(stockReporterEnabled([]), stock);
});
