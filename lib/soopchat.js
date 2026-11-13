/*
 * SOOP 채팅 연결 → 별풍선 후원 기록
 *  - 등록된 SOOP 방송국이 방송 중이면 그 방송 채팅방에 (로그인 없이 구경꾼으로) 접속
 *  - 별풍선(채팅 서비스 코드 18)이 오면 donations 에 저장
 *  - 방송이 끝나면 연결을 닫음. 끊기면 방송 중인 동안 다시 접속
 *  ※ 애드벌룬 · 영상풍선 등은 아직 기록하지 않음 (별풍선만)
 */
const { db } = require("./db");
const ws = require("./wsclient");

const F = "\x0c";
const pkt = (svc, body) => "\x1b\t" + String(svc).padStart(4, "0") + String(Buffer.byteLength(body)).padStart(6, "0") + "00" + body;
const LOGIN = pkt(1, `${F}${F}${F}16${F}`);
const D = "\x06";
const LOG = ["set_bps", "8000", "view_bps", "1000", "quality", "normal", "uuid", "", "geo_cc", "KR", "geo_rc", "11", "acpt_lang", "ko_KR",
  "svc_lang", "ko_KR", "subscribe", "0", "lowlatency", "0", "mode", "landing"].reduce((a, v, i) => a + (i % 2 ? `${D}=${D}${v}` : `${D}&${D}${v}`), "");
const join = (chatNo) => pkt(2, `${F}${chatNo}${F}${F}0${F}${F}log\x11${LOG}\x12pwd\x11\x12auth_info\x11NULL\x12pver\x112\x12access_system\x11html5\x12${F}`);
const PING = pkt(0, F);
const SVC_BALLOON = 18;

const insert = db.prepare("INSERT INTO donations (platform, channel_id, broad_id, donor_id, donor_nick, amount, kind, at) VALUES ('soop', ?, ?, ?, ?, ?, 'balloon', ?)");

// 방송국 아이디 → { broadNo, conn, ping, retry }
const rooms = new Map();

async function chatInfo(id) {
  const r = await fetch("https://live.sooplive.co.kr/afreeca/player_live_api.php", {
    method: "POST",
    headers: { "User-Agent": "Mozilla/5.0", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ bid: id, type: "live", pwd: "", player_type: "html5", stream_type: "common", quality: "HD", mode: "landing", from_api: "0" }),
    signal: AbortSignal.timeout(10000),
  });
  const ch = (await r.json())?.CHANNEL;
  if (!ch || Number(ch.RESULT) !== 1 || !ch.CHDOMAIN) throw new Error("채팅 정보 없음 (비밀번호 방송 · 연령 제한일 수 있음)");
  return { url: `wss://${ch.CHDOMAIN.toLowerCase()}:${Number(ch.CHPT) + 1}/Websocket/${ch.BJID}`, chatNo: ch.CHATNO, broadNo: String(ch.BNO) };
}

function onPacket(id, room, buf) {
  const s = buf.toString("utf8");
  const svc = Number(s.slice(2, 6));
  if (svc === 1 && !room.joined) { room.joined = true; room.conn.send(join(room.chatNo)); return; }
  if (svc !== SVC_BALLOON) return;
  // ["", 받은 방송국, 보낸 아이디, 보낸 닉네임, 개수, ...]
  const f = s.slice(14).split(F);
  const to = String(f[1] || "").toLowerCase();
  const donor = String(f[2] || "").replace(/\(\d+\)$/, "");
  const amount = Number(f[4]);
  if (to !== id || !donor || !(amount > 0)) return;
  insert.run(id, room.broadNo, donor, String(f[3] || ""), amount, Date.now());
}

async function open(id, broadNo) {
  const room = { broadNo, joined: false, closing: false };
  rooms.set(id, room);
  try {
    const info = await chatInfo(id);
    if (room.closing) return;
    room.chatNo = info.chatNo;
    room.broadNo = info.broadNo || broadNo;
    room.conn = ws.connect(info.url, { protocol: "chat", headers: { Origin: "https://play.sooplive.co.kr" } });
    room.conn.on("open", () => room.conn.send(LOGIN));
    room.conn.on("message", (b) => { try { onPacket(id, room, b); } catch (e) { console.error(`[soopchat:${id}]`, e.message); } });
    room.conn.on("error", (e) => console.error(`[soopchat:${id}]`, e.message));
    room.conn.on("close", () => {
      clearInterval(room.ping);
      if (room.closing || rooms.get(id) !== room) return;
      // 끊기면 30초 뒤 다시 (그 사이 방송이 끝나면 sync 가 정리)
      rooms.delete(id);
      room.retry = setTimeout(() => { if (!rooms.has(id) && wanted.get(id)) open(id, wanted.get(id)); }, 30 * 1000);
    });
    room.ping = setInterval(() => room.conn.isOpen() && room.conn.send(PING), 60 * 1000);
  } catch (e) {
    console.error(`[soopchat:${id}]`, e.message);
    if (rooms.get(id) === room) rooms.delete(id); // 다음 확인 때 다시 시도
  }
}

function close(id) {
  const room = rooms.get(id);
  if (!room) return;
  room.closing = true;
  clearInterval(room.ping);
  clearTimeout(room.retry);
  room.conn?.close();
  rooms.delete(id);
}

// soop.js 가 1분마다 방송 상태를 확인할 때 부름
const wanted = new Map(); // 방송 중인 방송국 → 방송 번호
function sync(id, broadNo) {
  if (process.env.SOOP_CHAT === "0") return; // 끄기: .env 에 SOOP_CHAT=0
  if (broadNo) {
    wanted.set(id, broadNo);
    const room = rooms.get(id);
    if (room && room.broadNo !== broadNo) close(id); // 새 방송
    if (!rooms.has(id)) open(id, broadNo);
  } else {
    wanted.delete(id);
    close(id);
  }
}

// 등록이 지워진 방송국은 연결 정리
function prune(ids) {
  const keep = new Set(ids);
  for (const id of [...rooms.keys(), ...wanted.keys()]) if (!keep.has(id)) { wanted.delete(id); close(id); }
}

const status = () => [...rooms].map(([id, r]) => ({ id, broad_no: r.broadNo, connected: !!r.conn?.isOpen() }));

module.exports = { sync, prune, status };
