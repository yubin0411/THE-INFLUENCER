(() => {
  let sigs = [];
  const NEW_DAYS = 5;
  const PAGE_SIZE = 20;
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
  const pageHref = (crew, page, channel) => `#crew/${encodeURIComponent(crew)}/${page}${channel ? `/${encodeURIComponent(channel)}` : ""}`;

  /* ---------- 라우팅: #home, #crew/{크루id}/{메뉴} ---------- */
  let current = { crew: null, page: "home", channel: null };

  // #crew/{크루}/{메뉴}/{채널} — 채널은 게시글·쇼츠에서 계정별로 볼 때만 붙음
  function parseRoute() {
    const m = location.hash.match(/^#crew\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?$/);
    const crew = m && decodeURIComponent(m[1]);
    if (!crew || !site.crews.some((c) => c.id === crew)) return { crew: null, page: "home", channel: null };
    const page = PAGES.some((p) => p.id === m[2]) ? m[2] : PAGES[0].id;
    const channel = m[3] && decodeURIComponent(m[3]);
    const valid = (page === "posts" || page === "shorts") && site.members.some((mb) => mb.id === channel && mb.crew === crew);
    return { crew, page, channel: valid ? channel : null };
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
        if (openSigId) openSig(openSigId);
        if (current.page === "files") renderPage();
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
            <h2 id="${key}-title">${title} <span class="head-note">계정별 최신</span></h2>
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
        const { items } = await api(`api/videos?type=${el.dataset.type}&crew=${encodeURIComponent(el.dataset.crewId)}&latest=1&limit=${SLIDER_COUNT}`);
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
  const list = { type: "post", crew: "", channel: "", before: null };
  const channelUrl = (m) => `https://www.youtube.com/${m.handle ? m.handle : `channel/${m.id}`}`;
  const avatar = (m) => (m.thumb ? `<img src="${esc(m.thumb)}" alt="" loading="lazy">` : `<span class="member-avatar" aria-hidden="true"></span>`);

  function renderPage() {
    const { crew, page, channel } = current;
    const title = PAGES.find((p) => p.id === page).name;
    const member = site.members.find((m) => m.id === channel);
    $("#page-crumb").textContent = crewName(crew);
    $("#page-title").textContent = member ? `${title} · ${member.name}` : title;
    $("#page-tools").innerHTML = "";
    $("#list-more").hidden = true;
    $("#page-tabs").innerHTML = PAGES.map((p) =>
      `<a href="${pageHref(crew, p.id, p.id === "posts" || p.id === "shorts" ? channel : null)}" class="${p.id === page ? "is-current" : ""}" ${p.id === page ? 'aria-current="page"' : ""}>${p.name}</a>`).join("");
    const body = $("#page-body");
    const crewSigs = () => sigs.filter((s) => s.crew === crew);

    if (page === "price") {
      const cats = [...new Set(crewSigs().map((s) => s.category).filter(Boolean))];
      let cat = "";
      $("#page-tools").innerHTML = `
        <label class="search"><span class="sr-only">시그 검색</span><input type="search" placeholder="시그 이름 · 단가 검색"></label>
        <label class="select"><span class="sr-only">정렬</span>
          <select><option value="sheet">기본 순서</option><option value="low">단가 낮은 순</option><option value="high">단가 높은 순</option><option value="new">최신 등록 순</option></select>
        </label>`;
      body.innerHTML = `
        ${cats.length > 1 ? `<div class="chips cat-chips">${["", ...cats].map((c) => `<button type="button" class="chip ${c ? "" : "is-active"}" data-cat="${esc(c)}">${c ? esc(c) : "전체"}</button>`).join("")}</div>` : ""}
        <div class="table-wrap"><table class="sig-table">
          <thead><tr><th>분류</th><th>시그 이름</th><th class="num">시그단가</th><th class="center">레퍼런스 · 레슨</th></tr></thead>
          <tbody></tbody>
        </table></div>
        <nav class="pagination" aria-label="가격표 페이지"></nav>`;
      const sortSel = $("#page-tools select");
      const render = sigTable({
        search: $("#page-tools input"), body: $("tbody", body), pager: $(".pagination", body),
        rows: () => crewSigs().filter((s) => !cat || s.category === cat), sort: () => sortSel.value,
      });
      sortSel.addEventListener("change", render);
      $$("[data-cat]", body).forEach((b) => b.addEventListener("click", () => {
        cat = b.dataset.cat;
        $$("[data-cat]", body).forEach((x) => x.classList.toggle("is-active", x === b));
        render();
      }));
    } else if (page === "sigs") {
      const groups = new Map();
      for (const s of crewSigs()) {
        const k = s.category || "기타";
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(s);
      }
      body.innerHTML = groups.size
        ? [...groups].map(([cat, list]) => `
            <section class="sig-group">
              <h3>${esc(cat)} <span class="muted">${list.length}</span></h3>
              <div class="sig-cards">${list.sort((a, b) => a.price - b.price).map(sigCard).join("")}</div>
            </section>`).join("")
        : empty("등록된 시그가 없습니다.");
    } else if (page === "newsig") {
      const list = crewSigs().filter((s) => s.lessons).sort((a, b) => b.last_lesson_at - a.last_lesson_at);
      body.innerHTML = list.length
        ? `<p class="hint">레슨 영상이 올라온 시그를 최근 순서로 보여줍니다. 누르면 레퍼런스와 레슨 영상을 볼 수 있어요.</p>
           <div class="sig-cards">${list.map((s) => sigCard(s, true)).join("")}</div>`
        : empty("아직 등록된 뉴시그·안무영상이 없습니다.");
    } else if (page === "files") {
      body.innerHTML = empty("불러오는 중…");
      api(`api/files?crew=${encodeURIComponent(crew)}`).then(({ items, locked }) => {
        if (current.crew !== crew || current.page !== "files") return;
        body.innerHTML = items.length
          ? `${locked ? `<p class="lock-note">파일은 승인된 회원만 받을 수 있어요. <button type="button" class="primary-btn" data-open="modal-login">로그인</button></p>` : ""}
             <ul class="file-rows">${items.map((f) => `
               <li>
                 <span class="file-icon" aria-hidden="true">${esc((f.orig_name.split(".").pop() || "file").slice(0, 4).toUpperCase())}</span>
                 <span class="file-info"><strong>${esc(f.title)}</strong><span>${esc(f.orig_name)} · ${fmtSize(f.size)} · ${fmtDate(f.created_at)}</span></span>
                 ${f.href ? `<a class="ghost-btn" href="${esc(f.href)}" download>다운로드</a>` : ""}
               </li>`).join("")}</ul>`
          : empty("아직 등록된 파일이 없습니다.");
      }).catch(() => { body.innerHTML = empty("불러오지 못했습니다."); });
    } else if (page === "members") {
      const members = site.members.filter((m) => m.crew === crew);
      body.innerHTML = members.length
        ? `<div class="member-grid">${members.map((m) => `
            <div class="member-card">
              <a class="member-main" href="${pageHref(crew, "posts", m.id)}">
                ${avatar(m)}
                ${m.is_live ? '<span class="badge-live">LIVE</span>' : ""}
                <strong>${esc(m.name)}</strong>
              </a>
              <span class="member-links">
                <a href="${pageHref(crew, "posts", m.id)}">게시글</a>
                <a href="${pageHref(crew, "shorts", m.id)}">쇼츠</a>
                <a href="${esc(channelUrl(m))}" target="_blank" rel="noopener">유튜브 ↗</a>
              </span>
            </div>`).join("")}</div>`
        : empty("등록된 멤버가 없습니다. 관리자 페이지의 유튜브 채널에서 이 크루로 채널을 추가하세요.");
    } else if (page === "live") {
      const lives = liveNow.filter((l) => l.crew === crew);
      body.innerHTML = lives.length ? `<div class="live-grid">${lives.map(liveCard).join("")}</div>` : empty("지금 방송 중인 멤버가 없습니다.");
    } else if (page === "posts" || page === "shorts") {
      Object.assign(list, { type: page === "shorts" ? "short" : "post", crew, channel: channel || "", before: null });
      const members = site.members.filter((m) => m.crew === crew);
      const chips = members.length > 1 || channel
        ? `<nav class="member-chips" aria-label="계정별 보기">
             <a href="${pageHref(crew, page)}" class="${channel ? "" : "is-current"}">전체</a>
             ${members.map((m) => `<a href="${pageHref(crew, page, m.id)}" class="${m.id === channel ? "is-current" : ""}" ${m.id === channel ? 'aria-current="true"' : ""}>${avatar(m)}${esc(m.name)}</a>`).join("")}
           </nav>`
        : "";
      body.innerHTML = `${chips}<div class="video-grid ${page === "shorts" ? "is-shorts" : ""}" id="list-grid"></div>`;
      loadMore();
    }
  }

  async function loadMore() {
    const btn = $("#list-more");
    const grid = $("#list-grid");
    const req = { ...list };
    btn.disabled = true;
    try {
      const q = new URLSearchParams({ type: req.type, crew: req.crew, limit: LIST_COUNT, ...(req.channel ? { channel: req.channel } : {}), ...(req.before ? { before: req.before } : {}) });
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

  /* ---------- 시그 ---------- */
  const isNew = (ms) => ms && (Date.now() - ms) / 864e5 <= NEW_DAYS;
  const won = (n) => `${Number(n || 0).toLocaleString()}원`;
  const SORTS = {
    sheet: () => 0,
    low: (a, b) => a.price - b.price,
    high: (a, b) => b.price - a.price,
    new: (a, b) => b.created_at - a.created_at,
  };
  const sigBadges = (s) =>
    `${s.ref_url ? '<span class="pill">레퍼런스</span>' : ""}${s.lessons ? `<span class="pill on">레슨 ${s.lessons}</span>` : ""}`;

  const sigCard = (s, showDate) => `
    <button type="button" class="sig-card" data-sig-open="${s.id}">
      <strong>${esc(s.name)} ${isNew(s.created_at) ? '<span class="badge-new">NEW</span>' : ""}</strong>
      <span class="sig-price">${won(s.price)}</span>
      <span class="sig-badges">${sigBadges(s)}${showDate && s.last_lesson_at ? `<span class="muted">${fmtAgo(s.last_lesson_at)}</span>` : ""}</span>
    </button>`;

  // 검색 + 페이지 나누기가 있는 시그 표 (홈의 "새로 들어온 시그", 크루별 "전체 가격표")
  function sigTable({ search, body, pager, rows, sort = () => "sheet", showCrew = false }) {
    let page = 1;
    const render = () => {
      const q = search.value.trim().toLowerCase().replace(/,/g, "");
      const list = rows()
        .filter((s) => !q || s.name.toLowerCase().includes(q) || String(s.price).includes(q))
        .sort(SORTS[sort()] || SORTS.sheet);
      const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
      page = Math.min(page, pages);
      const shown = list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

      body.innerHTML = shown.length
        ? shown.map((s) => `
          <tr class="clickable" data-sig-open="${s.id}">
            <td><span class="cat">${esc(s.category)}</span></td>
            <td><strong>${esc(s.name)}</strong> ${isNew(s.created_at) ? '<span class="badge-new">NEW</span>' : ""}</td>
            ${showCrew ? `<td>${esc(crewName(s.crew))}</td>` : ""}
            <td class="num">${won(s.price)}</td>
            <td class="center">${sigBadges(s)}</td>
          </tr>`).join("")
        : `<tr><td colspan="${showCrew ? 5 : 4}">${empty(q ? "검색 결과가 없습니다." : "등록된 시그가 없습니다.")}</td></tr>`;

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
    return () => { page = 1; render(); };
  }

  let renderHomeSigs = () => {};

  /* 시그 자세히: 유튜브 레퍼런스 + 레슨 영상 */
  const ytId = (u) => String(u).match(/(?:youtu\.be\/|\/shorts\/|\/live\/|\/embed\/|[?&]v=)([\w-]{11})/)?.[1];
  const driveId = (u) => String(u).match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?id=)([\w-]{10,})/)?.[1];

  function player(url, title) {
    const yt = ytId(url);
    if (yt) {
      const vertical = /\/shorts\//.test(url);
      return `<div class="player ${vertical ? "vertical" : ""}"><iframe src="https://www.youtube-nocookie.com/embed/${yt}?rel=0" title="${esc(title)}" allow="encrypted-media; picture-in-picture; fullscreen" allowfullscreen loading="lazy"></iframe></div>`;
    }
    const drive = driveId(url);
    if (drive) return `<div class="player"><iframe src="https://drive.google.com/file/d/${drive}/preview" title="${esc(title)}" allow="autoplay; fullscreen" allowfullscreen loading="lazy"></iframe></div>`;
    return `<a class="ghost-btn" href="${esc(url)}" target="_blank" rel="noopener">영상 열기 ↗</a>`;
  }

  let openSigId = null;
  async function openSig(id) {
    let s;
    try { s = await api(`api/sigs/${id}`); } catch { return; }
    openSigId = id;
    $("#sig-crumb").textContent = [crewName(s.crew), s.category].filter(Boolean).join(" · ");
    $("#sig-title").innerHTML = `${esc(s.name)} <span class="sig-price">${won(s.price)}</span>`;
    const lessons = s.locked
      ? `<p class="lock-note">레슨 영상은 승인된 회원만 볼 수 있어요. <button type="button" class="primary-btn" data-open="modal-login">로그인</button></p>`
      : s.items.length
        ? s.items.map((l) => `
            <figure class="lesson-item">
              ${l.kind === "file" ? `<div class="player video"><video src="${esc(l.src)}" controls preload="metadata" playsinline></video></div>` : player(l.url, l.title || s.name)}
              ${l.title ? `<figcaption>${esc(l.title)}</figcaption>` : ""}
            </figure>`).join("")
        : `<p class="hint">아직 올라온 레슨 영상이 없습니다.</p>`;
    $("#sig-media").innerHTML = `
      <section><h3>유튜브 레퍼런스</h3>${s.ref_url ? player(s.ref_url, s.name) : '<p class="hint">등록된 레퍼런스가 없습니다.</p>'}</section>
      <section><h3>레슨 영상 ${s.items.length > 1 ? `<span class="muted">${s.items.length}</span>` : ""}</h3>${lessons}</section>`;
    if (!$("#modal-sig").open) $("#modal-sig").showModal();
  }

  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-sig-open]");
    if (el) openSig(el.dataset.sigOpen);
  });
  $("#modal-sig").addEventListener("close", () => { $("#sig-media").innerHTML = ""; openSigId = null; });

  /* ---------- 시작 ---------- */
  async function loadSite() {
    try { Object.assign(site, await api("api/site")); } catch {}
    try { sigs = await api("api/sigs"); } catch { sigs = []; }
    $("#backwall-member").innerHTML = site.members.length
      ? site.members.map((m) => `<option>${esc(m.name)}</option>`).join("")
      : "<option value=''>등록된 멤버가 없습니다</option>";
    renderUser();
  }

  $("#year").textContent = new Date().getFullYear();
  loadSite().then(() => {
    renderHomeSigs = sigTable({ search: $("#sig-search"), body: $("#sig-list"), pager: $("#sig-pages"), rows: () => sigs, sort: () => "new", showCrew: true });
    route();
    loadLive();
    setInterval(loadLive, REFRESH_MS);
    // 새 영상 반영 (홈 화면에서만)
    setInterval(() => { if (current.page === "home") loadSliders(); }, REFRESH_MS * 5);
  });
})();
