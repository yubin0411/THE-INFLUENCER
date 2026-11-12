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
    if (!isAdmin) return;
    await loadCrews(); // 채널 · 방송 기록의 크루 표시에 필요
    await Promise.all([loadUsers(), loadCodes(), loadChannels(), loadRequests(), loadBrand()]);
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
  const fmtPhone = (p = "") => p.replace(/^(\d{3})(\d{3,4})(\d{4})$/, "$1-$2-$3");
  async function loadUsers() {
    const [users, st] = await Promise.all([api("api/admin/users"), api("api/admin/settle")]);
    const memberOpts = (cur) => `<option value="">연결 안 함</option>` + st.members.map((m) => {
      const taken = users.find((u) => u.member_id === m.id && u.member_id !== cur);
      return `<option value="${m.id}" ${m.id === cur ? "selected" : ""} ${taken ? "disabled" : ""}>${esc(m.name)}${taken ? ` (${esc(taken.username)})` : ""}</option>`;
    }).join("");
    const pending = users.filter((u) => u.status === "pending").length;
    $("#pending-count").textContent = pending;
    $("#pending-count").hidden = !pending;

    const list = userFilter === "all" ? users : users.filter((u) => u.status === userFilter);
    $("#user-list").innerHTML = list.length
      ? list.map((u) => `
        <tr>
          <td><strong>${esc(u.username)}</strong>${u.role === "admin" ? ' <span class="tag">관리자</span>' : ""}</td>
          <td>${esc(u.nickname)}</td>
          <td class="user-info">${u.real_name || u.phone || u.account
            ? `<b>${esc(u.real_name)}</b>${u.alias ? ` <span class="muted">가명 ${esc(u.alias)}</span>` : ""}<br>
               <span class="muted">${esc(fmtPhone(u.phone))}</span><br>
               <span class="muted">${esc(u.bank)} ${esc(u.account)}</span>`
            : '<span class="muted">-</span>'}</td>
          <td data-user="${u.id}"><select class="cell-input member-link" aria-label="연결 멤버">${memberOpts(u.member_id)}</select></td>
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
      : `<tr><td colspan="8"><div class="empty">${userFilter === "pending" ? "승인 대기 중인 회원이 없습니다." : "회원이 없습니다."}</div></td></tr>`;
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

  // 회원 ↔ 멤버 연결: 연결하면 그 회원이 사이트에서 자기 멤버 프로필 · 정산을 봄
  $("#user-list").addEventListener("change", async (e) => {
    const sel = e.target.closest(".member-link");
    if (!sel) return;
    sel.disabled = true;
    try { await api(`api/admin/users/${sel.closest("[data-user]").dataset.user}`, { member_id: sel.value ? Number(sel.value) : null }); await loadUsers(); }
    catch (err) { alertNote(err.message); await loadUsers(); }
  });

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
    $$(".crew-pick").forEach((s) => {
      const prev = s.value;
      s.innerHTML = crews.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("");
      if (crews.some((c) => c.id === prev)) s.value = prev;
    });
    $("#crew-list").innerHTML = crews.length
      ? crews.map((c, i) => `
        <tr data-crew-row="${esc(c.id)}">
          <td class="order-cell">
            <button type="button" class="mini-action" data-move="-1" aria-label="위로" ${i === 0 ? "disabled" : ""}>▲</button>
            <button type="button" class="mini-action" data-move="1" aria-label="아래로" ${i === crews.length - 1 ? "disabled" : ""}>▼</button>
          </td>
          <td><input class="cell-input" name="name" value="${esc(c.name)}" maxlength="30" aria-label="크루 이름"></td>
          <td><code>${esc(c.id)}</code></td>
          <td class="right actions">
            <button type="button" class="mini-action ok" data-save>이름 저장</button>
            <button type="button" class="mini-action danger" data-delete>삭제</button>
          </td>
        </tr>`).join("")
      : `<tr><td colspan="4"><div class="empty">크루가 없습니다.</div></td></tr>`;
    await Promise.all([loadSigs(), loadFiles(), loadSheets()]);
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
    if (btn.dataset.move) {
      return act(btn, async () => { await api(`api/admin/crews/${encodeURIComponent(id)}/move`, { dir: Number(btn.dataset.move) }); await loadCrews(); });
    }
    act(btn, async () => {
      await api("api/admin/crews", { id, name: $('[name="name"]', row).value });
      $("#crew-note").textContent = "저장했습니다.";
      await Promise.all([loadCrews(), loadChannels()]);
    });
  });

  /* ---------- 파일 올리기 (진행률 표시) ---------- */
  function upload(url, file, bar) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const done = () => { if (bar) bar.hidden = true; };
      xhr.open("POST", url);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.setRequestHeader("X-Upload", "1");
      xhr.setRequestHeader("X-Filename", encodeURIComponent(file.name));
      xhr.upload.onprogress = (e) => {
        if (!bar || !e.lengthComputable) return;
        bar.hidden = false;
        bar.firstElementChild.style.width = `${(e.loaded / e.total) * 100}%`;
      };
      xhr.onload = () => {
        done();
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch {}
        xhr.status < 300 ? resolve(data) : reject(new Error(data.error || "업로드에 실패했습니다."));
      };
      xhr.onerror = () => { done(); reject(new Error("업로드 중 연결이 끊겼습니다.")); };
      xhr.send(file);
    });
  }

  /* ---------- 사이트 꾸미기 (로고 · 배너 · 링크) ---------- */
  function drawBrand(b) {
    $("#brand-logo").innerHTML = b.logo ? `<img src="${esc(b.logo)}" alt="로고">` : '<span class="hint">아직 없음</span>';
    $("#brand-banner").innerHTML = b.banner ? `<img src="${esc(b.banner)}" alt="배너">` : '<span class="hint">아직 없음 (홈에 배너 칸이 안 보임)</span>';
    $$("[data-brand-del]").forEach((x) => (x.hidden = !b[x.dataset.brandDel]));
    for (const k of ["banner_link", "youtube_url", "soop_url"]) $(`#brand-form [name="${k}"]`).value = b[k] || "";
  }
  async function loadBrand() { drawBrand((await api("api/site")).brand || {}); }

  $$("[data-brand-file]").forEach((input) => input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    $("#brand-note").textContent = "올리는 중…";
    try {
      drawBrand(await upload(`api/admin/brand/image?kind=${input.dataset.brandFile}`, file));
      $("#brand-note").textContent = "올렸습니다. 사이트를 새로고침하면 보입니다.";
    } catch (err) { $("#brand-note").textContent = err.message; }
    input.value = "";
  }));
  $$("[data-brand-del]").forEach((btn) => btn.addEventListener("click", () => {
    if (!confirmClick(btn)) return;
    act(btn, async () => { drawBrand(await api("api/admin/brand/image/delete", { kind: btn.dataset.brandDel })); $("#brand-note").textContent = "지웠습니다."; });
  }));
  $("#brand-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const btn = $('button[type="submit"]', e.target);
    act(btn, async () => { drawBrand(await api("api/admin/brand", Object.fromEntries(new FormData(e.target)))); $("#brand-note").textContent = "저장했습니다."; });
  });

  /* ---------- 시그 · 레슨 영상 ---------- */
  const KIND = { youtube: "유튜브", drive: "드라이브", link: "링크", file: "파일", pending: "파일 대기" };
  let sigs = [];
  let sigFilter = "all";
  const openSigs = new Set();
  const sigCrew = () => $("#sig-crew").value;

  async function loadSigs() {
    if (!sigCrew()) { sigs = []; return renderSigs(); }
    sigs = await api(`api/admin/sigs?crew=${encodeURIComponent(sigCrew())}`);
    renderSigs();
  }

  function lessonHtml(l) {
    const label = l.title || l.url;
    const body = l.kind === "pending"
      ? `<span class="lesson-title">${esc(label)}</span>
         <label class="mini-action ok file-btn">영상 파일 올리기<input type="file" accept="video/*" data-fill="${l.id}" hidden></label>`
      : l.kind === "file"
        ? `<span class="lesson-title">${esc(label)}</span><span class="muted">${fmtSize(l.size)}</span>`
        : `<a class="lesson-title" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(label)}</a>`;
    return `<li class="lesson ${l.kind}"><span class="kind">${KIND[l.kind] || l.kind}</span>${body}
      <button type="button" class="mini-action danger" data-lesson-del="${l.id}">삭제</button></li>`;
  }

  function renderSigs() {
    const q = $("#sig-search-admin").value.trim().toLowerCase();
    const list = sigs.filter((s) =>
      (!q || s.name.toLowerCase().includes(q)) &&
      (sigFilter === "all" || (sigFilter === "hidden" ? s.hidden : s.items.some((l) => l.kind === "pending"))));
    const pending = sigs.reduce((n, s) => n + s.items.filter((l) => l.kind === "pending").length, 0);
    $("#sig-count").textContent = `${sigs.length}개${pending ? ` · 파일 대기 ${pending}개` : ""}`;
    $("#sig-admin-list").innerHTML = list.length
      ? list.map((s) => {
        const ready = s.items.filter((l) => l.kind !== "pending").length;
        const wait = s.items.length - ready;
        const open = openSigs.has(s.id);
        return `
        <article class="sig-admin ${s.hidden ? "is-hidden" : ""}" data-sig="${s.id}">
          <div class="sig-row">
            <input class="cell-input" name="category" value="${esc(s.category)}" list="sig-categories" maxlength="30" aria-label="분류">
            <input class="cell-input" name="name" value="${esc(s.name)}" maxlength="100" aria-label="시그 이름">
            <input class="cell-input" name="price" value="${s.price.toLocaleString()}" inputmode="numeric" aria-label="시그단가">
            <input class="cell-input" name="ref_url" value="${esc(s.ref_url.split(/\s+/).filter(Boolean).join(" "))}" placeholder="유튜브 레퍼런스 (여러 개는 띄어쓰기로)" aria-label="유튜브 레퍼런스" title="여러 개는 띄어쓰기로 구분">
            <label class="check"><input type="checkbox" name="hidden" ${s.hidden ? "checked" : ""}> 숨김</label>
            <div class="actions">
              <button type="button" class="mini-action ${wait ? "warn" : ""}" data-lessons aria-expanded="${open}">레슨 ${ready}${wait ? ` · 대기 ${wait}` : ""}${s.image ? " · 이미지" : ""}${s.audio ? " · 음원" : ""}</button>
              <button type="button" class="mini-action ok" data-save>저장</button>
              <button type="button" class="mini-action danger" data-delete>삭제</button>
            </div>
          </div>
          <div class="lesson-box" ${open ? "" : "hidden"}>
            <div class="asset-row">
              <div class="asset">
                <strong>시그 이미지</strong>
                ${s.image ? `<a href="/media/sigs/${esc(s.image)}" target="_blank" rel="noopener"><img class="asset-img" src="/media/sigs/${esc(s.image)}" alt=""></a>` : '<span class="asset-img empty-img">없음</span>'}
                <span class="asset-tools">
                  <label class="mini-action file-btn">${s.image ? "바꾸기" : "이미지 올리기"}<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" data-asset="image" hidden></label>
                  ${s.image ? '<button type="button" class="mini-action danger" data-asset-del="image">삭제</button>' : ""}
                </span>
              </div>
              <div class="asset">
                <strong>음원</strong>
                ${s.audio ? `<audio controls preload="none" src="/media/sigs/${esc(s.audio)}"></audio><span class="muted">${esc(s.audio_name)} · ${fmtSize(s.audio_size)}</span>` : '<span class="muted">없음</span>'}
                <span class="asset-tools">
                  <label class="mini-action file-btn">${s.audio ? "바꾸기" : "음원 올리기"}<input type="file" accept="audio/*,.mp3,.m4a,.wav,.ogg,.aac,.flac" data-asset="audio" hidden></label>
                  ${s.audio ? '<button type="button" class="mini-action danger" data-asset-del="audio">삭제</button>' : ""}
                </span>
              </div>
            </div>
            ${s.items.length ? `<ul class="lesson-list">${s.items.map(lessonHtml).join("")}</ul>` : '<p class="hint">등록된 레슨 영상이 없습니다.</p>'}
            <div class="lesson-add">
              <input class="cell-input" name="lesson_url" placeholder="유튜브 · 구글 드라이브 링크">
              <button type="button" class="mini-action ok" data-add-link>링크 추가</button>
              <span class="muted">또는</span>
              <label class="mini-action file-btn">영상 파일 올리기<input type="file" accept="video/*" data-upload-new hidden></label>
            </div>
            <div class="progress" hidden><span></span></div>
          </div>
        </article>`;
      }).join("")
      : `<div class="empty">${sigs.length ? "조건에 맞는 시그가 없습니다." : "등록된 시그가 없습니다. 엑셀을 올리거나 위에서 하나씩 추가하세요."}</div>`;
  }

  $("#sig-crew").addEventListener("change", () => { openSigs.clear(); loadSigs(); });
  $("#sig-search-admin").addEventListener("input", renderSigs);
  $$("[data-sig-filter]").forEach((b) => b.addEventListener("click", () => {
    sigFilter = b.dataset.sigFilter;
    $$("[data-sig-filter]").forEach((x) => x.classList.toggle("is-active", x === b));
    renderSigs();
  }));

  $("#sig-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("api/admin/sigs", { ...Object.fromEntries(new FormData(e.target)), crew: sigCrew() });
      e.target.reset();
      $("#sig-note").textContent = "시그를 추가했습니다.";
      await loadSigs();
    } catch (err) {
      $("#sig-note").textContent = err.message;
    }
  });

  $("#sig-admin-list").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const card = btn.closest("[data-sig]");
    const id = Number(card.dataset.sig);
    const note = $("#sig-note");
    if (btn.hasAttribute("data-lessons")) {
      openSigs.has(id) ? openSigs.delete(id) : openSigs.add(id);
      $(".lesson-box", card).hidden = !openSigs.has(id);
      btn.setAttribute("aria-expanded", String(openSigs.has(id)));
      return;
    }
    if (btn.hasAttribute("data-delete")) {
      if (!confirmClick(btn)) return;
      return act(btn, async () => { await api(`api/admin/sigs/${id}/delete`, {}); await loadSigs(); });
    }
    if (btn.dataset.assetDel) {
      if (!confirmClick(btn)) return;
      return act(btn, async () => { await api(`api/admin/sigs/${id}/asset/delete`, { kind: btn.dataset.assetDel }); note.textContent = "삭제했습니다."; await loadSigs(); });
    }
    if (btn.hasAttribute("data-save")) {
      const v = (n) => $(`[name="${n}"]`, card);
      return act(btn, async () => {
        await api("api/admin/sigs", { id, category: v("category").value, name: v("name").value, price: v("price").value, ref_url: v("ref_url").value, hidden: v("hidden").checked });
        note.textContent = "저장했습니다.";
        await loadSigs();
      });
    }
    if (btn.hasAttribute("data-add-link")) {
      const input = $('[name="lesson_url"]', card);
      return act(btn, async () => {
        await api(`api/admin/sigs/${id}/lessons`, { url: input.value });
        note.textContent = "레슨 영상을 추가했습니다.";
        await loadSigs();
      });
    }
    if (btn.dataset.lessonDel) {
      if (!confirmClick(btn)) return;
      return act(btn, async () => { await api(`api/admin/lessons/${btn.dataset.lessonDel}/delete`, {}); await loadSigs(); });
    }
  });

  // 영상 파일 고르면 바로 업로드 (파일 대기 칸 채우기 / 새로 추가)
  $("#sig-admin-list").addEventListener("change", async (e) => {
    const input = e.target.closest("input[type=file]");
    if (!input?.files[0]) return;
    const card = input.closest("[data-sig]");
    const file = input.files[0];
    const note = $("#sig-note");
    const q = input.dataset.fill ? `?lesson=${input.dataset.fill}` : "";
    const target = input.dataset.asset
      ? `api/admin/sigs/${card.dataset.sig}/asset?kind=${input.dataset.asset}`
      : `api/admin/sigs/${card.dataset.sig}/lessons/upload${q}`;
    $$("input[type=file]", card).forEach((i) => (i.disabled = true));
    note.textContent = `${file.name} 올리는 중… (${fmtSize(file.size)})`;
    try {
      await upload(target, file, $(".progress", card));
      note.textContent = `${file.name} 올리기 완료`;
      await loadSigs();
    } catch (err) {
      note.textContent = err.message;
      $$("input[type=file]", card).forEach((i) => (i.disabled = false));
    }
  });

  /* 엑셀 */
  const HEADERS = ["제외", "분류", "시그 이름", "시그단가", "유튜브 레퍼런스", "레슨 영상"];

  $("#excel-template").addEventListener("click", () => {
    const ws = XLSX.utils.aoa_to_sheet([
      HEADERS,
      ["", "엑셀시그", "예시 시그 (이 줄은 지우세요)", 10000, "https://youtube.com/shorts/…", "예시.mp4"],
    ]);
    ws["!cols"] = [{ wch: 6 }, { wch: 12 }, { wch: 24 }, { wch: 12 }, { wch: 48 }, { wch: 40 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "시그");
    XLSX.writeFile(wb, "시그_업로드_양식.xlsx");
  });

  // 제목 줄(시그 이름 …)을 찾아서 칸 위치를 맞춤 → 칸 순서가 달라도 됨
  /* 구글 시트 자동 반영 */
  let sheets = [];
  const sheetSummary = (r) => {
    if (!r) return "";
    if (!r.ok) return `<b class="err">반영 실패</b> · ${esc(r.error)}`;
    const parts = [`추가 ${r.added}`, `수정 ${r.updated}`, r.removed ? `삭제 ${r.removed}` : "", r.hidden ? `숨김 ${r.hidden}` : "",
      r.lessons ? `레슨 링크 ${r.lessons}` : "", r.pending ? `파일 대기 ${r.pending}` : ""].filter(Boolean).join(" · ");
    return `<b class="ok">반영됨</b> · ${parts}${r.changed_at ? ` (${fmtAgo(r.changed_at)} 바뀐 내용 반영)` : ""}`
      + (r.guarded ? ` · <b class="err">시트에서 절반 넘게 사라져서 삭제는 하지 않았어요. 시트를 확인하세요.</b>` : "");
  };
  function renderSheet() {
    const c = sheets.find((x) => x.id === sigCrew());
    const form = $("#sheet-form");
    form.elements.url.value = c?.sheet_url || "";
    form.elements.prune.checked = c ? !!c.sheet_prune : true;
    $("#sheet-sync").disabled = !c?.sheet_url;
    $("#sheet-status").innerHTML = !c?.sheet_url
      ? "자동 반영 꺼짐 (시트 주소가 없습니다)"
      : `마지막 확인 ${c.sheet_synced_at ? fmtAgo(c.sheet_synced_at) : "-"} · ${sheetSummary(c.sheet_result)}`;
  }
  async function loadSheets() {
    try { sheets = await api("api/admin/sheets"); } catch { sheets = []; }
    renderSheet();
  }
  $("#sheet-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target.elements;
    act($('[type="submit"]', e.target), async () => {
      $("#sheet-status").textContent = f.url.value ? "시트 받아서 반영하는 중…" : "저장 중…";
      try {
        await api(`api/admin/sheets/${encodeURIComponent(sigCrew())}`, { url: f.url.value, prune: f.prune.checked });
        await Promise.all([loadSheets(), loadSigs()]);
      } catch (err) { $("#sheet-status").textContent = err.message; }
    });
  });
  $("#sheet-sync").addEventListener("click", (e) => act(e.currentTarget, async () => {
    $("#sheet-status").textContent = "시트 받아서 반영하는 중…";
    try {
      await api(`api/admin/sheets/${encodeURIComponent(sigCrew())}/sync`, {});
      await Promise.all([loadSheets(), loadSigs()]);
    } catch (err) { $("#sheet-status").textContent = err.message; }
  }));
  $("#sig-crew").addEventListener("change", renderSheet);

  // 서버(lib/sheet.js extractRows)와 같은 규칙: 시그 표 + 신호탄 표(맴버 · 금액 · 링크)
  async function readExcel(file) {
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws?.["!ref"]) return [];
    const range = XLSX.utils.decode_range(ws["!ref"]);
    const raw = (r, c) => (c === undefined ? undefined : ws[XLSX.utils.encode_cell({ r, c })]);
    const cell = (r, c) => { const x = raw(r, c); return x && { v: x.w ?? x.v ?? "", n: x.v, link: x.l?.Target }; };
    const text = (r, c) => String(cell(r, c)?.v ?? "").trim();
    const MATCH = { exclude: /제외/, category: /분류/, name: /이름/, price: /단가|가격/, ref: /레퍼런스|유튜브/, lessons: /레슨/ };
    const SIGNAL = { name: /^(맴버|멤버)(이름)?$/, price: /금액|단가|가격/, ref: /링크|신호탄|음원/ };
    const rows = [];
    let mainName;
    for (let head = range.s.r; head <= Math.min(range.e.r, range.s.r + 20); head++) {
      const cols = {};
      for (let c = range.s.c; c <= range.e.c; c++) {
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
      const url = (r, c) => { const t = text(r, c); return /^https?:\/\//i.test(t) ? t : cell(r, c)?.link || ""; };
      for (let r = head + 1; r <= range.e.r; r++) {
        const name = text(r, cols.name);
        if (!name) continue;
        rows.push({
          exclude: text(r, cols.exclude),
          category: text(r, cols.category),
          name,
          price: cell(r, cols.price)?.n ?? "",
          ref: (cols.refs || []).map((c) => url(r, c)).filter(Boolean).join("\n"),
          lessons: text(r, cols.lessons),
          lessonLink: cell(r, cols.lessons)?.link || "",
        });
      }
      break;
    }
    for (let head = range.s.r; head <= Math.min(range.e.r, range.s.r + 20); head++) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        if (c === mainName || !SIGNAL.name.test(text(head, c).replace(/\s/g, ""))) continue;
        const right = (re) => { for (let x = c + 1; x <= Math.min(range.e.c, c + 4); x++) if (re.test(text(head, x).replace(/\s/g, ""))) return x; };
        const pc = right(SIGNAL.price), lc = right(SIGNAL.ref);
        if (pc === undefined) continue;
        const category = (head > range.s.r && text(head - 1, c)) || "신호탄";
        for (let r = head + 1; r <= range.e.r; r++) {
          const name = text(r, c);
          if (!name) break;
          const t = lc === undefined ? "" : text(r, lc);
          rows.push({ exclude: "", category, name, price: cell(r, pc)?.n ?? "",
            ref: (/^https?:\/\//i.test(t) ? t : "") || (lc === undefined ? "" : cell(r, lc)?.link || ""), lessons: "", lessonLink: "" });
        }
        return rows;
      }
    }
    return rows;
  }


  $("#excel-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const note = $("#excel-note");
    const btn = $('[type="submit"]', form);
    const prune = form.elements.prune.checked;
    if (prune && !btn.dataset.armed) {
      btn.dataset.armed = "1";
      note.textContent = "엑셀에 없는 시그와 그 레슨 영상이 삭제됩니다. 계속하려면 업로드를 한 번 더 누르세요.";
      setTimeout(() => delete btn.dataset.armed, 5000);
      return;
    }
    btn.disabled = true;
    note.textContent = "엑셀 읽는 중…";
    try {
      const rows = await readExcel(form.elements.file.files[0]);
      const r = await api("api/admin/sigs/import", { crew: sigCrew(), rows, prune });
      note.textContent = `완료: 추가 ${r.added} · 수정 ${r.updated} · 숨김 ${r.hidden}${r.removed ? ` · 삭제 ${r.removed}` : ""} · 레슨 링크 ${r.lessons} · 파일 대기 ${r.pending}${r.skipped ? ` · 건너뜀 ${r.skipped} (분류·단가 없는 줄)` : ""}`;
      form.reset();
      await loadSigs();
    } catch (err) {
      note.textContent = err.message;
    } finally {
      btn.disabled = false;
      delete btn.dataset.armed;
    }
  });

  /* ---------- 파일 ---------- */
  async function loadFiles() {
    const crew = $("#file-crew").value;
    const { items } = crew ? await api(`api/files?crew=${encodeURIComponent(crew)}`) : { items: [] };
    $("#file-list").innerHTML = items.length
      ? items.map((f) => `
        <tr data-file="${f.id}">
          <td><strong>${esc(f.title)}</strong></td>
          <td class="muted">${esc(f.orig_name)}</td>
          <td class="num">${fmtSize(f.size)}</td>
          <td>${fmtDate(f.created_at)}</td>
          <td class="right actions"><button type="button" class="mini-action danger" data-delete>삭제</button></td>
        </tr>`).join("")
      : `<tr><td colspan="5"><div class="empty">올린 파일이 없습니다.</div></td></tr>`;
  }

  $("#file-crew").addEventListener("change", loadFiles);

  $("#file-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const file = form.elements.file.files[0];
    const btn = $('[type="submit"]', form);
    const note = $("#file-note");
    btn.disabled = true;
    note.textContent = `${file.name} 올리는 중… (${fmtSize(file.size)})`;
    try {
      const q = new URLSearchParams({ crew: $("#file-crew").value, title: form.elements.title.value });
      await upload(`api/admin/files/upload?${q}`, file, $("#file-progress"));
      note.textContent = "올리기 완료";
      form.reset();
      await loadFiles();
    } catch (err) {
      note.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  $("#file-list").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-delete]");
    if (!btn || !confirmClick(btn)) return;
    act(btn, async () => { await api(`api/admin/files/${btn.closest("[data-file]").dataset.file}/delete`, {}); await loadFiles(); });
  });

  /* ---------- 백업 · 복원 ---------- */
  $("#restore-btn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const file = $("#restore-file").files[0];
    const note = $("#restore-note");
    if (!file) return (note.textContent = "백업 파일을 고르세요.");
    if (!btn.dataset.armed) {
      btn.dataset.armed = "1";
      note.textContent = "지금 데이터가 백업 내용으로 바뀝니다. 계속하려면 복원을 한 번 더 누르세요.";
      setTimeout(() => delete btn.dataset.armed, 5000);
      return;
    }
    delete btn.dataset.armed;
    btn.disabled = true;
    note.textContent = "복원 중…";
    try {
      const r = await upload("api/admin/restore", file);
      const c = r.counts;
      note.textContent = `복원 완료: 회원 ${c.users} · 크루 ${c.crews} · 채널 ${c.channels} · 시그 ${c.sigs} · 레슨 ${c.lessons}. 백업에 있던 관리자 계정으로 다시 로그인하세요.`;
      setTimeout(() => location.reload(), 4000);
    } catch (err) {
      note.textContent = err.message;
      btn.disabled = false;
    }
  });

  /* ---------- 멤버 · 방송 채널 ---------- */
  let members = [];
  let memberCrew = "";
  const ytUrl = (c) => `https://www.youtube.com/${c.handle || `channel/${c.id}`}`;
  const soopUrl = (id) => `https://www.sooplive.co.kr/station/${encodeURIComponent(id)}`;
  const crewLabelOf = (id) => crews.find((c) => c.id === id)?.name || "";

  async function loadChannels() {
    members = await api("api/admin/members");
    const f = $("#member-crew-filter");
    f.innerHTML = `<option value="">전체</option><option value="-">(크루 없음)</option>` + crews.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("");
    f.value = memberCrew;
    renderMembers();
    loadBroadcasts();
    if ($("#modal-member").open && editing?.id) fillEditor(members.find((m) => m.id === editing.id));
  }

  function renderMembers() {
    const list = members.filter((m) => !memberCrew || (memberCrew === "-" ? !m.crew_id : m.crew_id === memberCrew));
    $("#member-list").innerHTML = list.length
      ? list.map((m, i) => {
          const links = [
            ...m.youtubes.map((c) => `<a class="pill-link yt" href="${esc(ytUrl(c))}" target="_blank" rel="noopener">${c.is_live ? "● " : ""}YouTube · ${esc(c.handle || c.title)}</a>`),
            ...m.soops.map((c) => `<a class="pill-link soop" href="${esc(soopUrl(c.id))}" target="_blank" rel="noopener">${c.live ? "● " : ""}SOOP · ${esc(c.nick || c.id)}</a>`),
            m.instagram ? `<a class="pill-link ig" href="${esc(m.instagram)}" target="_blank" rel="noopener">Instagram</a>` : "",
          ].join("");
          const filled = [m.profile_text && "프로필", (m.promise_text || m.promise_image) && "공약", m.sig_ids.length && `시그 ${m.sig_ids.length}`].filter(Boolean);
          return `
          <article class="member-admin" data-member="${m.id}">
            <div class="order-cell">
              <button type="button" class="mini-action" data-move="-1" aria-label="위로" ${i === 0 || memberCrew ? "disabled" : ""}>▲</button>
              <button type="button" class="mini-action" data-move="1" aria-label="아래로" ${i === list.length - 1 || memberCrew ? "disabled" : ""}>▼</button>
            </div>
            ${m.thumb ? `<img class="channel-thumb" src="${esc(m.thumb)}" alt="">` : '<div class="channel-thumb"></div>'}
            <div class="channel-info">
              <strong>${esc(m.name)} ${m.role_title ? `<span class="tag">${esc(m.role_title)}</span>` : ""} ${m.is_live ? '<span class="badge-live" style="position:static">LIVE</span>' : ""}</strong>
              <span>${esc(crewLabelOf(m.crew_id) || "크루 없음")}${m.quote ? ` · ${esc(m.quote)}` : ""}</span>
              <span class="pill-links">${links || '<span class="muted">연결된 채널 없음</span>'}</span>
              <span class="muted">${filled.length ? `입력됨: ${filled.join(" · ")}` : "프로필 · 공약 · 시그 미입력"}</span>
            </div>
            <div class="actions">
              <button type="button" class="mini-action ok" data-edit>편집</button>
              <button type="button" class="mini-action danger" data-delete>삭제</button>
            </div>
          </article>`;
        }).join("")
      : '<div class="empty">등록된 멤버가 없습니다. [+ 멤버 추가]를 눌러 시작하세요.</div>';
  }

  $("#member-crew-filter").addEventListener("change", (e) => { memberCrew = e.target.value; renderMembers(); });
  $("#member-add").addEventListener("click", () => openEditor(null));

  $("#member-list").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const id = Number(btn.closest("[data-member]").dataset.member);
    if (btn.hasAttribute("data-edit")) return openEditor(members.find((m) => m.id === id));
    if (btn.hasAttribute("data-delete")) {
      if (!confirmClick(btn)) return;
      return act(btn, async () => { await api(`api/admin/members/${id}/delete`, {}); await loadChannels(); });
    }
    if (btn.dataset.move) return act(btn, async () => { await api(`api/admin/members/${id}/move`, { dir: Number(btn.dataset.move) }); await loadChannels(); });
  });

  $("#sync-btn").addEventListener("click", (e) => act(e.currentTarget, async () => {
    $("#channel-note").textContent = "새로고침 중…";
    await api("api/admin/sync", {});
    $("#channel-note").textContent = "새로고침 완료";
    await loadChannels();
  }));

  /* 멤버 편집 창 */
  const form = $("#member-form");
  const note = $("#member-note");
  let editing = null;        // 편집 중인 멤버 (새 멤버면 { id: null })
  let picked = [];           // 고른 대표 시그 id
  let crewSigs = [];         // 멤버 크루의 시그 목록
  const pending = { photo: null, promise: null }; // 저장할 때 올릴 이미지

  const imgPreview = (url, cls) => (url ? `<img src="${esc(url)}" alt="" class="${cls}">` : `<span class="${cls} empty-img">없음</span>`);

  async function loadCrewSigs() {
    const crew = form.elements.crew.value;
    try { crewSigs = await api(`api/sigs${crew ? `?crew=${encodeURIComponent(crew)}` : ""}`); } catch { crewSigs = []; }
    renderSigPicker();
  }

  function renderSigPicker() {
    const byId = new Map(crewSigs.map((sg) => [sg.id, sg]));
    $("#ed-sig-count").textContent = picked.length ? `${picked.length}개` : "";
    $("#ed-sig-picked").innerHTML = picked.length
      ? picked.map((id, i) => {
          const sg = byId.get(id);
          return `<span class="sig-chip" data-pick="${id}">${i + 1}. ${esc(sg ? sg.name : `(다른 크루/삭제된 시그 #${id})`)}${sg ? ` <small>${sg.price.toLocaleString()}</small>` : ""}
            <button type="button" data-unpick="${id}" aria-label="빼기">×</button></span>`;
        }).join("")
      : '<span class="muted">아직 고른 시그가 없습니다.</span>';
    const q = $("#ed-sig-search").value.trim().toLowerCase().replace(/,/g, "");
    const opts = crewSigs.filter((sg) => !picked.includes(sg.id) && (!q || sg.name.toLowerCase().includes(q) || String(sg.price).includes(q))).slice(0, 60);
    $("#ed-sig-options").innerHTML = opts.length
      ? opts.map((sg) => `<button type="button" class="sig-opt" data-pick-add="${sg.id}">+ ${esc(sg.name)} <small>${sg.price.toLocaleString()}</small></button>`).join("")
      : `<span class="muted">${!crewSigs.length ? "이 크루에 등록된 시그가 없습니다." : q ? "검색 결과가 없습니다." : "모든 시그를 골랐습니다."}</span>`;
  }

  $("#ed-sig-search").addEventListener("input", renderSigPicker);
  form.elements.crew.addEventListener("change", loadCrewSigs);
  form.addEventListener("click", (e) => {
    const add = e.target.closest("[data-pick-add]");
    if (add) { picked.push(Number(add.dataset.pickAdd)); return renderSigPicker(); }
    const rm = e.target.closest("[data-unpick]");
    if (rm) { picked = picked.filter((id) => id !== Number(rm.dataset.unpick)); return renderSigPicker(); }
  });

  function renderChannels(m) {
    const ready = !!m?.id;
    $("#ed-youtube-list").innerHTML = (m?.youtubes || []).map((c) => `
      <li><a href="${esc(ytUrl(c))}" target="_blank" rel="noopener">${c.is_live ? '<span class="badge-live" style="position:static">LIVE</span> ' : ""}${esc(c.title)}</a>
        <span class="muted">${esc(c.handle || c.id)} · 게시글 ${c.posts} · Shorts ${c.shorts}</span>
        <button type="button" class="mini-action danger" data-unlink-yt="${esc(c.id)}">연결 해제</button></li>`).join("");
    $("#ed-soop-list").innerHTML = (m?.soops || []).map((c) => `
      <li><a href="${esc(soopUrl(c.id))}" target="_blank" rel="noopener">${c.live ? '<span class="badge-live soop" style="position:static">LIVE</span> ' : ""}${esc(c.nick || c.id)}</a>
        <span class="muted">${esc(c.id)}</span>
        <button type="button" class="mini-action danger" data-unlink-soop="${esc(c.id)}">연결 해제</button></li>`).join("");
    if (!ready) $("#ed-youtube-list").innerHTML = $("#ed-soop-list").innerHTML = "";
  }

  function fillEditor(m) {
    if (!m) return;
    editing = m;
    renderChannels(m);
    $("#ed-photo").innerHTML = imgPreview(pending.photo ? URL.createObjectURL(pending.photo) : m.photo_url || m.thumb, "ed-photo-img");
    $("#ed-promise").innerHTML = imgPreview(pending.promise ? URL.createObjectURL(pending.promise) : m.promise_url, "ed-promise-img");
    $("#ed-photo-del").hidden = !m.photo_url;
    $("#ed-promise-del").hidden = !m.promise_url;
  }

  function openEditor(m) {
    form.reset();
    note.textContent = "";
    pending.photo = pending.promise = null;
    editing = m || { id: null, youtubes: [], soops: [] };
    $("#member-editor-title").textContent = m ? `멤버 편집 · ${m.name}` : "멤버 추가";
    form.elements.crew.innerHTML = crewOptions(m ? m.crew_id : memberCrew && memberCrew !== "-" ? memberCrew : "");
    const f = form.elements;
    f.id.value = m?.id || "";
    for (const k of ["name", "role_title", "quote", "instagram", "kakao", "profile_text", "promise_text"]) f[k].value = m?.[k] || "";
    picked = [...(m?.sig_ids || [])];
    $("#ed-sig-search").value = "";
    fillEditor(editing);
    if (!m) { $("#ed-photo").innerHTML = imgPreview(null, "ed-photo-img"); $("#ed-promise").innerHTML = imgPreview(null, "ed-promise-img"); }
    loadCrewSigs();
    $("#modal-member").showModal();
  }

  form.elements.photo.addEventListener("change", (e) => {
    pending.photo = e.target.files[0] || null;
    if (pending.photo) $("#ed-photo").innerHTML = imgPreview(URL.createObjectURL(pending.photo), "ed-photo-img");
  });
  form.elements.promise.addEventListener("change", (e) => {
    pending.promise = e.target.files[0] || null;
    if (pending.promise) $("#ed-promise").innerHTML = imgPreview(URL.createObjectURL(pending.promise), "ed-promise-img");
  });

  // 이미지 삭제 · 채널 연결 해제 (바로 반영)
  form.addEventListener("click", (e) => {
    const btn = e.target.closest("#ed-photo-del, #ed-promise-del, [data-unlink-yt], [data-unlink-soop]");
    if (!btn || !editing?.id) return;
    if (!confirmClick(btn)) return;
    act(btn, async () => {
      if (btn.id) await api(`api/admin/members/${editing.id}/image/delete`, { kind: btn.id === "ed-promise-del" ? "promise" : "photo" });
      else if (btn.dataset.unlinkYt) await api(`api/admin/channels/${encodeURIComponent(btn.dataset.unlinkYt)}/delete`, {});
      else await api(`api/admin/soop/${encodeURIComponent(btn.dataset.unlinkSoop)}/delete`, {});
      note.textContent = "반영했습니다.";
      await loadChannels();
    });
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $('[type="submit"]', form);
    const f = form.elements;
    btn.disabled = true;
    const done = [];
    try {
      note.textContent = "저장 중…";
      const body = { id: f.id.value || undefined, sig_ids: picked };
      for (const k of ["name", "crew", "role_title", "quote", "instagram", "kakao", "profile_text", "promise_text"]) body[k] = f[k].value;
      const { id } = await api("api/admin/members", body);
      f.id.value = id;
      editing = { ...editing, id };
      done.push("기본 정보");
      for (const kind of ["photo", "promise"]) {
        if (!pending[kind]) continue;
        note.textContent = `${kind === "photo" ? "프로필 사진" : "공약 이미지"} 올리는 중…`;
        await upload(`api/admin/members/${id}/image?kind=${kind}`, pending[kind]);
        pending[kind] = null;
        f[kind].value = "";
        done.push(kind === "photo" ? "프로필 사진" : "공약 이미지");
      }
      if (f.youtube_new.value.trim()) {
        note.textContent = "유튜브 채널 확인하고 영상 가져오는 중… (최대 1분)";
        const r = await api(`api/admin/members/${id}/youtube`, { channel: f.youtube_new.value });
        f.youtube_new.value = "";
        done.push(r.message);
      }
      if (f.soop_new.value.trim()) {
        note.textContent = "SOOP 방송국 확인 중…";
        const r = await api(`api/admin/members/${id}/soop`, { soop: f.soop_new.value });
        f.soop_new.value = "";
        done.push(r.message);
      }
      note.textContent = `저장했습니다: ${done.join(" · ")}`;
      $("#member-editor-title").textContent = `멤버 편집 · ${f.name.value}`;
    } catch (err) {
      note.textContent = `${done.length ? `${done.join(" · ")} 저장됨. ` : ""}${err.message}`;
    } finally {
      btn.disabled = false;
      await loadChannels().catch(() => {});
    }
  });

  /* ---------- 방송 기록 (월별 방송 시간) ---------- */
  let bc = null;
  const monthLabel = (k) => `${Number(k.slice(0, 4))}년 ${Number(k.slice(5))}월`;
  const fmtHours = (sec = 0) => {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    return h ? `${h}시간 ${m}분` : `${m}분`;
  };
  const fmtDT = (ms) => {
    const d = new Date(ms), p = (n) => String(n).padStart(2, "0");
    return `${d.getMonth() + 1}.${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const crewLabel = crewLabelOf;

  async function loadBroadcasts(month) {
    const sel = $("#bc-month");
    month = month || sel.value || "";
    try {
      bc = await api(`api/ranking?month=${month || ""}`);
    } catch (err) {
      $("#bc-note").textContent = err.message;
      return;
    }
    sel.innerHTML = bc.months.map((k) => `<option value="${k}">${monthLabel(k)}</option>`).join("");
    sel.value = bc.month;
    const total = bc.items.reduce((a, it) => a + it.seconds, 0);
    $("#bc-note").textContent = `${monthLabel(bc.month)} · 방송한 멤버 ${bc.items.filter((it) => it.seconds).length}/${bc.items.length}명 · 합계 ${fmtHours(total)}`;
    $("#bc-list").innerHTML = bc.items.length
      ? bc.items.map((it) => `
        <tr class="bc-row" data-bc-member="${esc(it.id)}">
          <td class="center"><strong>${it.rank ?? "-"}</strong></td>
          <td><strong>${esc(it.name)}</strong></td>
          <td>${esc(crewLabel(it.crew))}</td>
          <td>${it.youtube ? '<span class="badge-platform">YouTube</span> ' : ""}${it.soop ? '<span class="badge-platform soop">SOOP</span>' : ""}</td>
          <td class="num"><strong>${fmtHours(it.seconds)}</strong></td>
          <td class="num">${it.days}일</td>
          <td class="num">${it.sessions}회</td>
          <td>${it.is_live ? '<span class="badge-live" style="position:static">방송 중</span>' : '<span class="muted">-</span>'}</td>
        </tr>`).join("")
      : '<tr><td colspan="8"><div class="empty">등록된 멤버가 없습니다. 방송 채널 탭에서 유튜브 채널이나 SOOP 방송국을 추가하세요.</div></td></tr>';
  }

  $("#bc-month").addEventListener("change", (e) => loadBroadcasts(e.target.value));

  $("#bc-list").addEventListener("click", async (e) => {
    const row = e.target.closest("[data-bc-member]");
    if (!row) return;
    if (row.nextElementSibling?.classList.contains("bc-sessions")) return row.nextElementSibling.remove();
    const tr = document.createElement("tr");
    tr.className = "bc-sessions";
    tr.innerHTML = '<td colspan="8">불러오는 중…</td>';
    row.after(tr);
    try {
      const { items } = await api(`api/ranking/sessions?member=${encodeURIComponent(row.dataset.bcMember)}&month=${bc.month}`);
      tr.firstElementChild.innerHTML = items.length
        ? `<ul>${items.map((b) => `<li>
            <span class="badge-platform ${b.platform}">${b.platform === "soop" ? "SOOP" : "YouTube"}</span>
            <span class="t">${esc(b.title || "(제목 없음)")}</span>
            <span class="muted">${fmtDT(b.started_at)} ~ ${b.ended_at ? fmtDT(b.ended_at) : "방송 중"}</span>
            <strong>${fmtHours(b.seconds)}</strong></li>`).join("")}</ul>`
        : "이 달에는 방송 기록이 없습니다.";
    } catch (err) {
      tr.firstElementChild.textContent = err.message;
    }
  });

  // 엑셀에서 바로 열리는 CSV (한글 깨짐 방지 BOM)
  $("#bc-csv").addEventListener("click", () => {
    if (!bc) return;
    const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [["순위", "멤버", "크루", "유튜브", "SOOP", "방송 시간(시간)", "방송 시간", "방송일", "방송 횟수"]]
      .concat(bc.items.map((it) => [it.rank ?? "", it.name, crewLabel(it.crew), it.youtube || "", it.soop || "",
        (it.seconds / 3600).toFixed(2), fmtHours(it.seconds), it.days, it.sessions]));
    const blob = new Blob(["\ufeff" + rows.map((r) => r.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `방송시간_${bc.month}.csv` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  // 전체 방송자 · 전체 달을 엑셀 파일 하나로
  //   시트 1 "월별 정리": 멤버 × 달 (방송 시간, 시간 단위 숫자) + 합계
  //   시트 2~ "YYYY-MM": 그 달 순위 · 방송 시간 · 방송일 · 횟수 · 최고/평균 시청자
  $("#bc-xlsx").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (!window.XLSX) return ($("#bc-note").textContent = "엑셀 도구를 불러오지 못했습니다. 새로고침 후 다시 시도하세요.");
    btn.disabled = true;
    const note = $("#bc-note");
    try {
      const months = (bc?.months || (await api("api/ranking?month=")).months).slice().reverse(); // 오래된 달 → 최근 달
      const data = [];
      for (const [i, m] of months.entries()) {
        note.textContent = `엑셀 만드는 중… (${i + 1}/${months.length})`;
        data.push(await api(`api/ranking?month=${m}`));
      }
      const hours = (sec) => Math.round((sec / 3600) * 100) / 100;
      const people = new Map();
      for (const d of data) for (const it of d.items) if (!people.has(it.id)) people.set(it.id, it);
      const summary = [["멤버", "크루", "유튜브", "SOOP", ...months.map((m) => `${monthLabel(m)} (시간)`), "합계 (시간)"]];
      for (const p of people.values()) {
        const per = data.map((d) => d.items.find((x) => x.id === p.id)?.seconds || 0);
        summary.push([p.name, crewLabel(p.crew), p.youtube || "", p.soop || "", ...per.map(hours), hours(per.reduce((a, b) => a + b, 0))]);
      }
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet(summary);
      ws["!cols"] = [{ wch: 14 }, { wch: 12 }, { wch: 26 }, { wch: 14 }, ...months.map(() => ({ wch: 16 })), { wch: 12 }];
      XLSX.utils.book_append_sheet(wb, ws, "월별 정리");
      for (const [i, d] of data.entries()) {
        const rows = [["순위", "멤버", "크루", "유튜브", "SOOP", "방송 시간 (시간)", "방송 시간", "방송일", "방송 횟수", "최고 시청자", "평균 시청자", "받은 별풍선", "후원자 수"]]
          .concat(d.items.map((it) => [it.rank ?? "", it.name, crewLabel(it.crew), it.youtube || "", it.soop || "",
            hours(it.seconds), fmtHours(it.seconds), it.days, it.sessions, it.peak || "", it.avg || "", it.donation || 0, it.donors || 0]));
        const sh = XLSX.utils.aoa_to_sheet(rows);
        sh["!cols"] = [{ wch: 6 }, { wch: 14 }, { wch: 12 }, { wch: 26 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 8 }, { wch: 9 }, { wch: 11 }, { wch: 11 }, { wch: 11 }, { wch: 9 }];
        XLSX.utils.book_append_sheet(wb, sh, months[i]);
      }
      XLSX.writeFile(wb, `방송시간_월별_${months[0]}~${months.at(-1)}.xlsx`);
      note.textContent = `엑셀을 받았어요: ${months.length}개월 · 방송자 ${people.size}명`;
    } catch (err) {
      note.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

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
          : `<p><b>시그</b> ${esc(d.song)}${d.artist ? ` — ${esc(d.artist)}` : ""}</p>
             ${d.url ? `<p><a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">${esc(d.url)}</a></p>` : ""}
             ${d.memo ? `<p class="pre">${esc(d.memo)}</p>` : ""}`;
        return `
          <article class="request-card ${r.is_read ? "is-read" : ""}" data-request="${r.id}">
            <header>
              <span class="tag">${r.type === "backwall" ? "백월 요청" : "시그 요청"}</span>
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

  /* ---------- 정산 ---------- */
  // 금액 단위: 원. 계산은 서버와 같은 방식 (수수료 → 세금 → 회사와 나누기, 또는 나눈 뒤 세금)
  const ST_SRC = [["soop", "SOOP"], ["yt_account", "유튜브 계좌후원"], ["yt_web", "유튜브 웹후원"]];
  const TERM_FIELDS = [
    ["fee_soop", "SOOP 수수료 %"], ["fee_yt_account", "유튜브 계좌후원 수수료 %"], ["fee_yt_web", "유튜브 웹후원 수수료 %"],
    ["tax", "세금 %"], ["share_excel", "엑셀 멤버 몫 %"], ["share_personal", "개인방송 멤버 몫 %"],
  ];
  const ST_HINT = {
    excel: "엑셀 방송은 시즌 · 회차마다 멤버별 후원금을 넣습니다. 회차 날짜의 달로 월별 정산에 들어가요. 멤버가 많으면 [양식 받기] → 금액 채우기 → [시트 업로드] 하면 한 번에 들어갑니다.",
    personal: "개인 방송은 달마다 멤버별 후원금을 넣습니다. 금액을 모두 0으로 두면 그 칸은 지워집니다.",
    month: "그 달의 엑셀 + 개인방송을 멤버별로 합친 금액입니다. 돈을 보낸 뒤 [지급 완료]를 누르면 그때의 계약 조건으로 금액이 고정되고, 멤버 화면에 지급 완료로 보입니다.",
    terms: "계약 조건은 멤버마다 다르게 정할 수 있습니다. 따로 정하지 않은 멤버는 기본 조건을 씁니다. 바꾼 조건은 아직 지급 완료하지 않은 정산에 바로 적용됩니다.",
  };
  const wonFmt = (n) => Number(n || 0).toLocaleString();
  const thisMonth = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 7);
  const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const toNum = (v) => Math.max(0, Math.round(Number(String(v ?? "").replace(/[^\d.-]/g, "")) || 0));

  function calcSettle(e, t) {
    const by = {};
    let gross = 0, fee = 0;
    for (const [s] of ST_SRC) {
      const g = Number(e[s]) || 0, f = Math.round((g * t[`fee_${s}`]) / 100);
      by[s] = { gross: g, fee: f, net: g - f };
      gross += g; fee += f;
    }
    const afterFee = gross - fee, share = e.kind === "excel" ? t.share_excel : t.share_personal;
    let tax, member, company;
    if (t.tax_mode === "after") {
      const mg = Math.round((afterFee * share) / 100);
      company = afterFee - mg; tax = Math.round((mg * t.tax) / 100); member = mg - tax;
    } else {
      tax = Math.round((afterFee * t.tax) / 100);
      const net = afterFee - tax;
      member = Math.round((net * share) / 100); company = net - member;
    }
    return { by, gross, fee, after_fee: afterFee, tax, company, member };
  }

  let st = { mode: "excel", round: null, month: thisMonth(), sumMonth: thisMonth(), data: null };
  const stNote = (msg) => ($("#st-note").textContent = msg || "");

  async function loadSettle() {
    st.data = await api("api/admin/settle");
    if (!st.data.rounds.some((r) => r.id === st.round)) st.round = st.data.rounds[0]?.id ?? null;
    renderSettle();
  }

  $("#st-mode").addEventListener("click", (e) => {
    const b = e.target.closest("[data-mode]");
    if (!b) return;
    st.mode = b.dataset.mode;
    $$("#st-mode .chip").forEach((c) => c.classList.toggle("is-active", c === b));
    stNote("");
    renderSettle();
  });
  $('.admin-tabs [data-panel="settle"]').addEventListener("click", () => loadSettle().catch((err) => stNote(err.message)));

  function renderSettle() {
    $("#st-hint").textContent = ST_HINT[st.mode];
    const body = $("#st-body");
    if (!st.data) { body.innerHTML = '<div class="empty">불러오는 중…</div>'; return; }
    if (st.mode === "terms") return renderTerms(body);
    if (st.mode === "month") return renderMonthSum(body);
    return renderEntries(body);
  }

  /* 엑셀 회차 · 개인방송 달 금액 입력 */
  const roundLabel = (r) => `${r.season}시즌 ${r.round}회차${r.title ? ` · ${r.title}` : ""} (${r.held_on})`;

  async function renderEntries(body) {
    const excel = st.mode === "excel";
    const rounds = st.data.rounds;
    const cur = rounds.find((r) => r.id === st.round);
    const next = rounds[0] ? { season: rounds[0].season, round: rounds[0].round + 1 } : { season: 1, round: 1 };
    body.innerHTML = `
      ${excel ? `
        <div class="inline-form st-target">
          <label class="field grow">회차<select id="st-round">${rounds.length ? rounds.map((r) => `<option value="${r.id}" ${r.id === st.round ? "selected" : ""}>${esc(roundLabel(r))}</option>`).join("") : '<option value="">먼저 회차를 만드세요</option>'}</select></label>
          <button type="button" class="ghost-btn" id="st-round-new">+ 회차 추가</button>
          ${cur ? '<button type="button" class="ghost-btn" id="st-round-edit">회차 수정</button><button type="button" class="mini-action danger" id="st-round-del">회차 삭제</button>' : ""}
        </div>
        <form class="inline-form box st-round-form" id="st-round-form" hidden>
          <input type="hidden" name="id">
          <label class="field">시즌<input name="season" type="number" min="1" required value="${next.season}"></label>
          <label class="field">회차<input name="round" type="number" min="1" required value="${next.round}"></label>
          <label class="field">방송 날짜<input name="held_on" type="date" required value="${today()}"></label>
          <label class="field grow">이름 (선택)<input name="title" maxlength="60" placeholder="예: 할로윈 특집"></label>
          <button type="submit" class="primary-btn">저장</button>
          <button type="button" class="ghost-btn" id="st-round-cancel">취소</button>
        </form>`
      : `<div class="inline-form st-target"><label class="field">달<input type="month" id="st-month" value="${st.month}"></label></div>`}
      ${excel && !cur ? '<div class="empty">회차를 추가하면 멤버별 금액을 넣을 수 있어요.</div>' : `
        <div class="st-toolbar">
          <input type="search" class="cell-input" id="st-search" placeholder="멤버 찾기">
          <span class="grow"></span>
          <button type="button" class="ghost-btn" id="st-template">양식 받기 (.xlsx)</button>
          <label class="ghost-btn file-btn">시트 업로드<input type="file" id="st-upload" accept=".xlsx,.xls,.csv" hidden></label>
          <button type="button" class="primary-btn" id="st-save">저장</button>
        </div>
        <div class="table-wrap">
          <table class="sig-table admin-table st-table">
            <thead><tr><th>멤버</th>${ST_SRC.map(([, n]) => `<th class="num">${n}</th>`).join("")}<th>메모</th><th class="num">후원 합계</th><th class="num">수수료 · 세금</th><th class="num">회사</th><th class="num">멤버 정산</th></tr></thead>
            <tbody id="st-rows"><tr><td colspan="9"><div class="empty">불러오는 중…</div></td></tr></tbody>
          </table>
        </div>`}`;

    if (excel) bindRoundForm(cur);
    else $("#st-month").addEventListener("change", (e) => { st.month = e.target.value || thisMonth(); renderSettle(); });
    if (excel && !cur) return;

    const q = excel ? `kind=excel&round=${cur.id}` : `kind=personal&month=${st.month}`;
    let entries;
    try { entries = await api(`api/admin/settle/entries?${q}`); } catch (err) { stNote(err.message); return; }
    const byMember = new Map(entries.map((e) => [e.member_id, e]));
    const kind = excel ? "excel" : "personal";
    $("#st-rows").innerHTML = st.data.members.map((m) => {
      const e = byMember.get(m.id) || {};
      const paid = !!e.paid_at;
      return `<tr data-member="${m.id}" data-name="${esc(m.name.toLowerCase())}" class="${paid ? "is-paid" : ""}">
        <td><strong>${esc(m.name)}</strong>${m.user ? "" : ' <span class="muted">(회원 연결 안 됨)</span>'}${paid ? ` <span class="status status-approved">지급 완료</span>` : ""}</td>
        ${ST_SRC.map(([k]) => `<td class="num"><input class="cell-input money" inputmode="numeric" data-k="${k}" value="${e[k] ? wonFmt(e[k]) : ""}" placeholder="0" ${paid ? "disabled" : ""}></td>`).join("")}
        <td><input class="cell-input" data-k="memo" maxlength="200" value="${esc(e.memo || "")}" ${paid ? "disabled" : ""}></td>
        <td class="num" data-out="gross"></td><td class="num" data-out="cut"></td><td class="num" data-out="company"></td><td class="num" data-out="member"></td>
      </tr>`;
    }).join("") || '<tr><td colspan="9"><div class="empty">등록된 멤버가 없습니다.</div></td></tr>';

    const termsOf = (id) => byMember.get(id)?.terms || st.data.members.find((m) => m.id === id).terms;
    const recalc = (tr) => {
      const v = Object.fromEntries(ST_SRC.map(([k]) => [k, toNum($(`[data-k="${k}"]`, tr).value)]));
      const c = calcSettle({ ...v, kind }, termsOf(Number(tr.dataset.member)));
      $('[data-out="gross"]', tr).textContent = c.gross ? wonFmt(c.gross) : "";
      $('[data-out="cut"]', tr).textContent = c.gross ? wonFmt(c.fee + c.tax) : "";
      $('[data-out="company"]', tr).textContent = c.gross ? wonFmt(c.company) : "";
      $('[data-out="member"]', tr).innerHTML = c.gross ? `<b>${wonFmt(c.member)}</b>` : "";
    };
    $$("#st-rows tr[data-member]").forEach(recalc);
    $("#st-rows").addEventListener("input", (e) => {
      const tr = e.target.closest("tr[data-member]");
      if (tr) recalc(tr);
    });
    // 입력칸을 벗어나면 천 단위 쉼표
    $("#st-rows").addEventListener("focusout", (e) => {
      if (e.target.classList.contains("money")) e.target.value = toNum(e.target.value) ? wonFmt(toNum(e.target.value)) : "";
    });
    $("#st-search").addEventListener("input", (e) => {
      const s = e.target.value.trim().toLowerCase();
      $$("#st-rows tr[data-member]").forEach((tr) => (tr.hidden = !!s && !tr.dataset.name.includes(s)));
    });

    const target = excel ? { kind, round: cur.id } : { kind, month: st.month };
    const targetName = excel ? `엑셀_${cur.season}시즌_${cur.round}회차` : `개인방송_${st.month}`;
    const collect = () => $$("#st-rows tr[data-member]").filter((tr) => !tr.classList.contains("is-paid")).map((tr) => ({
      member_id: Number(tr.dataset.member),
      ...Object.fromEntries(ST_SRC.map(([k]) => [k, toNum($(`[data-k="${k}"]`, tr).value)])),
      memo: $('[data-k="memo"]', tr).value,
    }));
    const save = async (rows) => {
      const r = await api("api/admin/settle/entries", { ...target, rows });
      stNote(`저장했습니다. ${r.saved}명 반영${r.removed ? ` · ${r.removed}명 비움` : ""}${r.skipped_paid ? ` · 지급 완료라 건너뜀 ${r.skipped_paid}명` : ""}`);
    };
    $("#st-save").addEventListener("click", (e) => act(e.currentTarget, async () => { await save(collect()); renderSettle(); }));

    // 양식: 멤버ID · 멤버 · SOOP · 유튜브 계좌후원 · 유튜브 웹후원 · 메모 (지금 넣어 둔 금액도 같이)
    $("#st-template").addEventListener("click", () => {
      if (!window.XLSX) return stNote("엑셀 도구를 불러오지 못했습니다. 새로고침 후 다시 시도하세요.");
      const rows = [["멤버ID", "멤버", ...ST_SRC.map(([, n]) => n), "메모"]];
      for (const m of st.data.members) {
        const e = byMember.get(m.id) || {};
        rows.push([m.id, m.name, e.soop || 0, e.yt_account || 0, e.yt_web || 0, e.memo || ""]);
      }
      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws["!cols"] = [{ wch: 8 }, { wch: 16 }, { wch: 14 }, { wch: 16 }, { wch: 16 }, { wch: 24 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "정산");
      XLSX.writeFile(wb, `정산_${targetName}.xlsx`);
    });

    $("#st-upload").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (!file) return;
      try {
        const { rows, unknown } = await readSettleSheet(file);
        if (!rows.length) throw new Error("시트에서 멤버를 찾지 못했습니다. [양식 받기]로 받은 파일 형식을 써 주세요.");
        // 지급 완료된 멤버는 서버에서 건너뜀
        const r = await api("api/admin/settle/entries", { ...target, rows });
        renderSettle();
        stNote(`시트 반영: ${r.saved}명 저장${r.removed ? ` · ${r.removed}명 비움` : ""}${r.skipped_paid ? ` · 지급 완료라 건너뜀 ${r.skipped_paid}명` : ""}${unknown.length ? ` · 못 찾은 멤버: ${unknown.slice(0, 10).join(", ")}${unknown.length > 10 ? ` 외 ${unknown.length - 10}명` : ""}` : ""}`);
      } catch (err) { stNote(err.message); }
    });
  }

  // 시트 읽기: 첫 줄에서 칸 이름을 찾아 맞춤. 멤버ID 가 있으면 ID로, 없으면 이름으로 멤버를 찾음
  async function readSettleSheet(file) {
    if (!window.XLSX) throw new Error("엑셀 도구를 불러오지 못했습니다. 새로고침 후 다시 시도하세요.");
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "" });
    const hi = aoa.findIndex((r) => r.some((c) => /멤버|이름/.test(String(c))));
    if (hi < 0) throw new Error("첫 줄에 '멤버' 칸이 있어야 합니다.");
    const head = aoa[hi].map((c) => String(c).replace(/\s/g, "").toLowerCase());
    const col = (re) => head.findIndex((h) => re.test(h));
    const c = {
      id: col(/^멤버id$|^id$/), name: col(/^멤버$|^이름$|멤버이름/),
      soop: col(/soop|숲|별풍선/), yt_account: col(/계좌/), yt_web: col(/웹/), memo: col(/메모/),
    };
    const byName = new Map(st.data.members.map((m) => [m.name.replace(/\s/g, "").toLowerCase(), m]));
    const rows = [], unknown = [];
    for (const r of aoa.slice(hi + 1)) {
      const name = c.name >= 0 ? String(r[c.name]).trim() : "";
      const id = c.id >= 0 ? Number(r[c.id]) : NaN;
      if (!name && !id) continue;
      const m = st.data.members.find((x) => x.id === id) || byName.get(name.replace(/\s/g, "").toLowerCase());
      if (!m) { unknown.push(name || `ID ${r[c.id]}`); continue; }
      rows.push({
        member_id: m.id,
        soop: c.soop >= 0 ? toNum(r[c.soop]) : 0, yt_account: c.yt_account >= 0 ? toNum(r[c.yt_account]) : 0,
        yt_web: c.yt_web >= 0 ? toNum(r[c.yt_web]) : 0, memo: c.memo >= 0 ? String(r[c.memo]).trim() : "",
      });
    }
    return { rows, unknown };
  }

  function bindRoundForm(cur) {
    const form = $("#st-round-form");
    $("#st-round").addEventListener("change", (e) => { st.round = Number(e.target.value) || null; renderSettle(); });
    $("#st-round-new").addEventListener("click", () => { form.reset(); form.elements.id.value = ""; form.hidden = false; });
    $("#st-round-cancel").addEventListener("click", () => (form.hidden = true));
    if (cur) {
      $("#st-round-edit").addEventListener("click", () => {
        Object.assign(form.elements.id, { value: cur.id });
        form.elements.season.value = cur.season; form.elements.round.value = cur.round;
        form.elements.held_on.value = cur.held_on; form.elements.title.value = cur.title;
        form.hidden = false;
      });
      $("#st-round-del").addEventListener("click", (e) => {
        if (!confirmClick(e.currentTarget)) return;
        act(e.currentTarget, async () => { await api("api/admin/settle/rounds", { action: "delete", id: cur.id }); st.round = null; await loadSettle(); stNote("회차를 지웠습니다."); });
      });
    }
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        const r = await api("api/admin/settle/rounds", Object.fromEntries(new FormData(form)));
        st.round = r.id;
        await loadSettle();
        stNote("회차를 저장했습니다.");
      } catch (err) { stNote(err.message); }
    });
  }

  /* 월별 합계 · 지급 */
  async function renderMonthSum(body) {
    body.innerHTML = `
      <div class="inline-form st-target">
        <label class="field">달<input type="month" id="st-sum-month" value="${st.sumMonth}"></label>
      </div>
      <div class="st-toolbar">
        <span class="grow" id="st-sum-total"></span>
        <button type="button" class="ghost-btn" id="st-sum-xlsx">지급 목록 받기 (.xlsx)</button>
        <button type="button" class="primary-btn" id="st-sum-payall">남은 멤버 모두 지급 완료</button>
      </div>
      <div class="table-wrap">
        <table class="sig-table admin-table st-table">
          <thead><tr><th>멤버</th><th>정산 내역</th><th class="num">후원 합계</th><th class="num">수수료</th><th class="num">세금</th><th class="num">회사</th><th class="num">멤버 정산</th><th>받는 계좌</th><th>상태</th></tr></thead>
          <tbody id="st-sum-rows"><tr><td colspan="9"><div class="empty">불러오는 중…</div></td></tr></tbody>
        </table>
      </div>`;
    $("#st-sum-month").addEventListener("change", (e) => { st.sumMonth = e.target.value || thisMonth(); renderSettle(); });
    let entries;
    try { entries = await api(`api/admin/settle/entries?kind=month&month=${st.sumMonth}`); } catch (err) { stNote(err.message); return; }
    const groups = new Map();
    for (const e of entries) {
      if (!groups.has(e.member_id)) groups.set(e.member_id, { list: [], gross: 0, fee: 0, tax: 0, company: 0, member: 0 });
      const g = groups.get(e.member_id);
      g.list.push(e);
      for (const k of ["gross", "fee", "tax", "company", "member"]) g[k] += e.calc[k];
    }
    const rows = st.data.members.filter((m) => groups.has(m.id)).map((m) => {
      const g = groups.get(m.id);
      return { m, g, paid: g.list.every((e) => e.paid_at), paidAt: Math.max(...g.list.map((e) => e.paid_at || 0)) };
    });
    const sum = (k) => rows.reduce((a, r) => a + r.g[k], 0);
    $("#st-sum-total").innerHTML = rows.length ? `${rows.length}명 · 후원 ${wonFmt(sum("gross"))}원 · 멤버 정산 <b>${wonFmt(sum("member"))}원</b> · 회사 ${wonFmt(sum("company"))}원` : "";
    $("#st-sum-rows").innerHTML = rows.length ? rows.map(({ m, g, paid, paidAt }) => `
      <tr data-member="${m.id}">
        <td><strong>${esc(m.name)}</strong></td>
        <td class="st-items">${g.list.map((e) => e.kind === "excel" ? `엑셀 ${e.season}-${e.round}회` : "개인방송").join(" · ")}</td>
        <td class="num">${wonFmt(g.gross)}</td><td class="num">${wonFmt(g.fee)}</td><td class="num">${wonFmt(g.tax)}</td>
        <td class="num">${wonFmt(g.company)}</td><td class="num"><b>${wonFmt(g.member)}</b></td>
        <td>${m.user ? `${esc(m.user.real_name)} <span class="muted">${esc(m.user.bank)} ${esc(m.user.account)}</span>` : '<span class="muted">회원 연결 안 됨</span>'}</td>
        <td class="nowrap">${paid
          ? `<span class="status status-approved">지급 완료 ${fmtDate(paidAt)}</span> <button type="button" class="mini-action" data-unpay>취소</button>`
          : `<button type="button" class="mini-action ok" data-pay>지급 완료</button>`}</td>
      </tr>`).join("") : '<tr><td colspan="9"><div class="empty">이 달에 넣은 정산 금액이 없습니다.</div></td></tr>';

    const setPaid = async (ids, paid) => {
      await api("api/admin/settle/paid", { month: st.sumMonth, member_ids: ids, paid });
      renderSettle();
    };
    $("#st-sum-rows").addEventListener("click", (e) => {
      const b = e.target.closest("[data-pay], [data-unpay]");
      if (b) act(b, () => setPaid([Number(b.closest("tr").dataset.member)], b.hasAttribute("data-pay")));
    });
    $("#st-sum-payall").addEventListener("click", (e) => {
      const ids = rows.filter((r) => !r.paid).map((r) => r.m.id);
      if (!ids.length) return stNote("남은 멤버가 없습니다.");
      if (!confirmClick(e.currentTarget)) return;
      act(e.currentTarget, () => setPaid(ids, true));
    });
    $("#st-sum-xlsx").addEventListener("click", () => {
      if (!window.XLSX) return stNote("엑셀 도구를 불러오지 못했습니다.");
      const aoa = [["멤버", "본명", "은행", "계좌번호", "후원 합계", "수수료", "세금", "회사", "멤버 정산", "상태"]];
      for (const { m, g, paid } of rows) aoa.push([m.name, m.user?.real_name || "", m.user?.bank || "", m.user?.account || "", g.gross, g.fee, g.tax, g.company, g.member, paid ? "지급 완료" : "지급 예정"]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), st.sumMonth);
      XLSX.writeFile(wb, `정산_지급목록_${st.sumMonth}.xlsx`);
    });
  }

  /* 계약 조건 */
  const termInputs = (t, attrs = "") => TERM_FIELDS.map(([k]) => `<td><input class="cell-input small" inputmode="decimal" data-t="${k}" value="${t[k]}" ${attrs}></td>`).join("")
    + `<td><select class="cell-input" data-t="tax_mode" ${attrs}><option value="before" ${t.tax_mode !== "after" ? "selected" : ""}>나누기 전</option><option value="after" ${t.tax_mode === "after" ? "selected" : ""}>나눈 뒤 멤버 몫에서</option></select></td>`;
  const readTerms = (tr) => Object.fromEntries($$("[data-t]", tr).map((i) => [i.dataset.t, i.value]));

  function renderTerms(body) {
    const d = st.data.default_terms;
    const head = `<tr><th>멤버</th>${TERM_FIELDS.map(([, n]) => `<th>${n}</th>`).join("")}<th>세금 떼는 시점</th><th class="right">관리</th></tr>`;
    body.innerHTML = `
      <div class="box">
        <h3>기본 조건</h3>
        <p class="hint">조건을 따로 정하지 않은 멤버에게 적용됩니다. 멤버 몫 %는 회사와 나눌 때 멤버가 받는 비율입니다 (예: 60 → 멤버 60 : 회사 40).<br>
          계산 순서: 후원금 − 플랫폼 수수료 → 세금 → 회사와 나누기. "나눈 뒤 멤버 몫에서"를 고르면 회사와 먼저 나누고 멤버 몫에서만 세금을 뗍니다.</p>
        <div class="table-wrap"><table class="sig-table admin-table st-terms"><thead>${head}</thead>
          <tbody><tr id="st-default"><td><strong>기본</strong></td>${termInputs(d)}<td class="right"><button type="button" class="mini-action ok" id="st-default-save">저장</button></td></tr></tbody></table></div>
      </div>
      <div class="st-toolbar">
        <input type="search" class="cell-input" id="st-terms-search" placeholder="멤버 찾기">
        <span class="grow"></span>
        <button type="button" class="ghost-btn" id="st-terms-template">조건 양식 받기 (.xlsx)</button>
        <label class="ghost-btn file-btn">조건 시트 업로드<input type="file" id="st-terms-upload" accept=".xlsx,.xls,.csv" hidden></label>
      </div>
      <div class="table-wrap"><table class="sig-table admin-table st-terms"><thead>${head}</thead>
        <tbody id="st-terms-rows">${st.data.members.map((m) => `
          <tr data-member="${m.id}" data-name="${esc(m.name.toLowerCase())}">
            <td><strong>${esc(m.name)}</strong><br><span class="muted">${m.custom ? "개별 조건" : "기본 조건 사용 중"}</span></td>
            ${termInputs(m.terms)}
            <td class="right nowrap"><button type="button" class="mini-action ok" data-save>저장</button>${m.custom ? ' <button type="button" class="mini-action" data-reset>기본으로</button>' : ""}</td>
          </tr>`).join("")}</tbody></table></div>`;

    $("#st-default-save").addEventListener("click", (e) => act(e.currentTarget, async () => {
      await api("api/admin/settle/terms", { terms: readTerms($("#st-default")) });
      await loadSettle(); stNote("기본 조건을 저장했습니다.");
    }));
    $("#st-terms-rows").addEventListener("click", (e) => {
      const b = e.target.closest("[data-save], [data-reset]");
      if (!b) return;
      const tr = b.closest("tr");
      act(b, async () => {
        await api("api/admin/settle/terms", { member_id: Number(tr.dataset.member), terms: readTerms(tr), reset: b.hasAttribute("data-reset") });
        await loadSettle(); stNote(b.hasAttribute("data-reset") ? "기본 조건으로 되돌렸습니다." : "조건을 저장했습니다.");
      });
    });
    $("#st-terms-search").addEventListener("input", (e) => {
      const s = e.target.value.trim().toLowerCase();
      $$("#st-terms-rows tr").forEach((tr) => (tr.hidden = !!s && !tr.dataset.name.includes(s)));
    });
    $("#st-terms-template").addEventListener("click", () => {
      if (!window.XLSX) return stNote("엑셀 도구를 불러오지 못했습니다.");
      const aoa = [["멤버ID", "멤버", ...TERM_FIELDS.map(([, n]) => n), "세금 시점 (나누기 전 / 나눈 뒤)"]];
      for (const m of st.data.members) aoa.push([m.id, m.name, ...TERM_FIELDS.map(([k]) => m.terms[k]), m.terms.tax_mode === "after" ? "나눈 뒤" : "나누기 전"]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "계약 조건");
      XLSX.writeFile(wb, "정산_계약조건.xlsx");
    });
    $("#st-terms-upload").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (!file) return;
      try {
        const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
        const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "" });
        const head = (aoa[0] || []).map((c) => String(c).replace(/\s/g, ""));
        const idx = (label) => head.indexOf(label.replace(/\s/g, ""));
        const iId = idx("멤버ID"), iName = idx("멤버"), iMode = head.findIndex((h) => h.startsWith("세금시점"));
        const rows = [], unknown = [];
        for (const r of aoa.slice(1)) {
          const m = st.data.members.find((x) => x.id === Number(r[iId])) || st.data.members.find((x) => x.name === String(r[iName]).trim());
          if (!m) { if (String(r[iName]).trim()) unknown.push(String(r[iName]).trim()); continue; }
          const terms = Object.fromEntries(TERM_FIELDS.map(([k, n]) => [k, idx(n) >= 0 ? r[idx(n)] : m.terms[k]]));
          terms.tax_mode = iMode >= 0 && /뒤|after/i.test(String(r[iMode])) ? "after" : "before";
          rows.push({ member_id: m.id, terms });
        }
        const res = await api("api/admin/settle/terms/bulk", { rows });
        await loadSettle();
        stNote(`조건 반영: ${res.saved}명${unknown.length ? ` · 못 찾은 멤버: ${unknown.slice(0, 10).join(", ")}` : ""}`);
      } catch (err) { stNote(err.message); }
    });
  }

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
