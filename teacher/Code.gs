/**
 * Easy Python PRO — серверная часть (Google Apps Script).
 *
 * Учителя регистрируются на сайте, создают классы и получают код класса.
 * Ученик вводит код (или открывает ссылку-приглашение) и попадает к учителю.
 * Каждый учитель видит только своих учеников; администратор — всех.
 *
 * Листы этой таблицы (создаются автоматически):
 *   «Учителя» — аккаунты учителей (пароли хранятся только в виде хэша с солью);
 *   «Классы»  — классы учителей и их коды;
 *   «Ученики» — по строке на ученика: учитель, класс, снимок прогресса;
 *   «События» — каждое действие ученика.
 *
 * Установка — teacher/НАСТРОЙКА.md. Обязательно поменяйте ADMIN_KEY.
 */

// Пароль администратора сайта (вход «Администратор» на странице учителя). Поменяйте на свой!
const ADMIN_KEY = "поменяйте-меня";

const EVENTS = "События";
const STUDENTS = "Ученики";
const TEACHERS = "Учителя";
const GROUPS = "Классы";
const EV_HEAD = ["Время (сервер)", "Время (ученик)", "ID ученика", "Ученик", "Класс", "Действие", "Модуль", "Элемент", "Название", "Успех", "Результат", "Подробности", "Код"];
const ST_HEAD = ["ID ученика", "Ученик", "Класс", "PIN (хэш)", "Первый вход", "Последняя активность", "Прогресс %", "Уроки", "Задачи", "Отработка", "Тесты", "Модули (JSON)", "Прогресс (JSON)", "Действий", "ID учителя", "Код класса"];
const TE_HEAD = ["ID учителя", "ФИО", "Школа", "Логин", "Соль", "Хэш пароля", "Создан", "Последний вход", "Активен"];
const GR_HEAD = ["Код класса", "ID учителя", "Название", "Создан", "Активен"];
const TOKEN_DAYS = 30;

/* ================================================================ таблица */
function sheet_(name, head) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(head);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, head.length).setFontWeight("bold");
  } else if (sh.getLastColumn() < head.length) {
    // лист из старой версии — дописываем новые заголовки справа
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight("bold");
  }
  return sh;
}

