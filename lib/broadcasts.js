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
  INSERT INTO broadcasts (platform, channel_id, broad_id, title, started_at, ended_at, last_seen, category, category_name, peak_viewers, viewer_sum, viewer_samples)
  VALUES (:platform, :channel_id, :broad_id, :title, :started_at, :ended_at, :last_seen, :category, :category_name, :viewers, :viewers, :samples)
  ON CONFLICT(platform, broad_id) DO UPDATE SET
    title = excluded.title, started_at = excluded.started_at, ended_at = excluded.ended_at, last_seen = excluded.last_seen,
    category = COALESCE(excluded.category, category), category_name = COALESCE(excluded.category_name, category_name),
    peak_viewers = MAX(peak_viewers, excluded.peak_viewers),
    viewer_sum = viewer_sum + excluded.viewer_sum, viewer_samples = viewer_samples + excluded.viewer_samples
`);

// 방송 1개 기록 (ended_at 이 null 이면 방송 중). viewers 를 주면 시청자 수 표본으로 쌓음
function record({ platform, channel_id, broad_id, title = "", started_at, ended_at = null, viewers = null, category = null, category_name = null }) {
  const now = Date.now();
  const v = viewers == null || ended_at != null ? null : Math.max(0, Math.round(viewers));
  upsert.run({ platform, channel_id, broad_id: String(broad_id), title, started_at, ended_at, last_seen: ended_at ?? now,
    category, category_name, viewers: v ?? 0, samples: v == null ? 0 : 1 });
}

// 팔로워 수 (그날 값 덮어쓰기)
const setFollowers = db.prepare(`INSERT INTO follower_daily (platform, channel_id, day, count) VALUES (?, ?, ?, ?)
  ON CONFLICT(platform, channel_id, day) DO UPDATE SET count = excluded.count`);
function followers(platform, channelId, count) {
  if (Number.isFinite(count) && count >= 0) setFollowers.run(platform, channelId, dayKey(Date.now()), Math.round(count));
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
// 멤버 1명 = 유튜브 채널 여러 개 + SOOP 방송국 여러 개 (members 테이블 기준)
const photoUrl = (f) => (f ? `/media/members/${f}` : null);
function members() {
  const now = Date.now();
  const map = new Map();
  for (const r of db.prepare("SELECT id, name, crew_id, photo FROM members ORDER BY sort, name").all()) {
    map.set(r.id, {
      id: String(r.id), name: r.name, crew: r.crew_id, thumb: photoUrl(r.photo), handle: null,
      youtube: null, youtubes: [], soop: null, soops: [],
      yt_live: false, yt_live_id: null, soop_live: false, soop_station: null, soop_broad: null, soop_title: "", soop_viewers: 0,
    });
  }
  for (const c of db.prepare(`SELECT c.id, c.handle, c.thumb, c.member_id,
      (SELECT v.id FROM videos v WHERE v.channel_id = c.id AND v.live = 'live' ORDER BY v.viewers DESC LIMIT 1) AS yt_live
      FROM channels c ORDER BY c.created_at`).all()) {
    const m = map.get(c.member_id);
    if (!m) continue;
    m.youtubes.push(c.id);
    if (!m.youtube) { m.youtube = c.id; m.handle = c.handle; }
    if (!m.thumb) m.thumb = c.thumb;
    if (c.yt_live && !m.yt_live) {
      m.yt_live = true; m.yt_live_id = c.yt_live;
      m.yt_viewers = db.prepare("SELECT viewers FROM videos WHERE id = ?").get(c.yt_live)?.viewers || 0;
    }
  }
  for (const s of db.prepare("SELECT * FROM soop_channels ORDER BY created_at").all()) {
    const m = map.get(s.member_id);
    if (!m) continue;
    m.soops.push(s.id);
    if (!m.soop) m.soop = s.id;
    if (!m.thumb) m.thumb = s.thumb;
    const onAir = !!s.live && s.checked_at > now - STALE_MS; // 확인이 오래 끊겼으면 방송 중으로 보지 않음
    if (onAir && !m.soop_live) {
      Object.assign(m, { soop_live: true, soop_station: s.id, soop_broad: s.broad_no, soop_title: s.title, soop_viewers: s.viewers });
    }
  }
  return [...map.values()].map((m) => ({
    ...m, is_live: m.yt_live || m.soop_live,
    live_viewers: (m.soop_live ? m.soop_viewers : 0) + (m.yt_live ? m.yt_viewers || 0 : 0),
    live_platform: m.soop_live ? "soop" : m.yt_live ? "youtube" : null,
    live_url: m.soop_live ? `https://play.sooplive.co.kr/${m.soop_station}/${m.soop_broad}` : m.yt_live_id ? `https://www.youtube.com/watch?v=${m.yt_live_id}` : null,
  }));
}

