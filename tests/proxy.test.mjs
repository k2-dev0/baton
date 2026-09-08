import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { test, vi } from "vitest";
import {
  JsonLineDecoder,
  MemoryDiagnostics,
  MemoryStateStore,
  RouterEngine,
  runAppServerProxy,
  recordControlMessage,
} from "../src/proxy.mjs";
import {
  isRepositoryEnabled,
  validateConfig,
} from "../src/policy.mjs";
import { protocol, schemaCommand } from "./fixtures/protocol.mjs";
import { createSwitchRequest } from "../src/switch-config.mjs";

const repository = "/Users/test/project";
const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// 公開CLI入口を使い、推論を起動しない互換性検査用の実行環境を作る。
function compatibilityFixture({ schema = protocol, script = "", version = "9.999.0" } = {}) {
  const temporary = mkdtempSync(path.join(tmpdir(), "baton-compatibility-"));
  const fakeCodex = path.join(temporary, "codex");
  const calls = path.join(temporary, "calls.jsonl");
  const configPath = path.join(temporary, "config.json");
  const config = { ...makeConfig(), innerCodexPath: fakeCodex };
  writeFileSync(configPath, JSON.stringify(config));
  const fakePgrep = path.join(temporary, "pgrep");
  writeFileSync(fakePgrep, "#!/bin/sh\nexit 1\n");
  chmodSync(fakePgrep, 0o755);
  writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv[2] === "--version") { console.log(${JSON.stringify(`codex-cli ${version}`)}); process.exit(0); }