function rows_(sh, width) {
  const n = sh.getLastRow() - 1;
  return n > 0 ? sh.getRange(2, 1, n, width).getValues() : [];
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

const cut_ = (s, n) => (s == null ? "" : String(s).slice(0, n));
const norm_ = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ").replace(/ё/g, "е");
// апостроф — чтобы таблица не превратила текст (код, «2/5», хэш) в число или дату
const txt_ = (s) => (s == null || s === "" ? "" : "'" + String(s));

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ================================================================ безопасность */
function hex_(bytes) {
  return bytes.map((b) => ((b < 0 ? b + 256 : b).toString(16)).padStart(2, "0")).join("");
}

function secret_() {
  const props = PropertiesService.getScriptProperties();
  let s = props.getProperty("EP_SECRET");
  if (!s) {
    s = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty("EP_SECRET", s);
  }
  return s;
}

function hashPassword_(password, salt) {
  let h = String(password);
  for (let i = 0; i < 200; i++) h = hex_(Utilities.computeHmacSha256Signature(h, salt + ":" + i));
  return h;
}

function makeToken_(role, id) {
  const exp = Date.now() + TOKEN_DAYS * 86400000;
  const payload = role + "." + id + "." + exp;
  return payload + "." + hex_(Utilities.computeHmacSha256Signature(payload, secret_())).slice(0, 40);
}

// → { role: "teacher" | "admin", id } или null
function checkToken_(token) {
  const p = String(token || "").split(".");
  if (p.length !== 4) return null;
  const payload = p[0] + "." + p[1] + "." + p[2];
  const sig = hex_(Utilities.computeHmacSha256Signature(payload, secret_())).slice(0, 40);
  if (sig !== p[3] || Number(p[2]) < Date.now()) return null;
  if (p[0] === "teacher") {
    const t = findTeacher_((r) => r[0] === p[1]);
    if (!t || t.row[8] === "нет") return null;
    return { role: "teacher", id: p[1], teacher: t };
  }
  return p[0] === "admin" ? { role: "admin", id: "admin" } : null;
}

function newCode_(taken) {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // без похожих 0/O, 1/I
  for (;;) {
    let c = "";
    for (let i = 0; i < 6; i++) c += abc[Math.floor(Math.random() * abc.length)];
    if (!taken.has(c)) return c;
  }
}

function newPassword_() {
  const abc = "abcdefghjkmnpqrstuvwxyz23456789";
  let s = "";
  for (let i = 0; i < 8; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}

/* ================================================================ учителя и классы */
function findTeacher_(pred) {
  const sh = sheet_(TEACHERS, TE_HEAD);
  const rows = rows_(sh, TE_HEAD.length);
  for (let i = 0; i < rows.length; i++) if (pred(rows[i])) return { sh, index: i + 2, row: rows[i] };
  return null;
}

function teacherPublic_(r) {
  return { id: r[0], name: r[1], school: r[2], login: r[3], created: r[6], last: r[7], active: r[8] !== "нет" };
}

function groups_() {
  return rows_(sheet_(GROUPS, GR_HEAD), GR_HEAD.length)
    .filter((r) => r[0] && r[4] !== "нет")
    .map((r) => ({ code: String(r[0]), tid: String(r[1]), title: String(r[2]), created: r[3] }));
}

function groupByCode_(code) {
  code = String(code || "").trim().toUpperCase();
  return code ? groups_().find((g) => g.code === code) || null : null;
}

/* ================================================================ входные точки */
function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: "bad json" }); }
  try {
    if (body.action) return json_(api_(body));
    return json_(saveEvents_(body));
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function doGet(e) {
  const p = e.parameter || {};
  try {
    if (p.action === "restore") return json_(restore_(p));
    if (p.action === "exists") {
      const found = rows_(sheet_(STUDENTS, ST_HEAD), ST_HEAD.length).some((r) => r[0] && norm_(r[1]) === norm_(p.name) && norm_(r[2]) === norm_(p.cls));
      return json_({ ok: true, exists: found });
    }
    if (p.action === "group") {
      const g = groupByCode_(p.code);
      if (!g) return json_({ ok: false, error: "Класс с таким кодом не найден" });
      const t = findTeacher_((r) => r[0] === g.tid);
      return json_({ ok: true, code: g.code, title: g.title, teacher: t ? t.row[1] : "" });
    }
    return json_({ ok: true, hello: "Easy Python PRO" });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

/* ---------- API для страницы учителя (POST, JSON) ---------- */
function api_(b) {
  switch (b.action) {
    case "register": return register_(b);
    case "login": return login_(b);
  }
  const who = checkToken_(b.token);
  if (!who) return { ok: false, error: "Войдите заново", auth: false };
  switch (b.action) {
    case "me": return me_(who);
    case "createGroup": return createGroup_(who, b);
    case "deleteGroup": return deleteGroup_(who, b);
    case "summary": return summary_(who);
    case "student": return student_(who, b);
    case "changePassword": return changePassword_(who, b);
    case "resetPin": return resetPin_(who, b);
    case "teachers": return who.role === "admin" ? teachers_() : { ok: false, error: "Только для администратора" };
    case "resetPassword": return who.role === "admin" ? resetPassword_(b) : { ok: false, error: "Только для администратора" };
    case "setActive": return who.role === "admin" ? setActive_(b) : { ok: false, error: "Только для администратора" };
  }
  return { ok: false, error: "Неизвестное действие" };
}

function register_(b) {
  const name = cut_(String(b.name || "").trim(), 80), school = cut_(String(b.school || "").trim(), 120);
  const login = norm_(b.login).replace(/\s/g, "");
  const pw = String(b.password || "");
  if (name.length < 3) return { ok: false, error: "Укажите фамилию и имя" };
  if (!/^[a-z0-9._@-]{3,60}$/.test(login)) return { ok: false, error: "Логин: от 3 символов — латинские буквы, цифры, точка, @, дефис" };
  if (pw.length < 6) return { ok: false, error: "Пароль — не короче 6 символов" };
  return withLock_(() => {
    if (findTeacher_((r) => norm_(r[3]) === login)) return { ok: false, error: "Такой логин уже занят" };
    const id = "t" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
    const salt = Utilities.getUuid();
    const now = new Date();
    sheet_(TEACHERS, TE_HEAD).appendRow([id, name, school, login, salt, txt_(hashPassword_(pw, salt)), now, now, "да"]);
    return { ok: true, token: makeToken_("teacher", id), me: { role: "teacher", id, name, school, login } };
  });
}

function login_(b) {
  if (b.key != null) {
    if (String(b.key) !== ADMIN_KEY || ADMIN_KEY === "поменяйте-меня") return { ok: false, error: "Неверный пароль администратора" };
    return { ok: true, token: makeToken_("admin", "admin"), me: { role: "admin", id: "admin", name: "Администратор" } };
  }
  const login = norm_(b.login).replace(/\s/g, "");
  const t = findTeacher_((r) => norm_(r[3]) === login);
  if (!t || hashPassword_(String(b.password || ""), t.row[4]) !== String(t.row[5])) return { ok: false, error: "Неверный логин или пароль" };
  if (t.row[8] === "нет") return { ok: false, error: "Аккаунт отключён администратором" };
  t.sh.getRange(t.index, 8).setValue(new Date());
  return { ok: true, token: makeToken_("teacher", t.row[0]), me: Object.assign({ role: "teacher" }, teacherPublic_(t.row)) };
}

function me_(who) {
  const counts = {};
  rows_(sheet_(STUDENTS, ST_HEAD), ST_HEAD.length).forEach((r) => { const c = String(r[15] || ""); if (c) counts[c] = (counts[c] || 0) + 1; });
  const gs = groups_().filter((g) => who.role === "admin" || g.tid === who.id).map((g) => Object.assign(g, { students: counts[g.code] || 0 }));
  const me = who.role === "admin" ? { role: "admin", id: "admin", name: "Администратор" } : Object.assign({ role: "teacher" }, teacherPublic_(who.teacher.row));
  return { ok: true, me, groups: gs };
}

function createGroup_(who, b) {
  if (who.role !== "teacher") return { ok: false, error: "Классы создаёт учитель (войдите как учитель)" };
  const title = cut_(String(b.title || "").trim(), 40);
  if (!title) return { ok: false, error: "Укажите название класса, например 11А" };
  return withLock_(() => {
    const taken = new Set(rows_(sheet_(GROUPS, GR_HEAD), 1).map((r) => String(r[0])));
    const code = newCode_(taken);
    sheet_(GROUPS, GR_HEAD).appendRow([code, who.id, title, new Date(), "да"]);
    return { ok: true, group: { code, tid: who.id, title, students: 0 } };
  });
}

function deleteGroup_(who, b) {
  return withLock_(() => {
    const sh = sheet_(GROUPS, GR_HEAD);
    const rows = rows_(sh, GR_HEAD.length);
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][0]) === String(b.code) && (who.role === "admin" || String(rows[i][1]) === who.id)) {
        sh.getRange(i + 2, 5).setValue("нет");   // ученики остаются, но в класс больше нельзя вступить
        return { ok: true };
      }
    }
    return { ok: false, error: "Класс не найден" };
  });
}

