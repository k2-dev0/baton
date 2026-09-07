import { isDeepStrictEqual } from "node:util";
import { isReservedModelSetting } from "./policy.mjs";

const ANNOTATIONS = new Set(["$schema", "title", "description", "default", "examples", "deprecated"]);
const KEYWORDS = new Set(["$ref", "type", "enum", "const", "anyOf", "oneOf", "allOf", "properties", "required",
  "additionalProperties", "items", "minLength", "maxLength", "pattern", "minimum", "maximum",
  "exclusiveMinimum", "exclusiveMaximum", "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties"]);
const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const MAX_DEPTH = 64;

// ネイティブ仕様のローカルJSON Pointerだけを解決し、欠落参照は起動時に拒否する。
function resolveReference(root, reference) {
  if (typeof reference !== "string" || !reference.startsWith("#/")) throw new Error("unsupported settings schema reference");
  let value = root;
  for (const key of reference.slice(2).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (!value || !Object.hasOwn(value, key)) throw new Error(`missing settings schema reference: ${reference}`);
    value = value[key];
  }
  return value;
}

// 必要な設定仕様だけを取り出す。未対応の検証規則を黙って省略しない。
function copySchema(schema, root, definitions, references) {
  if (typeof schema === "boolean") return schema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("malformed settings schema");
  const copy = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!ANNOTATIONS.has(key) && !KEYWORDS.has(key)) throw new Error(`unsupported settings schema keyword: ${key}`);
    if (key === "$ref") {
      if (!references.has(value)) {
        const name = `setting_${references.size}`;
        references.set(value, name);
        definitions[name] = copySchema(resolveReference(root, value), root, definitions, references);
      }
      copy.$ref = `#/definitions/${references.get(value)}`;
    } else if (["anyOf", "oneOf", "allOf"].includes(key)) {
      copy[key] = value.map((branch) => copySchema(branch, root, definitions, references));
    } else if (key === "properties") {
      copy.properties = Object.fromEntries(Object.entries(value).map(([name, child]) =>
        [name, copySchema(child, root, definitions, references)]));
    } else if (["items", "additionalProperties"].includes(key)) {
      copy[key] = copySchema(value, root, definitions, references);
    } else {
      copy[key] = structuredClone(value);
    }
  }
  if (copy.type && ![copy.type].flat().every((type) => TYPES.has(type))) throw new Error("unsupported settings schema type");
  if (copy.pattern) new RegExp(copy.pattern, "u");
  return copy;
}

// JSONの値型を仕様の型名へ対応させる。数値への暗黙変換はしない。
function matchesType(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

// サポート済みJSON Schema規則だけを適用し、循環・過度な入れ子は拒否する。
function validate(value, schema, root, location, depth = 0) {
  const invalid = (reason) => `${location}: ${reason}`;
  if (depth > MAX_DEPTH) return invalid("settings nesting exceeds validation limit");
  if (schema === true) return null;
  if (schema === false) return invalid("not allowed");
  if (schema.$ref) {
    const error = validate(value, resolveReference(root, schema.$ref), root, location, depth + 1);
    if (error) return error;
  }
  if (schema.type && ![schema.type].flat().some((type) => matchesType(value, type))) return invalid(`expected ${schema.type}`);
  if (schema.enum && !schema.enum.some((entry) => isDeepStrictEqual(entry, value))) return invalid(`expected one of ${JSON.stringify(schema.enum)}`);
  if (Object.hasOwn(schema, "const") && !isDeepStrictEqual(value, schema.const)) return invalid("unexpected value");
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (!schema[key]) continue;
    const results = schema[key].map((branch) => validate(value, branch, root, location, depth + 1));
    const passed = results.filter((error) => !error).length;
    if ((key === "anyOf" && passed === 0) || (key === "oneOf" && passed !== 1) || (key === "allOf" && passed !== results.length)) {
      return invalid(`does not match ${key}: ${results.find(Boolean) ?? "ambiguous value"}`);
    }
  }
  if (matchesType(value, "object")) {
    const keys = Object.keys(value);
    if (keys.length < (schema.minProperties ?? 0) || keys.length > (schema.maxProperties ?? Infinity)) return invalid("invalid property count");
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) return invalid(`missing required ${key}`);
    for (const key of keys) {
      const child = Object.hasOwn(schema.properties ?? {}, key) ? schema.properties[key] : schema.additionalProperties ?? true;
      const error = validate(value[key], child, root, `${location}.${key}`, depth + 1);
      if (error) return error;
    }
  }
  if (Array.isArray(value)) {
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) return invalid("invalid item count");
    if (schema.uniqueItems && value.some((entry, index) => value.slice(0, index).some((other) => isDeepStrictEqual(entry, other)))) return invalid("duplicate items");
    for (const [index, entry] of value.entries()) {
      const error = validate(entry, schema.items ?? true, root, `${location}[${index}]`, depth + 1);
      if (error) return error;
    }
  }
  if (typeof value === "string") {
    const length = [...value].length;
    if (length < (schema.minLength ?? 0) || length > (schema.maxLength ?? Infinity)) return invalid("invalid string length");
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) return invalid("invalid string pattern");
  }
  if (typeof value === "number" && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity) ||
      value <= (schema.exclusiveMinimum ?? -Infinity) || value >= (schema.exclusiveMaximum ?? Infinity))) return invalid("number out of range");
  return null;
}

// インストール済みCodexの設定仕様から、ツール公開と受付検証で共用する契約を作る。
export function createSwitchRequest(protocol, models) {
  let params = protocol.definitions?.ClientRequest?.oneOf?.find((entry) =>
    entry.properties?.method?.enum?.includes("turn/start"))?.properties?.params;
  const visited = new Set();
  while (params?.$ref) {
    if (visited.has(params.$ref)) throw new Error("cyclic turn/start settings schema");
    visited.add(params.$ref);
    params = resolveReference(protocol, params.$ref);
  }
  if (!params?.properties?.effort) throw new Error("protocol missing turn/start effort settings");
  const definitions = {};
  const references = new Map();
  const properties = Object.fromEntries(Object.entries(params.properties)
    .filter(([key]) => !isReservedModelSetting(key))
    .map(([key, schema]) => [key, copySchema(schema, protocol, definitions, references)]));
  properties.effort = { allOf: [properties.effort, { type: "string", minLength: 1 }] };
  const inputSchema = {
    type: "object", properties: {
      model: { type: "string", enum: Object.keys(models) },
      config: { type: "object", properties, required: ["effort"], additionalProperties: false },
    }, required: ["model", "config"], additionalProperties: false,
    ...(Object.keys(definitions).length ? { definitions } : {}),
  };
  return { inputSchema, validateRequest: (args) => validate(args, inputSchema, inputSchema, "request") };
}
