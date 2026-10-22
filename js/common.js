// 사이트·관리자 페이지 공용 도우미
window.$ = (sel, root = document) => root.querySelector(sel);
window.$$ = (sel, root = document) => [...root.querySelectorAll(sel)];

window.esc = (s = "") =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

window.api = async (url, body) => {
  const res = await fetch(url, body === undefined
    ? { cache: "no-store" }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "요청에 실패했습니다.");
  return data;
};

window.fmtDate = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
};

window.fmtCount = (n = 0) => (n >= 1e8 ? `${(n / 1e8).toFixed(1)}억` : n >= 1e4 ? `${(n / 1e4).toFixed(1)}만` : n.toLocaleString());

window.fmtAgo = (ms) => {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "방금 전";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}일 전`;
  return fmtDate(ms);
};

window.fmtSize = (n = 0) =>
  n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)}GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`;

// 테마 전환 버튼
window.initTheme = (btn) => {
  const sync = () => ($(".theme-label", btn).textContent = document.documentElement.dataset.theme === "dark" ? "White" : "Dark");
  btn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("eternal-theme", next); } catch {}
    sync();
  });
  sync();
};

// 모달 공통: [data-open] 열기, [data-close]/배경 클릭 닫기
document.addEventListener("click", (e) => {
  const opener = e.target.closest("[data-open]");
  if (opener) $(`#${opener.dataset.open}`)?.showModal();
  const closer = e.target.closest("[data-close]");
  if (closer) closer.closest("dialog")?.close();
  if (e.target.tagName === "DIALOG") e.target.close();
});
