import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "vitest";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function startPty(command, args, options = {}) {
  const { transcriptPath, ...spawnOptions } = options;
  const child = spawn(process.env.BATON_TEST_PYTHON ?? "python3",
    [path.join(root, "tests/fixtures/pty-driver.py"), command, ...args], {
      ...spawnOptions, env: { ...process.env, TERM: "xterm-256color", ...options.env }, stdio: "pipe",
    });
  let output = "";
  let exited = false;
  let exitCode;
  let spawnError;
  const capture = chunk => {
    output = (output + chunk.toString()).slice(-1_000_000);
    if (transcriptPath) appendFileSync(transcriptPath, chunk, { mode: 0o600 });
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.stdin.on("error", () => {});
  child.on("error", error => { spawnError = error; exited = true; });
  const closed = new Promise(resolve => child.on("close", code => { exited = true; exitCode = code; resolve(); }));
  return { child, closed, get output() { return output; }, get exited() { return exited; },
    get exitCode() { return exitCode; }, get error() { return spawnError; } };
}

async function until(predicate, timeout, label, session) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (predicate()) return;
    if (session?.exited) throw new Error(`${label}: PTY exited (${session.exitCode}): ${session.error ?? session.output.slice(-3000)}`);
    await delay(100);
  }
  throw new Error(`${label}: timed out${session ? `\n${session.output.slice(-3000)}` : ""}`);
}

function readEvents(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").slice(0, -1).filter(Boolean).map(JSON.parse);
}

test("PTY試験ドライバーは端末入力を渡し、子の終了コードを保持する", async () => {
  const session = startPty("/bin/sh", ["-c", "test -t 0 && test -t 1 || exit 9; printf 'PTY_READY'; read answer; test \"$answer\" = hello || exit 8; exit 7"]);
  try {
    await until(() => session.output.includes("PTY_READY"), 5000, "PTY ready", session);
    session.child.stdin.write("hello\n");
    await until(() => session.exited, 5000, "PTY exit");
    assert.equal(session.exitCode, 7, session.output);
  } finally {
    if (!session.exited) session.child.kill("SIGTERM");
    await session.closed;
  }
}, 15_000);

