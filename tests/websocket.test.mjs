import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { createUnixWebSocketLineServer, WebSocketFrameDecoder } from "../src/websocket.mjs";

// CLIクライアントと同じマスク付きWebSocketフレームをテスト用に組み立てる。
function maskedFrame(payload, { final = true, opcode = 0x01 } = {}) {
  const body = Buffer.from(payload);
  assert.ok(body.length <= 125, "test frame must use the short payload format");
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const masked = Buffer.from(body);
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4];
  return Buffer.concat([
    Buffer.from([(final ? 0x80 : 0x00) | opcode, 0x80 | body.length]),
    mask,
    masked,
  ]);
}

test("分割されたWebSocketテキストフレームをCLI入力へ復元する", () => {
  const messages = [];
  const errors = [];
  const decoder = new WebSocketFrameDecoder({
    maxPayloadBytes: 1024,
    onText: (message) => messages.push(message),
    onPing() {},
    onClose() {},
    onError: (error) => errors.push(error),
  });
  const first = maskedFrame('{"method":"turn/', { final: false });
  const second = maskedFrame('start"}', { opcode: 0x00 });
  decoder.push(first.subarray(0, 3));
  decoder.push(Buffer.concat([first.subarray(3), second]));

  assert.deepEqual(messages, ['{"method":"turn/start"}']);
  assert.deepEqual(errors, []);
});

test("マスクされていないWebSocketクライアント入力を拒否する", () => {
  const errors = [];
  const decoder = new WebSocketFrameDecoder({
    maxPayloadBytes: 1024,
    onText() {},
    onPing() {},
    onClose() {},
    onError: (error) => errors.push(error),
  });
  decoder.push(Buffer.from([0x81, 0x02, 0x7b, 0x7d]));
  assert.match(errors[0].message, /must be masked/);
});

test.each(["close-frame", "eof", "server"])("Unix WebSocketの終了元を一度だけ記録し、入力も閉じる: %s", async (ending) => {
  const socketPath = path.join(mkdtempSync(path.join(tmpdir(), "baton-ws-")), "s");
  const events = [];
  let transport;
  let ready;
  const connected = new Promise(resolve => { ready = resolve; });
  const server = createUnixWebSocketLineServer({ socketPath, maxPayloadBytes: 4096,
    onEvent: (event, fields) => events.push({ event, ...fields }),
    onConnection(value) { transport = value; transport.readable.resume(); ready(); },
  });
  await once(server, "listening");
  const socket = connect({ path: socketPath, allowHalfOpen: true });
  socket.on("data", () => {});
  try {
    await once(socket, "connect");
    socket.write("GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
    await connected;
    const ended = once(transport.readable, "end");
    if (ending === "close-frame") {
      const payload = Buffer.concat([Buffer.from([3, 232]), Buffer.from("SECRET_CLOSE_REASON")]);
      socket.write(maskedFrame(payload, { opcode: 8 }));
    } else if (ending === "eof") socket.end();
    else transport.close();
    await ended;
    assert.deepEqual(events, [
      { event: "websocket-connected" },
      { event: "websocket-closed", source: { "close-frame": "client-close-frame", eof: "socket-end", server: "server" }[ending], code: ending === "close-frame" ? 1000 : null },
    ]);
    assert.ok(!JSON.stringify(events).includes("SECRET"));
  } finally {
    socket.destroy();
    transport?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
