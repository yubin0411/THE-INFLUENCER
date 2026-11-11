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
  // 한 크루만 쓰는 사이트: 상단 메뉴에 바로 나오는 페이지들
  const PAGES = [
    { id: "price", name: "가격표" },
    { id: "sigs", name: "시그목록" },
    { id: "members", name: "멤버" },
    { id: "live", name: "LIVE", hide: true },      // hide: 상단 메뉴에는 안 보임 (홈의 전체보기로 들어감)
    { id: "notice", name: "공지", hide: true },
    { id: "vod", name: "VOD", hide: true },
    { id: "shorts", name: "쇼츠", hide: true },
    { id: "files", name: "파일 다운로드" },
    { id: "newsig", name: "뉴시그·안무영상" },
  ];
  const MEMBER_PAGES = ["notice", "vod", "shorts"]; // 멤버별로 골라 볼 수 있는 페이지
  const OLD_PAGES = { posts: "notice" };
  const mainCrew = () => site.crews[0]?.id || "";
  const inCrew = (x) => !x.crew || x.crew === mainCrew();

  /* ---------- 플랫폼 로고 ---------- */
  const LOGO = {
    youtube: '<svg class="pf-logo yt" viewBox="0 0 28 20" role="img" aria-label="YouTube"><rect width="28" height="20" rx="5" fill="#FF0000"/><path d="M11.2 5.6 18.8 10l-7.6 4.4z" fill="#fff"/></svg>',
    soop: '<span class="pf-logo soop" role="img" aria-label="SOOP">SOOP</span>',
  };
  const logo = (pf) => LOGO[pf === "soop" ? "soop" : "youtube"];
  const fillLogos = (root = document) => $$("[data-logos]", root).forEach((el) => { el.innerHTML = el.dataset.logos.split(" ").map(logo).join(""); });
  const pageHref = (crew, page, channel) => `#crew/${encodeURIComponent(crew)}/${page}${channel ? `/${encodeURIComponent(channel)}` : ""}`;

  /* ---------- 라우팅: #home, #crew/{크루id}/{메뉴} ---------- */
  let current = { crew: null, page: "home", channel: null };

  // #crew/{크루}/{메뉴}/{채널} — 채널은 게시글·쇼츠에서 계정별로 볼 때만 붙음
  function parseRoute() {
    // #ranking, #ranking?sort=peak, #ranking/{멤버}
    const dn = location.hash.match(/^#donors(?:\/([^/?]+))?(?:\?(.*))?$/);
    if (dn) return { crew: null, page: "donors", channel: null, donor: dn[1] ? decodeURIComponent(dn[1]) : null, params: new URLSearchParams(dn[2] || "") };
    const rk = location.hash.match(/^#ranking(?:\/([^/?]+))?(?:\?(.*))?$/);
    if (rk) return { crew: null, page: "ranking", channel: null, member: rk[1] ? decodeURIComponent(rk[1]) : null, params: new URLSearchParams(rk[2] || "") };
    const m = location.hash.match(/^#crew\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?$/);
    const crew = m && decodeURIComponent(m[1]);
    if (!crew || !site.crews.some((c) => c.id === crew)) return { crew: null, page: "home", channel: null };
    const want = OLD_PAGES[m[2]] || m[2];
    const page = PAGES.some((p) => p.id === want) ? want : PAGES[0].id;
    const channel = m[3] && decodeURIComponent(m[3]);
    const valid = MEMBER_PAGES.includes(page) && site.members.some((mb) => mb.id === channel);
    return { crew, page, channel: valid ? channel : null };
  }

  function route() {
    current = parseRoute();
    renderNav();
    closeDropdowns();
    closeMobileNav();
    const home = current.page === "home", ranking = current.page === "ranking" || current.page === "donors";
    $("#home-view").hidden = !home;
    $("#page-view").hidden = home || ranking;
    $("#rank-view").hidden = !ranking;
    if (current.page === "donors") {
      if (current.donor) renderDonorPage(current.donor);
      else renderDonorsRoute(current.params);
    } else if (ranking) {
      if (current.member) { mdTab = "home"; renderMemberPage(current.member); }
      else renderRankingRoute(current.params);
    } else if (home) {
      renderRank();
      renderLive();
      loadHomeFeeds();
      renderHomeSigs();
    } else {
      renderPage();
    }
    window.scrollTo({ top: 0 });
  }
  window.addEventListener("hashchange", route);

  /* ---------- 상단 메뉴 (크루별 드롭다운) ---------- */
  // 크루 드롭다운 없이 메뉴를 바로 나열
  function navHtml() {
    const link = (href, name, on) => `<a href="${href}" class="nav-link ${on ? "is-active" : ""}" ${on ? 'aria-current="page"' : ""}><span class="nav-label">${name}</span></a>`;
    return link("#home", "홈", current.page === "home")
      + link("#ranking", "랭킹", current.page === "ranking")
      + link("#donors", "후원자 랭킹", current.page === "donors")
      + PAGES.filter((p) => !p.hide).map((p) => link(pageHref(mainCrew(), p.id), p.name, current.page === p.id)).join("");
  }

  function renderNav() {
    $("#desktop-nav").innerHTML = navHtml();
    $("#mobile-menu").innerHTML = navHtml();
    $$("[data-page-link]").forEach((a) => { a.href = pageHref(mainCrew(), a.dataset.pageLink); });
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

  const fmtStamp = (ms) => {
    const d = new Date(ms), now = new Date();
    const date = d.getFullYear() === now.getFullYear() ? `${d.getMonth() + 1}.${d.getDate()}` : `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
    return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  // 공지 한 줄: 플랫폼 로고 · 멤버 · 제목 · 날짜와 시간
  const noticeRow = (n) => {
    const inner = `
      <span class="notice-pf">${logo(n.platform)}</span>
      <span class="notice-main">
        <strong>${n.platform === "youtube" ? '<span class="notice-kind">새 영상</span>' : ""}${esc(n.title || "(제목 없음)")}</strong>
        ${n.summary ? `<span class="notice-sum">${esc(n.summary)}</span>` : ""}
      </span>
      <span class="notice-who">${esc(n.member)}</span>
      <time class="notice-time" datetime="${new Date(n.at).toISOString()}">${fmtStamp(n.at)}${isNew(n.at, 1) ? ' <span class="badge-new">NEW</span>' : ""}</time>`;
    return n.platform === "youtube"
      ? `<li><button type="button" class="notice-row" data-video="${esc(n.id)}">${inner}</button></li>`
      : `<li><a class="notice-row" href="${esc(n.url)}" target="_blank" rel="noopener">${inner}</a></li>`;
  };
  const vodCard = (v) => `
    <a class="post-card vod-card" href="${esc(v.url)}" target="_blank" rel="noopener">
      <div class="thumb">${thumb(v.thumb, v.title)}<span class="badge-platform-logo">${logo("soop")}</span>${v.duration ? `<span class="duration">${fmtDuration(v.duration)}</span>` : ""}</div>
      <div class="card-info"><strong>${esc(v.title)}</strong><span>${esc(v.member)} · ${fmtStamp(v.at)}</span></div>
    </a>`;

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
  let liveNow = [];

  async function loadLive() {
    try { liveNow = ((await api("api/live")).live ?? []).filter(inCrew); } catch { liveNow = []; }
    if (current.page === "home") renderLive();
    if (current.page === "live") renderPage();
  }

  const liveCard = (l) => `
      <a class="live-card" href="${esc(l.url)}" target="_blank" rel="noopener">
        <div class="thumb">${thumb(l.thumb, l.title)}<span class="badge-live">LIVE</span><span class="badge-platform-logo right">${logo(l.platform)}</span><span class="viewers">${(l.viewers || 0).toLocaleString()}명 시청</span></div>
        <div class="card-info"><strong>${esc(l.title)}</strong><span>${esc(l.member)} · ${l.platform === "soop" ? "SOOP" : "유튜브"}</span></div>
      </a>`;

  // 유튜브 · SOOP 방송을 한 칸에 같이 (시청자 많은 순)
  function renderLive() {
    const yt = liveNow.filter((l) => l.platform !== "soop").length, sp = liveNow.length - yt;
    $("#live-note").textContent = liveNow.length ? `방송 중 ${liveNow.length}${yt && sp ? ` · 유튜브 ${yt} · SOOP ${sp}` : ""}` : "";
    $("#live-list").innerHTML = liveNow.length ? liveNow.map(liveCard).join("") : empty("지금 방송 중인 멤버가 없어요. 방송을 켜면 1분 안에 여기에 떠요.");
  }

  /* ---------- 라이브 시간 랭킹 ---------- */
  const fmtHours = (sec = 0) => {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    return h ? `${h}시간 ${m}분` : `${m}분`;
  };
  const fmtHoursShort = (sec = 0) => (sec >= 3600 ? `${(sec / 3600).toFixed(sec >= 36000 ? 0 : 1)}시간` : `${Math.round(sec / 60)}분`);
  const fmtTime = (ms) => {
    const d = new Date(ms);
    return `${d.getMonth() + 1}.${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const fmtNum = (n) => Number(n || 0).toLocaleString();
  const fmtDay = (key) => `${Number(key.slice(5, 7))}.${Number(key.slice(8))}`;
  const WEEK = ["일", "월", "화", "수", "목", "금", "토"];
  const dow = (key) => WEEK[new Date(`${key}T00:00:00Z`).getUTCDay()]; // 날짜 키(KST)의 요일
  const memberAvatar = (it, cls = "") =>
    it.thumb ? `<img class="${cls}" src="${esc(it.thumb)}" alt="" loading="lazy">` : `<span class="${cls} member-avatar" aria-hidden="true"></span>`;

  const PLATFORMS = [{ id: "all", name: "전체" }, { id: "soop", name: "SOOP" }, { id: "youtube", name: "유튜브" }];
  const SORTS_RK = [
    { id: "time", name: "방송시간 순", unit: (it) => fmtHours(it.seconds) },
    { id: "viewers", name: "현재 시청자 순", unit: (it) => `시청 ${fmtNum(it.live_viewers)}명` },
    { id: "peak", name: "최고 시청자 순", unit: (it) => `최고 ${fmtNum(it.peak)}명` },
    { id: "donation", name: "후원 순", unit: (it) => `🎈 ${fmtNum(it.donation)}개` },
    { id: "followers", name: "팔로워 증가 순", unit: (it) => (it.follower_known ? `팔로워 ${it.follower_gain >= 0 ? "+" : ""}${fmtNum(it.follower_gain)}` : "팔로워 -") },
  ];
  const sortValue = (it, sort) => ({ time: it.seconds, viewers: it.live_viewers, peak: it.peak, followers: it.follower_gain, donation: it.donation }[sort] || 0);
  const PERIODS = [{ id: "today", name: "오늘" }, { id: "yesterday", name: "어제" }, { id: "week", name: "이번 주" }, { id: "30d", name: "최근 30일" }];
  let CATS = [
    { id: "game", name: "게임" }, { id: "talk", name: "토크/캠방" }, { id: "music", name: "음악/댄스" }, { id: "art", name: "그림/아트" },
    { id: "sports", name: "스포츠" }, { id: "travel", name: "여행" }, { id: "virtual", name: "버추얼" }, { id: "etc", name: "기타" },
  ];
  const catName = (id) => CATS.find((c) => c.id === id)?.name || "기타";

  // 랭킹 화면 상태 (멤버 자세히 화면과 기간을 같이 씀)
  const RK = { period: "30d", from: "", to: "", platform: "all", category: "all", sort: "time", liveOnly: false, q: "" };
  const rkQuery = (extra = {}) => {
    const o = { period: RK.period, platform: RK.platform, category: RK.category, sort: RK.sort, crew: mainCrew(), ...extra };
    if (o.period === "custom") Object.assign(o, { from: RK.from, to: RK.to });
    return new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== "")).toString();
  };

  const pfChip = (p) => (p.id === "all" ? p.name : p.id === "soop" ? logo("soop") : `${logo("youtube")}${p.name}`);
  const pfTag = (pf) => `<span class="pf-tag ${pf}">${pf === "soop" ? "SOOP" : "YOUTUBE"}</span>`;
  const pfTags = (it) => [it.has_soop || it.platforms?.includes("soop") ? pfTag("soop") : "", it.has_youtube || it.platforms?.includes("youtube") ? pfTag("youtube") : ""].join("");
  const ringClass = (it) => (it.has_soop && it.has_youtube ? "pf-both" : it.has_soop ? "pf-soop" : it.has_youtube ? "pf-youtube" : "");
  const liveTag = (it) => (it.is_live ? '<span class="live-tag">LIVE</span>' : "");
  const rankBadge = (r) => `<span class="rk-badge ${r && r <= 3 ? `r${r}` : ""}">${r ?? "-"}</span>`;
  const changeMark = (c) => (c === "new" ? '<span class="rk-change new">NEW</span>'
    : c > 0 ? `<span class="rk-change up" aria-label="${c}계단 상승">▲ ${c}</span>`
    : c < 0 ? `<span class="rk-change down" aria-label="${-c}계단 하락">▼ ${-c}</span>`
    : '<span class="rk-change same" aria-label="변동 없음">–</span>');
  const memberHref = (id) => `#ranking/${encodeURIComponent(id)}`;

  /* 홈: 라이브 시간 랭킹 카드 */
  let homePf = "all";
  let homeData = { time: null };

  async function loadRanking() {
    try { homeData.time = await api(`api/ranking?${new URLSearchParams({ period: "30d", platform: homePf, sort: "time", crew: mainCrew() })}`); } catch { return; }
    if (homeData.time?.categories) CATS = homeData.time.categories;
    if (current.page === "home") renderRank();
    if (current.page === "ranking" && !current.member && $("#rk-list")) refreshRankView();
  }

  const homeRow = (it, metric) => `
    <a class="rk-row" href="${memberHref(it.id)}">
      ${rankBadge(it.rank)}
      <span class="rk-avatar ${ringClass(it)}">${memberAvatar(it)}</span>
      <span class="rk-info">
        <span class="rk-line1">${pfTags(it)}<strong>${esc(it.name)}</strong>${liveTag(it)}</span>
        <span class="rk-line2">${metric(it)}</span>
      </span>
      ${it.change !== undefined ? changeMark(it.change) : ""}
    </a>`;

  function renderRank() {
    $("#home-rank-pf").innerHTML = PLATFORMS.map((p) =>
      `<button type="button" class="chip ${p.id === homePf ? "is-active" : ""}" role="tab" aria-selected="${p.id === homePf}" data-home-pf="${p.id}">${pfChip(p)}</button>`).join("");
    const top = (d, key) => (d?.items || []).filter((it) => it[key] > 0).slice(0, 5);
    const card = ({ icon, title, sub, tag, href, body, note }) => `
      <article class="rk-card">
        <a class="rk-card-head" href="${href}">
          <span class="rk-icon" aria-hidden="true">${icon}</span>
          <span class="rk-card-title"><strong>${title}</strong><small>${sub}</small></span>
          <span class="rk-card-tag">${tag}</span><span class="rk-card-go" aria-hidden="true">›</span>
        </a>
        <div class="rk-card-body">${body}</div>
        <p class="rk-card-note">${note}</p>
      </article>`;
    const loading = !homeData.time;
    $("#home-rank-cards").innerHTML = card({ icon: "👑", title: "라이브 시간 랭킹", sub: "전체 · 최근 30일 방송 시간", tag: "방송시간", href: "#ranking",
      body: loading ? empty("불러오는 중…") : top(homeData.time, "seconds").map((it) => homeRow(it, (x) => `⏱ ${fmtHours(x.seconds)}`)).join("") || empty("최근 30일 방송 기록이 아직 없어요."),
      note: "유튜브 라이브 · SOOP 방송을 1분마다 확인해 집계해요. 동시 송출 시간은 한 번만 셉니다." });
  }

  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-home-pf]");
    if (!b) return;
    homePf = b.dataset.homePf;
    homeData = { time: null };
    renderRank();
    loadRanking();
  });

  /* 기간 고르기 (랭킹 · 멤버 자세히 공통) */
  function periodControls(months) {
    const monthSel = `<label class="select"><span class="sr-only">월 선택</span>
      <select data-rk-month><option value="">월 선택</option>${(months || []).map((k) => `<option value="${k}" ${RK.period === k ? "selected" : ""}>${Number(k.slice(0, 4))}년 ${Number(k.slice(5))}월</option>`).join("")}</select></label>`;
    return `
      <div class="seg" role="group" aria-label="기간">${PERIODS.map((p) => `<button type="button" data-rk-period="${p.id}" class="${RK.period === p.id ? "is-active" : ""}">${p.name}</button>`).join("")}</div>
      ${monthSel}
      <details class="custom-range ${RK.period === "custom" ? "is-active" : ""}">
        <summary>📅 기간 직접 선택</summary>
        <form class="custom-range-pop" data-rk-custom>
          <label>시작<input type="date" name="from" value="${esc(RK.from)}" required></label>
          <label>끝<input type="date" name="to" value="${esc(RK.to)}" required></label>
          <button type="submit" class="primary-btn">적용</button>
        </form>
      </details>`;
  }
  function onPeriodEvent(e, reload) {
    const p = e.target.closest("[data-rk-period]");
    if (p && e.type === "click") { RK.period = p.dataset.rkPeriod; reload(); return true; }
    if (e.type === "change" && e.target.matches("[data-rk-month]") && e.target.value) { RK.period = e.target.value; reload(); return true; }
    if (e.type === "submit" && e.target.matches("[data-rk-custom]")) {
      e.preventDefault();
      const f = new FormData(e.target);
      Object.assign(RK, { period: "custom", from: f.get("from"), to: f.get("to") });
      reload();
      return true;
    }
    return false;
  }
  const rangeText = (per) => `${per.from_day.replaceAll("-", ".")} ~ ${per.to_day.replaceAll("-", ".")}`;

  /* 랭킹 화면 (#ranking) */
  let rkData = null, rkPlatformTop = null, rkSeq = 0;

  function renderRankingPage() {
    const view = $("#rank-view");
    view.innerHTML = `
      <section class="rk-page">
        <div class="rk-page-head">
          <h2>라이브 시간 랭킹</h2>
          <div class="seg" role="group" aria-label="표시">
            <button type="button" data-rk-live="0" class="${RK.liveOnly ? "" : "is-active"}">전체</button>
            <button type="button" data-rk-live="1" class="${RK.liveOnly ? "is-active" : ""}"><span class="live-dot"></span>Live만</button>
          </div>
        </div>
        <div class="rk-filters">
          <div class="rk-filter-row">
            <div class="chips">${PLATFORMS.map((p) => `<button type="button" class="chip big ${RK.platform === p.id ? "is-active" : ""}" data-rk-pf="${p.id}">${pfChip(p)}</button>`).join("")}</div>
            <div class="seg" role="group" aria-label="정렬">${SORTS_RK.map((s) => `<button type="button" data-rk-sort="${s.id}" class="${RK.sort === s.id ? "is-active" : ""}">${s.name}</button>`).join("")}</div>
          </div>
          <div class="rk-filter-row">
            <div class="chips">${[{ id: "all", name: "전체" }, ...CATS].map((c) => `<button type="button" class="chip ${RK.category === c.id ? "is-active" : ""}" data-rk-cat="${c.id}">${c.name}</button>`).join("")}</div>
            <div class="rk-period" id="rk-period">${periodControls(rkData?.months)}</div>
          </div>
          <label class="rk-search"><span class="sr-only">멤버 검색</span><input type="search" id="rk-search" placeholder="멤버 이름으로 검색 (전체 순위)" value="${esc(RK.q)}"></label>
        </div>
        <p class="rk-range" id="rk-range">불러오는 중…</p>
        <div class="rk-layout">
          <div class="rk-main">
            <ol class="rk-podium" id="rk-podium"></ol>
            <div class="rk-table">
              <div class="rk-table-head"><span>순위 · 멤버</span><span id="rk-metric-label">방송 시간</span></div>
              <ol class="rk-list" id="rk-list"></ol>
            </div>
          </div>
          <aside class="rk-side" id="rk-side"></aside>
        </div>
      </section>`;
    refreshRankView(true);
  }

  async function refreshRankView(reset) {
    const seq = ++rkSeq;
    if (reset) { $("#rk-list").innerHTML = `<li>${empty("불러오는 중…")}</li>`; $("#rk-podium").innerHTML = ""; }
    try {
      const [main, soopTop, ytTop] = await Promise.all([
        api(`api/ranking?${rkQuery()}`),
        RK.platform === "all" ? api(`api/ranking?${rkQuery({ platform: "soop", sort: "time" })}`) : null,
        RK.platform === "all" ? api(`api/ranking?${rkQuery({ platform: "youtube", sort: "time" })}`) : null,
      ]);
      if (seq !== rkSeq || current.page !== "ranking" || current.member) return;
      const firstLoad = !rkData;
      rkData = main;
      CATS = main.categories || CATS;
      rkPlatformTop = RK.platform === "all" ? { soop: soopTop.items.find((x) => x.seconds), youtube: ytTop.items.find((x) => x.seconds) } : null;
      if (firstLoad) $("#rk-period").innerHTML = periodControls(main.months);
      drawRankList(reset);
    } catch {
      if (seq === rkSeq) $("#rk-list").innerHTML = `<li>${empty("불러오지 못했습니다.")}</li>`;
    }
  }

  function drawRankList(animate) {
    const d = rkData;
    const sort = SORTS_RK.find((s) => s.id === RK.sort);
    const q = RK.q.trim().toLowerCase();
    let items = d.items.filter((it) => (!RK.liveOnly || it.is_live));
    const ranked = items.filter((it) => sortValue(it, RK.sort) > 0);
    const rest = items.filter((it) => !(sortValue(it, RK.sort) > 0));
    if (q) items = items.filter((it) => it.name.toLowerCase().includes(q));
    const what = { time: "방송 시간", viewers: "현재 시청자 수", peak: "최고 시청자 수", followers: "팔로워 증가", donation: "받은 후원(별풍선)" }[RK.sort];
    $("#rk-range").innerHTML = `📅 <b>${rangeText(d.period)}</b> ${esc(d.period.label)} 동안 집계된 ${what} 기준 순위예요.${RK.platform !== "all" ? ` · ${RK.platform === "soop" ? "SOOP" : "유튜브"}만` : ""}${RK.category !== "all" ? ` · ${catName(RK.category)}` : ""}`;
    $("#rk-metric-label").textContent = what;
    const max = Math.max(1, ...ranked.map((it) => sortValue(it, RK.sort)));
    const top3 = q ? [] : ranked.slice(0, 3);
    $("#rk-podium").innerHTML = top3.map((it) => `
      <li class="rk-pod place-${it.rank}">
        <a href="${memberHref(it.id)}">
          ${it.rank === 1 ? '<span class="crown" aria-hidden="true">♛</span>' : ""}
          ${rankBadge(it.rank)}
          <span class="rk-avatar big ${ringClass(it)}">${memberAvatar(it)}</span>
          <span class="rk-pod-tags">${pfTags(it)}</span>
          <strong class="rk-pod-name">${esc(it.name)}</strong>
          <span class="rk-pod-value">${sort.unit(it)}</span>
          <span class="rk-pod-sub">방송 ${it.days}일 · ${it.sessions}회${it.peak ? ` · 최고 ${fmtNum(it.peak)}명` : ""}</span>
          ${it.is_live ? `<span class="live-tag">LIVE${it.live_viewers ? ` · ${fmtNum(it.live_viewers)}명` : ""}</span>` : ""}
          ${it.change !== undefined ? changeMark(it.change) : ""}
        </a>
      </li>`).join("");
    const listItems = (q ? items : [...ranked.slice(3), ...rest]).filter((it) => !q || true);
    $("#rk-list").innerHTML = listItems.length
      ? listItems.map((it, i) => {
        const v = sortValue(it, RK.sort);
        return `
        <li style="--i:${Math.min(i, 20)}">
          <a class="rk-line ${animate ? "in" : ""}" href="${memberHref(it.id)}">
            ${rankBadge(v > 0 ? it.rank : null)}
            <span class="rk-avatar ${ringClass(it)}">${memberAvatar(it)}</span>
            <span class="rk-info">
              <span class="rk-line1">${pfTags(it)}<strong>${esc(it.name)}</strong></span>
              <span class="rk-line2">${it.category ? `<span class="cat-tag">${catName(it.category)}</span>` : ""}${it.is_live ? `<span class="live-tag">LIVE</span> 시청 ${fmtNum(it.live_viewers)}명` : `방송 ${it.days}일 · ${it.sessions}회`}</span>
            </span>
            <span class="rk-bar" aria-hidden="true"><span style="width:${Math.round((Math.max(0, v) / max) * 100)}%"></span></span>
            <span class="rk-value"><strong>${sort.unit(it)}</strong>${RK.sort === "time" && it.peak ? `<small>최고 ${fmtNum(it.peak)}명</small>` : RK.sort !== "time" && it.seconds ? `<small>${fmtHours(it.seconds)}</small>` : ""}</span>
            ${it.change !== undefined ? changeMark(it.change) : '<span class="rk-change"></span>'}
          </a>
        </li>`;
      }).join("")
      : (top3.length ? "" : `<li>${empty(q ? "검색 결과가 없어요." : RK.liveOnly ? "지금 방송 중인 멤버가 없어요." : "이 기간에는 기록이 없어요.")}</li>`);
    drawRankSide();
  }

  function drawRankSide() {
    const d = rkData;
    const rising = d.items.filter((it) => typeof it.change === "number" && it.change > 0).sort((a, b) => b.change - a.change).slice(0, 5);
    const lives = liveNow.filter((l) => RK.platform === "all" || l.platform === RK.platform).slice(0, 5);
    const sideRow = (it, right) => `<a class="side-row" href="${memberHref(it.id)}"><span class="rk-avatar small ${ringClass(it)}">${memberAvatar(it)}</span><strong>${esc(it.name)}</strong>${right}</a>`;
    $("#rk-side").innerHTML = `
      <section class="side-card"><h3>📈 실시간 급상승 TOP5</h3>
        ${rising.length ? rising.map((it, i) => sideRow(it, `<span class="side-num">${i + 1}</span>${changeMark(it.change)}`)).join("") : `<p class="side-empty">${d.period.rolling ? "어제보다 순위가 오른 멤버가 없어요." : "지금까지 이어지는 기간에서만 보여요."}</p>`}
      </section>
      ${rkPlatformTop ? `<section class="side-card"><h3>♛ 플랫폼별 1위</h3>
        ${["soop", "youtube"].map((pf) => {
          const it = rkPlatformTop[pf];
          return it ? `<a class="side-row" href="${memberHref(it.id)}"><span class="rk-avatar small pf-${pf}">${memberAvatar(it)}</span><span class="side-two"><small>${pf === "soop" ? "SOOP" : "유튜브"}</small><strong>${esc(it.name)}</strong></span><b>${fmtHours(it.seconds)}</b></a>`
            : `<div class="side-row muted"><small>${pf === "soop" ? "SOOP" : "유튜브"}</small> 기록 없음</div>`;
        }).join("")}</section>` : ""}
      <section class="side-card"><h3><span class="live-dot"></span> 지금 방송 중 LIVE</h3>
        ${lives.length ? lives.map((l) => `<a class="side-row" href="${esc(l.url)}" target="_blank" rel="noopener">${logo(l.platform)}<strong>${esc(l.member)}</strong><span class="side-num">👁 ${fmtNum(l.viewers)}명</span></a>`).join("") : '<p class="side-empty">지금 방송 중인 멤버가 없어요.</p>'}
      </section>
      <section class="side-card"><h3>✦ 랭킹 기준 안내</h3>
        <p class="side-empty">고른 기간의 방송 시간 순위 · 어제 대비 변동</p>
        <dl class="side-legend">
          <dt><span class="rk-change up">▲ 2</span></dt><dd>어제보다 순위 상승</dd>
          <dt><span class="rk-change down">▼ 1</span></dt><dd>어제보다 순위 하락</dd>
          <dt><span class="rk-change new">NEW</span></dt><dd>랭킹 신규 진입</dd>
        </dl>
        <p class="side-foot">유튜브 · SOOP 공개 방송 정보를 1분마다 확인해 직접 집계한 값이에요.</p>
      </section>`;
  }

  // 기간이 바뀌면 지금 보고 있는 화면을 다시 그림
  const periodReload = () => (current.page === "donors" ? (current.donor ? renderDonorPage(current.donor) : renderDonorsPage())
    : current.member ? renderMemberPage(current.member) : renderRankingPage());
  $("#rank-view").addEventListener("change", (e) => onPeriodEvent(e, periodReload));
  $("#rank-view").addEventListener("submit", (e) => onPeriodEvent(e, periodReload));

  $("#rank-view").addEventListener("click", (e) => {
    if (current.page !== "ranking" || current.member) return;
    const t = e.target.closest("[data-rk-pf], [data-rk-sort], [data-rk-cat], [data-rk-live]");
    if (onPeriodEvent(e, () => renderRankingPage())) return;
    if (!t) return;
    if (t.dataset.rkPf) RK.platform = t.dataset.rkPf;
    if (t.dataset.rkSort) RK.sort = t.dataset.rkSort;
    if (t.dataset.rkCat) RK.category = t.dataset.rkCat;
    if (t.dataset.rkLive) RK.liveOnly = t.dataset.rkLive === "1";
    if (t.dataset.rkLive && rkData) {
      $$("[data-rk-live]").forEach((b) => b.classList.toggle("is-active", b === t));
      return drawRankList(true);
    }
    renderRankingPage();
  });
  $("#rank-view").addEventListener("input", (e) => {
    if (current.page !== "ranking" || e.target.id !== "rk-search" || !rkData) return;
    RK.q = e.target.value;
    drawRankList(false);
  });

  /* 멤버 자세히 (#ranking/{멤버}) */
  const MD_TABS = [{ id: "home", name: "홈" }, { id: "schedule", name: "방송 일정" }, { id: "records", name: "방송 기록" }, { id: "donors", name: "후원자 랭킹" }, { id: "activity", name: "순위 · 활동" }];
  const METRICS = [
    { id: "seconds", name: "방송시간", fmt: fmtHours, axis: fmtHoursShort, total: (d) => fmtHours(d.reduce((a, x) => a + x.seconds, 0)), totalNote: "합계 방송 시간" },
    { id: "donation", name: "후원", fmt: (v) => `${fmtNum(v)}개`, axis: (v) => fmtCount(v), total: (d) => `${fmtNum(d.reduce((a, x) => a + (x.donation || 0), 0))}개`, totalNote: "받은 별풍선 합계" },
    { id: "peak", name: "최고 시청자", fmt: (v) => `${fmtNum(v)}명`, axis: (v) => fmtCount(v), total: (d) => `${fmtNum(Math.max(0, ...d.map((x) => x.peak)))}명`, totalNote: "기간 최고 시청자" },
    { id: "avg", name: "평균 시청자", fmt: (v) => `${fmtNum(v)}명`, axis: (v) => fmtCount(v), total: (d) => { const on = d.filter((x) => x.avg); return `${fmtNum(on.length ? Math.round(on.reduce((a, x) => a + x.avg, 0) / on.length) : 0)}명`; }, totalNote: "방송한 날 평균" },
    { id: "followers", name: "팔로워", fmt: (v) => `${fmtNum(v)}명`, axis: (v) => fmtCount(v), total: (d) => { const f = d.filter((x) => x.followers != null); return f.length ? `${fmtNum(f.at(-1).followers)}명` : "-"; }, totalNote: "기간 마지막 팔로워" },
  ];
  let md = null, mdTab = "home", mdMetric = "seconds", mdDay = null, mdSeq = 0;

  async function renderMemberPage(id) {
    const seq = ++mdSeq;
    const view = $("#rank-view");
    if (!md || md.member.id !== id) view.innerHTML = `<section class="rk-page">${empty("불러오는 중…")}</section>`;
    let data;
    try { data = await api(`api/ranking/member/${encodeURIComponent(id)}?${rkQuery({ sort: "time" })}`); }
    catch { if (seq === mdSeq) view.innerHTML = `<section class="rk-page">${empty("멤버를 찾을 수 없어요.")} <p><a class="ghost-btn" href="#ranking">← 랭킹으로</a></p></section>`; return; }
    if (seq !== mdSeq || current.member !== id) return;
    md = data;
    CATS = data.category_names || CATS;
    mdDay = null;
    drawMember();
  }

  function drawMember() {
    const { member: m, summary: s, period: per } = md;
    const months = rkData?.months || homeData.time?.months || [];
    $("#rank-view").innerHTML = `
      <section class="rk-page md-page">
        <a class="md-back" href="#ranking">← 라이브 시간 랭킹</a>
        <header class="md-head">
          <span class="rk-avatar huge ${m.soops.length && m.youtubes.length ? "pf-both" : m.soops.length ? "pf-soop" : "pf-youtube"}">${memberAvatar(m)}</span>
          <div class="md-title">
            <span class="rk-line1">${m.soops.length ? pfTag("soop") : ""}${m.youtubes.length ? pfTag("youtube") : ""}${m.is_live ? '<span class="live-tag">LIVE</span>' : ""}</span>
            <h2>${esc(m.name)}</h2>
            <p class="md-chips">
              ${s?.rank ? `<span class="md-chip strong">${esc(per.label)} ${s.rank}위 <small>/ ${s.total}명</small></span>` : `<span class="md-chip">${esc(per.label)} 기록 없음</span>`}
              ${s && s.change !== null && s.change !== undefined ? changeMark(s.change) : ""}
              ${s?.followers != null ? `<span class="md-chip">팔로워 ${fmtNum(s.followers)}</span>` : ""}
            </p>
          </div>
          ${m.is_live ? `<a class="md-live" href="${esc(m.live_url)}" target="_blank" rel="noopener">
              <span class="md-live-top">${logo(m.live_platform)}<span class="live-tag">LIVE</span>${m.live_viewers ? `<span>👁 시청 ${fmtNum(m.live_viewers)}명</span>` : ""}</span>
              ${m.live_title ? `<strong>${esc(m.live_title)}</strong>` : ""}
              <span class="md-live-go">방송 보러 가기 ›</span>
            </a>` : ""}
        </header>
        <div class="md-toolbar">
          <div class="rk-period">${periodControls(months)}</div>
          <span class="md-range">${esc(per.label)} <b>${rangeText(per)}</b></span>
        </div>
        <nav class="md-tabs" role="tablist">${MD_TABS.map((t) => `<button type="button" role="tab" data-md-tab="${t.id}" aria-selected="${t.id === mdTab}" class="${t.id === mdTab ? "is-active" : ""}">${t.name}</button>`).join("")}</nav>
        <div id="md-body"></div>
      </section>`;
    drawMemberTab();
  }

  const statTile = (label, value, sub = "") => `<div class="md-stat"><span>${label}</span><strong>${value}</strong>${sub ? `<small>${sub}</small>` : ""}</div>`;

  function drawMemberTab() {
    const body = $("#md-body");
    const { summary: s, daily, sessions, categories, history } = md;
    if (mdTab === "home") {
      const metric = METRICS.find((x) => x.id === mdMetric);
      body.innerHTML = `
        <div class="md-stats">
          ${statTile("누적 방송시간", s ? fmtHours(s.seconds) : "-")}
          ${statTile("방송 횟수", s ? `${s.sessions}회` : "-", s ? `방송한 날 ${s.days}일` : "")}
          ${statTile("최고 시청자", s?.peak ? `${fmtNum(s.peak)}명` : "-")}
          ${statTile("평균 시청자", s?.avg ? `${fmtNum(s.avg)}명` : "-")}
          ${statTile("팔로워 증가", s?.follower_gain != null ? `${s.follower_gain >= 0 ? "+" : ""}${fmtNum(s.follower_gain)}명` : "-", s?.followers != null ? `현재 ${fmtNum(s.followers)}명` : "기록 쌓는 중")}
          ${statTile("받은 후원", `🎈 ${fmtNum(md.donation.total)}개`, md.donation.collected ? `후원자 ${fmtNum(md.donation.donors)}명 · ${fmtNum(md.donation.count)}건` : "후원 수집 연결 전")}
        </div>
        <div class="md-grid">
          <section class="md-card">
            <div class="md-card-head">
              <h3>최근 방송 흐름</h3>
              <div class="seg" role="group" aria-label="그래프 항목">${METRICS.map((x) => `<button type="button" data-md-metric="${x.id}" class="${x.id === mdMetric ? "is-active" : ""}">${x.name}</button>`).join("")}</div>
            </div>
            <p class="md-total"><strong>${metric.total(daily)}</strong> <small>${esc(md.period.label)} ${metric.totalNote}</small></p>
            <div class="chart" id="md-chart"></div>
            <p class="chart-foot"><span>일별 ${metric.name} · 점을 누르면 그날 기록을 볼 수 있어요</span><span>빈 날은 방송하지 않은 날</span></p>
            <div id="md-day"></div>
          </section>
          <aside class="md-side">
            <section class="md-card">
              <div class="md-card-head"><h3>🎈 후원자 TOP</h3><small class="muted">${esc(md.period.label)}</small></div>
              ${donorMini(md.donors.slice(0, 10))}
              ${md.donors.length > 10 ? '<button type="button" class="text-link" data-md-tab="donors">후원자 전체 보기 ›</button>' : ""}
            </section>
            <section class="md-card">
              <h3>카테고리</h3>
              ${categories.length ? `<ul class="cat-bars">${categories.map((c) => `<li><span>${catName(c.id)}</span><span class="cat-bar"><span style="width:${Math.round((c.seconds / categories[0].seconds) * 100)}%"></span></span><b>${fmtHoursShort(c.seconds)}</b></li>`).join("")}</ul>` : '<p class="side-empty">이 기간 방송 기록이 없어요.</p>'}
            </section>
          </aside>
        </div>`;
      drawChart($("#md-chart"), daily, metric);
    } else if (mdTab === "schedule") {
      body.innerHTML = `<div class="md-card">${calendar(daily)}<div id="md-day"></div></div>`;
    } else if (mdTab === "donors") {
      const d = md.donation;
      body.innerHTML = `
        <div class="md-stats">
          ${statTile("받은 후원", `🎈 ${fmtNum(d.total)}개`)}
          ${statTile("후원자", `${fmtNum(d.donors)}명`)}
          ${statTile("후원 건수", `${fmtNum(d.count)}건`)}
          ${statTile("1위 후원자", md.donors[0] ? esc(md.donors[0].nick) : "-", md.donors[0] ? `${fmtNum(md.donors[0].total)}개` : "")}
        </div>
        <div class="md-grid">
          <section class="md-card"><h3>후원자 랭킹 <small class="muted">${esc(md.period.label)}</small></h3>
            ${md.donors.length ? `<ol class="dn-list">${md.donors.map((x, i) => donorLine(x, i, md.donors[0].total)).join("")}</ol>` : noDonations(d.collected)}
          </section>
          <section class="md-card"><h3>최근 후원</h3>
            ${md.recent_donations.length ? `<ul class="dn-recent">${md.recent_donations.map((r) => `<li><a href="#donors/${encodeURIComponent(r.key)}"><strong>${esc(r.nick)}</strong></a><b>🎈 ${fmtNum(r.amount)}개</b><time>${fmtTime(r.at)}</time></li>`).join("")}</ul>` : noDonations(d.collected)}
          </section>
        </div>`;
    } else if (mdTab === "records") {
      body.innerHTML = `<div class="md-card">${sessions.length ? `
        <div class="table-wrap"><table class="sig-table md-records">
          <thead><tr><th>플랫폼</th><th>방송 제목</th><th>카테고리</th><th>시작 ~ 끝</th><th class="num">방송 시간</th><th class="num">최고 시청자</th><th class="num">평균 시청자</th><th class="num">후원</th></tr></thead>
          <tbody>${sessions.map(sessionRow).join("")}</tbody>
        </table></div>` : empty("이 기간에는 방송 기록이 없어요.")}</div>`;
    } else {
      const fol = daily.filter((x) => x.followers != null);
      body.innerHTML = `
        <div class="md-stats">
          ${statTile("기간 순위", s?.rank ? `${s.rank}위` : "-", s ? `${s.total}명 중` : "")}
          ${statTile("방송 횟수", s ? `${s.sessions}회` : "-")}
          ${statTile("누적 방송시간", s ? fmtHours(s.seconds) : "-")}
          ${statTile("최고 시청자", s?.peak ? `${fmtNum(s.peak)}명` : "-")}
          ${statTile("팔로워", s?.followers != null ? `${fmtNum(s.followers)}명` : "-", s?.follower_gain != null ? `기간 중 ${s.follower_gain >= 0 ? "+" : ""}${fmtNum(s.follower_gain)}명` : "")}
        </div>
        <section class="md-card"><h3>월별 기록</h3>
          <div class="chips">${history.map((h) => `<button type="button" class="chip big" data-md-month="${h.month}">${Number(h.month.slice(0, 4))}년 ${Number(h.month.slice(5))}월 <b>${h.rank ? `${h.rank}위` : "-"}</b> <small>${fmtHoursShort(h.seconds)}</small></button>`).join("")}</div>
        </section>
        <section class="md-card"><h3>팔로워 변화</h3>
          ${fol.length ? `<div class="table-wrap"><table class="sig-table"><thead><tr><th>날짜</th><th class="num">팔로워</th><th class="num">전날 대비</th></tr></thead><tbody>
            ${fol.slice().reverse().map((x, i, arr) => { const prev = arr[i + 1]; const dlt = prev ? x.followers - prev.followers : null; return `<tr><td>${fmtDay(x.day)} (${dow(x.day)})</td><td class="num">${fmtNum(x.followers)}</td><td class="num">${dlt == null ? "-" : `${dlt >= 0 ? "+" : ""}${fmtNum(dlt)}`}</td></tr>`; }).join("")}
          </tbody></table></div>` : '<p class="side-empty">팔로워 수는 오늘부터 하루 한 번씩 기록돼요. 며칠 지나면 변화가 보여요.</p>'}
        </section>`;
    }
  }

  const sessionRow = (b) => `
    <tr>
      <td>${logo(b.platform)}</td>
      <td class="md-rec-title">${esc(b.title || "(제목 없음)")}</td>
      <td><span class="cat-tag">${esc(b.category_name || catName(b.category))}</span></td>
      <td class="nowrap">${fmtTime(b.started_at)} ~ ${b.ended_at ? fmtTime(b.ended_at) : '<b class="on-air">방송 중</b>'}</td>
      <td class="num">${fmtHours(b.seconds)}</td>
      <td class="num">${b.peak ? `${fmtNum(b.peak)}명` : "-"}</td>
      <td class="num">${b.avg ? `${fmtNum(b.avg)}명` : "-"}</td>
      <td class="num">${b.donation ? `🎈 ${fmtNum(b.donation)}` : "-"}</td>
    </tr>`;

  // 그날 기록 (그래프 점 · 달력 칸을 눌렀을 때)
  function showDay(day) {
    mdDay = day;
    const el = $("#md-day");
    if (!el) return;
    const x = md.daily.find((d) => d.day === day);
    const list = md.sessions.filter((b) => {
      const s = Date.parse(`${day}T00:00:00+09:00`), e = s + 86400e3;
      return b.started_at < e && (b.ended_at ?? Date.now()) > s;
    });
    $$("[data-cal-day]").forEach((c) => c.classList.toggle("is-selected", c.dataset.calDay === day));
    el.innerHTML = `
      <div class="md-day">
        <h4>${fmtDay(day)} (${dow(day)})</h4>
        <div class="md-day-stats">
          <span>방송 <b>${fmtHours(x?.seconds || 0)}</b></span><span>횟수 <b>${x?.sessions || 0}회</b></span>
          <span>최고 <b>${x?.peak ? `${fmtNum(x.peak)}명` : "-"}</b></span><span>평균 <b>${x?.avg ? `${fmtNum(x.avg)}명` : "-"}</b></span>
          <span>팔로워 <b>${x?.followers != null ? fmtNum(x.followers) : "-"}</b></span><span>후원 <b>🎈 ${fmtNum(x?.donation || 0)}개</b></span>
        </div>
        ${list.length ? `<div class="table-wrap"><table class="sig-table md-records"><tbody>${list.map(sessionRow).join("")}</tbody></table></div>` : '<p class="side-empty">이날은 방송하지 않았어요.</p>'}
      </div>`;
  }

  // 방송 일정: 달력 (진할수록 오래 방송)
  function calendar(daily) {
    const byDay = new Map(daily.map((d) => [d.day, d]));
    const months = [...new Set(daily.map((d) => d.day.slice(0, 7)))];
    const max = Math.max(1, ...daily.map((d) => d.seconds));
    const level = (sec) => (sec <= 0 ? 0 : Math.min(4, Math.ceil((sec / max) * 4)));
    return months.map((mk) => {
      const [y, mo] = mk.split("-").map(Number);
      const first = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay();
      const count = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      const cells = [];
      for (let i = 0; i < first; i++) cells.push('<span class="cal-cell blank"></span>');
      for (let dnum = 1; dnum <= count; dnum++) {
        const key = `${mk}-${pad(dnum)}`;
        const d = byDay.get(key);
        if (!d) { cells.push(`<span class="cal-cell out"><i>${dnum}</i></span>`); continue; }
        cells.push(`<button type="button" class="cal-cell lv${level(d.seconds)}" data-cal-day="${key}" aria-label="${dnum}일 ${d.seconds ? fmtHours(d.seconds) : "방송 없음"}">
          <i>${dnum}</i>${d.seconds ? `<b>${fmtHoursShort(d.seconds)}</b>${d.sessions > 1 ? `<small>${d.sessions}회</small>` : ""}` : ""}</button>`);
      }
      return `<section class="cal"><h4>${y}년 ${mo}월</h4>
        <div class="cal-grid">${WEEK.map((w) => `<span class="cal-head">${w}</span>`).join("")}${cells.join("")}</div></section>`;
    }).join("") + `<p class="chart-foot"><span>색이 진할수록 오래 방송한 날이에요. 날짜를 누르면 그날 방송 기록이 나와요.</span></p>`;
  }

  // 일별 그래프 (한 번에 한 항목 · 선 + 영역 · 마우스를 올리면 값)
  function drawChart(el, daily, metric, onPick = showDay) {
    const vals = daily.map((d) => (metric.id === "followers" ? d.followers : d[metric.id]));
    if (metric.id === "donation" && md && !md.donation?.collected && onPick === showDay) { el.innerHTML = empty("별풍선 수집이 연결되면 날짜별 후원이 여기에 나와요."); return; }
    if (vals.every((v) => v == null)) {
      el.innerHTML = empty(metric.id === "donation" ? "후원(별풍선) 집계는 아직 연결되지 않았어요." : metric.id === "followers" ? "팔로워 수는 오늘부터 하루 한 번씩 기록돼요." : "이 기간 기록이 없어요.");
      return;
    }
    const W = Math.max(300, el.clientWidth || 700), H = 260, L = 52, R = 14, T = 16, B = 30;
    const pts = vals.map((v, i) => ({ i, v }));
    const known = pts.filter((p) => p.v != null);
    let lo = metric.id === "followers" ? Math.min(...known.map((p) => p.v)) : 0;
    let hi = Math.max(...known.map((p) => p.v));
    if (hi === lo) hi = lo + (metric.id === "seconds" ? 3600 : 10);
    // 보기 좋은 눈금
    const step0 = (hi - lo) / 4, mag = 10 ** Math.floor(Math.log10(step0));
    const step = metric.id === "seconds"
      ? [600, 1800, 3600, 7200, 10800, 14400, 21600, 43200, 86400].find((k) => k >= step0) || step0  // 10분 · 30분 · 1 · 2 · 3 · 4 · 6 · 12 · 24시간
      : [1, 2, 2.5, 5, 10].map((k) => Math.max(1, k * mag)).find((k) => k >= step0) || step0;
    lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
    const n = daily.length;
    const x = (i) => (n === 1 ? L + (W - L - R) / 2 : L + (i * (W - L - R)) / (n - 1));
    const y = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo || 1));
    const ticks = []; for (let v = lo; v <= hi + step / 2; v += step) ticks.push(v);
    // 단조 곡선 (값이 0 아래로 내려가지 않게)
    const curve = (p) => {
      if (p.length < 2) return "";
      const dx = p.slice(1).map((q, k) => q.x - p[k].x), dy = p.slice(1).map((q, k) => q.y - p[k].y), s = dy.map((d, k) => d / dx[k]);
      const m = p.map((_, k) => (k === 0 ? s[0] : k === p.length - 1 ? s[k - 1] : s[k - 1] * s[k] <= 0 ? 0 : (s[k - 1] + s[k]) / 2));
      for (let k = 0; k < s.length; k++) {
        if (s[k] === 0) { m[k] = 0; m[k + 1] = 0; continue; }
        const a = m[k] / s[k], b = m[k + 1] / s[k], h = a * a + b * b;
        if (h > 9) { const t = 3 / Math.sqrt(h); m[k] = t * a * s[k]; m[k + 1] = t * b * s[k]; }
      }
      let d = `M${p[0].x},${p[0].y}`;
      for (let k = 0; k < p.length - 1; k++) d += ` C${p[k].x + dx[k] / 3},${p[k].y + (m[k] * dx[k]) / 3} ${p[k + 1].x - dx[k] / 3},${p[k + 1].y - (m[k + 1] * dx[k]) / 3} ${p[k + 1].x},${p[k + 1].y}`;
      return d;
    };
    const seq = known.map((p) => ({ x: x(p.i), y: y(p.v) }));
    const line = curve(seq);
    const area = line ? `${line} L${seq.at(-1).x},${y(lo)} L${seq[0].x},${y(lo)} Z` : "";
    const every = Math.max(1, Math.ceil(n / Math.floor((W - L - R) / 56)));
    el.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="일별 ${metric.name} 그래프">
        <defs><linearGradient id="md-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--chart)" stop-opacity=".22"/><stop offset="1" stop-color="var(--chart)" stop-opacity="0"/></linearGradient></defs>
        ${ticks.map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${metric.axis(v)}</text>`).join("")}
        ${daily.map((d, i) => (i % every === 0 || i === n - 1) && (i === n - 1 || n - 1 - i >= every / 2 || i === 0) ? `<text class="axis" x="${x(i)}" y="${H - 8}" text-anchor="middle">${fmtDay(d.day)}</text>` : "").join("")}
        ${area ? `<path d="${area}" fill="url(#md-fill)"/>` : ""}
        ${line ? `<path d="${line}" class="chart-line"/>` : ""}
        ${known.length <= 45 ? known.map((p) => `<circle class="chart-dot" cx="${x(p.i)}" cy="${y(p.v)}" r="${n === 1 ? 6 : 3}"/>`).join("") : ""}
        <line class="cross" id="md-cross" y1="${T}" y2="${H - B}" x1="-10" x2="-10"/>
        <circle class="chart-dot hover" id="md-hover" r="5" cx="-10" cy="-10"/>
        <rect class="hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}"/>
      </svg>
      <div class="chart-tip" id="md-tip" hidden></div>`;
    const svg = $("svg", el), tip = $("#md-tip", el);
    const at = (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      return Math.max(0, Math.min(n - 1, Math.round(n === 1 ? 0 : ((px - L) / (W - L - R)) * (n - 1))));
    };
    svg.addEventListener("mousemove", (ev) => {
      const i = at(ev), v = vals[i];
      $("#md-cross", el).setAttribute("x1", x(i)); $("#md-cross", el).setAttribute("x2", x(i));
      const hv = $("#md-hover", el);
      hv.setAttribute("cx", v == null ? -10 : x(i)); hv.setAttribute("cy", v == null ? -10 : y(v));
      const d = daily[i];
      tip.hidden = false;
      tip.innerHTML = `<b>${fmtDay(d.day)} (${dow(d.day)})</b><span>${metric.name} ${v == null ? "-" : metric.fmt(v)}</span>${d.seconds == null ? (d.count ? `<span>${d.count}건</span>` : "") : metric.id !== "seconds" ? `<span>방송 ${fmtHours(d.seconds)}</span>` : d.sessions ? `<span>${d.sessions}회 방송</span>` : ""}`;
      const left = (x(i) / W) * el.clientWidth;
      tip.style.left = `${Math.min(el.clientWidth - 150, Math.max(0, left + 12))}px`;
      tip.style.top = `${Math.max(0, ((v == null ? T : y(v)) / H) * 260 - 10)}px`;
    });
    svg.addEventListener("mouseleave", () => { tip.hidden = true; $("#md-cross", el).setAttribute("x1", -10); $("#md-cross", el).setAttribute("x2", -10); $("#md-hover", el).setAttribute("cx", -10); });
    svg.addEventListener("click", (ev) => onPick && onPick(daily[at(ev)].day));
  }

  $("#rank-view").addEventListener("click", (e) => {
    if (current.page !== "ranking" || !current.member || !md) return;
    if (onPeriodEvent(e, () => renderMemberPage(current.member))) return;
    const tab = e.target.closest("[data-md-tab]");
    if (tab) { mdTab = tab.dataset.mdTab; drawMember(); return; }
    const met = e.target.closest("[data-md-metric]");
    if (met) { mdMetric = met.dataset.mdMetric; drawMemberTab(); return; }
    const day = e.target.closest("[data-cal-day]");
    if (day) { showDay(day.dataset.calDay); return; }
    const mon = e.target.closest("[data-md-month]");
    if (mon) { RK.period = mon.dataset.mdMonth; mdTab = "home"; renderMemberPage(current.member); }
  });
  let resizeT;
  window.addEventListener("resize", () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { if (current.member && md && mdTab === "home") drawChart($("#md-chart"), md.daily, METRICS.find((x) => x.id === mdMetric)); }, 150);
  });

  /* ---------- 후원자 랭킹 ---------- */
  const donorHref = (key) => `#donors/${encodeURIComponent(key)}`;
  const donorAvatar = (nick = "", cls = "") => `<span class="dn-avatar ${cls}" aria-hidden="true">${esc([...String(nick).trim()][0] || "?")}</span>`;
  const noDonations = (collected) => `<p class="side-empty">${collected ? "이 기간에는 후원 기록이 없어요." : "별풍선 수집이 연결되면 후원 기록이 여기에 쌓여요."}</p>`;
  // 멤버 화면 옆 칸: 후원자 TOP 10
  const donorMini = (list) => (list.length
    ? `<ol class="dn-mini">${list.map((x) => `<li><a href="${donorHref(x.key)}">${rankBadge(x.rank)}<strong>${esc(x.nick)}</strong><b>${fmtNum(x.total)}개</b></a></li>`).join("")}</ol>`
    : noDonations(md?.donation?.collected));
  // 후원자 한 줄 (멤버 화면 · 전체 화면 공용)
  const donorLine = (x, i, max) => `
    <li style="--i:${Math.min(i, 20)}">
      <a class="dn-line in" href="${donorHref(x.key)}">
        ${rankBadge(x.rank)}
        ${donorAvatar(x.nick)}
        <span class="rk-info">
          <span class="rk-line1">${x.platform ? pfTag(x.platform) : ""}<strong>${esc(x.nick)}</strong></span>
          <span class="rk-line2">${x.to?.length ? x.to.slice(0, 3).map((t) => `<span class="dn-to">→ ${esc(t.name)} ${fmtNum(t.amount)}</span>`).join("") + (x.to.length > 3 ? ` 외 ${x.to.length - 3}명` : "") : `${fmtNum(x.count)}번 후원 · 마지막 ${fmtAgo(x.last_at)}`}</span>
        </span>
        <span class="rk-bar" aria-hidden="true"><span style="width:${Math.round((x.total / Math.max(1, max)) * 100)}%"></span></span>
        <span class="rk-value"><strong>🎈 ${fmtNum(x.total)}개</strong><small>${fmtNum(x.count)}건</small></span>
        ${x.change !== undefined ? changeMark(x.change) : '<span class="rk-change"></span>'}
      </a>
    </li>`;

  const DN = { member: "all", q: "" };
  let dnData = null, dnSeq = 0;

  function renderDonorsRoute(params) {
    if (params.get("member")) DN.member = params.get("member");
    renderDonorsPage();
  }

  function renderDonorsPage() {
    const members = site.members.filter((m) => m.soop || m.youtube);
    $("#rank-view").innerHTML = `
      <section class="rk-page">
        <div class="rk-page-head"><h2>후원자 랭킹</h2><span class="head-note">SOOP 별풍선 기준 · 실시간 집계</span></div>
        <div class="rk-filters">
          <div class="rk-filter-row">
            <div class="chips dn-members">
              <button type="button" class="chip big ${DN.member === "all" ? "is-active" : ""}" data-dn-member="all">전체</button>
              ${members.map((m) => `<button type="button" class="chip big ${DN.member === m.id ? "is-active" : ""}" data-dn-member="${esc(m.id)}"><span class="rk-avatar tiny">${memberAvatar(m)}</span>${esc(m.name)}</button>`).join("")}
            </div>
          </div>
          <div class="rk-filter-row"><span></span><div class="rk-period" id="dn-period">${periodControls(dnData?.months || rkData?.months || homeData.time?.months)}</div></div>
          <label class="rk-search"><span class="sr-only">후원자 검색</span><input type="search" id="dn-search" placeholder="후원자 닉네임 검색" value="${esc(DN.q)}"></label>
        </div>
        <p class="rk-range" id="dn-range">불러오는 중…</p>
        <div class="rk-layout">
          <div class="rk-main">
            <ol class="rk-podium" id="dn-podium"></ol>
            <div class="rk-table">
              <div class="rk-table-head"><span>순위 · 후원자</span><span>후원 별풍선</span></div>
              <ol class="rk-list" id="dn-list"><li>${empty("불러오는 중…")}</li></ol>
            </div>
          </div>
          <aside class="rk-side" id="dn-side"></aside>
        </div>
      </section>`;
    loadDonors();
  }

  async function loadDonors() {
    const seq = ++dnSeq;
    try {
      const d = await api(`api/donors?${rkQuery(DN.member === "all" ? { sort: null } : { sort: null, member: DN.member })}`);
      if (seq !== dnSeq || current.page !== "donors" || current.donor) return;
      const first = !dnData;
      dnData = d;
      if (first) $("#dn-period").innerHTML = periodControls(d.months);
      drawDonors();
    } catch {
      if (seq === dnSeq) $("#dn-list").innerHTML = `<li>${empty("불러오지 못했습니다.")}</li>`;
    }
  }

  function drawDonors() {
    const d = dnData;
    const who = DN.member === "all" ? "전체 멤버" : site.members.find((m) => m.id === DN.member)?.name || "";
    $("#dn-range").innerHTML = `📅 <b>${rangeText(d.period)}</b> ${esc(d.period.label)} · ${esc(who)}가 받은 후원 <b>🎈 ${fmtNum(d.total)}개</b> · 후원자 ${fmtNum(d.donors)}명 · ${fmtNum(d.count)}건`;
    const q = DN.q.trim().toLowerCase();
    const items = q ? d.items.filter((x) => x.nick.toLowerCase().includes(q) || x.donor_id.toLowerCase().includes(q)) : d.items;
    const top3 = q ? [] : items.slice(0, 3);
    $("#dn-podium").innerHTML = top3.map((x) => `
      <li class="rk-pod place-${x.rank}">
        <a href="${donorHref(x.key)}">
          ${x.rank === 1 ? '<span class="crown" aria-hidden="true">♛</span>' : ""}
          ${rankBadge(x.rank)}
          ${donorAvatar(x.nick, "big")}
          <span class="rk-pod-tags">${pfTag(x.platform)}</span>
          <strong class="rk-pod-name">${esc(x.nick)}</strong>
          <span class="rk-pod-value">🎈 ${fmtNum(x.total)}개</span>
          <span class="rk-pod-sub">${fmtNum(x.count)}번 후원${x.to[0] ? ` · 최다 ${esc(x.to[0].name)}` : ""}</span>
          ${x.change !== undefined ? changeMark(x.change) : ""}
        </a>
      </li>`).join("");
    const rest = q ? items : items.slice(3);
    const max = d.items[0]?.total || 1;
    $("#dn-list").innerHTML = rest.length ? rest.map((x, i) => donorLine(x, i, max)).join("")
      : top3.length ? "" : `<li>${empty(q ? "검색 결과가 없어요." : d.count ? "이 기간에는 후원 기록이 없어요." : "별풍선 수집이 연결되면 후원자 순위가 여기에 나와요.")}</li>`;
    const rising = d.items.filter((x) => typeof x.change === "number" && x.change > 0).sort((a, b) => b.change - a.change).slice(0, 5);
    $("#dn-side").innerHTML = `
      <section class="side-card"><h3>👑 후원 많이 받은 멤버</h3>
        ${d.receivers.length ? d.receivers.slice(0, 8).map((r, i) => `<a class="side-row" href="${memberHref(r.id)}"><span class="side-num">${i + 1}</span><span class="rk-avatar small">${memberAvatar(r)}</span><strong>${esc(r.name)}</strong><b>🎈 ${fmtNum(r.amount)}</b></a>`).join("") : '<p class="side-empty">아직 기록이 없어요.</p>'}
      </section>
      <section class="side-card"><h3>📈 큰손 급상승</h3>
        ${rising.length ? rising.map((x) => `<a class="side-row" href="${donorHref(x.key)}">${donorAvatar(x.nick, "small")}<strong>${esc(x.nick)}</strong>${changeMark(x.change)}</a>`).join("") : '<p class="side-empty">어제보다 순위가 오른 후원자가 없어요.</p>'}
      </section>
      <section class="side-card"><h3>✦ 집계 기준</h3>
        <p class="side-empty">멤버 SOOP 방송 채팅에 올라오는 별풍선 선물을 그대로 모아서 셉니다. 서버가 꺼져 있던 시간의 후원은 빠질 수 있는 추정치예요.</p>
        <p class="side-foot">후원자를 누르면 누구에게 언제 얼마나 후원했는지 자세히 볼 수 있어요.</p>
      </section>`;
  }

  /* 후원자 1명 자세히 (#donors/{플랫폼:아이디}) */
  const recordTable = (rows) => `<div class="table-wrap"><table class="sig-table"><thead><tr><th>시간</th><th>받은 멤버</th><th class="num">별풍선</th></tr></thead>
    <tbody>${rows.map((r) => `<tr><td class="nowrap">${fmtTime(r.at)}</td><td>${r.member_id ? `<a href="${memberHref(r.member_id)}">${esc(r.member)}</a>` : esc(r.member)}</td><td class="num">🎈 ${fmtNum(r.amount)}개</td></tr>`).join("")}</tbody></table></div>`;
  let dd = null, ddSeq = 0;
  async function renderDonorPage(key) {
    const seq = ++ddSeq;
    if (!dd || dd.donor.key !== key) $("#rank-view").innerHTML = `<section class="rk-page">${empty("불러오는 중…")}</section>`;
    let d;
    try { d = await api(`api/donors/${encodeURIComponent(key)}?${rkQuery({ sort: null })}`); }
    catch { if (seq === ddSeq) $("#rank-view").innerHTML = `<section class="rk-page">${empty("후원 기록을 찾을 수 없어요.")}<p><a class="ghost-btn" href="#donors">← 후원자 랭킹으로</a></p></section>`; return; }
    if (seq !== ddSeq || current.donor !== key) return;
    dd = d;
    const { donor: o, summary: s, period: per } = d;
    const max = d.to[0]?.amount || 1;
    $("#rank-view").innerHTML = `
      <section class="rk-page md-page">
        <a class="md-back" href="#donors">← 후원자 랭킹</a>
        <header class="md-head">
          ${donorAvatar(o.nick, "huge")}
          <div class="md-title">
            <span class="rk-line1">${pfTag(o.platform)}<span class="muted">${esc(o.donor_id)}</span></span>
            <h2>${esc(o.nick)}</h2>
            <p class="md-chips">
              ${s.rank ? `<span class="md-chip strong">${esc(per.label)} ${s.rank}위 <small>/ ${s.of}명</small></span>` : `<span class="md-chip">${esc(per.label)} 후원 없음</span>`}
              ${s.change !== null && s.change !== undefined ? changeMark(s.change) : ""}
              <span class="md-chip">누적 🎈 ${fmtNum(o.all_total)}개</span>
            </p>
          </div>
        </header>
        <div class="md-toolbar"><div class="rk-period">${periodControls(dnData?.months || rkData?.months || homeData.time?.months)}</div><span class="md-range">${esc(per.label)} <b>${rangeText(per)}</b></span></div>
        <div class="md-stats">
          ${statTile("후원 합계", `🎈 ${fmtNum(s.total)}개`)}
          ${statTile("후원 횟수", `${fmtNum(s.count)}번`)}
          ${statTile("후원한 멤버", `${fmtNum(s.members)}명`)}
          ${statTile("한 번 최대", s.max ? `🎈 ${fmtNum(s.max)}개` : "-")}
          ${statTile("처음 후원", fmtDate(o.first_at), `마지막 ${fmtAgo(o.last_at)}`)}
        </div>
        <div class="md-grid">
          <section class="md-card">
            <h3>날짜별 후원</h3>
            <p class="md-total"><strong>🎈 ${fmtNum(s.total)}개</strong> <small>${esc(per.label)} 합계</small></p>
            <div class="chart" id="dd-chart"></div>
          </section>
          <aside class="md-side">
            <section class="md-card"><h3>멤버별 후원</h3>
              ${d.to.length ? `<ul class="cat-bars dn-bars">${d.to.map((t) => `<li><a href="${memberHref(t.id)}">${esc(t.name)}</a><span class="cat-bar"><span style="width:${Math.round((t.amount / max) * 100)}%"></span></span><b>${fmtNum(t.amount)}</b></li>`).join("")}</ul>` : '<p class="side-empty">이 기간에는 후원 기록이 없어요.</p>'}
            </section>
          </aside>
        </div>
        <section class="md-card"><h3>후원 기록</h3>
          ${d.recent.length ? recordTable(d.recent.slice(0, 30)) + (d.recent.length > 30 ? `<details class="more-rows"><summary>${d.recent.length - 30}건 더 보기</summary>${recordTable(d.recent.slice(30))}</details>` : "") : '<p class="side-empty">이 기간에는 후원 기록이 없어요.</p>'}
        </section>
      </section>`;
    drawChart($("#dd-chart"), d.daily, METRICS.find((x) => x.id === "donation"), null);
  }

  $("#rank-view").addEventListener("click", (e) => {
    if (current.page !== "donors") return;
    if (onPeriodEvent(e, periodReload)) return;
    const b = e.target.closest("[data-dn-member]");
    if (b) { DN.member = b.dataset.dnMember; renderDonorsPage(); }
  });
  $("#rank-view").addEventListener("input", (e) => {
    if (current.page !== "donors" || e.target.id !== "dn-search" || !dnData) return;
    DN.q = e.target.value;
    drawDonors();
  });

  // #ranking?sort=peak&live=1 처럼 들어오면 그 설정으로
  function renderRankingRoute(params) {
    if (params.get("sort") && SORTS_RK.some((s) => s.id === params.get("sort"))) RK.sort = params.get("sort");
    if (params.has("live")) RK.liveOnly = params.get("live") === "1";
    renderRankingPage();
  }

  /* ---------- 홈: 공지 · VOD · 쇼츠 ---------- */
  const NOTICE_COUNT = 8;
  const feedFail = (el) => { el.innerHTML = empty("불러오지 못했습니다."); };
  const ofCrew = (items) => items.filter(inCrew);

  async function loadHomeFeeds() {
    const crew = encodeURIComponent(mainCrew());
    await Promise.all([
      api(`api/notices?limit=${NOTICE_COUNT * 2}`).then(({ items }) => {
        const list = ofCrew(items).slice(0, NOTICE_COUNT);
        $("#notice-list").innerHTML = list.length ? list.map(noticeRow).join("") : `<li>${empty("아직 올라온 공지가 없어요. 멤버의 SOOP 방송국에 글이 올라오면 바로 여기에 떠요.")}</li>`;
      }).catch(() => feedFail($("#notice-list"))),
      api(`api/vods?limit=${SLIDER_COUNT}`).then(({ items }) => {
        const list = ofCrew(items);
        $("#slider-vod").innerHTML = list.length ? list.map(vodCard).join("") : empty("아직 올라온 VOD가 없어요. SOOP 다시보기가 올라오면 자동으로 들어와요.");
      }).catch(() => feedFail($("#slider-vod"))),
      api(`api/videos?type=short&crew=${crew}&latest=1&limit=${SLIDER_COUNT}`).then(({ items }) => {
        $("#slider-shorts").innerHTML = items.length ? items.map(videoCard).join("") : empty("아직 올라온 쇼츠가 없어요.");
      }).catch(() => feedFail($("#slider-shorts"))),
    ]);
  }

  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-slide]");
    if (!btn) return;
    const slider = $(`#slider-${btn.dataset.slide}`);
    slider.scrollBy({ left: slider.clientWidth * 0.9 * Number(btn.dataset.dir), behavior: "smooth" });
  });

  /* ---------- 크루 페이지 ---------- */
  // 더 불러오기 목록: short(쇼츠) · notice(공지) · vod
  const list = { type: "short", crew: "", channel: "", before: null };
  const channelUrl = (m) => `https://www.youtube.com/${m.handle ? m.handle : `channel/${m.youtube}`}`;
  const soopUrl = (m) => `https://www.sooplive.co.kr/station/${encodeURIComponent(m.soop)}`;
  const avatar = (m) => (m.thumb ? `<img src="${esc(m.thumb)}" alt="" loading="lazy">` : `<span class="member-avatar" aria-hidden="true"></span>`);

  function renderPage() {
    const { crew, page, channel } = current;
    const title = PAGES.find((p) => p.id === page).name;
    const member = site.members.find((m) => m.id === channel);
    $("#page-crumb").textContent = crewName(crew);
    const pageLogos = { live: "youtube soop", notice: "youtube soop", vod: "soop", shorts: "youtube" }[page];
    $("#page-title").innerHTML = `${pageLogos ? `<span class="pf-logos" data-logos="${pageLogos}"></span>` : ""}${esc(member ? `${title} · ${member.name}` : title)}`;
    $("#page-title").classList.toggle("logo-title", !!pageLogos);
    fillLogos($("#page-title"));
    $("#page-tools").innerHTML = "";
    $("#list-more").hidden = true;
    $("#page-tabs").innerHTML = PAGES.filter((p) => !p.hide || p.id === page).map((p) =>
      `<a href="${pageHref(crew, p.id, MEMBER_PAGES.includes(p.id) ? channel : null)}" class="${p.id === page ? "is-current" : ""}" ${p.id === page ? 'aria-current="page"' : ""}>${p.name}</a>`).join("");
    const body = $("#page-body");
    const crewSigs = () => sigs.filter((s) => s.crew === crew);

    if (page === "price") {
      const cats = [...new Set(crewSigs().map((s) => s.category).filter(Boolean))];
      const hasImages = crewSigs().some((s) => s.image_url);
      const hasFiles = crewSigs().some((s) => s.image_url || s.audio_url);
      let cat = "";
      let view = hasImages ? "image" : "table";
      $("#page-tools").innerHTML = `
        <label class="search"><span class="sr-only">시그 검색</span><input type="search" placeholder="시그 이름 · 단가 검색"></label>
        <label class="select"><span class="sr-only">정렬</span>
          <select><option value="sheet">기본 순서</option><option value="low">단가 낮은 순</option><option value="high">단가 높은 순</option><option value="new">최신 등록 순</option></select>
        </label>
        <div class="view-toggle" role="group" aria-label="보기 방식">
          <button type="button" data-view-mode="image" class="${view === "image" ? "is-active" : ""}">이미지</button>
          <button type="button" data-view-mode="table" class="${view === "table" ? "is-active" : ""}">표</button>
        </div>
        ${hasFiles ? `<a class="primary-btn" id="sig-zip" href="#">한 번에 다운로드</a>` : ""}`;
      body.innerHTML = `
        ${cats.length > 1 ? `<div class="chips cat-chips">${["", ...cats].map((c) => `<button type="button" class="chip ${c ? "" : "is-active"}" data-cat="${esc(c)}">${c ? esc(c) : "전체"}</button>`).join("")}</div>` : ""}
        <div class="sig-image-grid" hidden></div>
        <div class="table-wrap"><table class="sig-table">
          <thead><tr><th>분류</th><th>시그 이름</th><th class="num">시그단가</th><th class="center">레퍼런스 · 레슨</th></tr></thead>
          <tbody></tbody>
        </table></div>
        <nav class="pagination" aria-label="가격표 페이지"></nav>`;
      const sortSel = $("#page-tools select");
      const zip = $("#sig-zip");
      const zipHref = () => `api/sigs/download?crew=${encodeURIComponent(crew)}${cat ? `&category=${encodeURIComponent(cat)}` : ""}`;
      if (zip) zip.href = zipHref();
      const render = sigTable({
        search: $("#page-tools input"), body: $("tbody", body), pager: $(".pagination", body),
        rows: () => crewSigs().filter((s) => !cat || s.category === cat), sort: () => sortSel.value,
        grid: () => (view === "image" ? $(".sig-image-grid", body) : null),
      });
      const setView = (v) => {
        view = v;
        $$("[data-view-mode]").forEach((b) => b.classList.toggle("is-active", b.dataset.viewMode === v));
        $(".sig-image-grid", body).hidden = v !== "image";
        $(".table-wrap", body).hidden = v === "image";
        render();
      };
      $$("[data-view-mode]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.viewMode)));
      sortSel.addEventListener("change", render);
      $$("[data-cat]", body).forEach((b) => b.addEventListener("click", () => {
        cat = b.dataset.cat;
        $$("[data-cat]", body).forEach((x) => x.classList.toggle("is-active", x === b));
        if (zip) zip.href = zipHref();
        render();
      }));
      setView(view);
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
        ? `<div class="member-grid">${members.map(memberCard).join("")}</div>`
        : empty("등록된 멤버가 없습니다. 관리자 페이지의 멤버 · 채널에서 이 크루로 멤버를 추가하세요.");
    } else if (page === "live") {
      const off = site.members.filter((m) => !m.is_live && (m.youtube || m.soop));
      body.innerHTML = `${liveNow.length ? `<div class="live-grid">${liveNow.map(liveCard).join("")}</div>` : empty("지금 방송 중인 멤버가 없습니다. 방송을 켜면 1분 안에 여기에 떠요.")}
        ${off.length ? `<h3 class="sub-head">오프라인</h3><div class="member-chips wrap">${off.map((m) => `<span>${avatar(m)}${esc(m.name)}</span>`).join("")}</div>` : ""}`;
    } else if (MEMBER_PAGES.includes(page)) {
      Object.assign(list, { type: page === "shorts" ? "short" : page, crew, channel: channel || "", before: null });
      const need = { shorts: (m) => m.youtube, vod: (m) => m.soop, notice: (m) => m.youtube || m.soop }[page];
      const members = site.members.filter(need);
      const chips = members.length > 1 || channel
        ? `<nav class="member-chips" aria-label="계정별 보기">
             <a href="${pageHref(crew, page)}" class="${channel ? "" : "is-current"}">전체</a>
             ${members.map((m) => `<a href="${pageHref(crew, page, m.id)}" class="${m.id === channel ? "is-current" : ""}" ${m.id === channel ? 'aria-current="true"' : ""}>${avatar(m)}${esc(m.name)}</a>`).join("")}
           </nav>`
        : "";
      body.innerHTML = page === "notice"
        ? `${chips}<ul class="notice-list" id="list-grid"></ul>`
        : `${chips}<div class="video-grid ${page === "shorts" ? "is-shorts" : ""}" id="list-grid"></div>`;
      loadMore();
    }
  }

  /* ---------- 멤버 카드 · 자세히 (프로필 · 공약 · 시그) ---------- */
  function socialLinks(m) {
    return [
      ...m.youtubes.map((c) => `<a class="social yt" href="${esc(`https://www.youtube.com/${c.handle || `channel/${c.id}`}`)}" target="_blank" rel="noopener" title="유튜브">YouTube</a>`),
      ...m.soops.map((id) => `<a class="social soop" href="${esc(`https://www.sooplive.co.kr/station/${encodeURIComponent(id)}`)}" target="_blank" rel="noopener" title="SOOP 방송국">SOOP</a>`),
      m.instagram ? `<a class="social ig" href="${esc(m.instagram)}" target="_blank" rel="noopener" title="인스타그램">Instagram</a>` : "",
      m.kakao ? `<a class="social kakao" href="${esc(m.kakao)}" target="_blank" rel="noopener" title="카카오톡 오픈채팅">Kakao</a>` : "",
    ].join("");
  }
  const hasPromise = (m) => !!(m.promise_text || m.promise_image);
  // 방송 중이면 "LIVE 보러가기" (유튜브인지 SOOP 인지 로고로 표시)
  const liveLink = (m) => m.is_live && m.live_url
    ? `<a class="live-go" href="${esc(m.live_url)}" target="_blank" rel="noopener">${logo(m.live_platform)}<span class="live-dot"></span>LIVE 보러가기</a>`
    : "";

  const memberCard = (m) => `
    <article class="member-card">
      <button type="button" class="member-main" data-member-open="${esc(m.id)}">
        <span class="member-photo">${avatar(m)}${m.is_live ? '<span class="badge-live">LIVE</span>' : ""}</span>
        ${m.role_title ? `<span class="member-role">${esc(m.role_title)}</span>` : ""}
        <strong>${esc(m.name)}</strong>
        ${m.quote ? `<span class="member-quote">${esc(m.quote)}</span>` : ""}
      </button>
      ${liveLink(m)}
      <span class="member-socials">${socialLinks(m)}</span>
      <span class="member-btns">
        <button type="button" data-member-open="${esc(m.id)}" data-tab="profile" ${m.profile_text ? "" : "disabled"}>프로필</button>
        <button type="button" data-member-open="${esc(m.id)}" data-tab="promise" ${hasPromise(m) ? "" : "disabled"}>공약</button>
        <button type="button" data-member-open="${esc(m.id)}" data-tab="sigs" ${m.sig_ids.length ? "" : "disabled"}>시그</button>
      </span>
      ${m.youtube || m.soop ? `<span class="member-links"><a href="${pageHref(mainCrew(), "notice", m.id)}">공지</a>${m.soop ? `<a href="${pageHref(mainCrew(), "vod", m.id)}">VOD</a>` : ""}${m.youtube ? `<a href="${pageHref(mainCrew(), "shorts", m.id)}">쇼츠</a>` : ""}</span>` : ""}
    </article>`;

  const MP_TABS = [{ id: "profile", name: "프로필" }, { id: "promise", name: "공약" }, { id: "sigs", name: "시그" }];
  let mpMember = null;

  function openMember(id, tab) {
    const m = site.members.find((x) => x.id === id);
    if (!m) return;
    mpMember = m;
    $("#mp-head").innerHTML = `
      <span class="mp-photo">${avatar(m)}${m.is_live ? '<span class="badge-live">LIVE</span>' : ""}</span>
      <div class="mp-info">
        <p class="crumb">${esc([crewName(m.crew), m.role_title].filter(Boolean).join(" · "))}</p>
        <h2 id="mp-name">${esc(m.name)}</h2>
        ${m.quote ? `<p class="mp-quote">${esc(m.quote)}</p>` : ""}
        ${liveLink(m)}
        <span class="member-socials left">${socialLinks(m)}</span>
      </div>`;
    const first = tab || (m.profile_text ? "profile" : hasPromise(m) ? "promise" : m.sig_ids.length ? "sigs" : "profile");
    renderMemberTab(first);
    if (!$("#modal-member").open) $("#modal-member").showModal();
  }

  function renderMemberTab(tab) {
    const m = mpMember;
    $("#mp-tabs").innerHTML = MP_TABS.map((t) => `<button type="button" class="tab ${t.id === tab ? "is-active" : ""}" data-mp-tab="${t.id}" role="tab" aria-selected="${t.id === tab}">${t.name}</button>`).join("");
    const body = $("#mp-body");
    if (tab === "profile") {
      body.innerHTML = m.profile_text ? `<div class="mp-text">${esc(m.profile_text)}</div>` : empty("등록된 프로필이 없습니다.");
    } else if (tab === "promise") {
      body.innerHTML = hasPromise(m)
        ? `${m.promise_image ? `<a class="mp-promise-img" href="${esc(m.promise_image)}" target="_blank" rel="noopener"><img src="${esc(m.promise_image)}" alt="${esc(m.name)} 공약 이미지"></a>` : ""}
           ${m.promise_text ? `<div class="mp-text">${esc(m.promise_text)}</div>` : ""}`
        : empty("등록된 공약이 없습니다.");
    } else {
      const list = m.sig_ids.map((id) => sigs.find((sg) => sg.id === id)).filter(Boolean);
      body.innerHTML = list.length
        ? `<div class="sig-cards">${list.map((sg) => sigCard(sg)).join("")}</div>`
        : empty("등록된 시그가 없습니다.");
    }
  }

  document.addEventListener("click", (e) => {
    const open = e.target.closest("[data-member-open]");
    if (open) return openMember(open.dataset.memberOpen, open.dataset.tab);
    const tab = e.target.closest("[data-mp-tab]");
    if (tab) renderMemberTab(tab.dataset.mpTab);
  });

  async function loadMore() {
    const btn = $("#list-more");
    const grid = $("#list-grid");
    const req = { ...list };
    btn.disabled = true;
    try {
      const q = new URLSearchParams({ limit: LIST_COUNT, ...(req.channel ? { member: req.channel } : {}), ...(req.before ? { before: req.before } : {}) });
      const src = { short: { url: `api/videos?type=short&crew=${encodeURIComponent(req.crew)}&`, card: videoCard, at: "published_at", none: "아직 올라온 쇼츠가 없습니다." },
        notice: { url: "api/notices?", card: noticeRow, at: "at", none: "아직 올라온 공지가 없습니다." },
        vod: { url: "api/vods?", card: vodCard, at: "at", none: "아직 올라온 VOD가 없습니다." } }[req.type];
      const { items: raw, more } = await api(`${src.url}${q}`);
      if (grid !== $("#list-grid")) return; // 그새 다른 페이지로 이동함
      const items = req.type === "short" ? raw : ofCrew(raw);
      grid.insertAdjacentHTML("beforeend", items.map(src.card).join(""));
      if (!req.before && !items.length) grid.innerHTML = req.type === "notice" ? `<li>${empty(src.none)}</li>` : empty(src.none);
      list.before = raw.at(-1)?.[src.at] ?? list.before;
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
  const isNew = (ms, days = NEW_DAYS) => ms && (Date.now() - ms) / 864e5 <= days;
  // 시그 단가: 별풍선 개수
  const won = (n) => `${Number(n || 0).toLocaleString()}개`;
  const refsOf = (s) => String(s.ref_url || "").split(/\s+/).filter(Boolean);
  const SORTS = {
    sheet: () => 0,
    low: (a, b) => a.price - b.price,
    high: (a, b) => b.price - a.price,
    new: (a, b) => b.created_at - a.created_at,
  };
  const sigBadges = (s) =>
    `${s.ref_url ? `<span class="pill">레퍼런스${refsOf(s).length > 1 ? ` ${refsOf(s).length}` : ""}</span>` : ""}${s.lessons ? `<span class="pill on">레슨 ${s.lessons}</span>` : ""}`;

  // 가격표 이미지 보기: 시그 이미지가 있으면 이미지, 없으면 글자 카드
  const sigImageCard = (s) => `
    <button type="button" class="sig-image-card ${s.image_url ? "" : "no-image"}" data-sig-open="${s.id}">
      ${s.image_url
        ? `<img src="${esc(s.image_url)}" alt="${esc(s.name)} ${won(s.price)}" loading="lazy">`
        : `<span class="sig-image-text"><span class="cat">${esc(s.category)}</span><strong>${esc(s.name)}</strong><span class="sig-price">${won(s.price)}</span></span>`}
      ${isNew(s.created_at) ? '<span class="badge-new">NEW</span>' : ""}
      ${s.audio_url ? '<span class="has-audio" title="음원 있음">♪</span>' : ""}
    </button>`;

  const sigCard = (s, showDate) => `
    <button type="button" class="sig-card" data-sig-open="${s.id}">
      <strong>${esc(s.name)} ${isNew(s.created_at) ? '<span class="badge-new">NEW</span>' : ""}</strong>
      <span class="sig-price">${won(s.price)}</span>
      <span class="sig-badges">${sigBadges(s)}${showDate && s.last_lesson_at ? `<span class="muted">${fmtAgo(s.last_lesson_at)}</span>` : ""}</span>
    </button>`;

  // 검색 + 페이지 나누기가 있는 시그 표 (홈의 "새로 들어온 시그", 크루별 "전체 가격표")
  function sigTable({ search, body, pager, rows, sort = () => "sheet", showCrew = false, grid = () => null }) {
    let page = 1;
    const render = () => {
      const q = search.value.trim().toLowerCase().replace(/,/g, "");
      const list = rows()
        .filter((s) => !q || s.name.toLowerCase().includes(q) || String(s.price).includes(q))
        .sort(SORTS[sort()] || SORTS.sheet);
      const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
      page = Math.min(page, pages);
      const shown = list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

      const g = grid();
      if (g) g.innerHTML = shown.length ? shown.map(sigImageCard).join("") : empty(q ? "검색 결과가 없습니다." : "등록된 시그가 없습니다.");
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
    const files = s.image_url || s.audio_url
      ? `<section class="sig-files">
           ${s.image_url ? `<a class="sig-modal-img" href="${esc(s.image_url)}" target="_blank" rel="noopener"><img src="${esc(s.image_url)}" alt="${esc(s.name)} 시그 이미지"></a>` : ""}
           <div class="sig-file-tools">
             ${s.audio_url ? `<audio controls preload="metadata" src="${esc(s.audio_url)}"></audio>` : ""}
             <div class="sig-dl">
               ${s.audio_url ? `<a class="primary-btn" href="${esc(s.audio_url)}?dl=1" download>음원 받기 <small>${fmtSize(s.audio_size)}</small></a>` : ""}
               ${s.image_url ? `<a class="ghost-btn" href="${esc(s.image_url)}?dl=1" download>이미지 받기 <small>${fmtSize(s.image_size)}</small></a>` : ""}
             </div>
           </div>
         </section>`
      : "";
    // 레퍼런스가 여러 개면 영상 아래 1 · 2 · 3 버튼으로 바꿔 보기
    const refs = refsOf(s);
    const refPicker = refs.length > 1
      ? `<div class="ref-tabs" role="tablist" aria-label="레퍼런스 고르기">${refs.map((_, i) =>
          `<button type="button" role="tab" data-ref="${i}" class="${i ? "" : "is-active"}" aria-selected="${!i}">${i + 1}</button>`).join("")}</div>`
      : "";
    $("#sig-media").innerHTML = `${files}
      <section class="sig-ref" data-refs="${esc(refs.join(" "))}" data-title="${esc(s.name)}"><h3>${s.category === "신호탄" ? "신호탄" : "유튜브 레퍼런스"} ${refs.length > 1 ? `<span class="muted">${refs.length}</span>` : ""}</h3>
        ${refs.length ? `<div class="ref-player">${player(refs[0], s.name)}</div>${refPicker}` : '<p class="hint">등록된 레퍼런스가 없습니다.</p>'}</section>
      <section><h3>레슨 영상 ${s.items.length > 1 ? `<span class="muted">${s.items.length}</span>` : ""}</h3>${lessons}</section>`;
    if (!$("#modal-sig").open) $("#modal-sig").showModal();
  }

  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-sig-open]");
    if (el) openSig(el.dataset.sigOpen);
  });
  $("#sig-media").addEventListener("click", (e) => {
    const b = e.target.closest("[data-ref]");
    if (!b || b.classList.contains("is-active")) return;
    const sec = b.closest(".sig-ref");
    const url = refsOf({ ref_url: sec.dataset.refs })[Number(b.dataset.ref)];
    if (!url) return;
    $(".ref-player", sec).innerHTML = player(url, sec.dataset.title);
    sec.querySelectorAll("[data-ref]").forEach((x) => { x.classList.toggle("is-active", x === b); x.setAttribute("aria-selected", x === b); });
  });
  $("#modal-sig").addEventListener("close", () => { $("#sig-media").innerHTML = ""; openSigId = null; });

  /* ---------- 시작 ---------- */
  async function loadSite() {
    try { Object.assign(site, await api("api/site")); } catch {}
    // 한 크루만 쓰는 사이트: 첫 번째 크루와 그 멤버만
    site.crews = site.crews.slice(0, 1);
    site.members = site.members.filter(inCrew);
    renderBrand(site.brand || {});
    try { sigs = (await api("api/sigs")).filter(inCrew); } catch { sigs = []; }
    $("#backwall-member").innerHTML = site.members.length
      ? site.members.map((m) => `<option>${esc(m.name)}</option>`).join("")
      : "<option value=''>등록된 멤버가 없습니다</option>";
    renderUser();
  }

  // 로고(프사) · 배너 · 하단 유튜브/SOOP 링크 (관리자 › 사이트 꾸미기)
  function renderBrand(b) {
    const mark = $("#logo-mark");
    mark.classList.toggle("has-img", !!b.logo);
    mark.innerHTML = b.logo ? `<img src="${esc(b.logo)}" alt="">` : "1";
    if (b.logo) $("#site-icon").href = b.logo;

    const banner = $("#home-banner");
    banner.hidden = !b.banner;
    if (b.banner) {
      const img = `<img src="${esc(b.banner)}" alt="ONE PICK 배너">`;
      banner.innerHTML = b.banner_link ? `<a href="${esc(b.banner_link)}" target="_blank" rel="noopener">${img}</a>` : img;
    }

    const sns = [["youtube", "YouTube", b.youtube_url], ["soop", "SOOP", b.soop_url]];
    $("#footer-sns").innerHTML = sns.map(([pf, name, url]) => url
      ? `<a class="sns-link" href="${esc(url)}" target="_blank" rel="noopener" aria-label="ONE PICK ${name}">${logo(pf)}<span>${name}</span></a>`
      : `<span class="sns-link">${logo(pf)}<span>${name}</span></span>`).join("");
  }

  // 멤버 방송 상태(LIVE 표시) 1분마다 갱신
  async function refreshMembers() {
    let fresh;
    try { fresh = (await api("api/site")).members.filter(inCrew); } catch { return; }
    const was = site.members.map((m) => `${m.id}:${m.live_url}`).join();
    site.members = fresh;
    if (current.page === "members" && was !== fresh.map((m) => `${m.id}:${m.live_url}`).join()) renderPage();
  }

  loadSite().then(() => {
    fillLogos();
    renderHomeSigs = sigTable({ search: $("#sig-search"), body: $("#sig-list"), pager: $("#sig-pages"), rows: () => sigs, sort: () => "new" });
    route();
    loadLive();
    loadRanking();
    setInterval(() => { loadLive(); loadRanking(); refreshMembers(); }, REFRESH_MS);
    // 공지 · VOD · 쇼츠 새로 반영 (홈 화면에서만, 1분마다)
    setInterval(() => { if (current.page === "home") loadHomeFeeds(); }, REFRESH_MS);
  });
})();