function changePassword_(who, b) {
  if (who.role !== "teacher") return { ok: false, error: "Пароль администратора меняется в скрипте (ADMIN_KEY)" };
  const t = who.teacher;
  if (hashPassword_(String(b.old || ""), t.row[4]) !== String(t.row[5])) return { ok: false, error: "Текущий пароль неверен" };
  if (String(b.password || "").length < 6) return { ok: false, error: "Новый пароль — не короче 6 символов" };
  const salt = Utilities.getUuid();
  t.sh.getRange(t.index, 5, 1, 2).setValues([[salt, txt_(hashPassword_(String(b.password), salt))]]);
  return { ok: true };
}

function teachers_() {
  const st = rows_(sheet_(STUDENTS, ST_HEAD), ST_HEAD.length);
  const gs = groups_();
  const list = rows_(sheet_(TEACHERS, TE_HEAD), TE_HEAD.length).map((r) => Object.assign(teacherPublic_(r), {
    groups: gs.filter((g) => g.tid === r[0]).length,
    students: st.filter((s) => String(s[14]) === String(r[0])).length,
  }));
  return { ok: true, teachers: list, unassigned: st.filter((s) => !s[14]).length };
}

function resetPassword_(b) {
  const t = findTeacher_((r) => r[0] === b.id);
  if (!t) return { ok: false, error: "Учитель не найден" };
  const pw = newPassword_(), salt = Utilities.getUuid();
  t.sh.getRange(t.index, 5, 1, 2).setValues([[salt, txt_(hashPassword_(pw, salt))]]);
  return { ok: true, password: pw };
}

function setActive_(b) {
  const t = findTeacher_((r) => r[0] === b.id);
  if (!t) return { ok: false, error: "Учитель не найден" };
  t.sh.getRange(t.index, 9).setValue(b.active ? "да" : "нет");
  return { ok: true };
}

