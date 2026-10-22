// SQLite 데이터베이스 (Node 내장 node:sqlite, 파일: data/eternal.db)
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = path.join(__dirname, "..", "data");
for (const dir of ["uploads", "uploads/lessons", "uploads/files"]) fs.mkdirSync(path.join(DATA_DIR, dir), { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, "eternal.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    nickname TEXT NOT NULL,
    pw_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',        -- admin | member
    status TEXT NOT NULL DEFAULT 'pending',     -- pending | approved | rejected
    code TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS codes (
    code TEXT PRIMARY KEY,
    memo TEXT NOT NULL DEFAULT '',
    max_uses INTEGER,                           -- NULL = 무제한
    uses INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS crews (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,                        -- 유튜브 채널 ID (UC...)
    title TEXT NOT NULL,
    handle TEXT,
    thumb TEXT,
    name TEXT NOT NULL DEFAULT '',              -- 사이트에 표시할 멤버 이름
    crew_id TEXT REFERENCES crews(id) ON DELETE SET NULL,
    uploads TEXT NOT NULL,                      -- 업로드 재생목록 ID (UU...)
    created_at INTEGER NOT NULL,
    synced_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    type TEXT NOT NULL DEFAULT 'post',          -- post | short
    live TEXT NOT NULL DEFAULT 'none',          -- none | live | upcoming
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    thumb TEXT,
    published_at INTEGER NOT NULL,
    duration INTEGER NOT NULL DEFAULT 0,
    views INTEGER NOT NULL DEFAULT 0,
    likes INTEGER NOT NULL DEFAULT 0,
    viewers INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS videos_list ON videos(type, live, published_at DESC);
  CREATE INDEX IF NOT EXISTS videos_channel ON videos(channel_id, published_at DESC);

  CREATE TABLE IF NOT EXISTS sigs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    crew_id TEXT NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
    category TEXT NOT NULL DEFAULT '',          -- 엑셀시그 | 첼린지 | 아이돌 시그 | 아웃송 ...
    name TEXT NOT NULL,
    price INTEGER NOT NULL DEFAULT 0,
    ref_url TEXT NOT NULL DEFAULT '',           -- 유튜브 레퍼런스
    hidden INTEGER NOT NULL DEFAULT 0,          -- 엑셀 "제외" 칸에 x
    sort INTEGER NOT NULL DEFAULT 0,            -- 엑셀 행 순서
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sigs_crew ON sigs(crew_id, sort);

  CREATE TABLE IF NOT EXISTS lessons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sig_id INTEGER NOT NULL REFERENCES sigs(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL,                         -- youtube | drive | link | file | pending(파일 업로드 대기)
    url TEXT NOT NULL DEFAULT '',
    file TEXT,                                  -- data/uploads/lessons/ 안의 파일 이름
    size INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS lessons_sig ON lessons(sig_id);

  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    crew_id TEXT NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    file TEXT NOT NULL,                         -- data/uploads/files/ 안의 파일 이름
    orig_name TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,                         -- recommend | backwall
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    data TEXT NOT NULL,
    image TEXT,
    is_read INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
`);

if (!db.prepare("SELECT 1 FROM crews LIMIT 1").get()) {
  const add = db.prepare("INSERT INTO crews (id, name, sort) VALUES (?, ?, ?)");
  add.run("crew-a", "THE 인플루언서", 1);
  add.run("crew-b", "아티스트", 2);
}
// 예전 기본 이름이 그대로 남아 있으면 새 이름으로 변경
db.prepare("UPDATE crews SET name = 'THE 인플루언서' WHERE id = 'crew-a' AND name = '크루 A'").run();
db.prepare("UPDATE crews SET name = '아티스트' WHERE id = 'crew-b' AND name = '크루 B'").run();

function tx(fn) {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

module.exports = { db, tx, DATA_DIR };
