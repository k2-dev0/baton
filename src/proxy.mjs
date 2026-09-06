#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  constants as fsConstants,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { applySelection, selectModel, validateConfig } from "./policy.mjs";

const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.dirname(SOURCE_DIR);
const DEFAULT_CONFIG_PATH = path.join(PROJECT_DIR, "config.json");
const DEFAULT_STATE_DIR = path.join(
  homedir(),
  "Library",
  "Application Support",
  "codex-model-router",
);

// 未検証のJSON値を、配列を除くオブジェクトとして判定する。
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// 数値IDと同じ文字列IDを混同しない保留要求キーを作る。
function requestKey(id) {
  return `${typeof id}:${String(id)}`;
}

// 双方向JSON-RPCの応答IDを型も含めて比較する。
function sameRequestId(left, right) {
  return typeof left === typeof right && left === right;
}

// JSON-RPCが対応対象とする文字列または数値の要求IDを持つか判定する。
function hasRequestId(message) {
  return isObject(message) && (typeof message.id === "string" || typeof message.id === "number");
}

// 通知や応答と区別してJSON-RPC要求だけを判定する。
function isRequest(message) {
  return hasRequestId(message) && typeof message.method === "string";
}

// 保存値と受信値の参照を共有しないJSON互換コピーを作る。
function cloneJson(value) {
  return structuredClone(value);
}

export class JsonLineDecoder {
  constructor({ maxBufferedBytes, onLine }) {
    this.maxBufferedBytes = maxBufferedBytes;
    this.onLine = onLine;
    this.decoder = new StringDecoder("utf8");
    this.buffer = "";
  }

  push(chunk) {
    this.buffer += this.decoder.write(chunk);
    this.#checkLimit();
    this.#drainLines();
  }

  end(chunk) {
    if (chunk) this.buffer += this.decoder.end(chunk);
    else this.buffer += this.decoder.end();
    this.#checkLimit();
    this.#drainLines();
    if (this.buffer.length > 0) {
      const line = this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer;
      this.buffer = "";
      this.onLine(line);
    }
  }

  #checkLimit() {
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxBufferedBytes) {
      throw new Error(`protocol line exceeds ${this.maxBufferedBytes} bytes`);
    }
  }

  #drainLines() {
    let newline;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) this.onLine(line);
    }
  }
}

export class Diagnostics {
  constructor(directory, now = () => new Date()) {
    this.directory = directory;
    this.now = now;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = path.join(directory, "router.jsonl");
  }

