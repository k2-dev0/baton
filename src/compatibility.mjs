import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSwitchRequest } from "./switch-config.mjs";

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_MAX_BYTES = 1024 * 1024;
const SCHEMA_FILENAME = "codex_app_server_protocol.schemas.json";

// ローカル参照とnullableだけを展開する。未知の構造や循環参照は互換と推測しない。
function resolveSchema(root, schema) {
  const visited = new Set();
  while (schema && typeof schema === "object" && !Array.isArray(schema)) {
    if (visited.has(schema)) throw new Error("protocol schema contains a reference cycle");
    visited.add(schema);
    if (schema.$ref) {
      if (!schema.$ref.startsWith("#/")) throw new Error("protocol schema contains an unsupported reference");
      const keys = schema.$ref.slice(2).split("/").map((key) => key.replaceAll("~1", "/").replaceAll("~0", "~"));
      schema = root;
      for (const key of keys) schema = schema?.[key];
      continue;
    }
    const branches = schema.anyOf?.filter((branch) => branch.type !== "null") ?? schema.allOf;
    if (branches?.length === 1) { schema = branches[0]; continue; }
    return schema;
  }
  throw new Error("protocol schema is missing or malformed");
}

// 中継が実際に使う項目の存在を、配列要素・参照先まで追って検証する。
function requireFields(root, schema, fields, label) {
  for (const specification of fields) {
    const [field, expectedType] = specification.split(":");
    let current = schema;
    for (const key of field.split(".")) {
      current = resolveSchema(root, current);
      current = key === "*" ? current.items : current.properties?.[key];
      if (current !== true && (!current || typeof current !== "object")) throw new Error(`protocol missing ${label}.${field}`);
    }
    if (!expectedType || current === true) continue;
    const resolved = resolveSchema(root, current);
    const variants = (resolved.anyOf ?? resolved.oneOf ?? [resolved]).map((variant) => resolveSchema(root, variant));
    if (!variants.some((variant) => [variant.type].flat().includes(expectedType))) {
      throw new Error(`protocol changed ${label}.${field}: expected ${expectedType}`);
    }
  }
  return resolveSchema(root, schema);
}

// 中継が生成する要求に、送信できない新しい必須入力が増えていたら拒否する。
function requireKnownInputs(schema, supplied, label) {
  const unknown = schema.required?.filter((key) => !supplied.includes(key)) ?? [];
  if (unknown.length) throw new Error(`protocol requires unsupported ${label}.${unknown.join(", ")}`);
}