// 방송 기록의 (플랫폼, 채널) → 멤버 key
function ownerMap(list) {
  const owner = new Map();
  for (const m of list) {
    for (const id of m.youtubes) owner.set(`youtube:${id}`, m.id);
    for (const id of m.soops) owner.set(`soop:${id}`, m.id);
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
      is_live: m.is_live, yt_live: m.yt_live, soop_live: m.soop_live, soop_broad: m.soop_broad, soop_station: m.soop_station,
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
  const keys = [...m.youtubes.map((id) => ["youtube", id]), ...m.soops.map((id) => ["soop", id])];
  if (!keys.length) return [];
  const now = Date.now();
  return db.prepare(`SELECT platform, channel_id, broad_id, title, started_at, ended_at FROM broadcasts
    WHERE (${keys.map(() => "(platform = ? AND channel_id = ?)").join(" OR ")})
      AND started_at < ? AND COALESCE(ended_at, ?) > ? ORDER BY started_at DESC`)
    .all(...keys.flat(), to, now, from)
    .map((r) => ({ ...r, seconds: Math.round(((r.ended_at ?? now) - r.started_at) / 1000) }));
}

const isMonth = (v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || ""));
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) && !Number.isNaN(Date.parse(v));

/* ---------- 카테고리 ---------- */
const CATEGORIES = [
  { id: "game", name: "게임" }, { id: "talk", name: "토크/캠방" }, { id: "music", name: "음악/댄스" }, { id: "art", name: "그림/아트" },
  { id: "sports", name: "스포츠" }, { id: "travel", name: "여행" }, { id: "virtual", name: "버추얼" }, { id: "etc", name: "기타" },
];
function categoryGroup(platform, code, name = "") {
  const n = String(name || "");
  if (platform === "youtube") {
    return { 20: "game", 10: "music", 17: "sports", 19: "travel", 22: "talk", 23: "talk", 24: "talk" }[Number(code)] || "etc";
  }
  const c = String(code || "").padStart(8, "0");
  if (/그림|아트|미술|일러스트|공예/.test(n)) return "art";
  if (/버추얼|vtuber/i.test(n) || c.startsWith("0081")) return "virtual";
  if (/여행|낚시|아웃도어|캠핑/.test(n) || c.startsWith("0074") || c.startsWith("0067")) return "travel";
  if (/스포츠|축구|야구|농구|배구|골프|피트니스|격투|당구|e스포츠/i.test(n) || c.startsWith("0057")) return "sports";
  if (/뮤직|음악|댄스|노래/.test(n) || c.startsWith("0003")) return "music";
  if (/토크|캠방|먹방|쿡방|라디오|더빙|일상|취미|지식/.test(n) || ["0013", "0033", "0059", "0002", "0029"].some((p) => c.startsWith(p))) return "talk";
  if (c.startsWith("0004") || c.startsWith("0036") || /게임/.test(n)) return "game";
  return "etc";
}

