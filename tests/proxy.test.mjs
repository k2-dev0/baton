import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
} from "../src/proxy.mjs";
import {
  isRepositoryEnabled,
  selectModel,
  validateConfig,
} from "../src/policy.mjs";
import { WebSocketFrameDecoder } from "../src/websocket.mjs";

const repository = "/Users/test/project";
const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// モデル設定構造の変更シナリオ（実装前の確認対象）:
// - modelsのモデル別effortを読み、既定思考量と切り替え先一覧に反映する。
// - 空のモデル一覧、effortの欠落・不正値、旧efforts形式を明示的に拒否する。
// - 本番・サンプルを新形式へ揃え、既存の切り替え・タスク間分離を維持する。
// - 設定全体とモデル内の追加項目を保持し、未対応項目をCodexへ無条件送信しない。

// 自律切り替えの修正シナリオ（実装前の確認対象）:
// - メインタスクに変更ツールを追加し、既存ツールと指示を保持する。
// - 理由なしの指定でSol→Astra→Solへ切り替え、同じタスクで追加入力なしに続行する。
// - 同じモデル、不正な指定、利用不能モデルでは不要な中断や成功記録を発生させない。
// - 並行ツール、承認待ち、ユーザーの停止、開始失敗を安全に処理する。
// - 別タスク、子エージェント、対象外の場所、権限、作業内容へ変更を波及させない。
// - 旧モードや固定設定を撤去し、再接続と複数プロセスで状態を失わない。
// - DesktopとCLIの実機で、実行モデル・同一タスク・自動続行を確認する。

test.runIf(process.env.MODEL_ROUTER_LIVE === "1")("実機で同一タスクのSol→Astra→Solを追加入力なしに続行する", async () => {
  const temporary = mkdtempSync("/private/tmp/model-router-live-");
  const innerCodexPath = process.env.MODEL_ROUTER_TEST_CODEX ?? "/Applications/ChatGPT.app/Contents/Resources/codex";
  const configPath = path.join(temporary, "config.json");
  writeFileSync(configPath, JSON.stringify(makeConfig({ innerCodexPath, enabledRepositories: [temporary], supportedCliVersions: ["0.153.4"], maxBufferedBytes: 32 * 1024 * 1024 })));
  const child = spawn(process.execPath, [path.join(repositoryRoot, "src/proxy.mjs"), "app-server", "--listen", "stdio://"], {
    cwd: temporary, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CODEX_CLI_PATH: "", CODEX_MODEL_ROUTER_CONFIG: configPath, CODEX_MODEL_ROUTER_STATE_DIR: path.join(temporary, "router") },
  });
  const pending = new Map();
  const events = [];
  const switches = [];
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
    if (message.method === "thread/settings/updated") {
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
    await send("initialize", { clientInfo: { name: "model_router_live_test", version: "0.1.0" }, capabilities: { experimentalApi: true } });
    child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    const started = await send("thread/start", {
      model: "gpt-5.6-sol", cwd: temporary, ephemeral: false, experimentalRawEvents: true,
      developerInstructions: "This is a model-switch integration test. Do not use any tools except switch_main_model. Follow the user's three ordered steps exactly.",
    });
    testThread = started.thread;
    await send("turn/start", { threadId: started.thread.id, effort: "high", input: [{ type: "text", text: "Do exactly these steps, in order: 1. Call switch_main_model with gpt-6-astra and await its result. 2. Then call switch_main_model with gpt-5.6-sol and await its result. 3. Respond with exactly MODEL_ROUTER_LIVE_OK. Do not call both tools in parallel. Do not do anything else." }] });
    const result = await completed;
    writeFileSync(path.join(temporary, "events.json"), JSON.stringify(events, null, 2), { mode: 0o600 });
    console.log("Live evidence:", temporary, JSON.stringify(switches));
    console.log("Runtime history:", testThread.path);
    assert.deepEqual({
      models: switches.map((entry) => entry.model),
      sameTask: switches.every((entry) => entry.threadId === started.thread.id),
      status: result.turn.status,
      finished: events.some((event) => event.method === "item/completed" && event.params.item.type === "agentMessage" && event.params.item.text.includes("MODEL_ROUTER_LIVE_OK")),
    }, { models: ["gpt-6-astra", "gpt-5.6-sol"], sameTask: true, status: "completed", finished: true });
    if (testThread.path) {
      const rollout = readFileSync(testThread.path, "utf8");
      writeFileSync(path.join(temporary, "rollout.jsonl"), rollout, { mode: 0o600 });
      const contexts = rollout.trim().split("\n").map(JSON.parse).filter((entry) => entry.type === "turn_context");
      assert.deepEqual(contexts.map((entry) => [entry.payload.model, entry.payload.effort]), [["gpt-5.6-sol", "high"], ["gpt-6-astra", "high"], ["gpt-5.6-sol", "high"]]);
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
    models: { "gpt-5.6-sol": { effort: "high" }, "gpt-6-astra": { effort: "high" } },
    supportedCliVersions: ["0.153.1"],
    innerCodexPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
    desktopAppPath: "/Applications/ChatGPT.app",
    maxBufferedBytes: 1024 * 1024,
    ...overrides,
  });
}

