/*
 * (주) 이터널 서버
 *   실행: node server.js   (기본 http://localhost:8000)
 *   설정: .env  →  YOUTUBE_API_KEY, ADMIN_ID, ADMIN_PASSWORD, (선택) PORT
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { DatabaseSync } = require("node:sqlite");

loadEnv();

const { db, tx, DATA_DIR, linkMembers } = require("./lib/db");
const auth = require("./lib/auth");
const youtube = require("./lib/youtube");
const soop = require("./lib/soop");
const broadcasts = require("./lib/broadcasts");
const sheet = require("./lib/sheet");

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8000;
const PUBLIC = new Set(["index.html", "admin.html", "css", "js", "assets"]);

function loadEnv() {
  try {
    for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([\w.]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
}

/* ---------- 공통 ---------- */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req, limit = 8 * 1024 * 1024) {
  // JSON 요청만 받음 → 다른 사이트의 폼 제출(CSRF) 차단
  if (!String(req.headers["content-type"] || "").startsWith("application/json")) fail(415, "JSON 요청만 허용됩니다.");
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) fail(413, "요청이 너무 큽니다.");
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { fail(400, "잘못된 요청입니다."); }
}

const str = (v, max = 200) => String(v ?? "").trim().slice(0, max);
const requireUser = (req) => auth.currentUser(req) || fail(401, "로그인이 필요합니다.");
const requireAdmin = (req) => {
  const u = requireUser(req);
  if (u.role !== "admin") fail(403, "관리자만 사용할 수 있습니다.");
  return u;
};

// 로그인 시도 제한 (IP당 10분에 10회)
const attempts = new Map();
function throttle(req) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress;
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (list.length >= 10) fail(429, "시도가 너무 많습니다. 잠시 후 다시 시도하세요.");
  list.push(now);
  attempts.set(ip, list);
}

const videoFields = `v.id, v.type, v.live, v.title, v.thumb, v.published_at, v.duration, v.views, v.viewers,
  c.id AS channel_id, COALESCE(mb.name, c.title) AS member, mb.id AS member_id, mb.crew_id AS crew`;
const videoFrom = "videos v JOIN channels c ON c.id = v.channel_id LEFT JOIN members mb ON mb.id = c.member_id";

/* ---------- 라우트 ---------- */
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
  routes.push({ method, re, keys, handler });
};

// 사이트 기본 정보
route("GET", "/api/site", (req) => ({
  crews: db.prepare("SELECT id, name FROM crews ORDER BY sort, name").all(),
  members: publicMembers(),
  user: auth.currentUser(req),
}));

// 멤버 (유튜브 · SOOP · 인스타 · 프로필 · 공약 · 대표 시그)
function publicMembers() {
  const live = new Map(broadcasts.members().map((m) => [m.id, m]));
  const channels = db.prepare("SELECT id, handle, member_id FROM channels ORDER BY created_at").all();
  const soops = db.prepare("SELECT id, member_id FROM soop_channels ORDER BY created_at").all();
  return db.prepare("SELECT * FROM members ORDER BY sort, name").all().map((r) => {
    const m = live.get(String(r.id));
    return {
      id: String(r.id), name: r.name, crew: r.crew_id, role_title: r.role_title, quote: r.quote,
      thumb: m.thumb, photo: broadcasts.photoUrl(r.photo), handle: m.handle, youtube: m.youtube, soop: m.soop,
      youtubes: channels.filter((c) => c.member_id === r.id).map((c) => ({ id: c.id, handle: c.handle })),
      soops: soops.filter((c) => c.member_id === r.id).map((c) => c.id),
      instagram: r.instagram, kakao: r.kakao, profile_text: r.profile_text,
      promise_text: r.promise_text, promise_image: broadcasts.photoUrl(r.promise_image),
      sig_ids: JSON.parse(r.sig_ids || "[]"),
      is_live: m.is_live, yt_live: m.yt_live, soop_live: m.soop_live,
    };
  });
}

// 라이브 (등록된 유튜브 채널 + SOOP 방송국)
route("GET", "/api/live", () => {
  const yt = db.prepare(`SELECT ${videoFields} FROM ${videoFrom} WHERE v.live = 'live'`).all()
    .map((v) => ({ ...v, platform: "youtube", url: `https://www.youtube.com/watch?v=${v.id}` }));
  const sp = broadcasts.members().filter((m) => m.soop_live).map((m) => ({
    id: `soop-${m.soop_broad}`, platform: "soop", title: m.soop_title || `${m.name} 방송 중`,
    thumb: `https://liveimg.sooplive.co.kr/m/${m.soop_broad}`, viewers: m.soop_viewers,
    channel_id: m.id, member: m.name, crew: m.crew, url: `https://play.sooplive.co.kr/${m.soop_station}/${m.soop_broad}`,
  }));
  return { live: [...yt, ...sp].sort((a, b) => b.viewers - a.viewers) };
});

// 방송 시간 순위 (달별, 기본 이번 달)
route("GET", "/api/ranking", (req, _p, url) => {
  const month = url.searchParams.get("month");
  return { ...broadcasts.monthStats(broadcasts.isMonth(month) ? month : undefined), months: broadcasts.months() };
});
// 한 멤버의 그 달 방송 목록
route("GET", "/api/ranking/sessions", (req, _p, url) => {
  const month = url.searchParams.get("month");
  return { items: broadcasts.sessions(str(url.searchParams.get("member"), 80), broadcasts.isMonth(month) ? month : undefined) };
});

// 게시글/쇼츠 목록 (누적, 최신순, before 로 더 불러오기)
//   member=멤버ID  → 그 멤버의 영상만
//   latest=1       → 계정마다 가장 최근 영상 1개씩 (홈 화면용)
route("GET", "/api/videos", (req, _p, url) => {
  const type = url.searchParams.get("type") === "short" ? "short" : "post";
  const crew = url.searchParams.get("crew");
  const member = Number(url.searchParams.get("member")) || null;
  const latest = url.searchParams.get("latest") === "1";
  const before = Number(url.searchParams.get("before")) || Number.MAX_SAFE_INTEGER;
  const limit = Math.min(Number(url.searchParams.get("limit")) || 20, 60);
  const where = ["v.type = ?", "v.live = 'none'"];
  const args = [type];
  if (crew) where.push("mb.crew_id = ?"), args.push(crew);
  if (member) where.push("c.member_id = ?"), args.push(member);
  const rows = latest
    ? db.prepare(`
        SELECT * FROM (
          SELECT ${videoFields}, ROW_NUMBER() OVER (PARTITION BY v.channel_id ORDER BY v.published_at DESC) AS rn
          FROM ${videoFrom} WHERE ${where.join(" AND ")}
        ) WHERE rn = 1 AND published_at < ? ORDER BY published_at DESC LIMIT ?
      `).all(...args, before, limit + 1)
    : db.prepare(`
        SELECT ${videoFields} FROM ${videoFrom}
        WHERE ${where.join(" AND ")} AND v.published_at < ?
        ORDER BY v.published_at DESC LIMIT ?
      `).all(...args, before, limit + 1);
  return { items: rows.slice(0, limit).map(({ rn, ...v }) => v), more: rows.length > limit };
});

// 자세히 보기
route("GET", "/api/videos/:id", (req, p) => {
  const v = db.prepare(`SELECT ${videoFields}, v.description, v.likes, c.title AS channel_title, c.thumb AS channel_thumb
    FROM ${videoFrom} WHERE v.id = ?`).get(p.id);
  return v || fail(404, "영상을 찾을 수 없습니다.");
});