/* ---------- 기간 ---------- */
const dayStart = (ms) => Math.floor((ms + KST) / DAY) * DAY - KST;            // 그날 KST 0시
const dayMs = (key) => Date.parse(`${key}T00:00:00+09:00`);
// period: today | yesterday | week | 30d | YYYY-MM | custom(from~to, YYYY-MM-DD)
function period(q = {}) {
  const now = Date.now(), today = dayStart(now);
  const p = String(q.period || "30d");
  let from, to, label;
  if (p === "today") [from, to, label] = [today, now, "오늘"];
  else if (p === "yesterday") [from, to, label] = [today - DAY, today, "어제"];
  else if (p === "week") {
    const dow = (new Date(now + KST).getUTCDay() + 6) % 7; // 월요일 = 0
    [from, to, label] = [today - dow * DAY, now, "이번 주"];
  } else if (isMonth(p)) {
    [from, to] = monthRange(p);
    to = Math.min(to, now);
    label = `${Number(p.slice(0, 4))}년 ${Number(p.slice(5))}월`;
  } else if (p === "custom" && isDay(q.from) && isDay(q.to)) {
    let [a, b] = [dayMs(q.from), dayMs(q.to)].sort((x, y) => x - y);
    a = Math.max(a, b - 365 * DAY);
    [from, to, label] = [a, Math.min(b + DAY, now), `${q.from} ~ ${q.to}`];
  } else [from, to, label] = [today - 29 * DAY, now, "최근 30일"];
  const key = ["today", "yesterday", "week", "custom"].includes(p) || isMonth(p) ? p : "30d";
  return { key, label, from, to, from_day: dayKey(from), to_day: dayKey(Math.max(from, to - 1)), rolling: to >= now - 60e3 };
}
function dayList(from, to) {
  const out = [];
  for (let t = dayStart(from); t < to; t += DAY) out.push(dayKey(t));
  return out;
}

/* ---------- 순위 (임의 기간 · 플랫폼 · 카테고리) ---------- */
const platformOk = (want, pf) => !want || want === "all" || want === pf;

// 기간 안의 방송 줄들 (기간 밖으로 나간 부분은 잘라서)
function rowsIn(from, to, { platform, category } = {}) {
  const now = Date.now();
  return db.prepare(`SELECT platform, channel_id, broad_id, title, started_at, COALESCE(ended_at, ?) AS ended_at, ended_at IS NULL AS open,
      category, category_name, peak_viewers, viewer_sum, viewer_samples
    FROM broadcasts WHERE started_at < ? AND COALESCE(ended_at, ?) > ?`).all(now, to, now, from)
    .filter((r) => platformOk(platform, r.platform) && (!category || category === "all" || (r.category || "etc") === category))
    .map((r) => ({ ...r, s: Math.max(r.started_at, from), e: Math.min(r.ended_at, to, now) }))
    .filter((r) => r.e > r.s);
}

function daysOf(merged) {
  const days = new Set();
  for (const [s, e] of merged) for (let t = s; t < e; t = dayStart(t) + DAY) days.add(dayKey(t));
  return days;
}

// 팔로워: 기간 끝 값 - 기간 시작 직전 값 (기록이 없으면 null)
function followerInfo(keys, fromDay, toDay) {
  if (!keys.length) return { now: null, gain: null };
  let now = 0, gain = 0, any = false, anyGain = false;
  for (const [pf, id] of keys) {
    const last = db.prepare("SELECT count FROM follower_daily WHERE platform = ? AND channel_id = ? AND day <= ? ORDER BY day DESC LIMIT 1").get(pf, id, toDay);
    if (!last) continue;
    any = true;
    now += last.count;
    const base = db.prepare("SELECT count FROM follower_daily WHERE platform = ? AND channel_id = ? AND day < ? ORDER BY day DESC LIMIT 1").get(pf, id, fromDay)
      || db.prepare("SELECT count FROM follower_daily WHERE platform = ? AND channel_id = ? AND day >= ? AND day <= ? ORDER BY day LIMIT 1").get(pf, id, fromDay, toDay);
    if (base) { gain += last.count - base.count; anyGain = true; }
  }
  return { now: any ? now : null, gain: anyGain ? gain : null };
}

const memberKeys = (m, platform) => [
  ...(platformOk(platform, "youtube") ? m.youtubes.map((id) => ["youtube", id]) : []),
  ...(platformOk(platform, "soop") ? m.soops.map((id) => ["soop", id]) : []),
];

function rankBy(items, key) {
  const sorted = [...items].sort((a, b) => b[key] - a[key] || b.seconds - a.seconds || a.name.localeCompare(b.name, "ko"));
  let rank = 0;
  sorted.forEach((it, i) => { it.rank = it[key] ? (i && sorted[i - 1][key] === it[key] ? rank : (rank = i + 1)) : null; });
  return sorted;
}

