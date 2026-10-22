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
route("GET", "/api/videos", (req, _p, url) => {
  const type = url.searchParams.get("type") === "short" ? "short" : "post";
  const crew = url.searchParams.get("crew");
  const before = Number(url.searchParams.get("before")) || Number.MAX_SAFE_INTEGER;
  const limit = Math.min(Number(url.searchParams.get("limit")) || 20, 60);
  const rows = db.prepare(`
    SELECT ${videoFields} FROM videos v JOIN channels c ON c.id = v.channel_id
    WHERE v.type = ? AND v.live = 'none' AND v.published_at < ? ${crew ? "AND c.crew_id = ?" : ""}
    ORDER BY v.published_at DESC LIMIT ?
  `).all(type, before, ...(crew ? [crew] : []), limit + 1);
  return { items: rows.slice(0, limit), more: rows.length > limit };
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

/* ---------- 정적 파일 ---------- */
const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".mp4": "video/mp4", ".webm": "video/webm",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
};

function serveFile(res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", "Content-Length": st.size });
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
