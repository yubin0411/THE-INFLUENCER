/*
 * 유튜브 라이브 채팅 → 슈퍼챗 · 슈퍼스티커 기록
 *  - 등록된 채널의 라이브 방송(videos.live = 'live')의 채팅을 주기적으로 읽음 (API 키로 공개 채팅 읽기)
 *  - 슈퍼챗 · 슈퍼스티커가 있으면 donations 에 원(₩) 단위로 저장 (외화는 대략 환율로 환산)
 *  - 할당량: 채팅 읽기 1번 = 5. 기본 60초마다 → 방송 1개당 시간당 약 300
 *    .env 의 YT_CHAT_SEC 로 간격 조절 (예: 30), YT_CHAT=0 이면 끔
 */
const { db } = require("./db");

const API_KEY = () => process.env.YOUTUBE_API_KEY || "";
const EVERY = () => Math.max(15, Number(process.env.YT_CHAT_SEC) || 60) * 1000;

// 원화가 아닌 슈퍼챗은 대략 환율로 원 환산 (정확한 정산용이 아니라 랭킹용)
const KRW_RATE = { KRW: 1, USD: 1400, JPY: 9.3, EUR: 1500, GBP: 1780, TWD: 43, HKD: 180, CAD: 1000, AUD: 910, SGD: 1050, PHP: 24, THB: 40, VND: 0.055, IDR: 0.088, MYR: 315 };

async function yt(endpoint, params) {
  const r = await fetch(`https://www.googleapis.com/youtube/v3/${endpoint}?${new URLSearchParams({ ...params, key: API_KEY() })}`, { signal: AbortSignal.timeout(15000) });
  const body = await r.json();
  if (!r.ok) throw Object.assign(new Error(body.error?.message || `YouTube API ${r.status}`), { status: r.status, reason: body.error?.errors?.[0]?.reason });
  return body;
}

const insert = db.prepare(`INSERT OR IGNORE INTO donations (platform, channel_id, broad_id, donor_id, donor_nick, amount, kind, at, ext_id)
  VALUES ('youtube', ?, ?, ?, ?, ?, ?, ?, ?)`);

// 영상 ID → { channelId, chatId, pageToken, nextAt }
const chats = new Map();

function save(v, items) {
  for (const m of items) {
    const sn = m.snippet || {};
    const d = sn.type === "superChatEvent" ? sn.superChatDetails : sn.type === "superStickerEvent" ? sn.superStickerDetails : null;
    if (!d) continue;
    const rate = KRW_RATE[d.currency];
    if (!rate) continue; // 모르는 통화는 건너뜀
    const won = Math.round((Number(d.amountMicros) / 1e6) * rate);
    if (!(won > 0)) continue;
    const a = m.authorDetails || {};
    insert.run(v.channelId, v.videoId, a.channelId || sn.authorChannelId || "unknown", a.displayName || "", won,
      sn.type === "superChatEvent" ? "superchat" : "supersticker", Date.parse(sn.publishedAt) || Date.now(), m.id);
  }
}

async function readChat(v) {
  const res = await yt("liveChat/messages", { liveChatId: v.chatId, part: "snippet,authorDetails", maxResults: 2000, ...(v.pageToken ? { pageToken: v.pageToken } : {}) });
  save(v, res.items || []);
  v.pageToken = res.nextPageToken || v.pageToken;
  v.nextAt = Date.now() + Math.max(EVERY(), Number(res.pollingIntervalMillis) || 0);
}

let quotaUntil = 0;
async function tick() {
  if (!API_KEY() || process.env.YT_CHAT === "0" || Date.now() < quotaUntil) return;
  const live = db.prepare(`SELECT v.id, v.channel_id FROM videos v JOIN channels c ON c.id = v.channel_id WHERE v.live = 'live'`).all();
  const liveIds = new Set(live.map((r) => r.id));
  for (const id of chats.keys()) if (!liveIds.has(id)) chats.delete(id); // 끝난 방송 정리

  // 새로 시작한 라이브: 채팅방 ID 받기 (50개씩 = 할당량 1)
  const fresh = live.filter((r) => !chats.has(r.id));
  for (let i = 0; i < fresh.length; i += 50) {
    const res = await yt("videos", { part: "liveStreamingDetails", id: fresh.slice(i, i + 50).map((r) => r.id).join(",") });
    for (const it of res.items || []) {
      const chatId = it.liveStreamingDetails?.activeLiveChatId;
      const row = fresh.find((r) => r.id === it.id);
      // 채팅이 꺼진 방송은 10분 뒤 다시 확인
      chats.set(it.id, { videoId: it.id, channelId: row.channel_id, chatId, pageToken: null, nextAt: chatId ? 0 : Date.now() + 10 * 60 * 1000 });
    }
  }

  for (const v of chats.values()) {
    if (!v.chatId) { if (Date.now() >= v.nextAt) chats.delete(v.videoId); continue; }
    if (Date.now() < v.nextAt) continue;
    try { await readChat(v); }
    catch (e) {
      if (e.reason === "quotaExceeded" || e.reason === "rateLimitExceeded") { quotaUntil = Date.now() + 30 * 60 * 1000; console.error("[ytchat] 할당량 초과 → 30분 쉼"); return; }
      if (e.status === 403 || e.status === 404) { v.chatId = null; v.nextAt = Date.now() + 10 * 60 * 1000; } // 채팅 종료 · 비공개
      console.error(`[ytchat:${v.videoId}]`, e.message);
    }
  }
}

function startScheduler() {
  if (!API_KEY()) return;
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try { await tick(); } catch (e) { console.error("[ytchat]", e.message); } finally { running = false; }
  }, 5 * 1000);
}

const status = () => [...chats.values()].map((v) => ({ video: v.videoId, channel: v.channelId, chat: !!v.chatId }));

module.exports = { startScheduler, status, save };
