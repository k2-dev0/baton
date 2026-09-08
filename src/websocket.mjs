import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { PassThrough, Writable } from "node:stream";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// サーバーから送る非マスクWebSocketフレームを組み立てる。
function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (body.length <= 125) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, body]);
}

// UTF-8として不正なテキストフレームをプロトコルエラーにする。
function decodeUtf8(payload) {
  return new TextDecoder("utf-8", { fatal: true }).decode(payload);
}

// マスク、分割、制御フレームを処理してテキストメッセージだけを上位へ渡す。
export class WebSocketFrameDecoder {
  constructor({ maxPayloadBytes, onText, onPing, onClose, onError }) {
    this.maxPayloadBytes = maxPayloadBytes;
    this.onText = onText;
    this.onPing = onPing;
    this.onClose = onClose;
    this.onError = onError;
    this.buffer = Buffer.alloc(0);
    this.fragmentChunks = [];
    this.fragmentBytes = 0;
    this.fragmentOpcode = null;
    this.ended = false;
  }

  push(chunk) {
    if (this.ended || chunk.length === 0) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      this.#drain();
    } catch (error) {
      this.ended = true;
      this.onError(error);
    }
  }

  #drain() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const final = Boolean(first & 0x80);
      const opcode = first & 0x0f;
      if (first & 0x70) throw new Error("WebSocket RSV bits are not supported");
      if (!(second & 0x80)) throw new Error("WebSocket client frames must be masked");

      let payloadLength = second & 0x7f;
      let headerLength = 2;
      if (payloadLength === 126) {
        if (this.buffer.length < 4) return;
        payloadLength = this.buffer.readUInt16BE(2);
        headerLength = 4;
      } else if (payloadLength === 127) {
        if (this.buffer.length < 10) return;
        const length = this.buffer.readBigUInt64BE(2);
        if (length > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("WebSocket frame is too large");
        payloadLength = Number(length);
        headerLength = 10;
      }

      const controlFrame = opcode >= 0x08;
      if (controlFrame && (!final || payloadLength > 125)) {
        throw new Error("WebSocket control frame is invalid");
      }
      if (payloadLength > this.maxPayloadBytes) {
        throw new Error(`WebSocket frame exceeds ${this.maxPayloadBytes} bytes`);
      }

      const frameLength = headerLength + 4 + payloadLength;
      if (this.buffer.length < frameLength) return;
      const mask = this.buffer.subarray(headerLength, headerLength + 4);
      const payload = Buffer.from(this.buffer.subarray(headerLength + 4, frameLength));
      this.buffer = this.buffer.subarray(frameLength);
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
      this.#handleFrame({ final, opcode, payload });
      if (this.ended) return;
    }
  }

  #handleFrame({ final, opcode, payload }) {
    if (opcode === 0x08) {
      if (payload.length === 1) throw new Error("WebSocket close frame is invalid");
      this.ended = true;
      this.onClose(payload);
      return;
    }
    if (opcode === 0x09) {
      this.onPing(payload);
      return;
    }
    if (opcode === 0x0a) return;
    if (opcode === 0x02) throw new Error("WebSocket binary messages are not supported");

    if (opcode === 0x01) {
      if (this.fragmentOpcode !== null) throw new Error("WebSocket fragments overlap");
      if (final) {
        this.onText(decodeUtf8(payload));
        return;
      }
      this.fragmentOpcode = opcode;
      this.fragmentChunks = [payload];
      this.fragmentBytes = payload.length;
      return;
    }

    if (opcode !== 0x00 || this.fragmentOpcode === null) {
      throw new Error("WebSocket opcode is not supported");
    }
    this.fragmentBytes += payload.length;
    if (this.fragmentBytes > this.maxPayloadBytes) {
      throw new Error(`WebSocket message exceeds ${this.maxPayloadBytes} bytes`);
    }
    this.fragmentChunks.push(payload);
    if (!final) return;

    const message = Buffer.concat(this.fragmentChunks, this.fragmentBytes);
    this.fragmentChunks = [];
    this.fragmentBytes = 0;
    this.fragmentOpcode = null;
    this.onText(decodeUtf8(message));
  }
}