// 実行制御に必要な要求・通知・応答だけを検査し、全仕様の互換性までは保証しない。
function checkProtocol(root) {
  const requests = {
    initialize: ["clientInfo", "capabilities.experimentalApi:boolean"],
    "model/list": ["cursor:string", "limit:integer", "includeHidden:boolean"],
    "thread/start": ["cwd:string", "dynamicTools.*"],
    "thread/resume": ["threadId:string"],
    "thread/fork": ["threadId:string"],
    "thread/backgroundTerminals/list": ["threadId:string"],
    "turn/interrupt": ["threadId:string", "turnId:string"],
    "thread/settings/update": ["threadId:string", "model:string", "effort:string", "collaborationMode.settings.model:string", "collaborationMode.settings.reasoning_effort:string"],
    "turn/start": ["threadId:string", "input:array", "model:string", "effort:string", "collaborationMode.settings.model:string", "collaborationMode.settings.reasoning_effort:string", "toolOutput.name:string", "toolOutput.output:string", "turnTrigger:string"],
  };
  const notifications = {
    "thread/started": ["thread.id:string", "thread.cwd:string", "thread.parentThreadId:string"],
    "thread/settings/updated": ["threadId:string", "threadSettings.model:string", "threadSettings.effort:string", "threadSettings.collaborationMode"],
    "turn/started": ["threadId:string", "turn.id:string", "turn.status:string"],
    "turn/completed": ["threadId:string", "turn.id:string", "turn.status:string"],
    "item/started": ["threadId:string", "turnId:string", "item"],
    "item/completed": ["threadId:string", "turnId:string", "item"],
    "serverRequest/resolved": ["threadId:string", "requestId"],
  };
  const generatedInputs = {
    "model/list": ["cursor", "limit", "includeHidden"],
    "thread/backgroundTerminals/list": ["threadId"],
    "turn/interrupt": ["threadId", "turnId"],
    "thread/settings/update": ["threadId", "model", "effort"],
    "turn/start": ["threadId", "input", "model", "effort", "toolOutput", "turnTrigger"],
  };
  const paramsByMethod = new Map();
  for (const [kind, contracts] of Object.entries({ ClientRequest: requests, ServerNotification: notifications,
    ServerRequest: { "item/tool/call": ["threadId:string", "turnId:string", "callId:string", "tool:string", "namespace:string", "arguments"] } })) {
    const variants = root?.definitions?.[kind]?.oneOf;
    if (!Array.isArray(variants)) throw new Error(`protocol missing ${kind}`);
    for (const [method, fields] of Object.entries(contracts)) {
      const envelope = variants.find((variant) => variant.properties?.method?.enum?.includes(method));
      if (!envelope) throw new Error(`protocol missing ${method}`);
      const params = requireFields(root, envelope.properties.params, fields, method);
      paramsByMethod.set(method, params);
      if (generatedInputs[method]) requireKnownInputs(params, generatedInputs[method], method);
    }
  }
  const toolArray = resolveSchema(root, paramsByMethod.get("thread/start").properties.dynamicTools);
  const tool = resolveSchema(root, toolArray.items).oneOf?.find((variant) => variant.properties?.type?.enum?.includes("function"));
  const toolFields = ["type", "name", "description", "inputSchema"];
  requireKnownInputs(requireFields(root, tool, toolFields, "dynamicTools.function"), toolFields, "dynamicTools.function");
  const toolOutput = resolveSchema(root, paramsByMethod.get("turn/start").properties.toolOutput);
  requireKnownInputs(toolOutput, ["name", "output"], "toolOutput");
  const completedTurn = resolveSchema(root, paramsByMethod.get("turn/completed").properties.turn);
  const statuses = resolveSchema(root, completedTurn.properties.status).enum;
  if (!["inProgress", "completed", "interrupted", "failed"].every((status) => statuses?.includes(status))) {
    throw new Error("protocol missing required turn status values");
  }
  const responses = {
    ModelListResponse: ["data.*.model:string", "data.*.supportedReasoningEfforts.*.reasoningEffort:string", "nextCursor:string"],
    ThreadStartResponse: ["thread.id:string", "thread.cwd:string", "thread.parentThreadId:string", "thread.status", "model:string"],
    ThreadResumeResponse: ["thread.id:string", "thread.cwd:string", "thread.parentThreadId:string", "thread.status", "model:string"],
    ThreadForkResponse: ["thread.id:string", "thread.cwd:string", "thread.parentThreadId:string", "thread.status", "model:string"],
    ThreadBackgroundTerminalsListResponse: ["data:array", "nextCursor:string"],
    TurnStartResponse: ["turn.id:string", "turn.status:string"],
  };
  for (const [name, fields] of Object.entries(responses)) requireFields(root, root.definitions.v2?.[name], fields, name);
  const toolResponse = requireFields(root, root.definitions.DynamicToolCallResponse, ["contentItems:array", "success:boolean"], "DynamicToolCallResponse");
  requireKnownInputs(toolResponse, ["contentItems", "success"], "DynamicToolCallResponse");
}

// 起動する実行ファイルから仕様を生成させる。推論・タスク作成・サーバー待受は行わない。
export function checkCliCompatibility(innerCodexPath) {
  const options = { encoding: "utf8", timeout: PROBE_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: PROBE_MAX_BYTES,
    env: { ...process.env, CODEX_CLI_PATH: "" } };
  const version = spawnSync(innerCodexPath, ["--version"], options);
  const cliVersion = version.status === 0 ? `${version.stdout}\n${version.stderr}`.match(/codex-cli\s+(\S+)/)?.[1] ?? null : null;
  let temporary;
  try {
    temporary = mkdtempSync(path.join(tmpdir(), "model-router-schema-"));
    const result = spawnSync(innerCodexPath, ["app-server", "generate-json-schema", "--experimental", "--out", temporary], options);
    if (result.error?.code === "ETIMEDOUT") throw new Error(`protocol schema generation timed out after ${PROBE_TIMEOUT_MS}ms`);
    if (result.error || result.status !== 0) throw new Error(`protocol schema generation failed: ${result.error?.message ?? `exit ${result.status}; ${result.stderr.trim()}`}`);
    const protocol = JSON.parse(readFileSync(path.join(temporary, SCHEMA_FILENAME), "utf8"));
    checkProtocol(protocol);
    const switchRequest = createSwitchRequest(protocol);
    return { ok: true, cliVersion, reason: null, switchRequest };
  } catch (error) {
    return { ok: false, cliVersion, reason: error.message };
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}