const SORT_KEY = { time: "seconds", peak: "peak", viewers: "live_viewers", followers: "follower_gain", donation: "donation" };

/* ---------- 후원 ---------- */
// 기간 안의 후원 줄 (카테고리를 고르면 그 카테고리 방송에서 받은 것만)
// 후원 단위가 달라서(SOOP 별풍선 개 · 유튜브 원) 한 번에 한 플랫폼만 셈
//   dplat=youtube 이거나 플랫폼을 유튜브로 고르면 유튜브(원), 아니면 SOOP(개)
const donationPlatform = (q = {}) => (q.dplat === "youtube" || q.dplat === "soop" ? q.dplat : q.platform === "youtube" ? "youtube" : "soop");
function donationsIn(from, to, { platform, category, dplat } = {}) {
  const dp = donationPlatform({ platform, dplat });
  let rows = db.prepare("SELECT platform, channel_id, broad_id, donor_id, donor_nick, amount, at FROM donations WHERE platform = ? AND at >= ? AND at < ?").all(dp, from, to)
    .filter((d) => platformOk(platform, d.platform));
  if (category && category !== "all") {
    const ok = new Set(rowsIn(from, to, { platform, category }).map((r) => `${r.platform}:${r.broad_id}`));
    rows = rows.filter((d) => ok.has(`${d.platform}:${d.broad_id}`));
  }
  return rows;
}
const donorKey = (d) => `${d.platform}:${d.donor_id}`;

// 후원자별 합계 (닉네임은 가장 최근 것)
function groupDonors(rows, owner, list) {
  const byId = new Map(list.map((m) => [m.id, m]));
  const map = new Map();
  for (const d of rows) {
    const k = donorKey(d);
    let x = map.get(k);
    if (!x) map.set(k, (x = { key: k, platform: d.platform, donor_id: d.donor_id, nick: d.donor_nick, total: 0, count: 0, first_at: d.at, last_at: d.at, to: new Map() }));
    x.total += d.amount; x.count++;
    if (d.at >= x.last_at) { x.last_at = d.at; if (d.donor_nick) x.nick = d.donor_nick; }
    x.first_at = Math.min(x.first_at, d.at);
    const mid = owner.get(`${d.platform}:${d.channel_id}`);
    if (mid) x.to.set(mid, (x.to.get(mid) || 0) + d.amount);
  }
  return [...map.values()].map((x) => ({
    ...x, nick: x.nick || x.donor_id,
    to: [...x.to].map(([id, amount]) => ({ id, name: byId.get(id)?.name || "", thumb: byId.get(id)?.thumb || null, amount })).sort((a, b) => b.amount - a.amount),
  })).sort((a, b) => b.total - a.total || a.nick.localeCompare(b.nick, "ko"));
}
function rankDonors(list) {
  let rank = 0;
  list.forEach((it, i) => { it.rank = i && list[i - 1].total === it.total ? rank : (rank = i + 1); });
  return list;
}

// 전체 후원자 랭킹 (member=멤버ID 를 주면 그 멤버가 받은 것만)
function donorRanking(q = {}) {
  const per = period(q);
  const list = members().filter((m) => !q.members || q.members.has(m.id));
  const owner = ownerMap(list);
  const pick = (rows) => rows.filter((d) => owner.has(`${d.platform}:${d.channel_id}`) && (!q.member || owner.get(`${d.platform}:${d.channel_id}`) === q.member));
  const rows = pick(donationsIn(per.from, per.to, q));
  const items = rankDonors(groupDonors(rows, owner, list));
  if (per.rolling && per.key !== "custom") {
    const prev = new Map(rankDonors(groupDonors(pick(donationsIn(per.from - DAY, per.to - DAY, q)), owner, list)).map((d) => [d.key, d.rank]));
    for (const it of items) { const b = prev.get(it.key); it.change = b == null ? "new" : b - it.rank; }
  }
  const total = rows.reduce((a, d) => a + d.amount, 0);
  // 받은 쪽(멤버) 합계
  const recv = new Map();
  for (const d of rows) { const id = owner.get(`${d.platform}:${d.channel_id}`); recv.set(id, (recv.get(id) || 0) + d.amount); }
  const receivers = [...recv].map(([id, amount]) => { const m = list.find((x) => x.id === id); return { id, name: m?.name || "", thumb: m?.thumb || null, amount }; }).sort((a, b) => b.amount - a.amount);
  return { period: per, dplat: donationPlatform(q), items, total, count: rows.length, donors: items.length, receivers, months: months(), updated_at: Date.now() };
}