test.runIf(process.env.BATON_CLI_LIVE === "1")("実CLIのPTY接続でSol→Astra後に読取り・編集・検証し、連続切り替え後も同一タスクを完了する", async () => {
  const temporary = realpathSync(mkdtempSync(path.join(tmpdir(), "baton-cli-live-")));
  const workspace = path.join(temporary, "work");
  mkdirSync(workspace);
  const codex = process.env.BATON_TEST_CODEX ?? spawnSync("/bin/sh", ["-c", "command -v codex"], { encoding: "utf8" }).stdout.trim();
  assert.ok(path.isAbsolute(codex), "BATON_TEST_CODEXまたはPATHにCodexの実行ファイルが必要");
  const configPath = path.join(temporary, "config.json");
  const diagnosticsPath = path.join(temporary, "router.jsonl");
  writeFileSync(configPath, JSON.stringify({ schemaVersion: 2, enabledRepositories: [workspace],
    innerCodexPath: codex, desktopAppPath: "/Applications/ChatGPT.app", maxBufferedBytes: 32 * 1024 * 1024 }));
  writeFileSync(path.join(workspace, "AGENTS.md"), "This is an isolated integration test. Follow the user's ordered steps. Await all tools before calling switch_model, and call switch_model alone. Do not select other models or delegate.\n");
  writeFileSync(path.join(workspace, "add.mjs"), "export const add = (a, b) => a - b;\n");
  writeFileSync(path.join(workspace, "add.test.mjs"), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './add.mjs';\ntest('BATON_TEST_OK', () => assert.equal(add(2, 3), 5));\n");
  const prompt = 'Perform these ordered integration-test steps in this same task without asking for more input. '
    + '1. Call switch_model({"model":"gpt-6-astra","config":{"effort":"high"}}) alone. '
    + '2. After the switch, read add.mjs and add.test.mjs, fix only add.mjs, and run node --test add.test.mjs. Await its passing result. '
    + '3. Call switch_model({"model":"gpt-5.6-sol","config":{"effort":"high"}}) alone. '
    + '4. Call switch_model({"model":"gpt-5.6-sol","config":{"effort":"xhigh"}}) alone. '
    + '5. Respond with exactly BATON_CLI_LIVE_OK. Do not repeat completed steps.';
  const session = startPty(path.join(root, "bin/baton"), ["--no-alt-screen", "-m", "gpt-5.6-sol",
    "-c", "model_reasoning_effort=\"high\"", "-c", "check_for_update_on_startup=false",
    "-c", `projects.${JSON.stringify(workspace)}.trust_level="trusted"`, "-s", "workspace-write", prompt], {
    cwd: workspace, transcriptPath: path.join(temporary, "terminal.txt"), env: { CODEX_AUTO_CODEX_BIN: codex, CODEX_BATON_CONFIG: configPath,
      CODEX_BATON_STATE_DIR: temporary },
  });
  console.log(`CLI live evidence: ${temporary}`);
  try {
    let trustedFixture = false;
    await until(() => {
      // --remoteではCLIのprojects overrideがサーバー側へ渡らない版がある。
      // 今回作成したfixtureの信頼確認だけ回答する。ツール承認・ログインには回答しない。
      const terminal = session.output.replace(/\x1b\[[0-9;? >]*[A-Za-z]/g, "");
      if (!trustedFixture && terminal.includes(workspace) && terminal.includes("1. Yes, continue") && terminal.includes("Press enter to continue")) {
        trustedFixture = true;
        session.child.stdin.write("\r");
      }
      return readEvents(diagnosticsPath).some(e => e.event === "turn-state" && e.method === "turn/started");
    },
      45_000, "CLI startup (check terminal.txt for trust/login prompts)", session);
    const threadId = readEvents(diagnosticsPath).find(e => e.event === "control-request" && e.source === "client" && e.method === "turn/start").threadId;
    await until(() => readEvents(diagnosticsPath).some(e => e.threadId === threadId && e.event === "turn-state" && e.method === "turn/completed" && e.status !== "interrupted"),
      240_000, "same-task completion", session);
    const events = readEvents(diagnosticsPath);
    const taskEvents = events.filter(e => e.threadId === threadId);
    const switches = taskEvents.filter(e => e.event === "switch-accepted");
    assert.deepEqual(switches.map(e => [e.model, e.effort]), [["gpt-6-astra", "high"], ["gpt-5.6-sol", "high"], ["gpt-5.6-sol", "xhigh"]]);
    assert.ok(switches.every(e => e.threadId === threadId));
    assert.equal(taskEvents.filter(e => e.event === "control-request" && e.source === "client" && e.method === "turn/start").length, 1, "追加入力なし");
    assert.equal(taskEvents.filter(e => e.event === "control-request" && e.source === "baton" && e.method === "turn/interrupt").length, 3);
    assert.ok(events.some(e => e.event === "websocket-connected"));
    const sessionsPath = path.join(process.env.CODEX_HOME ?? path.join(homedir(), ".codex"), "sessions");
    const rolloutName = readdirSync(sessionsPath, { recursive: true }).find(name => name.endsWith(`${threadId}.jsonl`));
    assert.ok(rolloutName, "実モデル・通常ツールの実行記録が必要");
    const rollout = readFileSync(path.join(sessionsPath, rolloutName), "utf8");
    writeFileSync(path.join(temporary, "rollout.jsonl"), rollout, { mode: 0o600 });
    const records = rollout.trim().split("\n").map(JSON.parse);
    const contexts = records.filter(e => e.type === "turn_context");
    assert.deepEqual(contexts.map(e => [e.payload.model, e.payload.effort]),
      [["gpt-5.6-sol", "high"], ["gpt-6-astra", "high"], ["gpt-5.6-sol", "high"], ["gpt-5.6-sol", "xhigh"]]);
    const commands = records.filter(e => e.payload?.type === "item_completed" && e.payload.turn_id === switches[0].turnId)
      .map(e => e.payload.item).filter(item => item.type === "CommandExecution");
    assert.ok(commands.some(item => item.exit_code === 0 && /node\s+--test/.test(item.command.join(" ")) && /BATON_TEST_OK/.test(item.aggregated_output ?? item.stdout)), "Astraで通常テストが成功した証拠");
    assert.ok(records.some(e => e.payload?.type === "task_complete" && e.payload.turn_id === switches.at(-1).turnId
      && e.payload.last_agent_message?.trim() === "BATON_CLI_LIVE_OK"), "最終回答まで完了");
    await until(() => stripVTControlCharacters(session.output).includes("• BATON_CLI_LIVE_OK"), 5000, "最終回答のCLI表示（入力プロンプトの文字列ではない）", session);
    assert.ok(!stripVTControlCharacters(session.output).includes("Conversation interrupted"), "自動切り替えをCLIに中断エラーとして表示しない");
    assert.ok(!stripVTControlCharacters(session.output).includes("dynamic tool call was cancelled before receiving a response"),
      "サーバーの内部中断ログをCLIの入力欄へ混ぜない");
    const switchCalls = records.filter(e => e.payload?.type === "item_completed")
      .map(e => e.payload.item).filter(item => item.type === "DynamicToolCall" && item.tool === "switch_model");
    assert.equal(switchCalls.length, 3);
    assert.ok(switchCalls.every(item => item.status === "completed" && item.success === true), "切り替えツール自体が成功応答で完了する");
    assert.ok(!readFileSync(path.join(temporary, "app-server.stderr.log"), "utf8").includes("dynamic tool call was cancelled before receiving a response"),
      "画面から隠すだけでなく未応答キャンセルを発生させない");
    // 既存の30秒タイマーが後から継続ターン・CLIを終了させないことも確認する。
    await delay(31_000);
    assert.equal(session.exited, false, session.output.slice(-3000));
    assert.ok(!readEvents(diagnosticsPath).some(e => ["switch-failed", "switch-request-timeout", "proxy-failure", "websocket-closed", "cli-exit"].includes(e.event)));
    // 自動切り替えの検証完了後、別の入力を実際のEsc操作で止める。
    const outputBeforeStop = session.output.length;
    session.child.stdin.write("\x1b[200~Run sleep 30, then reply STOP_TEST_FINISHED. Do not switch models.\x1b[201~");
    await delay(300);
    session.child.stdin.write("\r");
    let stopTurnId;
    await until(() => {
      stopTurnId = readEvents(diagnosticsPath).find(e => e.threadId === threadId && e.event === "turn-state"
        && e.method === "turn/started" && e.timestamp > events.at(-1).timestamp)?.turnId;
      return Boolean(stopTurnId);
    }, 15_000, "停止確認用ターンの開始", session);
    session.child.stdin.write("\x1b");
    await until(() => readEvents(diagnosticsPath).some(e => e.threadId === threadId && e.turnId === stopTurnId
      && e.event === "turn-state" && e.method === "turn/completed" && e.status === "interrupted"), 15_000, "Escによる停止", session);
    await until(() => stripVTControlCharacters(session.output.slice(outputBeforeStop)).includes("Conversation interrupted"),
      5000, "利用者が停止した場合のCLI表示", session);
    assert.equal(readEvents(diagnosticsPath).filter(e => e.threadId === threadId && e.event === "switch-accepted").length, 3,
      "利用者の停止後に自動続行しない");
  } finally {
    // 作成した試験プロセスだけを終了し、失敗時も診断資料を残す。
    if (!session.exited) {
      session.child.stdin.write("\x1b[200~/quit\x1b[201~");
      await delay(300);
      session.child.stdin.write("\r");
      await Promise.race([session.closed, delay(2000)]);
    }
    if (!session.exited) session.child.kill("SIGTERM");
    await session.closed;
    writeFileSync(path.join(temporary, "terminal.txt"), session.output, { mode: 0o600 });
  }
}, 330_000);
