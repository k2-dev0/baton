import path from "node:path";

const RESERVED_MODEL_SETTINGS = new Set(["model", "threadId", "turnId", "input", "toolOutput", "turnTrigger", "clientUserMessageId",
  "cwd", "runtimeWorkspaceRoots", "approvalPolicy", "approvalsReviewer", "sandboxPolicy", "permissions", "environments",
  "collaborationMode", "additionalContext", "multiAgentMode", "cyberAccessProgram", "__proto__", "constructor", "prototype"]);

// モデル設定からタスク識別子・入力・権限などの実行制御を分離する。
export function isReservedModelSetting(key) {
  return RESERVED_MODEL_SETTINGS.has(key);
}

// JSON設定とプロトコル値を、配列を除くオブジェクトとして判定する。
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// 設定境界で必須文字列を検証し、空値を早期に拒否する。
function assertString(value, name, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string${nullable ? " or null" : ""}`);
  }
}

// 対象リポジトリの比較表現を絶対正規化パスへ統一する。
function normalizeRepository(repository) {
  return path.resolve(repository);
}

// 外部JSON設定を実行前に検証し、判定処理が使える内部設定へ変換する。
export function validateConfig(input) {
  if (!isPlainObject(input)) throw new Error("config must be a JSON object");
  if (Object.hasOwn(input, "hooks")) throw new Error("Move hooks from config.json to the project's .codex/hooks.json");
  if (input.schemaVersion !== 2) throw new Error("config.schemaVersion must be 2; migrate using config_sample.json");
  const removed = ["mode", "requestModelPolicy", "fixedModel", "threadPins", "escalatedThreads", "efforts", "rulesVersion"];
  if (removed.some((key) => Object.hasOwn(input, key))) {
    throw new Error("legacy model policy settings were removed; use config_sample.json");
  }
  if (!Array.isArray(input.enabledRepositories)) {
    throw new Error("config.enabledRepositories must be an array");
  }
  for (const repository of input.enabledRepositories) {
    assertString(repository, "enabledRepositories[]");
    if (!path.isAbsolute(repository)) {
      throw new Error("enabledRepositories[] must contain absolute paths");
    }
  }
  assertString(input.innerCodexPath, "config.innerCodexPath");
  assertString(input.desktopAppPath, "config.desktopAppPath");
  if (!path.isAbsolute(input.innerCodexPath) || !path.isAbsolute(input.desktopAppPath)) {
    throw new Error("innerCodexPath and desktopAppPath must be absolute paths");
  }
  const minimumProtocolBytes = 1024;
  if (!Number.isSafeInteger(input.maxBufferedBytes) || input.maxBufferedBytes < minimumProtocolBytes) {
    throw new Error("config.maxBufferedBytes must be an integer of at least 1024");
  }

  const { models: unusedModels, ...startupConfig } = input;
  return {
    ...startupConfig,
    enabledRepositories: input.enabledRepositories.map(normalizeRepository),
  };
}

// 作業ディレクトリが有効化済みリポジトリ自身または配下かを判定する。
export function isRepositoryEnabled(cwd, enabledRepositories) {
  if (typeof cwd !== "string" || cwd.length === 0 || !path.isAbsolute(cwd)) return false;
  const normalized = path.resolve(cwd);
  return enabledRepositories.some((repository) => {
    const relative = path.relative(repository, normalized);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

// 選択モデルの設定一式を複製要求へ反映し、既存の作業モードと整合させる。
export function applySelection(request, selection) {
  const changed = structuredClone(request);
  changed.params = { ...changed.params, ...structuredClone(selection.settings) };
  changed.params.model = selection.model;
  changed.params.effort = selection.effort;
  if (isPlainObject(changed.params.collaborationMode)) {
    const settings = changed.params.collaborationMode.settings;
    if (!isPlainObject(settings)) {
      throw new Error("turn/start collaborationMode.settings must be an object");
    }
    settings.model = selection.model;
    settings.reasoning_effort = selection.effort;
  }
  return changed;
}
