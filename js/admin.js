(() => {
  initTheme($("#theme-toggle"));

  const STATUS = { pending: "승인 대기", approved: "승인됨", rejected: "거절됨" };
  let crews = [];
  let userFilter = "pending";
  let requestFilter = "all";

  /* ---------- 로그인 ---------- */
  async function boot() {
    const { user } = await api("api/site").catch(() => ({}));
    const isAdmin = user?.role === "admin";
    $("#login-view").hidden = isAdmin;
    $("#admin-view").hidden = !isAdmin;
    $("#logout-btn").hidden = !user;
    if (user && !isAdmin) $(".form-note", $("#admin-login")).textContent = "관리자 계정이 아닙니다.";
    if (isAdmin) await Promise.all([loadCrews(), loadUsers(), loadCodes(), loadChannels(), loadRequests()]);
  }

  $("#admin-login").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      await api("api/auth/login", f);
      e.target.reset();
      await boot();
    } catch (err) {
      $(".form-note", e.target).textContent = err.message;
    }
  });

  $("#logout-btn").addEventListener("click", async () => {
    await api("api/auth/logout", {}).catch(() => {});
    location.reload();
  });

  /* ---------- 탭 ---------- */
  $$(".admin-tabs [data-panel]").forEach((tab) => tab.addEventListener("click", () => {
    $$(".admin-tabs [data-panel]").forEach((t) => t.classList.toggle("is-active", t === tab));
    $$("[data-view]").forEach((v) => (v.hidden = v.dataset.view !== tab.dataset.panel));
  }));

  // 버튼 처리 중 중복 클릭 방지 + 오류 표시
  async function act(btn, fn) {
    btn.disabled = true;
    try { await fn(); } catch (err) { alertNote(err.message); } finally { btn.disabled = false; }
  }
  const alertNote = (msg) => {
    const view = $("[data-view]:not([hidden])");
    const note = $(".form-note", view) || view.insertAdjacentElement("afterbegin", Object.assign(document.createElement("p"), { className: "form-note" }));
    note.textContent = msg;
  };

  /* ---------- 회원 ---------- */
  async function loadUsers() {
    const users = await api("api/admin/users");
    const pending = users.filter((u) => u.status === "pending").length;
    $("#pending-count").textContent = pending;
    $("#pending-count").hidden = !pending;

    const list = userFilter === "all" ? users : users.filter((u) => u.status === userFilter);
    $("#user-list").innerHTML = list.length
      ? list.map((u) => `
        <tr>
          <td><strong>${esc(u.username)}</strong>${u.role === "admin" ? ' <span class="tag">관리자</span>' : ""}</td>
          <td>${esc(u.nickname)}</td>
          <td><code>${esc(u.code || "-")}</code></td>
          <td>${fmtDate(u.created_at)}</td>
          <td><span class="status status-${u.status}">${STATUS[u.status]}</span></td>
          <td class="right actions" data-user="${u.id}">
            ${u.status !== "approved" ? '<button type="button" class="mini-action ok" data-set="approved">승인</button>' : ""}
            ${u.status !== "rejected" && u.role !== "admin" ? '<button type="button" class="mini-action" data-set="rejected">거절</button>' : ""}
            ${u.status === "approved" ? `<button type="button" class="mini-action" data-role="${u.role === "admin" ? "member" : "admin"}">${u.role === "admin" ? "관리자 해제" : "관리자 지정"}</button>` : ""}
            <button type="button" class="mini-action danger" data-delete>삭제</button>
          </td>
        </tr>`).join("")
      : `<tr><td colspan="6"><div class="empty">${userFilter === "pending" ? "승인 대기 중인 회원이 없습니다." : "회원이 없습니다."}</div></td></tr>`;
  }

  $("#user-filter").addEventListener("click", (e) => {
    const b = e.target.closest("[data-status]");
    if (!b) return;
    userFilter = b.dataset.status;
    $$("#user-filter .chip").forEach((c) => c.classList.toggle("is-active", c === b));
    loadUsers();
  });

  const confirmClick = (btn) => {
    // 삭제는 한 번 더 눌러야 실행
    if (btn.dataset.armed) return true;
    btn.dataset.armed = "1";
    const label = btn.textContent;
    btn.textContent = "한 번 더 누르면 삭제";
    setTimeout(() => { delete btn.dataset.armed; btn.textContent = label; }, 3000);
    return false;
  };

  $("#user-list").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const id = btn.closest("[data-user]").dataset.user;
    if (btn.hasAttribute("data-delete") && !confirmClick(btn)) return;
    const body = btn.dataset.set ? { status: btn.dataset.set } : btn.dataset.role ? { role: btn.dataset.role } : { action: "delete" };
    act(btn, async () => { await api(`api/admin/users/${id}`, body); await loadUsers(); });
  });

  /* ---------- 승인코드 ---------- */
  async function loadCodes() {
    const codes = await api("api/admin/codes");
    $("#code-list").innerHTML = codes.length
      ? codes.map((c) => `
        <tr>
          <td><code class="code-chip">${esc(c.code)}</code> <button type="button" class="mini-action" data-copy="${esc(c.code)}">복사</button></td>
          <td>${esc(c.memo)}</td>
          <td class="num">${c.uses}${c.max_uses != null ? ` / ${c.max_uses}` : ""}</td>
          <td>${c.active ? (c.max_uses != null && c.uses >= c.max_uses ? '<span class="status status-rejected">소진</span>' : '<span class="status status-approved">사용 중</span>') : '<span class="status status-pending">중지</span>'}</td>
          <td>${fmtDate(c.created_at)}</td>
          <td class="right actions" data-code="${esc(c.code)}">
            <button type="button" class="mini-action" data-active="${c.active ? 0 : 1}">${c.active ? "중지" : "다시 사용"}</button>
            <button type="button" class="mini-action danger" data-delete>삭제</button>
          </td>
        </tr>`).join("")
      : `<tr><td colspan="6"><div class="empty">만든 승인코드가 없습니다.</div></td></tr>`;
  }

  $("#code-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      const r = await api("api/admin/codes", f);
      e.target.reset();
      $("#code-note").textContent = `코드 생성: ${r.code}`;
      await loadCodes();
    } catch (err) {
      $("#code-note").textContent = err.message;
    }
  });

  $("#code-list").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    if (btn.dataset.copy) {
      navigator.clipboard?.writeText(btn.dataset.copy).then(() => { btn.textContent = "복사됨"; setTimeout(() => (btn.textContent = "복사"), 1500); });
      return;
    }
    const code = btn.closest("[data-code]").dataset.code;
    if (btn.hasAttribute("data-delete") && !confirmClick(btn)) return;
    const body = btn.hasAttribute("data-delete") ? { action: "delete" } : { active: btn.dataset.active === "1" };
    act(btn, async () => { await api(`api/admin/codes/${encodeURIComponent(code)}`, body); await loadCodes(); });
  });

  /* ---------- 크루 ---------- */
  const crewOptions = (selected) => `<option value="">(크루 없음)</option>` +
    crews.map((c) => `<option value="${esc(c.id)}" ${c.id === selected ? "selected" : ""}>${esc(c.name)}</option>`).join("");

  async function loadCrews() {
    crews = await api("api/admin/crews");
    $$(".crew-select").forEach((s) => (s.innerHTML = crewOptions(s.value)));
    $("#crew-list").innerHTML = crews.length
      ? crews.map((c) => `
        <tr data-crew-row="${esc(c.id)}">
          <td><input class="cell-input" name="name" value="${esc(c.name)}" maxlength="30"></td>
          <td><input class="cell-input small" name="sort" type="number" value="${c.sort}"></td>
          <td><code>${esc(c.id)}</code></td>
          <td class="right actions">
            <button type="button" class="mini-action ok" data-save>저장</button>
            <button type="button" class="mini-action danger" data-delete>삭제</button>
          </td>
        </tr>`).join("")
      : `<tr><td colspan="4"><div class="empty">크루가 없습니다.</div></td></tr>`;
  }

  $("#crew-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("api/admin/crews", Object.fromEntries(new FormData(e.target)));
      e.target.reset();
      $("#crew-note").textContent = "크루를 추가했습니다.";
      await Promise.all([loadCrews(), loadChannels()]);
    } catch (err) {
      $("#crew-note").textContent = err.message;
    }
  });

  $("#crew-list").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const row = btn.closest("[data-crew-row]");
    const id = row.dataset.crewRow;
    if (btn.hasAttribute("data-delete")) {
      if (!confirmClick(btn)) return;
      return act(btn, async () => { await api(`api/admin/crews/${encodeURIComponent(id)}/delete`, {}); await Promise.all([loadCrews(), loadChannels()]); });
    }
    act(btn, async () => {
      await api("api/admin/crews", { id, name: $('[name="name"]', row).value, sort: $('[name="sort"]', row).value });
      $("#crew-note").textContent = "저장했습니다.";
      await Promise.all([loadCrews(), loadChannels()]);
    });
  });

  /* ---------- 유튜브 채널 ---------- */
  async function loadChannels() {
    const channels = await api("api/admin/channels");
    $("#channel-list").innerHTML = channels.length
      ? channels.map((c) => `
        <article class="channel-card" data-channel="${esc(c.id)}">
          ${c.thumb ? `<img class="channel-thumb" src="${esc(c.thumb)}" alt="">` : '<div class="channel-thumb"></div>'}
          <div class="channel-info">
            <a href="https://www.youtube.com/channel/${esc(c.id)}" target="_blank" rel="noopener"><strong>${esc(c.title)}</strong></a>
            <span>${esc(c.handle || c.id)}</span>
            <span class="channel-stats">
              ${c.is_live ? '<span class="badge-live">LIVE</span>' : ""}
              게시글 ${c.posts} · Shorts ${c.shorts} · 확인 ${c.synced_at ? fmtAgo(c.synced_at) : "-"}
            </span>
          </div>
          <label class="field">멤버 이름<input class="cell-input" name="name" value="${esc(c.name)}" maxlength="30" placeholder="${esc(c.title)}"></label>
          <label class="field">크루<select class="cell-input" name="crew">${crewOptions(c.crew_id)}</select></label>
          <div class="actions">
            <button type="button" class="mini-action ok" data-save>저장</button>
            <button type="button" class="mini-action danger" data-delete>삭제</button>
          </div>
        </article>`).join("")
      : '<div class="empty">등록된 채널이 없습니다. 위에서 채널을 추가하세요.</div>';
  }

  $("#channel-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $('[type="submit"]', e.target);
    const note = $("#channel-note");
    btn.disabled = true;
    note.textContent = "채널 확인하고 영상 가져오는 중… (최대 1분 정도 걸릴 수 있어요)";
    try {
      const r = await api("api/admin/channels", Object.fromEntries(new FormData(e.target)));
      e.target.reset();
      note.textContent = r.message;
      await loadChannels();
    } catch (err) {
      note.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  $("#channel-list").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const card = btn.closest("[data-channel]");
    const id = card.dataset.channel;
    if (btn.hasAttribute("data-delete")) {
      if (!confirmClick(btn)) return;
      return act(btn, async () => { await api(`api/admin/channels/${id}`, { action: "delete" }); await loadChannels(); });
    }
    act(btn, async () => {
      await api(`api/admin/channels/${id}`, { name: $('[name="name"]', card).value, crew: $('[name="crew"]', card).value });
      $("#channel-note").textContent = "저장했습니다.";
      await loadChannels();
    });
  });

  $("#sync-btn").addEventListener("click", (e) => act(e.currentTarget, async () => {
    $("#channel-note").textContent = "새로고침 중…";
    await api("api/admin/sync", {});
    $("#channel-note").textContent = "새로고침 완료";
    await loadChannels();
  }));

  /* ---------- 요청함 ---------- */
  async function loadRequests() {
    const reqs = await api("api/admin/requests");
    const unread = reqs.filter((r) => !r.is_read).length;
    $("#unread-count").textContent = unread;
    $("#unread-count").hidden = !unread;

    const list = requestFilter === "all" ? reqs : reqs.filter((r) => r.type === requestFilter);
    $("#request-list").innerHTML = list.length
      ? list.map((r) => {
        const d = r.data;
        const body = r.type === "backwall"
          ? `<p><b>멤버</b> ${esc(d.member || "-")}</p><p class="pre">${esc(d.content)}</p>`
          : `<p><b>곡</b> ${esc(d.song)}${d.artist ? ` — ${esc(d.artist)}` : ""}</p>
             ${d.url ? `<p><a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">${esc(d.url)}</a></p>` : ""}
             ${d.memo ? `<p class="pre">${esc(d.memo)}</p>` : ""}`;
        return `
          <article class="request-card ${r.is_read ? "is-read" : ""}" data-request="${r.id}">
            <header>
              <span class="tag">${r.type === "backwall" ? "백월 요청" : "추천 노래"}</span>
              <strong>${esc(r.nickname || "탈퇴 회원")}</strong><span class="muted">${esc(r.username || "")}</span>
              <span class="muted right">${fmtAgo(r.created_at)}</span>
            </header>
            ${body}
            ${r.image ? `<button type="button" class="request-image" data-image="uploads/${esc(r.image)}"><img src="uploads/${esc(r.image)}" alt="첨부 사진"></button>` : ""}
            <div class="actions">
              <button type="button" class="mini-action" data-read="${r.is_read ? 0 : 1}">${r.is_read ? "안 읽음으로" : "읽음 처리"}</button>
              <button type="button" class="mini-action danger" data-delete>삭제</button>
            </div>
          </article>`;
      }).join("")
      : '<div class="empty">받은 요청이 없습니다.</div>';
  }

  $("#request-filter").addEventListener("click", (e) => {
    const b = e.target.closest("[data-type]");
    if (!b) return;
    requestFilter = b.dataset.type;
    $$("#request-filter .chip").forEach((c) => c.classList.toggle("is-active", c === b));
    loadRequests();
  });

  $("#request-list").addEventListener("click", (e) => {
    const img = e.target.closest("[data-image]");
    if (img) { $("#image-view").src = img.dataset.image; return $("#modal-image").showModal(); }
    const btn = e.target.closest("button");
    if (!btn) return;
    const id = btn.closest("[data-request]").dataset.request;
    if (btn.hasAttribute("data-delete") && !confirmClick(btn)) return;
    const body = btn.hasAttribute("data-delete") ? { action: "delete" } : { read: btn.dataset.read === "1" };
    act(btn, async () => { await api(`api/admin/requests/${id}`, body); await loadRequests(); });
  });

  /* ---------- 내 계정 ---------- */
  $("#password-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const note = $(".form-note", e.target);
    try {
      if (f.next !== f.next2) throw new Error("새 비밀번호가 서로 다릅니다.");
      await api("api/auth/password", { current: f.current, next: f.next });
      e.target.reset();
      note.textContent = "비밀번호를 변경했습니다.";
    } catch (err) {
      note.textContent = err.message;
    }
  });

  boot();
  // 새 가입 신청 / 요청 주기적으로 확인
  setInterval(() => { if (!$("#admin-view").hidden) { loadUsers(); loadRequests(); } }, 60 * 1000);
})();
