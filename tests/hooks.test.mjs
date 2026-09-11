import assert from "node:assert/strict";
import { test } from "vitest";
import { runPreModelSwitchHooks, parsePreModelSwitchHooks, loadPreModelSwitchHooks } from "../src/hooks.mjs";
import { validateConfig } from "../src/policy.mjs";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const baseConfig = {
  schemaVersion: 2,
  enabledRepositories: ["/Users/test/project"],
  innerCodexPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
  desktopAppPath: "/Applications/ChatGPT.app",
  maxBufferedBytes: 1024,
};

const event = {
  event: "PreModelSwitch",
  threadId: "thread",
  turnId: "turn",
  cwd: process.cwd(),
  from: { model: "old-model", effort: "high" },
  to: { model: "new-model", config: { effort: "xhigh" } },
};

test("既存イベントを含む標準hook形式からPreModelSwitchのみ読む", () => {
  assert.deepEqual(parsePreModelSwitchHooks({hooks:{SessionStart:[]}}), []);
  const hooks = parsePreModelSwitchHooks({ hooks: { SessionStart: [{hooks:[{type:'command', command:'existing'}]}],
    PreModelSwitch: [{hooks:[{type:'command', command:'test -d .', statusMessage:'Checking'}]}] } });
  assert.deepEqual(hooks, [{command:'/bin/sh', args:['-c','test -d .'], timeout:5}]);
  assert.throws(() => validateConfig({...baseConfig, hooks:{PreModelSwitch:[]}}), /Move hooks/);
});

test.each([
  [{ hooks: [] }, /hooks must be an object/],
  [{ hooks: { PreModelSwitch: {} } }, /must be an array/],
  [{ hooks: { PreModelSwitch: [{}] } }, /hooks array/],
  [{ hooks: { PreModelSwitch: [{hooks:[{type:'command',command:''}]}] } }, /non-empty string/],
  [{ hooks: { PreModelSwitch: [{hooks:[{type:'command',command:'true',timeout:0}]}] } }, /1 to 30/],
  [{ hooks: { PreModelSwitch: [{hooks:[{type:'command',command:'true',async:true}]}] } }, /async:true/],
  [{ hooks: { PreModelSwitch: [{matcher:'Astra',hooks:[]}] } }, /filtered matchers/],
])("不正なPreModelSwitch hook設定を切替前に拒否する: %#", (document, reason) => {
  assert.throws(() => parsePreModelSwitchHooks(document), reason);
});

test("サブディレクトリから最寄りのhooks.jsonを読み、変更を再読込して境界外を読まない", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'baton-hook-files-'));
  const root = path.join(parent,'project');
  const subdir = path.join(root,'src');
  mkdirSync(path.join(root,'.codex'), {recursive:true});
  mkdirSync(subdir);
  mkdirSync(path.join(parent,'.codex'));
  writeFileSync(path.join(parent,'.codex','hooks.json'), '{');
  assert.deepEqual(loadPreModelSwitchHooks(subdir,[root]),[]);
  const file = path.join(root,'.codex','hooks.json');
  const contents = {hooks:{SessionStart:[],PreModelSwitch:[{hooks:[{type:'command',command:'test "$CODEX_BATON_HOOK_EVENT" = PreModelSwitch',timeout:5}]}]}};
  writeFileSync(file,JSON.stringify(contents));
  const loaded = loadPreModelSwitchHooks(subdir,[root]);
  assert.equal((await runPreModelSwitchHooks(loaded,{...event,cwd:subdir})).allowed,true);
  writeFileSync(file,'{');
  assert.throws(() => loadPreModelSwitchHooks(subdir,[root]), /hooks.json/);
  writeFileSync(file,JSON.stringify({hooks:{SessionStart:[]}}));
  assert.deepEqual(loadPreModelSwitchHooks(subdir,[root]),[]);
  assert.deepEqual(loadPreModelSwitchHooks(parent,[root]),[]);
});

test("hookへ切替情報をstdinで渡し、設定順に実行する", async () => {
  const validateInput = `let input="";process.stdin.on("data",c=>input+=c);process.stdin.on("end",()=>{const e=JSON.parse(input);if(e.event==="PreModelSwitch"&&e.from.model==="old-model"&&e.to.model==="new-model")process.exit(0);process.stderr.write("bad input");process.exit(2);});`;
  const result = await runPreModelSwitchHooks([
    { type: "command", command: process.execPath, args: ["-e", validateInput], timeout: 5 },
    { type: "command", command: process.execPath, args: ["-e", "process.exit(0)"], timeout: 5 },
  ], event);
  assert.deepEqual(result, { allowed: true, reasonCode: "allowed", hookCount: 2 });
});

test("exit 2の理由を返し、拒否後のhookを起動しない", async () => {
  const result = await runPreModelSwitchHooks([
    { type: "command", command: process.execPath, args: ["-e", "process.exit(0)"], timeout: 5 },
    { type: "command", command: process.execPath, args: ["-e", "process.stderr.write('repository policy denied');process.exit(2)"], timeout: 5 },
    { type: "command", command: "/path/that/must/not/run", args: [], timeout: 5 },
  ], event);
  assert.deepEqual(result, { allowed: false, reason: "repository policy denied", reasonCode: "denied", hookIndex: 1 });
});

test("hookの異常終了と時間切れをfail-closedにする", async () => {
  const failed = await runPreModelSwitchHooks([
    { type: "command", command: process.execPath, args: ["-e", "process.stderr.write('broken');process.exit(3)"], timeout: 5 },
  ], event);
  assert.equal(failed.allowed, false);
  assert.match(failed.reason, /exit code 3.*broken/);

  const timedOut = await runPreModelSwitchHooks([
    { type: "command", command: process.execPath, args: ["-e", "setTimeout(()=>{},5000)"], timeout: 1 },
  ], event);
  assert.deepEqual(timedOut, { allowed: false, reason: "PreModelSwitch hook timed out after 1 seconds.", reasonCode: "timeout", hookIndex: 0 });
});

test("hook待機を中止すると実行中プロセスも終了する", async () => {
  const controller = new AbortController();
  const pending = runPreModelSwitchHooks([
    { type: "command", command: process.execPath, args: ["-e", "setTimeout(()=>{},5000)"], timeout: 5 },
  ], event, { signal: controller.signal });
  controller.abort();
  assert.deepEqual(await pending,
    { allowed: false, reason: "PreModelSwitch hook was cancelled.", reasonCode: "cancelled", hookIndex: 0 });
});