function makeEngine(config = makeConfig(), { compatible = true } = {}) {
  const diagnostics = new MemoryDiagnostics();
  const stateStore = new MemoryStateStore();
  const engine = new RouterEngine({ config, diagnostics, stateStore, compatible });
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

// CLIクライアントと同じマスク付きWebSocketフレームをテスト用に組み立てる。
function maskedFrame(payload, { final = true, opcode = 0x01 } = {}) {
  const body = Buffer.from(payload);
  assert.ok(body.length <= 125, "test frame must use the short payload format");
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const masked = Buffer.from(body);
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4];
  return Buffer.concat([
    Buffer.from([(final ? 0x80 : 0x00) | opcode, 0x80 | body.length]),
    mask,
    masked,
  ]);
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

test("分割されたWebSocketテキストフレームをCLI入力へ復元する", () => {
  const messages = [];
  const errors = [];
  const decoder = new WebSocketFrameDecoder({
    maxPayloadBytes: 1024,
    onText: (message) => messages.push(message),
    onPing() {},
    onClose() {},
    onError: (error) => errors.push(error),
  });
  const first = maskedFrame('{"method":"turn/', { final: false });
  const second = maskedFrame('start"}', { opcode: 0x00 });
  decoder.push(first.subarray(0, 3));
  decoder.push(Buffer.concat([first.subarray(3), second]));

  assert.deepEqual(messages, ['{"method":"turn/start"}']);
  assert.deepEqual(errors, []);
});

test("マスクされていないWebSocketクライアント入力を拒否する", () => {
  const errors = [];
  const decoder = new WebSocketFrameDecoder({
    maxPayloadBytes: 1024,
    onText() {},
    onPing() {},
    onClose() {},
    onError: (error) => errors.push(error),
  });
  decoder.push(Buffer.from([0x81, 0x02, 0x7b, 0x7d]));
  assert.match(errors[0].message, /must be masked/);
});

test("共通接頭辞を持つ別リポジトリを対象に含めない", () => {
  assert.equal(isRepositoryEnabled(repository, [repository]), true);
  assert.equal(isRepositoryEnabled(`${repository}/src`, [repository]), true);
  assert.equal(isRepositoryEnabled(`${repository}-other`, [repository]), false);
  assert.equal(isRepositoryEnabled("relative/path", [repository]), false);
});

test("自由文を分類せず、指定モデルの未指定effortだけを補う", () => {
  const decision = selectModel({
    config: makeConfig(), thread: { id: "main", cwd: repository, isMain: true, selectedModel: "gpt-5.6-sol" },
    requestParams: { model: "gpt-5.6-sol", input: [{ type: "text", text: "課金と権限と並行保存" }] },
  });
  assert.deepEqual(decision, { apply: true, model: "gpt-5.6-sol", effort: "high", reasonCode: "default-effort" });
});

test("利用者のモデルとeffort、子と対象外のタスクを保持する", () => {
  const main = { id: "main", cwd: repository, isMain: true };
  const cases = [
    { thread: main, requestParams: { model: "gpt-6-astra", effort: "xhigh" } },
    { thread: { ...main, isMain: false }, requestParams: { model: "gpt-5.6-sol" } },
    { thread: { ...main, cwd: "/other" }, requestParams: { model: "gpt-5.6-sol" } },
    { thread: main, requestParams: { model: "gpt-5.6-terra" } },
  ];
  assert.deepEqual(cases.map((entry) => selectModel({ config: makeConfig(), ...entry }).apply), [false, false, false, false]);
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
  }, { experimental: true, notifications: ["irrelevant"], first: existing, added: "switch_main_model", instructions: "keep instructions", required: ["model"] });
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
  const call = { id: "tool-call", method: "item/tool/call", params: { threadId: "main", turnId: "old-turn", callId: "switch-item", namespace: null, tool: "switch_main_model", arguments: { model: "gpt-6-astra" } } };
  return { ...context, call };
}

