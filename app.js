/* Desk iPhone app — plan B. Path/key/token only from #p/#k/#t or localStorage.
   Never log those values. Never build FOMO URLs; use the ones shipped in JSON. */
(function () {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(function () {});
  }

  var LS = { p: "desk.p", k: "desk.k", t: "desk.t", seen: "desk.seenActivity" };
  var POLL_MS = 15000;
  var SCREEN_MS = 15000;
  var store = { state: null, chart: null, activity: null, account: null, coin: {}, audit: {}, decisions: {}, screenUrl: null, screenBuf: [null, null], range: "LIVE", view: "home", mint: null, lastOk: 0, retryIn: 15, offline: false, reduced: false };

  try {
    store.reduced = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  } catch (e) {}

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function qs() { return new URLSearchParams(location.search); }
  function demoEmpty() { return qs().get("empty") === "1"; }
  function demoError() { return qs().get("error") === "1"; }

  function b64urlToBytes(s) {
    var pad = "====".slice((s.length % 4) || 4);
    var b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function parseFragment() {
    var h = (location.hash || "").replace(/^#/, "");
    var p = new URLSearchParams(h);
    return { path: p.get("p") || "", key: p.get("k") || "", token: p.get("t") || "", s: p.get("s") || "", m: p.get("m") || "" };
  }

  function setHashParams(extra) {
    var cur = parseFragment();
    var p = new URLSearchParams();
    if (cur.path) p.set("p", cur.path);
    if (cur.key) p.set("k", cur.key);
    if (cur.token) p.set("t", cur.token);
    if (extra.s && extra.s !== "home") p.set("s", extra.s);
    if (extra.m) p.set("m", extra.m);
    var next = "#" + p.toString();
    if (next !== location.hash) history.replaceState(null, "", location.pathname + location.search + next);
  }

  function loadCreds() {
    var f = parseFragment();
    var cfg = {
      path: f.path || localStorage.getItem(LS.p) || "",
      key: f.key || localStorage.getItem(LS.k) || "",
      token: f.token || localStorage.getItem(LS.t) || ""
    };
    if (f.path) localStorage.setItem(LS.p, f.path);
    if (f.key) localStorage.setItem(LS.k, f.key);
    if (f.token) localStorage.setItem(LS.t, f.token);
    if (cfg.path && /\.json$/i.test(cfg.path.split("/").pop() || "")) {
      cfg.path = cfg.path.replace(/\/[^/]+$/, "");
    }
    cfg.path = (cfg.path || "").replace(/^\/+|\/+$/g, "");
    if (f.s) store.view = f.s;
    if (f.m) store.mint = f.m;
    return cfg;
  }

  function repoFromHost() {
    var host = location.hostname;
    if (!host.endsWith(".github.io")) return null;
    var owner = host.slice(0, -".github.io".length);
    var parts = location.pathname.split("/").filter(Boolean);
    var first = parts[0] || "";
    var isFile = first.indexOf(".") >= 0;
    var repo = !first || isFile ? owner + ".github.io" : first;
    return { owner: owner, repo: repo };
  }

  var cryptoKey = null;
  var cfg = { path: "", key: "", token: "" };

  function importKey(keyB64) {
    return crypto.subtle.importKey("raw", b64urlToBytes(keyB64), "AES-GCM", false, ["decrypt"]);
  }

  function decryptBox(box) {
    var iv = b64urlToBytes(box.iv);
    var ct = b64urlToBytes(box.ct);
    return crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, cryptoKey, ct);
  }

  function decryptJson(box) {
    return decryptBox(box).then(function (pt) {
      return JSON.parse(new TextDecoder().decode(pt));
    });
  }

  function getJson(url, headers) {
    return fetch(url, { cache: "no-store", headers: headers || {} });
  }

  function decodeContents(meta) {
    if (!meta || !meta.content) return null;
    var bin = atob(meta.content.replace(/\n/g, ""));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, function (c) { return c.charCodeAt(0); })));
  }

  function loadBox(rel) {
    var loc = repoFromHost();
    var headers = {};
    if (cfg.token) headers.Authorization = "Bearer " + cfg.token;
    var relPath = cfg.path + "/" + rel;
    var errors = [];

    function tryApi() {
      if (!loc) return Promise.reject();
      var api = "https://api.github.com/repos/" + loc.owner + "/" + loc.repo + "/contents/" + relPath + "?ref=main";
      return getJson(api, Object.assign({ Accept: "application/vnd.github+json" }, headers)).then(function (res) {
        if (!res.ok) throw new Error("api " + res.status);
        return res.json().then(function (meta) { return decodeContents(meta); });
      });
    }
    function tryRaw() {
      if (!loc) return Promise.reject();
      var raw = "https://raw.githubusercontent.com/" + loc.owner + "/" + loc.repo + "/main/" + relPath;
      return getJson(raw).then(function (res) {
        if (!res.ok) throw new Error("raw " + res.status);
        return res.json();
      });
    }
    function tryPages() {
      var url = relPath;
      var base = location.pathname.replace(/\/[^/]*$/, "/");
      if (location.protocol === "https:" || location.protocol === "http:") url = base + relPath;
      return getJson(url).then(function (res) {
        if (!res.ok) throw new Error("pages " + res.status);
        return res.json();
      });
    }
    return tryApi().catch(function () { return tryRaw(); }).catch(function () { return tryPages(); });
  }

  function loadJson(rel) {
    return loadBox(rel).then(decryptJson);
  }

  function fmtMoney(n, digits) {
    if (n == null || n === "" || !isFinite(Number(n))) return null;
    var d = digits == null ? 2 : digits;
    return Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function fmtPct(n) {
    if (n == null || !isFinite(Number(n))) return null;
    var v = Number(n);
    var s = (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
    return s;
  }
  function fmtTime(ts) {
    if (ts == null) return "";
    var d = new Date(Number(ts) * (Number(ts) > 1e12 ? 1 : 1000));
    return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }
  function fmtWhen(ts) {
    if (ts == null) return "";
    var d = new Date(Number(ts) * (Number(ts) > 1e12 ? 1 : 1000));
    return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }

  function toast(msg) {
    var t = $("toast");
    t.hidden = false;
    t.textContent = msg;
    clearTimeout(toast._id);
    toast._id = setTimeout(function () { t.hidden = true; }, 1800);
  }

  function copyText(text) {
    if (!text) return Promise.resolve();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { toast("Copied"); }).catch(function () { fallback(text); });
    }
    fallback(text);
    return Promise.resolve();
  }
  function fallback(text) {
    var a = el("textarea");
    a.value = text;
    document.body.appendChild(a);
    a.select();
    try { document.execCommand("copy"); toast("Copied"); } catch (e) {}
    a.remove();
  }

  function go(view, mint) {
    store.view = view;
    store.mint = mint || (view === "coin" || view === "audit" ? store.mint : null);
    setHashParams({ s: view, m: store.mint || "" });
    render();
    if (view === "coin" && store.mint) ensureCoin(store.mint);
    if (view === "audit" && store.mint) ensureAudit(store.mint);
    if (view === "bots") ["scanner","analyst","brain","executor","risk"].forEach(ensureDecisions);
  }

  function ensureCoin(mint) {
    if (store.coin[mint]) return;
    loadJson("coin/" + mint + ".json").then(function (d) { store.coin[mint] = d; if (store.view === "coin") render(); }).catch(function () {});
  }
  function ensureAudit(mint) {
    if (store.audit[mint]) return;
    loadJson("audit/" + mint + ".json").then(function (d) { store.audit[mint] = d; if (store.view === "audit") render(); }).catch(function () {});
  }
  function ensureDecisions(name) {
    if (store.decisions[name]) return;
    loadJson("bots/" + name + "/decisions.json").then(function (d) { store.decisions[name] = d; if (store.view === "bots") render(); }).catch(function () {});
  }

  /* ---------- views ---------- */
  function render() {
    var app = $("app");
    var tab = $("tabbar");
    tab.hidden = store.view === "live" || store.view === "search";
    Array.prototype.forEach.call(tab.querySelectorAll("button"), function (b) {
      b.classList.toggle("on", b.getAttribute("data-tab") === store.view || (store.view === "home" && b.getAttribute("data-tab") === "home"));
      if (store.view === "coin" || store.view === "audit") b.classList.toggle("on", b.getAttribute("data-tab") === "activity" && store.view === "coin" ? false : b.classList.contains("on"));
    });
    app.classList.remove("loading");
    if (demoError()) showError(true);
    var v = store.view;
    if (demoEmpty()) {
      if (v === "home") { app.innerHTML = ""; app.appendChild(viewHome(emptyState())); return; }
      if (v === "activity") { app.innerHTML = ""; app.appendChild(viewActivity({ rows: [] })); return; }
    }
    if (v === "home") { app.innerHTML = ""; app.appendChild(viewHome(store.state)); }
    else if (v === "bots") { app.innerHTML = ""; app.appendChild(viewBots(store.state)); }
    else if (v === "activity") { app.innerHTML = ""; app.appendChild(viewActivity(store.activity)); }
    else if (v === "account") { app.innerHTML = ""; app.appendChild(viewAccount(store.account || store.state)); }
    else if (v === "coin") { app.innerHTML = ""; app.appendChild(viewCoin(store.mint)); }
    else if (v === "audit") { app.innerHTML = ""; app.appendChild(viewAudit(store.mint)); }
    else if (v === "search") { app.innerHTML = ""; app.appendChild(viewSearch()); }
    else if (v === "live") { app.innerHTML = ""; app.appendChild(viewLiveFull()); }
    else { app.innerHTML = ""; app.appendChild(viewHome(store.state)); }
  }

  function emptyState() {
    return { mode: "PAPER", balance: null, today_pct: null, multiplier: null, bots_running: 0, bots: [], positions: [], activity_preview: [], last_order: null, lane: { label: "Idle" }, screen_ts: null, coins: [] };
  }

  function navBar(title, opts) {
    opts = opts || {};
    var bar = el("div", "navbar");
    if (opts.back) {
      var back = el("button", "navbtn", "‹");
      back.type = "button";
      back.addEventListener("click", function () { go(opts.back); });
      bar.appendChild(back);
    } else {
      var av = el("button", "avatar", initials((store.state || {}).fomo_handle || "G"));
      av.type = "button";
      av.addEventListener("click", function () { go("account"); });
      bar.appendChild(av);
    }
    bar.appendChild(el("div", "title", title || "Grok Bot ›"));
    if (!opts.bare) {
      var search = el("button", "navbtn", "⌕");
      search.type = "button";
      search.addEventListener("click", function () { go("search"); });
      var bell = el("button", "navbtn", "⌂");
      bell.type = "button";
      bell.textContent = "◉";
      if (hasUnseen()) bell.appendChild(el("span", "bell-dot"));
      bell.addEventListener("click", function () { go("activity"); });
      bar.appendChild(search);
      bar.appendChild(bell);
    }
    if (opts.paper && isPaper()) {
      bar.appendChild(el("span", "pill paper", "PAPER"));
    }
    return bar;
  }

  function initials(h) { return (h || "G").replace(/^@/, "").slice(0, 1).toUpperCase(); }
  function isPaper() {
    var m = (store.state && store.state.mode) || (store.account && store.account.mode) || "PAPER";
    return String(m).toUpperCase() !== "LIVE";
  }

  function hasUnseen() {
    var rows = ((store.activity || {}).rows) || ((store.state || {}).activity_preview) || [];
    if (!rows.length) return false;
    var seen = Number(localStorage.getItem(LS.seen) || 0);
    return Number(rows[0].ts || 0) > seen;
  }

  function viewHome(state) {
    var root = el("div");
    root.appendChild(navBar("Grok Bot ›"));
    var pad = el("div", "pad");
    var st = state || {};
    var balRow = el("div", "balance-row");
    var odo = el("div", "odometer");
    if (st.balance == null) {
      odo.classList.add("muted");
      odo.appendChild(el("span", "digits", ""));
    } else {
      odo.appendChild(el("span", "cur", "$"));
      odo.appendChild(buildOdo(fmtMoney(st.balance)));
    }
    balRow.appendChild(odo);
    var meta = el("div", "meta-row");
    var pct = fmtPct(st.today_pct);
    if (pct) meta.appendChild(el("span", Number(st.today_pct) >= 0 ? "up" : "down", pct + " today"));
    if (st.multiplier != null && isFinite(Number(st.multiplier))) {
      meta.appendChild(el("span", "pill mult", Number(st.multiplier).toFixed(2) + "×"));
    }
    if (isPaper()) meta.appendChild(el("span", "pill paper", "PAPER"));
    balRow.appendChild(meta);
    pad.appendChild(balRow);

    var wrap = el("div", "chart-wrap");
    var cv = document.createElement("canvas");
    wrap.appendChild(cv);
    var marksLayer = el("div", "chart-marks");
    wrap.appendChild(marksLayer);
    pad.appendChild(wrap);
    var ranges = el("div", "ranges");
    ["LIVE","1H","4H","1D","1W","ALL"].forEach(function (r) {
      var b = el("button", store.range === r ? "on" : "", r);
      b.type = "button";
      b.addEventListener("click", function () { store.range = r; drawHomeChart(cv, marksLayer); Array.prototype.forEach.call(ranges.children, function (x) { x.classList.toggle("on", x.textContent === r); }); });
      ranges.appendChild(b);
    });
    pad.appendChild(ranges);

    pad.appendChild(liveCard(st));

    var previewEarly = st.activity_preview || [];
    if (!previewEarly.length) pad.appendChild(el("div", "empty", "Waiting for the first trade"));

    var botsH = el("div", "section-h");
    var nRun = st.bots_running;
    botsH.appendChild(el("span", "", nRun == null ? "Bots" : ("Bots · " + nRun + " running")));
    pad.appendChild(botsH);
    pad.appendChild(botCarousel(st.bots || []));

    var actH = el("div", "section-h");
    actH.appendChild(el("span", "", "Activity"));
    var see = el("button", "more", "See all");
    see.type = "button";
    see.addEventListener("click", function () { go("activity"); });
    actH.appendChild(see);
    pad.appendChild(actH);
    var preview = st.activity_preview || [];
    if (!preview.length) pad.appendChild(el("div", "empty", "Waiting for the first trade"));
    else pad.appendChild(activityList(preview));

    root.appendChild(pad);
    requestAnimationFrame(function () { drawHomeChart(cv, marksLayer); });
    requestAnimationFrame(paintLiveFrame);
    return root;
  }

  function buildOdo(text) {
    var box = el("span", "digits");
    if (store.reduced) { box.textContent = text; return box; }
    (text || "").split("").forEach(function (ch, i) {
      if (!/[0-9]/.test(ch)) { box.appendChild(document.createTextNode(ch)); return; }
      var d = el("span", "digit");
      var col = el("span");
      for (var n = 0; n <= 9; n++) col.appendChild(el("span", "", String(n)));
      d.appendChild(col);
      box.appendChild(d);
      var target = Number(ch);
      col.style.transitionDelay = (i * 30) + "ms";
      requestAnimationFrame(function () { col.style.transform = "translateY(" + (-target * 10) + "%)"; });
    });
    return box;
  }

  function drawHomeChart(canvas, layer) {
    var data = (store.chart && store.chart[store.range]) || { points: [], marks: [] };
    if (demoEmpty()) data = { points: [], marks: [] };
    layer.innerHTML = "";
    if (!window.DeskChart) return;
    if (!data.points || !data.points.length) return;
    var drawn = DeskChart.line(canvas, data);
    var placed = [];
    (drawn.positions || []).forEach(function (p) {
      var row = 0;
      var left = p.x;
      for (var guard = 0; guard < 6; guard++) {
        var clash = placed.some(function (q) { return Math.abs(q.x - left) < 72 && q.row === row; });
        if (!clash) break;
        row += 1;
      }
      placed.push({ x: left, row: row });
      var m = el("div", "mark " + (p.mark.tone || "blue"), p.mark.label || "");
      m.style.left = p.x + "px";
      m.style.top = Math.max(10, p.y - 8 - row * 16) + "px";
      layer.appendChild(m);
    });
  }

  function liveCard(st) {
    var box = el("div", "live-card");
    var frame = el("div", "live-frame");
    frame.id = "live-frame";
    var empty = el("div", "live-empty", "No frame yet");
    empty.id = "live-empty";
    frame.appendChild(empty);
    var imgA = document.createElement("img");
    imgA.id = "screen-a"; altSafe(imgA);
    var imgB = document.createElement("img");
    imgB.id = "screen-b"; altSafe(imgB);
    frame.appendChild(imgA); frame.appendChild(imgB);
    var tag = el("div", "live-tag");
    var age = screenAge(st);
    var dot = el("span", "dot" + (age != null && age < 5 ? " live" : ""));
    tag.appendChild(dot);
    tag.appendChild(el("span", "", age != null && age < 5 ? "Live · Bot's computer" : (st.screen_ts ? ("Last frame " + fmtWhen(st.screen_ts)) : "Last frame —")));
    frame.appendChild(tag);
    var lane = el("div", "live-lane", (st.lane && st.lane.label) || "Idle");
    if (st.lane && st.lane.color) lane.style.color = st.lane.color;
    frame.appendChild(lane);
    frame.addEventListener("click", function () { go("live"); });
    box.appendChild(frame);
    var last = el("div", "live-last");
    if (st.last_order) {
      var o = st.last_order;
      var verb = o.side === "sell" ? "Sold" : "Bought";
      var usd = o.fill_usd != null ? o.fill_usd : o.usd;
      var t = verb + " " + (o.label || "") + (usd != null ? " · $" + fmtMoney(usd) : "");
      if (o.screen_ok && o.api_ok && o.chain_ok) t += " · verified";
      last.appendChild(el("span", "", t));
      var ch = el("span", "checks");
      ["screen_ok","api_ok","chain_ok"].forEach(function (k) {
        ch.appendChild(el("span", "check" + (o[k] ? " ok" : ""), o[k] ? "✓" : "·"));
      });
      last.appendChild(ch);
    }
    box.appendChild(last);
    return box;
  }
  function altSafe(img) { img.alt = "Live screen"; img.draggable = false; }

  function screenAge(st) {
    if (!st || st.screen_ts == null) return null;
    var ts = Number(st.screen_ts);
    if (ts > 1e12) ts = ts / 1000;
    return (Date.now() / 1000) - ts;
  }

  function botCarousel(bots) {
    var row = el("div", "carousel");
    if (!bots.length) {
      row.appendChild(el("div", "empty", "Bots are idle"));
      return row;
    }
    bots.forEach(function (b) { row.appendChild(miniCard(b)); });
    return row;
  }

  function miniCard(b) {
    var c = el("div", "bot-card");
    var who = el("div", "who");
    var name = el("span", "", b.name);
    name.style.color = b.color || "#fff";
    who.appendChild(name);
    c.appendChild(who);
    c.appendChild(el("div", "hl", b.headline || ""));
    if (b.id === "scanner" && b.feed) {
      b.feed.slice(0, 4).forEach(function (f) {
        var v = (f.verdict || "").toLowerCase();
        var cls = "feed-item" + (v === "killed" || v === "kill" ? " kill" : v === "pass" || v === "passed" ? " pass" : "");
        var t = f.label || "";
        if (v === "killed" || v === "kill") t += "  " + (f.reason || "");
        if (v === "pass" || v === "passed") t += " → Analyst";
        c.appendChild(el("div", cls, t));
      });
    }
    if (b.id === "analyst") {
      var lay = el("div", "layers");
      for (var i = 0; i < 8; i++) {
        var L = (b.layers || [])[i];
        var s = el("div", "layer-s" + (L ? (L.pass ? " ok" : " bad") : ""));
        lay.appendChild(s);
      }
      c.appendChild(lay);
      var sr = el("div", "score-row");
      var ring = document.createElement("canvas");
      ring.className = "ring";
      sr.appendChild(ring);
      if (b.score != null) sr.appendChild(el("span", "num", String(b.score)));
      if (b.social_pts != null) sr.appendChild(el("span", "", "Social +" + b.social_pts));
      c.appendChild(sr);
      requestAnimationFrame(function () { if (window.DeskChart) DeskChart.ring(ring, b.score); });
    }
    if (b.id === "brain") {
      if (b.ticket) c.appendChild(el("div", "", b.ticket));
      c.appendChild(el("div", "hl", b.size_rule || "80+ = full size / under 80 = half size"));
    }
    if (b.id === "executor") c.appendChild(el("div", "exec-bar", b.bar || "Idle"));
    if (b.id === "risk" && b.pills) {
      var ps = el("div", "pills");
      b.pills.forEach(function (p) { ps.appendChild(el("span", "pill " + (p.tone || ""), p.text)); });
      c.appendChild(ps);
    }
    c.addEventListener("click", function () { go("bots"); });
    return c;
  }

  function activityList(rows) {
    var box = el("div", "rows");
    rows.forEach(function (r) { box.appendChild(activityRow(r)); });
    return box;
  }

  function activityRow(r) {
    var b = el("button", "row");
    b.type = "button";
    var mid = el("div", "mid");
    mid.appendChild(el("div", "t", r.title || prettyKind(r)));
    var sub = [r.bot, fmtTime(r.ts), r.subtitle].filter(Boolean).join(" · ");
    mid.appendChild(el("div", "s", sub));
    b.appendChild(mid);
    var right = el("div", "r");
    if (r.usd != null) {
      var sign = (r.kind === "stopped" || (Number(r.usd) < 0)) ? "-" : (r.kind === "sold" ? "+" : "");
      right.appendChild(document.createTextNode((sign === "-" ? "-$" : sign === "+" ? "+$" : "$") + fmtMoney(Math.abs(Number(r.usd)))));
    } else if (r.value && typeof r.value === "string" && r.value.indexOf("{") !== 0) {
      right.textContent = r.value;
    } else if ((r.kind || "") === "rejected") {
      right.textContent = "Skipped";
    }
    if (Number(r.usd) < 0 || r.kind === "stopped") right.classList.add("down");
    if (r.kind === "sold" && Number(r.usd) >= 0) right.classList.add("up");
    b.appendChild(right);
    b.addEventListener("click", function () {
      if (!r.mint) return;
      go(r.open === "audit" || r.kind === "rejected" ? "audit" : "coin", r.mint);
    });
    return b;
  }
  function prettyKind(r) {
    var lab = r.label || r.symbol || r.name || "";
    var k = (r.kind || "").toLowerCase();
    if (k === "bought") return "Bought " + lab;
    if (k === "sold") return "Sold " + lab;
    if (k === "stopped") return "Stopped " + lab;
    if (k === "rejected") return "Rejected " + lab;
    return r.title || k || lab;
  }

  function viewActivity(act) {
    var root = el("div");
    root.appendChild(navBar("Activity", { bare: true }));
    var pad = el("div", "pad");
    var rows = (act && act.rows) || [];
    if (demoEmpty()) rows = [];
    if (!rows.length) pad.appendChild(el("div", "empty", "Nothing yet tonight"));
    else pad.appendChild(activityList(rows));
    root.appendChild(pad);
    try { if (rows[0]) localStorage.setItem(LS.seen, String(rows[0].ts || 0)); } catch (e) {}
    return root;
  }

  function viewBots(state) {
    var root = el("div");
    root.appendChild(navBar("Bots", { bare: true }));
    var pad = el("div", "pad");
    var bots = (state && state.bots) || [];
    if (!bots.length) pad.appendChild(el("div", "empty", "No bot data yet"));
    bots.forEach(function (b) {
      var card = el("div", "bot-full");
      var top = el("div", "top");
      top.appendChild(el("span", "status-dot " + (b.status || "idle")));
      var h = el("h2", "", b.name);
      h.style.color = b.color || "#fff";
      top.appendChild(h);
      top.appendChild(el("span", "hl", b.count != null ? (b.count + " today") : ""));
      var sw = el("button", "switch" + (b.paused ? " on" : "") + (b.pause_locked ? " locked" : ""));
      sw.type = "button";
      sw.appendChild(el("i"));
      sw.addEventListener("click", function () {
        if (b.pause_locked) { toast("Risk is locked while a position is open"); return; }
        var cmd = (b.paused ? "resume " : "pause ") + b.name;
        copyText(cmd).then(function () { toast("Telegram: " + cmd); });
      });
      top.appendChild(sw);
      card.appendChild(top);
      card.appendChild(el("div", "hl", b.headline || ""));
      var dec = (store.decisions[b.id] && store.decisions[b.id].rows) || [];
      var list = el("div", "decisions");
      if (!dec.length) list.appendChild(el("div", "d", "No decisions yet"));
      dec.slice(0, 20).forEach(function (d) {
        var a = el("button", "d", (d.label ? d.label + " · " : "") + (d.text || d.reason || ""));
        a.type = "button";
        a.addEventListener("click", function () { if (d.mint) go("coin", d.mint); });
        list.appendChild(a);
      });
      card.appendChild(list);
      var setBtn = el("button", "more", "Settings");
      setBtn.type = "button";
      setBtn.addEventListener("click", function () { go("account"); });
      card.appendChild(setBtn);
      pad.appendChild(card);
    });
    root.appendChild(pad);
    return root;
  }

  function viewAccount(acc) {
    var root = el("div");
    root.appendChild(navBar("Account", { bare: true }));
    var pad = el("div", "pad");
    var a = acc || {};
    var modes = el("div", "mode-row");
    var paperB = el("button", isPaper() ? "on paper" : "", "PAPER");
    var liveB = el("button", !isPaper() ? "on live" : "", "LIVE");
    paperB.type = liveB.type = "button";
    paperB.addEventListener("click", function () { toast("Change via Telegram: paper"); });
    liveB.addEventListener("click", function () { toast("Change via Telegram: type LIVE"); });
    modes.appendChild(paperB); modes.appendChild(liveB);
    pad.appendChild(modes);
    if (a.cash != null) {
      var cash = el("div", "set-row");
      cash.appendChild(el("div", "lab", "Cash"));
      cash.appendChild(el("div", "num", "$" + fmtMoney(a.cash)));
      cash.appendChild(el("div", "hint", "Change via Telegram"));
      pad.appendChild(cash);
    }
    var links = el("div", "rows");
    if (a.profile_url) {
      var p = el("a", "row");
      p.href = a.profile_url;
      p.appendChild(el("div", "mid")).appendChild(el("div", "t", "Your FOMO profile"));
      links.appendChild(p);
    }
    var inv = el("button", "row");
    inv.type = "button";
    var mid = el("div", "mid"); mid.appendChild(el("div", "t", "Invite a friend")); inv.appendChild(mid);
    inv.addEventListener("click", function () { shareInvite(a.signup_url); });
    links.appendChild(inv);
    pad.appendChild(links);

    (a.groups || []).forEach(function (g) {
      var box = el("div", "group");
      box.appendChild(el("h3", "", g.name));
      (g.items || []).forEach(function (it) {
        var row = el("div", "set-row");
        var lab = el("div", "lab");
        lab.appendChild(el("span", "", it.key));
        lab.appendChild(el("span", "num", String(it.value == null ? "" : it.value)));
        row.appendChild(lab);
        if (typeof it.value === "number" && it.min != null && it.max != null) {
          var sl = document.createElement("input");
          sl.type = "range"; sl.min = it.min; sl.max = it.max; sl.value = it.value; sl.disabled = true;
          sl.step = Number.isInteger(it.value) ? 1 : 0.01;
          row.appendChild(sl);
        }
        row.appendChild(el("div", "hint", it.hint || ("Change via Telegram: set " + it.path + " to " + it.value)));
        box.appendChild(row);
      });
      pad.appendChild(box);
    });

    var picks = el("div", "group");
    picks.appendChild(el("h3", "", "Copy picks"));
    var pr = el("div", "set-row");
    pr.appendChild(el("div", "lab", a.copy_picks || "off"));
    pr.appendChild(el("div", "hint", a.copy_picks_note || "copy picks off until chapter 3"));
    picks.appendChild(pr);
    pad.appendChild(picks);

    var push = el("div", "group");
    push.appendChild(el("h3", "", "Pushes"));
    var pu = el("div", "set-row");
    pu.appendChild(el("div", "lab", a.pushes || "Telegram only (plan B)"));
    pu.appendChild(el("div", "hint", "Web push is off on plan B"));
    push.appendChild(pu);
    var watch = el("button", "btn", "Watch in Grok Bot");
    watch.type = "button";
    watch.addEventListener("click", function () { go("live"); });
    push.appendChild(watch);
    pad.appendChild(push);

    root.appendChild(pad);
    return root;
  }

  function shareInvite(url) {
    if (!url) return;
    if (navigator.share) {
      navigator.share({ title: "FOMO", url: url }).catch(function () { copyText(url).then(function () { toast("Link copied"); }); });
    } else {
      copyText(url).then(function () { toast("Link copied"); });
    }
  }

  function viewCoin(mint) {
    var root = el("div");
    var data = store.coin[mint];
    root.appendChild(navBar(data && (data.name || data.label) || "Coin", { back: "activity", paper: true, bare: true }));
    var pad = el("div", "pad");
    if (!data) { pad.appendChild(skelBlock()); root.appendChild(pad); return root; }
    var head = el("div", "coin-head");
    var sub = [data.symbol || data.label, data.chain, data.age].filter(Boolean).join(" · ");
    head.appendChild(el("div", "sub", sub));
    if (data.shield) head.appendChild(el("span", "shield", data.shield));
    pad.appendChild(head);
    var px = el("div", "px num", data.price != null ? String(data.price) : "—");
    pad.appendChild(px);
    var chg = fmtPct(data.change_since_entry_pct);
    if (chg) pad.appendChild(el("div", Number(data.change_since_entry_pct) >= 0 ? "up" : "down", "▲ " + chg + " since entry"));
    var cv = document.createElement("canvas");
    cv.style.width = "100%"; cv.style.height = "180px"; cv.style.display = "block";
    pad.appendChild(cv);
    requestAnimationFrame(function () { if (window.DeskChart) DeskChart.candles(cv, data.candles || [], { exit: data.exit_price }); });
    var stats = el("div", "stats");
    [["Market cap", data.market_cap], ["Liquidity", data.liquidity != null ? "$" + fmtMoney(data.liquidity, 0) : null], ["Holders", data.holders]].forEach(function (pair) {
      var s = el("div", "stat");
      s.appendChild(el("div", "k", pair[0]));
      s.appendChild(el("div", "v", pair[1] == null ? "—" : String(pair[1])));
      stats.appendChild(s);
    });
    pad.appendChild(stats);
    if (data.position && !data.position.closed_at) {
      var box = el("div", "pos-box");
      box.appendChild(el("div", "t", "Your position"));
      var line = data.position.size_usd != null ? ("$" + fmtMoney(data.position.size_usd) + " in · Executor") : "Executor";
      box.appendChild(el("div", "s", line));
      pad.appendChild(box);
    }
    var btns = el("div", "btn-row");
    if (data.coin_url) {
      var open = el("a", "btn primary", "Open on FOMO");
      open.href = data.coin_url;
      btns.appendChild(open);
    }
    var sell = el("button", "btn danger", "Sell now");
    sell.type = "button";
    sell.addEventListener("click", function () { openSellSheet(data); });
    btns.appendChild(sell);
    pad.appendChild(btns);
    root.appendChild(pad);
    return root;
  }

  function viewAudit(mint) {
    var root = el("div");
    var data = store.audit[mint];
    root.appendChild(navBar(data && (data.name || data.label) || "Audit", { back: "activity", bare: true }));
    var pad = el("div", "pad");
    if (!data) { pad.appendChild(skelBlock()); root.appendChild(pad); return root; }
    pad.appendChild(el("div", "audit-head", data.label || data.name || ""));
    var discs = el("div", "discs");
    (data.layers || []).forEach(function (L, i) {
      var d = el("div", "disc" + (L.pass === true ? " ok" : L.pass === false ? " bad" : "") + (i === 0 ? " read" : ""), L.pass === true ? "✓" : L.pass === false ? "!" : String(L.layer || i + 1));
      discs.appendChild(d);
    });
    pad.appendChild(discs);
    (data.layers || []).forEach(function (L) {
      var row = el("div", "layer-row");
      row.appendChild(el("div", "n", L.name || ("Layer " + L.layer)));
      row.appendChild(el("div", "v", L.value_text == null ? "—" : L.value_text));
      pad.appendChild(row);
    });
    var social = el("div", "social-row");
    if (data.social_off || !data.social) social.textContent = "Social: off";
    else {
      var s = data.social;
      var t = "Social +" + (s.pts == null ? "0" : s.pts);
      if (s.u15 != null) t += " · " + s.u15 + " accounts in 15m";
      if (s.smart != null) t += " · " + s.smart + " top traders hold";
      social.textContent = t;
    }
    pad.appendChild(social);
    if (data.coin_url) {
      var open = el("a", "btn", "Open on FOMO");
      open.href = data.coin_url;
      open.style.marginTop = "16px";
      pad.appendChild(open);
    }
    root.appendChild(pad);
    return root;
  }

  function viewSearch() {
    var root = el("div", "search-overlay");
    var bar = el("div", "navbar");
    var back = el("button", "navbtn", "‹");
    back.type = "button";
    back.addEventListener("click", function () { go("home"); });
    bar.appendChild(back);
    bar.appendChild(el("div", "title", "Search"));
    root.appendChild(bar);
    var input = document.createElement("input");
    input.type = "search";
    input.placeholder = "Name, symbol or mint";
    input.autofocus = true;
    root.appendChild(input);
    var list = el("div", "rows");
    list.style.margin = "8px 16px";
    root.appendChild(list);
    function paint() {
      list.innerHTML = "";
      var q = (input.value || "").trim().toLowerCase();
      var coins = ((store.state || {}).coins) || [];
      var hits = coins.filter(function (c) {
        if (!q) return true;
        return [c.name, c.symbol, c.label, c.mint].some(function (x) { return String(x || "").toLowerCase().indexOf(q) >= 0; });
      });
      if (!hits.length) list.appendChild(el("div", "empty", q ? "No matches" : "No coins yet"));
      hits.forEach(function (c) {
        var b = el("button", "row");
        b.type = "button";
        var mid = el("div", "mid");
        mid.appendChild(el("div", "t", c.label || c.symbol || c.name || c.mint));
        mid.appendChild(el("div", "s", c.mint || ""));
        b.appendChild(mid);
        b.addEventListener("click", function () { go("coin", c.mint); });
        list.appendChild(b);
      });
    }
    input.addEventListener("input", paint);
    paint();
    setTimeout(function () { input.focus(); }, 50);
    return root;
  }

  function viewLiveFull() {
    var root = el("div", "fs-overlay");
    var bar = el("div", "navbar");
    var back = el("button", "navbtn", "‹");
    back.type = "button";
    back.addEventListener("click", function () { go("home"); });
    bar.appendChild(back);
    bar.appendChild(el("div", "title", "Live screen"));
    root.appendChild(bar);
    var stage = el("div", "fs-img");
    var img = document.createElement("img");
    altSafe(img);
    if (store.screenUrl) img.src = store.screenUrl;
    stage.appendChild(img);
    pinchZoom(stage, img);
    root.appendChild(stage);
    var bot = el("div", "fs-bar");
    var st = store.state || {};
    var url = (st.last_order && st.last_order.coin_url) || null;
    if (url) {
      var a = el("a", "btn primary", "Open on FOMO");
      a.href = url;
      bot.appendChild(a);
    } else bot.appendChild(el("span", "", (st.lane && st.lane.label) || "Idle"));
    root.appendChild(bot);
    return root;
  }

  function pinchZoom(stage, img) {
    var scale = 1, x = 0, y = 0, last = null;
    function apply() { img.style.transform = "translate(" + x + "px," + y + "px) scale(" + scale + ")"; }
    stage.addEventListener("touchstart", function (e) {
      if (e.touches.length) last = { t: touches(e), s: scale, x: x, y: y };
    }, { passive: true });
    stage.addEventListener("touchmove", function (e) {
      if (!last) return;
      var t = touches(e);
      if (e.touches.length === 2 && last.t.d) {
        scale = Math.max(1, Math.min(6, last.s * (t.d / last.t.d)));
      }
      x = last.x + (t.x - last.t.x);
      y = last.y + (t.y - last.t.y);
      if (scale === 1) { x = 0; y = 0; }
      apply();
    }, { passive: true });
    stage.addEventListener("touchend", function () { last = null; if (scale <= 1) { scale = 1; x = 0; y = 0; apply(); } });
  }
  function touches(e) {
    var a = e.touches[0], b = e.touches[1];
    if (b) return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2, d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) };
    return { x: a.clientX, y: a.clientY, d: 0 };
  }

  function openSellSheet(data) {
    var sheet = $("sheet");
    sheet.hidden = false;
    sheet.innerHTML = "";
    var panel = el("div", "panel");
    panel.appendChild(el("div", "handle"));
    panel.appendChild(el("div", "t", "Sell " + (data.label || "") + " now"));
    var cmds = data.sell_commands || {};
    var chosen = "100";
    var row = el("div", "btn-row");
    ["25","50","100"].forEach(function (p) {
      var b = el("button", "btn" + (p === chosen ? " primary" : ""), p + "%");
      b.type = "button";
      b.addEventListener("click", function () {
        chosen = p;
        Array.prototype.forEach.call(row.children, function (x) { x.classList.toggle("primary", x.textContent === p + "%"); });
        cmdLine.textContent = cmds[chosen] || ("sell " + (data.label || "") + " " + chosen);
      });
      row.appendChild(b);
    });
    panel.appendChild(row);
    var cmdLine = el("div", "hint");
    cmdLine.style.margin = "12px 0";
    cmdLine.textContent = cmds[chosen] || "";
    panel.appendChild(cmdLine);
    var confirm = el("button", "btn danger", "Confirm sell");
    confirm.type = "button";
    confirm.addEventListener("click", function () {
      var cmd = cmds[chosen] || ("sell " + (data.label || "") + " " + chosen);
      copyText(cmd).then(function () { toast("Telegram: " + cmd); });
    });
    panel.appendChild(confirm);
    var cancel = el("button", "btn", "Cancel");
    cancel.type = "button";
    cancel.style.marginTop = "8px";
    cancel.addEventListener("click", function () { sheet.hidden = true; });
    panel.appendChild(cancel);
    panel.appendChild(el("div", "hint", "Plan B: settings and sells go through Telegram. Copy the command, then send it."));
    sheet.appendChild(panel);
    sheet.onclick = function (e) { if (e.target === sheet) sheet.hidden = true; };
  }

  function skelBlock() {
    var d = el("div");
    d.appendChild(el("div", "skel bal"));
    d.appendChild(el("div", "skel chart"));
    return d;
  }

  function showError(on) {
    var b = $("error-banner");
    if (!on && !demoError()) { b.hidden = true; return; }
    var last = store.lastOk ? fmtWhen(store.lastOk / 1000) : "—";
    b.hidden = false;
    b.textContent = "Desk offline · retrying in " + Math.max(0, Math.round(store.retryIn)) + "s · last update " + last;
  }

  /* ---------- live frame double buffer ---------- */
  var screenFlip = 0;
  function paintLiveFrame() {
    var a = $("screen-a"), b = $("screen-b");
    if (!a || !store.screenUrl) return;
    var empty = $("live-empty");
    var target = screenFlip % 2 === 0 ? a : (b || a);
    var other = target === a ? b : a;
    function show() {
      target.classList.add("show");
      if (other) other.classList.remove("show");
      if (empty) empty.style.display = "none";
      screenFlip += 1;
    }
    if (target.src === store.screenUrl) { show(); return; }
    target.onload = show;
    target.src = store.screenUrl;
  }

  function setScreenBytes(buf) {
    var blob = new Blob([buf], { type: "image/jpeg" });
    var url = URL.createObjectURL(blob);
    if (store.screenUrl) URL.revokeObjectURL(store.screenUrl);
    store.screenUrl = url;
    paintLiveFrame();
  }

  function pollScreen() {
    if (!cfg.path || !cryptoKey) return Promise.resolve();
    return loadBox("screen.jpg").then(decryptBox).then(function (pt) {
      setScreenBytes(pt);
    }).catch(function () { /* no frame is an empty state, not an error */ });
  }

  /* ---------- poll ---------- */
  function pollAll() {
    if (!cfg.path || !cryptoKey) return Promise.resolve();
    if (demoError()) { store.offline = true; store.retryIn = POLL_MS / 1000; showError(true); render(); return Promise.resolve(); }
    var jobs = [
      loadJson("state.json").then(function (d) { store.state = d; }),
      loadJson("chart.json").then(function (d) { store.chart = d; }),
      loadJson("activity.json").then(function (d) { store.activity = d; }),
      loadJson("account.json").then(function (d) { store.account = d; })
    ];
    return Promise.all(jobs).then(function () {
      store.lastOk = Date.now();
      store.offline = false;
      showError(false);
      render();
    }).catch(function () {
      store.offline = true;
      store.retryIn = POLL_MS / 1000;
      showError(true);
      /* keep last good numbers — do not blank the screen */
    });
  }

  $("tabbar").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-tab]");
    if (!b) return;
    go(b.getAttribute("data-tab"));
  });

  function boot() {
    cfg = loadCreds();
    $("tabbar").hidden = false;
    if (!cfg.path || !cfg.key) {
      var app = $("app");
      app.classList.remove("loading");
      var root = el("div");
      root.appendChild(navBar("Grok Bot ›"));
      var pad = el("div", "pad");
      pad.appendChild(el("div", "empty", "Open the bookmarked URL that includes the fragment."));
      root.appendChild(pad);
      app.innerHTML = "";
      app.appendChild(root);
      return;
    }
    importKey(cfg.key).then(function (k) {
      cryptoKey = k;
      return pollAll();
    }).then(function () { return pollScreen(); }).then(function () {
      setInterval(function () {
        store.retryIn = POLL_MS / 1000;
        pollAll();
      }, POLL_MS);
      setInterval(pollScreen, SCREEN_MS);
    }).catch(function () {
      store.offline = true;
      showError(true);
      render();
    });
  }

  window.addEventListener("hashchange", function () {
    var f = parseFragment();
    if (f.s) store.view = f.s;
    else if (!["home","bots","activity","account","search","live","coin","audit"].includes(store.view)) store.view = "home";
    if (f.m) store.mint = f.m;
    if (f.s === "home" || f.s === "bots" || f.s === "activity" || f.s === "account") {
      store.view = f.s;
    }
    if (f.s === "coin" || f.s === "audit") {
      store.view = f.s;
      if (store.mint) {
        if (store.view === "coin") ensureCoin(store.mint);
        if (store.view === "audit") ensureAudit(store.mint);
      }
    }
    render();
  });

  boot();
})();

