/*
 * SOOP(구 아프리카TV) 방송 확인
 *  - 관리자가 등록한 SOOP 방송국만 다룹니다.
 *  - 1분마다 방송국 정보(공개 API)로 방송 중인지 확인 → 방송 기록(broadcasts)에 남김
 */
const { db } = require("./db");
const broadcasts = require("./broadcasts");

const UA = { "User-Agent": "Mozilla/5.0" };
const https = (u) => (u && u.startsWith("//") ? `https:${u}` : u || null);
// SOOP 시각은 한국 시간 "2026-11-11 16:31:04"
const kstTime = (s) => Date.parse(`${String(s).replace(" ", "T")}+09:00`) || null;

// 아이디, 방송국 주소, 방송 주소 모두 받아서 아이디로
function parseId(input) {
  const v = String(input || "").trim();
  if (!/^https?:\/\//i.test(v) && !v.includes("/")) return v.toLowerCase();
  const parts = v.replace(/^https?:\/\/[^/]+/i, "").split(/[/?#]/).filter(Boolean);
  return (parts.find((p) => !["station", "live", "player"].includes(p.toLowerCase())) || "").toLowerCase();
}

async function station(id) {
  const r = await fetch(`https://chapi.sooplive.co.kr/api/${encodeURIComponent(id)}/station`, { headers: UA, signal: AbortSignal.timeout(10000) });
  const body = await r.json().catch(() => null);
  if (body?.code === 9000 || r.status === 404) throw Object.assign(new Error("SOOP 방송국을 찾을 수 없습니다."), { notFound: true });
  if (!r.ok || !body?.station) throw new Error(`SOOP API ${r.status}`);
  const st = body.station;
  const b = body.broad;
  return {
    id: st.user_id || id,
    nick: st.user_nick || "",
    thumb: https(body.profile_image),
    live: b ? {
      broad_no: String(b.broad_no),
      title: b.broad_title || "",
      viewers: Number(b.current_sum_viewer || 0),
      started_at: kstTime(st.broad_start) || Date.now(),
    } : null,
  };
}

// 방송국 홈: 방송자가 직접 쓴 글(공지) + 다시보기 VOD
const upsertPost = db.prepare(`INSERT INTO soop_posts (id, kind, station_id, title, summary, thumb, duration, views, is_notice, posted_at, seen_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET title = excluded.title, summary = excluded.summary, thumb = excluded.thumb, duration = excluded.duration,
    views = excluded.views, is_notice = excluded.is_notice, seen_at = excluded.seen_at`);

async function posts(id) {
  const r = await fetch(`https://chapi.sooplive.co.kr/api/${encodeURIComponent(id)}/home`, { headers: UA, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`SOOP API ${r.status}`);
  const body = await r.json();
  const now = Date.now();
  const own = (x) => String(x.user_id || "").toLowerCase() === id; // 방송자 본인이 올린 것만
  const plain = (t) => String(t || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  for (const b of (body.boards || []).filter(own)) {
    upsertPost.run(String(b.title_no), "post", id, plain(b.title_name), plain(b.content), https(b.thumb) || null, 0,
      Number(b.count?.read_cnt || 0), b.is_notice ? 1 : 0, kstTime(b.reg_date) || now, now);
  }
  for (const v of (body.vods || []).filter(own)) {
    upsertPost.run(String(v.title_no), "vod", id, plain(v.title_name), "", https(v.ucc?.thumb) || null,
      Math.round(Number(v.ucc?.total_file_duration || 0) / 1000), Number(v.count?.read_cnt || 0), 0, kstTime(v.reg_date) || now, now);
  }
}

async function pollPosts() {
  const ids = db.prepare("SELECT id FROM soop_channels").all().map((r) => r.id);
  for (let i = 0; i < ids.length; i += 5) {
    await Promise.all(ids.slice(i, i + 5).map((id) => posts(id).catch((e) => console.error(`[soop-posts:${id}]`, e.message))));
  }
}

async function resolve(input) {
  const id = parseId(input);
  if (!/^[a-z0-9_]{2,40}$/.test(id)) throw new Error("SOOP 아이디나 방송국 주소를 입력하세요.");
  return station(id);
}

const setLive = db.prepare(`UPDATE soop_channels SET nick = ?, thumb = COALESCE(?, thumb), live = ?, broad_no = ?, title = ?, viewers = ?, checked_at = ? WHERE id = ?`);

// 방송국 하나 확인 + 기록
async function check(id) {
  const s = await station(id);
  const now = Date.now();
  if (s.live) {
    broadcasts.record({ platform: "soop", channel_id: id, broad_id: s.live.broad_no, title: s.live.title, started_at: s.live.started_at });
    broadcasts.closeOthers("soop", id, s.live.broad_no);
    setLive.run(s.nick, s.thumb, 1, s.live.broad_no, s.live.title, s.live.viewers, now, id);
  } else {
    broadcasts.closeOthers("soop", id, null);
    setLive.run(s.nick, s.thumb, 0, null, "", 0, now, id);
  }
  return s;
}

async function poll() {
  const ids = db.prepare("SELECT id FROM soop_channels").all().map((r) => r.id);
  for (let i = 0; i < ids.length; i += 5) {
    await Promise.all(ids.slice(i, i + 5).map((id) => check(id).catch((e) => console.error(`[soop:${id}]`, e.message))));
  }
  broadcasts.closeStale();
}

function startScheduler() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await poll(); } catch (e) { console.error("[soop]", e.message); } finally { running = false; }
  };
  tick();
  setInterval(tick, 60 * 1000);

  // 공지 · VOD: 2분마다
  let busy = false;
  const postTick = async () => {
    if (busy) return;
    busy = true;
    try { await pollPosts(); } catch (e) { console.error("[soop-posts]", e.message); } finally { busy = false; }
  };
  setTimeout(postTick, 15 * 1000);
  setInterval(postTick, 2 * 60 * 1000);
}

module.exports = { resolve, check, poll, posts, pollPosts, startScheduler, parseId };