function switch_main_model(engine, call) {
  const result = engine.processServerMessage(call);
  if (result.upstream[0]?.method !== "thread/backgroundTerminals/list") return result;
  return engine.processServerMessage({ id: result.upstream[0].id, result: { data: [], nextCursor: null } });
}

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
  const { engine, call } = beginSwitchTest({ params: { permissions: "old-profile", cwd: "/repo/app", runtimeWorkspaceRoots: ["/repo/app"], environments: [], additionalContext: { a: { text: "keep" } } } });
  engine.processClientMessage({ id: "live-reviewer", method: "turn/settings/update", params: { threadId: "main", turnId: "old-turn", approvalsReviewer: "user" } });
  engine.processServerMessage({ id: "live-reviewer", result: { status: "applied" } });
  engine.processServerMessage({ method: "thread/settings/updated", params: { threadId: "main", threadSettings: {
    model: "gpt-5.6-sol", effort: "high", collaborationMode: { mode: "plan", settings: { model: "gpt-5.6-sol", reasoning_effort: "high", developer_instructions: "latest instructions" } },
  } } });
  const interrupt = switch_main_model(engine, call).upstream[0];
  engine.processServerMessage({ id: interrupt.id, result: {} });
  const settings = engine.processServerMessage({ method: "turn/completed", params: { threadId: "main", turn: { id: "old-turn", status: "interrupted" } } }).upstream[0];
  const continuation = engine.processServerMessage({ id: settings.id, result: {} }).upstream[0];
  for (const key of ["permissions", "sandboxPolicy", "approvalPolicy", "cwd", "runtimeWorkspaceRoots", "environments"]) assert.equal(continuation.params[key], undefined);
  assert.equal(continuation.params.collaborationMode.mode, "plan");
  assert.equal(continuation.params.collaborationMode.settings.developer_instructions, "latest instructions");
  assert.deepEqual(continuation.params.additionalContext, { a: { text: "keep" } });
  assert.deepEqual(continuation.params.outputSchema, { type: "object" });
  assert.equal(continuation.params.approvalsReviewer, "user");
});

