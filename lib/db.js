// SQLite 데이터베이스 (Node 내장 node:sqlite, 파일: data/eternal.db)
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

// 데이터 폴더: DATA_DIR 환경변수 → Railway 볼륨 → 프로젝트의 data/
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, "..", "data");
for (const dir of ["uploads", "uploads/lessons", "uploads/files", "uploads/members", "uploads/sigs"]) fs.mkdirSync(path.join(DATA_DIR, dir), { recursive: true });

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

  -- 멤버 (유튜브 채널 · SOOP 방송국은 member_id 로 멤버에 연결)
  CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    crew_id TEXT REFERENCES crews(id) ON DELETE SET NULL,
    role_title TEXT NOT NULL DEFAULT '',        -- 직책
    quote TEXT NOT NULL DEFAULT '',             -- 한마디
    photo TEXT,                                 -- data/uploads/members/ 안의 파일 이름
    instagram TEXT NOT NULL DEFAULT '',
    kakao TEXT NOT NULL DEFAULT '',
    profile_text TEXT NOT NULL DEFAULT '',
    promise_text TEXT NOT NULL DEFAULT '',
    promise_image TEXT,                         -- data/uploads/members/ 안의 파일 이름
    sig_ids TEXT NOT NULL DEFAULT '[]',         -- 대표 시그 (sigs.id 목록, JSON)
    sort INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
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

  -- SOOP 방송국 (youtube_id 를 넣으면 그 유튜브 멤버와 같은 사람으로 합쳐서 집계)
  CREATE TABLE IF NOT EXISTS soop_channels (
    id TEXT PRIMARY KEY,                        -- SOOP 아이디
    nick TEXT NOT NULL DEFAULT '',
    thumb TEXT,
    name TEXT NOT NULL DEFAULT '',              -- 사이트에 표시할 멤버 이름
    crew_id TEXT REFERENCES crews(id) ON DELETE SET NULL,
    youtube_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
    live INTEGER NOT NULL DEFAULT 0,
    broad_no TEXT,
    title TEXT NOT NULL DEFAULT '',
    viewers INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    checked_at INTEGER
  );

  -- 방송 기록 (유튜브 라이브 + SOOP). 채널을 지워도 기록은 남김
  CREATE TABLE IF NOT EXISTS broadcasts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,                     -- youtube | soop
    channel_id TEXT NOT NULL,                   -- 유튜브 채널 ID 또는 SOOP 아이디
    broad_id TEXT NOT NULL,                     -- 유튜브 영상 ID 또는 SOOP 방송 번호
    title TEXT NOT NULL DEFAULT '',
    started_at INTEGER NOT NULL,
    ended_at INTEGER,                           -- NULL = 방송 중
    last_seen INTEGER NOT NULL,
    UNIQUE (platform, broad_id)
  );
  CREATE INDEX IF NOT EXISTS broadcasts_time ON broadcasts(started_at);

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

// 예전 DB 에 없는 칸 추가
function addColumn(table, column, def) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}
for (const t of ["channels", "soop_channels"]) addColumn(t, "member_id", "INTEGER REFERENCES members(id) ON DELETE SET NULL");
// 크루별 구글 시트 자동 반영
addColumn("crews", "sheet_url", "TEXT");
addColumn("crews", "sheet_prune", "INTEGER NOT NULL DEFAULT 1");   // 시트에서 지운 시그는 사이트에서도 지움
addColumn("crews", "sheet_hash", "TEXT");                          // 마지막으로 반영한 내용 (바뀐 게 없으면 건너뜀)
addColumn("crews", "sheet_synced_at", "INTEGER");
addColumn("crews", "sheet_result", "TEXT");                        // 마지막 결과 (JSON)
// 시그 음원 · 시그 이미지 (data/uploads/sigs/, crc 는 한 번에 받기 zip 용)
for (const k of ["image", "audio"]) {
  addColumn("sigs", k, "TEXT");
  addColumn("sigs", `${k}_name`, "TEXT");
  addColumn("sigs", `${k}_size`, "INTEGER NOT NULL DEFAULT 0");
  addColumn("sigs", `${k}_crc`, "INTEGER NOT NULL DEFAULT 0");
}

// 멤버에 연결되지 않은 채널 · 방송국에 멤버 만들어 주기 (예전 데이터, 예전 백업 복원 후)
function linkMembers() {
  const now = Date.now();
  const add = db.prepare("INSERT INTO members (name, crew_id, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
  const nextSort = () => (db.prepare("SELECT MAX(sort) AS m FROM members").get().m ?? 0) + 1;
  const exists = (id) => id != null && db.prepare("SELECT 1 FROM members WHERE id = ?").get(id);
  tx(() => {
    for (const c of db.prepare("SELECT id, title, name, crew_id, member_id FROM channels ORDER BY created_at").all()) {
      if (exists(c.member_id)) continue;
      const id = Number(add.run(c.name || c.title, c.crew_id, nextSort(), now, now).lastInsertRowid);
      db.prepare("UPDATE channels SET member_id = ? WHERE id = ?").run(id, c.id);
    }
    for (const s of db.prepare("SELECT id, nick, name, crew_id, youtube_id, member_id FROM soop_channels ORDER BY created_at").all()) {
      if (exists(s.member_id)) continue;
      let id = s.youtube_id && db.prepare("SELECT member_id FROM channels WHERE id = ?").get(s.youtube_id)?.member_id;
      if (!exists(id)) id = Number(add.run(s.name || s.nick || s.id, s.crew_id, nextSort(), now, now).lastInsertRowid);
      db.prepare("UPDATE soop_channels SET member_id = ? WHERE id = ?").run(id, s.id);
    }
  });
}

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

linkMembers();

module.exports = { db, tx, DATA_DIR, linkMembers };
