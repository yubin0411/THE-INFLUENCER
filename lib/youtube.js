/*
 * 유튜브 동기화
 *  - 관리자가 등록한 채널만 다룹니다.
 *  - 채널 등록 시: 업로드 목록에서 최근 영상 최대 BACKFILL_MAX 개를 가져와 저장
 *  - 1분마다: 채널 RSS(할당량 0)로 새 영상 확인 + 라이브 상태 갱신
 *  - 30분마다: 최근 영상 조회수 등 갱신
 *  저장된 영상은 계속 누적됩니다. (유튜브에서 삭제·비공개된 영상만 지워짐)
 */
const { db, tx } = require("./db");

const API_KEY = () => process.env.YOUTUBE_API_KEY || "";
const BACKFILL_MAX = 200;
const SHORTS_MAX_SEC = 180;

async function yt(endpoint, params) {
  const r = await fetch(`https://www.googleapis.com/youtube/v3/${endpoint}?${new URLSearchParams({ ...params, key: API_KEY() })}`);
  const body = await r.json();
  if (!r.ok) throw new Error(body.error?.message || `YouTube API ${r.status}`);
  return body;
}

const bestThumb = (t = {}) => (t.maxres || t.high || t.medium || t.default)?.url || null;

function parseDuration(iso = "") {
  const m = iso.match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  const [, d = 0, h = 0, mi = 0, s = 0] = m.map((x) => Number(x) || 0);
  return d * 86400 + h * 3600 + mi * 60 + s;
}

// "@핸들", 채널 주소, 채널 ID 모두 받아서 채널 정보로 변환
async function resolveChannel(input) {
  const value = String(input || "").trim();
  if (!value) throw new Error("채널을 입력하세요.");
  const id = value.match(/(UC[\w-]{22})/)?.[1];
  const handle = id ? null : value.match(/@([^/?#\s]+)/)?.[1] ?? value.replace(/^https?:\/\/[^/]+\//, "");
  const res = await yt("channels", { part: "snippet,contentDetails", ...(id ? { id } : { forHandle: decodeURIComponent(handle) }) });
  const ch = res.items?.[0];
  if (!ch) throw new Error("유튜브 채널을 찾을 수 없습니다.");
  return {
    id: ch.id,
    title: ch.snippet.title,
    handle: ch.snippet.customUrl || null,
    thumb: bestThumb(ch.snippet.thumbnails),
    uploads: ch.contentDetails.relatedPlaylists.uploads,
  };
}

// 쇼츠 판별: youtube.com/shorts/ID 가 200이면 쇼츠, 일반 영상은 watch 로 리다이렉트
async function isShort(id) {
  try {
    const r = await fetch(`https://www.youtube.com/shorts/${id}`, { method: "HEAD", redirect: "manual" });
    return r.status === 200;
  } catch {
    return false;
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const n = i++; out[n] = await fn(items[n]); }
  }));
  return out;
}

const selectType = db.prepare("SELECT type, live FROM videos WHERE id = ?");
const upsert = db.prepare(`
  INSERT INTO videos (id, channel_id, type, live, title, description, thumb, published_at, duration, views, likes, viewers, updated_at)
  VALUES (:id, :channel_id, :type, :live, :title, :description, :thumb, :published_at, :duration, :views, :likes, :viewers, :updated_at)
  ON CONFLICT(id) DO UPDATE SET
    type = excluded.type, live = excluded.live, title = excluded.title, description = excluded.description,
    thumb = excluded.thumb, published_at = excluded.published_at, duration = excluded.duration,
    views = excluded.views, likes = excluded.likes, viewers = excluded.viewers, updated_at = excluded.updated_at
`);
const deleteVideo = db.prepare("DELETE FROM videos WHERE id = ?");

