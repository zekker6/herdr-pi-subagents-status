import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url));

test("packed package installs and loads under Bun in a clean Pi profile", { timeout: 30_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-install-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const agentDir = join(dir, "profile");
  const cwd = join(dir, "project");
  mkdirSync(cwd);
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    PI_SKIP_VERSION_CHECK: "1",
    HERDR_ENV: "0",
    HERDR_SOCKET_PATH: "",
    HERDR_PANE_ID: "",
  };
  const tarball = join(dir, "package.tgz");
  execFileSync(process.execPath, ["pm", "pack", "--filename", tarball, "--ignore-scripts", "--quiet"], {
    cwd: root, env, timeout: 15_000,
  });
  const files = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8", timeout: 15_000 })
    .trim().split("\n").map((file) => file.replace(/^package\//, ""));
  for (const required of ["src/herdr-status.ts", "src/stock-reporter.ts", "LICENSE", "NOTICE", "README.md", "package.json"]) {
    assert.ok(files.includes(required), `missing ${required}`);
  }
  assert.ok(files.every((file) => !file.startsWith("node_modules/") && !file.startsWith("test/")));
  execFileSync("tar", ["-xzf", tarball, "-C", dir]);
  const packageDir = join(dir, "package");
  execFileSync(process.execPath, [cli, "install", packageDir], { cwd, env, timeout: 15_000 });
  const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
  assert.deepEqual(settings.packages.map((source) => resolve(agentDir, source)), [packageDir]);

  // Load in a subprocess so Pi's environment-derived paths cannot leak across tests.
  const sdk = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/index.js", import.meta.url).href;
  execFileSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { DefaultResourceLoader } from ${JSON.stringify(sdk)};
    assert.ok(process.versions.bun, "Pi must load under Bun");
    const loader = new DefaultResourceLoader({
      cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR,
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await loader.reload();
    const { extensions, errors } = loader.getExtensions();
    assert.deepEqual(errors, []);
    assert.equal(extensions.length, 1);
    assert.equal(extensions[0].path, ${JSON.stringify(join(packageDir, "src", "herdr-status.ts"))});
    assert.ok(extensions[0].handlers.has("session_start"));
    assert.ok(extensions[0].handlers.has("agent_settled"));
    assert.ok(extensions[0].handlers.has("session_shutdown"));
  `], {
    cwd,
    env: { ...env, HERDR_ENV: "1", HERDR_SOCKET_PATH: join(dir, "unused.sock"), HERDR_PANE_ID: "test:pane" },
    timeout: 15_000,
    stdio: "pipe",
  });
});
