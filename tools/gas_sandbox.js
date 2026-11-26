/* =========================================================
   Песочница Google Apps Script для проверки teacher/Code.gs в браузере.
   Сайтом НЕ подключается. Использование (в консоли страницы сайта):
     localStorage.setItem("eppro.endpoint.override", JSON.stringify("https://gas.test/exec"));
     // перезагрузить страницу, затем:
     const s = document.createElement("script"); s.src = "tools/gas_sandbox.js"; document.head.appendChild(s);
   Таблица хранится в localStorage («gas.sandbox»), поэтому переживает перезагрузку.
   Имитирует: SpreadsheetApp, ContentService, LockService, Utilities, PropertiesService.
   Как и настоящая таблица, апостроф в начале строки делает значение текстом.
   ========================================================= */
(async function () {
  const URL_BASE = "https://gas.test/exec";
  const LS = "gas.sandbox";
  const db = JSON.parse(localStorage.getItem(LS) || '{"sheets":{},"props":{}}');
  const save = () => localStorage.setItem(LS, JSON.stringify(db));

  /* ---------- синхронный SHA-256 / HMAC (как Utilities.computeHmacSha256Signature) ---------- */
  const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  function sha256(bytes) {
    const l = bytes.length, withPad = ((l + 9 + 63) >> 6) << 6;
    const m = new Uint8Array(withPad); m.set(bytes); m[l] = 0x80;
    const dv = new DataView(m.buffer); dv.setUint32(withPad - 4, l * 8); dv.setUint32(withPad - 8, Math.floor(l / 0x20000000));
    let H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const w = new Uint32Array(64), rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let o = 0; o < withPad; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H = [H[0] + a, H[1] + b, H[2] + c, H[3] + d, H[4] + e, H[5] + f, H[6] + g, H[7] + h].map((x) => x >>> 0);
    }
    const out = new Uint8Array(32); const ov = new DataView(out.buffer); H.forEach((x, i) => ov.setUint32(i * 4, x)); return out;
  }
  const utf8 = (s) => new TextEncoder().encode(String(s));
  function hmac(value, key) {
    let k = utf8(key); if (k.length > 64) k = sha256(k);
    const kp = new Uint8Array(64); kp.set(k);
    const ipad = kp.map((x) => x ^ 0x36), opad = kp.map((x) => x ^ 0x5c), v = utf8(value);
    const inner = new Uint8Array(64 + v.length); inner.set(ipad); inner.set(v, 64);
    const ih = sha256(inner), outer = new Uint8Array(96); outer.set(opad); outer.set(ih, 64);
    return Array.from(sha256(outer)).map((b) => (b > 127 ? b - 256 : b));   // как в Apps Script: байты со знаком
  }

  /* ---------- таблица ---------- */
  const cell = (v) => (v instanceof Date ? v.toISOString() : typeof v === "string" && v.startsWith("'") ? v.slice(1) : v);
  function Sheet(name) {
    const rows = () => db.sheets[name];
    const api = {
      appendRow(r) { rows().push(r.map(cell)); save(); return api; },
      setFrozenRows() { return api; },
      getLastRow() { return rows().length; },
      getLastColumn() { return rows().reduce((m, r) => Math.max(m, r.length), 0); },
      getRange(r, c, nr = 1, nc = 1) {
        return {
          setFontWeight() { return this; },
          getValues() {
            const out = [];
            for (let i = 0; i < nr; i++) { const row = rows()[r - 1 + i] || []; const o = []; for (let j = 0; j < nc; j++) o.push(row[c - 1 + j] ?? ""); out.push(o); }
            return out;
          },
          setValues(vals) {
            for (let i = 0; i < nr; i++) {
              const row = rows()[r - 1 + i] || (rows()[r - 1 + i] = []);
              for (let j = 0; j < nc; j++) row[c - 1 + j] = cell(vals[i][j]);
            }
            save(); return this;
          },
          setValue(v) { return this.setValues([[v]]); },
        };
      },
    };
    return api;
  }
  const SpreadsheetApp = { getActiveSpreadsheet: () => ({
    getSheetByName: (n) => (db.sheets[n] ? Sheet(n) : null),
    insertSheet: (n) => { db.sheets[n] = []; save(); return Sheet(n); },
  }) };
  const ContentService = { MimeType: { JSON: "json" }, createTextOutput: (s) => ({ s, setMimeType() { return this; } }) };
  const LockService = { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) };
  const Utilities = { getUuid: () => crypto.randomUUID(), computeHmacSha256Signature: hmac,
    DigestAlgorithm: { SHA_256: "SHA_256" }, Charset: { UTF_8: "UTF_8" },
    computeDigest: (alg, value) => Array.from(sha256(utf8(value))).map((b) => (b > 127 ? b - 256 : b)) };
  const PropertiesService = { getScriptProperties: () => ({ getProperty: (k) => db.props[k] ?? null, setProperty: (k, v) => { db.props[k] = v; save(); } }) };

  /* ---------- настоящий Code.gs ---------- */
  let src = await (await fetch("teacher/Code.gs?_=" + Date.now())).text();
  src = src.replace('const ADMIN_KEY = "поменяйте-меня";', 'const ADMIN_KEY = "admin-test";');   // только в песочнице
  const gas = new Function("SpreadsheetApp", "ContentService", "LockService", "Utilities", "PropertiesService",
    src + "\nreturn { doGet, doPost };")(SpreadsheetApp, ContentService, LockService, Utilities, PropertiesService);

  const realFetch = window.__realFetch || window.fetch;
  window.__realFetch = realFetch;
  window.fetch = async (input, opts = {}) => {
    const url = String(input);
    if (!url.startsWith(URL_BASE)) return realFetch(input, opts);
    const u = new URL(url);
    const out = (opts.method || "GET").toUpperCase() === "POST"
      ? gas.doPost({ postData: { contents: typeof opts.body === "string" ? opts.body : await new Response(opts.body).text() } })
      : gas.doGet({ parameter: Object.fromEntries(u.searchParams) });
    return new Response(out.s, { headers: { "Content-Type": "application/json" } });
  };
  navigator.sendBeacon = (url, data) => { window.fetch(url, { method: "POST", body: data }); return true; };
  window.GAS_SANDBOX = { db, reset() { localStorage.removeItem(LS); }, gas, hmac };
  console.log("GAS sandbox ready");
})();
