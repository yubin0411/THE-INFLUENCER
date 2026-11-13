/*
 * 아주 작은 WebSocket 클라이언트 (추가 설치 없이 node:tls 로 직접)
 *  - SOOP 채팅 서버는 Node 내장 WebSocket 으로 접속이 안 돼서 직접 구현
 *  - 텍스트/바이너리 보내기, 받기, ping 응답, 닫기만 지원
 */
const tls = require("node:tls");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");

function connect(url, { protocol, headers = {}, timeout = 15000 } = {}) {
  const u = new URL(url);
  const ev = new EventEmitter();
  const key = crypto.randomBytes(16).toString("base64");
  const sock = tls.connect({ host: u.hostname, port: Number(u.port || 443), servername: u.hostname });
  let buf = Buffer.alloc(0);
  let open = false, closed = false;
  const timer = setTimeout(() => fail(new Error("접속 시간 초과")), timeout);

  function fail(err) {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    sock.destroy();
    if (!open) ev.emit("error", err);
    ev.emit("close", err?.message || "");
  }

  sock.on("secureConnect", () => {
    const lines = [
      `GET ${u.pathname}${u.search} HTTP/1.1`, `Host: ${u.host}`, "Connection: Upgrade", "Upgrade: websocket",
      "Sec-WebSocket-Version: 13", `Sec-WebSocket-Key: ${key}`,
      ...(protocol ? [`Sec-WebSocket-Protocol: ${protocol}`] : []),
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    ];
    sock.write(lines.join("\r\n") + "\r\n\r\n");
  });

  sock.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (!open) {
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = buf.subarray(0, end).toString();
      buf = buf.subarray(end + 4);
      if (!/^HTTP\/1\.1 101/.test(head)) return fail(new Error(head.split("\r\n")[0]));
      open = true;
      clearTimeout(timer);
      ev.emit("open");
    }
    // 프레임 읽기 (서버 → 클라이언트는 마스크 없음)
    while (buf.length >= 2) {
      const op = buf[0] & 0x0f;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) return;
      const data = buf.subarray(off, off + len);
      buf = buf.subarray(off + len);
      if (op === 0x8) return fail(null);
      if (op === 0x9) send(data, 0xa); // ping → pong
      else if (op === 0x1 || op === 0x2 || op === 0x0) ev.emit("message", Buffer.from(data));
    }
  });
  sock.on("error", fail);
  sock.on("close", () => fail(null));

  // 클라이언트 → 서버는 마스크 필수
  function send(data, op = 0x2) {
    if (closed) return;
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    const mask = crypto.randomBytes(4);
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0x80 | op, 0x80 | n])
      : n < 65536 ? Buffer.from([0x80 | op, 0x80 | 126, n >> 8, n & 0xff])
      : Buffer.concat([Buffer.from([0x80 | op, 0x80 | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
    const body = Buffer.alloc(n);
    for (let i = 0; i < n; i++) body[i] = payload[i] ^ mask[i & 3];
    sock.write(Buffer.concat([head, mask, body]));
  }

  ev.send = (data) => send(data, 0x2);
  ev.close = () => { if (!closed) { try { send(Buffer.alloc(0), 0x8); } catch {} } fail(null); };
  ev.isOpen = () => open && !closed;
  return ev;
}

module.exports = { connect };