test("理由なしの変更は完了通知を待って同じタスクを新モデルで続行し、権限・指示を維持する", () => {
  const { engine, call, diagnostics } = beginSwitchTest();
  const interrupt = switch_main_model(engine, call);
  assert.equal(interrupt.upstream[0].method, "turn/interrupt");
  assert.equal(engine.processServerMessage({ id: interrupt.upstream[0].id, result: {} }).upstream.length, 0);
  const completed = engine.processServerMessage({ method: "turn/completed", params: { threadId: "main", turn: { id: "old-turn", status: "interrupted" } } });
  const settings = completed.upstream[0];
  assert.equal(settings.method, "thread/settings/update");
  const continued = engine.processServerMessage({ id: settings.id, result: {} }).upstream[0];
  assert.deepEqual({
    method: continued.method, task: continued.params.threadId, input: continued.params.input,
    model: continued.params.model, effort: continued.params.effort,
    mode: continued.params.collaborationMode, approval: continued.params.approvalPolicy,
    sandbox: continued.params.sandboxPolicy, schema: continued.params.outputSchema,
    tool: continued.params.toolOutput.name, userMessage: continued.params.clientUserMessageId,
  }, { method: "turn/start", task: "main", input: [], model: "gpt-6-astra", effort: "high",
    mode: { mode: "default", settings: { model: "gpt-6-astra", reasoning_effort: "high", developer_instructions: "keep mode instructions" } },
    approval: undefined, sandbox: undefined, schema: { type: "object" },
    tool: "switch_main_model", userMessage: undefined });
  assert.equal(diagnostics.events.some((entry) => entry.event === "switch-accepted"), false);
  engine.processServerMessage({ id: continued.id, result: { turn: { id: "new-turn", status: "inProgress" } } });
  assert.equal(diagnostics.events.at(-1).event, "switch-accepted");
});

test("同じモデル、不正指定、利用不能モデル、古いターン、子を中断しない", () => {
  const cases = [
    { args: { model: "gpt-5.6-sol" }, success: true },
    { args: { model: "gpt-6-astra", reason: "not allowed" }, success: false },
    { args: { model: "unknown" }, success: false },
    { args: { model: "gpt-6-astra" }, turnId: "old-other", success: false },
    { args: { model: "gpt-6-astra" }, options: { parentThreadId: "parent" }, success: false },
  ];
  for (const entry of cases) {
    const { engine, call } = beginSwitchTest(entry.options);
    call.params.arguments = entry.args;
    if (entry.turnId) call.params.turnId = entry.turnId;
    const result = switch_main_model(engine, call);
    assert.deepEqual({ method: result.upstream[0].method, success: result.upstream[0].result.success }, { method: undefined, success: entry.success });
  }
});

test("並行ツールや承認待ちがある間は変更を拒否し、通常の承認応答は透過する", () => {
  const { engine, call } = beginSwitchTest();
  const approval = { id: 8, method: "item/commandExecution/requestApproval", params: { threadId: "main", turnId: "old-turn" } };
  engine.processServerMessage(approval);
  assert.equal(switch_main_model(engine, call).upstream[0].result.success, false);
  const response = { id: 8, result: { decision: "decline" } };
  assert.equal(engine.processClientMessage(response).message, response);
  engine.processServerMessage({ method: "item/started", params: { threadId: "main", turnId: "old-turn", item: { id: "command", type: "commandExecution" } } });
  assert.equal(switch_main_model(engine, call).upstream[0].result.success, false);
  engine.processServerMessage({ method: "item/completed", params: { threadId: "main", turnId: "old-turn", item: { id: "command", type: "commandExecution" } } });
  assert.equal(switch_main_model(engine, call).upstream[0].method, "turn/interrupt");
});

test("停止・新しいユーザー入力・重複完了は自動続行を増殖させない", () => {
  for (const method of ["turn/interrupt", "turn/start", "turn/steer", "thread/archive"]) {
    const { engine, call } = beginSwitchTest();
    switch_main_model(engine, call);
    engine.processClientMessage({ id: "user", method, params: { threadId: "main", turnId: "old-turn", input: [{ type: "text", text: "stop/change" }] } });
    const result = engine.processServerMessage({ method: "turn/completed", params: { threadId: "main", turn: { id: "old-turn", status: "interrupted" } } });
    assert.equal(result?.upstream?.length ?? 0, 0);
  }
  const { engine, call } = beginSwitchTest();
  const interrupt = switch_main_model(engine, call).upstream[0];
  const event = { method: "turn/completed", params: { threadId: "main", turn: { id: "old-turn", status: "interrupted" } } };
  engine.processServerMessage({ id: interrupt.id, result: {} });
  engine.processServerMessage(event);
  assert.equal(engine.processServerMessage(event)?.upstream?.length ?? 0, 0);
});

