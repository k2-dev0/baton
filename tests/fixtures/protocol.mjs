// Codex 0.153.4の生成仕様から、中継の通信契約だけを独立したfixtureとして表す。
const string = { type: "string" };
const object = (properties, required = []) => ({ type: "object", properties, required });
const ref = (name) => ({ $ref: `#/definitions/v2/${name}` });
const array = (items) => ({ type: "array", items });
const message = (method, params) => object({ method: { enum: [method] }, params });
const thread = object({ id: string, parentThreadId: string, cwd: string, status: {} });
const turn = object({ id: string, status: { type: "string", enum: ["inProgress", "completed", "interrupted", "failed"] } });
const collaboration = object({ settings: object({ model: string, reasoning_effort: string }) });
const settings = object({ model: string, effort: string, collaborationMode: collaboration });
const item = object({ threadId: string, turnId: string, item: {} });

export const protocol = {
  definitions: {
    ClientRequest: { oneOf: [
      message("initialize", object({ clientInfo: {}, capabilities: object({ experimentalApi: { type: "boolean" } }) })),
      message("model/list", object({ cursor: string, limit: { type: "integer" }, includeHidden: { type: "boolean" } })),
      message("thread/start", object({ cwd: string, dynamicTools: array({ oneOf: [object({ type: { enum: ["function"] }, name: string, description: string, inputSchema: {} }, ["type", "name", "description", "inputSchema"])] }) })),
      message("thread/resume", object({ threadId: string })),
      message("thread/fork", object({ threadId: string })),
      message("thread/backgroundTerminals/list", object({ threadId: string }, ["threadId"])),
      message("turn/interrupt", object({ threadId: string, turnId: string }, ["threadId", "turnId"])),
      message("thread/settings/update", ref("ThreadSettingsUpdateParams")),
      message("turn/start", ref("TurnStartParams")),
    ] },
    ServerRequest: { oneOf: [message("item/tool/call", object({ threadId: string, turnId: string, callId: string, tool: string, namespace: string, arguments: true }))] },
    ServerNotification: { oneOf: [
      message("thread/started", object({ thread })),
      message("thread/settings/updated", object({ threadId: string, threadSettings: settings })),
      message("turn/started", object({ threadId: string, turn })),
      message("turn/completed", object({ threadId: string, turn })),
      message("item/started", item), message("item/completed", item),
      message("serverRequest/resolved", object({ threadId: string, requestId: {} })),
    ] },
    DynamicToolCallResponse: object({ contentItems: array({}), success: { type: "boolean" } }),
    v2: {
      ThreadSettingsUpdateParams: object({ threadId: string, model: string, effort: string, collaborationMode: collaboration }, ["threadId"]),
      TurnStartParams: object({ threadId: string, input: array({}), model: string, effort: string, collaborationMode: collaboration, toolOutput: { anyOf: [ref("TurnToolOutput"), { type: "null" }] }, turnTrigger: string }, ["threadId", "input"]),
      TurnToolOutput: object({ name: string, output: { anyOf: [string, array({})] } }, ["name", "output"]),
      ModelListResponse: object({ data: array(object({ model: string, supportedReasoningEfforts: array(object({ reasoningEffort: string })) })), nextCursor: string }),
      ThreadStartResponse: object({ thread, model: string }),
      ThreadResumeResponse: object({ thread, model: string }),
      ThreadForkResponse: object({ thread, model: string }),
      ThreadBackgroundTerminalsListResponse: object({ data: array({}), nextCursor: string }),
      TurnStartResponse: object({ turn }),
    },
  },
};

// 偽物のCLIでも本物と同じ生成コマンド経由で仕様を返す。
export const schemaCommand = `
if (process.argv[2] === "app-server" && process.argv[3] === "generate-json-schema") {
  const fs = require("node:fs");
  const path = require("node:path");
  fs.writeFileSync(path.join(process.argv[process.argv.indexOf("--out") + 1], "codex_app_server_protocol.schemas.json"), ${JSON.stringify(JSON.stringify(protocol))});
  process.exit(0);
}
`;
