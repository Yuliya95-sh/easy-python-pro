/* =========================================================
   Easy Python — журнал действий ученика.
   Ученик один раз вводит имя, класс и PIN. Действия (уроки, проверки
   задач, тесты, открытые страницы) копятся в очереди в localStorage
   и отправляются в Google-таблицу учителя (config.js → endpoint).
   Если связи нет, очередь ждёт и уйдёт позже — история не теряется.
   ========================================================= */
(function () {
  "use strict";
  const LS_ID = "eppro.student.v1";
  const LS_Q = "eppro.queue.v1";
  const LS_JOIN = "eppro.join.v1";   // код класса из ссылки-приглашения, пока ученик не вошёл
  const LS_RESET = "eppro.progressReset.v1";   // ученик сбросил прогресс — журнал должен заменить, а не объединить
  const MAX_Q = 3000;

  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function endpoint() {
    const c = (window.EP_CONFIG && window.EP_CONFIG.endpoint) || "";
    return c || ls.get("eppro.endpoint.override", "");   // переопределение — только для локальной проверки
  }

  async function sha256(s) {
    try {
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
      return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch (e) { return "plain:" + s; }
  }
  const pinHash = (name, cls, pin) => sha256(`ep|${norm(name)}|${norm(cls)}|${pin}`);
  const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ").replace(/ё/g, "е");
  const newId = () => "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const T = {
    student: ls.get(LS_ID, null),
    queue: ls.get(LS_Q, []),
    hooks: { snapshot: () => null, progress: () => null, onRestore: () => {}, onMerge: () => {} },
    sending: false,
    lastOpen: "",
    enabled() { return !!endpoint(); },

    init(hooks) {
      Object.assign(this.hooks, hooks || {});
      if (!this.enabled()) return;
      setInterval(() => this.flush(), 15000);
      addEventListener("online", () => this.flush());
      addEventListener("pagehide", () => this.flush(true));
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") this.flush(true);
        else if (this.student) { this.markSnapshot(); this.flush(); }   // вернулись на вкладку — подтянем прогресс с других устройств
      });
      addEventListener("hashchange", () => this.catchJoinLink());
      this.catchJoinLink();
      if (!this.student) this.showGate();
      else { this.markSnapshot(); this.flush(); }
    },

    /* ---------- класс учителя: код и ссылка-приглашение #/join/КОД ---------- */
    catchJoinLink() {
      const m = location.hash.match(/^#\/join\/([A-Za-z0-9]{4,10})/);
      if (!m) return;
      const code = m[1].toUpperCase();
      ls.set(LS_JOIN, code);
      history.replaceState(null, "", location.pathname + location.search + "#/");
      if (this.student) this.joinGroup(code, true);
      else if (document.querySelector(".ep-gate")) this.showGate();   // подставим код в открытое окно входа
    },
    async groupInfo(code) {
      const u = new URL(endpoint());
      u.searchParams.set("action", "group");
      u.searchParams.set("code", code);
      return (await fetch(u)).json();
    },
    async joinGroup(code, ask) {
      code = String(code || "").trim().toUpperCase();
      if (!code) return;
      let g;
      try { g = await this.groupInfo(code); } catch (e) { alert("Нет связи с журналом. Попробуйте позже."); return; }
      if (!g.ok) { alert(g.error || "Класс не найден"); ls.del(LS_JOIN); return; }
      if (this.student.group === g.code) { ls.del(LS_JOIN); return; }
      if (ask && !confirm(`Присоединиться к классу «${g.title}»${g.teacher ? ` (учитель: ${g.teacher})` : ""}? Учитель будет видеть ваш прогресс.`)) { ls.del(LS_JOIN); return; }
      this.setStudent(Object.assign({}, this.student, { group: g.code, groupTitle: g.title, teacher: g.teacher }));
      ls.del(LS_JOIN);
      this.log({ type: "join", title: `Класс «${g.title}»${g.teacher ? ", учитель " + g.teacher : ""}` });
      this.markSnapshot();
      this.flush();
      this.hooks.onLogin && this.hooks.onLogin();
    },

    log(ev) {
      if (!this.enabled() || !this.student) return;
      ev = Object.assign({ ts: new Date().toISOString(), sid: this.student.sid, name: this.student.name, cls: this.student.cls }, ev);
      if (ev.code && ev.code.length > 20000) ev.code = ev.code.slice(0, 20000);
      this.queue.push(ev);
      if (this.queue.length > MAX_Q) this.queue = this.queue.slice(-MAX_Q);
      ls.set(LS_Q, this.queue);
      // важные события отправляем сразу, просмотры страниц — пачкой
      if (ev.type !== "open") setTimeout(() => this.flush(), 300);
    },

    open(route, title) {
      const key = route + "|" + title;
      if (key === this.lastOpen) return;
      this.lastOpen = key;
      this.log({ type: "open", module: route.mid || "", item: route.view === "module" ? `${route.tab}/${route.n}` : route.view, title });
    },

    payload(events) {
      return JSON.stringify({ student: this.student, events, snapshot: this.hooks.snapshot(), progress: this.hooks.progress(),
        progressReset: ls.get(LS_RESET, false) || undefined });
    },

    async flush(beacon) {
      const url = endpoint();
      if (!url || !this.student || this.sending) return;
      const batch = this.queue.slice(0, 150);
      // даже без новых событий иногда отправляем снимок прогресса
      if (!batch.length && !this._dirtySnap) return;
      const body = this.payload(batch);
      if (beacon && navigator.sendBeacon) {
        if (navigator.sendBeacon(url, new Blob([body], { type: "text/plain;charset=utf-8" }))) this.drop(batch.length);
        return;
      }
      this.sending = true;
      try {
        // text/plain — «простой» запрос без предварительной проверки CORS
        const r = await fetch(url, { method: "POST", body, headers: { "Content-Type": "text/plain;charset=utf-8" }, redirect: "follow" });
        const j = await r.json().catch(() => ({ ok: r.ok }));
        if (j.ok) {
          this.drop(batch.length); this._dirtySnap = false; ls.del(LS_RESET);
          // на другом устройстве ученик успел больше — добавим к прогрессу здесь
          if (j.progress) { this.hooks.onMerge(j.progress); this.markSnapshot(); }
        }
      } catch (e) { /* нет связи — попробуем позже */ }
      this.sending = false;
      if (this.queue.length) setTimeout(() => this.flush(), 2000);
    },
    drop(n) { this.queue = this.queue.slice(n); ls.set(LS_Q, this.queue); },
    markSnapshot() { this._dirtySnap = true; },
    // ученик сам сбросил прогресс: следующая отправка заменит прогресс в журнале, а не объединит
    progressWasReset() { ls.set(LS_RESET, true); this.markSnapshot(); this.flush(); },

    /* ---------- окно входа ---------- */
    showGate(mode) {
      if (location.hash.startsWith("#/teacher")) {
        // учителю окно входа не мешает: покажем, когда уйдёт со страницы учителя
        const again = () => { if (!location.hash.startsWith("#/teacher") && !this.student) { removeEventListener("hashchange", again); this.showGate(); } };
        addEventListener("hashchange", again);
        return;
      }
      document.querySelector(".ep-gate")?.remove();
      const restore = mode === "restore";
      const g = document.createElement("div");
      g.className = "ep-gate";
      g.innerHTML = `<form class="ep-gate-box card" autocomplete="off">
        <span class="ep-label">Easy Python</span>
        <div class="lesson-nav t-tabs ep-gate-tabs">
          <button type="button" class="lesson-pill ${restore ? "" : "active"}" data-a="reg">Регистрация</button>
          <button type="button" class="lesson-pill ${restore ? "active" : ""}" data-a="login">Вход</button></div>
        <h2>${restore ? "С возвращением!" : "Давай познакомимся"}</h2>
        <p class="muted small">${restore
          ? "Уже занимались? Введите те же имя, класс и PIN, что при регистрации, — прогресс загрузится на это устройство."
          : "Учитель будет видеть ваши уроки, проверки задач и результаты тестов. PIN нужен, чтобы продолжить с другого устройства."}</p>
        <label>Фамилия и имя<input type="text" name="name" required minlength="3" maxlength="60" placeholder="Например: Ахметова Алия"></label>
        <label>Класс<input type="text" name="cls" required maxlength="12" placeholder="Например: 11А"></label>
        <label>PIN — 4 цифры<input type="text" name="pin" required inputmode="numeric" pattern="[0-9]{4}" maxlength="4" placeholder="${restore ? "Ваш PIN" : "Придумайте и запомните"}"></label>
        ${restore ? "" : `<label>Код класса от учителя <span class="muted" style="font-weight:400">(если есть)</span>
          <input type="text" name="group" maxlength="10" autocapitalize="characters" placeholder="Например: K7X2QP" value="${esc(ls.get(LS_JOIN, ""))}"></label>
          <div class="ep-gate-group small muted"></div>`}
        <div class="ep-gate-err small"></div>
        <button class="btn btn-primary" type="submit">${restore ? "Войти" : "Зарегистрироваться"}</button>
        ${restore ? `<p class="small muted" style="text-align:center;margin:0">Забыли PIN? Попросите учителя сбросить его в кабинете.</p>` : ""}
        <a class="small" href="#/teacher" data-a="teacher" style="text-align:center;display:block;margin-top:4px">👩‍🏫 Я учитель — войти в кабинет</a>
      </form>`;
      document.body.appendChild(g);
      document.body.classList.add("gate-open");
      const f = g.querySelector("form");
      const err = g.querySelector(".ep-gate-err");
      g.querySelector('[data-a="reg"]').onclick = () => { if (restore) this.showGate(""); };
      g.querySelector('[data-a="login"]').onclick = () => { if (!restore) this.showGate("restore"); };
      g.querySelector('[data-a="teacher"]').onclick = (e) => {
        e.preventDefault();
        g.remove(); document.body.classList.remove("gate-open");
        location.hash = "#/teacher";
        this.showGate();   // окно вернётся, если уйти со страницы учителя без входа ученика
      };
      setTimeout(() => f.name.focus(), 50);
      // проверяем код класса сразу, чтобы ученик видел, к какому учителю попадёт
      const gInfo = g.querySelector(".ep-gate-group");
      let checked = { code: "", g: null }, dupWarned = "";
      const checkCode = async () => {
        const code = (f.group && f.group.value.trim().toUpperCase()) || "";
        if (!gInfo) return null;
        if (!code) { gInfo.textContent = ""; checked = { code: "", g: null }; return null; }
        if (checked.code === code) return checked.g;
        gInfo.textContent = "Проверяем код…";
        try {
          const r = await this.groupInfo(code);
          checked = { code, g: r.ok ? r : null };
          gInfo.innerHTML = r.ok ? `✅ Класс <b>${esc(r.title)}</b>${r.teacher ? `, учитель ${esc(r.teacher)}` : ""}` : `❌ ${esc(r.error || "Код не найден")}`;
        } catch (x) { checked = { code: "", g: null }; gInfo.textContent = "Не удалось проверить код — нет связи."; }
        return checked.g;
      };
      if (f.group) {
        f.group.addEventListener("change", checkCode);
        if (f.group.value) checkCode();
      }
      f.onsubmit = async (e) => {
        e.preventDefault();
        const name = f.name.value.trim().replace(/\s+/g, " "), cls = f.cls.value.trim().toUpperCase(), pin = f.pin.value.trim();
        if (!/^\d{4}$/.test(pin)) { err.textContent = "PIN — ровно 4 цифры."; return; }
        const hash = await pinHash(name, cls, pin);
        const btn = f.querySelector('[type="submit"]');
        if (restore) {
          btn.disabled = true; err.textContent = "Ищем…";
          try {
            const u = new URL(endpoint()); u.searchParams.set("action", "restore");
            u.searchParams.set("name", name); u.searchParams.set("cls", cls); u.searchParams.set("pin", hash);
            const j = await (await fetch(u)).json();
            if (!j.ok) { err.textContent = j.error || "Не найдено."; btn.disabled = false; return; }
            this.setStudent({ sid: j.sid, name: j.name, cls: j.cls, pin: hash, group: j.group || "", groupTitle: j.groupTitle || "" });
            if (j.progress) this.hooks.onRestore(j.progress);
            this.log({ type: "login", title: "Восстановление прогресса" });
            this.closeGate();
          } catch (x) { err.textContent = "Нет связи с журналом. Проверьте интернет."; btn.disabled = false; }
          return;
        }
        // уже зарегистрирован? те же имя, класс и PIN — просто входим; то же имя без PIN — подсказываем «Вход»
        btn.disabled = true;
        try {
          const u = new URL(endpoint()); u.searchParams.set("action", "restore");
          u.searchParams.set("name", name); u.searchParams.set("cls", cls); u.searchParams.set("pin", hash);
          const j = await (await fetch(u)).json();
          if (j.ok) {
            this.setStudent({ sid: j.sid, name: j.name, cls: j.cls, pin: hash, group: j.group || "", groupTitle: j.groupTitle || "" });
            if (j.progress) this.hooks.onRestore(j.progress);
            this.log({ type: "login", title: "Вход (повторная регистрация)" });
            this.closeGate(); return;
          }
          const key = norm(name) + "|" + norm(cls);
          if (dupWarned !== key) {
            const u2 = new URL(endpoint()); u2.searchParams.set("action", "exists");
            u2.searchParams.set("name", name); u2.searchParams.set("cls", cls);
            const k = await (await fetch(u2)).json();
            if (k.ok && k.exists) {
              dupWarned = key; btn.disabled = false;
              err.innerHTML = `Ученик «${esc(name)}», класс ${esc(cls)} уже зарегистрирован. Если это вы — откройте вкладку <b>«Вход»</b> (забыли PIN — учитель сбросит). Если это другой человек — нажмите «Зарегистрироваться» ещё раз.`;
              return;
            }
          }
        } catch (x) { /* нет связи — регистрируем как обычно */ }
        btn.disabled = false;
        let grp = null;
        if (f.group && f.group.value.trim()) {
          btn.disabled = true;
          grp = await checkCode();
          btn.disabled = false;
          if (!grp) { err.textContent = "Код класса не найден. Проверьте его у учителя или оставьте поле пустым."; return; }
        }
        this.setStudent({ sid: newId(), name, cls, pin: hash, group: grp ? grp.code : "", groupTitle: grp ? grp.title : "", teacher: grp ? grp.teacher : "" });
        ls.del(LS_JOIN);
        this.log({ type: "login", title: grp ? `Первый вход · класс «${grp.title}»` : "Первый вход" });
        this.markSnapshot();
        this.closeGate();
      };
    },
    closeGate() {
      document.querySelector(".ep-gate")?.remove();
      document.body.classList.remove("gate-open");
      this.hooks.onLogin && this.hooks.onLogin();
    },
    setStudent(s) { this.student = s; ls.set(LS_ID, s); },
    logout() {
      if (!confirm("Сменить ученика? Прогресс на этом устройстве будет очищен (его можно восстановить по имени, классу и PIN).")) return;
      this.flush(true);
      this.student = null; ls.del(LS_ID);
      this.hooks.onLogout && this.hooks.onLogout();
      this.showGate();
    },
    badge() {
      if (!this.enabled()) return "";
      if (!this.student) return "";
      const s = this.student;
      return `<div class="ep-me small"><div class="ep-me-row"><span>👤 <b>${esc(s.name)}</b>, ${esc(s.cls)}</span><a href="#" data-ep="logout">Сменить</a></div>
        <div class="ep-me-row">${s.group ? `<span>🏫 ${esc(s.groupTitle || s.group)}${s.teacher ? ` · ${esc(s.teacher)}` : ""}</span><a href="#" data-ep="join">Другой класс</a>`
          : `<span>Класс не выбран</span><a href="#" data-ep="join">Ввести код класса</a>`}</div></div>`;
    },
  };
  window.EPTrack = T;
})();