test("中断や開始失敗を成功扱いせず別タスクを変更しない", () => {
  const { engine, call, diagnostics } = beginSwitchTest();
  announceThread(engine, "other", { model: "gpt-5.6-sol" });
  const before = structuredClone(engine.threads.other);
  const interrupt = switch_main_model(engine, call).upstream[0];
  const failed = engine.processServerMessage({ id: interrupt.id, error: { code: -1, message: "cannot interrupt" } });
  assert.equal(failed.upstream[0].result.success, false);
  assert.deepEqual(engine.threads.other, before);
  assert.equal(diagnostics.events.some((entry) => entry.event === "switch-accepted"), false);
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
  const interrupt = switch_main_model(engine, call).upstream[0];
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
  assert.equal(nextB.message.params.model, "gpt-5.6-sol");
  assert.equal(nextB.message.params.effort, "high");
});

test("AとBの切り替え応答が交錯しても、それぞれ指定したモデルで続行する", () => {
  const { engine, call } = beginSwitchTest();
  announceThread(engine, "task-b", { model: "gpt-6-astra", effort: "high" });
  engine.processClientMessage(turnRequest("begin-b", "task-b", { model: "gpt-6-astra", effort: "high" }));
  engine.processServerMessage({ id: "begin-b", result: { turn: { id: "b-running", status: "inProgress" } } });
  const callB = { ...call, id: "tool-b", params: { ...call.params, threadId: "task-b", turnId: "b-running", callId: "switch-b", arguments: { model: "gpt-5.6-sol" } } };
  const interruptA = switch_main_model(engine, call).upstream[0];
  const interruptB = switch_main_model(engine, callB).upstream[0];
  // Aは通知→応答、Bは応答→通知。設定の受付はB→Aと逆順にする。
  engine.processServerMessage({ method: "turn/completed", params: { threadId: "main", turn: { id: "old-turn", status: "interrupted" } } });
  engine.processServerMessage({ id: interruptB.id, result: {} });
  const settingsA = engine.processServerMessage({ id: interruptA.id, result: {} }).upstream[0];
  const settingsB = engine.processServerMessage({ method: "turn/completed", params: { threadId: "task-b", turn: { id: "b-running", status: "interrupted" } } }).upstream[0];
  const continuationB = engine.processServerMessage({ id: settingsB.id, result: {} }).upstream[0];
  const continuationA = engine.processServerMessage({ id: settingsA.id, result: {} }).upstream[0];
  assert.deepEqual([settingsA, continuationA].map((request) => [request.params.threadId, request.params.model]), [["main", "gpt-6-astra"], ["main", "gpt-6-astra"]]);
  assert.deepEqual([settingsB, continuationB].map((request) => [request.params.threadId, request.params.model]), [["task-b", "gpt-5.6-sol"], ["task-b", "gpt-5.6-sol"]]);
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
  assert.equal(engine.processClientMessage(turnRequest(12, "resumed")).message.params.model, "gpt-6-astra");
});

test("続行の開始が停止と競合したら、新しく受理された区間も停止する", () => {
  const { engine, call, diagnostics } = beginSwitchTest();
  const interrupt = switch_main_model(engine, call).upstream[0];
  engine.processServerMessage({ id: interrupt.id, result: {} });
  const settings = engine.processServerMessage({ method: "turn/completed", params: { threadId: "main", turn: { id: "old-turn", status: "interrupted" } } }).upstream[0];
  const continuation = engine.processServerMessage({ id: settings.id, result: {} }).upstream[0];
  engine.processClientMessage({ id: 999, method: "turn/interrupt", params: { threadId: "main", turnId: "old-turn" } });
  const result = engine.processServerMessage({ id: continuation.id, result: { turn: { id: "late-turn", status: "inProgress" } } });
  assert.deepEqual(result.upstream[0]?.params, { threadId: "main", turnId: "late-turn" });
  assert.equal(diagnostics.events.some((entry) => entry.event === "switch-accepted"), false);
});