${script}
if (process.argv[3] !== "generate-json-schema") process.exit(99);
fs.writeFileSync(require("node:path").join(process.argv[process.argv.indexOf("--out") + 1], "codex_app_server_protocol.schemas.json"), ${JSON.stringify(JSON.stringify(schema))});
`);
  chmodSync(fakeCodex, 0o755);
  const env = { ...process.env, PATH: `${temporary}:${process.env.PATH}`, CODEX_BATON_CONFIG: configPath, CODEX_BATON_INNER_CODEX: fakeCodex,
    CODEX_AUTO_CODEX_BIN: fakeCodex, CODEX_BATON_STATE_DIR: temporary };
  const run = (args = ["--router-check"], launcher = false) => spawnSync(launcher ? path.join(repositoryRoot, "bin/baton") : process.execPath,
    launcher ? args : [path.join(repositoryRoot, "src/proxy.mjs"), ...args], { env, encoding: "utf8", timeout: 15_000 });
  return { run, calls, configPath };
}

test("互換性検査は版の登録なしで新しいCodexを受け入れ、タスクを作らない", () => {
  const { run, calls } = compatibilityFixture();
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
  const invocations = readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(invocations.map((args) => args.slice(0, 2)), [["--version"], ["app-server", "generate-json-schema"]]);
  assert.equal(invocations[1].includes("--experimental"), true);
  assert.equal(existsSync(invocations[1][invocations[1].indexOf("--out") + 1]), false);
});

test("互換性検査は旧バージョン一覧が残っていても版番号で拒否しない", () => {
  const { run, configPath } = compatibilityFixture();
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.supportedCliVersions = ["0.0.0"];
  writeFileSync(configPath, JSON.stringify(config));
  assert.equal(run().status, 0);
});

test("互換性検査では版番号を読めなくても取得できた通信仕様で判定する", () => {
  const result = compatibilityFixture({ version: "" }).run();
  assert.deepEqual({ status: result.status, cliVersion: JSON.parse(result.stdout).cliVersion }, { status: 0, cliVersion: null });
});

test.each([
  ["必須操作", (s) => { s.definitions.ClientRequest.oneOf = s.definitions.ClientRequest.oneOf.filter((m) => !m.properties.method.enum.includes("turn/interrupt")); }, /turn\/interrupt/],
  ["続行入力", (s) => { delete s.definitions.v2.TurnStartParams.properties.toolOutput; }, /toolOutput/],
  ["続行入力の型", (s) => { s.definitions.v2.TurnStartParams.properties.input = { type: "number" }; }, /turn\/start.input/],
  ["応答", (s) => { delete s.definitions.v2.ThreadResumeResponse.properties.model; }, /ThreadResumeResponse.model/],
  ["完了状態", (s) => { s.definitions.v2.TurnStartResponse.properties.turn.properties.status.enum = ["finished"]; }, /turn status/],
  ["循環参照", (s) => { s.definitions.v2.TurnStartParams = { $ref: "#/definitions/v2/TurnStartParams" }; }, /cycle/],
  ["通知", (s) => { s.definitions.ServerNotification.oneOf = []; }, /thread\/started/],
  ["未知の必須入力", (s) => { s.definitions.v2.ThreadSettingsUpdateParams.required.push("newRequiredInput"); }, /newRequiredInput/],
  ["任意入力の必須化", (s) => { s.definitions.v2.ThreadSettingsUpdateParams.required.push("collaborationMode"); }, /collaborationMode/],
])("互換性検査は%sの欠落・変更を拒否する", (_label, mutate, reason) => {
  const schema = structuredClone(protocol);
  mutate(schema);
  const { run } = compatibilityFixture({ schema });
  const result = run();
  assert.equal(result.status, 2, result.stderr);
  assert.match(JSON.parse(result.stdout).reason, reason);
});

test.each([
  ["取得失敗", "process.exit(1);", /schema generation failed/],
  ["時間切れ", 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);', /timed out/],
  ["不正JSON", 'fs.writeFileSync(require("node:path").join(process.argv[process.argv.indexOf("--out") + 1], "codex_app_server_protocol.schemas.json"), "{"); process.exit(0);', /JSON/],
])("互換性検査は%sで理由を返す", (_label, script, reason) => {
  const result = compatibilityFixture({ script }).run();
  assert.equal(result.status, 2, result.stderr);
  assert.match(JSON.parse(result.stdout).reason, reason);
}, 15_000);

test.each([["直接中継", ["app-server"], false], ["CLI", [], true], ["Desktop", ["app"], true]])("互換性のない%sはサーバー起動前に拒否する", (_label, args, launcher) => {
  const { run, calls } = compatibilityFixture({ schema: {} });
  const result = run(args, launcher);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /incompatible|schema|protocol/i);
  assert.equal(readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse).some((call) => call[0] === "app-server" && call[1] !== "generate-json-schema"), false);
});

test.runIf(process.env.BATON_LIVE === "1")("実機で同一タスクのSol→Astra→Solと同じモデルの設定変更を追加入力なしに続行する", async () => {
  const temporary = mkdtempSync("/private/tmp/baton-live-");
  const innerCodexPath = process.env.BATON_TEST_CODEX ?? "/Applications/ChatGPT.app/Contents/Resources/codex";
  const configPath = path.join(temporary, "config.json");
  writeFileSync(configPath, JSON.stringify(makeConfig({ innerCodexPath, enabledRepositories: [temporary], maxBufferedBytes: 32 * 1024 * 1024,
  })));
  const child = spawn(process.execPath, [path.join(repositoryRoot, "src/proxy.mjs"), "app-server", "--listen", "stdio://"], {
    cwd: temporary, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CODEX_CLI_PATH: "", CODEX_BATON_CONFIG: configPath, CODEX_BATON_STATE_DIR: path.join(temporary, "router") },
  });
  const pending = new Map();
  const events = [];
  const switches = [];
  let lastModel = "gpt-5.6-sol";
  let sequence = 0;
  let stderr = "";
  let testThread = null;
  let finish;
  let fail;
  const completed = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  completed.catch(() => {});
  child.stderr.on("data", (data) => { stderr += data; });
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    events.push(message);
    if (!message.method && pending.has(message.id)) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    }
    if (message.method === "thread/settings/updated" && message.params.threadSettings.model !== lastModel) {
      lastModel = message.params.threadSettings.model;
      switches.push({ threadId: message.params.threadId, model: message.params.threadSettings.model });
    }
    if (message.method === "turn/completed" && message.params.turn.status !== "interrupted") {
      finish(message.params);
    }
    if (message.method && message.id !== undefined) {
      fail(new Error(`Unexpected server request: ${message.method}`));
    }
  });
  const timeout = setTimeout(() => fail(new Error(`Live test timed out: ${stderr.slice(-2000)}`)), 180_000);
  try {
    await send("initialize", { clientInfo: { name: "baton_live_test", version: "0.1.0" }, capabilities: { experimentalApi: true } });
    child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    const started = await send("thread/start", {
      model: "gpt-5.6-sol", cwd: temporary, ephemeral: false, experimentalRawEvents: true,
      developerInstructions: "This is a model-switch integration test. Do not use any tools except switch_model. Follow the user's four ordered steps exactly.",
    });
    testThread = started.thread;
    await send("turn/start", { threadId: started.thread.id, effort: "high", summary: "auto", personality: "pragmatic", input: [{ type: "text", text: 'Do exactly these steps, in order: 1. Call switch_model({"model":"gpt-6-astra","config":{"effort":"high","summary":"concise","personality":"friendly"}}) and await its result. 2. Then call switch_model({"model":"gpt-5.6-sol","config":{"effort":"high","summary":"auto","personality":"pragmatic"}}) and await its result. 3. Then call switch_model({"model":"gpt-5.6-sol","config":{"effort":"high","personality":"friendly"}}) to change settings on the same model and await its result. 4. Respond with exactly BATON_LIVE_OK. Do not call tools in parallel. Do not do anything else.' }] });
    const result = await completed;
    writeFileSync(path.join(temporary, "events.json"), JSON.stringify(events, null, 2), { mode: 0o600 });
    console.log("Live evidence:", temporary, JSON.stringify(switches));
    console.log("Runtime history:", testThread.path);
    assert.deepEqual({
      models: switches.map((entry) => entry.model),
      sameTask: switches.every((entry) => entry.threadId === started.thread.id),
      status: result.turn.status,
      finished: events.some((event) => event.method === "item/completed" && event.params.item.type === "agentMessage" && event.params.item.text.includes("BATON_LIVE_OK")),
    }, { models: ["gpt-6-astra", "gpt-5.6-sol"], sameTask: true, status: "completed", finished: true });
    if (testThread.path) {
      const rollout = readFileSync(testThread.path, "utf8");
      writeFileSync(path.join(temporary, "rollout.jsonl"), rollout, { mode: 0o600 });
      const contexts = rollout.trim().split("\n").map(JSON.parse).filter((entry) => entry.type === "turn_context");
      assert.deepEqual(contexts.map((entry) => [entry.payload.model, entry.payload.effort]), [["gpt-5.6-sol", "high"], ["gpt-6-astra", "high"], ["gpt-5.6-sol", "high"], ["gpt-5.6-sol", "high"]]);
      assert.deepEqual(contexts.map((entry) => entry.payload.personality), ["pragmatic", "friendly", "pragmatic", "friendly"]);
      assert.ok(events.some((entry) => entry.method === "thread/settings/updated" && entry.params.threadSettings.model === "gpt-6-astra" && entry.params.threadSettings.summary === "concise"), "Codex acknowledged the additional summary setting; effective reasoning summaries remain model-dependent");
      const responseTurns = events.filter((entry) => entry.method === "rawResponse/completed" ||
        (entry.method === "rawResponseItem/completed" && ["custom_tool_call", "function_call"].includes(entry.params.item.type))).map((entry) => entry.params.turnId);
      assert.ok(contexts.every((entry) => responseTurns.includes(entry.payload.turn_id)), "each actual model context produced an upstream response");
    } else assert.fail("Native runtime history was unavailable");
    await send("thread/unsubscribe", { threadId: started.thread.id });
    const resumed = await send("thread/resume", { threadId: started.thread.id });
    assert.equal(resumed.thread.id, started.thread.id);
    assert.equal(resumed.model, "gpt-5.6-sol");
  } finally {
    clearTimeout(timeout);
    writeFileSync(path.join(temporary, "events.json"), JSON.stringify(events, null, 2), { mode: 0o600 });
    if (testThread) await send("thread/archive", { threadId: testThread.id }).catch(() => {});
    child.stdin.end();
    child.kill("SIGTERM");
    writeFileSync(path.join(temporary, "stderr.txt"), stderr, { mode: 0o600 });
  }
}, 200_000);

function makeConfig(overrides = {}) {
  return validateConfig({
    schemaVersion: 2,
    enabledRepositories: [repository],
    innerCodexPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
    desktopAppPath: "/Applications/ChatGPT.app",
    maxBufferedBytes: 1024 * 1024,
    ...overrides,
  });
}

function makeEngine(config = makeConfig(), { compatible = true } = {}) {
  const diagnostics = new MemoryDiagnostics();
  const stateStore = new MemoryStateStore();
  const engine = new RouterEngine({ config, diagnostics, stateStore, compatible, switchRequest: createSwitchRequest(protocol) });
  engine.setModelCatalog([
    {
      model: "gpt-5.6-sol",
      supportedReasoningEfforts: [
        { reasoningEffort: "high" },
        { reasoningEffort: "xhigh" },
      ],
    },
    {
      model: "gpt-6-astra",
      supportedReasoningEfforts: [
        { reasoningEffort: "high" },
        { reasoningEffort: "xhigh" },
      ],
    },
  ]);
  return { diagnostics, engine, stateStore };
}

function announceThread(engine, id, options = {}) {
  engine.processServerMessage({
    method: "thread/started",
    params: {
      thread: {
        id,
        parentThreadId: options.parentThreadId ?? null,
        cwd: options.cwd ?? repository,
        model: options.model ?? "gpt-5.6-terra",
        reasoningEffort: options.effort ?? "medium",
        status: options.status ?? { type: "idle" },
      },
    },
  });
}

function turnRequest(id, threadId, overrides = {}) {
  return {
    method: "turn/start",
    id,
    params: {
      threadId,
      input: [{ type: "text", text: "Implement the change" }],
      cwd: repository,
      approvalPolicy: "unlessTrusted",
      sandboxPolicy: { type: "workspaceWrite" },
      ...overrides,
    },
  };
}

test("分割到着と複数同時到着のJSON行を復元する", () => {
  const lines = [];
  const decoder = new JsonLineDecoder({ maxBufferedBytes: 1024, onLine: (line) => lines.push(line) });
  decoder.push(Buffer.from('{"id":1'));
  decoder.push(Buffer.from('}\n{"id":2}\r\n{"id"'));
  decoder.end(Buffer.from(":3}"));
  assert.deepEqual(lines.map(JSON.parse), [{ id: 1 }, { id: 2 }, { id: 3 }]);
});

test("上限を超えるプロトコル行を拒否する", () => {
  const decoder = new JsonLineDecoder({ maxBufferedBytes: 8, onLine() {} });
  assert.throws(() => decoder.push(Buffer.from("123456789")), /exceeds 8 bytes/);
});

test("共通接頭辞を持つ別リポジトリを対象に含めない", () => {
  assert.equal(isRepositoryEnabled(repository, [repository]), true);
  assert.equal(isRepositoryEnabled(`${repository}/src`, [repository]), true);
  assert.equal(isRepositoryEnabled(`${repository}-other`, [repository]), false);
  assert.equal(isRepositoryEnabled("relative/path", [repository]), false);
});

test("モデル定義なしで起動し、通常要求の未指定設定を補完しない", () => {
  const { engine } = makeEngine();
  announceThread(engine, "main", { model: "gpt-5.6-sol" });
  const request = turnRequest("start", "main", { model: "gpt-5.6-sol" });
  assert.deepEqual(engine.processClientMessage(request), { type: "forward", message: request, modified: false });
});

test("設定未登録のモデルもCodexのカタログにあれば切り替えられる", () => {
  const { engine, call } = beginSwitchTest();
  engine.setModelCatalog([{ model: "new-model", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }]);
  call.params.arguments.model = "new-model";
  const interrupt = switch_model(engine, call).upstream[0];
  engine.processServerMessage({ id: interrupt.id, result: {} });
  const settings = engine.processServerMessage({ method: "turn/completed", params: { threadId: "main", turn: { id: "old-turn", status: "interrupted" } } }).upstream[0];
  const continuation = engine.processServerMessage({ id: settings.id, result: {} }).upstream[0];
  assert.deepEqual([settings, continuation].map((request) => [request.params.threadId, request.params.model, request.params.effort]),
    [["main", "new-model", "high"], ["main", "new-model", "high"]]);
});

test("カタログを取得できない場合は切り替えず、元の実行を保持する", () => {
  const { engine, call } = beginSwitchTest();
  engine.setModelCatalogUnavailable("catalog unavailable");
  const action = engine.processServerMessage(call);
  assert.deepEqual({ success: action.upstream[0]?.result?.success, active: engine.threads.main.activeTurnId, switching: engine.switches.size },
    { success: false, active: "old-turn", switching: 0 });
});

test("追加ツールと実験機能を既存の指示・ツール・通知設定を壊さず登録する", () => {
  const { engine } = makeEngine();
  const initialized = engine.processClientMessage({ id: 1, method: "initialize", params: { capabilities: { optOutNotificationMethods: ["irrelevant"] } } });
  const existing = { type: "function", name: "existing", description: "keep", inputSchema: {} };
  const action = engine.processClientMessage({ id: 2, method: "thread/start", params: { cwd: repository, dynamicTools: [existing], developerInstructions: "keep instructions" } });
  assert.deepEqual({
    experimental: initialized.message.params.capabilities.experimentalApi,
    notifications: initialized.message.params.capabilities.optOutNotificationMethods,
    first: action.message.params.dynamicTools[0],
    added: action.message.params.dynamicTools.at(-1).name,
    instructions: action.message.params.developerInstructions,
    required: action.message.params.dynamicTools.at(-1).inputSchema.required,
  }, { experimental: true, notifications: ["irrelevant"], first: existing, added: "switch_model", instructions: "keep instructions", required: ["model", "config"] });
});

function beginSwitchTest(options = {}) {
  const context = makeEngine(options.config);
  const { engine } = context;
  announceThread(engine, "main", { model: "gpt-5.6-sol", ...options });
  const params = { model: "gpt-5.6-sol", effort: "high", outputSchema: { type: "object" },
    collaborationMode: { mode: "default", settings: { model: "gpt-5.6-sol", reasoning_effort: "high", developer_instructions: "keep mode instructions" } },
    ...options.params };
  engine.processClientMessage(turnRequest("begin", "main", params));
  engine.processServerMessage({ id: "begin", result: { turn: { id: "old-turn", status: "inProgress" } } });
  const call = { id: "tool-call", method: "item/tool/call", params: { threadId: "main", turnId: "old-turn", callId: "switch-item", namespace: null, tool: "switch_model", arguments: { model: "gpt-6-astra", config: { effort: "high" } } } };
  return { ...context, call };
}

function switch_model(engine, call) {
  const result = engine.processServerMessage(call);
  if (result.upstream[0]?.method !== "thread/backgroundTerminals/list") return result;
  const reply = engine.processServerMessage({ id: result.upstream[0].id, result: { data: [], nextCursor: null } });
  if (!reply.waitFor) return reply;
  return engine.processServerMessage({ method: "item/completed", params: { threadId: call.params.threadId, turnId: call.params.turnId,
    item: { id: call.params.callId, type: "dynamicToolCall", status: "completed", success: true } } });
}

test("切り替えツールへ一度応答し、Codexの完了通知まで中断しない", () => {
  const { engine, call, diagnostics } = beginSwitchTest();
  announceThread(engine, "other", { model: "gpt-5.6-sol" });
  const otherBefore = structuredClone(engine.threads.other);
  const inspect = engine.processServerMessage(call).upstream[0];
  const reply = engine.processServerMessage({ id: inspect.id, result: { data: [], nextCursor: null } });
  assert.equal(reply.upstream.length, 1);
  assert.equal(reply.upstream[0].id, call.id);
  assert.equal(JSON.parse(reply.upstream[0].result.contentItems[0].text).status, "pending");
  assert.equal(reply.upstream[0].method, undefined);
  assert.equal(reply.waitFor.length, 1);
  const done = { method: "item/completed", params: { threadId: "main", turnId: "old-turn",
    item: { id: call.params.callId, type: "dynamicToolCall", status: "completed", success: true } } };
  assert.equal(engine.processServerMessage({ ...done, params: { ...done.params, turnId: "unrelated-turn" } })?.upstream?.length ?? 0, 0);
  assert.equal(engine.switches.get("main").phase, "settle", "別ターンの通知では待機を解除しない");
  const action = engine.processServerMessage(done);
  assert.equal(action.consume, false);
  assert.equal(action.upstream[0].method, "turn/interrupt");
  assert.equal(engine.processServerMessage(done)?.upstream?.length ?? 0, 0);
  const failure = engine.processServerMessage({ id: action.upstream[0].id, error: { code: -1, message: "cannot interrupt" } });
  assert.equal(failure.upstream.length, 0, "応答済みのツールへ二重応答しない");
  assert.match(failure.downstream[0].params.error.message, /cannot interrupt/);
  assert.deepEqual(engine.threads.other, otherBefore);
  assert.equal(diagnostics.events.some(e => e.event === "switch-accepted"), false);
});

test.each(["stop", "other-work", "failed", "timeout", "turn-end"])("ツール応答後の%sは未応答中断や勝手な続行を起こさない", (race) => {
  const { engine, call } = beginSwitchTest();
  const inspect = engine.processServerMessage(call).upstream[0];
  const reply = engine.processServerMessage({ id: inspect.id, result: { data: [], nextCursor: null } });
  if (race === "stop") engine.processClientMessage({ id: "stop", method: "turn/interrupt", params: { threadId: "main", turnId: "old-turn" } });
  if (race === "other-work") engine.processServerMessage({ method: "item/started", params: { threadId: "main", turnId: "old-turn", item: { id: "command", type: "commandExecution" } } });
  const event = race === "timeout" ? { id: reply.waitFor[0].id, error: { code: -1, message: "baton: item/completed timed out" } }
    : race === "turn-end" ? { method: "turn/completed", params: { threadId: "main", turn: { id: "old-turn", status: "completed" } } }
    : { method: "item/completed", params: { threadId: "main", turnId: "old-turn", item: { id: call.params.callId, type: "dynamicToolCall",
      status: race === "failed" ? "failed" : "completed", success: race !== "failed" } } };
  const result = engine.processServerMessage(event);
  assert.equal(result.upstream.length, 0);
  assert.equal(result.downstream[0].method, "error");
  assert.equal(engine.switches.size, 0);
  assert.equal(engine.pending.size, 0);
});

test("制御ログは発行元と識別子を区別し、本文・設定・認証情報を保存しない", () => {
  const diagnostics = new MemoryDiagnostics();
  const message = { id: "request", method: "turn/interrupt", params: {
    threadId: "main", turnId: "turn", input: "SECRET", authorization: "SECRET", config: { secret: "SECRET" },
  } };
  for (const source of ["client", "baton"]) recordControlMessage(diagnostics, source, message);
  recordControlMessage(diagnostics, "client", { ...message, method: "account/login/start" });
  assert.deepEqual(diagnostics.events, ["client", "baton"].map(source => ({
    event: "control-request", source, method: "turn/interrupt", requestId: "request", threadId: "main", turnId: "turn",
  })));
  assert.ok(!JSON.stringify(diagnostics.events).includes("SECRET"));
});

test.each(["response-first", "notification-first"])("連続切り替えは内部中断を表示せず、旧通知と利用者の停止を区別する: %s", (order) => {
  const { engine, call, diagnostics } = beginSwitchTest();
  const stale = [];
  let activeTurn = "old-turn";
  for (const [index, model, effort] of [[0, "gpt-6-astra", "high"], [1, "gpt-5.6-sol", "high"], [2, "gpt-5.6-sol", "xhigh"]]) {
    const request = structuredClone(call);
    request.id = `tool-${index}`;
    request.params.turnId = activeTurn;
    request.params.arguments = { model, config: { effort } };
    const interrupt = switch_model(engine, request).upstream[0];
    const response = { id: interrupt.id, result: {} };
    const notification = { method: "turn/completed", params: { threadId: "main", turn: { id: activeTurn, status: "interrupted" } } };
    const pair = order === "response-first" ? [response, notification] : [notification, response];
    const first = engine.processServerMessage(pair[0]);
    const second = engine.processServerMessage(pair[1]);
    assert.equal(first.upstream.length, 0);
    assert.equal((order === "response-first" ? second : first).consume, true, "内部中断は表示しない");
    const settings = second.upstream[0];
    const start = engine.processServerMessage({ id: settings.id, result: {} }).upstream[0];
    assert.deepEqual([settings.method, start.method], ["thread/settings/update", "turn/start"]);
    assert.deepEqual([settings, start].map(r => [r.params.threadId, r.params.model, r.params.effort]),
      [["main", model, effort], ["main", model, effort]]);
    activeTurn = `new-${index}`;
    const started = { id: start.id, result: { turn: { id: activeTurn, status: "inProgress" } } };
    engine.processServerMessage(started);
    assert.notEqual(engine.processServerMessage({ method: "turn/started", params: { threadId: "main", turn: started.result.turn } })?.consume, true);
    stale.push(response, notification, started);
    for (const old of stale) {
      const replayed = engine.processServerMessage(old);
      assert.equal(replayed?.upstream?.length ?? 0, 0);
      if (old.method === "turn/completed") assert.equal(replayed.consume, true, "遅れた内部中断も表示しない");
    }
    assert.equal(engine.threads.main.activeTurnId, activeTurn);
    assert.equal(engine.threads.main.selectedModel, model);
    assert.equal(engine.threads.main.selectedEffort, effort);
    assert.equal(engine.pending.size, 0);
    assert.equal(engine.switches.size, 0);
  }
  assert.equal(diagnostics.events.filter(e => e.event === "switch-accepted").length, 3);
  assert.notEqual(engine.processServerMessage({ method: "turn/completed", params: { threadId: "other", turn: { id: "old-turn", status: "interrupted" } } })?.consume, true);
  const stop = { id: "user-stop", method: "turn/interrupt", params: { threadId: "main", turnId: activeTurn } };
  assert.deepEqual(engine.processClientMessage(stop).message, stop);
  assert.notEqual(engine.processServerMessage({ method: "turn/completed", params: { threadId: "main", turn: { id: activeTurn, status: "interrupted" } } })?.consume, true);
  assert.equal(engine.threads.main.activeTurnId, null);
  assert.equal(engine.switches.size, 0);
});

test.each([undefined, {}, { personality: "friendly" }, { effort: null }, { effort: "" }])("呼び出し側configのeffort欠落・空値を中断前に拒否する: %j", (config) => {
  const { engine, call } = beginSwitchTest();
  call.params.arguments = { model: "gpt-6-astra", ...(config === undefined ? {} : { config }) };
  const result = engine.processServerMessage(call);
  assert.deepEqual({ success: result.upstream[0]?.result?.success, active: engine.threads.main.activeTurnId, switching: engine.switches.size },
    { success: false, active: "old-turn", switching: 0 });
});

test.each([
  { effort: "high", typoOption: true }, { effort: "high", personality: 1 }, { effort: "high", summary: "wrong" },
  { effort: "unsupported" }, { effort: "medium" }, { effort: "high", threadId: "other" },
  { effort: "high", approvalPolicy: "never" }, { effort: "high", cwd: "/other" }, { effort: "high", input: [] },
  { effort: "high", responsesapiClientMetadata: { invalid: 42 } }, { effort: "high", serviceTier: false },
])("呼び出し側configの未知項目・不正値・保護項目を中断前に拒否する: %j", (config) => {
  const { engine, call } = beginSwitchTest();
  call.params.arguments.config = config;
  const result = engine.processServerMessage(call);
  assert.deepEqual({ success: result.upstream[0]?.result?.success, active: engine.threads.main.activeTurnId, switching: engine.switches.size },
    { success: false, active: "old-turn", switching: 0 });
});

test("続けて設定を変更しても、最初のターンの古い設定へ巻き戻さない", () => {
  const { engine, call } = beginSwitchTest();
  const outputSchema = { type: "object", properties: { answer: { type: "string" } } };
  call.params.arguments.config = { effort: "high", outputSchema };
  const interrupt = switch_model(engine, call).upstream[0];
  engine.processServerMessage({ id: interrupt.id, result: {} });
  const settings = engine.processServerMessage({ method: "turn/completed", params: { threadId: "main", turn: { id: "old-turn", status: "interrupted" } } }).upstream[0];
  const continuation = engine.processServerMessage({ id: settings.id, result: {} }).upstream[0];
  engine.processServerMessage({ id: continuation.id, result: { turn: { id: "next-turn", status: "inProgress" } } });
  call.params.turnId = "next-turn";
  call.params.arguments = { model: "gpt-6-astra", config: { effort: "xhigh" } };
  const nextInterrupt = switch_model(engine, call).upstream[0];
  engine.processServerMessage({ id: nextInterrupt.id, result: {} });
  const nextSettings = engine.processServerMessage({ method: "turn/completed", params: { threadId: "main", turn: { id: "next-turn", status: "interrupted" } } }).upstream[0];
  const nextContinuation = engine.processServerMessage({ id: nextSettings.id, result: {} }).upstream[0];
  assert.deepEqual(nextContinuation.params.outputSchema, outputSchema);
});

test("設定の公開仕様と受付検証を共用し、未知項目・必須effort・不正な入れ子を拒否する", () => {
  const contract = createSwitchRequest(protocol);
  assert.deepEqual(contract.inputSchema.properties.config.required, ["effort"]);
  assert.equal(contract.inputSchema.properties.config.additionalProperties, false);
  assert.ok(Object.keys(contract.inputSchema.definitions).length < 5, "only referenced setting schemas are published");
  for (const args of [null, [], "bad", { model: "gpt-6-astra", config: null }, { model: "gpt-6-astra", config: [] },
    JSON.parse('{"model":"gpt-6-astra","config":{"effort":"high","__proto__":{}}}')]) assert.ok(contract.validateRequest(args));
  assert.equal(contract.validateRequest({ model: "gpt-6-astra", config: { effort: "high", personality: null,
    serviceTier: null, responsesapiClientMetadata: { source: "test" }, outputSchema: { type: "object", properties: { result: { type: "string" } } } } }), null);
});

test("Codexの仕様に追加された設定をコード側の項目追加なしで検証する", () => {
  const future = structuredClone(protocol);
  future.definitions.v2.FutureSetting = { type: "object", properties: {
    labels: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, uniqueItems: true },
    count: { type: "integer", minimum: 1, maximum: 3 },
  }, required: ["labels", "count"], additionalProperties: false };
  future.definitions.v2.TurnStartParams.properties.futureSetting = { $ref: "#/definitions/v2/FutureSetting" };
  const contract = createSwitchRequest(future);
  const request = (futureSetting) => ({ model: "gpt-6-astra", config: { effort: "high", futureSetting } });
  assert.equal(contract.validateRequest(request({ labels: ["a"], count: 2 })), null);
  for (const value of [{ labels: [], count: 2 }, { labels: [""], count: 2 }, { labels: ["a", "a"], count: 2 },
    { labels: ["a"], count: 0 }, { labels: ["a"], count: 4 }, { labels: ["a"], count: 1.5 },
    { labels: ["a"] }, { labels: ["a"], count: 2, typo: true }]) assert.ok(contract.validateRequest(request(value)));
});

test("解析できない設定仕様や欠落参照は受付を始める前に拒否する", () => {
  for (const schema of [{ type: "string", format: "uri" }, { $ref: "#/definitions/Missing" },
    { $ref: "https://example.invalid/schema" }, { type: "array", items: [] }]) {
    const changed = structuredClone(protocol);
    changed.definitions.v2.TurnStartParams.properties.newSetting = schema;
    assert.throws(() => createSwitchRequest(changed), /schema/);
  }
});

test("応答済みでも裏で動いているコマンドを確認し、残っていれば中断しない", () => {
  const { engine, call } = beginSwitchTest();
  const check = engine.processServerMessage(call).upstream[0];
  assert.equal(check.method, "thread/backgroundTerminals/list");
  const result = engine.processServerMessage({ id: check.id, result: { data: [{ processId: "running" }], nextCursor: null } });
  assert.equal(result.upstream[0].result.success, false);
  assert.equal(engine.threads.main.activeTurnId, "old-turn");
});

test("設定変更と切り替えを競合させず、中断前の取消はツールを失敗応答で解放する", () => {
  const { engine, call } = beginSwitchTest();
  engine.processClientMessage({ id: "settings-user", method: "thread/settings/update", params: { threadId: "main", approvalPolicy: "never" } });
  assert.equal(engine.processServerMessage(call).upstream[0].result.success, false);
  engine.processServerMessage({ id: "settings-user", result: {} });
  const check = engine.processServerMessage(call).upstream[0];
  engine.processClientMessage({ id: "settings-user2", method: "thread/settings/update", params: { threadId: "main", approvalPolicy: "unlessTrusted" } });
  const cancelled = engine.processServerMessage({ id: check.id, result: { data: [], nextCursor: null } });
  assert.equal(cancelled.upstream[0].result.success, false);
  assert.equal(engine.threads.main.activeTurnId, "old-turn");
});

test("続行では古い権限を再送せず、最新の作業モードとターン限定設定を保持する", () => {
  const { engine, call, diagnostics } = beginSwitchTest({ params: { permissions: "old-profile", cwd: "/repo/app", runtimeWorkspaceRoots: ["/repo/app"], environments: [], additionalContext: { a: { text: "keep" } } } });
  engine.processClientMessage({ id: "live-reviewer", method: "turn/settings/update", params: { threadId: "main", turnId: "old-turn", approvalsReviewer: "user" } });
  engine.processServerMessage({ id: "live-reviewer", result: { status: "applied" } });
  engine.processServerMessage({ method: "thread/settings/updated", params: { threadId: "main", threadSettings: {
    model: "gpt-5.6-sol", effort: "high", collaborationMode: { mode: "plan", settings: { model: "gpt-5.6-sol", reasoning_effort: "high", developer_instructions: "latest instructions" } },
  } } });
  const interrupt = switch_model(engine, call).upstream[0];
  engine.processServerMessage({ id: interrupt.id, result: {} });
  const settings = engine.processServerMessage({ method: "turn/completed", params: { threadId: "main", turn: { id: "old-turn", status: "interrupted" } } }).upstream[0];
  const continuation = engine.processServerMessage({ id: settings.id, result: {} }).upstream[0];
  for (const key of ["permissions", "sandboxPolicy", "approvalPolicy", "cwd", "runtimeWorkspaceRoots", "environments"]) assert.equal(continuation.params[key], undefined);
  assert.equal(continuation.params.collaborationMode.mode, "plan");
  assert.equal(continuation.params.collaborationMode.settings.developer_instructions, "latest instructions");
  assert.deepEqual(continuation.params.additionalContext, { a: { text: "keep" } });
  assert.deepEqual(continuation.params.outputSchema, { type: "object" });
  assert.equal(continuation.params.approvalsReviewer, "user");
  assert.deepEqual({ method: settings.method, model: continuation.params.model, effort: continuation.params.effort,
    modeModel: continuation.params.collaborationMode.settings.model, modeEffort: continuation.params.collaborationMode.settings.reasoning_effort,
    input: continuation.params.input, tool: continuation.params.toolOutput.name, userMessage: continuation.params.clientUserMessageId },
  { method: "thread/settings/update", model: "gpt-6-astra", effort: "high", modeModel: "gpt-6-astra", modeEffort: "high",
    input: [], tool: "switch_model", userMessage: undefined });
  assert.equal(diagnostics.events.some(e => e.event === "switch-accepted"), false);
  engine.processServerMessage({ id: continuation.id, result: { turn: { id: "new-turn", status: "inProgress" } } });
  assert.equal(diagnostics.events.at(-1).event, "switch-accepted");
});

test.each(["settings", "continue", "timeout", "invalid", "cancel"])("内部中断後に%sで続行できなければ終了通知を戻す", (failure) => {
  const { engine, call, diagnostics } = beginSwitchTest();
  const interrupt = switch_model(engine, call).upstream[0];
  const completed = { method: "turn/completed", params: { threadId: "main", turn: { id: "old-turn", status: "interrupted" } } };
  assert.equal(engine.processServerMessage(completed).upstream.length, 0, "通知が先でも中断応答を待つ");
  const settings = engine.processServerMessage({ id: interrupt.id, result: {} }).upstream[0];
  const request = failure === "settings" ? settings : engine.processServerMessage({ id: settings.id, result: {} }).upstream[0];
  if (failure === "cancel") engine.processClientMessage({ id: "stop", method: "turn/interrupt", params: { threadId: "main", turnId: "old-turn" } });
  const reply = failure === "invalid" || failure === "cancel" ? { id: request.id, result: {} }
    : { id: request.id, error: { code: -1, message: failure === "timeout" ? "baton: turn/start timed out" : "refused" } };
  const result = engine.processServerMessage(reply);
  assert.deepEqual(result.downstream.at(-1), completed, "続行できない場合は実際の中断を隠さない");
  if (failure !== "cancel") assert.equal(result.downstream[0].method, "error");
  if (reply.error) assert.ok(result.downstream[0].params.error.message.includes(reply.error.message));
  assert.equal(diagnostics.events.some(e => e.event === "switch-accepted"), false);
  if (failure === "continue") assert.equal(engine.processServerMessage({ id: request.id, result: {} }).consume, true);
});

test("effort欠落、不正指定、利用不能モデル、古いターン、子を中断しない", () => {
  const cases = [
    { args: { model: "gpt-5.6-sol" }, success: false },
    { args: { model: "gpt-6-astra", config: { effort: "high" }, reason: "not allowed" }, success: false },
    { args: { model: "unknown", config: { effort: "high" } }, success: false },
    { args: { model: "gpt-6-astra", config: { effort: "high" } }, turnId: "old-other", success: false },
    { args: { model: "gpt-6-astra", config: { effort: "high" } }, options: { parentThreadId: "parent" }, success: false },
  ];
  for (const entry of cases) {
    const { engine, call } = beginSwitchTest(entry.options);
    call.params.arguments = entry.args;
    if (entry.turnId) call.params.turnId = entry.turnId;
    const result = switch_model(engine, call);
    assert.deepEqual({ method: result.upstream[0].method, success: result.upstream[0].result.success }, { method: undefined, success: entry.success });
  }
});

test("並行ツールや承認待ちがある間は変更を拒否し、通常の承認応答は透過する", () => {
  const { engine, call } = beginSwitchTest();
  const approval = { id: 8, method: "item/commandExecution/requestApproval", params: { threadId: "main", turnId: "old-turn" } };
  assert.equal(engine.processServerMessage(approval), undefined);
  assert.equal(switch_model(engine, call).upstream[0].result.success, false);
  const response = { id: 8, result: { decision: "decline" } };
  assert.deepEqual(engine.processClientMessage(response), { type: "forward", message: response, modified: false });
  engine.processServerMessage({ method: "item/started", params: { threadId: "main", turnId: "old-turn", item: { id: "command", type: "commandExecution" } } });
  assert.equal(switch_model(engine, call).upstream[0].result.success, false);
  engine.processServerMessage({ method: "item/completed", params: { threadId: "main", turnId: "old-turn", item: { id: "command", type: "commandExecution" } } });
  assert.equal(switch_model(engine, call).upstream[0].method, "turn/interrupt");
});

test("停止・新しいユーザー入力は切り替えを取り消し、自動続行しない", () => {
  for (const method of ["turn/interrupt", "turn/start", "turn/steer", "thread/archive"]) {
    const { engine, call } = beginSwitchTest();
    switch_model(engine, call);
    engine.processClientMessage({ id: "user", method, params: { threadId: "main", turnId: "old-turn", input: [{ type: "text", text: "stop/change" }] } });
    const result = engine.processServerMessage({ method: "turn/completed", params: { threadId: "main", turn: { id: "old-turn", status: "interrupted" } } });
    assert.equal(result?.upstream?.length ?? 0, 0);
    assert.notEqual(result?.consume, true, "利用者の取消による中断は通知する");
  }
});

test("同じリポジトリのAだけをAstraへ変更し、Bの実行・承認・次の応答をSolのまま保つ", () => {
  const { engine, call } = beginSwitchTest();
  announceThread(engine, "task-b", { model: "gpt-5.6-sol", effort: "high" });
  announceThread(engine, "child", { model: "gpt-5.6-luna", effort: "max", parentThreadId: "main" });
  engine.processClientMessage(turnRequest("begin-b", "task-b", { model: "gpt-5.6-sol", effort: "high" }));
  engine.processServerMessage({ id: "begin-b", result: { turn: { id: "b-running", status: "inProgress" } } });
  engine.processServerMessage({ id: "approval-b", method: "item/commandExecution/requestApproval", params: { threadId: "task-b", turnId: "b-running" } });
  const beforeB = structuredClone(engine.threads["task-b"]);
  const beforeChild = structuredClone(engine.threads.child);
  const beforeConfig = structuredClone(engine.config);
  const interrupt = switch_model(engine, call).upstream[0];
  engine.processServerMessage({ id: interrupt.id, result: {} });
  const settings = engine.processServerMessage({ method: "turn/completed", params: { threadId: "main", turn: { id: "old-turn", status: "interrupted" } } }).upstream[0];
  engine.processServerMessage({ method: "thread/settings/updated", params: { threadId: "main", threadSettings: { model: "gpt-6-astra", effort: "high" } } });
  const continuation = engine.processServerMessage({ id: settings.id, result: {} }).upstream[0];
  engine.processServerMessage({ id: continuation.id, result: { turn: { id: "a-astra", status: "inProgress" } } });
  assert.deepEqual([interrupt, settings, continuation].map((request) => request.params.threadId), ["main", "main", "main"]);
  assert.equal(engine.threads.main.selectedModel, "gpt-6-astra");
  assert.deepEqual(engine.threads["task-b"], beforeB);
  assert.deepEqual(engine.threads.child, beforeChild);
  assert.deepEqual(engine.config, beforeConfig);
  assert.ok([...engine.serverRequests.values()].includes("task-b"));
  engine.processClientMessage({ id: "approval-b", result: { decision: "accept" } });
  engine.processServerMessage({ method: "turn/completed", params: { threadId: "task-b", turn: { id: "b-running", status: "completed" } } });
  const nextB = engine.processClientMessage(turnRequest("next-b", "task-b"));
  assert.equal(nextB.modified, false);
  assert.equal(nextB.message.params.model, undefined);
  assert.equal(nextB.message.params.effort, undefined);
  assert.equal(engine.threads["task-b"].selectedModel, "gpt-5.6-sol");
  assert.equal(engine.threads["task-b"].selectedEffort, "high");
});

test("AとBの切り替え応答が交錯しても、それぞれ指定したモデルで続行する", () => {
  const { engine, call } = beginSwitchTest();
  call.params.arguments.config = { effort: "xhigh", personality: "friendly" };
  announceThread(engine, "task-b", { model: "gpt-6-astra", effort: "high" });
  engine.processClientMessage(turnRequest("begin-b", "task-b", { model: "gpt-6-astra", effort: "high" }));
  engine.processServerMessage({ id: "begin-b", result: { turn: { id: "b-running", status: "inProgress" } } });
  const callB = { ...call, id: "tool-b", params: { ...call.params, threadId: "task-b", turnId: "b-running", callId: "switch-b", arguments: { model: "gpt-5.6-sol", config: { effort: "high" } } } };
  const interruptA = switch_model(engine, call).upstream[0];
  const interruptB = switch_model(engine, callB).upstream[0];
  // Aは通知→応答、Bは応答→通知。設定の受付はB→Aと逆順にする。
  engine.processServerMessage({ method: "turn/completed", params: { threadId: "main", turn: { id: "old-turn", status: "interrupted" } } });
  engine.processServerMessage({ id: interruptB.id, result: {} });
  const settingsA = engine.processServerMessage({ id: interruptA.id, result: {} }).upstream[0];
  const settingsB = engine.processServerMessage({ method: "turn/completed", params: { threadId: "task-b", turn: { id: "b-running", status: "interrupted" } } }).upstream[0];
  const continuationB = engine.processServerMessage({ id: settingsB.id, result: {} }).upstream[0];
  const continuationA = engine.processServerMessage({ id: settingsA.id, result: {} }).upstream[0];
  assert.deepEqual([settingsA, continuationA].map((request) => [request.params.threadId, request.params.model]), [["main", "gpt-6-astra"], ["main", "gpt-6-astra"]]);
  assert.deepEqual([settingsB, continuationB].map((request) => [request.params.threadId, request.params.model]), [["task-b", "gpt-5.6-sol"], ["task-b", "gpt-5.6-sol"]]);
  assert.deepEqual([continuationA, continuationB].map((request) => [request.params.effort, request.params.personality]), [["xhigh", "friendly"], ["high", undefined]]);
  engine.processServerMessage({ id: continuationB.id, result: { turn: { id: "b-sol", status: "inProgress" } } });
  engine.processServerMessage({ id: continuationA.id, result: { turn: { id: "a-astra", status: "inProgress" } } });
  assert.equal(engine.threads.main.selectedModel, "gpt-6-astra");
  assert.equal(engine.threads["task-b"].selectedModel, "gpt-5.6-sol");
  assert.equal(engine.switches.size, 0);
});

test("再接続はCodexが返すモデルを使い、旧固定値や他プロセスの保存状態を使わない", () => {
  const { engine } = makeEngine();
  engine.processClientMessage({ id: 11, method: "thread/resume", params: { threadId: "resumed" } });
  engine.processServerMessage({ id: 11, result: { model: "gpt-6-astra", reasoningEffort: "high", thread: { id: "resumed", cwd: repository, parentThreadId: null, status: { type: "idle" } } } });
  assert.equal(engine.threads.resumed.selectedModel, "gpt-6-astra");
  const request = turnRequest(12, "resumed");
  assert.deepEqual(engine.processClientMessage(request), { type: "forward", message: request, modified: false });
});

test.each(["user-stop", "timeout"])("取消後に遅れて受理された続行も停止し、成功扱いしない: %s", (reason) => {
  const { engine, call, diagnostics } = beginSwitchTest();
  const interrupt = switch_model(engine, call).upstream[0];
  engine.processServerMessage({ id: interrupt.id, result: {} });
  const settings = engine.processServerMessage({ method: "turn/completed", params: { threadId: "main", turn: { id: "old-turn", status: "interrupted" } } }).upstream[0];
  const continuation = engine.processServerMessage({ id: settings.id, result: {} }).upstream[0];
  if (reason === "user-stop") {
    engine.processClientMessage({ id: 999, method: "turn/interrupt", params: { threadId: "main", turnId: "old-turn" } });
  } else {
    const timeout = engine.processServerMessage({ id: continuation.id, error: { code: -32091, message: "baton: turn/start timed out" } });
    assert.match(timeout.downstream[0].params.error.message, /timed out/);
  }
  const result = engine.processServerMessage({ id: continuation.id, result: { turn: { id: "late-turn", status: "inProgress" } } });
  assert.deepEqual(result.upstream[0]?.params, { threadId: "main", turnId: "late-turn" });
  assert.equal(diagnostics.events.some((entry) => entry.event === "switch-accepted"), false);
});

test.each([false, true, "tool"])("切り替え要求タイマーは通知欠落で失敗し、成功後は残らない（待機ケース=%s）", async (completeSwitch) => {
  const temporary = mkdtempSync(path.join(tmpdir(), "baton-timeout-"));
  const fakeCodex = path.join(temporary, "codex");
  writeFileSync(fakeCodex, `#!/usr/bin/env node
