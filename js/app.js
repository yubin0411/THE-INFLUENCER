(() => {
  const sigs = window.SITE_DATA?.sigs ?? [];
  const NEW_DAYS = 5;
  const PAGE_SIZE = 10;
  const SLIDER_COUNT = 20;
  const LIST_COUNT = 24;
  const REFRESH_MS = 60 * 1000;

  const site = { crews: [], members: [], user: null };
  const crewName = (id) => site.crews.find((c) => c.id === id)?.name ?? "";

  // 모든 크루 드롭다운에 공통으로 붙는 하위 메뉴
  const PAGES = [
    { id: "price", name: "전체 가격표" },
    { id: "sigs", name: "시그목록" },
    { id: "members", name: "멤버" },
    { id: "live", name: "Live" },
    { id: "posts", name: "게시글" },
    { id: "shorts", name: "쇼츠" },
    { id: "files", name: "파일 다운로드" },
    { id: "newsig", name: "뉴시그·안무영상" },
  ];
  const pageHref = (crew, page) => `#crew/${encodeURIComponent(crew)}/${page}`;

  /* ---------- 라우팅: #home, #crew/{크루id}/{메뉴} ---------- */
  let current = { crew: null, page: "home" };

  function parseRoute() {
    const m = location.hash.match(/^#crew\/([^/]+)(?:\/([^/]+))?$/);
    const crew = m && decodeURIComponent(m[1]);
    if (!crew || !site.crews.some((c) => c.id === crew)) return { crew: null, page: "home" };
    return { crew, page: PAGES.some((p) => p.id === m[2]) ? m[2] : PAGES[0].id };
  }

  function route() {
    current = parseRoute();
    renderNav();
    closeDropdowns();
    closeMobileNav();
    const home = current.page === "home";
    $("#home-view").hidden = !home;
    $("#page-view").hidden = home;
    if (home) {
      renderLive();
      renderCrewSections();
      renderHomeSigs();
    } else {
      renderPage();
    }
    window.scrollTo({ top: 0 });
  }
  window.addEventListener("hashchange", route);

  /* ---------- 상단 메뉴 (크루별 드롭다운) ---------- */
  function navHtml(prefix) {
    const homeLink = `<a href="#home" class="nav-link ${current.page === "home" ? "is-active" : ""}"><span class="nav-label">홈</span></a>`;
    const crews = site.crews.map((c) => {
      const active = c.id === current.crew;
      const menuId = `${prefix}-dd-${c.id}`;
      const items = PAGES.map((p) => {
        const here = active && p.id === current.page;
        return `<li><a href="${pageHref(c.id, p.id)}" class="${here ? "is-current" : ""}" ${here ? 'aria-current="page"' : ""}>${p.name}</a></li>`;
      }).join("");
      return `
        <div class="nav-item ${active ? "is-active" : ""}">
          <button type="button" class="nav-link dd-toggle" aria-expanded="false" aria-controls="${esc(menuId)}">
            <span class="nav-label">${esc(c.name)}</span><span class="caret" aria-hidden="true">▼</span>
          </button>
          <ul class="dd-menu" id="${esc(menuId)}" hidden>${items}</ul>
        </div>`;
    }).join("");
    return homeLink + crews;
  }

  function renderNav() {
    $("#desktop-nav").innerHTML = navHtml("d");
    $("#mobile-menu").innerHTML = navHtml("m");
  }

  function closeDropdowns(except) {
    $$(".dd-toggle[aria-expanded='true']").forEach((t) => {
      if (t === except) return;
      t.setAttribute("aria-expanded", "false");
      $(`#${CSS.escape(t.getAttribute("aria-controls"))}`).hidden = true;
    });
  }

  // 드롭다운: 누르면 열고, 다른 크루나 바깥을 누르면 닫음
  document.addEventListener("click", (e) => {
    const toggle = e.target.closest(".dd-toggle");
    if (toggle) {
      const open = toggle.getAttribute("aria-expanded") !== "true";
      closeDropdowns(toggle);
      toggle.setAttribute("aria-expanded", String(open));
      $(`#${CSS.escape(toggle.getAttribute("aria-controls"))}`).hidden = !open;
      return;
    }
    const menuItem = e.target.closest(".dd-menu a, .dd-menu button");
    if (menuItem || !e.target.closest(".dd-menu")) closeDropdowns();
    // 모바일 메뉴 안에서 이동하거나 창을 열면 메뉴를 접음
    if (e.target.closest("#mobile-nav a, #mobile-nav [data-open]")) closeMobileNav();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const open = $(".dd-toggle[aria-expanded='true']");
    if (open) { closeDropdowns(); open.focus(); }
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
    const myItems = [
      `<button type="button" data-open="modal-backwall" data-need-login>백월 요청</button>`,
      `<button type="button" data-open="modal-recommend" data-need-login>추천 노래</button>`,
      u?.role === "admin" ? `<a href="admin.html">관리자 페이지</a>` : "",
    ].filter(Boolean);
    $("#user-area").innerHTML = u
      ? `<div class="nav-item">
           <button type="button" class="text-btn dd-toggle" aria-expanded="false" aria-controls="my-menu">내 메뉴 <span class="caret" aria-hidden="true">▼</span></button>
           <ul class="dd-menu align-right" id="my-menu" hidden>
             <li class="dd-head">${esc(u.nickname)}님</li>
             ${myItems.map((i) => `<li>${i}</li>`).join("")}
           </ul>
         </div>
         <button class="ghost-btn" type="button" data-logout>로그아웃</button>`
      : `<button class="primary-btn" type="button" data-open="modal-login">로그인</button>`;
    $("#mobile-user").innerHTML = u
      ? `<p class="mobile-user-name">${esc(u.nickname)}님</p>
         ${myItems.join("")}
         <button type="button" data-logout>로그아웃</button>`
      : `<button class="primary-btn wide" type="button" data-open="modal-login">로그인</button>`;
  }

  document.addEventListener("click", async (e) => {
    if (e.target.closest("[data-logout]")) {
      closeMobileNav();
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
    if (current.page === "home") renderLive();
    if (current.page === "live") renderPage();
  }

  const liveCard = (l) => `
      <a class="live-card" href="${esc(l.url)}" target="_blank" rel="noopener">
        <div class="thumb">${thumb(l.thumb, l.title)}<span class="badge-live">LIVE</span><span class="viewers">${(l.viewers || 0).toLocaleString()}명 시청</span></div>
        <div class="card-info"><strong>${esc(l.title)}</strong><span>${esc(l.member)}${l.crew ? ` · ${esc(crewName(l.crew))}` : ""}</span></div>
      </a>`;

  function renderLive() {
    $("#home-live").hidden = liveNow.length === 0;
    const filters = [{ id: "all", name: "전체" }, ...site.crews.filter((c) => liveNow.some((l) => l.crew === c.id))];
    if (!filters.some((f) => f.id === liveFilter)) liveFilter = "all";
    $("#live-filter").innerHTML = filters.length > 2
      ? filters.map((f) => `<button type="button" class="chip ${f.id === liveFilter ? "is-active" : ""}" data-live="${f.id}">${esc(f.name)}</button>`).join("")
      : "";
    const list = liveFilter === "all" ? liveNow : liveNow.filter((l) => l.crew === liveFilter);
    $("#live-list").innerHTML = list.map(liveCard).join("");
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
    const keys = ["post", "short"].flatMap((type) => site.crews.map((c) => ({ type, crew: c })));
    $("#crew-sections").innerHTML = keys.map(({ type, crew }) => {
      const key = `${type}-${crew.id}`;
      const title = `${esc(crew.name)} ${TYPE_LABEL[type]}`;
      return `
        <section class="panel" aria-labelledby="${key}-title">
          <div class="panel-head">
            <h2 id="${key}-title">${title}</h2>
            <div class="head-tools">
              <a class="ghost-btn" href="${pageHref(crew.id, type === "short" ? "shorts" : "posts")}">전체보기</a>
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

  /* ---------- 크루 페이지 ---------- */
  const list = { type: "post", crew: "", before: null };

  function renderPage() {
    const { crew, page } = current;
    const title = PAGES.find((p) => p.id === page).name;
    $("#page-crumb").textContent = crewName(crew);
    $("#page-title").textContent = title;
    $("#page-tools").innerHTML = "";
    $("#list-more").hidden = true;
    $("#page-tabs").innerHTML = PAGES.map((p) =>
      `<a href="${pageHref(crew, p.id)}" class="${p.id === page ? "is-current" : ""}" ${p.id === page ? 'aria-current="page"' : ""}>${p.name}</a>`).join("");
    const body = $("#page-body");
    const crewSigs = () => sigs.filter((s) => s.crew === crew);

    if (page === "price") {
      $("#page-tools").innerHTML = `<label class="search"><span class="sr-only">시그 검색</span><input type="search" placeholder="시그 이름 · 가격 검색"></label>`;
      body.innerHTML = `
        <div class="table-wrap"><table class="sig-table">
          <thead><tr><th>시그</th><th>크루</th><th class="num">가격</th><th>등록일</th><th class="center">미리듣기</th></tr></thead>
          <tbody></tbody>
        </table></div>
        <nav class="pagination" aria-label="가격표 페이지"></nav>`;
      sigTable({ search: $("#page-tools input"), body: $("tbody", body), pager: $(".pagination", body), rows: crewSigs });
    } else if (page === "sigs") {
      const rows = crewSigs().sort((a, b) => (a.price || 0) - (b.price || 0) || a.name.localeCompare(b.name));
      body.innerHTML = rows.length
        ? `<ul class="sig-grid">${rows.map((s) => `
            <li class="sig-item">
              <span class="sig-name">${esc(s.name)} ${isNew(s.date) ? '<span class="badge-new">NEW</span>' : ""}</span>
              <span class="sig-price">${Number(s.price || 0).toLocaleString()}</span>
              <button type="button" class="mini-btn" data-sig="${sigs.indexOf(s)}" ${s.audio ? "" : "disabled"} aria-label="${esc(s.name)} 미리듣기">▶</button>
            </li>`).join("")}</ul>`
        : empty("등록된 시그가 없습니다.");
    } else if (page === "members") {
      const members = site.members.filter((m) => m.crew === crew);
      body.innerHTML = members.length
        ? `<div class="member-grid">${members.map((m) => `
            <a class="member-card" href="https://www.youtube.com/${m.handle ? esc(m.handle) : `channel/${esc(m.id)}`}" target="_blank" rel="noopener">
              ${m.thumb ? `<img src="${esc(m.thumb)}" alt="" loading="lazy">` : `<span class="member-avatar" aria-hidden="true"></span>`}
              ${m.is_live ? '<span class="badge-live">LIVE</span>' : ""}
              <strong>${esc(m.name)}</strong>
            </a>`).join("")}</div>`
        : empty("등록된 멤버가 없습니다. 관리자 페이지의 유튜브 채널에서 이 크루로 채널을 추가하세요.");
    } else if (page === "live") {
      const lives = liveNow.filter((l) => l.crew === crew);
      body.innerHTML = lives.length ? `<div class="live-grid">${lives.map(liveCard).join("")}</div>` : empty("지금 방송 중인 멤버가 없습니다.");
    } else if (page === "posts" || page === "shorts") {
      Object.assign(list, { type: page === "shorts" ? "short" : "post", crew, before: null });
      body.innerHTML = `<div class="video-grid ${page === "shorts" ? "is-shorts" : ""}" id="list-grid"></div>`;
      loadMore();
    } else if (page === "files") {
      body.innerHTML = empty("아직 등록된 파일이 없습니다.");
    } else if (page === "newsig") {
      body.innerHTML = empty("아직 등록된 뉴시그·안무영상이 없습니다.");
    }
  }

  async function loadMore() {
    const btn = $("#list-more");
    const grid = $("#list-grid");
    const req = { ...list };
    btn.disabled = true;
    try {
      const q = new URLSearchParams({ type: req.type, crew: req.crew, limit: LIST_COUNT, ...(req.before ? { before: req.before } : {}) });
      const { items, more } = await api(`api/videos?${q}`);
      if (grid !== $("#list-grid")) return; // 그새 다른 페이지로 이동함
      grid.insertAdjacentHTML("beforeend", items.map(videoCard).join(""));
      if (!req.before && !items.length) grid.innerHTML = empty("아직 올라온 영상이 없습니다.");
      list.before = items.at(-1)?.published_at ?? list.before;
      btn.hidden = !more;
    } catch {
      if (grid === $("#list-grid") && !req.before) grid.innerHTML = empty("불러오지 못했습니다.");
    } finally {
      btn.disabled = false;
    }
  }

  $("#list-more").addEventListener("click", loadMore);

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
  const isNew = (date) => date && (Date.now() - new Date(date).getTime()) / 864e5 <= NEW_DAYS;

  // 검색 + 페이지 나누기가 있는 시그 표 (홈의 "새로 들어온 시그", 크루별 "전체 가격표")
  function sigTable({ search, body, pager, rows }) {
    let page = 1;
    const render = () => {
      const q = search.value.trim().toLowerCase();
      const list = rows()
        .filter((s) => !q || s.name.toLowerCase().includes(q) || String(s.price).includes(q))
        .sort((a, b) => String(b.date).localeCompare(String(a.date)));
      const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
      page = Math.min(page, pages);
      const shown = list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

      body.innerHTML = shown.length
        ? shown.map((s) => `
          <tr>
            <td>${esc(s.name)} ${isNew(s.date) ? '<span class="badge-new">NEW</span>' : ""}</td>
            <td>${esc(crewName(s.crew))}</td>
            <td class="num">${Number(s.price || 0).toLocaleString()}</td>
            <td>${esc(s.date || "")}</td>
            <td class="center"><button type="button" class="mini-btn" data-sig="${sigs.indexOf(s)}" ${s.audio ? "" : "disabled"} aria-label="미리듣기">▶</button></td>
          </tr>`).join("")
        : `<tr><td colspan="5">${empty(q ? "검색 결과가 없습니다." : "등록된 시그가 없습니다.")}</td></tr>`;

      pager.innerHTML = pages > 1
        ? Array.from({ length: pages }, (_, i) => `<button type="button" data-page="${i + 1}" class="${i + 1 === page ? "is-active" : ""}">${i + 1}</button>`).join("")
        : "";
    };
    search.addEventListener("input", () => { page = 1; render(); });
    pager.addEventListener("click", (e) => {
      const b = e.target.closest("[data-page]");
      if (b) { page = Number(b.dataset.page); render(); }
    });
    render();
    return render;
  }

  let renderHomeSigs = () => {};

  document.addEventListener("click", (e) => {
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
    renderHomeSigs = sigTable({ search: $("#sig-search"), body: $("#sig-list"), pager: $("#sig-pages"), rows: () => sigs });
    route();
    loadLive();
    setInterval(loadLive, REFRESH_MS);
    // 새 영상 반영 (홈 화면에서만)
    setInterval(() => { if (current.page === "home") loadSliders(); }, REFRESH_MS * 5);
  });
})();