// 改行区切りJSONをWebSocketテキストフレームへ変換する書込みストリームを作る。
function createFrameWritable(socket, maxPayloadBytes) {
  let buffered = Buffer.alloc(0);
  return new Writable({
    write(chunk, _encoding, callback) {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > maxPayloadBytes) {
        callback(new Error(`WebSocket output exceeds ${maxPayloadBytes} buffered bytes`));
        return;
      }

      const frames = [];
      let newline;
      while ((newline = buffered.indexOf(0x0a)) !== -1) {
        let line = buffered.subarray(0, newline);
        buffered = buffered.subarray(newline + 1);
        if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
        if (line.length > maxPayloadBytes) {
          callback(new Error(`WebSocket message exceeds ${maxPayloadBytes} bytes`));
          return;
        }
        frames.push(encodeFrame(0x01, line));
      }

      if (frames.length === 0) {
        callback();
        return;
      }
      socket.write(Buffer.concat(frames), callback);
    },
  });
}

// Upgrade済みsocketを既存stdioルーターが扱える入出力ストリームへ変換する。
function createLineTransport(socket, head, maxPayloadBytes, onEvent) {
  const readable = new PassThrough();
  const writable = createFrameWritable(socket, maxPayloadBytes);
  let closed = false;

  const close = (payload = Buffer.alloc(0), source = "server") => {
    if (closed) return;
    closed = true;
    // close理由の自由文には利用者のデータが混ざり得るため、コードと発生元だけ残す。
    onEvent("websocket-closed", { source, code: payload.length >= 2 ? payload.readUInt16BE(0) : null });
    if (!socket.destroyed) {
      socket.end(encodeFrame(0x08, payload));
    }
    readable.end();
  };

  const fail = (error) => {
    if (closed) return;
    closed = true;
    onEvent("websocket-error", { code: typeof error.code === "string" ? error.code : null });
    const reason = Buffer.from(error.message, "utf8").subarray(0, 123);
    const payload = Buffer.alloc(2 + reason.length);
    payload.writeUInt16BE(1002, 0);
    reason.copy(payload, 2);
    if (!socket.destroyed) socket.end(encodeFrame(0x08, payload));
    readable.destroy(error);
    writable.destroy(error);
  };

  const decoder = new WebSocketFrameDecoder({
    maxPayloadBytes,
    onText(message) {
      readable.write(`${message}\n`);
    },
    onPing(payload) {
      if (!socket.destroyed) socket.write(encodeFrame(0x0a, payload));
    },
    onClose(payload) {
      close(payload, "client-close-frame");
    },
    onError: fail,
  });

  socket.on("data", (chunk) => decoder.push(chunk));
  socket.on("end", () => close(undefined, "socket-end"));
  socket.on("close", () => close(undefined, "socket-close"));
  socket.on("error", fail);
  writable.on("error", fail);
  if (head.length > 0) decoder.push(head);
  return { readable, writable, close };
}

// 不正なUpgrade要求を通常HTTP応答で閉じる。
function rejectUpgrade(socket, status, message) {
  const body = Buffer.from(`${message}\n`, "utf8");
  socket.end(
    `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
  );
}

// Unix socket上のローカルCLI一接続だけを受けるWebSocketサーバーを起動する。
export function createUnixWebSocketLineServer({ socketPath, maxPayloadBytes, onConnection, onEvent = () => {} }) {
  let accepted = false;
  const server = createServer((_request, response) => {
    response.writeHead(404).end();
  });

  server.on("upgrade", (request, socket, head) => {
    if (accepted) {
      rejectUpgrade(socket, "503 Service Unavailable", "router already has a client");
      return;
    }
    const key = request.headers["sec-websocket-key"];
    const connection = request.headers.connection ?? "";
    if (
      request.headers.upgrade?.toLowerCase() !== "websocket" ||
      !connection.toLowerCase().split(/\s*,\s*/u).includes("upgrade") ||
      request.headers["sec-websocket-version"] !== "13" ||
      typeof key !== "string" ||
      Buffer.from(key, "base64").length !== 16
    ) {
      rejectUpgrade(socket, "400 Bad Request", "invalid WebSocket upgrade");
      return;
    }

    accepted = true;
    onEvent("websocket-connected", {});
    const accept = createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const transport = createLineTransport(socket, head, maxPayloadBytes, onEvent);
    try {
      onConnection(transport);
    } catch (error) {
      transport.close();
      server.close();
      throw error;
    }
  });

  server.listen(socketPath);
  return server;
}
