// 비밀번호 해시 · 세션 쿠키
const crypto = require("crypto");
const { db } = require("./db");

const COOKIE = "eternal_sid";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString("hex")}`;
}

function verifyPassword(pw, stored) {
  const [salt, hash] = stored.split(":");
  const a = Buffer.from(hash, "hex");
  const b = crypto.scryptSync(pw, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || "").split(";").map((c) => c.trim().split("=")).filter(([k]) => k).map(([k, v]) => [k, decodeURIComponent(v || "")])
  );
}

const isHttps = (req) => req.headers["x-forwarded-proto"] === "https";

function createSession(res, req, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(token, userId, Date.now() + SESSION_MS);
  res.setHeader("Set-Cookie", `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${isHttps(req) ? "; Secure" : ""}`);
}

function destroySession(res, req) {
  const token = parseCookies(req)[COOKIE];
  if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// 승인된 사용자만 로그인 상태로 인정
function currentUser(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.username, u.nickname, u.role, u.status FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ? AND u.status = 'approved'
  `).get(token, Date.now());
  return row || null;
}

// 관리자 계정이 없으면 .env 의 ADMIN_ID / ADMIN_PASSWORD 로 생성
function ensureAdmin() {
  if (db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get()) return;
  const id = process.env.ADMIN_ID;
  const pw = process.env.ADMIN_PASSWORD;
  if (!id || !pw) return console.warn("⚠ 관리자 계정이 없습니다. .env 에 ADMIN_ID / ADMIN_PASSWORD 를 넣고 다시 실행하세요.");
  db.prepare("INSERT INTO users (username, nickname, pw_hash, role, status, created_at) VALUES (?, ?, ?, 'admin', 'approved', ?)")
    .run(id, "관리자", hashPassword(pw), Date.now());
  console.log(`관리자 계정 생성: ${id}`);
}

function cleanupSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
}

module.exports = { hashPassword, verifyPassword, createSession, destroySession, currentUser, ensureAdmin, cleanupSessions };
