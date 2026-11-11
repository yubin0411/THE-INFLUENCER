/*
 * 구글 시트 → 시그 목록
 *  - 공개 시트("링크가 있는 사람은 누구나 보기")를 xlsx 로 받아서 읽습니다. (추가 설치 없이 직접 해석)
 *  - 첫 번째 탭에서 제목 줄(시그 이름 · 단가 …)을 찾아, 관리자 페이지 엑셀 업로드와 같은 형태로 돌려줍니다.
 *  - 파일 이름 칸에 걸린 링크(구글 드라이브 등)도 함께 읽습니다.
 */
const zlib = require("zlib");

/* ---------- zip ---------- */
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("엑셀 파일이 아닙니다.");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("엑셀 파일을 읽을 수 없습니다.");
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    files.set(name, { method, data: buf.subarray(start, start + size) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return (name) => {
    const f = files.get(name);
    if (!f) return null;
    return (f.method === 8 ? zlib.inflateRawSync(f.data) : f.data).toString("utf8");
  };
}

/* ---------- xml ---------- */
const decode = (s = "") => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[\da-f]+);/gi, (_, e) => {
  const map = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
  if (map[e.toLowerCase()]) return map[e.toLowerCase()];
  return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
});
const attr = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
const texts = (xml) => [...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1])).join("");
function rels(xml) {
  const map = new Map();
  for (const m of (xml || "").matchAll(/<Relationship\b[^>]*>/g)) map.set(attr(m[0], "Id"), decode(attr(m[0], "Target") || ""));
  return map;
}
// "AB12" → [행, 열] (0부터)
function cellRef(ref) {
  const m = String(ref).match(/^([A-Z]+)(\d+)/);
  if (!m) return null;
  let c = 0;
  for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64;
  return [Number(m[2]) - 1, c - 1];
}