// 후원자 1명 자세히
function donorDetail(key, q = {}) {
  const [platform, ...rest] = String(key).split(":");
  const donorId = rest.join(":");
  const per = period(q);
  const list = members().filter((m) => !q.members || q.members.has(m.id));
  const owner = ownerMap(list);
  const mine = db.prepare("SELECT platform, channel_id, broad_id, donor_id, donor_nick, amount, at FROM donations WHERE platform = ? AND donor_id = ? AND at >= ? AND at < ? ORDER BY at DESC")
    .all(platform, donorId, per.from, per.to).filter((d) => owner.has(`${d.platform}:${d.channel_id}`));
  const ever = db.prepare("SELECT donor_nick, MIN(at) AS first_at, MAX(at) AS last_at, SUM(amount) AS total FROM donations WHERE platform = ? AND donor_id = ?").get(platform, donorId);
  if (!ever?.last_at) return null;
  const nick = db.prepare("SELECT donor_nick FROM donations WHERE platform = ? AND donor_id = ? AND donor_nick != '' ORDER BY at DESC LIMIT 1").get(platform, donorId)?.donor_nick || donorId;
  const g = groupDonors(mine, owner, list)[0];
  const all = donorRanking({ ...q, period: q.period, dplat: platform });
  const me = all.items.find((x) => x.key === `${platform}:${donorId}`);
  const daily = dayList(per.from, per.to).map((day) => ({ day, donation: 0, count: 0 }));
  const idx = new Map(daily.map((d, i) => [d.day, i]));
  for (const d of mine) { const i = idx.get(dayKey(d.at)); if (i != null) { daily[i].donation += d.amount; daily[i].count++; } }
  const byId = new Map(list.map((m) => [m.id, m]));
  return {
    donor: { key: `${platform}:${donorId}`, platform, donor_id: donorId, nick, first_at: ever.first_at, last_at: ever.last_at, all_total: ever.total },
    period: per,
    summary: { rank: me?.rank ?? null, change: me?.change ?? null, of: all.items.length, total: g?.total || 0, count: g?.count || 0, members: g?.to.length || 0,
      max: mine.reduce((a, d) => Math.max(a, d.amount), 0) },
    to: g?.to || [],
    daily,
    recent: mine.slice(0, 100).map((d) => ({ at: d.at, amount: d.amount, member: byId.get(owner.get(`${d.platform}:${d.channel_id}`))?.name || "", member_id: owner.get(`${d.platform}:${d.channel_id}`) })),
  };
}