// 영상 ID 목록의 상세 정보를 가져와 저장 (50개씩 = 할당량 1)
async function syncVideos(ids) {
  ids = [...new Set(ids)];
  if (!ids.length) return 0;
  const known = new Set(db.prepare("SELECT id FROM channels").all().map((c) => c.id));
  let saved = 0;

  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const res = await yt("videos", { part: "snippet,contentDetails,statistics,liveStreamingDetails", id: chunk.join(",") });
    const items = (res.items || []).filter((v) => known.has(v.snippet.channelId));

    const rows = await mapLimit(items, 6, async (v) => {
      const live = v.snippet.liveBroadcastContent || "none";
      const duration = parseDuration(v.contentDetails?.duration);
      const prev = selectType.get(v.id);
      let type = prev?.type || "post";
      // 처음 보거나, 라이브가 끝나서 처음 일반 영상이 된 경우에만 쇼츠 확인
      if (live === "none" && (!prev || prev.live !== "none") && duration > 0 && duration <= SHORTS_MAX_SEC && !v.liveStreamingDetails) {
        type = (await isShort(v.id)) ? "short" : "post";
      }
      const lsd = v.liveStreamingDetails || {};
      return {
        id: v.id,
        channel_id: v.snippet.channelId,
        type,
        live,
        title: v.snippet.title,
        description: v.snippet.description || "",
        thumb: bestThumb(v.snippet.thumbnails),
        published_at: Date.parse(lsd.actualStartTime || v.snippet.publishedAt) || Date.now(),
        duration,
        views: Number(v.statistics?.viewCount || 0),
        likes: Number(v.statistics?.likeCount || 0),
        viewers: Number(lsd.concurrentViewers || 0),
        updated_at: Date.now(),
      };
    });

    const returned = new Set(items.map((v) => v.id));
    tx(() => {
      for (const r of rows) upsert.run(r);
      // 유튜브에서 삭제/비공개된 영상은 정리
      for (const id of chunk) if (!returned.has(id)) deleteVideo.run(id);
    });
    saved += rows.length;
  }
  return saved;
}

async function rssVideoIds(channelId) {
  try {
    const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
    if (!r.ok) return [];
    return [...(await r.text()).matchAll(/<yt:videoId>([\w-]+)<\/yt:videoId>/g)].map((m) => m[1]);
  } catch {
    return [];
  }
}

// 채널 처음 등록 시 과거 영상 가져오기
async function backfillChannel(channel) {
  const ids = [];
  let pageToken;
  do {
    const res = await yt("playlistItems", { part: "contentDetails", playlistId: channel.uploads, maxResults: 50, ...(pageToken ? { pageToken } : {}) });
    ids.push(...res.items.map((i) => i.contentDetails.videoId));
    pageToken = res.nextPageToken;
  } while (pageToken && ids.length < BACKFILL_MAX);
  const n = await syncVideos(ids.slice(0, BACKFILL_MAX));
  db.prepare("UPDATE channels SET synced_at = ? WHERE id = ?").run(Date.now(), channel.id);
  return n;
}

// 1분마다: 새 영상 + 라이브/예정 영상만 조회 (할당량 절약)
async function quickPoll() {
  const channels = db.prepare("SELECT id FROM channels").all();
  const rssIds = (await mapLimit(channels, 6, (c) => rssVideoIds(c.id))).flat();
  const existing = new Set(rssIds.length ? db.prepare(`SELECT id FROM videos WHERE id IN (${rssIds.map(() => "?").join(",")})`).all(...rssIds).map((r) => r.id) : []);
  const liveIds = db.prepare("SELECT id FROM videos WHERE live != 'none'").all().map((r) => r.id);
  await syncVideos([...rssIds.filter((id) => !existing.has(id)), ...liveIds]);
}

// 30분마다: RSS 에 있는 최근 영상 전체 갱신 (조회수 등)
async function fullRefresh() {
  const channels = db.prepare("SELECT id FROM channels").all();
  const rssIds = (await mapLimit(channels, 6, (c) => rssVideoIds(c.id))).flat();
  await syncVideos(rssIds);
  db.prepare("UPDATE channels SET synced_at = ?").run(Date.now());
}

function startScheduler() {
  if (!API_KEY()) return console.warn("⚠ YOUTUBE_API_KEY 가 없어 유튜브 동기화가 꺼져 있습니다.");
  let running = false;
  const guard = (fn, label) => async () => {
    if (running) return;
    running = true;
    try { await fn(); } catch (e) { console.error(`[youtube:${label}]`, e.message); } finally { running = false; }
  };
  const poll = guard(quickPoll, "poll");
  const refresh = guard(fullRefresh, "refresh");
  refresh();
  setInterval(poll, 60 * 1000);
  setInterval(refresh, 30 * 60 * 1000);
}

module.exports = { resolveChannel, backfillChannel, quickPoll, startScheduler };
