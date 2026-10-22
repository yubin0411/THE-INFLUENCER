(() => {
  const sigs = window.SITE_DATA?.sigs ?? [];
  const NEW_DAYS = 5;
  const PAGE_SIZE = 10;
  const SLIDER_COUNT = 20;
  const LIST_COUNT = 24;
  const REFRESH_MS = 60 * 1000;

  const site = { crews: [], members: [], user: null };
  let activeCrew = "all";
  const crewName = (id) => site.crews.find((c) => c.id === id)?.name ?? "";

  /* ---------- 메뉴 ---------- */
  function renderNav() {
    const items = [{ id: "all", name: "홈" }, ...site.crews];
    const html = items
      .map((c) => `<a href="#${c.id === "all" ? "home" : c.id}" data-crew="${c.id}" class="${c.id === activeCrew ? "is-active" : ""}">${esc(c.name)}</a>`)
      .join("");
    $("#desktop-nav").innerHTML = html;
    $("#mobile-nav").innerHTML = html;
  }

  function setCrew(id) {
    activeCrew = site.crews.some((c) => c.id === id) ? id : "all";
    showHome();
    renderNav();
    renderLive();
    renderCrewSections();
    sigPage = 1;
    renderSigs();
  }

  document.addEventListener("click", (e) => {
    const link = e.target.closest("[data-crew]");
    if (!link) return;
    e.preventDefault();
    history.replaceState(null, "", link.getAttribute("href"));
    setCrew(link.dataset.crew);
    closeMobileNav();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  const menuBtn = $("#menu-toggle");
  function closeMobileNav() {
    $("#mobile-nav").hidden = true;
    menuBtn.setAttribute("aria-expanded", "false");
  }
  menuBtn.addEventListener("click", () => {
    const nav = $("#mobile-nav");
    nav.hidden = !nav.hidden;
    menuBtn.setAttribute("aria-expanded", String(!nav.hidden));
  });

  initTheme($("#theme-toggle"));

  /* ---------- 로그인 상태 ---------- */
  function renderUser() {
    const u = site.user;
    $("#user-area").innerHTML = u
      ? `<span class="user-name">${esc(u.nickname)}님</span>
         ${u.role === "admin" ? '<a class="text-btn" href="admin.html">관리자</a>' : ""}
         <button class="ghost-btn" type="button" id="logout-btn">로그아웃</button>`
      : `<button class="primary-btn" type="button" data-open="modal-login">로그인</button>`;
  }

  document.addEventListener("click", async (e) => {
    if (e.target.closest("#logout-btn")) {
      await api("api/auth/logout", {}).catch(() => {});
      site.user = null;
      renderUser();
    }
  });

  // 로그인이 필요한 버튼은 로그인 창을 대신 띄움
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-need-login]");
    if (b && !site.user) {
      e.stopPropagation();
      const form = $("#auth-form");
      $(".form-note", form).textContent = "로그인 후 이용할 수 있습니다.";
      $("#modal-login").showModal();
    }
  }, true);

  const authForm = $("#auth-form");
  $$(".tab", authForm).forEach((tab) => tab.addEventListener("click", () => {
    const signup = tab.dataset.tab === "signup";
    authForm.dataset.mode = tab.dataset.tab;
    $$(".tab", authForm).forEach((t) => t.classList.toggle("is-active", t === tab));
    $$(".signup-only", authForm).forEach((el) => (el.hidden = !signup));
    ["password2", "nickname", "code"].forEach((n) => (authForm.elements[n].required = signup));
    authForm.elements.password.autocomplete = signup ? "new-password" : "current-password";
    $(".form-note", authForm).textContent = "";
  }));

  authForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(authForm));
    const note = $(".form-note", authForm);
    try {
      if (authForm.dataset.mode === "signup") {
        if (f.password !== f.password2) throw new Error("비밀번호가 서로 다릅니다.");
        const r = await api("api/auth/signup", f);
        note.textContent = r.message;
        authForm.reset();
        $('.tab[data-tab="login"]', authForm).click();
        note.textContent = r.message;
      } else {
        const r = await api("api/auth/login", { username: f.username, password: f.password });
        site.user = r.user;
        renderUser();
        authForm.reset();
        note.textContent = "";
        $("#modal-login").close();
      }
    } catch (err) {
      note.textContent = err.message;
    }
  });

  /* ---------- 요청 폼 ---------- */
  const readImage = (file) => new Promise((resolve, reject) => {
    if (!file || !file.size) return resolve(null);
    if (file.size > 5 * 1024 * 1024) return reject(new Error("사진은 5MB 이하만 올릴 수 있습니다."));
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error("사진을 읽을 수 없습니다."));
    r.readAsDataURL(file);
  });

  $$("form[data-request]").forEach((form) => form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const note = $(".form-note", form);
    const btn = $('[type="submit"]', form);
    btn.disabled = true;
    try {
      const f = Object.fromEntries(new FormData(form));
      const image = await readImage(f.image);
      const r = await api("api/requests", { ...f, image, type: form.dataset.request });
      form.reset();
      note.textContent = r.message;
    } catch (err) {
      note.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  }));

  /* ---------- 공통 카드 ---------- */
  const thumb = (src, alt) => (src ? `<img src="${esc(src)}" alt="${esc(alt)}" loading="lazy">` : `<div class="thumb-placeholder" aria-hidden="true"></div>`);
  const empty = (msg) => `<div class="empty">${msg}</div>`;
  const pad = (n) => String(n).padStart(2, "0");
  const fmtDuration = (s) => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  };

  const videoCard = (v) => v.type === "short"
    ? `<button type="button" class="short-card" data-video="${esc(v.id)}">
         <div class="thumb">${thumb(v.thumb, v.title)}<span class="play" aria-hidden="true">▶</span></div>
         <div class="card-info"><strong>${esc(v.title)}</strong><span>${esc(v.member)} · 조회 ${fmtCount(v.views)}</span></div>
       </button>`
    : `<button type="button" class="post-card" data-video="${esc(v.id)}">
         <div class="thumb">${thumb(v.thumb, v.title)}${v.duration ? `<span class="duration">${fmtDuration(v.duration)}</span>` : ""}</div>
         <div class="card-info"><strong>${esc(v.title)}</strong><span>${esc(v.member)} · 조회 ${fmtCount(v.views)} · ${fmtAgo(v.published_at)}</span></div>
       </button>`;

  /* ---------- 라이브 ---------- */
  let liveFilter = "all";
  let liveNow = [];

  async function loadLive() {
    try { liveNow = (await api("api/live")).live ?? []; } catch { liveNow = []; }
    renderLive();
  }

  function renderLive() {
    const crewLive = activeCrew === "all" ? liveNow : liveNow.filter((l) => l.crew === activeCrew);
    $("#home-live").hidden = crewLive.length === 0;

    const filters = [{ id: "all", name: "전체" }, ...site.crews.filter((c) => liveNow.some((l) => l.crew === c.id))];
    if (!filters.some((f) => f.id === liveFilter)) liveFilter = "all";
    $("#live-filter").innerHTML = activeCrew === "all" && filters.length > 2
      ? filters.map((f) => `<button type="button" class="chip ${f.id === liveFilter ? "is-active" : ""}" data-live="${f.id}">${esc(f.name)}</button>`).join("")
      : "";

    const list = activeCrew === "all" && liveFilter !== "all" ? crewLive.filter((l) => l.crew === liveFilter) : crewLive;
    $("#live-list").innerHTML = list.map((l) => `
      <a class="live-card" href="${esc(l.url)}" target="_blank" rel="noopener">
        <div class="thumb">${thumb(l.thumb, l.title)}<span class="badge-live">LIVE</span><span class="viewers">${(l.viewers || 0).toLocaleString()}명 시청</span></div>
        <div class="card-info"><strong>${esc(l.title)}</strong><span>${esc(l.member)}${l.crew ? ` · ${esc(crewName(l.crew))}` : ""}</span></div>
      </a>`).join("");
  }

  $("#live-filter").addEventListener("click", (e) => {
    const b = e.target.closest("[data-live]");
    if (!b) return;
    liveFilter = b.dataset.live;
    renderLive();
  });

  /* ---------- 크루별 게시글 / 쇼츠 슬라이더 ---------- */
  const TYPE_LABEL = { post: "게시글", short: "Shorts" };

  function renderCrewSections() {
    const crews = activeCrew === "all" ? site.crews : site.crews.filter((c) => c.id === activeCrew);
    const keys = ["post", "short"].flatMap((type) => crews.map((c) => ({ type, crew: c })));
    $("#crew-sections").innerHTML = keys.map(({ type, crew }) => {
      const key = `${type}-${crew.id}`;
      const title = `${esc(crew.name)} ${TYPE_LABEL[type]}`;
      return `
        <section class="panel" aria-labelledby="${key}-title">
          <div class="panel-head">
            <h2 id="${key}-title">${title}</h2>
            <div class="head-tools">
              <button type="button" class="ghost-btn" data-list="${type}" data-list-crew="${crew.id}">전체보기</button>
              <nav class="arrows" aria-label="${title} 넘기기">
                <button type="button" data-slide="${key}" data-dir="-1" aria-label="이전">‹</button>
                <button type="button" data-slide="${key}" data-dir="1" aria-label="다음">›</button>
              </nav>
            </div>
          </div>
          <div class="slider ${type === "short" ? "is-shorts" : ""}" id="slider-${key}" data-type="${type}" data-crew-id="${crew.id}">${empty("불러오는 중…")}</div>
        </section>`;
    }).join("");
    loadSliders();
  }

  async function loadSliders() {
    await Promise.all($$("#crew-sections .slider").map(async (el) => {
      try {
        const { items } = await api(`api/videos?type=${el.dataset.type}&crew=${encodeURIComponent(el.dataset.crewId)}&limit=${SLIDER_COUNT}`);
        el.innerHTML = items.length ? items.map(videoCard).join("") : empty("아직 올라온 영상이 없습니다.");
      } catch {
        el.innerHTML = empty("불러오지 못했습니다.");
      }
    }));
  }

  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-slide]");
    if (!btn) return;
    const slider = $(`#slider-${btn.dataset.slide}`);
    slider.scrollBy({ left: slider.clientWidth * 0.9 * Number(btn.dataset.dir), behavior: "smooth" });
  });

  /* ---------- 전체보기 ---------- */
  const list = { type: "post", crew: "", before: null };

  function showHome() {
    $("#home-view").hidden = false;
    $("#list-view").hidden = true;
  }

  async function openList(type, crew) {
    Object.assign(list, { type, crew, before: null });
    $("#list-title").textContent = `${crewName(crew)} ${TYPE_LABEL[type]}`;
    $("#list-grid").className = `video-grid ${type === "short" ? "is-shorts" : ""}`;
    $("#list-grid").innerHTML = "";
    $("#home-view").hidden = true;
    $("#list-view").hidden = false;
    window.scrollTo({ top: 0 });
    await loadMore();
  }

  async function loadMore() {
    const btn = $("#list-more");
    btn.disabled = true;
    try {
      const q = new URLSearchParams({ type: list.type, crew: list.crew, limit: LIST_COUNT, ...(list.before ? { before: list.before } : {}) });
      const { items, more } = await api(`api/videos?${q}`);
      $("#list-grid").insertAdjacentHTML("beforeend", items.map(videoCard).join(""));
      if (!list.before && !items.length) $("#list-grid").innerHTML = empty("아직 올라온 영상이 없습니다.");
      list.before = items.at(-1)?.published_at ?? list.before;
      btn.hidden = !more;
    } finally {
      btn.disabled = false;
    }
  }

  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-list]");
    if (b) openList(b.dataset.list, b.dataset.listCrew);
  });
  $("#list-more").addEventListener("click", loadMore);
  $("#list-back").addEventListener("click", () => { showHome(); window.scrollTo({ top: 0 }); });

  /* ---------- 자세히 보기 ---------- */
  const detail = $("#modal-detail");

  async function openDetail(id) {
    let v;
    try { v = await api(`api/videos/${encodeURIComponent(id)}`); } catch { return; }
    $("#detail-player").className = `detail-player ${v.type === "short" ? "is-short" : ""}`;
    $("#detail-player").innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${esc(v.id)}?autoplay=1&rel=0" title="${esc(v.title)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`;
    $("#detail-title").textContent = v.title;
    $("#detail-meta").innerHTML = `
      ${v.channel_thumb ? `<img class="avatar" src="${esc(v.channel_thumb)}" alt="">` : ""}
      <strong>${esc(v.member)}</strong>
      ${v.crew ? `<span class="tag">${esc(crewName(v.crew))}</span>` : ""}
      <span>조회수 ${v.views.toLocaleString()}회</span>
      <span>좋아요 ${v.likes.toLocaleString()}</span>
      <span>${fmtDate(v.published_at)}</span>`;
    $("#detail-desc").textContent = v.description;
    $("#detail-desc").hidden = !v.description;
    $("#detail-link").href = v.type === "short" ? `https://www.youtube.com/shorts/${v.id}` : `https://www.youtube.com/watch?v=${v.id}`;
    detail.showModal();
  }

  document.addEventListener("click", (e) => {
    const card = e.target.closest("[data-video]");
    if (card) openDetail(card.dataset.video);
  });
  detail.addEventListener("close", () => { $("#detail-player").innerHTML = ""; });

  /* ---------- 시그 가격표 ---------- */
  let sigPage = 1;
  let sigQuery = "";
  const isNew = (date) => date && (Date.now() - new Date(date).getTime()) / 864e5 <= NEW_DAYS;

  function renderSigs() {
    const q = sigQuery.trim().toLowerCase();
    const rows = (activeCrew === "all" ? sigs : sigs.filter((s) => s.crew === activeCrew))
      .filter((s) => !q || s.name.toLowerCase().includes(q) || String(s.price).includes(q))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    sigPage = Math.min(sigPage, pages);
    const page = rows.slice((sigPage - 1) * PAGE_SIZE, sigPage * PAGE_SIZE);

    $("#sig-list").innerHTML = page.length
      ? page.map((s) => `
        <tr>
          <td>${esc(s.name)} ${isNew(s.date) ? '<span class="badge-new">NEW</span>' : ""}</td>
          <td>${esc(crewName(s.crew))}</td>
          <td class="num">${Number(s.price || 0).toLocaleString()}</td>
          <td>${esc(s.date || "")}</td>
          <td class="center"><button type="button" class="mini-btn" data-sig="${sigs.indexOf(s)}" ${s.audio ? "" : "disabled"} aria-label="미리듣기">▶</button></td>
        </tr>`).join("")
      : `<tr><td colspan="5">${empty(q ? "검색 결과가 없습니다." : "등록된 시그가 없습니다.")}</td></tr>`;

    $("#sig-pages").innerHTML = pages > 1
      ? Array.from({ length: pages }, (_, i) => `<button type="button" data-page="${i + 1}" class="${i + 1 === sigPage ? "is-active" : ""}">${i + 1}</button>`).join("")
      : "";
  }

  $("#sig-search").addEventListener("input", (e) => { sigQuery = e.target.value; sigPage = 1; renderSigs(); });
  $("#sig-pages").addEventListener("click", (e) => {
    const b = e.target.closest("[data-page]");
    if (b) { sigPage = Number(b.dataset.page); renderSigs(); }
  });
  $("#sig-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-sig]");
    if (!b) return;
    const s = sigs[Number(b.dataset.sig)];
    $("#audio-title").textContent = s.name;
    $("#audio-frame").innerHTML = `<audio src="${esc(s.audio)}" controls autoplay></audio>`;
    $("#modal-audio").showModal();
  });
  $("#modal-audio").addEventListener("close", () => { $("#audio-frame").innerHTML = ""; });

  /* ---------- 시작 ---------- */
  async function loadSite() {
    try { Object.assign(site, await api("api/site")); } catch {}
    $("#backwall-member").innerHTML = site.members.length
      ? site.members.map((m) => `<option>${esc(m.name)}</option>`).join("")
      : "<option value=''>등록된 멤버가 없습니다</option>";
    renderUser();
  }

  $("#year").textContent = new Date().getFullYear();
  loadSite().then(() => {
    setCrew(location.hash.slice(1));
    loadLive();
    setInterval(loadLive, REFRESH_MS);
    // 새 영상 반영 (전체보기 화면에서는 갱신하지 않음)
    setInterval(() => { if (!$("#home-view").hidden) loadSliders(); }, REFRESH_MS * 5);
  });
})();