${schemaCommand}
if (process.argv[2] === "--version") { console.log("codex-cli 0.153.1"); process.exit(0); }
const readline = require("node:readline");
const send = (message) => console.log(JSON.stringify(message));
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ id: m.id, result: {} });
  if (m.method === "model/list") send({ id: m.id, result: { data: ["gpt-5.6-sol", "gpt-6-astra"].map(model => ({ model, supportedReasoningEfforts: [{ reasoningEffort: "high" }] })), nextCursor: null } });
  if (m.method === "thread/start") send({ id: m.id, result: { thread: { id: "main", parentThreadId: null, cwd: ${JSON.stringify(repository)}, model: "gpt-5.6-sol", status: { type: "idle" } } } });
  if (m.method === "turn/start") {
    if (m.params.toolOutput) {
      send({ id: m.id, result: { turn: { id: "continued", status: "inProgress" } } });
      send({ method: "turn/started", params: { threadId: "main", turn: { id: "continued", status: "inProgress" } } });
      send({ method: "test/ready" });
      return;
    }
    send({ id: m.id, result: { turn: { id: "turn", status: "inProgress" } } });
    send({ id: "switch", method: "item/tool/call", params: { threadId: "main", turnId: "turn", callId: "switch", namespace: null, tool: "switch_model", arguments: { model: "gpt-6-astra", config: { effort: "high" } } } });
  }
  if (m.method === "thread/backgroundTerminals/list") send({ id: m.id, result: { data: [], nextCursor: null } });
  if (m.method === "turn/interrupt") {
    send({ id: m.id, result: {} });
    if (${JSON.stringify(completeSwitch)} === true) send({ method: "turn/completed", params: { threadId: "main", turn: { id: "turn", status: "interrupted" } } });
    else send({ method: "test/ready" });
  }
  if (m.method === "thread/settings/update") send({ id: m.id, result: {} });
  if (!m.method && m.id === "switch") {
    if (${JSON.stringify(completeSwitch)} === "tool") send({ method: "test/ready" });
    else send({ method: "item/completed", params: { threadId: "main", turnId: "turn", item: { id: "switch", type: "dynamicToolCall", status: "completed", success: m.result.success } } });
  }
});
`);
  chmodSync(fakeCodex, 0o755);
  const input = new PassThrough();
  const output = new PassThrough();
  let ready;
  let finish;
  const readyPromise = new Promise((resolve) => { ready = resolve; });
  const resultPromise = new Promise((resolve) => { finish = resolve; });
  const lines = new JsonLineDecoder({ maxBufferedBytes: 1024 * 1024, onLine(line) {
    const message = JSON.parse(line);
    if (message.id === 1) input.write(JSON.stringify({ id: 2, method: "thread/start", params: { cwd: repository } }) + "\n");
    if (message.id === 2) input.write(JSON.stringify(turnRequest(3, "main", { model: "gpt-5.6-sol", effort: "high" })) + "\n");
    if (message.method === "test/ready") ready();
    if (message.method === "error") finish(message.params.error);
  } });
  output.on("data", (chunk) => lines.push(chunk));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const exited = new Promise((resolve) => runAppServerProxy({ config: makeConfig(), innerCodexPath: fakeCodex,
    args: ["app-server"], stateDirectory: temporary, clientReadable: input, clientWritable: output, onExit: resolve }));
  try {
    input.write(JSON.stringify({ id: 1, method: "initialize", params: {} }) + "\n");
    await readyPromise;
    await vi.advanceTimersByTimeAsync(30_001);
    if (completeSwitch !== true) {
      const result = await resultPromise;
      assert.match(result.message, /timed out/);
    }
    const events = readFileSync(path.join(temporary, "router.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(events.filter(e => e.event === "switch-request-timeout").length, completeSwitch === true ? 0 : 1);
    assert.equal(events.filter(e => e.event === "switch-accepted").length, completeSwitch === true ? 1 : 0);
    assert.equal(events.filter(e => e.event === "control-request" && e.source === "baton" && e.method === "turn/interrupt").length, completeSwitch === "tool" ? 0 : 1);
    assert.equal(events.filter(e => e.event === "control-request" && e.source === "client" && e.method === "turn/start").length, 1);
  } finally {
    input.end();
    await exited;
    vi.useRealTimers();
  }
});

test("initialized通知がなくてもinitialize応答後にモデルカタログを取得する", async () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "baton-initialize-"));
  const fakeCodex = path.join(temporary, "codex");
  writeFileSync(
    fakeCodex,
    `#!/usr/bin/env node
