/* =========================================================
   Easy Python PRO — кабинет учителя (#/teacher).
   Регистрация и вход учителей, классы с кодами-приглашениями,
   журнал только своих учеников, страница ученика, панель администратора.
   ========================================================= */
(function () {
  "use strict";
  const LS_AUTH = "eppro.teacherAuth.v1";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const h = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const getAuth = () => { try { return JSON.parse(localStorage.getItem(LS_AUTH) || "null"); } catch (e) { return null; } };
  const setAuth = (a) => { try { a ? localStorage.setItem(LS_AUTH, JSON.stringify(a)) : localStorage.removeItem(LS_AUTH); } catch (e) {} };
  const endpoint = () => (window.EP_CONFIG && window.EP_CONFIG.endpoint) || (() => { try { return JSON.parse(localStorage.getItem("eppro.endpoint.override") || '""'); } catch (e) { return ""; } })();
  const rerender = () => window.dispatchEvent(new HashChangeEvent("hashchange"));
  const joinLink = (code) => `${location.origin}${location.pathname}#/join/${code}`;

  const TYPE = {
    login: ["👤", "Вход"], open: ["👁", "Открыл(а)"], lesson: ["📖", "Урок изучен"],
    check: ["💻", "Проверка задачи"], quiz: ["📝", "Тест"], run: ["▶", "Запуск"], join: ["🏫", "Вступил(а) в класс"],
  };
  let state = { data: null, filterCls: "", search: "", sort: "last", showOpens: false, timer: null };

  function when(v) {
    const d = new Date(v);
    if (isNaN(d)) return esc(v);
    const s = (Date.now() - d) / 1000;
    const rel = s < 60 ? "только что" : s < 3600 ? `${Math.floor(s / 60)} мин назад` : s < 86400 ? `${Math.floor(s / 3600)} ч назад` : s < 7 * 86400 ? `${Math.floor(s / 86400)} дн назад` : "";
    const abs = d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    return rel ? `<span title="${abs}">${rel}</span>` : abs;
  }
  const modTitle = (C, id) => { const i = C.modules.findIndex((m) => m.id === id); return i < 0 ? id || "" : `М${i + 1}. ${C.modules[i].title}`; };
  const ok = (v) => v === true || v === "да";

  // Все запросы кабинета — POST с токеном входа (пароль по сети передаётся только при входе)
  async function api(action, data) {
    const a = getAuth();
    const body = JSON.stringify(Object.assign({ action, token: a ? a.token : "" }, data || {}));
    let r;
    try { r = await fetch(endpoint(), { method: "POST", body, headers: { "Content-Type": "text/plain;charset=utf-8" }, redirect: "follow" }); }
    catch (x) { throw new Error("нет связи с Google (проверьте интернет)"); }
    const txt = await r.text();
    let j;
    try { j = JSON.parse(txt); } catch (x) {
      const plain = txt.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, "\n").split("\n").map((s) => s.trim()).filter(Boolean);
      const msg = plain.find((s) => /Error|Ошибка|Exception|превышен|exceeded|строка|line/i.test(s) && s.length > 8) || `HTTP ${r.status}`;
      throw new Error("скрипт таблицы ответил ошибкой: " + msg.slice(0, 300));
    }
    if (j && j.auth === false) { setAuth(null); state.data = null; setTimeout(rerender, 0); }
    return j;
  }

  /* ---------------- вход / регистрация ---------------- */
  function authScreen(el) {
    const mode = state.authMode || "login";
    const field = (label, name, type, extra) => `<label class="t-field">${label}<input type="${type || "text"}" name="${name}" ${extra || ""}></label>`;
    const forms = {
      login: `<h1>Вход для учителя</h1><p class="muted small">Войдите, чтобы видеть прогресс учеников своих классов.</p>
        ${field("Логин", "login", "text", 'required autocomplete="username" autocapitalize="none"')}
        ${field("Пароль", "password", "password", 'required autocomplete="current-password"')}
        <button class="btn btn-primary">Войти</button>`,
      register: `<h1>Регистрация учителя</h1><p class="muted small">После регистрации создайте класс — ученики вступят в него по коду или ссылке.</p>
        ${field("Фамилия, имя, отчество", "name", "text", 'required minlength="3" maxlength="80"')}
        ${field("Школа (необязательно)", "school", "text", 'maxlength="120"')}
        ${field("Логин (латиница, можно e-mail)", "login", "text", 'required minlength="3" maxlength="60" autocomplete="username" autocapitalize="none"')}
        ${field("Пароль (от 6 символов)", "password", "password", 'required minlength="6" autocomplete="new-password"')}
        ${field("Повторите пароль", "password2", "password", 'required minlength="6" autocomplete="new-password"')}
        <button class="btn btn-primary">Зарегистрироваться</button>`,
      admin: `<h1>Вход администратора</h1><p class="muted small">Пароль администратора задан в скрипте таблицы (ADMIN_KEY). Администратор видит всех учителей и учеников.</p>
        ${field("Пароль администратора", "key", "password", "required")}
        <button class="btn btn-primary">Войти</button>`,
    };
    const box = h(`<div class="t-auth"><div class="lesson-nav t-tabs">
        <button type="button" class="lesson-pill ${mode === "login" ? "active" : ""}" data-m="login">Вход</button>
        <button type="button" class="lesson-pill ${mode === "register" ? "active" : ""}" data-m="register">Регистрация</button></div>
      <form class="card t-auth-form" autocomplete="on"><span class="ep-label">Кабинет учителя</span>${forms[mode]}<div class="small t-bad t-err"></div></form>
      <p class="small muted" style="text-align:center"><a href="#" data-m="admin">Вход администратора</a></p></div>`);
    box.querySelectorAll("[data-m]").forEach((b) => (b.onclick = (e) => { e.preventDefault(); state.authMode = b.dataset.m; rerender(); }));
    const f = box.querySelector("form"), err = box.querySelector(".t-err");
    f.onsubmit = async (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(f).entries());
      if (mode === "register" && v.password !== v.password2) { err.textContent = "Пароли не совпадают"; return; }
      const btn = f.querySelector("button"); btn.disabled = true; err.textContent = "Подождите…";
      try {
        const j = mode === "admin" ? await api("login", { key: v.key }) : await api(mode === "register" ? "register" : "login", v);
        if (!j.ok) { err.textContent = j.error || "Ошибка"; btn.disabled = false; return; }
        setAuth({ token: j.token, me: j.me });
        state.authMode = "login";
        location.hash = mode === "register" ? "#/teacher/classes" : "#/teacher";
        rerender();
      } catch (x) { err.textContent = x.message; btn.disabled = false; }
    };
    el.appendChild(box);
    setTimeout(() => f.querySelector("input")?.focus(), 30);
  }

  /* ---------------- каркас кабинета ---------------- */
  const RESERVED = ["classes", "teachers", "account"];

  function view(C) {
    const el = h(`<div class="container teacher"></div>`);
    clearInterval(state.timer);
    if (!endpoint()) {
      el.appendChild(h(`<div class="card"><span class="ep-label">Кабинет учителя</span><h1 style="margin:8px 0 10px">Журнал не подключён</h1>
        <p>Нужно один раз создать Google-таблицу со скриптом и вписать её адрес в файл <code>config.js</code> — инструкция в <code>teacher/НАСТРОЙКА.md</code>.</p>
        <p class="muted small">Пока журнал выключен, ученики занимаются без входа, прогресс хранится только в их браузере.</p></div>`));
      return el;
    }
    const auth = getAuth();
    if (!auth) { authScreen(el); return el; }
    const me = auth.me || {};
    const admin = me.role === "admin";
    const parts = location.hash.split("/");
    const sub = parts[2] ? decodeURIComponent(parts[2]) : "";
    const page = RESERVED.includes(sub) ? sub : sub ? "student" : "journal";
    const titles = { journal: "Журнал учеников", student: "Ученик", classes: admin ? "Все классы" : "Мои классы", teachers: "Учителя", account: "Аккаунт" };

    const head = h(`<div class="page-head"><div><span class="ep-label">${admin ? "Администратор" : "Кабинет учителя"} · ${esc(me.name || "")}</span>
        <h1 style="margin:6px 0 0">${titles[page]}</h1></div>
      <div class="btn-row"><button class="btn btn-ghost btn-sm" data-a="reload">↻ Обновить</button><button class="btn btn-ghost btn-sm" data-a="out">Выйти</button></div></div>`);
    const nav = h(`<nav class="lesson-nav t-tabs t-mainnav">
      <a class="lesson-pill ${page === "journal" || page === "student" ? "active" : ""}" href="#/teacher">📋 Журнал</a>
      <a class="lesson-pill ${page === "classes" ? "active" : ""}" href="#/teacher/classes">🏫 ${admin ? "Классы" : "Мои классы"}</a>
      ${admin ? `<a class="lesson-pill ${page === "teachers" ? "active" : ""}" href="#/teacher/teachers">👩‍🏫 Учителя</a>` : ""}
      <a class="lesson-pill ${page === "account" ? "active" : ""}" href="#/teacher/account">⚙️ Аккаунт</a></nav>`);
    el.appendChild(head);
    el.appendChild(nav);
    const body = h(`<div><p class="muted">Загрузка…</p></div>`);
    el.appendChild(body);
    head.querySelector('[data-a="out"]').onclick = () => { setAuth(null); state.data = null; location.hash = "#/teacher"; rerender(); };

    const fail = (x) => { body.innerHTML = `<p class="t-bad">Не удалось загрузить: ${esc(x.message)}.</p><p class="small muted">Попробуйте «↻ Обновить». Если ошибка повторяется — пришлите её текст.</p>`; };
    const load = async () => {
      try {
        if (page === "classes") return await classesPage(body, admin);
        if (page === "teachers") return await teachersPage(body);
        if (page === "account") return accountPage(body, admin);
        const j = await api("summary");
        if (!j.ok) { body.innerHTML = `<p class="t-bad">${esc(j.error)}</p>`; return; }
        state.data = j;
        if (page === "student") await renderStudent(C, body, sub);
        else {
          if (!admin && !j.students.length) {
            const m = await api("me");
            if (m.ok && !m.groups.length) { body.innerHTML = ""; body.appendChild(h(`<div class="card t-empty"><h2>Начните с класса</h2>
              <p>Создайте класс — сайт выдаст код и ссылку-приглашение. Ученики вводят код при входе на сайт и сразу появляются в вашем журнале.</p>
              <a class="btn btn-primary" href="#/teacher/classes">Создать класс →</a></div>`)); return; }
          }
          renderAll(C, body, admin);
        }
      } catch (x) { console.error(x); fail(x); }
    };
    head.querySelector('[data-a="reload"]').onclick = load;
    if (state.data && page === "journal") renderAll(C, body, admin);
    load();
    if (page === "journal") state.timer = setInterval(() => { if (location.hash.replace(/\/$/, "") === "#/teacher" && document.visibilityState === "visible") load(); else clearInterval(state.timer); }, 60000);
    return el;
  }

  /* ---------------- классы ---------------- */
  async function classesPage(body, admin) {
    const j = await api("me");
    if (!j.ok) { body.innerHTML = `<p class="t-bad">${esc(j.error)}</p>`; return; }
    body.innerHTML = "";
    if (!admin) {
      const f = h(`<form class="card t-newclass"><h2 style="margin:0 0 6px">Новый класс</h2>
        <p class="small muted" style="margin:0 0 10px">Например: «11А», «10Б — информатика», «Подготовка к ЕНТ».</p>
        <div class="t-newclass-row"><input type="text" name="title" required maxlength="40" placeholder="Название класса"><button class="btn btn-primary">Создать</button></div>
        <div class="small t-bad t-err"></div></form>`);
      f.onsubmit = async (e) => {
        e.preventDefault();
        const btn = f.querySelector("button"); btn.disabled = true;
        try {
          const r = await api("createGroup", { title: f.title.value });
          if (!r.ok) { f.querySelector(".t-err").textContent = r.error; btn.disabled = false; return; }
          classesPage(body, admin);
        } catch (x) { f.querySelector(".t-err").textContent = x.message; btn.disabled = false; }
      };
      body.appendChild(f);
    }
    if (!j.groups.length) {
      body.appendChild(h(`<p class="muted">${admin ? "Учителя ещё не создали ни одного класса." : "Классов пока нет — создайте первый."}</p>`));
      return;
    }
    const grid = h(`<div class="grid-mods t-classes"></div>`);
    j.groups.forEach((g) => {
      const card = h(`<div class="card t-class">
        <div class="t-class-top"><h3>${esc(g.title)}</h3><span class="badge">${g.students} ${g.students % 10 === 1 && g.students % 100 !== 11 ? "ученик" : [2, 3, 4].includes(g.students % 10) && ![12, 13, 14].includes(g.students % 100) ? "ученика" : "учеников"}</span></div>
        <div class="small muted">Код класса</div><div class="t-code-big">${esc(g.code)}</div>
        <div class="t-link small"></div>
        <div class="btn-row"><button class="btn btn-lime btn-sm" data-a="link">Скопировать ссылку</button><button class="btn btn-ghost btn-sm" data-a="code">Скопировать код</button>
          <button class="btn btn-ghost btn-sm" data-a="del" title="Ученики останутся в журнале">Закрыть класс</button></div></div>`);
      card.querySelector(".t-link").textContent = joinLink(g.code);
      const copy = async (text, btn) => { try { await navigator.clipboard.writeText(text); btn.textContent = "Скопировано ✓"; } catch (x) { prompt("Скопируйте:", text); } };
      card.querySelector('[data-a="link"]').onclick = (e) => copy(joinLink(g.code), e.target);
      card.querySelector('[data-a="code"]').onclick = (e) => copy(g.code, e.target);
      card.querySelector('[data-a="del"]').onclick = async () => {
        if (!confirm(`Закрыть класс «${g.title}»? По коду ${g.code} больше нельзя будет вступить. Ученики и их история останутся в журнале.`)) return;
        const r = await api("deleteGroup", { code: g.code });
        if (!r.ok) alert(r.error); else classesPage(body, admin);
      };
      grid.appendChild(card);
    });
    body.appendChild(grid);
    body.appendChild(h(`<div class="note"><div class="note-title">Как пригласить учеников</div>
      <p>Отправьте ученикам <b>ссылку</b> (например, в чат класса) — при входе на сайт код подставится сам. Или продиктуйте <b>код</b>: его вводят в поле «Код класса» при первом входе либо позже через «Ввести код класса» в меню сайта.</p></div>`));
  }

  /* ---------------- учителя (администратор) ---------------- */
  async function teachersPage(body) {
    const j = await api("teachers");
    if (!j.ok) { body.innerHTML = `<p class="t-bad">${esc(j.error)}</p>`; return; }
    body.innerHTML = "";
    body.appendChild(h(`<div class="stats ep-stats" style="margin-bottom:16px">
      <div class="stat hl"><b>${j.teachers.length}</b><span>учителей</span></div>
      <div class="stat"><b>${j.teachers.reduce((a, t) => a + t.students, 0)}</b><span>учеников в классах</span></div>
      <div class="stat"><b>${j.unassigned}</b><span>учеников без класса</span></div></div>`));
    if (!j.teachers.length) { body.appendChild(h(`<p class="muted">Пока никто не зарегистрировался.</p>`)); return; }
    const tbl = h(`<div class="t-table-wrap card" style="padding:0"><table class="t-table"><thead><tr>
      <th>Учитель</th><th>Школа</th><th>Логин</th><th>Классов</th><th>Учеников</th><th>Последний вход</th><th>Статус</th><th></th></tr></thead><tbody></tbody></table></div>`);
    j.teachers.forEach((t) => {
      const tr = h(`<tr><td><b>${esc(t.name)}</b></td><td>${esc(t.school)}</td><td>${esc(t.login)}</td><td>${t.groups}</td><td>${t.students}</td>
        <td class="nowrap">${when(t.last)}</td><td>${t.active ? '<span class="tl-badge good">активен</span>' : '<span class="tl-badge bad">отключён</span>'}</td>
        <td class="nowrap"><button class="btn btn-ghost btn-sm" data-a="reset">Сбросить пароль</button> <button class="btn btn-ghost btn-sm" data-a="toggle">${t.active ? "Отключить" : "Включить"}</button></td></tr>`);
      tr.querySelector('[data-a="reset"]').onclick = async () => {
        if (!confirm(`Сбросить пароль учителя ${t.name}? Старый пароль перестанет работать.`)) return;
        const r = await api("resetPassword", { id: t.id });
        if (!r.ok) { alert(r.error); return; }
        prompt(`Новый пароль для ${t.name} (логин ${t.login}). Передайте его учителю — он сможет сменить его в разделе «Аккаунт»:`, r.password);
      };
      tr.querySelector('[data-a="toggle"]').onclick = async () => {
        if (t.active && !confirm(`Отключить аккаунт ${t.name}? Учитель не сможет войти, его ученики останутся в журнале.`)) return;
        const r = await api("setActive", { id: t.id, active: !t.active });
        if (!r.ok) alert(r.error); else teachersPage(body);
      };
      tbl.querySelector("tbody").appendChild(tr);
    });
    body.appendChild(tbl);
  }

  /* ---------------- аккаунт ---------------- */
  function accountPage(body, admin) {
    const me = (getAuth() || {}).me || {};
    body.innerHTML = "";
    body.appendChild(h(`<div class="card" style="margin-bottom:14px"><h2 style="margin:0 0 6px;text-transform:none">${esc(me.name || "")}</h2>
      <p class="small muted" style="margin:0">${admin ? "Администратор сайта" : `Логин: <b>${esc(me.login)}</b>${me.school ? ` · ${esc(me.school)}` : ""}`}</p></div>`));
    if (admin) { body.appendChild(h(`<p class="muted small">Пароль администратора меняется в скрипте таблицы (строка ADMIN_KEY) с выпуском новой версии.</p>`)); return; }
    const f = h(`<form class="card t-auth-form" style="max-width:460px"><h2 style="margin:0 0 8px">Сменить пароль</h2>
      <label class="t-field">Текущий пароль<input type="password" name="old" required autocomplete="current-password"></label>
      <label class="t-field">Новый пароль<input type="password" name="password" required minlength="6" autocomplete="new-password"></label>
      <label class="t-field">Повторите новый пароль<input type="password" name="password2" required minlength="6" autocomplete="new-password"></label>
      <button class="btn btn-primary">Сохранить</button><div class="small t-err"></div></form>`);
    f.onsubmit = async (e) => {
      e.preventDefault();
      const err = f.querySelector(".t-err");
      if (f.password.value !== f.password2.value) { err.className = "small t-err t-bad"; err.textContent = "Пароли не совпадают"; return; }
      try {
        const r = await api("changePassword", { old: f.old.value, password: f.password.value });
        err.className = "small t-err " + (r.ok ? "t-ok" : "t-bad");
        err.textContent = r.ok ? "Пароль изменён ✓" : r.error;
        if (r.ok) f.reset();
      } catch (x) { err.className = "small t-err t-bad"; err.textContent = x.message; }
    };
    body.appendChild(f);
  }

  // Google-таблица превращала результат «1/5» в дату. Восстанавливаем такие старые записи:
  // число пройденных тестов не больше общего, поэтому берём меньшее из «день / месяц».
  function fixScore(s) {
    s = String(s ?? "");
    if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
      const d = new Date(s);
      const a = d.getDate(), b = d.getMonth() + 1;
      return `${Math.min(a, b)} из ${Math.max(a, b)}`;
    }
    return s.replace(/^(\d+)\/(\d+)$/, "$1 из $2");
  }

  function resultBadge(e) {
    if (e.type === "check") {
      if (ok(e.ok)) return `<span class="tl-badge good">✓ решено</span>`;
      const sc = fixScore(e.score);
      return `<span class="tl-badge bad">✗ ${esc(sc)}${sc ? " тестов" : ""}</span>`;
    }
    if (e.type === "quiz") return `<span class="tl-badge ${ok(e.ok) ? "good" : "bad"}">${esc(e.score)}% · ${ok(e.ok) ? "сдан" : "не сдан"}</span>`;
    if (e.type === "lesson") return `<span class="tl-badge good">✓ изучен</span>`;
    return "";
  }

  // Подряд идущие одинаковые действия одного ученика (например, 5 неудачных проверок одной задачи) — одной строкой
  function compact(list) {
    const out = [];
    for (const e of list) {
      const p = out[out.length - 1];
      if (p && p.sid === e.sid && p.type === e.type && p.module === e.module && p.item === e.item && String(p.ok) === String(e.ok) && e.type !== "quiz") {
        p.times = (p.times || 1) + 1;
        continue;
      }
      out.push(Object.assign({}, e));
    }
    return out;
  }

  function eventLine(C, e, withName) {
    const [ic, label] = TYPE[e.type] || ["•", e.type];
    const what = e.type === "check" ? `Задача «${esc(e.title)}»` : e.type === "quiz" ? esc(e.title || "Тест") : e.type === "lesson" ? `Урок «${esc(e.title)}»` : esc(e.title || label);
    return `<div class="tl-row ev-${esc(e.type)}">
      <span class="tl-time">${when(e.ts || e.at)}</span>
      <div class="tl-body">
        ${withName ? `<div class="tl-who"><a href="#/teacher/${encodeURIComponent(e.sid)}"><b>${esc(e.name)}</b></a> <span class="tl-cls">${esc(state.data && state.data.students ? clsOf(state.data.students.find((x) => x.sid === e.sid) || e) : e.cls)}</span></div>` : ""}
        <div class="tl-what"><span class="tl-ic">${ic}</span> ${what}${e.times > 1 ? ` <span class="tl-times">× ${e.times} ${e.times < 5 ? "попытки" : "попыток"}</span>` : ""}</div>
        <div class="tl-meta">${e.module ? esc(modTitle(C, e.module)) : label}${e.detail ? ` · ${esc(e.detail)}` : ""}</div>
      </div>
      <span class="tl-res">${resultBadge(e)}</span></div>`;
  }

  // класс ученика: название класса учителя, а если ученик не вступил ни в один — то, что он сам написал при входе
  const clsOf = (s) => s.groupTitle || (s.cls ? `${s.cls} (без класса)` : "без класса");

  function renderAll(C, body, admin) {
    const { students, events } = state.data;
    const bySid = {};
    students.forEach((s) => (bySid[s.sid] = s));
    const classes = [...new Set(students.map(clsOf))].sort();
    const q = state.search.toLowerCase();
    let list = students.filter((s) => (!state.filterCls || clsOf(s) === state.filterCls) && (!q || String(s.name).toLowerCase().includes(q)));
    const sorters = { last: (a, b) => new Date(b.last) - new Date(a.last), name: (a, b) => String(a.name).localeCompare(String(b.name), "ru"), pct: (a, b) => b.pct - a.pct };
    list.sort(sorters[state.sort]);
    const ready = C.modules.filter((m) => m.status !== "soon");
    const dayAgo = Date.now() - 86400000;
    const activeToday = students.filter((s) => new Date(s.last) > dayAgo).length;
    const avg = students.length ? Math.round(students.reduce((a, s) => a + (Number(s.pct) || 0), 0) / students.length) : 0;

    body.innerHTML = "";
    body.appendChild(h(`<div class="stats ep-stats" style="margin-bottom:16px">
      <div class="stat hl"><b>${students.length}</b><span>учеников</span></div>
      <div class="stat"><b>${activeToday}</b><span>активны за 24 часа</span></div>
      <div class="stat"><b>${avg}%</b><span>средний прогресс</span></div>
      <div class="stat"><b>${events.filter((e) => e.type === "check" && ok(e.ok)).length}</b><span>задач решено (в ленте)</span></div></div>`));

    const tools = h(`<div class="t-tools">
      <select data-f="cls"><option value="">Все классы</option>${classes.map((c) => `<option ${c === state.filterCls ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
      <input type="text" data-f="q" placeholder="Поиск по имени" value="${esc(state.search)}">
      <select data-f="sort"><option value="last" ${state.sort === "last" ? "selected" : ""}>Сначала активные</option><option value="name" ${state.sort === "name" ? "selected" : ""}>По алфавиту</option><option value="pct" ${state.sort === "pct" ? "selected" : ""}>По прогрессу</option></select></div>`);
    tools.querySelector('[data-f="cls"]').onchange = (e) => { state.filterCls = e.target.value; renderAll(C, body, admin); };
    tools.querySelector('[data-f="sort"]').onchange = (e) => { state.sort = e.target.value; renderAll(C, body, admin); };
    tools.querySelector('[data-f="q"]').oninput = (e) => { state.search = e.target.value; clearTimeout(state.st); state.st = setTimeout(() => { renderAll(C, body, admin); const i = body.querySelector('[data-f="q"]'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 250); };
    body.appendChild(tools);

    if (!students.length) {
      body.appendChild(h(`<div class="card"><p style="margin:0">${admin ? "Пока никто не входил." : "В ваших классах пока нет учеников. Отправьте им ссылку или код из раздела «Мои классы» — после входа на сайт они появятся здесь."}</p></div>`));
    } else {
      const tbl = h(`<div class="t-table-wrap card" style="padding:0"><table class="t-table"><thead><tr>
        <th>Ученик</th><th>Класс</th><th>Прогресс</th><th>Уроки</th><th>Задачи</th><th>Отработка</th><th>Тесты</th>
        ${ready.map((m, i) => `<th title="${esc(m.title)}">М${C.modules.indexOf(m) + 1}</th>`).join("")}<th>Активность</th></tr></thead><tbody></tbody></table></div>`);
      const tb = tbl.querySelector("tbody");
      list.forEach((s) => {
        const cells = ready.map((m) => {
          const v = s.mods && s.mods[m.id] != null ? Number(s.mods[m.id]) : 0;
          return `<td class="t-heat" style="--v:${v}" title="${esc(m.title)}: ${v}%">${v ? v : "·"}</td>`;
        }).join("");
        const tr = h(`<tr data-sid="${esc(s.sid)}"><td><a href="#/teacher/${encodeURIComponent(s.sid)}"><b>${esc(s.name)}</b></a></td><td>${esc(clsOf(s))}</td>
          <td><div class="t-pct"><div class="bar"><span style="width:${Number(s.pct) || 0}%"></span></div><b>${Number(s.pct) || 0}%</b></div></td>
          <td>${s.lessons}</td><td>${s.tasks}</td><td>${s.extra}</td><td>${s.quizzes}</td>${cells}<td class="nowrap">${when(s.last)}</td></tr>`);
        tr.onclick = (e) => { if (!e.target.closest("a")) location.hash = `#/teacher/${encodeURIComponent(s.sid)}`; };
        tb.appendChild(tr);
      });
      body.appendChild(tbl);
      body.appendChild(h(`<p class="small muted">М1, М2… — процент прохождения модуля (уроки, задачи, отработка и тест). Нажмите на ученика, чтобы открыть всю его историю.</p>`));
    }

    const feed = h(`<div class="card"><div class="t-feed-head"><h2 style="margin:0">Лента действий</h2>
      <label class="small"><input type="checkbox" ${state.showOpens ? "checked" : ""}> показывать открытия страниц</label></div><div class="tl"></div></div>`);
    feed.querySelector("input").onchange = (e) => { state.showOpens = e.target.checked; renderAll(C, body, admin); };
    const evs = compact(events.filter((e) => (state.showOpens || e.type !== "open") && (!state.filterCls || (bySid[e.sid] && clsOf(bySid[e.sid]) === state.filterCls)))).slice(0, 150);
    feed.querySelector(".tl").innerHTML = evs.length ? evs.map((e) => eventLine(C, e, true)).join("") : `<p class="muted">Пока пусто.</p>`;
    body.appendChild(h(`<h2>Последние действия</h2>`));
    body.appendChild(feed);
  }

  async function renderStudent(C, body, sid) {
    const s = state.data.students.find((x) => x.sid === sid);
    if (!s) { body.innerHTML = `<p>Ученик не найден.</p>`; return; }
    let events, warn = "";
    try {
      const j = await api("student", { sid });
      if (!j.ok) throw new Error(j.error || "ошибка скрипта");
      events = j.events || [];
    } catch (x) {
      // запасной вариант: последние события из общей ленты (без кода решений)
      events = (state.data.events || []).filter((e) => e.sid === sid).map((e) => Object.assign({}, e, { code: "" }));
      warn = `Полную историю загрузить не удалось (${x.message}). Показаны только последние действия из общей ленты, без кода и ответов.`;
    }
    const checks = events.filter((e) => e.type === "check");
    const quizzes = events.filter((e) => e.type === "quiz");
    const solvedSet = new Set(checks.filter((e) => ok(e.ok)).map((e) => e.module + "." + e.item));
    const tries = checks.length;

    body.innerHTML = "";
    if (warn) body.appendChild(h(`<div class="note warn" style="margin-bottom:14px"><div class="note-title">Не всё загрузилось</div><p>${esc(warn)}</p></div>`));
    body.appendChild(h(`<div class="card" style="margin-bottom:14px"><h2 style="margin:0 0 4px;text-transform:none">${esc(s.name)} <span class="muted" style="font-weight:500">${esc(clsOf(s))}</span></h2>
      <p class="small muted" style="margin:0">Первый вход: ${when(s.first)} · последняя активность: ${when(s.last)} · действий: ${s.actions}</p>
      <div class="t-pin" style="margin-top:10px"><button class="btn btn-ghost btn-sm" data-a="pin">🔑 Сбросить PIN ученика</button>
        <span class="small muted">— если ученик забыл PIN и не может войти</span></div></div>`));
    body.querySelector('[data-a="pin"]').onclick = async (e) => {
      if (!confirm(`Выдать ученику «${s.name}» новый PIN? Старый PIN перестанет работать.`)) return;
      e.target.disabled = true;
      try {
        const r = await api("resetPin", { sid });
        if (!r.ok) throw new Error(r.error || "ошибка скрипта");
        body.querySelector(".t-pin").innerHTML = `<div class="note"><div class="note-title">Новый PIN: <span style="font-size:1.4em;letter-spacing:.15em">${esc(r.pin)}</span></div>
          <p class="small" style="margin:6px 0 0">Передайте ученику. На сайте он нажимает вкладку «Вход» и вводит:
          имя <b>${esc(r.name)}</b>, класс <b>${esc(r.cls)}</b>, PIN <b>${esc(r.pin)}</b>. Весь прогресс вернётся.</p></div>`;
      } catch (x) { alert("Не удалось сбросить PIN: " + x.message); e.target.disabled = false; }
    };
    body.appendChild(h(`<div class="stats ep-stats" style="margin-bottom:16px">
      <div class="stat hl"><b>${Number(s.pct) || 0}%</b><span>общий прогресс</span></div>
      <div class="stat"><b>${s.lessons}</b><span>уроков изучено</span></div>
      <div class="stat"><b>${s.tasks} + ${s.extra}</b><span>задач решено (основные + отработка)</span></div>
      <div class="stat"><b>${tries}</b><span>проверок решений${tries ? `, успешных ${Math.round(checks.filter((e) => ok(e.ok)).length / tries * 100)}%` : ""}</span></div>
      <div class="stat"><b>${s.quizzes}</b><span>тестов сдано</span></div></div>`));

    const mods = h(`<div class="card" style="margin-bottom:14px"><h2 style="margin-top:0">По модулям</h2><div class="t-mods"></div></div>`);
    C.modules.filter((m) => m.status !== "soon").forEach((m) => {
      const v = s.mods && s.mods[m.id] != null ? Number(s.mods[m.id]) : 0;
      const mine = quizzes.filter((e) => e.module === m.id);
      const qz = mine.filter((e) => !String(e.item).includes(":bank"));
      const tr = mine.filter((e) => String(e.item).includes(":bank"));
      const best = qz.length ? Math.max(...qz.map((e) => Number(e.score) || 0)) : null;
      const trBest = tr.length ? Math.max(...tr.map((e) => Number(e.score) || 0)) : null;
      mods.querySelector(".t-mods").appendChild(h(`<div class="t-mod"><div class="small"><b>${esc(modTitle(C, m.id))}</b></div>
        <div class="t-pct"><div class="bar"><span style="width:${v}%"></span></div><b>${v}%</b></div>
        <div class="small muted">${best != null ? `тест: лучший ${best}%, попыток ${qz.length}` : "тест не начат"}${trBest != null ? ` · тренажёр: лучший ${trBest}%, попыток ${tr.length}` : ""}</div></div>`));
    });
    body.appendChild(mods);

    // ---------- вкладки: задачи / тесты / история ----------
    const tabs = [
      ["tasks", `💻 Задачи <span class="count">${new Set(checks.map((e) => e.module + "." + e.item)).size}</span>`],
      ["tests", `📝 Тесты <span class="count">${quizzes.length}</span>`],
      ["history", "🕘 История"],
    ];
    const nav = h(`<div class="lesson-nav t-tabs">${tabs.map(([k, l]) => `<button type="button" class="lesson-pill" data-tab="${k}">${l}</button>`).join("")}</div>`);
    const pane = h(`<div></div>`);
    body.appendChild(nav);
    body.appendChild(pane);
    const show = (k) => {
      state.studentTab = k;
      nav.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.tab === k));
      pane.innerHTML = "";
      ({ tasks: tasksPane, tests: testsPane, history: historyPane })[k](C, pane, events, checks, quizzes);
    };
    nav.querySelectorAll("button").forEach((b) => (b.onclick = () => show(b.dataset.tab)));
    show(state.studentTab || "tasks");
  }

  const codeBox = (code) => {
    const pre = document.createElement("pre");
    pre.className = "t-pre";
    pre.textContent = code;
    return pre;
  };

  /* Задачи: по модулям, по каждой задаче — статус, число попыток, код каждой попытки */
  function tasksPane(C, pane, events, checks) {
    if (!checks.length) { pane.appendChild(h(`<div class="card"><p style="margin:0">Ученик ещё не отправлял решения на проверку.</p></div>`)); return; }
    const byTask = new Map();
    checks.forEach((e) => {   // события идут от новых к старым
      const k = e.module + "." + e.item;
      if (!byTask.has(k)) byTask.set(k, { module: e.module, item: e.item, title: e.title, list: [] });
      byTask.get(k).list.push(e);
    });
    const hard = [...byTask.values()].filter((t) => t.list.filter((e) => !ok(e.ok)).length >= 3);
    if (hard.length) {
      pane.appendChild(h(`<div class="note warn" style="margin-bottom:14px"><div class="note-title">Где трудно</div>
        ${hard.map((t) => `<div>• ${esc(t.title)} — ${t.list.filter((e) => !ok(e.ok)).length} неудачных проверок, ${t.list.some((e) => ok(e.ok)) ? "в итоге решено" : "<b>не решено</b>"}</div>`).join("")}</div>`));
    }
    const order = (mid) => C.modules.findIndex((m) => m.id === mid);
    const groups = {};
    byTask.forEach((t) => (groups[t.module] = groups[t.module] || []).push(t));
    Object.keys(groups).sort((a, b) => order(a) - order(b)).forEach((mid) => {
      const card = h(`<div class="card" style="margin-bottom:14px"><h2 style="margin:0 0 8px;text-transform:none;font-size:17px">${esc(modTitle(C, mid))}</h2></div>`);
      groups[mid].forEach((t) => {
        const solved = t.list.some((e) => ok(e.ok));
        const last = t.list[0];
        const d = h(`<details class="t-task"><summary>
          <span class="t-task-title">${esc(t.title)}</span>
          <span class="t-task-meta">${t.list.length} ${t.list.length === 1 ? "проверка" : t.list.length < 5 ? "проверки" : "проверок"} · ${when(last.ts || last.at)}</span>
          <span class="tl-badge ${solved ? "good" : "bad"}">${solved ? "✓ решено" : "✗ не решено"}</span></summary><div class="t-attempts"></div></details>`);
        const box = d.querySelector(".t-attempts");
        t.list.forEach((e, i) => {
          const a = h(`<div class="t-attempt"><div class="t-attempt-head"><b>Попытка ${t.list.length - i}</b> · <span class="muted">${when(e.ts || e.at)}</span> ${resultBadge(e)}</div>
            ${e.detail ? `<div class="small muted">${esc(e.detail)}</div>` : ""}</div>`);
          if (e.code) a.appendChild(codeBox(e.code));
          box.appendChild(a);
        });
        card.appendChild(d);
      });
      pane.appendChild(card);
    });
  }

  /* Тесты: каждая попытка с ответами ученика на каждый вопрос */
  function testsPane(C, pane, events, checks, quizzes) {
    if (!quizzes.length) { pane.appendChild(h(`<div class="card"><p style="margin:0">Ученик ещё не сдавал тесты.</p></div>`)); return; }
    const top = h(`<label class="small t-only"><input type="checkbox" ${state.onlyWrong ? "checked" : ""}> показывать только вопросы с ошибками</label>`);
    pane.appendChild(top);
    const list = h(`<div></div>`);
    pane.appendChild(list);
    const draw = () => {
      list.innerHTML = "";
      quizzes.forEach((e, idx) => {
        let data = null;
        try { data = e.code ? JSON.parse(e.code) : null; } catch (x) { data = null; }
        const ans = data && data.answers;
        const d = h(`<details class="card t-quiz" ${idx === 0 ? "open" : ""}><summary>
          <span class="t-task-title">${esc(e.title || "Тест")}</span>
          <span class="t-task-meta">${esc(modTitle(C, e.module))} · ${when(e.ts || e.at)} · ${esc(e.detail || "")}</span>
          ${resultBadge(e)}</summary><div class="t-answers"></div></details>`);
        const box = d.querySelector(".t-answers");
        if (!ans) box.appendChild(h(`<p class="small muted">Ответы по вопросам не сохранялись: тест пройден до обновления журнала.</p>`));
        else {
          ans.forEach((r, i) => {
            if (state.onlyWrong && r.g === r.m) return;
            const cls = r.g === r.m ? "good" : r.g > 0 ? "part" : "bad";
            const mark = r.g === r.m ? "✓" : r.g > 0 ? "◐" : "✗";
            const q = h(`<div class="t-ans ${cls}"><div class="t-ans-head"><span class="t-ans-mark">${mark}</span> <b>Вопрос ${i + 1}</b> <span class="muted small">· ${r.g} из ${r.m} балл.</span></div>
              <div class="t-ans-q">${esc(r.q)}</div></div>`);
            if (r.code) q.appendChild(codeBox(r.code));
            const row = (label, val, kind) => {
              const el = h(`<div class="t-ans-row ${kind}"><span class="t-ans-label">${label}</span><span class="t-ans-val"></span></div>`);
              el.querySelector(".t-ans-val").textContent = val || "— (нет ответа)";
              return el;
            };
            q.appendChild(row("Ответ ученика:", r.a, cls));
            if (r.g !== r.m) q.appendChild(row("Правильно:", r.c, "good"));
            box.appendChild(q);
          });
          if (!box.children.length) box.appendChild(h(`<p class="small muted">Ошибок нет.</p>`));
        }
        list.appendChild(d);
      });
    };
    top.querySelector("input").onchange = (ev) => { state.onlyWrong = ev.target.checked; draw(); };
    draw();
  }

  /* История: все действия по времени */
  function historyPane(C, pane, events) {
    const tl = h(`<div class="card"><div class="t-feed-head"><h2 style="margin:0">Вся история</h2>
      <label class="small"><input type="checkbox" ${state.showOpens ? "checked" : ""}> показывать открытия страниц</label></div><div class="tl"></div></div>`);
    const draw = () => {
      const evs = events.filter((e) => state.showOpens || e.type !== "open");
      tl.querySelector(".tl").innerHTML = evs.length ? "" : `<p class="muted">Пока пусто.</p>`;
      evs.forEach((e) => {
        const row = h(eventLine(C, e, false));
        if (e.code && e.type === "check") {
          const d = h(`<details class="t-code"><summary class="small">код решения</summary></details>`);
          d.appendChild(codeBox(e.code));
          row.querySelector(".tl-body").appendChild(d);
        }
        tl.querySelector(".tl").appendChild(row);
      });
    };
    tl.querySelector("input").onchange = (e) => { state.showOpens = e.target.checked; draw(); };
    draw();
    pane.appendChild(tl);
  }

  window.EPTeacher = { view };
})();
