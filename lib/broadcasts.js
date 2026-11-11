/*
 * 방송 기록 · 방송 시간 순위
 *  - 유튜브 라이브와 SOOP 방송을 broadcasts 테이블에 한 번씩(방송 1개 = 1줄) 기록
 *  - 멤버: 유튜브 채널 1개 + (연결된) SOOP 방송국을 같은 사람으로 묶음
 *  - 같은 시간에 유튜브·SOOP 동시 송출하면 겹친 시간은 한 번만 셉니다.
 *  - 달 · 날짜 경계는 한국 시간(KST) 기준
 */
const { db } = require("./db");

const KST = 9 * 3600 * 1000;
const STALE_MS = 15 * 60 * 1000; // 이만큼 확인이 안 되면 마지막으로 본 시각에 끝난 것으로 처리
const DAY = 86400 * 1000;

const monthKey = (ms = Date.now()) => new Date(ms + KST).toISOString().slice(0, 7);
const dayKey = (ms) => new Date(ms + KST).toISOString().slice(0, 10);
function monthRange(month) {
  const [y, m] = month.split("-").map(Number);
  return [Date.UTC(y, m - 1, 1) - KST, Date.UTC(y, m, 1) - KST];
}

const upsert = db.prepare(`
  INSERT INTO broadcasts (platform, channel_id, broad_id, title, started_at, ended_at, last_seen)
  VALUES (:platform, :channel_id, :broad_id, :title, :started_at, :ended_at, :last_seen)
  ON CONFLICT(platform, broad_id) DO UPDATE SET
    title = excluded.title, started_at = excluded.started_at, ended_at = excluded.ended_at, last_seen = excluded.last_seen
`);

// 방송 1개 기록 (ended_at 이 null 이면 방송 중)
function record({ platform, channel_id, broad_id, title = "", started_at, ended_at = null }) {
  const now = Date.now();
  upsert.run({ platform, channel_id, broad_id: String(broad_id), title, started_at, ended_at, last_seen: ended_at ?? now });
}

// 이 채널의 열린 방송 중 지금 방송(keep)이 아닌 것은 끝난 것으로 처리
function closeOthers(platform, channelId, keep = null) {
  db.prepare(`UPDATE broadcasts SET ended_at = MAX(last_seen, started_at)
    WHERE platform = ? AND channel_id = ? AND ended_at IS NULL AND broad_id != ?`).run(platform, channelId, String(keep ?? ""));
}

// 서버가 꺼졌거나 확인이 계속 실패한 방송 정리
function closeStale() {
  db.prepare("UPDATE broadcasts SET ended_at = MAX(last_seen, started_at) WHERE ended_at IS NULL AND last_seen < ?").run(Date.now() - STALE_MS);
}

/* ---------- 멤버 ---------- */
// key: 유튜브 채널 ID, 또는 SOOP 만 있는 멤버는 "soop:아이디"
function members() {
  const map = new Map();
  for (const c of db.prepare(`SELECT c.id, COALESCE(NULLIF(c.name, ''), c.title) AS name, c.crew_id AS crew, c.thumb, c.handle,
      EXISTS (SELECT 1 FROM videos v WHERE v.channel_id = c.id AND v.live = 'live') AS yt_live
      FROM channels c`).all()) {
    map.set(c.id, { id: c.id, name: c.name, crew: c.crew, thumb: c.thumb, handle: c.handle, youtube: c.id, soop: null, yt_live: !!c.yt_live, soop_live: false, soop_broad: null });
  }
  for (const s of db.prepare("SELECT * FROM soop_channels").all()) {
    const linked = s.youtube_id && map.get(s.youtube_id);
    const m = linked || { id: `soop:${s.id}`, name: s.name || s.nick || s.id, crew: s.crew_id, thumb: s.thumb, handle: null, youtube: null, soop: null, yt_live: false, soop_live: false, soop_broad: null };
    m.soop = s.id;
    const onAir = !!s.live && s.checked_at > Date.now() - STALE_MS; // 확인이 오래 끊겼으면 방송 중으로 보지 않음
    m.soop_live = onAir;
    m.soop_broad = onAir ? s.broad_no : null;
    m.soop_title = onAir ? s.title : "";
    m.soop_viewers = onAir ? s.viewers : 0;
    if (!m.thumb) m.thumb = s.thumb;
    map.set(m.id, m);
  }
  return [...map.values()]
    .map((m) => ({ ...m, is_live: m.yt_live || m.soop_live }))
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));
}

