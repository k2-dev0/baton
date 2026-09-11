import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { isRepositoryEnabled } from "./policy.mjs";

const MAX_STDERR_BYTES = 64 * 1024;

// 有効化済みプロジェクト内だけを探索し、最寄りのhooks.jsonの独自イベントを読む。
export function loadPreModelSwitchHooks(cwd, enabledRepositories) {
  if (!isRepositoryEnabled(cwd, enabledRepositories)) return [];
  let directory = path.resolve(cwd);
  while (isRepositoryEnabled(directory, enabledRepositories)) {
    const file = path.join(directory, ".codex", "hooks.json");
    let contents;
    try { contents = readFileSync(file, "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (contents !== undefined) {
      try { return parsePreModelSwitchHooks(JSON.parse(contents)); }
      catch (error) { throw new Error(`${file}: ${error.message}`); }
    }
    if (existsSync(path.join(directory, ".git"))) break;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return [];
}

// 他イベントを保持した標準hook形式から、Batonが実行するcommandだけを取り出す。
export function parsePreModelSwitchHooks(document) {
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!object(document)) throw new Error("hooks.json must be an object");
  if (document.hooks === undefined) return [];
  if (!object(document.hooks)) throw new Error("hooks must be an object");
  const groups = document.hooks.PreModelSwitch;
  if (groups === undefined) return [];
  if (!Array.isArray(groups)) throw new Error("PreModelSwitch must be an array");
  return groups.flatMap(group => {
    if (!object(group) || !Array.isArray(group.hooks)) throw new Error("PreModelSwitch groups require a hooks array");
    if (Object.keys(group).some(key => !["matcher", "hooks"].includes(key))) throw new Error("unsupported PreModelSwitch group field");
    if (group.matcher !== undefined && !["", "*"].includes(group.matcher)) throw new Error("PreModelSwitch does not support filtered matchers");
    return group.hooks.map(handler => {
      if (!object(handler) || handler.type !== "command") throw new Error("PreModelSwitch type must be command");
      if (Object.keys(handler).some(key => !["type", "command", "timeout", "statusMessage", "async"].includes(key))) {
        throw new Error("unsupported PreModelSwitch handler field");
      }
      if (typeof handler.command !== "string" || !handler.command.trim()) throw new Error("command must be a non-empty string");
      if (handler.async !== undefined && handler.async !== false) throw new Error("PreModelSwitch must wait for its result; async:true is unsupported");
      if (handler.statusMessage !== undefined && typeof handler.statusMessage !== "string") throw new Error("statusMessage must be a string");
      const timeout = handler.timeout === undefined ? 5 : handler.timeout;
      if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30) throw new Error("timeout must be from 1 to 30 seconds");
      return { command: "/bin/sh", args: ["-c", handler.command], timeout };
    });
  });
}

function detailFrom(chunks, fallback) {
  const detail = Buffer.concat(chunks).toString("utf8").trim();
  return detail || fallback;
}

// 一つのhookだけを非同期実行し、標準エラーの上限と終了条件をfail-closedで扱う。
function runCommandHook(handler, event, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ allowed: false, reason: "PreModelSwitch hook was cancelled.", reasonCode: "cancelled" });
      return;
    }

    const stderr = [];
    let stderrBytes = 0;
    let forcedFailure = null;
    let settled = false;
    let child;
    let timer;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const stop = (reason, reasonCode) => {
      forcedFailure ??= { allowed: false, reason, reasonCode };
      try { if (child?.pid) process.kill(-child.pid, "SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") child?.kill("SIGKILL"); }
      child?.stdin.destroy();
      child?.stderr.destroy();
      finish(forcedFailure);
    };
    const abort = () => stop("PreModelSwitch hook was cancelled.", "cancelled");

    try {
      child = spawn(handler.command, handler.args, {
        cwd: event.cwd,
        detached: true,
        env: { ...process.env, CODEX_BATON_HOOK_EVENT: "PreModelSwitch" },
        stdio: ["pipe", "ignore", "pipe"],
      });
    } catch (error) {
      finish({ allowed: false, reason: `PreModelSwitch hook failed to start: ${error.message}`, reasonCode: "start-failed" });
      return;
    }

    signal?.addEventListener("abort", abort, { once: true });
    child.stdin.on("error", () => {});
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) {
        stop(`PreModelSwitch hook stderr exceeded ${MAX_STDERR_BYTES} bytes.`, "output-limit");
        return;
      }
      stderr.push(chunk);
    });
    child.once("error", (error) => {
      finish({ allowed: false, reason: `PreModelSwitch hook failed to start: ${error.message}`, reasonCode: "start-failed" });
    });
    child.once("close", (code, exitSignal) => {
      if (forcedFailure) {
        finish(forcedFailure);
      } else if (code === 0) {
        finish({ allowed: true, reasonCode: "allowed" });
      } else if (code === 2) {
        finish({ allowed: false, reason: detailFrom(stderr, "PreModelSwitch hook denied the switch."), reasonCode: "denied" });
      } else {
        const status = exitSignal ? `signal ${exitSignal}` : `exit code ${code}`;
        finish({ allowed: false,
          reason: `PreModelSwitch hook failed with ${status}: ${detailFrom(stderr, "no error output")}`,
          reasonCode: "hook-failed" });
      }
    });

    timer = setTimeout(() => {
      stop(`PreModelSwitch hook timed out after ${handler.timeout} seconds.`, "timeout");
    }, handler.timeout * 1000);
    timer.unref?.();
    child.stdin.end(`${JSON.stringify(event)}\n`);
  });
}

// 設定順を保って実行し、一つでも許可以外なら後続hookを起動しない。
export async function runPreModelSwitchHooks(handlers, event, { signal } = {}) {
  for (let index = 0; index < handlers.length; index += 1) {
    const result = await runCommandHook(handlers[index], event, signal);
    if (!result.allowed) return { ...result, hookIndex: index };
  }
  return { allowed: true, reasonCode: "allowed", hookCount: handlers.length };
}
