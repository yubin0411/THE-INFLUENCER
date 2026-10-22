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
    await Promise.all([loadSigs(), loadFiles()]);
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
            <input class="cell-input" name="ref_url" value="${esc(s.ref_url)}" placeholder="유튜브 레퍼런스" aria-label="유튜브 레퍼런스">
            <label class="check"><input type="checkbox" name="hidden" ${s.hidden ? "checked" : ""}> 숨김</label>
            <div class="actions">
              <button type="button" class="mini-action ${wait ? "warn" : ""}" data-lessons aria-expanded="${open}">레슨 ${ready}${wait ? ` · 대기 ${wait}` : ""}</button>
              <button type="button" class="mini-action ok" data-save>저장</button>
              <button type="button" class="mini-action danger" data-delete>삭제</button>
            </div>
          </div>
          <div class="lesson-box" ${open ? "" : "hidden"}>
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
    $$("input[type=file]", card).forEach((i) => (i.disabled = true));
    note.textContent = `${file.name} 올리는 중… (${fmtSize(file.size)})`;
    try {
      await upload(`api/admin/sigs/${card.dataset.sig}/lessons/upload${q}`, file, $(".progress", card));
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
  async function readExcel(file) {
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws?.["!ref"]) return [];
    const range = XLSX.utils.decode_range(ws["!ref"]);
    const cell = (r, c) => (c === undefined ? undefined : ws[XLSX.utils.encode_cell({ r, c })]);
    const text = (r, c) => { const x = cell(r, c); return x ? String(x.w ?? x.v ?? "").trim() : ""; };
    const MATCH = { exclude: /제외/, category: /분류/, name: /이름/, price: /단가|가격/, ref: /레퍼런스|유튜브/, lessons: /레슨/ };

    for (let head = range.s.r; head <= Math.min(range.e.r, range.s.r + 20); head++) {
      const cols = {};
      for (let c = range.s.c; c <= range.e.c; c++) {
        const t = text(head, c).replace(/\s/g, "");
        for (const [key, re] of Object.entries(MATCH)) if (cols[key] === undefined && re.test(t)) { cols[key] = c; break; }
      }
      if (cols.name === undefined) continue;
      const rows = [];
      for (let r = head + 1; r <= range.e.r; r++) {
        const name = text(r, cols.name);
        if (!name) continue;
        const ref = cell(r, cols.ref);
        const lessons = cell(r, cols.lessons);
        rows.push({
          exclude: text(r, cols.exclude),
          category: text(r, cols.category),
          name,
          price: cell(r, cols.price)?.v ?? "",
          ref: text(r, cols.ref) || ref?.l?.Target || "",
          lessons: text(r, cols.lessons),
          lessonLink: lessons?.l?.Target || "",
        });
      }
      return rows;
    }
    return [];
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