${schemaCommand}
if (process.argv[2] === "--version") {
  process.stdout.write("codex-cli 0.153.1\\n");
  process.exit(0);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
    } else if (message.method === "model/list") {
      process.stdout.write(JSON.stringify({
        id: message.id,
        result: {
          data: [{
            model: "gpt-6-astra",
            supportedReasoningEfforts: [{ reasoningEffort: "high" }],
          }],
          nextCursor: null,
        },
      }) + "\\n");
    } else if (message.method === "thread/start") {
      process.stdout.write(JSON.stringify({
        id: message.id,
        result: {
          thread: {
            id: "thread-1",
            parentThreadId: null,
            cwd: ${JSON.stringify(repository)},
            model: "gpt-5.6-terra",
            reasoningEffort: "medium",
            status: { type: "idle" },
          },
        },
      }) + "\\n");
    } else if (message.method === "turn/start") {
      process.stdout.write(JSON.stringify({
        id: message.id,
        result: { receivedModel: message.params.model },
      }) + "\\n");
    }
  }
});
`,
  );
  chmodSync(fakeCodex, 0o755);

  const clientReadable = new PassThrough();
  const clientWritable = new PassThrough();
  const exited = new Promise((resolve) => {
    runAppServerProxy({
      config: makeConfig(),
      innerCodexPath: fakeCodex,
      args: ["app-server"],
      stateDirectory: path.join(temporary, "state"),
      clientReadable,
      clientWritable,
      onExit: resolve,
    });
  });
  const turnResponse = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("turn/start response timed out")), 5_000);
    const decoder = new JsonLineDecoder({
      maxBufferedBytes: 1024 * 1024,
      onLine(line) {
        const message = JSON.parse(line);
        if (message.id === "initialize") {
          clientReadable.write(
            `${JSON.stringify({ method: "thread/start", id: "thread", params: {} })}\n`,
          );
        } else if (message.id === "thread") {
          clientReadable.write(`${JSON.stringify(turnRequest("turn", "thread-1", { model: "gpt-6-astra" }))}\n`);
        } else if (message.id === "turn") {
          clearTimeout(timeout);
          resolve(message);
        }
      },
    });
    clientWritable.on("data", (chunk) => decoder.push(chunk));
  });

  clientReadable.write(
    `${JSON.stringify({ method: "initialize", id: "initialize", params: {} })}\n`,
  );
  const response = await turnResponse;
  clientReadable.end();
  await exited;

  assert.equal(response.result?.receivedModel, "gpt-6-astra", response.error?.message);
});

test("切り替えを無効化したエンジンは要求を書き換えない", () => {
  const { engine } = makeEngine(makeConfig(), { compatible: false });
  announceThread(engine, "thread-1");
  const request = turnRequest(80, "thread-1");
  const action = engine.processClientMessage(request);
  assert.equal(action.modified, false);
  assert.equal(action.message, request);
});

test("処理中の要求ID重複を拒否する", () => {
  const { engine } = makeEngine();
  announceThread(engine, "thread-1");
  engine.processClientMessage(turnRequest("same-id", "thread-1"));
  const duplicate = engine.processClientMessage(turnRequest("same-id", "thread-1"));
  assert.equal(duplicate.type, "local-error");
  assert.match(duplicate.message.error.message, /duplicate/);
});

test("旧モード設定や不正なパスを明示的に拒否する", () => {
  assert.throws(() => makeConfig({ mode: "fixed" }), /removed/);
  assert.throws(() => makeConfig({ enabledRepositories: ["relative/repository"] }), /absolute paths/);
});

test("起動設定にモデル定義が残っていても入力を書き換えず読み飛ばす", () => {
  const models = { "gpt-5.6-sol": { effort: "high", futureOption: { value: "keep" } } };
  const config = makeConfig({ models, extraSetting: { enabled: true } });
  assert.deepEqual({ hasModels: Object.hasOwn(config, "models"), extraSetting: config.extraSetting, models },
    { hasModels: false, extraSetting: { enabled: true }, models: { "gpt-5.6-sol": { effort: "high", futureOption: { value: "keep" } } } });
});

test("不要なモデル定義の内容に起動可否が依存しない", () => {
  for (const models of [null, [], {}, "unused", { model: { effort: "invalid" } }]) {
    assert.equal(Object.hasOwn(makeConfig({ models }), "models"), false);
  }
  assert.throws(() => makeConfig({ efforts: { "gpt-5.6-sol": "high" } }), /removed/);
});

test("起動設定のモデル定義を使わず、呼び出し側の設定を同期・続行へそのまま渡す", () => {
  const extra = { summary: "concise", personality: "friendly", serviceTier: null, outputSchema: { type: "object", properties: { answer: { type: "string" } } } };
  const config = makeConfig({ models: { "gpt-6-astra": { effort: "high", personality: "pragmatic", serviceTier: "default" } } });
  const { engine, call } = beginSwitchTest({ config });
  call.params.arguments.config = { effort: "xhigh", ...extra };
  const before = structuredClone(config);
  const interrupt = switch_model(engine, call).upstream[0];
  engine.processServerMessage({ id: interrupt.id, result: {} });
  const settings = engine.processServerMessage({ method: "turn/completed", params: { threadId: "main", turn: { id: "old-turn", status: "interrupted" } } }).upstream[0];
  const continuation = engine.processServerMessage({ id: settings.id, result: {} }).upstream[0];
  assert.deepEqual([settings.params.effort, settings.params.collaborationMode.settings.reasoning_effort, continuation.params.effort],
    ["xhigh", "xhigh", "xhigh"]);
  assert.deepEqual({
    extra: Object.fromEntries(Object.keys(extra).map((key) => [key, continuation.params[key]])),
    threadId: continuation.params.threadId, model: continuation.params.model, input: continuation.params.input,
    configUnchanged: JSON.stringify(config) === JSON.stringify(before),
  }, { extra, threadId: "main", model: "gpt-6-astra", input: [], configUnchanged: true });
});

test("通常の開始へ起動設定のモデル既定値を補わず、利用者の指定を保持する", () => {
  const config = makeConfig({ models: { "gpt-5.6-sol": { effort: "high", summary: "concise", serviceTier: "default", futureOption: false } } });
  const { engine } = makeEngine(config);
  announceThread(engine, "main", { model: "gpt-5.6-sol" });
  const { params } = engine.processClientMessage(turnRequest("start", "main", { effort: "xhigh", serviceTier: null })).message;
  assert.deepEqual({ model: params.model, effort: params.effort, summary: params.summary, serviceTier: params.serviceTier, futureOption: params.futureOption },
    { model: undefined, effort: "xhigh", summary: undefined, serviceTier: null, futureOption: undefined });
});

test("モデル設定からタスク・会話・権限・作業指示を上書きできない", () => {
  const reserved = ["model", "threadId", "turnId", "input", "toolOutput", "turnTrigger", "clientUserMessageId", "cwd", "runtimeWorkspaceRoots", "approvalPolicy", "approvalsReviewer", "sandboxPolicy", "permissions", "environments", "collaborationMode", "additionalContext", "multiAgentMode", "cyberAccessProgram"];
  for (const key of reserved) {
    const { engine, call } = beginSwitchTest();
    call.params.arguments.config[key] = "override";
    assert.equal(engine.processServerMessage(call).upstream[0]?.result?.success, false, key);
  }
});

test("Desktopプロセスを検出できない環境では起動しない", () => {
  const fakeBin = mkdtempSync(path.join(tmpdir(), "baton-bin-"));
  const fakePgrep = path.join(fakeBin, "pgrep");
  const fakeCodex = path.join(fakeBin, "codex");
  writeFileSync(fakePgrep, "#!/bin/sh\nexit 3\n");
  writeFileSync(fakeCodex, "#!/bin/sh\nexit 0\n");
  chmodSync(fakePgrep, 0o755);
  chmodSync(fakeCodex, 0o755);

  const result = spawnSync(path.join(repositoryRoot, "bin", "baton"), ["app", repositoryRoot], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      CODEX_AUTO_CODEX_BIN: fakeCodex,
    },
    encoding: "utf8",
  });

  assert.deepEqual(
    { status: result.status, refused: result.stderr.includes("cannot inspect Desktop process state") },
    { status: 69, refused: true },
  );
});

test("Desktop版をカレントディレクトリで起動する", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "baton-app-"));
  const fakePgrep = path.join(temporary, "pgrep");
  const fakeCodex = path.join(temporary, "codex");
  const capturePath = path.join(temporary, "arguments.txt");
  const configPath = path.join(temporary, "config.json");
  writeFileSync(fakePgrep, "#!/bin/sh\nexit 1\n");
  writeFileSync(
    fakeCodex,
    `#!/usr/bin/env node