  record(event, fields = {}) {
    appendFileSync(
      this.file,
      `${JSON.stringify({ timestamp: this.now().toISOString(), event, ...fields })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }
}

export class StateStore {
  constructor(directory, rulesVersion) {
    this.directory = directory;
    this.rulesVersion = rulesVersion;
    this.file = path.join(directory, "state.json");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.state = this.#load();
  }

  #load() {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));
      if (parsed.schemaVersion !== 1 || !isObject(parsed.threads)) {
        throw new Error("unsupported state schema");
      }
      return { ...parsed, rulesVersion: this.rulesVersion };
    } catch (error) {
      if (error?.code !== "ENOENT") {
        const backup = `${this.file}.invalid-${Date.now()}`;
        try {
          renameSync(this.file, backup);
        } catch {
          // A missing or concurrently moved file is equivalent to empty state.
        }
      }
      return { schemaVersion: 1, rulesVersion: this.rulesVersion, threads: {} };
    }
  }

  getThreads() {
    return cloneJson(this.state.threads);
  }

  saveThreads(threads) {
    this.state = {
      schemaVersion: 1,
      rulesVersion: this.rulesVersion,
      updatedAt: new Date().toISOString(),
      threads: cloneJson(threads),
    };
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporary, this.file);
  }
}

export class MemoryStateStore {
  constructor(initial = {}) {
    this.threads = cloneJson(initial);
  }

  getThreads() {
    return cloneJson(this.threads);
  }

  saveThreads(threads) {
    this.threads = cloneJson(threads);
  }
}

export class MemoryDiagnostics {
  constructor() {
    this.events = [];
  }

  record(event, fields = {}) {
    this.events.push({ event, ...cloneJson(fields) });
  }
}

export class RouterEngine {
  constructor({ config, diagnostics, stateStore, compatible = true }) {
    this.config = config;
    this.diagnostics = diagnostics;
    this.stateStore = stateStore;
    this.compatible = compatible;
    this.threads = stateStore.getThreads();
    this.pending = new Map();
    this.modelCatalog = null;
    this.catalogError = null;
  }

  setModelCatalog(entries) {
    this.modelCatalog = new Map();
    for (const entry of entries) {
      if (!isObject(entry)) continue;
      const model = typeof entry.model === "string" ? entry.model : entry.id;
      if (typeof model !== "string") continue;
      const efforts = Array.isArray(entry.supportedReasoningEfforts)
        ? entry.supportedReasoningEfforts
            .map((option) => option?.reasoningEffort)
            .filter((effort) => typeof effort === "string")
        : [];
      this.modelCatalog.set(model, new Set(efforts));
    }
    this.catalogError = null;
    this.diagnostics.record("model-catalog-ready", { count: this.modelCatalog.size });
  }

  setModelCatalogUnavailable(reason) {
    this.modelCatalog = null;
    this.catalogError = reason;
    this.diagnostics.record("model-catalog-unavailable", { reason });
  }

  processClientMessage(message) {
    if (!isObject(message) || typeof message.method !== "string") {
      return { type: "forward", message, modified: false };
    }

    if (hasRequestId(message) && this.pending.has(requestKey(message.id))) {
      return {
        type: "local-error",
        message: this.#localError(message.id, "duplicate in-flight request id"),
      };
    }

    if (["thread/start", "thread/resume", "thread/fork"].includes(message.method)) {
      if (hasRequestId(message)) {
        this.pending.set(requestKey(message.id), {
          kind: "thread-lifecycle",
          method: message.method,
          params: cloneJson(message.params ?? {}),
        });
      }
      return { type: "forward", message, modified: false };
    }

    if (message.method !== "turn/start" || !hasRequestId(message) || !isObject(message.params)) {
      return { type: "forward", message, modified: false };
    }

    const threadId = message.params.threadId;
    const thread = typeof threadId === "string" ? this.threads[threadId] : null;
    const isNewTurn = Boolean(thread && !thread.activeTurnId && !thread.pendingTurnRequestId);
    let selection;
    if (!isNewTurn) {
      selection = {
        apply: false,
        model: null,
        effort: null,
        reasonCode: thread ? "active-turn-input" : "thread-state-unknown",
        advisory: null,
      };
    } else if (!this.compatible) {
      selection = {
        apply: false,
        model: null,
        effort: null,
        reasonCode: "unsupported-cli-version",
        advisory: null,
      };
    } else {
      selection = selectModel({ config: this.config, thread, requestParams: message.params });
    }

    if (selection.apply) {
      const availabilityError = this.#availabilityError(selection.model, selection.effort);
      if (availabilityError) {
        this.diagnostics.record("turn-rejected", {
          threadId,
          requestId: message.id,
          model: selection.model,
          effort: selection.effort,
          reasonCode: availabilityError.code,
        });
        return {
          type: "local-error",
          message: this.#localError(message.id, availabilityError.message),
        };
      }
    }

    const forwarded = selection.apply ? applySelection(message, selection) : message;
    if (isNewTurn) thread.pendingTurnRequestId = requestKey(message.id);
    const collaborationSettings = isObject(message.params.collaborationMode?.settings)
      ? message.params.collaborationMode.settings
      : {};
    const requestedUserModel =
      this.config.requestModelPolicy === "preserve"
        ? message.params.model ?? collaborationSettings.model ?? null
        : null;
    const requestedUserEffort =
      this.config.requestModelPolicy === "preserve"
        ? message.params.effort ?? collaborationSettings.reasoning_effort ?? null
        : null;
    this.pending.set(requestKey(message.id), {
      kind: "turn-start",
      threadId,
      isNewTurn,
      selection,
      userOverride:
        isNewTurn &&
        (typeof requestedUserModel === "string" || typeof requestedUserEffort === "string")
          ? {
              model: typeof requestedUserModel === "string" ? requestedUserModel : null,
              effort:
                typeof requestedUserEffort === "string"
                  ? requestedUserEffort
                  : typeof requestedUserModel === "string"
                    ? selection.effort
                    : null,
            }
          : null,
    });
    this.diagnostics.record("turn-decision", {
      threadId,
      requestId: message.id,
      model: selection.model,
      effort: selection.effort,
      reasonCode: selection.reasonCode,
      advisoryModel: selection.advisory?.model ?? null,
      advisoryReasonCode: selection.advisory?.reasonCode ?? null,
      applied: selection.apply,
      rulesVersion: this.config.rulesVersion,
    });
    return { type: "forward", message: forwarded, modified: forwarded !== message };
  }

  processServerMessage(message) {
    if (!isObject(message)) return;

    if (hasRequestId(message) && !message.method) {
      const key = requestKey(message.id);
      const pending = this.pending.get(key);
      if (pending) {
        this.pending.delete(key);
        if (pending.kind === "thread-lifecycle") {
          if (message.result?.thread) this.#captureThread(message.result.thread, pending.params);
        } else if (pending.kind === "turn-start") {
          this.#settleTurnRequest(pending, message);
        }
      }
      return;
    }

    if (message.method === "thread/started" && message.params?.thread) {
      this.#captureThread(message.params.thread);
      return;
    }
    if (message.method === "thread/status/changed") {
      const { threadId, status } = message.params ?? {};
      const thread = this.threads[threadId];
      if (!thread || !isObject(status)) return;
      if (status.type === "idle" || status.type === "notLoaded" || status.type === "systemError") {
        thread.activeTurnId = null;
        thread.pendingTurnRequestId = null;
      } else if (status.type === "active" && !thread.activeTurnId) {
        thread.activeTurnId = "unknown-active-turn";
      }
      this.#save();
      return;
    }
    if (message.method === "turn/started") {
      const { threadId, turn } = message.params ?? {};
      const thread = this.threads[threadId];
      if (thread && typeof turn?.id === "string") {
        thread.activeTurnId = turn.id;
        this.#save();
      }
      return;
    }
    if (message.method === "turn/completed") {
      const { threadId, turn } = message.params ?? {};
      const thread = this.threads[threadId];
      if (thread && (!turn?.id || thread.activeTurnId === turn.id || thread.activeTurnId === "unknown-active-turn")) {
        thread.activeTurnId = null;
        thread.pendingTurnRequestId = null;
        this.#save();
      }
    }
  }

  #availabilityError(model, effort) {
    if (!this.modelCatalog) {
      return {
        code: "model-catalog-unavailable",
        message: `model router cannot verify model availability${this.catalogError ? `: ${this.catalogError}` : ""}`,
      };
    }
    const efforts = this.modelCatalog.get(model);
    if (!efforts) {
      return { code: "model-unavailable", message: `model router: ${model} is not available` };
    }
    if (effort && !efforts.has(effort)) {
      return {
        code: "effort-unavailable",
        message: `model router: ${model} does not advertise reasoning effort ${effort}`,
      };
    }
    return null;
  }

  #localError(id, message) {
    return { id, error: { code: -32091, message } };
  }

  #captureThread(thread, requestParams = {}) {
    if (!isObject(thread) || typeof thread.id !== "string") return;
    const previous = this.threads[thread.id] ?? {};
    const statusType = thread.status?.type;
    this.threads[thread.id] = {
      id: thread.id,
      cwd: thread.cwd ?? requestParams.cwd ?? previous.cwd ?? null,
      isMain:
        thread.parentThreadId === null
          ? true
          : typeof thread.parentThreadId === "string"
            ? false
            : previous.isMain ?? false,
      activeTurnId:
        statusType === "active" ? previous.activeTurnId ?? "unknown-active-turn" : null,
      pendingTurnRequestId: previous.pendingTurnRequestId ?? null,
      selectedModel: thread.model ?? previous.selectedModel ?? null,
      selectedEffort: thread.reasoningEffort ?? previous.selectedEffort ?? null,
      reasonCode: previous.reasonCode ?? null,
      unresolvedReasons: previous.unresolvedReasons ?? [],
      userModel: previous.userModel ?? null,
      userEffort: previous.userEffort ?? null,
      rulesVersion: this.config.rulesVersion,
    };
    this.#save();
  }

  #settleTurnRequest(pending, response) {
    const thread = this.threads[pending.threadId];
    if (!thread) return;
    if (pending.isNewTurn) thread.pendingTurnRequestId = null;
    if (response.error) {
      this.diagnostics.record("turn-not-accepted", {
        threadId: pending.threadId,
        reasonCode: pending.selection.reasonCode,
      });
      this.#save();
      return;
    }

    const turn = response.result?.turn;
    if (typeof turn?.id === "string" && !["completed", "failed", "interrupted"].includes(turn.status)) {
      thread.activeTurnId = turn.id;
    }
    if (pending.userOverride) {
      if (pending.userOverride.model) {
        thread.userModel = pending.userOverride.model;
        thread.selectedModel = pending.userOverride.model;
      }
      if (pending.userOverride.effort) {
        thread.userEffort = pending.userOverride.effort;
        thread.selectedEffort = pending.userOverride.effort;
      }
    }
    if (pending.selection.apply) {
      thread.selectedModel = pending.selection.model;
      thread.selectedEffort = pending.selection.effort;
      thread.reasonCode = pending.selection.reasonCode;
      thread.unresolvedReasons = pending.selection.unresolvedReasons ?? thread.unresolvedReasons ?? [];
      thread.rulesVersion = this.config.rulesVersion;
      this.diagnostics.record("turn-selection-accepted", {
        threadId: pending.threadId,
        turnId: turn?.id ?? null,
        model: pending.selection.model,
        effort: pending.selection.effort,
        reasonCode: pending.selection.reasonCode,
      });
    }
    this.#save();
  }

  #save() {
    this.stateStore.saveThreads(this.threads);
  }
}

// JSON構造を壊さない独立行のコメントだけを除いて設定を解析する。
function parseConfigFile(contents) {
  const json = contents
    .split(/\r?\n/u)
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  return JSON.parse(json);
}

// 設定ファイルを読み取り、外部入力のまま判定処理へ渡さない。
function loadConfig(configPath = process.env.CODEX_MODEL_ROUTER_CONFIG ?? DEFAULT_CONFIG_PATH) {
  return validateConfig(parseConfigFile(readFileSync(configPath, "utf8")));
}

// Desktop同梱Codexを優先し、プロキシ自身への再帰を拒否する。
function resolveInnerCodex(config) {
  const resourcesPath = process.env.CODEX_ELECTRON_RESOURCES_PATH;
  const candidate =
    process.env.CODEX_MODEL_ROUTER_INNER_CODEX ??
    (resourcesPath ? path.join(resourcesPath, "codex") : null) ??
    config.innerCodexPath;
  const resolved = path.resolve(candidate);
  const self = path.resolve(fileURLToPath(import.meta.url));
  if (resolved === self) throw new Error("inner Codex path resolves to the router itself");
  accessSync(resolved, fsConstants.X_OK);
  return resolved;
}

// 対象実行ファイルが報告するCodex CLIバージョンだけを取得する。
export function readCliVersion(innerCodexPath) {
  const result = spawnSync(innerCodexPath, ["--version"], {
    encoding: "utf8",
    env: { ...process.env, CODEX_CLI_PATH: "" },
  });
  if (result.error || result.status !== 0) return null;
  const match = `${result.stdout}\n${result.stderr}`.match(/codex-cli\s+(\S+)/);
  return match?.[1] ?? null;
}

// 書き込み先が詰まった間だけ読み取り元を停止して通信量を制御する。
function writeRespectingBackpressure(writable, data, readable) {
  if (!writable.write(data)) {
    readable?.pause();
    writable.once("drain", () => readable?.resume());
  }
}

// 一行のプロトコルJSONを検証し、方向を含む接続エラーへ変換する。
function parseProtocolLine(line, direction) {
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`${direction} emitted invalid newline-delimited JSON`);
  }
}

// Desktopがモデル中継を必要とするApp Server起動かを判定する。
function isAppServerInvocation(args) {
  return args.includes("app-server");
}

// App Server以外の呼び出しを同梱Codexへそのまま委譲する。
function runPassthrough(innerCodexPath, args) {
  const child = spawn(innerCodexPath, args, {
    env: { ...process.env, CODEX_CLI_PATH: "" },
    stdio: "inherit",
  });
  child.on("error", (error) => {
    process.stderr.write(`codex-model-router: ${error.message}\n`);
    process.exitCode = 70;
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 70;
  });
}

// 対応版App Serverとの双方向通信を保ち、新規ターンだけを判定する。
export function runAppServerProxy({ config, innerCodexPath, args, stateDirectory }) {
  const diagnostics = new Diagnostics(stateDirectory);
  const stateStore = new StateStore(stateDirectory, config.rulesVersion);
  const cliVersion = readCliVersion(innerCodexPath);
  const compatible = Boolean(cliVersion && config.supportedCliVersions.includes(cliVersion));
  diagnostics.record("proxy-start", {
    cliVersion,
    compatible,
    mode: config.mode,
    rulesVersion: config.rulesVersion,
  });

  const engine = new RouterEngine({ config, diagnostics, stateStore, compatible });
  if (!compatible) engine.setModelCatalogUnavailable("unsupported CLI version");

  const child = spawn(innerCodexPath, args, {
    env: { ...process.env, CODEX_CLI_PATH: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const activeClientRequestIds = new Set();
  const gate = {
    internalId: null,
    timeout: null,
    queue: [],
    queuedBytes: 0,
    catalogEntries: [],
    finished: !compatible,
  };
  let failed = false;
  let childExited = false;
  let forcedExitTimer = null;
  let terminatingSignal = null;

  const scheduleForcedExit = (exitCode) => {
    if (forcedExitTimer) return;
    process.stdin.pause();
    forcedExitTimer = setTimeout(() => process.exit(exitCode), 2000);
  };

  const failProtocol = (error) => {
    if (failed) return;
    failed = true;
    diagnostics.record("proxy-failure", { reason: error.message });
    process.stderr.write(`codex-model-router: ${error.message}\n`);
    process.exitCode = 70;
    child.kill("SIGTERM");
    child.stdin.destroy();
    scheduleForcedExit(70);
  };

  const forwardClientMessage = (line, message) => {
    const action = engine.processClientMessage(message);
    if (action.type === "local-error") {
      writeRespectingBackpressure(process.stdout, `${JSON.stringify(action.message)}\n`, child.stdout);
      return;
    }
    if (isRequest(action.message)) activeClientRequestIds.add(requestKey(action.message.id));
    const output = action.modified ? JSON.stringify(action.message) : line;
    writeRespectingBackpressure(child.stdin, `${output}\n`, process.stdin);
  };

  const flushGate = () => {
    if (gate.timeout) clearTimeout(gate.timeout);
    gate.timeout = null;
    gate.finished = true;
    gate.internalId = null;
    const queued = gate.queue;
    gate.queue = [];
    gate.queuedBytes = 0;
    for (const { line, message } of queued) forwardClientMessage(line, message);
  };

  const requestCatalogPage = (cursor = null) => {
    const request = {
      method: "model/list",
      id: gate.internalId,
      params: { cursor, limit: 100, includeHidden: true },
    };
    writeRespectingBackpressure(child.stdin, `${JSON.stringify(request)}\n`, process.stdin);
  };

  const beginCatalogGate = () => {
    if (gate.finished || gate.internalId !== null) return;
    let id;
    do id = `codex-model-router:${randomUUID()}`;
    while (activeClientRequestIds.has(requestKey(id)));
    gate.internalId = id;
    requestCatalogPage();
    gate.timeout = setTimeout(() => {
      engine.setModelCatalogUnavailable("model/list timed out");
      flushGate();
    }, 5000);
    gate.timeout.unref();
  };

  const queueBehindGate = (line, message) => {
    gate.queuedBytes += Buffer.byteLength(line, "utf8") + 1;
    if (gate.queuedBytes > config.maxBufferedBytes) {
      throw new Error(`catalog gate exceeds ${config.maxBufferedBytes} buffered bytes`);
    }
    gate.queue.push({ line, message });
  };

  const clientDecoder = new JsonLineDecoder({
    maxBufferedBytes: config.maxBufferedBytes,
    onLine(line) {
      try {
        const message = parseProtocolLine(line, "Desktop");
        if (gate.internalId !== null) {
          queueBehindGate(line, message);
          return;
        }
        forwardClientMessage(line, message);
        if (message.method === "initialized") beginCatalogGate();
      } catch (error) {
        failProtocol(error);
      }
    },
  });

  const serverDecoder = new JsonLineDecoder({
    maxBufferedBytes: config.maxBufferedBytes,
    onLine(line) {
      try {
        const message = parseProtocolLine(line, "Codex app-server");
        if (gate.internalId !== null && sameRequestId(message.id, gate.internalId) && !message.method) {
          if (message.error) {
            engine.setModelCatalogUnavailable(message.error.message ?? "model/list failed");
            flushGate();
            return;
          }
          const data = message.result?.data;
          if (!Array.isArray(data)) {
            engine.setModelCatalogUnavailable("model/list returned an invalid result");
            flushGate();
            return;
          }
          gate.catalogEntries.push(...data);
          if (typeof message.result.nextCursor === "string") {
            requestCatalogPage(message.result.nextCursor);
          } else {
            engine.setModelCatalog(gate.catalogEntries);
            flushGate();
          }
          return;
        }

        if (hasRequestId(message) && !message.method) {
          activeClientRequestIds.delete(requestKey(message.id));
        }
        engine.processServerMessage(message);
        writeRespectingBackpressure(process.stdout, `${line}\n`, child.stdout);
      } catch (error) {
        failProtocol(error);
      }
    },
  });

  process.stdin.on("data", (chunk) => {
    if (childExited || failed) return;
    try {
      clientDecoder.push(chunk);
    } catch (error) {
      failProtocol(error);
    }
  });
  process.stdin.on("end", () => {
    try {
      clientDecoder.end();
      if (!failed) child.stdin.end();
    } catch (error) {
      failProtocol(error);
    }
  });
  child.stdout.on("data", (chunk) => {
    try {
      serverDecoder.push(chunk);
    } catch (error) {
      failProtocol(error);
    }
  });
  child.stdout.on("end", () => {
    try {
      serverDecoder.end();
    } catch (error) {
      failProtocol(error);
    }
  });
  child.stderr.on("data", (chunk) => writeRespectingBackpressure(process.stderr, chunk, child.stderr));
  child.on("error", failProtocol);
  child.on("exit", (code, signal) => {
    childExited = true;
    process.stdin.pause();
    if (forcedExitTimer) clearTimeout(forcedExitTimer);
    forcedExitTimer = null;
    diagnostics.record("proxy-exit", { code, signal });
    if (terminatingSignal) {
      const signalExitCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
      process.exitCode = signalExitCodes[terminatingSignal] ?? 128;
    } else if (signal) process.exitCode = 128;
    else if (!failed) process.exitCode = code ?? 70;
  });

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => {
      terminatingSignal = signal;
      diagnostics.record("proxy-signal", { signal });
      child.kill(signal);
      const signalExitCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
      scheduleForcedExit(signalExitCodes[signal] ?? 128);
    });
  }
}

// 起動前診断に必要な互換性情報だけを標準出力へ返す。
function printCheck(config, innerCodexPath) {
  const cliVersion = readCliVersion(innerCodexPath);
  const result = {
    ok: Boolean(cliVersion && config.supportedCliVersions.includes(cliVersion)),
    cliVersion,
    supportedCliVersions: config.supportedCliVersions,
    innerCodexPath,
    mode: config.mode,
    enabledRepositories: config.enabledRepositories,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 2;
}

// 実行種別を検証して診断、透過委譲、App Server中継へ振り分ける。
export function main(args = process.argv.slice(2)) {
  const config = loadConfig();
  const innerCodexPath = resolveInnerCodex(config);
  if (args.length === 1 && args[0] === "--router-check") {
    printCheck(config, innerCodexPath);
    return;
  }
  if (!isAppServerInvocation(args)) {
    runPassthrough(innerCodexPath, args);
    return;
  }
  const stateDirectory =
    process.env.CODEX_MODEL_ROUTER_STATE_DIR ?? config.stateDirectory ?? DEFAULT_STATE_DIR;
  runAppServerProxy({ config, innerCodexPath, args, stateDirectory });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`codex-model-router: ${error.message}\n`);
    process.exitCode = 70;
  }
}