/* ---------- приём событий от учеников ---------- */
function saveEvents_(body) {
  const st = body.student || {};
  if (!st.sid || !st.name) return { ok: false, error: "no student" };
  return withLock_(() => {
    const now = new Date();
    const events = (body.events || []).slice(0, 200);
    if (events.length) {
      const rows = events.map((ev) => [
        now, cut_(ev.ts, 40), cut_(ev.sid || st.sid, 40), cut_(ev.name || st.name, 80), cut_(ev.cls || st.cls, 20),
        cut_(ev.type, 20), cut_(ev.module, 20), txt_(cut_(ev.item, 60)), cut_(ev.title, 200),
        ev.ok === true ? "да" : ev.ok === false ? "нет" : "", txt_(cut_(ev.score, 40)), cut_(ev.detail, 1000), txt_(cut_(ev.code, 20000)),
      ]);
      const sh = sheet_(EVENTS, EV_HEAD);
      sh.getRange(sh.getLastRow() + 1, 1, rows.length, EV_HEAD.length).setValues(rows);
    }
    const g = groupByCode_(st.group);
    const merged = upsertStudent_(st, g, body.snapshot, body.progress, events.filter((ev) => !ev.sid || ev.sid === st.sid).length, now, body.progressReset);
    // если на других устройствах ученик успел больше — вернём общий прогресс
    return { ok: true, group: g ? { code: g.code, title: g.title } : null, progress: merged };
  });
}

/* ---------- прогресс с нескольких устройств: объединяем, ничего не теряя ---------- */
function mergeProgress_(a, b) {
  a = a || {}; b = b || {};
  const out = {};
  ["lessons", "tasks"].forEach((k) => {
    out[k] = Object.assign({}, a[k] || {});
    Object.keys(b[k] || {}).forEach((x) => { if (b[k][x]) out[k][x] = b[k][x]; });
  });
  out.fails = Object.assign({}, a.fails || {});
  Object.keys(b.fails || {}).forEach((x) => { out.fails[x] = Math.max(Number(out.fails[x]) || 0, Number(b.fails[x]) || 0); });
  out.quiz = Object.assign({}, a.quiz || {});
  Object.keys(b.quiz || {}).forEach((x) => {
    const p = out.quiz[x], q = b.quiz[x];
    if (!p) { out.quiz[x] = q; return; }
    const top = (Number(q.best) || 0) > (Number(p.best) || 0) ? q : p;
    out.quiz[x] = Object.assign({}, top, {
      best: Math.max(Number(p.best) || 0, Number(q.best) || 0),
      attempts: Math.max(Number(p.attempts) || 0, Number(q.attempts) || 0),
      passed: !!(p.passed || q.passed),
    });
  });
  return out;
}

// → объединённый прогресс, если он отличается от присланного (иначе null)
function upsertStudent_(st, g, snap, progress, nEvents, now, reset) {
  const sh = sheet_(STUDENTS, ST_HEAD);
  const ids = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map((r) => r[0]) : [];
  const i = ids.indexOf(st.sid);
  const s = snap || {};
  const prev = i >= 0 ? sh.getRange(i + 2, 1, 1, ST_HEAD.length).getValues()[0] : null;
  let merged = null;
  if (progress && prev && prev[12] && !reset) {
    const m = mergeProgress_(progress, safeParse_(prev[12], {}));
    if (JSON.stringify(m) !== JSON.stringify(mergeProgress_(progress, {}))) merged = m;
    progress = m;
  }
  const row = [
    st.sid, cut_(st.name, 80), cut_(st.cls, 20), // PIN из таблицы главнее: его мог сбросить учитель, а старое устройство ученика помнит прежний
    (prev && prev[3] ? txt_(prev[3]) : txt_(st.pin)),
    prev ? prev[4] : now, now,
    s.pct != null ? s.pct : prev ? prev[6] : 0,
    s.lessons != null ? s.lessons : prev ? prev[7] : 0,
    s.tasks != null ? s.tasks : prev ? prev[8] : 0,
    s.extra != null ? s.extra : prev ? prev[9] : 0,
    s.quizzes != null ? s.quizzes : prev ? prev[10] : 0,
    s.mods ? cut_(JSON.stringify(s.mods), 20000) : prev ? prev[11] : "{}",
    progress ? cut_(JSON.stringify(progress), 49000) : prev ? prev[12] : "",
    (prev ? Number(prev[13]) || 0 : 0) + nEvents,
    // учитель и класс: новый верный код класса переводит ученика, иначе остаётся прежний
    g ? g.tid : prev ? prev[14] : "",
    g ? g.code : prev ? prev[15] : "",
  ];
  if (i >= 0) sh.getRange(i + 2, 1, 1, ST_HEAD.length).setValues([row]);
  else sh.appendRow(row);
  return merged;
}