${schemaCommand}
if (process.argv[2] === "--version") { console.log("codex-cli 0.153.1"); process.exit(0); }
require("node:fs").writeFileSync(process.env.CODEX_AUTO_CAPTURE_PATH, process.argv.slice(2).join("\\n"));
`,
  );
  chmodSync(fakePgrep, 0o755);
  chmodSync(fakeCodex, 0o755);
  writeFileSync(configPath, JSON.stringify(makeConfig({ innerCodexPath: fakeCodex })));

  const result = spawnSync(path.join(repositoryRoot, "bin", "baton"), ["app"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      PATH: `${temporary}:${process.env.PATH}`,
      CODEX_AUTO_CAPTURE_PATH: capturePath,
      CODEX_AUTO_CODEX_BIN: fakeCodex,
      CODEX_BATON_CONFIG: configPath,
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(capturePath, "utf8").trim().split("\n"), [
    "app",
    repositoryRoot,
  ]);
});

test.each([0, 23])("CLI版は接続先を渡し、終了コードを保持してsocketを片付ける: %s", (cliExitCode) => {
  const temporary = mkdtempSync(path.join(tmpdir(), "baton-cli-"));
  const fakeCodex = path.join(temporary, "codex");
  const capturePath = path.join(temporary, "arguments.txt");
  const configPath = path.join(temporary, "config.json");
  writeFileSync(
    fakeCodex,
    `#!/usr/bin/env node
