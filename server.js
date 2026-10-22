/*
 * (주) 이터널 서버
 *   실행: node server.js   (기본 http://localhost:8000)
 *   설정: .env  →  YOUTUBE_API_KEY, ADMIN_ID, ADMIN_PASSWORD, (선택) PORT
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

loadEnv();

const { db, tx, DATA_DIR } = require("./lib/db");
const auth = require("./lib/auth");
const youtube = require("./lib/youtube");

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
  c.id AS channel_id, COALESCE(NULLIF(c.name, ''), c.title) AS member, c.crew_id AS crew`;

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
  members: db.prepare(`SELECT c.id, COALESCE(NULLIF(c.name, ''), c.title) AS name, c.crew_id AS crew, c.thumb, c.handle,
    EXISTS (SELECT 1 FROM videos v WHERE v.channel_id = c.id AND v.live = 'live') AS is_live
    FROM channels c ORDER BY name`).all(),
  user: auth.currentUser(req),
}));

// 라이브 (등록된 채널만)
route("GET", "/api/live", () => ({
  live: db.prepare(`SELECT ${videoFields} FROM videos v JOIN channels c ON c.id = v.channel_id WHERE v.live = 'live' ORDER BY v.viewers DESC`).all()
    .map((v) => ({ ...v, url: `https://www.youtube.com/watch?v=${v.id}` })),
}));

// 게시글/쇼츠 목록 (누적, 최신순, before 로 더 불러오기)
//   channel=UC...  → 그 계정 영상만
//   latest=1       → 계정마다 가장 최근 영상 1개씩 (홈 화면용)
route("GET", "/api/videos", (req, _p, url) => {
  const type = url.searchParams.get("type") === "short" ? "short" : "post";
  const crew = url.searchParams.get("crew");
  const channel = url.searchParams.get("channel");
  const latest = url.searchParams.get("latest") === "1";
  const before = Number(url.searchParams.get("before")) || Number.MAX_SAFE_INTEGER;
  const limit = Math.min(Number(url.searchParams.get("limit")) || 20, 60);
  const where = ["v.type = ?", "v.live = 'none'"];
  const args = [type];
  if (crew) where.push("c.crew_id = ?"), args.push(crew);
  if (channel) where.push("c.id = ?"), args.push(channel);
  const rows = latest
    ? db.prepare(`
        SELECT * FROM (
          SELECT ${videoFields}, ROW_NUMBER() OVER (PARTITION BY v.channel_id ORDER BY v.published_at DESC) AS rn
          FROM videos v JOIN channels c ON c.id = v.channel_id WHERE ${where.join(" AND ")}
        ) WHERE rn = 1 AND published_at < ? ORDER BY published_at DESC LIMIT ?
      `).all(...args, before, limit + 1)
    : db.prepare(`
        SELECT ${videoFields} FROM videos v JOIN channels c ON c.id = v.channel_id
        WHERE ${where.join(" AND ")} AND v.published_at < ?
        ORDER BY v.published_at DESC LIMIT ?
      `).all(...args, before, limit + 1);
  return { items: rows.slice(0, limit).map(({ rn, ...v }) => v), more: rows.length > limit };
});

// 자세히 보기
route("GET", "/api/videos/:id", (req, p) => {
  const v = db.prepare(`SELECT ${videoFields}, v.description, v.likes, c.title AS channel_title, c.thumb AS channel_thumb
    FROM videos v JOIN channels c ON c.id = v.channel_id WHERE v.id = ?`).get(p.id);
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
    ...db.prepare("SELECT l.file FROM lessons l JOIN sigs s ON s.id = l.sig_id WHERE s.crew_id = ? AND l.file IS NOT NULL").all(p.id).map((r) => `lessons/${r.file}`),
    ...db.prepare("SELECT file FROM files WHERE crew_id = ?").all(p.id).map((r) => `files/${r.file}`),
  ]);
  db.prepare("DELETE FROM crews WHERE id = ?").run(p.id);
  return { ok: true };
});

route("GET", "/api/admin/channels", (req) => {
  requireAdmin(req);
  return db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM videos v WHERE v.channel_id = c.id AND v.type = 'post') AS posts,
    (SELECT COUNT(*) FROM videos v WHERE v.channel_id = c.id AND v.type = 'short') AS shorts,
    EXISTS (SELECT 1 FROM videos v WHERE v.channel_id = c.id AND v.live = 'live') AS is_live
    FROM channels c ORDER BY c.created_at DESC`).all();
});

route("POST", "/api/admin/channels", async (req) => {
  requireAdmin(req);
  if (!process.env.YOUTUBE_API_KEY) fail(503, "YOUTUBE_API_KEY 가 설정되지 않았습니다.");
  const b = await readJson(req);
  const ch = await youtube.resolveChannel(b.channel).catch((e) => fail(400, e.message));
  if (db.prepare("SELECT 1 FROM channels WHERE id = ?").get(ch.id)) fail(409, `이미 등록된 채널입니다: ${ch.title}`);
  db.prepare("INSERT INTO channels (id, title, handle, thumb, name, crew_id, uploads, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(ch.id, ch.title, ch.handle, ch.thumb, str(b.name, 30), str(b.crew, 30) || null, ch.uploads, Date.now());
  const count = await youtube.backfillChannel(ch);
  await youtube.quickPoll().catch(() => {});
  return { ok: true, message: `${ch.title} 등록 완료 (영상 ${count}개 가져옴)` };
});

route("POST", "/api/admin/channels/:id", async (req, p) => {
  requireAdmin(req);
  const b = await readJson(req);
  if (b.action === "delete") db.prepare("DELETE FROM channels WHERE id = ?").run(p.id);
  else db.prepare("UPDATE channels SET name = ?, crew_id = ? WHERE id = ?").run(str(b.name, 30), str(b.crew, 30) || null, p.id);
  return { ok: true };
});

route("POST", "/api/admin/sync", async (req) => {
  requireAdmin(req);
  await youtube.quickPoll();
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
  try {
    for await (const c of req) {
      size += c.length;
      if (size > MAX_UPLOAD) fail(413, "파일은 2GB 이하만 올릴 수 있습니다.");
      if (!out.write(c)) await new Promise((r) => out.once("drain", r));
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  } catch (e) {
    out.destroy();
    fs.rm(dest, () => {});
    throw e;
  }
  if (!size) { fs.rm(dest, () => {}); fail(400, "빈 파일입니다."); }
  return { file: name, orig, size };
}

const ytId = (u) => String(u).match(/(?:youtu\.be\/|\/shorts\/|\/live\/|\/embed\/|[?&]v=)([\w-]{11})/)?.[1];
const driveId = (u) => String(u).match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?id=)([\w-]{10,})/)?.[1];
const lessonKind = (u) => (ytId(u) ? "youtube" : driveId(u) ? "drive" : "link");
const parsePrice = (v) => Number(String(v ?? "").replace(/[^\d]/g, "")) || 0;

// 레슨 칸 → 링크 / 파일 이름 목록 ("레몬에이드.mp4 레몬에이드 0.7.mp4" 처럼 여러 개도 분리)
function lessonTokens(text) {
  return [...String(text || "").matchAll(/https?:\/\/\S+|\S.*?\.(?:mp4|mov|m4v|webm|avi|mkv)(?=\s|$)/gi)].map((m) => m[0].trim());
}

const sigFields = `s.id, s.crew_id AS crew, s.category, s.name, s.price, s.ref_url, s.created_at,
  (SELECT COUNT(*) FROM lessons l WHERE l.sig_id = s.id AND l.kind != 'pending') AS lessons,
  (SELECT MAX(l.created_at) FROM lessons l WHERE l.sig_id = s.id AND l.kind != 'pending') AS last_lesson_at`;

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
  const sigs = db.prepare("SELECT id, category, name, price, ref_url, hidden, created_at FROM sigs WHERE crew_id = ? ORDER BY sort, id").all(crew);
  const lessons = db.prepare("SELECT l.id, l.sig_id, l.title, l.kind, l.url, l.file, l.size FROM lessons l JOIN sigs s ON s.id = l.sig_id WHERE s.crew_id = ? ORDER BY l.id").all(crew);
  return sigs.map((sg) => ({ ...sg, items: lessons.filter((l) => l.sig_id === sg.id) }));
});

route("POST", "/api/admin/sigs", async (req) => {
  requireAdmin(req);
  const b = await readJson(req);
  const name = str(b.name, 100) || fail(400, "시그 이름을 입력하세요.");
  const v = [str(b.category, 30), name, parsePrice(b.price), str(b.ref_url, 500), b.hidden ? 1 : 0, Date.now()];
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
  removeStored(db.prepare("SELECT file FROM lessons WHERE sig_id = ? AND file IS NOT NULL").all(Number(p.id)).map((r) => `lessons/${r.file}`));
  db.prepare("DELETE FROM sigs WHERE id = ?").run(Number(p.id));
  return { ok: true };
});

// 엑셀 업로드: 같은 이름은 수정, 새 이름은 추가 (이름이 같은 시그가 여럿이면 순서대로 짝지음)
route("POST", "/api/admin/sigs/import", async (req) => {
  requireAdmin(req);
  const b = await readJson(req, 20 * 1024 * 1024);
  const crew = str(b.crew, 30);
  if (!db.prepare("SELECT 1 FROM crews WHERE id = ?").get(crew)) fail(400, "크루를 고르세요.");
  // 분류도 단가도 없는 줄(메모, 다른 표 등)은 시그가 아니므로 건너뜀
  const all = (Array.isArray(b.rows) ? b.rows : []).map((r) => ({ ...r, name: str(r.name, 100) })).filter((r) => r.name);
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
    const vals = [str(r.category, 30), parsePrice(r.price), str(r.ref, 500), hidden, i + 1, now];
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

  if (b.prune) {
    const gone = db.prepare("SELECT id FROM sigs WHERE crew_id = ?").all(crew).map((r) => r.id).filter((id) => !used.has(id));
    for (const id of gone) {
      removeStored(db.prepare("SELECT file FROM lessons WHERE sig_id = ? AND file IS NOT NULL").all(id).map((r) => `lessons/${r.file}`));
      db.prepare("DELETE FROM sigs WHERE id = ?").run(id);
    }
    stat.removed = gone.length;
  }
  return { ok: true, ...stat };
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

/* ---------- 정적 파일 ---------- */
const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".mp4": "video/mp4", ".webm": "video/webm",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
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
        return sendJson(res, 200, await r.handler(req, params, url, res));
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
});