// 회원가입 (승인코드 필요 → 관리자 승인 대기)
route("POST", "/api/auth/signup", async (req) => {
  throttle(req);
  const b = await readJson(req);
  const username = str(b.username, 30);
  const nickname = str(b.nickname, 30);
  const password = String(b.password || "");
  const code = str(b.code, 50);
  if (!/^[a-zA-Z0-9_]{4,30}$/.test(username)) fail(400, "아이디는 영문/숫자/_ 4~30자로 입력하세요.");
  if (password.length < 8) fail(400, "비밀번호는 8자 이상으로 입력하세요.");
  if (!nickname) fail(400, "닉네임을 입력하세요.");
  const c = db.prepare("SELECT * FROM codes WHERE code = ? AND active = 1").get(code);
  if (!c || (c.max_uses != null && c.uses >= c.max_uses)) fail(400, "승인코드가 올바르지 않습니다.");
  if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(username)) fail(409, "이미 사용 중인 아이디입니다.");
  db.prepare("INSERT INTO users (username, nickname, pw_hash, code, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(username, nickname, auth.hashPassword(password), code, Date.now());
  db.prepare("UPDATE codes SET uses = uses + 1 WHERE code = ?").run(code);
  return { ok: true, message: "가입 신청이 완료되었습니다. 관리자 승인 후 로그인할 수 있습니다." };
});

route("POST", "/api/auth/login", async (req, _p, _u, res) => {
  throttle(req);
  const b = await readJson(req);
  const u = db.prepare("SELECT * FROM users WHERE username = ?").get(str(b.username, 30));
  if (!u || !auth.verifyPassword(String(b.password || ""), u.pw_hash)) fail(401, "아이디 또는 비밀번호가 올바르지 않습니다.");
  if (u.status === "pending") fail(403, "관리자 승인 대기 중입니다.");
  if (u.status !== "approved") fail(403, "가입이 거절된 계정입니다.");
  auth.createSession(res, req, u.id);
  return { user: { id: u.id, username: u.username, nickname: u.nickname, role: u.role } };
});

route("POST", "/api/auth/logout", (req, _p, _u, res) => {
  auth.destroySession(res, req);
  return { ok: true };
});

route("POST", "/api/auth/password", async (req) => {
  const user = requireUser(req);
  const b = await readJson(req);
  const row = db.prepare("SELECT pw_hash FROM users WHERE id = ?").get(user.id);
  if (!auth.verifyPassword(String(b.current || ""), row.pw_hash)) fail(400, "현재 비밀번호가 올바르지 않습니다.");
  if (String(b.next || "").length < 8) fail(400, "새 비밀번호는 8자 이상으로 입력하세요.");
  db.prepare("UPDATE users SET pw_hash = ? WHERE id = ?").run(auth.hashPassword(String(b.next)), user.id);
  return { ok: true };
});

// 추천 노래 / 백월 요청 (승인된 회원만)
route("POST", "/api/requests", async (req) => {
  const user = requireUser(req);
  const b = await readJson(req);
  const type = b.type === "backwall" ? "backwall" : "recommend";
  const data = type === "backwall"
    ? { member: str(b.member, 50), content: str(b.content, 2000) }
    : { song: str(b.song), artist: str(b.artist), url: str(b.url, 500), memo: str(b.memo, 2000) };
  if (type === "backwall" ? !data.content : !data.song) fail(400, "필수 항목을 입력하세요.");

  let image = null;
  const m = typeof b.image === "string" && b.image.match(/^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/);
  if (m) {
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > 5 * 1024 * 1024) fail(413, "사진은 5MB 이하만 올릴 수 있습니다.");
    image = `${crypto.randomBytes(12).toString("hex")}.${m[1].replace("jpeg", "jpg")}`;
    fs.writeFileSync(path.join(DATA_DIR, "uploads", image), buf);
  }
  db.prepare("INSERT INTO requests (type, user_id, data, image, created_at) VALUES (?, ?, ?, ?, ?)").run(type, user.id, JSON.stringify(data), image, Date.now());
  return { ok: true, message: "요청이 접수되었습니다." };
});

/* ---------- 관리자 ---------- */
route("GET", "/api/admin/users", (req) => {
  requireAdmin(req);
  return db.prepare("SELECT id, username, nickname, role, status, code, created_at FROM users ORDER BY status = 'pending' DESC, created_at DESC").all();
});

route("POST", "/api/admin/users/:id", async (req, p) => {
  const me = requireAdmin(req);
  const b = await readJson(req);
  const id = Number(p.id);
  if (id === me.id) fail(400, "본인 계정은 변경할 수 없습니다.");
  if (b.action === "delete") {
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
  } else if (["approved", "rejected", "pending"].includes(b.status)) {
    db.prepare("UPDATE users SET status = ? WHERE id = ?").run(b.status, id);
    if (b.status !== "approved") db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
  } else if (["admin", "member"].includes(b.role)) {
    db.prepare("UPDATE users SET role = ? WHERE id = ?").run(b.role, id);
  } else fail(400, "잘못된 요청입니다.");
  return { ok: true };
});

route("GET", "/api/admin/codes", (req) => {
  requireAdmin(req);
  return db.prepare("SELECT * FROM codes ORDER BY created_at DESC").all();
});

route("POST", "/api/admin/codes", async (req) => {
  requireAdmin(req);
  const b = await readJson(req);
  const code = str(b.code, 50) || crypto.randomBytes(4).toString("hex").toUpperCase();
  if (!/^[\w-]+$/.test(code)) fail(400, "코드는 영문/숫자/_/- 만 가능합니다.");
  const maxUses = b.max_uses === "" || b.max_uses == null ? null : Math.max(1, Number(b.max_uses) || 1);
  if (db.prepare("SELECT 1 FROM codes WHERE code = ?").get(code)) fail(409, "이미 있는 코드입니다.");
  db.prepare("INSERT INTO codes (code, memo, max_uses, created_at) VALUES (?, ?, ?, ?)").run(code, str(b.memo), maxUses, Date.now());
  return { ok: true, code };
});

route("POST", "/api/admin/codes/:code", async (req, p) => {
  requireAdmin(req);
  const b = await readJson(req);
  const code = decodeURIComponent(p.code);
  if (b.action === "delete") db.prepare("DELETE FROM codes WHERE code = ?").run(code);
  else db.prepare("UPDATE codes SET active = ? WHERE code = ?").run(b.active ? 1 : 0, code);
  return { ok: true };
});

route("GET", "/api/admin/crews", (req) => {
  requireAdmin(req);
  return db.prepare("SELECT id, name, sort FROM crews ORDER BY sort, name").all();
});

route("POST", "/api/admin/crews", async (req) => {
  requireAdmin(req);
  const b = await readJson(req);
  const name = str(b.name, 30) || fail(400, "크루 이름을 입력하세요.");
  const id = str(b.id, 30) || `crew-${crypto.randomBytes(3).toString("hex")}`;
  if (!/^[a-z0-9-]+$/.test(id)) fail(400, "크루 ID는 영문 소문자/숫자/- 만 가능합니다.");
  const sort = b.sort === undefined || b.sort === ""
    ? db.prepare("SELECT sort FROM crews WHERE id = ?").get(id)?.sort ?? (db.prepare("SELECT MAX(sort) AS m FROM crews").get().m ?? 0) + 1
    : Number(b.sort) || 0;
  db.prepare("INSERT INTO crews (id, name, sort) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, sort = excluded.sort")
    .run(id, name, sort);
  return { ok: true };
});