// 첫 번째 탭의 칸들: Map("행,열" → { v: 값, link: 링크 })
function readFirstSheet(buf) {
  const read = unzip(buf);
  const wb = read("xl/workbook.xml") || "";
  const firstSheet = wb.match(/<sheet\b[^>]*>/)?.[0];
  const rid = firstSheet && attr(firstSheet, "r:id");
  let target = rels(read("xl/_rels/workbook.xml.rels")).get(rid) || "worksheets/sheet1.xml";
  target = target.replace(/^\/?xl\//, "").replace(/^\//, "");
  const path = `xl/${target}`;
  const sheet = read(path);
  if (!sheet) throw new Error("시트를 찾을 수 없습니다.");

  const shared = [...(read("xl/sharedStrings.xml") || "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]));
  const cells = new Map();
  for (const m of sheet.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const pos = cellRef(attr(m[1], "r"));
    if (!pos || !m[2]) continue;
    const type = attr(m[1], "t");
    const raw = m[2].match(/<v>([\s\S]*?)<\/v>/)?.[1];
    let v = type === "s" ? shared[Number(raw)] ?? "" : type === "inlineStr" ? texts(m[2]) : decode(raw ?? "");
    if ((!type || type === "n") && v !== "" && Number.isFinite(Number(v))) v = Number(v); // "300.0" → 300
    const cell = { v };
    // =HYPERLINK("주소", "글자") 수식
    const f = m[2].match(/<f>([\s\S]*?)<\/f>/)?.[1];
    const hl = f && decode(f).match(/HYPERLINK\(\s*"([^"]+)"/i);
    if (hl) cell.link = hl[1];
    cells.set(pos.join(","), cell);
  }

  // 칸에 걸린 링크
  const sheetName = path.split("/").pop();
  const linkRels = rels(read(path.replace(sheetName, `_rels/${sheetName}.rels`)));
  for (const m of sheet.matchAll(/<hyperlink\b[^>]*>/g)) {
    const url = linkRels.get(attr(m[0], "r:id"));
    const pos = cellRef((attr(m[0], "ref") || "").split(":")[0]);
    if (!url || !pos) continue;
    const key = pos.join(",");
    cells.set(key, { v: "", ...cells.get(key), link: url });
  }
  return cells;
}

// 관리자 페이지 엑셀 업로드(js/admin.js readExcel)와 같은 규칙으로 줄 만들기
//  - 시그 표: 제목 줄(시그 이름 · 단가 …)을 찾아서 아래 줄들
//  - 신호탄 표: 제목 줄(맴버 · 금액 · 링크)을 찾아서 분류 "신호탄"(표 위 칸의 글자)으로
const MATCH = { exclude: /제외/, category: /분류/, name: /이름/, price: /단가|가격/, ref: /레퍼런스|유튜브/, lessons: /레슨/ };
const SIGNAL = { name: /^(맴버|멤버)(이름)?$/, price: /금액|단가|가격/, ref: /링크|신호탄|음원/ };

function extractRows(cell, maxR, maxC) {
  const text = (r, c) => String(cell(r, c)?.v ?? "").trim();
  const rows = [];
  let mainName;
  for (let head = 0; head <= Math.min(maxR, 20); head++) {
    const cols = {};
    for (let c = 0; c <= maxC; c++) {
      const t = text(head, c).replace(/\s/g, "");
      for (const [key, re] of Object.entries(MATCH)) {
        if (!re.test(t)) continue;
        if (key === "ref") (cols.refs ||= []).push(c); // 레퍼런스1 · 2 · 3 … 칸 모두
        else if (cols[key] === undefined) cols[key] = c;
        break;
      }
    }
    if (cols.name === undefined) continue;
    mainName = cols.name;
    // 칸 글자가 주소면 그 주소, 아니면 칸에 걸린 링크
    const url = (r, c) => { const t = text(r, c); return /^https?:\/\//i.test(t) ? t : cell(r, c)?.link || ""; };
    for (let r = head + 1; r <= maxR; r++) {
      const name = text(r, cols.name);
      if (!name) continue;
      rows.push({
        exclude: text(r, cols.exclude),
        category: text(r, cols.category),
        name,
        price: cell(r, cols.price)?.v ?? "",
        ref: (cols.refs || []).map((c) => url(r, c)).filter(Boolean).join("\n"),
        lessons: text(r, cols.lessons),
        lessonLink: cell(r, cols.lessons)?.link || "",
      });
    }
    break;
  }

  // 신호탄 표 (시그 표와 다른 칸에 있는 "맴버 · 금액 · 링크")
  for (let head = 0; head <= Math.min(maxR, 20); head++) {
    for (let c = 0; c <= maxC; c++) {
      if (c === mainName || !SIGNAL.name.test(text(head, c).replace(/\s/g, ""))) continue;
      const right = (re) => { for (let x = c + 1; x <= Math.min(maxC, c + 4); x++) if (re.test(text(head, x).replace(/\s/g, ""))) return x; };
      const pc = right(SIGNAL.price), lc = right(SIGNAL.ref);
      if (pc === undefined) continue;
      const category = (head > 0 && text(head - 1, c)) || "신호탄";
      for (let r = head + 1; r <= maxR; r++) {
        const name = text(r, c);
        if (!name) break;
        const t = lc === undefined ? "" : text(r, lc);
        rows.push({
          exclude: "", category, name, price: cell(r, pc)?.v ?? "",
          ref: (/^https?:\/\//i.test(t) ? t : "") || (lc === undefined ? "" : cell(r, lc)?.link || ""),
          lessons: "", lessonLink: "",
        });
      }
      return rows;
    }
  }
  return rows;
}

function sigRows(buf) {
  const cells = readFirstSheet(buf);
  let maxR = 0, maxC = 0;
  for (const k of cells.keys()) { const [r, c] = k.split(",").map(Number); maxR = Math.max(maxR, r); maxC = Math.max(maxC, c); }
  return extractRows((r, c) => (c === undefined ? undefined : cells.get(`${r},${c}`)), maxR, maxC);
}

// 구글 시트 주소 → 시트 ID
function sheetId(url) {
  const id = String(url || "").match(/\/spreadsheets\/d\/([\w-]{20,})/)?.[1];
  if (!id) throw new Error("구글 시트 주소를 넣으세요. (https://docs.google.com/spreadsheets/d/…)");
  return id;
}

async function fetchSigRows(url) {
  const r = await fetch(`https://docs.google.com/spreadsheets/d/${sheetId(url)}/export?format=xlsx`, { signal: AbortSignal.timeout(30000), redirect: "follow" });
  const type = r.headers.get("content-type") || "";
  if (!r.ok || !type.includes("spreadsheetml")) {
    throw new Error(r.status === 404 ? "시트를 찾을 수 없습니다." : "시트를 받을 수 없습니다. 시트 공유를 \"링크가 있는 모든 사용자 → 뷰어\"로 바꿔 주세요.");
  }
  return sigRows(Buffer.from(await r.arrayBuffer()));
}

module.exports = { sheetId, sigRows, fetchSigRows };