function stats(from, to, opts = {}) {
  const list = members().filter((m) => !opts.members || opts.members.has(m.id));
  const owner = ownerMap(list);
  const per = new Map(list.map((m) => [m.id, { intervals: [], sessions: 0, platforms: new Set(), peak: 0, vsum: 0, vn: 0, cats: {} }]));
  for (const r of rowsIn(from, to, opts)) {
    const p = per.get(owner.get(`${r.platform}:${r.channel_id}`));
    if (!p) continue;
    p.intervals.push([r.s, r.e]);
    p.sessions++;
    p.platforms.add(r.platform);
    p.peak = Math.max(p.peak, r.peak_viewers || 0);
    p.vsum += r.viewer_sum || 0;
    p.vn += r.viewer_samples || 0;
    const c = r.category || "etc";
    p.cats[c] = (p.cats[c] || 0) + (r.e - r.s);
  }
  const fromDay = dayKey(from), toDay = dayKey(Math.max(from, to - 1));
  const don = new Map();
  for (const d of donationsIn(from, to, opts)) {
    const id = owner.get(`${d.platform}:${d.channel_id}`);
    if (!id) continue;
    const x = don.get(id) || { sum: 0, donors: new Set() };
    x.sum += d.amount; x.donors.add(donorKey(d));
    don.set(id, x);
  }
  const items = list.map((m) => {
    const p = per.get(m.id);
    const merged = merge(p.intervals);
    const ms = merged.reduce((a, [s, e]) => a + e - s, 0);
    const mainCat = Object.entries(p.cats).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const fol = opts.withFollowers === false ? { now: null, gain: null } : followerInfo(memberKeys(m, opts.platform), fromDay, toDay);
    const liveHere = m.is_live && (platformOk(opts.platform, m.live_platform) || (opts.platform === "youtube" && m.yt_live));
    return {
      id: m.id, name: m.name, crew: m.crew, thumb: m.thumb,
      youtube: m.youtube, handle: m.handle, soop: m.soop,
      has_youtube: m.youtubes.length > 0, has_soop: m.soops.length > 0,
      is_live: !!liveHere, live_platform: liveHere ? (opts.platform === "youtube" ? "youtube" : m.live_platform) : null,
      live_url: liveHere ? (opts.platform === "youtube" && m.yt_live_id ? `https://www.youtube.com/watch?v=${m.yt_live_id}` : m.live_url) : null,
      live_viewers: liveHere ? (opts.platform === "youtube" ? m.yt_viewers || 0 : opts.platform === "soop" ? m.soop_viewers : m.live_viewers) : 0,
      seconds: Math.round(ms / 1000), days: daysOf(merged).size, sessions: p.sessions, platforms: [...p.platforms],
      peak: p.peak, avg: p.vn ? Math.round(p.vsum / p.vn) : 0, category: mainCat,
      followers: fol.now, follower_gain: fol.gain ?? 0, follower_known: fol.gain != null,
      donation: don.get(m.id)?.sum || 0, donors: don.get(m.id)?.donors.size || 0,
    };
  });
  return rankBy(items, SORT_KEY[opts.sort] || "seconds");
}

// 순위 + 어제 대비 변동 (기간이 지금까지 이어질 때만)
function ranking(q = {}) {
  const per = period(q);
  const opts = { platform: q.platform, category: q.category, sort: q.sort, members: q.members, dplat: q.dplat };
  const items = stats(per.from, per.to, opts);
  if (per.rolling && per.key !== "custom") {
    const prev = new Map(stats(per.from - DAY, per.to - DAY, { ...opts, withFollowers: false }).map((it) => [it.id, it.rank]));
    for (const it of items) {
      const before = prev.get(it.id);
      it.change = it.rank == null ? null : before == null ? "new" : before - it.rank;
    }
  }
  return { period: per, dplat: donationPlatform(opts), items, months: months(), categories: CATEGORIES, updated_at: Date.now() };
}