// 순서 변경: 바로 앞/뒤 크루와 자리 바꾸기
route("POST", "/api/admin/crews/:id/move", async (req, p) => {
  requireAdmin(req);
  const b = await readJson(req);
  const ids = db.prepare("SELECT id FROM crews ORDER BY sort, name").all().map((c) => c.id);
  const i = ids.indexOf(p.id);
  if (i < 0) fail(404, "크루를 찾을 수 없습니다.");
  const j = i + (Number(b.dir) < 0 ? -1 : 1);
  if (j < 0 || j >= ids.length) return { ok: true };
  [ids[i], ids[j]] = [ids[j], ids[i]];
  const set = db.prepare("UPDATE crews SET sort = ? WHERE id = ?");
  tx(() => ids.forEach((id, n) => set.run(n + 1, id)));
  return { ok: true };
});

route("POST", "/api/admin/crews/:id/delete", (req, p) => {
  requireAdmin(req);
  removeStored([
    ...sigStored("s.crew_id = ?", p.id),
    ...db.prepare("SELECT file FROM files WHERE crew_id = ?").all(p.id).map((r) => `files/${r.file}`),
  ]);
  db.prepare("DELETE FROM crews WHERE id = ?").run(p.id);
  return { ok: true };
});

/* 관리자: 멤버 (유튜브 채널 · SOOP 방송국 · 프로필 · 공약 · 대표 시그) */
const memberRow = (id) => db.prepare("SELECT * FROM members WHERE id = ?").get(Number(id)) || fail(404, "멤버를 찾을 수 없습니다.");
const linkUrl = (v) => {
  const u = str(v, 300);
  if (u && !/^https?:\/\//i.test(u)) fail(400, "링크는 https:// 로 시작하는 주소를 넣으세요.");
  return u;
};

route("GET", "/api/admin/members", (req) => {
  requireAdmin(req);
  const live = new Map(broadcasts.members().map((m) => [m.id, m]));
  const channels = db.prepare(`SELECT c.id, c.title, c.handle, c.thumb, c.member_id, c.synced_at,
    (SELECT COUNT(*) FROM videos v WHERE v.channel_id = c.id AND v.type = 'post') AS posts,
    (SELECT COUNT(*) FROM videos v WHERE v.channel_id = c.id AND v.type = 'short') AS shorts,
    EXISTS (SELECT 1 FROM videos v WHERE v.channel_id = c.id AND v.live = 'live') AS is_live
    FROM channels c ORDER BY c.created_at`).all();
  const soops = db.prepare("SELECT id, nick, thumb, member_id, live, title, checked_at FROM soop_channels ORDER BY created_at").all();
  return db.prepare("SELECT * FROM members ORDER BY sort, name").all().map((r) => ({
    ...r,
    sig_ids: JSON.parse(r.sig_ids || "[]"),
    photo_url: broadcasts.photoUrl(r.photo),
    promise_url: broadcasts.photoUrl(r.promise_image),
    thumb: live.get(String(r.id))?.thumb || null,
    is_live: !!live.get(String(r.id))?.is_live,
    youtubes: channels.filter((c) => c.member_id === r.id),
    soops: soops.filter((c) => c.member_id === r.id),
  }));
});

// 멤버 만들기 / 고치기 (id 가 있으면 수정)
route("POST", "/api/admin/members", async (req) => {
  requireAdmin(req);
  const b = await readJson(req);
  const name = str(b.name, 30) || fail(400, "멤버 이름을 입력하세요.");
  const crew = str(b.crew, 30) || null;
  if (crew && !db.prepare("SELECT 1 FROM crews WHERE id = ?").get(crew)) fail(400, "없는 크루입니다.");
  const sigIds = [...new Set((Array.isArray(b.sig_ids) ? b.sig_ids : []).map(Number).filter(Number.isInteger))].slice(0, 100);
  const vals = {
    name, crew_id: crew, role_title: str(b.role_title, 30), quote: str(b.quote, 100),
    instagram: linkUrl(b.instagram), kakao: linkUrl(b.kakao),
    profile_text: str(b.profile_text, 3000), promise_text: str(b.promise_text, 3000),
    sig_ids: JSON.stringify(sigIds), updated_at: Date.now(),
  };
  if (b.id) {
    memberRow(b.id);
    const sort = b.sort === "" || b.sort == null ? null : Number(b.sort) || 0;
    db.prepare(`UPDATE members SET name = :name, crew_id = :crew_id, role_title = :role_title, quote = :quote, instagram = :instagram,
      kakao = :kakao, profile_text = :profile_text, promise_text = :promise_text, sig_ids = :sig_ids, updated_at = :updated_at,
      sort = COALESCE(:sort, sort) WHERE id = :id`).run({ ...vals, sort, id: Number(b.id) });
    return { ok: true, id: Number(b.id) };
  }
  const sort = (db.prepare("SELECT MAX(sort) AS m FROM members").get().m ?? 0) + 1;
  const r = db.prepare(`INSERT INTO members (name, crew_id, role_title, quote, instagram, kakao, profile_text, promise_text, sig_ids, sort, created_at, updated_at)
    VALUES (:name, :crew_id, :role_title, :quote, :instagram, :kakao, :profile_text, :promise_text, :sig_ids, :sort, :updated_at, :updated_at)`).run({ ...vals, sort });
  return { ok: true, id: Number(r.lastInsertRowid) };
});

// 멤버 삭제: 연결된 유튜브 채널(영상 포함) · SOOP 방송국도 같이 지움. 방송 기록은 남음
route("POST", "/api/admin/members/:id/delete", (req, p) => {
  requireAdmin(req);
  const m = memberRow(p.id);
  removeStored([m.photo && `members/${m.photo}`, m.promise_image && `members/${m.promise_image}`]);
  tx(() => {
    db.prepare("DELETE FROM channels WHERE member_id = ?").run(m.id);
    db.prepare("DELETE FROM soop_channels WHERE member_id = ?").run(m.id);
    db.prepare("DELETE FROM members WHERE id = ?").run(m.id);
  });
  return { ok: true };
});

// 순서 변경: 바로 앞/뒤 멤버와 자리 바꾸기
route("POST", "/api/admin/members/:id/move", async (req, p) => {
  requireAdmin(req);
  const b = await readJson(req);
  const ids = db.prepare("SELECT id FROM members ORDER BY sort, name").all().map((r) => r.id);
  const i = ids.indexOf(Number(p.id));
  if (i < 0) fail(404, "멤버를 찾을 수 없습니다.");
  const j = i + (Number(b.dir) < 0 ? -1 : 1);
  if (j < 0 || j >= ids.length) return { ok: true };
  [ids[i], ids[j]] = [ids[j], ids[i]];
  const set = db.prepare("UPDATE members SET sort = ? WHERE id = ?");
  tx(() => ids.forEach((id, n) => set.run(n + 1, id)));
  return { ok: true };
});

// 프로필 사진 / 공약 이미지 올리기 (?kind=photo | promise), 지우기
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
route("POST", "/api/admin/members/:id/image", async (req, p, url) => {
  requireAdmin(req);
  const m = memberRow(p.id);
  const col = url.searchParams.get("kind") === "promise" ? "promise_image" : "photo";
  const up = await saveUpload(req, "members");
  if (!IMAGE_EXT.test(up.file) || up.size > 20 * 1024 * 1024) {
    removeStored([`members/${up.file}`]);
    fail(400, "이미지(jpg, png, gif, webp) 20MB 이하만 올릴 수 있습니다.");
  }
  removeStored([m[col] && `members/${m[col]}`]);
  db.prepare(`UPDATE members SET ${col} = ?, updated_at = ? WHERE id = ?`).run(up.file, Date.now(), m.id);
  return { ok: true };
});
route("POST", "/api/admin/members/:id/image/delete", async (req, p) => {
  requireAdmin(req);
  const m = memberRow(p.id);
  const b = await readJson(req);
  const col = b.kind === "promise" ? "promise_image" : "photo";
  removeStored([m[col] && `members/${m[col]}`]);
  db.prepare(`UPDATE members SET ${col} = NULL, updated_at = ? WHERE id = ?`).run(Date.now(), m.id);
  return { ok: true };
});

// 유튜브 채널 연결 (등록하면서 과거 영상도 가져옴)
route("POST", "/api/admin/members/:id/youtube", async (req, p) => {
  requireAdmin(req);
  if (!process.env.YOUTUBE_API_KEY) fail(503, "YOUTUBE_API_KEY 가 설정되지 않았습니다.");
  const m = memberRow(p.id);
  const b = await readJson(req);
  const ch = await youtube.resolveChannel(b.channel).catch((e) => fail(400, e.message));
  const owner = db.prepare("SELECT m.name FROM channels c LEFT JOIN members m ON m.id = c.member_id WHERE c.id = ?").get(ch.id);
  if (owner) fail(409, `이미 등록된 채널입니다: ${ch.title}${owner.name ? ` (${owner.name})` : ""}`);
  db.prepare("INSERT INTO channels (id, title, handle, thumb, name, crew_id, uploads, member_id, created_at) VALUES (?, ?, ?, ?, '', NULL, ?, ?, ?)")
    .run(ch.id, ch.title, ch.handle, ch.thumb, ch.uploads, m.id, Date.now());
  const count = await youtube.backfillChannel(ch);
  await youtube.quickPoll().catch(() => {});
  return { ok: true, message: `${ch.title} 연결 완료 (영상 ${count}개 가져옴)` };
});
route("POST", "/api/admin/channels/:id/delete", (req, p) => {
  requireAdmin(req);
  db.prepare("DELETE FROM channels WHERE id = ?").run(p.id);
  return { ok: true };
});

// SOOP 방송국 연결
route("POST", "/api/admin/members/:id/soop", async (req, p) => {
  requireAdmin(req);
  const m = memberRow(p.id);
  const b = await readJson(req);
  const st = await soop.resolve(b.soop).catch((e) => fail(400, e.message));
  const owner = db.prepare("SELECT m.name FROM soop_channels s LEFT JOIN members m ON m.id = s.member_id WHERE s.id = ?").get(st.id);
  if (owner) fail(409, `이미 등록된 방송국입니다: ${st.nick || st.id}${owner.name ? ` (${owner.name})` : ""}`);
  db.prepare("INSERT INTO soop_channels (id, nick, thumb, member_id, created_at) VALUES (?, ?, ?, ?, ?)").run(st.id, st.nick, st.thumb, m.id, Date.now());
  await soop.check(st.id).catch(() => {});
  return { ok: true, message: `${st.nick || st.id} 연결 완료${st.live ? " (지금 방송 중)" : ""}` };
});
route("POST", "/api/admin/soop/:id/delete", (req, p) => {
  requireAdmin(req);
  db.prepare("DELETE FROM soop_channels WHERE id = ?").run(p.id);
  return { ok: true };
});

route("POST", "/api/admin/sync", async (req) => {
  requireAdmin(req);
  await Promise.all([process.env.YOUTUBE_API_KEY ? youtube.quickPoll() : null, soop.poll()]);
  return { ok: true };
});

route("GET", "/api/admin/requests", (req) => {
  requireAdmin(req);
  return db.prepare(`SELECT r.*, u.username, u.nickname FROM requests r LEFT JOIN users u ON u.id = r.user_id ORDER BY r.created_at DESC LIMIT 300`).all()
    .map((r) => ({ ...r, data: JSON.parse(r.data) }));
});

route("POST", "/api/admin/requests/:id", async (req, p) => {
  requireAdmin(req);
  const b = await readJson(req);
  const r = db.prepare("SELECT image FROM requests WHERE id = ?").get(Number(p.id)) || fail(404, "없는 요청입니다.");
  if (b.action === "delete") {
    if (r.image) fs.rm(path.join(DATA_DIR, "uploads", r.image), () => {});
    db.prepare("DELETE FROM requests WHERE id = ?").run(Number(p.id));
  } else db.prepare("UPDATE requests SET is_read = ? WHERE id = ?").run(b.read ? 1 : 0, Number(p.id));
  return { ok: true };
});

/* ---------- 시그 · 레슨 영상 · 파일 ---------- */
const MAX_UPLOAD = 2 * 1024 * 1024 * 1024; // 2GB

// 올린 파일 지우기 (uploads/ 기준 경로 목록)
function removeStored(list) {
  for (const rel of list) if (rel) fs.rm(path.join(DATA_DIR, "uploads", rel), () => {});
}

// 파일 업로드: 요청 본문을 그대로 디스크에 저장 (X-Upload 헤더 필수 → 다른 사이트에서 못 보냄)
async function saveUpload(req, dir) {
  if (req.headers["x-upload"] !== "1") fail(415, "잘못된 업로드 요청입니다.");
  const orig = str(decodeURIComponent(req.headers["x-filename"] || ""), 200) || "file";
  const ext = (path.extname(orig).toLowerCase().match(/^\.[a-z0-9]{1,8}$/) || [""])[0];
  const name = `${crypto.randomBytes(12).toString("hex")}${ext}`;
  const dest = path.join(DATA_DIR, "uploads", dir, name);
  const out = fs.createWriteStream(dest);
  let size = 0;
  let crc = 0;
  try {
    for await (const c of req) {
      size += c.length;
      if (size > MAX_UPLOAD) fail(413, "파일은 2GB 이하만 올릴 수 있습니다.");
      crc = zlib.crc32(c, crc);
      if (!out.write(c)) await new Promise((r) => out.once("drain", r));
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  } catch (e) {
    out.destroy();
    fs.rm(dest, () => {});
    throw e;
  }
  if (!size) { fs.rm(dest, () => {}); fail(400, "빈 파일입니다."); }
  return { file: name, orig, size, crc };
}

// 시그에 딸린 파일 (레슨 영상 · 음원 · 시그 이미지) — 시그를 지울 때 같이 지움
function sigStored(where, ...args) {
  return [
    ...db.prepare(`SELECT l.file FROM lessons l JOIN sigs s ON s.id = l.sig_id WHERE ${where} AND l.file IS NOT NULL`).all(...args).map((r) => `lessons/${r.file}`),
    ...db.prepare(`SELECT s.image, s.audio FROM sigs s WHERE ${where}`).all(...args).flatMap((r) => [r.image && `sigs/${r.image}`, r.audio && `sigs/${r.audio}`]),
  ];
}

const ytId = (u) => String(u).match(/(?:youtu\.be\/|\/shorts\/|\/live\/|\/embed\/|[?&]v=)([\w-]{11})/)?.[1];
const driveId = (u) => String(u).match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?id=)([\w-]{10,})/)?.[1];
const lessonKind = (u) => (ytId(u) ? "youtube" : driveId(u) ? "drive" : "link");
const parsePrice = (v) => Number(String(v ?? "").replace(/[^\d]/g, "")) || 0;
// 레퍼런스 칸: 주소 여러 개 (띄어쓰기 · 줄바꿈 · 쉼표로 구분) → 줄바꿈으로 묶어 저장
const refUrls = (v) => [...new Set(String(v ?? "").split(/[\s,]+/).filter((u) => /^https?:\/\//i.test(u)).map((u) => u.slice(0, 500)))].slice(0, 10).join("\n");

// 레슨 칸 → 링크 / 파일 이름 목록 ("레몬에이드.mp4 레몬에이드 0.7.mp4" 처럼 여러 개도 분리)
function lessonTokens(text) {
  return [...String(text || "").matchAll(/https?:\/\/\S+|\S.*?\.(?:mp4|mov|m4v|webm|avi|mkv)(?=\s|$)/gi)].map((m) => m[0].trim());
}

const sigFields = `s.id, s.crew_id AS crew, s.category, s.name, s.price, s.ref_url, s.created_at,
  (SELECT COUNT(*) FROM lessons l WHERE l.sig_id = s.id AND l.kind != 'pending') AS lessons,
  (SELECT MAX(l.created_at) FROM lessons l WHERE l.sig_id = s.id AND l.kind != 'pending') AS last_lesson_at,
  CASE WHEN s.image IS NULL THEN NULL ELSE '/media/sigs/' || s.image END AS image_url,
  CASE WHEN s.audio IS NULL THEN NULL ELSE '/media/sigs/' || s.audio END AS audio_url,
  s.image_name, s.image_size, s.audio_name, s.audio_size`;

// 한 번에 받기: 크루(와 분류)의 음원 · 시그 이미지를 zip 하나로 (압축 없이 묶기만, 받으면서 바로 만듦)
const safeName = (v) => String(v || "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 80) || "시그";
function zipEntries(rows) {
  const used = new Set();
  const out = [];
  for (const r of rows) {
    for (const [kind, label] of [["audio", "음원"], ["image", "이미지"]]) {
      if (!r[kind]) continue;
      const ext = path.extname(r[kind]) || path.extname(r[`${kind}_name`] || "");
      let name = `${safeName(r.category || "기타")}/${safeName(r.name)} - ${label}`;
      for (let n = 2; used.has(name + ext); n++) name = `${safeName(r.category || "기타")}/${safeName(r.name)} (${n}) - ${label}`;
      used.add(name + ext);
      out.push({ name: name + ext, file: path.join(DATA_DIR, "uploads", "sigs", r[kind]), size: r[`${kind}_size`], crc: r[`${kind}_crc`] >>> 0 });
    }
  }
  return out;
}
async function sendZip(res, filename, entries) {
  entries = entries.filter((e) => fs.existsSync(e.file));
  const total = entries.reduce((n, e) => n + 30 + Buffer.byteLength(e.name) + e.size + 46 + Buffer.byteLength(e.name), 22);
  if (total > 0xffffffff) fail(413, "파일이 너무 많아 한 번에 받을 수 없습니다. 분류별로 받아 주세요.");
  res.writeHead(200, {
    "Content-Type": "application/zip", "Content-Length": total,
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
  });
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const central = [];
  let offset = 0;
  const write = (buf) => new Promise((resolve) => (res.write(buf) ? resolve() : res.once("drain", resolve)));
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(0, 8);
    h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12); h.writeUInt32LE(e.crc, 14);
    h.writeUInt32LE(e.size, 18); h.writeUInt32LE(e.size, 22); h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
    await write(Buffer.concat([h, name]));
    for await (const chunk of fs.createReadStream(e.file)) await write(chunk);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(0, 10);
    c.writeUInt16LE(time, 12); c.writeUInt16LE(date, 14); c.writeUInt32LE(e.crc, 16); c.writeUInt32LE(e.size, 20); c.writeUInt32LE(e.size, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([c, name]));
    offset += 30 + name.length + e.size;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  await write(Buffer.concat([cd, end]));
  res.end();
}

route("GET", "/api/sigs/download", async (req, _p, url, res) => {
  const crew = db.prepare("SELECT id, name FROM crews WHERE id = ?").get(url.searchParams.get("crew") || "") || fail(404, "크루를 찾을 수 없습니다.");
  const cat = str(url.searchParams.get("category"), 30);
  const rows = db.prepare(`SELECT category, name, image, image_name, image_size, image_crc, audio, audio_name, audio_size, audio_crc
    FROM sigs WHERE crew_id = ? AND hidden = 0 ${cat ? "AND category = ?" : ""} AND (image IS NOT NULL OR audio IS NOT NULL) ORDER BY sort, id`)
    .all(crew.id, ...(cat ? [cat] : []));
  if (!rows.length) fail(404, "받을 음원 · 이미지가 없습니다.");
  await sendZip(res, `${safeName(crew.name)}${cat ? `_${safeName(cat)}` : ""}_시그.zip`, zipEntries(rows));
});

// 시그 목록 (공개)
route("GET", "/api/sigs", (req, _p, url) => {
  const crew = url.searchParams.get("crew");
  return db.prepare(`SELECT ${sigFields} FROM sigs s WHERE s.hidden = 0 ${crew ? "AND s.crew_id = ?" : ""} ORDER BY s.sort, s.id`)
    .all(...(crew ? [crew] : []));
});

// 시그 자세히 + 레슨 영상 (레슨은 승인된 회원만)
route("GET", "/api/sigs/:id", (req, p) => {
  const sig = db.prepare(`SELECT ${sigFields} FROM sigs s WHERE s.id = ? AND s.hidden = 0`).get(Number(p.id)) || fail(404, "시그를 찾을 수 없습니다.");
  const user = auth.currentUser(req);
  if (!user) return { ...sig, locked: true, items: [] };
  const items = db.prepare("SELECT id, title, kind, url, file, size FROM lessons WHERE sig_id = ? AND kind != 'pending' ORDER BY id").all(sig.id)
    .map(({ file, ...l }) => ({ ...l, src: file ? `/media/lessons/${file}` : null }));
  return { ...sig, locked: false, items };
});

// 파일 다운로드 목록 (목록은 공개, 받기는 회원만)
route("GET", "/api/files", (req, _p, url) => {
  const crew = url.searchParams.get("crew");
  const rows = db.prepare(`SELECT id, crew_id AS crew, title, orig_name, size, created_at FROM files ${crew ? "WHERE crew_id = ?" : ""} ORDER BY created_at DESC`)
    .all(...(crew ? [crew] : []));
  const locked = !auth.currentUser(req);
  return { items: locked ? rows : rows.map((f) => ({ ...f, href: `/media/files/${db.prepare("SELECT file FROM files WHERE id = ?").get(f.id).file}` })), locked };
});

/* 관리자: 시그 */
route("GET", "/api/admin/sigs", (req, _p, url) => {
  requireAdmin(req);
  const crew = url.searchParams.get("crew") || fail(400, "크루를 고르세요.");
  const sigs = db.prepare(`SELECT id, category, name, price, ref_url, hidden, created_at, image, image_name, image_size, audio, audio_name, audio_size
    FROM sigs WHERE crew_id = ? ORDER BY sort, id`).all(crew);
  const lessons = db.prepare("SELECT l.id, l.sig_id, l.title, l.kind, l.url, l.file, l.size FROM lessons l JOIN sigs s ON s.id = l.sig_id WHERE s.crew_id = ? ORDER BY l.id").all(crew);
  return sigs.map((sg) => ({ ...sg, items: lessons.filter((l) => l.sig_id === sg.id) }));
});

route("POST", "/api/admin/sigs", async (req) => {
  requireAdmin(req);
  const b = await readJson(req);
  const name = str(b.name, 100) || fail(400, "시그 이름을 입력하세요.");
  const v = [str(b.category, 30), name, parsePrice(b.price), refUrls(b.ref_url), b.hidden ? 1 : 0, Date.now()];
  if (b.id) {
    db.prepare("UPDATE sigs SET category = ?, name = ?, price = ?, ref_url = ?, hidden = ?, updated_at = ? WHERE id = ?").run(...v, Number(b.id));
    return { ok: true };
  }
  const crew = str(b.crew, 30);
  if (!db.prepare("SELECT 1 FROM crews WHERE id = ?").get(crew)) fail(400, "크루를 고르세요.");
  const sort = (db.prepare("SELECT MAX(sort) AS m FROM sigs WHERE crew_id = ?").get(crew).m ?? 0) + 1;
  const r = db.prepare("INSERT INTO sigs (crew_id, category, name, price, ref_url, hidden, updated_at, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(crew, ...v, sort, Date.now());
  return { ok: true, id: Number(r.lastInsertRowid) };
});

route("POST", "/api/admin/sigs/:id/delete", (req, p) => {
  requireAdmin(req);
  removeStored(sigStored("s.id = ?", Number(p.id)));
  db.prepare("DELETE FROM sigs WHERE id = ?").run(Number(p.id));
  return { ok: true };
});

// 시그 목록 반영: 같은 이름은 수정, 새 이름은 추가 (이름이 같은 시그가 여럿이면 순서대로 짝지음)
//   엑셀 업로드와 구글 시트 자동 반영이 같이 씀
function importSigs(crew, rows0, prune) {
  // 분류도 단가도 없는 줄(메모, 다른 표 등)은 시그가 아니므로 건너뜀
  const all = (Array.isArray(rows0) ? rows0 : []).map((r) => ({ ...r, name: str(r.name, 100) })).filter((r) => r.name);
  const rows = all.filter((r) => str(r.category) || parsePrice(r.price));
  if (!rows.length) fail(400, "엑셀에서 시그를 찾지 못했습니다. 양식의 제목 줄(시그 이름, 시그단가 …)을 확인하세요.");

  const now = Date.now();
  // 크루에 처음 올리는 목록은 NEW 표시를 붙이지 않음 (전부 NEW 로 뜨는 것 방지)
  const first = !db.prepare("SELECT 1 FROM sigs WHERE crew_id = ?").get(crew);
  const createdAt = first ? now - 30 * 864e5 : now;
  const stat = { added: 0, updated: 0, hidden: 0, removed: 0, lessons: 0, pending: 0, skipped: all.length - rows.length };
  const existing = new Map();
  for (const sg of db.prepare("SELECT id, name FROM sigs WHERE crew_id = ? ORDER BY sort, id").all(crew)) {
    if (!existing.has(sg.name)) existing.set(sg.name, []);
    existing.get(sg.name).push(sg.id);
  }
  const used = new Set();
  const insertSig = db.prepare("INSERT INTO sigs (crew_id, category, name, price, ref_url, hidden, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const updateSig = db.prepare("UPDATE sigs SET category = ?, price = ?, ref_url = ?, hidden = ?, sort = ?, updated_at = ? WHERE id = ?");
  const hasLesson = db.prepare("SELECT 1 FROM lessons WHERE sig_id = ? AND (url = ? OR (? != '' AND title = ?))");
  const addLesson = db.prepare("INSERT INTO lessons (sig_id, title, kind, url, created_at) VALUES (?, ?, ?, ?, ?)");

  tx(() => rows.forEach((r, i) => {
    const hidden = /x|제외/i.test(String(r.exclude || "")) ? 1 : 0;
    const vals = [str(r.category, 30), parsePrice(r.price), refUrls(r.ref), hidden, i + 1, now];
    const id = (existing.get(r.name) || []).find((x) => !used.has(x));
    let sigId;
    if (id) {
      updateSig.run(...vals, id);
      sigId = id;
      stat.updated++;
    } else {
      sigId = Number(insertSig.run(crew, vals[0], r.name, vals[1], vals[2], hidden, i + 1, createdAt, now).lastInsertRowid);
      stat.added++;
    }
    used.add(sigId);
    if (hidden) stat.hidden++;

    const tokens = lessonTokens(r.lessons);
    const fileNames = tokens.filter((t) => !/^https?:/i.test(t));
    for (const t of tokens) {
      const isUrl = /^https?:/i.test(t);
      // 파일 이름 한 개에 링크가 걸려 있으면 (구글 드라이브 등) 그 링크로 등록
      const url = isUrl ? t : fileNames.length === 1 && r.lessonLink ? str(r.lessonLink, 500) : "";
      const title = isUrl ? "" : t;
      if (hasLesson.get(sigId, url || "\u0000", title, title)) continue;
      addLesson.run(sigId, title, url ? lessonKind(url) : "pending", url, now);
      url ? stat.lessons++ : stat.pending++;
    }
  }));

  if (prune) {
    const gone = db.prepare("SELECT id FROM sigs WHERE crew_id = ?").all(crew).map((r) => r.id).filter((id) => !used.has(id));
    for (const id of gone) {
      removeStored(sigStored("s.id = ?", id));
      db.prepare("DELETE FROM sigs WHERE id = ?").run(id);
    }
    stat.removed = gone.length;
  }
  return stat;
}

// 엑셀 업로드
route("POST", "/api/admin/sigs/import", async (req) => {
  requireAdmin(req);
  const b = await readJson(req, 20 * 1024 * 1024);
  const crew = str(b.crew, 30);
  if (!db.prepare("SELECT 1 FROM crews WHERE id = ?").get(crew)) fail(400, "크루를 고르세요.");
  return { ok: true, ...importSigs(crew, b.rows, !!b.prune) };
});

/* 구글 시트 자동 반영 (5분마다 + 지금 가져오기) */
// 시트에서 지운 시그가 너무 많으면(절반 넘게) 실수일 수 있어서 지우지 않음
async function syncSheet(crewId) {
  const c = db.prepare("SELECT id, sheet_url, sheet_prune, sheet_hash FROM crews WHERE id = ?").get(crewId);
  if (!c?.sheet_url) return null;
  const save = (result, hash = c.sheet_hash) =>
    db.prepare("UPDATE crews SET sheet_result = ?, sheet_hash = ?, sheet_synced_at = ? WHERE id = ?").run(JSON.stringify(result), hash, Date.now(), c.id);
  try {
    const rows = await sheet.fetchSigRows(c.sheet_url);
    const hash = crypto.createHash("sha1").update(JSON.stringify([rows, c.sheet_prune])).digest("hex");
    if (hash === c.sheet_hash) {
      const prev = JSON.parse(db.prepare("SELECT sheet_result FROM crews WHERE id = ?").get(c.id).sheet_result || "{}");
      const result = { ...prev, ok: true, unchanged: true, checked_at: Date.now() };
      save(result, hash);
      return result;
    }
    let prune = !!c.sheet_prune, guarded = false;
    if (prune) {
      const names = new Set(rows.map((r) => str(r.name, 100)));
      const existing = db.prepare("SELECT name FROM sigs WHERE crew_id = ?").all(c.id);
      const gone = existing.filter((x) => !names.has(x.name)).length;
      if (existing.length >= 10 && gone > existing.length / 2) { prune = false; guarded = true; }
    }
    const stat = importSigs(c.id, rows, prune);
    const result = { ok: true, ...stat, guarded, changed_at: Date.now(), checked_at: Date.now() };
    save(result, guarded ? null : hash); // 지우기를 건너뛰었으면 다음에 다시 확인
    return result;
  } catch (e) {
    const result = { ok: false, error: e.message || "시트를 반영하지 못했습니다.", checked_at: Date.now() };
    save(result);
    return result;
  }
}
async function syncAllSheets() {
  for (const c of db.prepare("SELECT id FROM crews WHERE sheet_url IS NOT NULL AND sheet_url != ''").all()) {
    await syncSheet(c.id).catch((e) => console.error(`[sheet:${c.id}]`, e.message));
  }
}

route("GET", "/api/admin/sheets", (req) => {
  requireAdmin(req);
  return db.prepare("SELECT id, sheet_url, sheet_prune, sheet_synced_at, sheet_result FROM crews").all()
    .map((c) => ({ ...c, sheet_result: c.sheet_result ? JSON.parse(c.sheet_result) : null }));
});
// 시트 주소 저장 (비우면 자동 반영 끔) → 바로 한 번 가져옴
route("POST", "/api/admin/sheets/:crew", async (req, p) => {
  requireAdmin(req);
  const b = await readJson(req);
  db.prepare("SELECT 1 FROM crews WHERE id = ?").get(p.crew) || fail(404, "크루를 찾을 수 없습니다.");
  const url = str(b.url, 500);
  if (url) try { sheet.sheetId(url); } catch (e) { fail(400, e.message); }
  db.prepare("UPDATE crews SET sheet_url = ?, sheet_prune = ?, sheet_hash = NULL, sheet_result = NULL, sheet_synced_at = NULL WHERE id = ?")
    .run(url || null, b.prune === false ? 0 : 1, p.crew);
  return { ok: true, result: url ? await syncSheet(p.crew) : null };
});
// 지금 가져오기 (바뀐 게 없어도 다시 반영)
route("POST", "/api/admin/sheets/:crew/sync", async (req, p) => {
  requireAdmin(req);
  db.prepare("UPDATE crews SET sheet_hash = NULL WHERE id = ?").run(p.crew);
  const result = await syncSheet(p.crew);
  if (!result) fail(400, "먼저 구글 시트 주소를 저장하세요.");
  return { ok: true, result };
});

/* 관리자: 시그 음원 · 시그 이미지 (?kind=audio | image) */
const ASSET = {
  image: { re: /\.(png|jpe?g|gif|webp)$/i, label: "이미지(jpg, png, gif, webp)" },
  audio: { re: /\.(mp3|m4a|wav|ogg|aac|flac)$/i, label: "음원(mp3, m4a, wav, ogg, aac, flac)" },
};
route("POST", "/api/admin/sigs/:id/asset", async (req, p, url) => {
  requireAdmin(req);
  const kind = url.searchParams.get("kind") === "image" ? "image" : "audio";
  const sig = db.prepare(`SELECT id, ${kind} AS file FROM sigs WHERE id = ?`).get(Number(p.id)) || fail(404, "시그를 찾을 수 없습니다.");
  const up = await saveUpload(req, "sigs");
  if (!ASSET[kind].re.test(up.file)) { removeStored([`sigs/${up.file}`]); fail(400, `${ASSET[kind].label} 파일만 올릴 수 있습니다.`); }
  removeStored([sig.file && `sigs/${sig.file}`]);
  db.prepare(`UPDATE sigs SET ${kind} = ?, ${kind}_name = ?, ${kind}_size = ?, ${kind}_crc = ?, updated_at = ? WHERE id = ?`)
    .run(up.file, up.orig, up.size, up.crc, Date.now(), sig.id);
  return { ok: true };
});
route("POST", "/api/admin/sigs/:id/asset/delete", async (req, p) => {
  requireAdmin(req);
  const b = await readJson(req);
  const kind = b.kind === "image" ? "image" : "audio";
  const sig = db.prepare(`SELECT id, ${kind} AS file FROM sigs WHERE id = ?`).get(Number(p.id)) || fail(404, "시그를 찾을 수 없습니다.");
  removeStored([sig.file && `sigs/${sig.file}`]);
  db.prepare(`UPDATE sigs SET ${kind} = NULL, ${kind}_name = NULL, ${kind}_size = 0, ${kind}_crc = 0, updated_at = ? WHERE id = ?`).run(Date.now(), sig.id);
  return { ok: true };
});

/* 관리자: 레슨 영상 */
route("POST", "/api/admin/sigs/:id/lessons", async (req, p) => {
  requireAdmin(req);
  const b = await readJson(req);
  const url = str(b.url, 500);
  if (!/^https?:\/\//i.test(url)) fail(400, "유튜브나 구글 드라이브 링크를 넣으세요.");
  db.prepare("SELECT 1 FROM sigs WHERE id = ?").get(Number(p.id)) || fail(404, "시그를 찾을 수 없습니다.");
  db.prepare("INSERT INTO lessons (sig_id, title, kind, url, created_at) VALUES (?, ?, ?, ?, ?)").run(Number(p.id), str(b.title, 100), lessonKind(url), url, Date.now());
  return { ok: true };
});

// 영상 파일 올리기: lesson 이 있으면 그 칸(파일 대기)에 채우고, 없으면 새로 추가
route("POST", "/api/admin/sigs/:id/lessons/upload", async (req, p, url) => {
  requireAdmin(req);
  const sigId = Number(p.id);
  db.prepare("SELECT 1 FROM sigs WHERE id = ?").get(sigId) || fail(404, "시그를 찾을 수 없습니다.");
  const lessonId = Number(url.searchParams.get("lesson")) || null;
  const old = lessonId && (db.prepare("SELECT id, title, file FROM lessons WHERE id = ? AND sig_id = ?").get(lessonId, sigId) || fail(404, "레슨 영상을 찾을 수 없습니다."));
  const up = await saveUpload(req, "lessons");
  if (old) {
    removeStored([old.file && `lessons/${old.file}`]);
    db.prepare("UPDATE lessons SET kind = 'file', url = '', file = ?, size = ?, title = ?, created_at = ? WHERE id = ?")
      .run(up.file, up.size, old.title || up.orig, Date.now(), old.id);
  } else {
    db.prepare("INSERT INTO lessons (sig_id, title, kind, file, size, created_at) VALUES (?, ?, 'file', ?, ?, ?)").run(sigId, up.orig, up.file, up.size, Date.now());
  }
  return { ok: true };
});

route("POST", "/api/admin/lessons/:id/delete", (req, p) => {
  requireAdmin(req);
  const l = db.prepare("SELECT file FROM lessons WHERE id = ?").get(Number(p.id));
  removeStored([l?.file && `lessons/${l.file}`]);
  db.prepare("DELETE FROM lessons WHERE id = ?").run(Number(p.id));
  return { ok: true };
});

/* 관리자: 파일 */
route("POST", "/api/admin/files/upload", async (req, _p, url) => {
  requireAdmin(req);
  const crew = str(url.searchParams.get("crew"), 30);
  if (!db.prepare("SELECT 1 FROM crews WHERE id = ?").get(crew)) fail(400, "크루를 고르세요.");
  const up = await saveUpload(req, "files");
  const title = str(url.searchParams.get("title"), 100) || up.orig;
  db.prepare("INSERT INTO files (crew_id, title, file, orig_name, size, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(crew, title, up.file, up.orig, up.size, Date.now());
  return { ok: true };
});

route("POST", "/api/admin/files/:id/delete", (req, p) => {
  requireAdmin(req);
  const f = db.prepare("SELECT file FROM files WHERE id = ?").get(Number(p.id));
  removeStored([f && `files/${f.file}`]);
  db.prepare("DELETE FROM files WHERE id = ?").run(Number(p.id));
  return { ok: true };
});

/* ---------- 백업 · 복원 (다른 서버로 옮길 때, 정기 백업) ---------- */
// 올린 영상·파일은 백업에 들어가지 않음 (데이터베이스만)
const BACKUP_TABLES = ["users", "codes", "crews", "members", "channels", "videos", "soop_channels", "broadcasts", "sigs", "lessons", "files", "requests"];

route("GET", "/api/admin/backup", (req, _p, _u, res) => {
  requireAdmin(req);
  const tmp = path.join(DATA_DIR, `backup-${crypto.randomBytes(6).toString("hex")}.db`);
  try {
    db.prepare("VACUUM INTO ?").run(tmp);
    const buf = fs.readFileSync(tmp);
    const d = new Date();
    const name = `eternal-backup-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}.db`;
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": buf.length, "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" });
    res.end(buf);
  } finally {
    fs.rm(tmp, { force: true }, () => {});
  }
});

route("POST", "/api/admin/restore", async (req) => {
  requireAdmin(req);
  const up = await saveUpload(req, ".");
  const file = path.join(DATA_DIR, "uploads", up.file);
  try {
    // 진짜 백업 파일인지 확인 (관리자 계정이 있어야 함)
    let admins = 0;
    try {
      const src = new DatabaseSync(file, { readOnly: true });
      try { admins = src.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c; } finally { src.close(); }
    } catch { fail(400, "이 사이트의 백업 파일이 아닙니다."); }
    if (!admins) fail(400, "백업에 관리자 계정이 없어서 복원할 수 없습니다.");

    const counts = {};
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("ATTACH DATABASE ? AS src").run(file);
    try {
      tx(() => {
        for (const t of BACKUP_TABLES) {
          const srcCols = new Set(db.prepare(`PRAGMA src.table_info(${t})`).all().map((c) => c.name));
          const cols = db.prepare(`PRAGMA main.table_info(${t})`).all().map((c) => c.name).filter((c) => srcCols.has(c)).join(", ");
          db.exec(`DELETE FROM main.${t}`);
          if (cols) db.exec(`INSERT INTO main.${t} (${cols}) SELECT ${cols} FROM src.${t}`);
          counts[t] = db.prepare(`SELECT COUNT(*) AS c FROM main.${t}`).get().c;
        }
        db.exec("DELETE FROM main.sessions");
      });
      linkMembers(); // 예전 백업이면 채널마다 멤버를 만들어 줌
    } finally {
      db.exec("DETACH DATABASE src");
      db.exec("PRAGMA foreign_keys = ON");
    }
    return { ok: true, counts };
  } finally {
    fs.rm(file, { force: true }, () => {});
  }
});

/* ---------- 정적 파일 ---------- */
const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".mp4": "video/mp4", ".webm": "video/webm",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".flac": "audio/flac",
  ".mov": "video/quicktime", ".m4v": "video/mp4", ".pdf": "application/pdf", ".zip": "application/zip",
};

function serveFile(res, file, { req, download } = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end("Not found"); }
    const headers = { "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", "Accept-Ranges": "bytes" };
    if (download) headers["Content-Disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(download)}`;
    // 영상 중간으로 넘기기 (Range 요청)
    const range = req?.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
      let end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      start = Math.max(0, start);
      if (start > end || start >= st.size) { res.writeHead(416, { "Content-Range": `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${st.size}`, "Content-Length": end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, "Content-Length": st.size });
    fs.createReadStream(file).pipe(res);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const pathname = decodeURIComponent(url.pathname);

  if (pathname.startsWith("/api/")) {
    for (const r of routes) {
      const m = r.method === req.method && pathname.match(r.re);
      if (!m) continue;
      try {
        const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
        const out = await r.handler(req, params, url, res);
        return res.headersSent ? undefined : sendJson(res, 200, out);
      } catch (e) {
        if (!(e instanceof HttpError)) console.error(e);
        return sendJson(res, e.status || 500, { error: e instanceof HttpError ? e.message : "서버 오류가 발생했습니다." });
      }
    }
    return sendJson(res, 404, { error: "Not found" });
  }

  // 요청 첨부 사진 (관리자만)
  if (pathname.startsWith("/uploads/")) {
    const u = auth.currentUser(req);
    const name = path.basename(pathname);
    if (u?.role !== "admin" || !/^[a-f0-9]+\.\w+$/.test(name)) { res.writeHead(404); return res.end("Not found"); }
    return serveFile(res, path.join(DATA_DIR, "uploads", name));
  }

  // 시그 음원 · 시그 이미지 (공개, ?dl=1 이면 원래 파일 이름으로 받기)
  const sigFile = pathname.match(/^\/media\/sigs\/([a-f0-9]{24}\.[a-z0-9]{1,8})$/i);
  if (sigFile) {
    let download;
    if (url.searchParams.get("dl")) {
      const r = db.prepare("SELECT name, image, image_name, audio_name FROM sigs WHERE image = ? OR audio = ?").get(sigFile[1], sigFile[1]);
      if (r) download = `${safeName(r.name)} - ${r.image === sigFile[1] ? "이미지" : "음원"}${path.extname(sigFile[1])}`;
    }
    return serveFile(res, path.join(DATA_DIR, "uploads", "sigs", sigFile[1]), { req, download });
  }

  // 멤버 프로필 사진 · 공약 이미지 (공개)
  const memberImg = pathname.match(/^\/media\/members\/([a-f0-9]{24}\.(?:png|jpe?g|gif|webp))$/i);
  if (memberImg) return serveFile(res, path.join(DATA_DIR, "uploads", "members", memberImg[1]), { req });

  // 레슨 영상 · 다운로드 파일 (승인된 회원만)
  const media = pathname.match(/^\/media\/(lessons|files)\/([a-f0-9]{24}(?:\.[a-z0-9]{1,8})?)$/);
  if (media) {
    if (!auth.currentUser(req)) { res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("로그인이 필요합니다."); }
    const f = media[1] === "files" && db.prepare("SELECT orig_name FROM files WHERE file = ?").get(media[2]);
    return serveFile(res, path.join(DATA_DIR, "uploads", media[1], media[2]), { req, download: f?.orig_name });
  }

  const rel = pathname.replace(/^\/+/, "") || "index.html";
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep) || !PUBLIC.has(rel.split("/")[0])) { res.writeHead(404); return res.end("Not found"); }
  serveFile(res, file);
}).listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
  auth.ensureAdmin();
  auth.cleanupSessions();
  setInterval(auth.cleanupSessions, 60 * 60 * 1000);
  youtube.startScheduler();
  soop.startScheduler();
  // 구글 시트 → 시그 목록 (5분마다)
  setTimeout(syncAllSheets, 10 * 1000);
  setInterval(syncAllSheets, 5 * 60 * 1000);
});
