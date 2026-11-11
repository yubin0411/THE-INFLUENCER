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
    { id: "live", name: "LIVE" },
    { id: "notice", name: "공지" },
    { id: "vod", name: "VOD" },
    { id: "shorts", name: "쇼츠" },
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
    const home = current.page === "home";
    $("#home-view").hidden = !home;
    $("#page-view").hidden = home;
    if (home) {
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
      + PAGES.map((p) => link(pageHref(mainCrew(), p.id), p.name, current.page === p.id)).join("");
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

  /* ---------- 방송 시간 순위 ---------- */
  let rank = null;          // 이번 달 순위 (홈 화면)
  let rankView = null;      // 자세히 보기에서 보고 있는 달
  let rankCrew = "all";
  const MEDALS = ["1st", "2nd", "3rd"];
  const monthLabel = (k) => `${Number(k.slice(0, 4))}년 ${Number(k.slice(5))}월`;
  const fmtHours = (sec = 0) => {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    return h ? `${h}시간 ${m}분` : `${m}분`;
  };
  const fmtTime = (ms) => {
    const d = new Date(ms);
    return `${d.getMonth() + 1}.${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const liveBadges = (it) =>
    `${it.yt_live ? '<span class="badge-live inline">LIVE · 유튜브</span>' : ""}${it.soop_live ? '<span class="badge-live inline soop">LIVE · SOOP</span>' : ""}`;
  const memberAvatar = (it, cls = "") =>
    it.thumb ? `<img class="${cls}" src="${esc(it.thumb)}" alt="" loading="lazy">` : `<span class="${cls} member-avatar" aria-hidden="true"></span>`;

  // 순위에서 이 크루 멤버만 남기고 순위를 다시 매김
  function onlyCrew(r) {
    if (!r) return r;
    const items = r.items.filter(inCrew).map((it) => ({ ...it }));
    let rank = 0;
    items.forEach((it, i) => { it.rank = it.seconds ? (i && items[i - 1].seconds === it.seconds ? rank : (rank = i + 1)) : null; });
    return { ...r, items };
  }

  async function loadRanking() {
    try { rank = await api("api/ranking"); } catch { return; }
    rank = onlyCrew(rank);
    if (current.page === "home") renderRank();
    // 자세히 보기가 이번 달을 보고 있으면 같이 갱신
    if ($("#modal-rank").open && rankView?.current) { rankView = rank; renderRankTable(); }
  }

  function renderRank() {
    if (!rank) { $("#rank-podium").innerHTML = `<li class="podium-empty">${empty("불러오는 중…")}</li>`; return; }
    const top = rank.items.filter((it) => it.seconds > 0).slice(0, 3);
    const live = rank.items.filter((it) => it.is_live).length;
    $("#rank-note").textContent = `${monthLabel(rank.month)} · 1분마다 갱신${live ? ` · ${live}명 방송 중` : ""}`;
    $("#rank-podium").innerHTML = top.length
      ? top.map((it) => `
        <li class="podium-card place-${it.rank > 3 ? 3 : it.rank}">
          <button type="button" class="podium-btn" data-rank-open="${esc(it.id)}">
            <span class="medal" aria-label="${it.rank}위">${MEDALS[it.rank - 1] || `${it.rank}th`}</span>
            <span class="podium-avatar">${memberAvatar(it)}${it.is_live ? '<span class="badge-live">LIVE</span>' : ""}</span>
            <strong class="podium-name">${esc(it.name)}</strong>
            <span class="podium-time">${fmtHours(it.seconds)}</span>
            <span class="podium-sub">방송 ${it.days}일 · ${it.sessions}회</span>
          </button>
        </li>`).join("")
      : `<li class="podium-empty">${empty(`${monthLabel(rank.month)} 방송 기록이 아직 없어요. 멤버가 방송을 켜면 자동으로 집계됩니다.`)}</li>`;
  }

  async function openRanking(memberId) {
    rankView = rank;
    rankCrew = "all";
    const sel = $("#rank-month");
    sel.innerHTML = (rank?.months || []).map((k) => `<option value="${k}">${monthLabel(k)}</option>`).join("");
    sel.value = rank?.month || "";
    renderRankTable();
    $("#modal-rank").showModal();
    if (memberId) toggleSessions(memberId);
  }

  function renderRankTable() {
    if (!rankView) return;
    const crews = site.crews.filter((c) => rankView.items.some((it) => it.crew === c.id));
    if (!crews.some((c) => c.id === rankCrew)) rankCrew = "all";
    $("#rank-crew").innerHTML = crews.length > 1
      ? [{ id: "all", name: "전체" }, ...crews].map((c) => `<button type="button" class="chip ${c.id === rankCrew ? "is-active" : ""}" data-rank-crew="${esc(c.id)}">${esc(c.name)}</button>`).join("")
      : "";
    const items = rankView.items.filter((it) => rankCrew === "all" || it.crew === rankCrew);
    const total = items.reduce((a, it) => a + it.seconds, 0);
    const active = items.filter((it) => it.seconds > 0).length;
    $("#rank-summary").textContent = `${monthLabel(rankView.month)} · 방송한 멤버 ${active}/${items.length}명 · 합계 ${fmtHours(total)}${rankView.current ? " · 진행 중인 달" : ""}`;
    $("#rank-list").innerHTML = items.length
      ? items.map((it) => `
        <tr class="clickable rank-row ${it.rank && it.rank <= 3 ? `top-${it.rank}` : ""}" data-rank-member="${esc(it.id)}" tabindex="0">
          <td class="center"><span class="rank-num">${it.rank ?? "-"}</span></td>
          <td><span class="rank-member">${memberAvatar(it, "rank-avatar")}<span><strong>${esc(it.name)}</strong>${it.crew ? `<small>${esc(crewName(it.crew))}</small>` : ""}</span></span></td>
          <td class="num"><strong>${fmtHours(it.seconds)}</strong></td>
          <td class="num">${it.days}일</td>
          <td class="num">${it.sessions}회</td>
          <td class="center">${liveBadges(it) || '<span class="muted">오프라인</span>'}</td>
        </tr>`).join("")
      : `<tr><td colspan="6">${empty("등록된 멤버가 없습니다.")}</td></tr>`;
  }

  async function toggleSessions(memberId) {
    const row = $(`[data-rank-member="${CSS.escape(memberId)}"]`, $("#rank-list"));
    if (!row) return;
    const next = row.nextElementSibling;
    if (next?.classList.contains("rank-sessions")) { next.remove(); return; }
    const detail = document.createElement("tr");
    detail.className = "rank-sessions";
    detail.innerHTML = `<td colspan="6">${empty("불러오는 중…")}</td>`;
    row.after(detail);
    const month = rankView.month;
    try {
      const { items } = await api(`api/ranking/sessions?member=${encodeURIComponent(memberId)}&month=${month}`);
      detail.firstElementChild.innerHTML = items.length
        ? `<ul class="session-list">${items.map((b) => `
            <li>
              <span class="badge-platform ${b.platform}">${b.platform === "soop" ? "SOOP" : "YouTube"}</span>
              <span class="session-title">${esc(b.title || "(제목 없음)")}</span>
              <span class="session-time">${fmtTime(b.started_at)} ~ ${b.ended_at ? fmtTime(b.ended_at) : '<b class="on-air">방송 중</b>'}</span>
              <span class="session-len">${fmtHours(b.seconds)}</span>
            </li>`).join("")}</ul>`
        : empty(`${monthLabel(month)}에는 방송 기록이 없습니다.`);
    } catch {
      detail.firstElementChild.innerHTML = empty("불러오지 못했습니다.");
    }
  }

  document.addEventListener("click", (e) => {
    const open = e.target.closest("[data-rank-open]");
    if (open) return openRanking(open.dataset.rankOpen || null);
    const crew = e.target.closest("[data-rank-crew]");
    if (crew) { rankCrew = crew.dataset.rankCrew; return renderRankTable(); }
    const row = e.target.closest("[data-rank-member]");
    if (row) toggleSessions(row.dataset.rankMember);
  });
  $("#rank-list").addEventListener("keydown", (e) => {
    const row = e.target.closest("[data-rank-member]");
    if (row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggleSessions(row.dataset.rankMember); }
  });
  $("#rank-month").addEventListener("change", async (e) => {
    try {
      rankView = onlyCrew(await api(`api/ranking?month=${e.target.value}`));
      renderRankTable();
    } catch {}
  });

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
    $("#page-tabs").innerHTML = PAGES.map((p) =>
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
    if (site.crews[0]) document.title = site.crews[0].name;
    try { sigs = (await api("api/sigs")).filter(inCrew); } catch { sigs = []; }
    $("#backwall-member").innerHTML = site.members.length
      ? site.members.map((m) => `<option>${esc(m.name)}</option>`).join("")
      : "<option value=''>등록된 멤버가 없습니다</option>";
    renderUser();
  }

  // 멤버 방송 상태(LIVE 표시) 1분마다 갱신
  async function refreshMembers() {
    let fresh;
    try { fresh = (await api("api/site")).members.filter(inCrew); } catch { return; }
    const was = site.members.map((m) => `${m.id}:${m.live_url}`).join();
    site.members = fresh;
    if (current.page === "members" && was !== fresh.map((m) => `${m.id}:${m.live_url}`).join()) renderPage();
  }

  $("#year").textContent = new Date().getFullYear();
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