test("完了通知が応答より先でも一度だけ続行し、開始失敗を利用者へ知らせる", () => {
  const { engine, call, diagnostics } = beginSwitchTest();
  const interrupt = switch_main_model(engine, call).upstream[0];
  const completed = { method: "turn/completed", params: { threadId: "main", turn: { id: "old-turn", status: "interrupted" } } };
  assert.equal(engine.processServerMessage(completed).upstream.length, 0);
  const settings = engine.processServerMessage({ id: interrupt.id, result: {} }).upstream[0];
  const continuation = engine.processServerMessage({ id: settings.id, result: {} }).upstream[0];
  const failed = engine.processServerMessage({ id: continuation.id, error: { code: -1, message: "start refused" } });
  assert.match(failed.downstream[0].params.error.message, /start refused/);
  assert.equal(diagnostics.events.some((entry) => entry.event === "switch-accepted"), false);
  assert.equal(engine.processServerMessage({ id: continuation.id, result: {} }).consume, true);
});

test("開始タイムアウト後に届く遅い成功も停止し、裏で実行を続けない", () => {
  const { engine, call, diagnostics } = beginSwitchTest();
  const interrupt = switch_main_model(engine, call).upstream[0];
  engine.processServerMessage({ id: interrupt.id, result: {} });
  const settings = engine.processServerMessage({ method: "turn/completed", params: { threadId: "main", turn: { id: "old-turn", status: "interrupted" } } }).upstream[0];
  const continuation = engine.processServerMessage({ id: settings.id, result: {} }).upstream[0];
  const timeout = engine.processServerMessage({ id: continuation.id, error: { code: -32091, message: "model-router: turn/start timed out" } });
  assert.match(timeout.downstream[0].params.error.message, /timed out/);
  const late = engine.processServerMessage({ id: continuation.id, result: { turn: { id: "late-turn", status: "inProgress" } } });
  assert.deepEqual(late.upstream[0]?.params, { threadId: "main", turnId: "late-turn" });
  assert.equal(diagnostics.events.some((entry) => entry.event === "switch-accepted"), false);
});

