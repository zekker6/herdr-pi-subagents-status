import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { Transpiler } from "bun";
import vm from "node:vm";
import { test } from "node:test";

// Run the actual extension without a Pi runtime or a live herdr socket.
const source = new Transpiler({ loader: "ts" }).transformSync(readFileSync(new URL("../src/herdr-status.ts", import.meta.url), "utf8"))
  .replace('import net from "node:net";', "const net = globalThis.net;")
  .replace('import { stockReporterEnabled } from "./stock-reporter.ts";', "const stockReporterEnabled = globalThis.stockReporterEnabled;")
  .replace("export default function", "globalThis.register = function");

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
};

function harness({ mode = "tui", enabled = true, idle = true, stockReporter } = {}) {
  const requests = [];
  const notifications = [];
  const handlers = new Map();
  const bus = new EventEmitter();
  const context = vm.createContext({
    process: { platform: "linux", env: enabled ? { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/unused", HERDR_PANE_ID: "test:pane" } : {} },
    setTimeout, clearTimeout, queueMicrotask,
    stockReporterEnabled: () => stockReporter,
    net: {
      createConnection() {
        const socket = new EventEmitter();
        socket.destroy = () => {};
        socket.write = text => {
          requests.push(JSON.parse(text));
          queueMicrotask(() => socket.emit("data", Buffer.from('{"result":{}}\n')));
        };
        queueMicrotask(() => socket.emit("connect"));
        return socket;
      },
    },
  });
  vm.runInContext(source, context);
  const pi = {
    getSettings: () => ({}),
    on(name, handler) { handlers.set(name, handler); },
    events: { on(name, handler) { bus.on(name, handler); return () => bus.off(name, handler); } },
  };
  context.register(pi);
  let sessionId = "root-session";
  const ctx = {
    mode,
    ui: { notify: (message, level) => notifications.push({ message, level }) },
    isIdle: () => idle,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => `/sessions/${sessionId}.jsonl`,
    },
  };
  return {
    requests, bus, ctx, notifications,
    state: () => requests.filter(r => r.method === "pane.report_agent").at(-1)?.params.state,
    async event(name, data = {}) { await handlers.get(name)?.(data, ctx); await flush(); },
    async emit(name, data) { bus.emit(name, data); await flush(); },
    setIdle(value) { idle = value; },
    setSession(value) { sessionId = value; },
  };
}

async function started(options) {
  const h = harness(options);
  await h.event("session_start", { reason: "startup" });
  return h;
}

for (const terminal of ["completed", "failed"]) {
  test(`background agent keeps parent working until ${terminal}`, async () => {
    const h = await started();
    h.setIdle(false);
    await h.event("agent_start");
    await h.emit("subagents:started", { id: "a" });
    h.setIdle(true);
    await h.event("agent_settled");
    assert.equal(h.state(), "working");
    await h.emit(`subagents:${terminal}`, { id: "a" });
    assert.equal(h.state(), "idle");
  });
}

test("concurrent agents use IDs, tolerate duplicate and unknown events, and can resume", async () => {
  const h = await started();
  for (const id of ["a", "a", "b"]) await h.emit("subagents:started", { id });
  await h.emit("subagents:failed", { id: "unknown" });
  for (let i = 0; i < 2; i++) await h.emit("subagents:completed", { id: "a" });
  assert.equal(h.state(), "working");
  await h.emit("subagents:failed", { id: "b", status: "stopped" });
  assert.equal(h.state(), "idle");
  await h.emit("subagents:started", { id: "a" });
  assert.equal(h.state(), "working");
  await h.emit("subagents:completed", { id: "a", status: "steered" });
  assert.equal(h.state(), "idle");
});

test("created does not track a cancelled queue entry or resurrect a finished agent", async () => {
  const h = await started();
  await h.emit("subagents:created", { id: "queued", isBackground: true });
  assert.equal(h.state(), "idle");
  await h.emit("subagents:started", { id: "a" });
  await h.emit("subagents:completed", { id: "a" });
  await h.emit("subagents:created", { id: "a", isBackground: true });
  assert.equal(h.state(), "idle");
});

test("queue drain keeps working while another agent starts", async () => {
  const h = await started();
  await h.emit("subagents:started", { id: "a" });
  await h.emit("subagents:created", { id: "b", isBackground: true });
  await h.emit("subagents:started", { id: "b" });
  await h.emit("subagents:completed", { id: "a" });
  assert.equal(h.state(), "working");
  await h.emit("subagents:failed", { id: "b", status: "aborted" });
  assert.equal(h.state(), "idle");
});

test("same-turn queue handoff does not report transient idle", async () => {
  const h = await started();
  await h.emit("subagents:started", { id: "a" });
  const count = h.requests.length;
  h.bus.emit("subagents:completed", { id: "a" });
  h.bus.emit("subagents:started", { id: "b" });
  await flush();
  assert.equal(h.state(), "working");
  assert.equal(h.requests.length, count);
});

test("agent completion never clears an active parent turn", async () => {
  const h = await started();
  h.setIdle(false);
  await h.event("agent_start");
  await h.emit("subagents:started", { id: "a" });
  await h.emit("subagents:failed", { id: "a" });
  await h.event("agent_settled");
  assert.equal(h.state(), "working");
  h.setIdle(true);
  await h.event("agent_settled");
  assert.equal(h.state(), "idle");
});

test("explicit blockers take priority and restore background activity when dismissed", async () => {
  const h = await started();
  await h.emit("subagents:started", { id: "a" });
  await h.emit("herdr:blocked", { active: true, label: "Confirm" });
  assert.equal(h.state(), "blocked");
  assert.equal(h.requests.at(-1).params.message, "Confirm");
  await h.emit("herdr:blocked", { active: false });
  assert.equal(h.state(), "working");
  await h.emit("subagents:completed", { id: "a" });
  assert.equal(h.state(), "idle");
});

for (const mode of ["print", "json", "rpc"]) {
  test(`${mode} sessions never report state or session identity`, async () => {
    const h = await started({ mode });
    await h.event("agent_start");
    await h.emit("subagents:started", { id: "a" });
    await h.emit("herdr:blocked", { active: true });
    await h.event("agent_settled");
    await h.event("session_shutdown");
    assert.equal(h.requests.length, 0);
  });
}

test("disabled outside herdr", async () => {
  const h = await started({ enabled: false });
  await h.event("agent_start");
  await h.emit("subagents:started", { id: "a" });
  assert.equal(h.requests.length, 0);
});

test("ignores malformed lifecycle payloads", async () => {
  const h = await started();
  for (const data of [null, undefined, {}, { id: "" }, { id: 1 }]) {
    await h.emit("subagents:started", data);
    await h.emit("subagents:failed", data);
  }
  assert.equal(h.state(), "idle");
});

test("reports root session references with increasing sequences", async () => {
  const h = await started({ idle: false });
  assert.equal(h.state(), "working");
  h.setSession("next-session");
  await h.event("agent_start");
  await h.emit("subagents:started", { id: "child-session" });
  h.setIdle(true);
  await h.event("agent_settled");
  await h.emit("subagents:completed", { id: "child-session" });
  assert.equal(h.requests.at(-1).params.agent_session_path, "/sessions/next-session.jsonl");
  let previous = 0;
  for (const request of h.requests) {
    assert.ok(request.params.seq > previous);
    previous = request.params.seq;
    assert.equal(request.params.source, "herdr:pi");
    assert.equal(request.params.agent, "pi");
    assert.equal(request.params.pane_id, "test:pane");
    assert.notEqual(request.params.agent_session_path, "/sessions/child-session.jsonl");
  }
});

test("shutdown unregisters bus listeners and ignores late completions", async () => {
  const h = await started();
  await h.emit("subagents:started", { id: "a" });
  await h.event("session_shutdown");
  const count = h.requests.length;
  await h.emit("subagents:completed", { id: "a" });
  await h.emit("subagents:started", { id: "b" });
  assert.equal(h.requests.length, count);
  assert.equal(h.bus.eventNames().length, 0);
});

test("warns when the stock reporter appears enabled without changing reporting", async () => {
  const h = await started({ stockReporter: "/profile/extensions/herdr-agent-state.ts" });
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].level, "warning");
  assert.match(h.notifications[0].message, /herdr integration uninstall pi/);
  assert.equal(h.state(), "idle");
});

test("does not warn when stock reporter is absent or disabled", async () => {
  const h = await started();
  assert.equal(h.notifications.length, 0);
});

test("session ID is the restore fallback when a session file is unavailable", async () => {
  const h = harness();
  h.ctx.sessionManager.getSessionFile = () => undefined;
  await h.event("session_start", { reason: "resume" });
  for (const request of h.requests) {
    assert.equal(request.params.agent_session_id, "root-session");
    assert.equal(request.params.agent_session_path, undefined);
  }
  assert.equal(h.requests[0].params.session_start_source, "resume");
});

test("unavailable session references do not prevent status reporting", async () => {
  const h = harness();
  h.ctx.sessionManager.getSessionFile = () => { throw new Error("unavailable"); };
  h.ctx.sessionManager.getSessionId = () => { throw new Error("unavailable"); };
  await h.event("session_start");
  assert.equal(h.requests.length, 1);
  assert.equal(h.state(), "idle");
  assert.equal(h.requests[0].params.agent_session_id, undefined);
  assert.equal(h.requests[0].params.agent_session_path, undefined);
});