${schemaCommand}
if (process.argv[2] === "--version") { console.log("codex-cli 0.153.4"); process.exit(0); }
if (process.argv[2] === "app-server") { process.stdin.resume(); }
else { require("node:fs").writeFileSync(process.env.CODEX_AUTO_CAPTURE_PATH, process.argv.slice(2).join("\\n")); process.exit(${cliExitCode}); }
`,
  );
  chmodSync(fakeCodex, 0o755);
  writeFileSync(
    configPath,
    JSON.stringify(makeConfig({ innerCodexPath: fakeCodex })),
  );

  const result = spawnSync(path.join(repositoryRoot, "bin", "baton"), ["--search"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CODEX_AUTO_CAPTURE_PATH: capturePath,
      CODEX_AUTO_CODEX_BIN: fakeCodex,
      CODEX_BATON_CONFIG: configPath,
      CODEX_BATON_STATE_DIR: path.join(temporary, "state"),
    },
    encoding: "utf8",
    timeout: 10_000,
  });

  assert.equal(result.status, cliExitCode, result.stderr);
  const argumentsList = readFileSync(capturePath, "utf8").trim().split("\n");
  assert.equal(argumentsList[0], "--remote");
  assert.match(argumentsList[1], /^unix:\/\//u);
  assert.deepEqual(argumentsList.slice(2), ["-C", repositoryRoot, "--search"]);
  const diagnostics = readFileSync(path.join(temporary, "state/router.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(diagnostics.find(e => e.event === "cli-exit")?.code, cliExitCode);
  assert.equal(existsSync(argumentsList[1].slice("unix://".length)), false, "CLI終了時は現在の仕様どおりsocketが片付く");
});

test.each([false, true])("CLIではサーバー標準エラーだけを保存し、通常のエラー通知とCLI出力を維持する: %s", (cli) => {
  const log = "ERROR codex_core::tools::router: error=dynamic tool call was cancelled before receiving a response\n";
  const { run, configPath } = compatibilityFixture({ script: `
