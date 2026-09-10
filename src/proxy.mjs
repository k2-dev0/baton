#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  accessSync,
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  constants as fsConstants,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { applySelection, isRepositoryEnabled, validateConfig } from "./policy.mjs";
import { createUnixWebSocketLineServer } from "./websocket.mjs";
import { checkCliCompatibility } from "./compatibility.mjs";

const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.dirname(SOURCE_DIR);
const DEFAULT_CONFIG_PATH = path.join(PROJECT_DIR, "config.json");
const SWITCH_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_STATE_DIR = path.join(
  homedir(),
  "Library",
  "Application Support",
  "codex-baton",
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

// 中断元の追跡に必要な識別子だけを記録し、入力・ツール結果・認証情報は残さない。
export function recordControlMessage(diagnostics, source, message) {
  if (!["turn/interrupt", "turn/start", "turn/steer", "thread/unsubscribe", "thread/archive", "thread/rollback", "thread/revert", "thread/settings/update", "turn/settings/update"].includes(message.method)) return;
  diagnostics.record("control-request", {
    source, method: message.method, requestId: message.id ?? null,
    threadId: message.params?.threadId ?? null, turnId: message.params?.turnId ?? null,
  });
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
    const bufferedBytes = Buffer.byteLength(this.buffer, "utf8");
    if (bufferedBytes > this.maxBufferedBytes) {
      throw new Error(
        `protocol line exceeds ${this.maxBufferedBytes} bytes (received at least ${bufferedBytes})`,
      );
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
      `${JSON.stringify({ timestamp: this.now().toISOString(), pid: process.pid, event, ...fields })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
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
  constructor({ config, diagnostics, stateStore, switchRequest, compatible = true }) {
    this.config = config;
    this.switchRequest = switchRequest;
    this.diagnostics = diagnostics;
    this.stateStore = stateStore;
    this.compatible = compatible;
    this.threads = stateStore.getThreads();
    this.pending = new Map();
    this.modelCatalog = null;
    this.catalogError = null;
    this.switches = new Map();
    this.internalInterruptions = new Set();
    this.serverRequests = new Map();
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
    if (!isObject(message)) return { type: "forward", message, modified: false };
    if (hasRequestId(message) && !message.method) this.serverRequests.delete(requestKey(message.id));
    if (typeof message.method !== "string") return { type: "forward", message, modified: false };
    if (hasRequestId(message) && (this.pending.has(requestKey(message.id)) ||
        (typeof message.id === "string" && message.id.startsWith("baton:switch:")))) {
      return { type: "local-error", message: this.#localError(message.id, "duplicate or reserved in-flight request id") };
    }
    if (message.method === "initialize" && this.compatible) {
      const changed = cloneJson(message);
      changed.params ??= {};
      changed.params.capabilities = { ...changed.params.capabilities, experimentalApi: true };
      return { type: "forward", message: changed, modified: true };
    }
    const threadId = message.params?.threadId;
    const switching = this.switches.get(threadId);
    if (["thread/settings/update", "turn/settings/update"].includes(message.method) && hasRequestId(message)) {
      if (switching) switching.cancelled = true;
      this.pending.set(requestKey(message.id), { kind: "settings", threadId, method: message.method, params: cloneJson(message.params) });
      return { type: "forward", message, modified: false };
    }
    if (switching && ["turn/interrupt", "turn/start", "turn/steer", "thread/archive", "thread/unsubscribe", "thread/rollback", "thread/revert"].includes(message.method)) {
      switching.cancelled = true;
      if (["turn/start", "turn/steer"].includes(message.method)) {
        return { type: "local-error", message: this.#localError(message.id, "Model switch cancelled. Wait for the current turn to stop, then resend this input; it was not submitted.") };
      }
    }
    if (["thread/start", "thread/resume", "thread/fork"].includes(message.method)) {
      let forwarded = message;
      if (message.method === "thread/start" && this.compatible &&
          isRepositoryEnabled(message.params?.cwd ?? process.cwd(), this.config.enabledRepositories)) {
        const existing = message.params?.dynamicTools ?? [];
        if (!Array.isArray(existing) || existing.some((tool) => tool.name === "switch_model")) {
          return { type: "local-error", message: this.#localError(message.id, "switch_model conflicts with an existing tool") };
        }
        forwarded = cloneJson(message);
        forwarded.params ??= {};
        forwarded.params.dynamicTools = [...existing, {
          type: "function", name: "switch_model",
          description: "Switch this main task's model or settings and automatically continue its unfinished work. Always provide config.effort explicitly. Only the supplied config fields are applied; omitted settings follow Codex defaults and inheritance. The model and effort must be available in Codex. The same model is allowed when changing settings. Call alone, after awaiting other tools and approvals. This ends the current execution segment, not the task. No reason is required.",
          inputSchema: this.switchRequest.inputSchema,
        }];
      }
      if (hasRequestId(message)) this.pending.set(requestKey(message.id), {
        kind: "thread-lifecycle", method: message.method, params: cloneJson(forwarded.params ?? {}),
      });
      return { type: "forward", message: forwarded, modified: forwarded !== message };
    }
    if (message.method !== "turn/start" || !hasRequestId(message) || !isObject(message.params)) {
      return { type: "forward", message, modified: false };
    }
    const thread = this.threads[threadId];
    const isNewTurn = Boolean(thread && !thread.activeTurnId && !thread.pendingTurnRequestId);
    if (isNewTurn) thread.pendingTurnRequestId = requestKey(message.id);
    this.pending.set(requestKey(message.id), {
      kind: "turn-start", threadId, isNewTurn, params: cloneJson(message.params),
    });
    return { type: "forward", message, modified: false };
  }

  processServerMessage(message) {
    if (!isObject(message)) return;
    if (message.method === "item/tool/call" && message.params?.tool === "switch_model" && message.params?.namespace == null) {
      return this.switch_model(message);
    }
    if (isRequest(message)) this.serverRequests.set(requestKey(message.id), message.params?.threadId);
    if (hasRequestId(message) && !message.method) {
      const key = requestKey(message.id);
      const pending = this.pending.get(key);
      if (pending?.kind === "switch") return this.switch_model(message);
      if (typeof message.id === "string" && message.id.startsWith("baton:switch:")) {
        return { consume: true, upstream: [], downstream: [] };
      }
      if (pending) {
        this.pending.delete(key);
        if (pending.kind === "settings" && message.result?.status === "applied" && pending.method === "turn/settings/update") {
          const thread = this.threads[pending.threadId];
          if (thread?.activeTurnId === pending.params.turnId) thread.liveSettings = { ...thread.liveSettings, ...pending.params };
        }
        if (pending.kind === "thread-lifecycle" && message.result?.thread) {
          this.#captureThread({ ...message.result.thread,
            model: message.result.model ?? message.result.thread.model,
            reasoningEffort: message.result.reasoningEffort ?? message.result.thread.reasoningEffort,
          }, pending.params);
        } else if (pending.kind === "turn-start") this.#settleTurnRequest(pending, message);
      }
      return;
    }
    const { threadId, turn, item } = message.params ?? {};
    if (message.method === "turn/completed" && turn?.status === "interrupted" &&
        this.internalInterruptions.has(JSON.stringify([threadId, turn.id]))) {
      return { consume: true, upstream: [], downstream: [] };
    }
    const thread = this.threads[threadId];
    if (message.method === "thread/started" && message.params?.thread) {
      this.#captureThread(message.params.thread);
    } else if (message.method === "thread/settings/updated" && thread) {
      const settings = message.params.threadSettings;
      thread.selectedModel = settings.model;
      thread.selectedEffort = settings.effort;
      if (thread.turnParams && settings.collaborationMode) thread.turnParams.collaborationMode = cloneJson(settings.collaborationMode);
    } else if (message.method === "turn/started" && thread && typeof turn?.id === "string") {
      thread.activeTurnId = turn.id;
    } else if (message.method === "item/started" && thread && item) {
      if (["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "collabToolCall", "webSearch"].includes(item.type)) {
        thread.activeItems[item.id] = item;
      }
    } else if (message.method === "item/completed" && thread && item) {
      delete thread.activeItems[item.id];
    } else if (message.method === "serverRequest/resolved") {
      this.serverRequests.delete(requestKey(message.params.requestId));
    } else if (message.method === "turn/completed" && thread && turn?.id === thread.activeTurnId) {
      thread.activeTurnId = null;
      thread.pendingTurnRequestId = null;
      thread.activeItems = {};
    }
    this.#save();
    const switching = this.switches.get(threadId);
    if (message.method === "item/completed" && switching?.phase === "settle" &&
        message.params.turnId === switching.turnId && item?.id === switching.call.params.callId &&
        item.type === "dynamicToolCall") return this.switch_model(message);
    if (message.method === "turn/completed" && this.switches.has(threadId)) return this.switch_model(message);
  }

  // 切り替えツールの待機を区切りにし、Codexの正規手順で同じタスクを続行する。
  switch_model(message) {
    const action = { consume: !["turn/completed", "item/completed"].includes(message.method), upstream: [], downstream: [] };
    const pending = !message.method ? this.pending.get(requestKey(message.id)) : null;
    const threadId = pending?.threadId ?? message.params?.threadId;
    const thread = this.threads[threadId];
    let state = this.switches.get(threadId);
    if (message.method === "item/tool/call") {
      const args = message.params.arguments;
      let error = this.switchRequest.validateRequest(args);
      let reasonCode = error ? "invalid-request" : null;
      if (!this.compatible || thread?.isMain !== true ||
          !isRepositoryEnabled(thread?.cwd, this.config.enabledRepositories)) {
        error = "This is not an enabled main task.";
        reasonCode = "task-unavailable";
      }
      if (!thread?.turnParams || thread.activeTurnId !== message.params.turnId) {
        error = "The calling turn is no longer active.";
        reasonCode = "turn-inactive";
      }
      if (state) {
        error = "A model switch is already in progress.";
        reasonCode = "switch-in-progress";
      }
      if ([...this.pending.values()].some((request) => request.kind === "settings" && request.threadId === threadId)) {
        error = "Await the user's settings change before switching the model.";
        reasonCode = "settings-pending";
      }
      const otherItems = Object.values(thread?.activeItems ?? {}).filter((item) => item.id !== message.params.callId);
      if (otherItems.length || [...this.serverRequests.values()].includes(threadId)) {
        error = "Await other tools and approvals before switching the model.";
        reasonCode = "other-work";
      }
      const effort = args?.config?.effort;
      if (!error) {
        const availabilityError = this.#availabilityError(args.model, effort);
        error = availabilityError?.message ?? null;
        reasonCode = availabilityError?.code ?? null;
      }
      if (error) {
        this.diagnostics.record("switch-rejected", { threadId, phase: "request", reasonCode });
        action.upstream.push({ id: message.id, result: {
          success: false, contentItems: [{ type: "inputText", text: error }],
        } });
        return action;
      }
      state = { call: cloneJson(message), threadId, turnId: message.params.turnId,
        model: args.model, effort, settings: cloneJson(args.config),
        phase: "settle", interrupted: false, interruptAccepted: false, cancelled: false, callResolved: true };
      this.switches.set(threadId, state);
    } else if (!state) {
      if (pending) this.pending.delete(requestKey(message.id));
      return action;
    } else if (message.method === "item/completed") {
      this.pending.delete(requestKey(state.requestId));
      const item = message.params.item;
      if (state.cancelled || item.status !== "completed" || item.success !== true ||
          Object.keys(thread.activeItems).length || [...this.serverRequests.values()].includes(threadId) ||
          thread.activeTurnId !== state.turnId) {
        this.switches.delete(threadId);
        this.diagnostics.record("switch-failed", { threadId, phase: "settle", error: "Switch tool did not settle alone in the active turn." });
        action.downstream.push({ method: "error", params: { threadId, turnId: state.turnId, willRetry: false,
          error: { message: "Model switch cancelled before interruption: the tool failed, the turn stopped, or other work started.", codexErrorInfo: null, additionalDetails: null } } });
        return action;
      }
      state.phase = "interrupt";
    } else if (message.method === "turn/completed") {
      if (message.params.turn?.id === state.turnId && state.phase === "settle") {
        this.pending.delete(requestKey(state.requestId));
        this.switches.delete(threadId);
        this.diagnostics.record("switch-failed", { threadId, phase: "settle", error: "Turn ended before switch tool settled." });
        if (!state.cancelled) action.downstream.push({ method: "error", params: { threadId, turnId: state.turnId, willRetry: false,
          error: { message: "Model switch cancelled: the calling turn ended before handoff.", codexErrorInfo: null, additionalDetails: null } } });
        return action;
      }
      if (message.params.turn?.id !== state.turnId || state.phase !== "interrupt") return action;
      state.interrupted = message.params.turn.status === "interrupted";
      if (!state.interrupted || state.cancelled) {
        this.switches.delete(threadId);
        return action;
      }
      // 内部の中断を利用者の停止として表示しない。続行不能時だけ元の通知を戻す。
      state.interruptionNotification = cloneJson(message);
      this.internalInterruptions.add(JSON.stringify([threadId, state.turnId]));
      action.consume = true;
      if (!state.interruptAccepted) return action;
      state.phase = "settings";
    } else {
      if (message.error || state.phase !== "interrupt" || state.interrupted) this.pending.delete(requestKey(message.id));
      if (message.error) {
        this.switches.delete(threadId);
        this.diagnostics.record("switch-failed", { threadId, phase: state.phase, error: message.error.message });
        if (state.phase === "continue" && message.error.message === "baton: turn/start timed out") {
          state.cancelled = true;
          this.switches.set(threadId, state);
          this.pending.set(requestKey(message.id), pending);
        }
        if (!state.callResolved) {
          action.upstream.push({ id: state.call.id, result: { success: false,
            contentItems: [{ type: "inputText", text: message.error.message }] } });
        } else {
          action.downstream.push({ method: "error", params: { threadId, turnId: state.turnId, willRetry: false,
            error: { message: "Model switch did not continue: " + message.error.message, codexErrorInfo: null, additionalDetails: null } } });
        }
        this.#releaseInterruption(state, action);
        return action;
      }
      if (state.cancelled) {
        this.#releaseInterruption(state, action);
        if (state.phase === "continue" && message.result?.turn?.status === "inProgress") {
          state.phase = "cancel";
          const id = "baton:switch:" + randomUUID();
          this.pending.set(requestKey(id), { kind: "switch", threadId });
          action.upstream.push({ id, method: "turn/interrupt", params: { threadId, turnId: message.result.turn.id } });
          return action;
        }
        this.switches.delete(threadId);
        return action;
      }
      if (state.phase === "interrupt") {
        state.interruptAccepted = true;
        if (!state.interrupted) return action;
        state.phase = "settings";
      } else if (state.phase === "settings") {
        state.phase = "continue";
      } else {
        this.switches.delete(threadId);
        const turn = message.result?.turn;
        if (!turn?.id || turn.status !== "inProgress") {
          action.downstream.push({ method: "error", params: { threadId, turnId: state.turnId, willRetry: false,
            error: { message: "Model switch did not start an active turn.", codexErrorInfo: null, additionalDetails: null } } });
          this.#releaseInterruption(state, action);
          return action;
        }
        thread.activeTurnId = turn.id;
        thread.selectedModel = state.model;
        thread.selectedEffort = state.effort;
        thread.turnParams = cloneJson(pending.params);
        this.diagnostics.record("switch-accepted", { threadId, turnId: turn.id, model: state.model, effort: state.effort });
        this.#save();
        return action;
      }
    }
    const id = "baton:switch:" + randomUUID();
    if (state.requestId) this.pending.delete(requestKey(state.requestId));
    state.requestId = id;
    let method = "turn/interrupt";
    let params = { threadId, turnId: state.turnId };
    if (state.phase === "settings") {
      method = "thread/settings/update";
      // この操作はモデルと思考量の同期用。追加設定一式は続行時のturn/startへ渡す。
      params = { threadId, model: state.model, effort: state.effort };
      if (thread.turnParams.collaborationMode) {
        params.collaborationMode = applySelection({ params: thread.turnParams }, state).params.collaborationMode;
      }
    } else if (state.phase === "continue") {
      method = "turn/start";
      params = cloneJson(thread.turnParams);
      // Sticky設定はCodexの最新値を継承し、古い権限・環境を再適用しない。
      for (const key of ["cwd", "runtimeWorkspaceRoots", "approvalPolicy", "approvalsReviewer", "sandboxPolicy", "permissions", "environments", "serviceTier", "summary", "personality", "multiAgentMode"]) delete params[key];
      for (const key of ["approvalsReviewer", "summary", "serviceTier"]) {
        if (Object.hasOwn(thread.liveSettings ?? {}, key)) params[key] = thread.liveSettings[key];
      }
      params = applySelection({ params }, state).params;
      delete params.clientUserMessageId;
      params.input = [];
      params.turnTrigger = "baton";
      params.toolOutput = { name: "switch_model", output: JSON.stringify({
        model: state.model, config: state.settings, status: "applied",
        message: "Continue the original task from this successful switch; do not repeat completed work. The preceding interruption was performed by baton, not the user.",
      }) };
    }
    this.pending.set(requestKey(id), { kind: "switch", threadId, params: cloneJson(params) });
    if (state.phase === "settle") {
      action.upstream.push({ id: state.call.id, result: { success: true, contentItems: [{ type: "inputText", text: JSON.stringify({
        status: "pending", model: state.model, config: state.settings,
        message: "Baton accepted the handoff request; settings are not applied yet. Do not start further work. Baton will interrupt and continue this task with the requested settings.",
      }) }] } });
      action.waitFor = [{ id, method: "item/completed", params: { threadId, turnId: state.turnId } }];
      return action;
    }
    action.upstream.push({ id, method, params });
    return action;
  }

  // 続行失敗・利用者の取消では終了状態をCLIにも伝え、実行中表示を残さない。
  #releaseInterruption(state, action) {
    if (!state.interruptionNotification) return;
    action.downstream.push(state.interruptionNotification);
    state.interruptionNotification = null;
    this.internalInterruptions.delete(JSON.stringify([state.threadId, state.turnId]));
  }

  #availabilityError(model, effort) {
    if (!this.modelCatalog) {
      return {
        code: "model-catalog-unavailable",
        message: `baton cannot verify model availability${this.catalogError ? `: ${this.catalogError}` : ""}`,
      };
    }
    const efforts = this.modelCatalog.get(model);
    if (!efforts) {
      return { code: "model-unavailable", message: `baton: ${model} is not available` };
    }
    if (effort && !efforts.has(effort)) {
      return {
        code: "effort-unavailable",
        message: `baton: ${model} does not advertise reasoning effort ${effort}`,
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
      activeItems: previous.activeItems ?? {},
      turnParams: previous.turnParams ?? null,
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
        reasonCode: "preserve",
      });
      this.#save();
      return;
    }

    const turn = response.result?.turn;
    if (typeof turn?.id === "string" && !["completed", "failed", "interrupted"].includes(turn.status)) {
      thread.activeTurnId = turn.id;
    }
    if (pending.isNewTurn && turn?.id) {
      thread.liveSettings = {};
      thread.turnParams = pending.params;
      const settings = pending.params.collaborationMode?.settings;
      thread.selectedModel = settings?.model ?? pending.params.model ?? thread.selectedModel;
      thread.selectedEffort = settings?.reasoning_effort ?? pending.params.effort ?? thread.selectedEffort;
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
function loadConfig(configPath = process.env.CODEX_BATON_CONFIG ?? DEFAULT_CONFIG_PATH) {
  return validateConfig(parseConfigFile(readFileSync(configPath, "utf8")));
}

// Desktop同梱Codexを優先し、プロキシ自身への再帰を拒否する。
function resolveInnerCodex(config) {
  const resourcesPath = process.env.CODEX_ELECTRON_RESOURCES_PATH;
  const candidate =
    process.env.CODEX_BATON_INNER_CODEX ??
    (resourcesPath ? path.join(resourcesPath, "codex") : null) ??
    config.innerCodexPath;
  const resolved = path.resolve(candidate);
  const self = path.resolve(fileURLToPath(import.meta.url));
  if (resolved === self) throw new Error("inner Codex path resolves to the router itself");
  accessSync(resolved, fsConstants.X_OK);
  return resolved;
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
    process.stderr.write(`codex-baton: ${error.message}\n`);
    process.exitCode = 70;
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 70;
  });
}

// 必須通信仕様を持つApp Serverとの双方向通信を保ち、新規ターンだけを判定する。
export function runAppServerProxy({
  config,
  innerCodexPath,
  args,
  stateDirectory,
  clientReadable = process.stdin,
  clientWritable = process.stdout,
  clientName = "Desktop",
  serverStderr = "pipe",
  onExit = () => {},
}) {
  const diagnostics = new Diagnostics(stateDirectory);
  const stateStore = new MemoryStateStore();
  const { switchRequest, ...compatibility } = checkCliCompatibility(innerCodexPath);
  diagnostics.record("proxy-start", { ...compatibility, compatible: compatibility.ok });
  if (!compatibility.ok) throw new Error(`incompatible Codex: ${compatibility.reason}`);
  const engine = new RouterEngine({ config, diagnostics, stateStore, switchRequest });

  const child = spawn(innerCodexPath, args, {
    env: { ...process.env, CODEX_CLI_PATH: "" },
    stdio: ["pipe", "pipe", serverStderr],
  });

  const activeClientRequestIds = new Set();
  const switchTimers = new Map();
  const gate = {
    internalId: null,
    initializeRequestId: null,
    timeout: null,
    queue: [],
    queuedBytes: 0,
    catalogEntries: [],
    finished: false,
  };
  let failed = false;
  let childExited = false;
  let forcedExitTimer = null;
  let terminatingSignal = null;

  const scheduleForcedExit = (exitCode) => {
    if (forcedExitTimer) return;
    clientReadable.pause();
    forcedExitTimer = setTimeout(() => process.exit(exitCode), 2000);
  };

  const failProtocol = (error) => {
    if (failed) return;
    failed = true;
    diagnostics.record("proxy-failure", { reason: error.message });
    process.stderr.write(`codex-baton: ${error.message}\n`);
    process.exitCode = 70;
    child.kill("SIGTERM");
    child.stdin.destroy();
    scheduleForcedExit(70);
  };

  const forwardClientMessage = (line, message) => {
    recordControlMessage(diagnostics, "client", message);
    const action = engine.processClientMessage(message);
    if (action.type === "local-error") {
      diagnostics.record("control-rejected", { requestId: message.id, method: message.method });
      writeRespectingBackpressure(clientWritable, `${JSON.stringify(action.message)}\n`, child.stdout);
      return;
    }
    if (isRequest(action.message)) {
      activeClientRequestIds.add(requestKey(action.message.id));
      if (action.message.method === "initialize") gate.initializeRequestId = action.message.id;
    }
    const output = action.modified ? JSON.stringify(action.message) : line;
    writeRespectingBackpressure(child.stdin, `${output}\n`, clientReadable);
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
    writeRespectingBackpressure(child.stdin, `${JSON.stringify(request)}\n`, clientReadable);
  };

  const beginCatalogGate = () => {
    if (gate.finished || gate.internalId !== null) return;
    let id;
    do id = `codex-baton:${randomUUID()}`;
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
        const message = parseProtocolLine(line, clientName);
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

        const isInitializeResponse =
          gate.initializeRequestId !== null &&
          sameRequestId(message.id, gate.initializeRequestId) &&
          !message.method;
        if (isInitializeResponse) {
          gate.initializeRequestId = null;
          if (!message.error) beginCatalogGate();
        }

        if (hasRequestId(message) && !message.method) {
          activeClientRequestIds.delete(requestKey(message.id));
        }
        const action = engine.processServerMessage(message);
        if (["turn/started", "turn/completed"].includes(message.method)) {
          diagnostics.record("turn-state", { source: "server", method: message.method,
            threadId: message.params?.threadId, turnId: message.params?.turn?.id,
            status: message.params?.turn?.status });
        }
        for (const [id, timer] of switchTimers) {
          if (!engine.pending.has(requestKey(id))) {
            clearTimeout(timer);
            switchTimers.delete(id);
          }
        }
        for (const outgoing of action?.upstream ?? []) {
          recordControlMessage(diagnostics, "baton", outgoing);
          writeRespectingBackpressure(child.stdin, JSON.stringify(outgoing) + "\n", clientReadable);
        }
        const timedRequests = [...(action?.upstream ?? []).filter(outgoing => outgoing.method), ...(action?.waitFor ?? [])];
        for (const outgoing of timedRequests) {
          switchTimers.set(outgoing.id, setTimeout(() => {
            diagnostics.record("switch-request-timeout", { requestId: outgoing.id, method: outgoing.method,
              threadId: outgoing.params?.threadId, turnId: outgoing.params?.turnId });
            serverDecoder.onLine(JSON.stringify({ id: outgoing.id, error: {
              code: -32091, message: "baton: " + outgoing.method + " timed out",
            } }));
          }, SWITCH_REQUEST_TIMEOUT_MS));
        }
        for (const outgoing of action?.downstream ?? []) {
          writeRespectingBackpressure(clientWritable, JSON.stringify(outgoing) + "\n", child.stdout);
        }
        if (!action?.consume) writeRespectingBackpressure(clientWritable, `${line}\n`, child.stdout);
      } catch (error) {
        failProtocol(error);
      }
    },
  });

  clientReadable.on("data", (chunk) => {
    if (childExited || failed) return;
    try {
      clientDecoder.push(chunk);
    } catch (error) {
      failProtocol(error);
    }
  });
  clientReadable.on("end", () => {
    diagnostics.record("client-input-ended");
    try {
      clientDecoder.end();
      if (!failed) child.stdin.end();
    } catch (error) {
      failProtocol(error);
    }
  });
  clientReadable.on("error", failProtocol);
  clientWritable.on("error", failProtocol);
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
  child.stderr?.on("data", (chunk) => writeRespectingBackpressure(process.stderr, chunk, child.stderr));
  child.on("error", failProtocol);
  child.on("exit", (code, signal) => {
    childExited = true;
    for (const timer of switchTimers.values()) clearTimeout(timer);
    switchTimers.clear();
    clientReadable.pause();
    if (forcedExitTimer) clearTimeout(forcedExitTimer);
    forcedExitTimer = null;
    diagnostics.record("proxy-exit", { code, signal });
    if (terminatingSignal) {
      const signalExitCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
      process.exitCode = signalExitCodes[terminatingSignal] ?? 128;
    } else if (signal) process.exitCode = 128;
    else if (!failed) process.exitCode = code ?? 70;
    onExit({ code, signal });
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

// unix://以外を受け付けず、CLI用socketの対象を絶対パスに限定する。
function parseUnixListenUrl(listenUrl) {
  if (!listenUrl.startsWith("unix://")) {
    throw new Error("router listen URL must use unix://");
  }
  const socketPath = listenUrl.slice("unix://".length);
  if (!path.isAbsolute(socketPath)) {
    throw new Error("router unix socket path must be absolute");
  }
  return socketPath;
}

// CLI TUIのWebSocketを既存のstdio RouterEngineへ接続する。
export function runCliWebSocketProxy({ config, innerCodexPath, listenUrl, stateDirectory }) {
  const socketPath = parseUnixListenUrl(listenUrl);
  const diagnostics = new Diagnostics(stateDirectory);
  let server;
  server = createUnixWebSocketLineServer({
    socketPath,
    maxPayloadBytes: config.maxBufferedBytes,
    onEvent: (event, fields) => diagnostics.record(event, fields),
    onConnection(transport) {
      // TUIと同じ端末へサーバー内部ログを書かず、子プロセスから直接保存する。
      const serverStderr = openSync(path.join(stateDirectory, "app-server.stderr.log"), "a", 0o600);
      try {
        runAppServerProxy({
          config,
          innerCodexPath,
          args: ["app-server", "--listen", "stdio://"],
          stateDirectory,
          clientReadable: transport.readable,
          clientWritable: transport.writable,
          clientName: "Codex CLI",
          serverStderr,
          onExit() {
            transport.close();
            server.close();
          },
        });
      } finally {
        closeSync(serverStderr);
      }
    },
  });
  server.on("error", (error) => {
    process.stderr.write(`codex-baton: ${error.message}\n`);
    process.exitCode = 70;
  });
}

// 起動前診断に必要な互換性情報だけを標準出力へ返す。
function printCheck(config, innerCodexPath) {
  const { switchRequest, ...compatibility } = checkCliCompatibility(innerCodexPath);
  const result = {
    ...compatibility,
    innerCodexPath,
    enabledRepositories: config.enabledRepositories,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.stderr.write(`codex-baton: incompatible Codex: ${result.reason}\n`);
  process.exitCode = result.ok ? 0 : 2;
}

// 実行種別を検証して診断、透過委譲、App Server中継へ振り分ける。
export function main(args = process.argv.slice(2)) {
  const config = loadConfig();
  if (args[0] === "--router-cli-exit") {
    if (args.length !== 2 || !/^\d{1,3}$/.test(args[1]) || Number(args[1]) > 255) throw new Error("invalid CLI exit code");
    new Diagnostics(process.env.CODEX_BATON_STATE_DIR ?? config.stateDirectory ?? DEFAULT_STATE_DIR)
      .record("cli-exit", { code: Number(args[1]) });
    return;
  }
  const innerCodexPath = resolveInnerCodex(config);
  if (args.length === 1 && args[0] === "--router-check") {
    printCheck(config, innerCodexPath);
    return;
  }
  if (args[0] === "--router-listen") {
    if (args.length !== 2) throw new Error("--router-listen requires one unix:// URL");
    const stateDirectory =
      process.env.CODEX_BATON_STATE_DIR ?? config.stateDirectory ?? DEFAULT_STATE_DIR;
    runCliWebSocketProxy({ config, innerCodexPath, listenUrl: args[1], stateDirectory });
    return;
  }
  if (!isAppServerInvocation(args)) {
    runPassthrough(innerCodexPath, args);
    return;
  }
  const stateDirectory =
    process.env.CODEX_BATON_STATE_DIR ?? config.stateDirectory ?? DEFAULT_STATE_DIR;
  runAppServerProxy({ config, innerCodexPath, args, stateDirectory });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`codex-baton: ${error.message}\n`);
    process.exitCode = 70;
  }
}