// 방송 기록의 (플랫폼, 채널) → 멤버 key
function ownerMap(list) {
  const owner = new Map();
  for (const m of list) {
    if (m.youtube) owner.set(`youtube:${m.youtube}`, m.id);
    if (m.soop) owner.set(`soop:${m.soop}`, m.id);
  }
  return owner;
}

// 겹치는 구간을 합쳐서 정렬된 구간 목록으로
function merge(intervals) {
  const out = [];
  for (const [s, e] of intervals.sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

// 한 달 방송 통계 (순위 순)
function monthStats(month = monthKey()) {
  const [from, to] = monthRange(month);
  const now = Date.now();
  const list = members();
  const owner = ownerMap(list);
  const rows = db.prepare(`SELECT platform, channel_id, started_at, COALESCE(ended_at, ?) AS ended_at, ended_at IS NULL AS open
    FROM broadcasts WHERE started_at < ? AND COALESCE(ended_at, ?) > ?`).all(now, to, now, from);

  const per = new Map(list.map((m) => [m.id, { intervals: [], sessions: 0, platforms: new Set() }]));
  for (const r of rows) {
    const p = per.get(owner.get(`${r.platform}:${r.channel_id}`));
    if (!p) continue;
    const s = Math.max(r.started_at, from), e = Math.min(r.ended_at, to, now);
    if (e <= s) continue;
    p.intervals.push([s, e]);
    p.sessions++;
    p.platforms.add(r.platform);
  }

  const items = list.map((m) => {
    const p = per.get(m.id);
    const merged = merge(p.intervals);
    const days = new Set();
    let ms = 0;
    for (const [s, e] of merged) {
      ms += e - s;
      // 방송이 걸친 날짜 모두 (다음 KST 자정으로 건너뛰며)
      for (let t = s; t < e; t = (Math.floor((t + KST) / DAY) + 1) * DAY - KST) days.add(dayKey(t));
    }
    return {
      id: m.id, name: m.name, crew: m.crew, thumb: m.thumb,
      youtube: m.youtube, handle: m.handle, soop: m.soop,
      is_live: m.is_live, yt_live: m.yt_live, soop_live: m.soop_live, soop_broad: m.soop_broad,
      seconds: Math.round(ms / 1000), days: days.size, sessions: p.sessions, platforms: [...p.platforms],
    };
  }).sort((a, b) => b.seconds - a.seconds || b.is_live - a.is_live || a.name.localeCompare(b.name, "ko"));

  let rank = 0;
  items.forEach((it, i) => { it.rank = it.seconds ? (i && items[i - 1].seconds === it.seconds ? rank : (rank = i + 1)) : null; });
  return { month, current: month === monthKey(), items, updated_at: now };
}

// 기록이 있는 달 목록 (최신순)
function months() {
  const first = db.prepare("SELECT MIN(started_at) AS t FROM broadcasts").get().t;
  const last = monthKey();
  if (!first) return [last];
  const out = [];
  for (let k = monthKey(first); k <= last; ) {
    out.push(k);
    const [y, m] = k.split("-").map(Number);
    k = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  }
  return out.reverse();
}

// 한 멤버의 그 달 방송 목록
function sessions(memberId, month = monthKey()) {
  const [from, to] = monthRange(month);
  const m = members().find((x) => x.id === memberId);
  if (!m) return [];
  const keys = [m.youtube && ["youtube", m.youtube], m.soop && ["soop", m.soop]].filter(Boolean);
  if (!keys.length) return [];
  const now = Date.now();
  return db.prepare(`SELECT platform, channel_id, broad_id, title, started_at, ended_at FROM broadcasts
    WHERE (${keys.map(() => "(platform = ? AND channel_id = ?)").join(" OR ")})
      AND started_at < ? AND COALESCE(ended_at, ?) > ? ORDER BY started_at DESC`)
    .all(...keys.flat(), to, now, from)
    .map((r) => ({ ...r, seconds: Math.round(((r.ended_at ?? now) - r.started_at) / 1000) }));
}

const isMonth = (v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || ""));

module.exports = { record, closeOthers, closeStale, members, monthStats, months, sessions, monthKey, isMonth };