if (process.argv[2] === "app-server" && process.argv[3] !== "generate-json-schema") {
  process.stderr.write(${JSON.stringify(log)});
  console.log(JSON.stringify({ method: "error", params: { threadId: "test", turnId: "turn", willRetry: false,
    error: { message: "VISIBLE_RPC_ERROR", codexErrorInfo: null, additionalDetails: null } } }));
  console.log(JSON.stringify({ method: "test/ready" }));
  process.stdin.resume();
  return;
}
if (process.argv[2] === "--remote") {
  const socket = require("node:net").connect(process.argv[3].slice("unix://".length));
  const timeout = setTimeout(() => process.exit(99), 5000);
  let received = "";
  let ready = false;
  socket.on("connect", () => socket.write("GET / HTTP/1.1\\r\\nHost: localhost\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Version: 13\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\n\\r\\n"));
  socket.on("data", chunk => {
    received += chunk.toString();
    if (ready || !received.includes("test/ready")) return;
    ready = true;
    require("node:assert/strict").ok(received.includes("VISIBLE_RPC_ERROR"));
    console.log("CLI_READY");
    process.stderr.write("CLI_STDERR\\n");
    clearTimeout(timeout);
    socket.end();
  });
  return;
}
` });
  const result = run(cli ? [] : ["app-server", "--listen", "stdio://"], cli);
  assert.equal(result.status, 0, result.stderr);
  const logPath = path.join(path.dirname(configPath), "app-server.stderr.log");
  if (cli) {
    assert.equal(result.stdout, "CLI_READY\n");
    assert.equal(result.stderr, "CLI_STDERR\n", "サーバー内部ログは端末へ混ぜない");
    assert.equal(readFileSync(logPath, "utf8"), log, "文言で捨てず原文を保存する");
    assert.equal(statSync(logPath).mode & 0o777, 0o600);
  } else {
    assert.equal(result.stderr, log, "既存のstdio接続では標準エラーを維持する");
    assert.match(result.stdout, /VISIBLE_RPC_ERROR/);
    assert.equal(existsSync(logPath), false);
  }
});

test("設定ファイル内の行コメントを許可する", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "baton-config-"));
  const fakeCodex = path.join(temporary, "codex");
  const configPath = path.join(temporary, "config.json");
  writeFileSync(fakeCodex, `#!/usr/bin/env node\n${schemaCommand}\nconsole.log("codex-cli 0.153.1");\n`);
  chmodSync(fakeCodex, 0o755);
  const configWithComment = JSON.stringify(makeConfig(), null, 2).replace(
    '"enabledRepositories": [',
    '"enabledRepositories": [\n    // モデル切り替えを行うプロジェクトを追加する',
  );
  writeFileSync(configPath, configWithComment);

  const result = spawnSync(path.join(repositoryRoot, "src", "proxy.mjs"), ["--router-check"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CODEX_BATON_CONFIG: configPath,
      CODEX_BATON_INNER_CODEX: fakeCodex,
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
});