/* ---------- чтение для учителя ---------- */
function visibleStudents_(who) {
  const titles = {};
  groups_().forEach((g) => (titles[g.code] = g.title));
  return rows_(sheet_(STUDENTS, ST_HEAD), ST_HEAD.length)
    .filter((r) => r[0] && (who.role === "admin" || String(r[14]) === who.id))
    .map((r) => ({
      sid: r[0], name: r[1], cls: r[2], first: r[4], last: r[5], pct: r[6], lessons: r[7], tasks: r[8], extra: r[9], quizzes: r[10],
      mods: safeParse_(r[11], {}), actions: r[13], tid: r[14], group: String(r[15] || ""), groupTitle: titles[String(r[15] || "")] || "",
    }));
}

function summary_(who) {
  const students = visibleStudents_(who);
  const sids = new Set(students.map((s) => s.sid));
  return { ok: true, students, events: lastEvents_(400, (sid) => sids.has(sid), false) };
}

function student_(who, b) {
  const s = visibleStudents_(who).find((x) => x.sid === b.sid);
  if (!s) return { ok: false, error: "Этот ученик не в ваших классах" };
  return { ok: true, events: lastEvents_(2000, (sid) => sid === b.sid, true) };
}

function lastEvents_(limit, allow, withCode) {
  const sh = sheet_(EVENTS, EV_HEAD);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  const take = Math.min(n, 20000);
  const rows = sh.getRange(n + 1 - take + 1, 1, take, EV_HEAD.length).getValues();
  const out = [];
  for (let k = rows.length - 1; k >= 0 && out.length < limit; k--) {
    const r = rows[k];
    if (!allow(r[2])) continue;
    out.push({ at: r[0], ts: r[1], sid: r[2], name: r[3], cls: r[4], type: r[5], module: r[6], item: r[7], title: r[8], ok: r[9], score: r[10], detail: r[11], code: withCode ? r[12] : (r[12] ? "1" : "") });
  }
  return out;
}

/* ---------- учитель сбрасывает PIN ученика ---------- */
// Хэш считается так же, как на сайте (tracker.js → pinHash): SHA-256 от "ep|имя|класс|PIN".
function pinHash_(name, cls, pin) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, "ep|" + norm_(name) + "|" + norm_(cls) + "|" + pin, Utilities.Charset.UTF_8);
  return hex_(bytes);
}

function resetPin_(who, b) {
  if (!visibleStudents_(who).some((x) => x.sid === b.sid)) return { ok: false, error: "Этот ученик не в ваших классах" };
  return withLock_(() => {
    const sh = sheet_(STUDENTS, ST_HEAD);
    const ids = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map((r) => r[0]);
    const i = ids.indexOf(b.sid);
    if (i < 0) return { ok: false, error: "Ученик не найден" };
    const r = sh.getRange(i + 2, 1, 1, 3).getValues()[0];
    const pin = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
    sh.getRange(i + 2, 4).setValue(txt_(pinHash_(r[1], r[2], pin)));
    return { ok: true, pin, name: r[1], cls: r[2] };
  });
}

/* ---------- восстановление прогресса ученика ---------- */
function restore_(p) {
  if (!p.pin) return { ok: false, error: "Ученик не найден" };
  const rows = rows_(sheet_(STUDENTS, ST_HEAD), ST_HEAD.length);
  for (let k = rows.length - 1; k >= 0; k--) {
    const r = rows[k];
    if (norm_(r[1]) === norm_(p.name) && norm_(r[2]) === norm_(p.cls) && r[3] && String(r[3]) === p.pin) {
      const g = groupByCode_(r[15]);
      return { ok: true, sid: r[0], name: r[1], cls: r[2], group: g ? g.code : "", groupTitle: g ? g.title : "", progress: safeParse_(r[12], null) };
    }
  }
  return { ok: false, error: "Ученик с таким именем, классом и PIN не найден" };
}

function safeParse_(s, d) {
  try { return s ? JSON.parse(s) : d; } catch (e) { return d; }
}