test("中断受付後に完了通知が失われても待ち続けず失敗を返す", async () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "model-router-timeout-"));
  const fakeCodex = path.join(temporary, "codex");
  writeFileSync(fakeCodex, `#!/usr/bin/env node
if (process.argv[2] === "--version") { console.log("codex-cli 0.153.1"); process.exit(0); }
const readline = require("node:readline");
const send = (message) => console.log(JSON.stringify(message));
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ id: m.id, result: {} });
  if (m.method === "model/list") send({ id: m.id, result: { data: ["gpt-5.6-sol", "gpt-6-astra"].map(model => ({ model, supportedReasoningEfforts: [{ reasoningEffort: "high" }] })), nextCursor: null } });
  if (m.method === "thread/start") send({ id: m.id, result: { thread: { id: "main", parentThreadId: null, cwd: ${JSON.stringify(repository)}, model: "gpt-5.6-sol", status: { type: "idle" } } } });
  if (m.method === "turn/start") {
    send({ id: m.id, result: { turn: { id: "turn", status: "inProgress" } } });
    send({ id: "switch", method: "item/tool/call", params: { threadId: "main", turnId: "turn", callId: "switch", namespace: null, tool: "switch_main_model", arguments: { model: "gpt-6-astra" } } });
  }
  if (m.method === "thread/backgroundTerminals/list") send({ id: m.id, result: { data: [], nextCursor: null } });
  if (m.method === "turn/interrupt") { send({ id: m.id, result: {} }); send({ method: "test/ready" }); }
  if (!m.method && m.id === "switch") send({ method: "test/result", params: m.result });
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
    if (message.method === "test/result") finish(message.params);
  } });
  output.on("data", (chunk) => lines.push(chunk));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const exited = new Promise((resolve) => runAppServerProxy({ config: makeConfig(), innerCodexPath: fakeCodex,
    args: ["app-server"], stateDirectory: temporary, clientReadable: input, clientWritable: output, onExit: resolve }));
  try {
    input.write(JSON.stringify({ id: 1, method: "initialize", params: {} }) + "\n");
    await readyPromise;
    await vi.advanceTimersByTimeAsync(30_001);
    const result = await resultPromise;
    assert.deepEqual({ success: result.success, timedOut: result.contentItems[0].text.includes("timed out") }, { success: false, timedOut: true });
  } finally {
    input.end();
    await exited;
    vi.useRealTimers();
  }
});

test("initialized通知がなくてもinitialize応答後にモデルカタログを取得する", async () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "model-router-initialize-"));
  const fakeCodex = path.join(temporary, "codex");
  writeFileSync(
    fakeCodex,
    `#!/usr/bin/env node
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

test("未対応CLIでは要求を透過中継する", () => {
  const { engine } = makeEngine(makeConfig(), { compatible: false });
  announceThread(engine, "thread-1");
  const request = turnRequest(80, "thread-1");
  const action = engine.processClientMessage(request);
  assert.equal(action.modified, false);
  assert.equal(action.message, request);
});

test("承認要求と応答を双方向にそのまま中継する", () => {
  const { engine } = makeEngine();
  const approval = {
    method: "item/commandExecution/requestApproval",
    id: "server-request-1",
    params: { threadId: "thread-1", turnId: "turn-1", command: "npm test" },
  };
  assert.equal(engine.processServerMessage(approval), undefined);
  const response = { id: "server-request-1", result: { decision: "accept" } };
  assert.deepEqual(engine.processClientMessage(response), {
    type: "forward",
    message: response,
    modified: false,
  });
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
  assert.throws(() => makeConfig({ models: {} }), /at least one model/);
  assert.throws(() => makeConfig({ mode: "fixed" }), /removed/);
  assert.throws(() => makeConfig({ enabledRepositories: ["relative/repository"] }), /absolute paths/);
});

test("モデルごとの設定をオブジェクトとして受け取り、設定全体を保持する", () => {
  const models = { "gpt-5.6-sol": { effort: "high", futureOption: { value: "keep" } } };
  const config = makeConfig({ models, extraSetting: { enabled: true } });
  assert.deepEqual({ models: config.models, extraSetting: config.extraSetting }, { models, extraSetting: { enabled: true } });
});

test("不正なモデル定義と旧形式を設定の読み込み時に拒否する", () => {
  const cases = [
    [{ efforts: { "gpt-5.6-sol": "high" } }, /removed/],
    [{ models: null }, /config.models must be an object/],
    [{ models: [] }, /config.models must be an object/],
    [{ models: { default: "gpt-5.6-sol" } }, /must be an object/],
    ...[null, [], "high"].map((settings) => [{ models: { "gpt-5.6-sol": settings } }, /must be an object/]),
    ...[undefined, null, "", 1].map((effort) => [{ models: { "gpt-5.6-sol": { effort } } }, /effort must be a non-empty string/]),
  ];
  for (const [input, error] of cases) assert.throws(() => makeConfig(input), error);
});

test("モデル内の追加項目を保持しても他タスクの指定や未対応設定を送信しない", () => {
  const config = makeConfig({ models: { "gpt-5.6-sol": { effort: "high" }, "gpt-6-astra": { effort: "high", threadId: "other", futureOption: true } } });
  const { engine, call } = beginSwitchTest({ config });
  const interrupt = switch_main_model(engine, call).upstream[0];
  engine.processServerMessage({ id: interrupt.id, result: {} });
  const settings = engine.processServerMessage({ method: "turn/completed", params: { threadId: "main", turn: { id: "old-turn", status: "interrupted" } } }).upstream[0];
  const continuation = engine.processServerMessage({ id: settings.id, result: {} }).upstream[0];
  assert.deepEqual([settings, continuation].map((request) => ({ threadId: request.params.threadId, model: request.params.model, effort: request.params.effort, futureOption: request.params.futureOption })), [
    { threadId: "main", model: "gpt-6-astra", effort: "high", futureOption: undefined },
    { threadId: "main", model: "gpt-6-astra", effort: "high", futureOption: undefined },
  ]);
});

test("Desktopプロセスを検出できない環境では起動しない", () => {
  const fakeBin = mkdtempSync(path.join(tmpdir(), "model-router-bin-"));
  const fakePgrep = path.join(fakeBin, "pgrep");
  const fakeCodex = path.join(fakeBin, "codex");
  writeFileSync(fakePgrep, "#!/bin/sh\nexit 3\n");
  writeFileSync(fakeCodex, "#!/bin/sh\nexit 0\n");
  chmodSync(fakePgrep, 0o755);
  chmodSync(fakeCodex, 0o755);

  const result = spawnSync(path.join(repositoryRoot, "bin", "model-router"), ["app", repositoryRoot], {
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
  const temporary = mkdtempSync(path.join(tmpdir(), "model-router-app-"));
  const fakePgrep = path.join(temporary, "pgrep");
  const fakeCodex = path.join(temporary, "codex");
  const capturePath = path.join(temporary, "arguments.txt");
  const configPath = path.join(temporary, "config.json");
  writeFileSync(fakePgrep, "#!/bin/sh\nexit 1\n");
  writeFileSync(
    fakeCodex,
    `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then
  printf 'codex-cli 0.153.1\\n'
  exit 0
fi
printf '%s\\n' "$@" > "$CODEX_AUTO_CAPTURE_PATH"
`,
  );
  chmodSync(fakePgrep, 0o755);
  chmodSync(fakeCodex, 0o755);
  writeFileSync(configPath, JSON.stringify(makeConfig({ innerCodexPath: fakeCodex })));

  const result = spawnSync(path.join(repositoryRoot, "bin", "model-router"), ["app"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      PATH: `${temporary}:${process.env.PATH}`,
      CODEX_AUTO_CAPTURE_PATH: capturePath,
      CODEX_AUTO_CODEX_BIN: fakeCodex,
      CODEX_MODEL_ROUTER_CONFIG: configPath,
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(capturePath, "utf8").trim().split("\n"), [
    "app",
    repositoryRoot,
  ]);
});

test("サブコマンドなしでCLI版をカレントディレクトリのルーターへ接続する", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "model-router-cli-"));
  const fakeCodex = path.join(temporary, "codex");
  const capturePath = path.join(temporary, "arguments.txt");
  const configPath = path.join(temporary, "config.json");
  writeFileSync(
    fakeCodex,
    `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then
  printf 'codex-cli 0.153.4\\n'
  exit 0
fi
if [ "\${1:-}" = "app-server" ]; then
  while IFS= read -r line; do :; done
  exit 0
fi
printf '%s\\n' "$@" > "$CODEX_AUTO_CAPTURE_PATH"
`,
  );
  chmodSync(fakeCodex, 0o755);
  writeFileSync(
    configPath,
    JSON.stringify(makeConfig({ innerCodexPath: fakeCodex, supportedCliVersions: ["0.153.4"] })),
  );

  const result = spawnSync(path.join(repositoryRoot, "bin", "model-router"), ["--search"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CODEX_AUTO_CAPTURE_PATH: capturePath,
      CODEX_AUTO_CODEX_BIN: fakeCodex,
      CODEX_MODEL_ROUTER_CONFIG: configPath,
      CODEX_MODEL_ROUTER_STATE_DIR: path.join(temporary, "state"),
    },
    encoding: "utf8",
    timeout: 10_000,
  });

  assert.equal(result.status, 0, result.stderr);
  const argumentsList = readFileSync(capturePath, "utf8").trim().split("\n");
  assert.equal(argumentsList[0], "--remote");
  assert.match(argumentsList[1], /^unix:\/\//u);
  assert.deepEqual(argumentsList.slice(2), ["-C", repositoryRoot, "--search"]);
});

test("設定ファイル内の行コメントを許可する", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "model-router-config-"));
  const fakeCodex = path.join(temporary, "codex");
  const configPath = path.join(temporary, "config.json");
  writeFileSync(fakeCodex, '#!/bin/sh\nprintf \'codex-cli 0.153.1\\n\'\n');
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
      CODEX_MODEL_ROUTER_CONFIG: configPath,
      CODEX_MODEL_ROUTER_INNER_CODEX: fakeCodex,
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
});
