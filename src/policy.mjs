import path from "node:path";

export const ROUTER_MODES = new Set(["observe", "fixed", "auto"]);
export const REQUEST_MODEL_POLICIES = new Set(["preserve", "replace"]);

const ASTRA_HINTS = [
  /\b(?:etag|race condition|idempotenc[ey]|concurren(?:cy|t)|authorization|billing)\b/i,
  /(?:請求|課金|権限|認可|並行(?:保存|処理)|順序逆転|再処理|不変条件|責務.*境界)/u,
];

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
  if (input.schemaVersion !== 1) throw new Error("config.schemaVersion must be 1");
  if (!ROUTER_MODES.has(input.mode)) {
    throw new Error("config.mode must be observe, fixed, or auto");
  }
  if (!REQUEST_MODEL_POLICIES.has(input.requestModelPolicy)) {
    throw new Error("config.requestModelPolicy must be preserve or replace");
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
  if (!isPlainObject(input.models)) throw new Error("config.models must be an object");
  assertString(input.models.default, "config.models.default");
  assertString(input.models.escalated, "config.models.escalated");
  if (!isPlainObject(input.efforts)) throw new Error("config.efforts must be an object");
  for (const [model, effort] of Object.entries(input.efforts)) {
    assertString(model, "config.efforts key");
    assertString(effort, `config.efforts.${model}`);
  }
  for (const model of [input.models.default, input.models.escalated]) {
    if (typeof input.efforts[model] !== "string") {
      throw new Error(`config.efforts must define an effort for ${model}`);
    }
  }
  assertString(input.rulesVersion, "config.rulesVersion");
  assertString(input.innerCodexPath, "config.innerCodexPath");
  assertString(input.desktopAppPath, "config.desktopAppPath");
  if (!path.isAbsolute(input.innerCodexPath) || !path.isAbsolute(input.desktopAppPath)) {
    throw new Error("innerCodexPath and desktopAppPath must be absolute paths");
  }
  if (input.fixedModel !== null) {
    assertString(input.fixedModel, "config.fixedModel");
    if (typeof input.efforts[input.fixedModel] !== "string") {
      throw new Error(`config.efforts must define an effort for fixedModel ${input.fixedModel}`);
    }
  }
  if (!isPlainObject(input.threadPins)) throw new Error("config.threadPins must be an object");
  for (const [threadId, pin] of Object.entries(input.threadPins)) {
    assertString(threadId, "threadPins key");
    if (!isPlainObject(pin)) throw new Error(`threadPins.${threadId} must be an object`);
    assertString(pin.model, `threadPins.${threadId}.model`);
    if (pin.effort !== undefined && pin.effort !== null) {
      assertString(pin.effort, `threadPins.${threadId}.effort`);
    }
    if (pin.effort == null && typeof input.efforts[pin.model] !== "string") {
      throw new Error(`threadPins.${threadId} needs effort or a config.efforts entry`);
    }
  }
  if (!isPlainObject(input.escalatedThreads)) {
    throw new Error("config.escalatedThreads must be an object");
  }
  for (const [threadId, reasonCodes] of Object.entries(input.escalatedThreads)) {
    assertString(threadId, "escalatedThreads key");
    if (
      !Array.isArray(reasonCodes) ||
      reasonCodes.length === 0 ||
      reasonCodes.some((reason) => typeof reason !== "string" || reason.length === 0)
    ) {
      throw new Error(`escalatedThreads.${threadId} must be a non-empty string array`);
    }
  }
  if (
    !Array.isArray(input.supportedCliVersions) ||
    input.supportedCliVersions.some((version) => typeof version !== "string" || version.length === 0)
  ) {
    throw new Error("config.supportedCliVersions must be a string array");
  }
  if (!Number.isSafeInteger(input.maxBufferedBytes) || input.maxBufferedBytes < 1024) {
    throw new Error("config.maxBufferedBytes must be an integer of at least 1024");
  }

  return {
    ...input,
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

// ユーザー入力項目から助言用のテキストだけを抽出する。
export function extractText(input) {
  if (!Array.isArray(input)) return "";
  return input
    .filter((item) => isPlainObject(item) && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

// 自由文を自動切り替えに使わず、低信頼の推奨だけを返す。
export function getAdvisoryRecommendation(input, models) {
  const text = extractText(input);
  if (text && ASTRA_HINTS.some((pattern) => pattern.test(text))) {
    return {
      model: models.escalated,
      reasonCode: "advisory-risk-language",
      confidence: "low",
    };
  }
  return {
    model: models.default,
    reasonCode: "advisory-default",
    confidence: "low",
  };
}

/**
 * Selects a model without performing I/O or mutating the supplied state.
 * Free-form input can affect advisory output only; it cannot trigger automatic escalation.
 */
export function selectModel({ config, thread, requestParams }) {
  const cwd = requestParams.cwd ?? thread?.cwd ?? null;
  const advisory = getAdvisoryRecommendation(requestParams.input, config.models);
  const collaborationSettings = isPlainObject(requestParams.collaborationMode?.settings)
    ? requestParams.collaborationMode.settings
    : {};
  const requestedModel =
    typeof requestParams.model === "string" && requestParams.model.length > 0
      ? requestParams.model
      : typeof collaborationSettings.model === "string" && collaborationSettings.model.length > 0
        ? collaborationSettings.model
        : null;
  const requestedEffort =
    typeof requestParams.effort === "string" && requestParams.effort.length > 0
      ? requestParams.effort
      : typeof collaborationSettings.reasoning_effort === "string" &&
          collaborationSettings.reasoning_effort.length > 0
        ? collaborationSettings.reasoning_effort
        : null;
  const base = {
    apply: false,
    model: null,
    effort: null,
    reasonCode: "preserve",
    advisory,
  };

  if (!thread || thread.isMain !== true) {
    return { ...base, reasonCode: "not-confirmed-main-thread" };
  }
  if (!isRepositoryEnabled(cwd, config.enabledRepositories)) {
    return { ...base, reasonCode: "repository-not-enabled" };
  }

  if (config.requestModelPolicy === "preserve") {
    if (requestedModel) {
      const effort = requestedEffort ?? config.efforts[requestedModel] ?? null;
      if (!effort) return { ...base, reasonCode: "request-model-preserved" };
      return {
        ...base,
        apply: true,
        model: requestedModel,
        effort,
        reasonCode: requestedEffort ? "user-model-and-effort" : "user-model",
      };
    }
    if (requestedEffort) {
      return { ...base, reasonCode: "user-effort-preserved" };
    }
    if (typeof thread.userModel === "string" && thread.userModel.length > 0) {
      const effort = thread.userEffort ?? config.efforts[thread.userModel] ?? null;
      if (!effort) return { ...base, reasonCode: "sticky-user-model-preserved" };
      return {
        ...base,
        apply: true,
        model: thread.userModel,
        effort,
        reasonCode: "sticky-user-model",
      };
    }
  }

  const pin = config.threadPins[thread.id];
  if (pin) {
    return {
      ...base,
      apply: true,
      model: pin.model,
      effort: thread.userEffort ?? pin.effort ?? config.efforts[pin.model],
      reasonCode: "thread-pin",
    };
  }

  if (config.mode === "observe") {
    return { ...base, reasonCode: "observe-only" };
  }

  if (config.mode === "fixed") {
    if (!config.fixedModel) return { ...base, reasonCode: "fixed-model-not-configured" };
    return {
      ...base,
      apply: true,
      model: config.fixedModel,
      effort: thread.userEffort ?? config.efforts[config.fixedModel],
      reasonCode: "fixed-model",
    };
  }

  const unresolvedReasons = config.escalatedThreads[thread.id] ?? thread.unresolvedReasons ?? [];
  if (unresolvedReasons.length > 0) {
    return {
      ...base,
      apply: true,
      model: config.models.escalated,
      effort: thread.userEffort ?? config.efforts[config.models.escalated],
      reasonCode: "confirmed-escalation",
      unresolvedReasons: [...unresolvedReasons],
    };
  }

  return {
    ...base,
    apply: true,
    model: config.models.default,
    effort: thread.userEffort ?? config.efforts[config.models.default],
    reasonCode: "auto-default",
  };
}

// 選択済みのモデル設定だけを複製要求へ反映し、他のターン設定を保持する。
export function applySelection(request, selection) {
  const changed = structuredClone(request);
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
