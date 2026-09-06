import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
  JsonLineDecoder,
  MemoryDiagnostics,
  MemoryStateStore,
  RouterEngine,
} from "../src/proxy.mjs";
import {
  getAdvisoryRecommendation,
  isRepositoryEnabled,
  selectModel,
  validateConfig,
} from "../src/policy.mjs";
import { WebSocketFrameDecoder } from "../src/websocket.mjs";

const repository = "/Users/test/project";
const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function makeConfig(overrides = {}) {
  return validateConfig({
    schemaVersion: 1,
    mode: "auto",
    rulesVersion: "test.1",
    enabledRepositories: [repository],
    models: { default: "gpt-5.6-sol", escalated: "gpt-6-astra" },
    efforts: { "gpt-5.6-sol": "high", "gpt-6-astra": "high" },
    requestModelPolicy: "replace",
    fixedModel: null,
    threadPins: {},
    escalatedThreads: {},
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

test("自由文のリスク語句だけではAstraへ自動昇格しない", () => {
  const config = makeConfig();
  const thread = { id: "thread-1", cwd: repository, isMain: true, unresolvedReasons: [] };
  const requestParams = {
    cwd: repository,
    input: [{ type: "text", text: "請求と権限の不変条件を変更する" }],
  };
  assert.deepEqual(getAdvisoryRecommendation(requestParams.input, config.models), {
    model: "gpt-6-astra",
    reasonCode: "advisory-risk-language",
    confidence: "low",
  });
  const decision = selectModel({ config, thread, requestParams });
  assert.equal(decision.model, "gpt-5.6-sol");
  assert.equal(decision.reasonCode, "auto-default");
  assert.equal(decision.advisory.model, "gpt-6-astra");
});

test("観測モード・対象外リポジトリ・サブエージェントの設定を保持する", () => {
  const observe = makeConfig({ mode: "observe" });
  const main = { id: "main", cwd: repository, isMain: true };
  assert.equal(
    selectModel({ config: observe, thread: main, requestParams: { cwd: repository } }).reasonCode,
    "observe-only",
  );
  assert.equal(
    selectModel({
      config: makeConfig(),
      thread: { ...main, cwd: "/Users/test/other" },
      requestParams: {},
    }).reasonCode,
    "repository-not-enabled",
  );
  assert.equal(
    selectModel({
      config: makeConfig(),
      thread: { ...main, isMain: false },
      requestParams: { cwd: repository },
    }).reasonCode,
    "not-confirmed-main-thread",
  );
});

test("既定effort未定義のユーザー指定モデルへeffortを補わない", () => {
  const config = makeConfig({ requestModelPolicy: "preserve" });
  const decision = selectModel({
    config,
    thread: { id: "thread-1", cwd: repository, isMain: true },
    requestParams: { cwd: repository, model: "gpt-5.6-terra" },
  });
  assert.equal(decision.apply, false);
  assert.equal(decision.model, null);
  assert.equal(decision.effort, null);
  assert.equal(decision.reasonCode, "request-model-preserved");
});

test("ユーザーがモデルだけ指定した場合はモデル別の既定effortを使う", () => {
  const config = makeConfig({ requestModelPolicy: "preserve" });
  const decision = selectModel({
    config,
    thread: { id: "thread-1", cwd: repository, isMain: true },
    requestParams: { cwd: repository, model: "gpt-6-astra" },
  });
  assert.equal(decision.apply, true);
  assert.equal(decision.model, "gpt-6-astra");
  assert.equal(decision.effort, "high");
  assert.equal(decision.reasonCode, "user-model");
});

test("collaborationMode のユーザー指定を優先する", () => {
  const config = makeConfig({ requestModelPolicy: "preserve" });
  const decision = selectModel({
    config,
    thread: { id: "thread-1", cwd: repository, isMain: true },
    requestParams: {
      cwd: repository,
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-6-astra",
          reasoning_effort: "high",
          developer_instructions: null,
        },
      },
    },
  });
  assert.deepEqual(
    { apply: decision.apply, model: decision.model, effort: decision.effort, reason: decision.reasonCode },
    { apply: true, model: "gpt-6-astra", effort: "high", reason: "user-model-and-effort" },
  );
});

test("ユーザー指定のモデルとeffortを自動判定より優先する", () => {
  const config = makeConfig({
    requestModelPolicy: "preserve",
    threadPins: { "thread-1": { model: "gpt-6-astra", effort: "xhigh" } },
  });
  const decision = selectModel({
    config,
    thread: { id: "thread-1", cwd: repository, isMain: true },
    requestParams: { cwd: repository, model: "gpt-5.6-sol", effort: "high" },
  });
  assert.equal(decision.apply, true);
  assert.equal(decision.model, "gpt-5.6-sol");
  assert.equal(decision.effort, "high");
  assert.equal(decision.reasonCode, "user-model-and-effort");
});

test("受信値を既定扱いにした場合は会話固定を優先する", () => {
  const config = makeConfig({
    requestModelPolicy: "replace",
    threadPins: { "thread-1": { model: "gpt-6-astra" } },
  });
  const decision = selectModel({
    config,
    thread: { id: "thread-1", cwd: repository, isMain: true },
    requestParams: { cwd: repository, model: "gpt-5.6-terra" },
  });
  assert.equal(decision.model, "gpt-6-astra");
  assert.equal(decision.effort, "high");
  assert.equal(decision.reasonCode, "thread-pin");
});

test("新規ターンではモデル項目だけを変更してモード指示を保持する", () => {
  const { engine } = makeEngine();
  announceThread(engine, "thread-1");
  const request = turnRequest(1, "thread-1", {
    collaborationMode: {
      mode: "default",
      settings: {
        model: "gpt-5.6-terra",
        reasoning_effort: "medium",
        developer_instructions: "keep this exact instruction",
      },
    },
  });
  const action = engine.processClientMessage(request);
  assert.equal(action.type, "forward");
  assert.equal(action.modified, true);
  assert.equal(action.message.params.model, "gpt-5.6-sol");
  assert.equal(action.message.params.effort, "high");
  assert.equal(action.message.params.collaborationMode.settings.model, "gpt-5.6-sol");
  assert.equal(action.message.params.collaborationMode.settings.reasoning_effort, "high");
  assert.equal(
    action.message.params.collaborationMode.settings.developer_instructions,
    "keep this exact instruction",
  );
  assert.equal(action.message.params.approvalPolicy, "unlessTrusted");
  assert.deepEqual(action.message.params.sandboxPolicy, { type: "workspaceWrite" });
  assert.equal(request.params.model, undefined, "the received message must not be mutated");
});

test("turn start受理後に限って選択状態を確定する", () => {
  const { engine, stateStore } = makeEngine();
  announceThread(engine, "thread-1");
  engine.processClientMessage(turnRequest(10, "thread-1"));
  assert.equal(stateStore.threads["thread-1"].selectedModel, "gpt-5.6-terra");
  engine.processServerMessage({ id: 10, error: { code: -1, message: "rejected" } });
  assert.equal(stateStore.threads["thread-1"].selectedModel, "gpt-5.6-terra");

  engine.processClientMessage(turnRequest(11, "thread-1"));
  engine.processServerMessage({
    id: 11,
    result: { turn: { id: "turn-11", status: "inProgress" } },
  });
  assert.equal(stateStore.threads["thread-1"].selectedModel, "gpt-5.6-sol");
  assert.equal(stateStore.threads["thread-1"].selectedEffort, "high");
  assert.equal(stateStore.threads["thread-1"].activeTurnId, "turn-11");
});

test("実行中ターンへ届いたturn startを書き換えない", () => {
  const { engine } = makeEngine();
  announceThread(engine, "thread-1", { status: { type: "active", activeFlags: [] } });
  const action = engine.processClientMessage(turnRequest(20, "thread-1"));
  assert.equal(action.modified, false);
  assert.equal(action.message.params.model, undefined);
});

test("保留中のturn startがある場合は後続要求を新規ターン扱いしない", () => {
  const { diagnostics, engine } = makeEngine();
  announceThread(engine, "thread-1");
  const first = engine.processClientMessage(turnRequest(30, "thread-1"));
  const second = engine.processClientMessage(turnRequest(31, "thread-1"));
  assert.equal(first.modified, true);
  assert.equal(second.modified, false);
  assert.equal(diagnostics.events.at(-1).reasonCode, "active-turn-input");
});

test("ターン完了後は次の新規ターンで再判定する", () => {
  const { engine } = makeEngine();
  announceThread(engine, "thread-1");
  engine.processClientMessage(turnRequest(40, "thread-1"));
  engine.processServerMessage({ id: 40, result: { turn: { id: "turn-40", status: "inProgress" } } });
  engine.processServerMessage({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-40", status: "completed" } },
  });
  assert.equal(engine.processClientMessage(turnRequest(41, "thread-1")).modified, true);
});

test("受理されたユーザー指定を次のターンでも維持する", () => {
  const config = makeConfig({ requestModelPolicy: "preserve" });
  const { engine } = makeEngine(config);
  announceThread(engine, "thread-1");
  engine.processClientMessage(
    turnRequest(42, "thread-1", { model: "gpt-6-astra", effort: "high" }),
  );
  engine.processServerMessage({
    id: 42,
    result: { turn: { id: "turn-42", status: "inProgress" } },
  });
  engine.processServerMessage({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-42", status: "completed" } },
  });
  const next = engine.processClientMessage(turnRequest(43, "thread-1"));
  assert.deepEqual(
    { model: next.message.params.model, effort: next.message.params.effort },
    { model: "gpt-6-astra", effort: "high" },
  );
});

test("会話状態を分離してサブエージェントを対象外にする", () => {
  const { engine } = makeEngine();
  announceThread(engine, "main-a");
  announceThread(engine, "main-b");
  announceThread(engine, "child", { parentThreadId: "main-a" });
  assert.equal(engine.processClientMessage(turnRequest(50, "main-a")).modified, true);
  assert.equal(engine.processClientMessage(turnRequest(51, "main-b")).modified, true);
  assert.equal(engine.processClientMessage(turnRequest(52, "child")).modified, false);
});

test("確認済みの未解決理由がある間はAstraを維持する", () => {
  const config = makeConfig({ escalatedThreads: { "thread-1": ["cross-domain-invariant"] } });
  const { engine } = makeEngine(config);
  announceThread(engine, "thread-1");
  const action = engine.processClientMessage(turnRequest(60, "thread-1"));
  assert.equal(action.message.params.model, "gpt-6-astra");
  assert.equal(action.message.params.effort, "high");
});

test("利用不能モデルを代替せず送信前に拒否する", () => {
  const config = makeConfig({
    fixedModel: "gpt-does-not-exist",
    mode: "fixed",
    efforts: {
      "gpt-5.6-sol": "high",
      "gpt-6-astra": "high",
      "gpt-does-not-exist": "xhigh",
    },
  });
  const { diagnostics, engine } = makeEngine(config);
  announceThread(engine, "thread-1");
  const action = engine.processClientMessage(turnRequest(70, "thread-1"));
  assert.equal(action.type, "local-error");
  assert.equal(action.message.id, 70);
  assert.match(action.message.error.message, /not available/);
  assert.equal(diagnostics.events.at(-1).reasonCode, "model-unavailable");
});

test("モデル一覧を確認できない場合は書き換え要求を拒否する", () => {
  const config = makeConfig({ mode: "fixed", fixedModel: "gpt-6-astra" });
  const { engine } = makeEngine(config);
  announceThread(engine, "thread-1");
  engine.setModelCatalogUnavailable("catalog test failure");
  const action = engine.processClientMessage(turnRequest(71, "thread-1"));
  assert.equal(action.type, "local-error");
  assert.match(action.message.error.message, /cannot verify model availability/);
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

test("曖昧または不正な設定値を起動前に拒否する", () => {
  assert.throws(() => makeConfig({ mode: "semantic-magic" }), /observe, fixed, or auto/);
  assert.throws(
    () => makeConfig({ enabledRepositories: ["relative/repository"] }),
    /absolute paths/,
  );
  assert.throws(() => makeConfig({ fixedModel: "" }), /non-empty string/);
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