/* ---------- 멤버 자세히 ---------- */
function memberDetail(memberId, q = {}) {
  const m = members().find((x) => x.id === memberId);
  if (!m) return null;
  const per = period(q);
  const opts = { platform: q.platform, category: q.category, dplat: q.dplat };
  const all = ranking({ ...q, sort: "time" });
  const me = all.items.find((it) => it.id === memberId);
  const keys = memberKeys(m, q.platform);
  const mine = (r) => keys.some(([pf, id]) => pf === r.platform && id === r.channel_id);
  const rows = rowsIn(per.from, per.to, opts).filter(mine);

  // 날짜별
  const days = dayList(per.from, per.to);
  const byDay = new Map(days.map((d) => [d, { day: d, intervals: [], sessions: 0, peak: 0, vsum: 0, vn: 0 }]));
  for (const r of rows) {
    for (let t = r.s; t < r.e; ) {
      const end = Math.min(r.e, dayStart(t) + DAY);
      const d = byDay.get(dayKey(t));
      if (d) d.intervals.push([t, end]);
      t = end;
    }
    const d0 = byDay.get(dayKey(r.s));
    if (d0) { d0.sessions++; d0.peak = Math.max(d0.peak, r.peak_viewers || 0); d0.vsum += r.viewer_sum || 0; d0.vn += r.viewer_samples || 0; }
  }
  const folRows = keys.length ? db.prepare(`SELECT day, SUM(count) AS count FROM follower_daily
    WHERE (${keys.map(() => "(platform = ? AND channel_id = ?)").join(" OR ")}) AND day >= ? AND day <= ? GROUP BY day`).all(...keys.flat(), per.from_day, per.to_day) : [];
  const fol = new Map(folRows.map((r) => [r.day, r.count]));
  const daily = days.map((d) => {
    const x = byDay.get(d);
    return { day: d, seconds: Math.round(merge(x.intervals).reduce((a, [s, e]) => a + e - s, 0) / 1000), sessions: x.sessions,
      peak: x.peak, avg: x.vn ? Math.round(x.vsum / x.vn) : 0, followers: fol.get(d) ?? null, donation: null };
  });

  // 후원: 날짜별 · 방송별
  const owner = ownerMap([m]);
  const dons = donationsIn(per.from, per.to, { category: opts.category, dplat: donationPlatform(opts) }).filter((d) => owner.get(`${d.platform}:${d.channel_id}`) === m.id);
  const donDay = new Map(), donBroad = new Map();
  for (const d of dons) {
    donDay.set(dayKey(d.at), (donDay.get(dayKey(d.at)) || 0) + d.amount);
    donBroad.set(`${d.platform}:${d.broad_id}`, (donBroad.get(`${d.platform}:${d.broad_id}`) || 0) + d.amount);
  }
  for (const x of daily) x.donation = donDay.get(x.day) || 0;
  const donors = rankDonors(groupDonors(dons, owner, [m])).map(({ to, ...x }) => x);

  // 카테고리별 시간
  const cats = {};
  for (const r of rows) { const c = r.category || "etc"; cats[c] = (cats[c] || 0) + Math.round((r.e - r.s) / 1000); }

  // 지난 달들 순위 (최근 6개월)
  const history = months().slice(0, 6).map((mk) => {
    const [a, b] = monthRange(mk);
    const it = stats(a, Math.min(b, Date.now()), { ...opts, withFollowers: false }).find((x) => x.id === memberId);
    return { month: mk, rank: it?.rank ?? null, seconds: it?.seconds ?? 0 };
  });

  return {
    member: { id: m.id, name: m.name, thumb: m.thumb, youtube: m.youtube, handle: m.handle, soop: m.soop, soops: m.soops, youtubes: m.youtubes,
      is_live: m.is_live, live_url: m.live_url, live_platform: m.live_platform, live_viewers: m.live_viewers,
      live_title: m.soop_live ? m.soop_title : null },
    period: per,
    summary: me ? { rank: me.rank, change: me.change ?? null, total: all.items.filter((x) => x.rank).length, seconds: me.seconds, days: me.days,
      sessions: me.sessions, peak: me.peak, avg: me.avg, followers: me.followers, follower_gain: me.follower_known ? me.follower_gain : null,
      donation: me.donation, donors: me.donors } : null,
    daily,
    sessions: rows.sort((a, b) => b.started_at - a.started_at).map((r) => ({
      platform: r.platform, channel_id: r.channel_id, broad_id: r.broad_id, title: r.title, started_at: r.started_at, ended_at: r.open ? null : r.ended_at,
      seconds: Math.round(((r.open ? Date.now() : r.ended_at) - r.started_at) / 1000), peak: r.peak_viewers, avg: r.viewer_samples ? Math.round(r.viewer_sum / r.viewer_samples) : 0,
      category: r.category || "etc", category_name: r.category_name, donation: donBroad.get(`${r.platform}:${r.broad_id}`) || 0,
    })),
    categories: Object.entries(cats).map(([id, seconds]) => ({ id, seconds })).sort((a, b) => b.seconds - a.seconds),
    category_names: CATEGORIES,
    history,
    donation: { platform: donationPlatform(opts), total: dons.reduce((a, d) => a + d.amount, 0), count: dons.length, donors: donors.length, collected: !!db.prepare("SELECT 1 FROM donations WHERE platform = ? LIMIT 1").get(donationPlatform(opts)) },
    donors: donors.slice(0, 100),
    recent_donations: dons.sort((a, b) => b.at - a.at).slice(0, 50).map((d) => ({ at: d.at, nick: d.donor_nick || d.donor_id, key: donorKey(d), amount: d.amount })),
  };
}

module.exports = { donationPlatform, photoUrl, record, closeOthers, closeStale, followers, members, monthStats, months, sessions, monthKey, isMonth,
  categoryGroup, CATEGORIES, period, ranking, memberDetail, donorRanking, donorDetail };
