/* Activity Entry for iPhone - screens and syncing. Data rules live in core.js, Dropbox calls in dropbox.js. */
(function () {
  "use strict";
  const C = window.AECore, D = window.AEDropbox, LS = D.LS, N = window.AENames;
  const CFG = Object.assign({ dropboxAppKey: "" }, window.AE_CONFIG || {});
  const LOCK_AFTER_MS = 15 * 60 * 1000;
  const SYNC_EVERY_MS = 60 * 1000;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (v) => "$" + Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // ================================================================== local storage (IndexedDB for the big things)
  const idb = {
    db: null,
    open() {
      if (this.db) return Promise.resolve(this.db);
      return new Promise((res, rej) => {
        const r = indexedDB.open("activity-entry", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("kv");
        r.onsuccess = () => { this.db = r.result; res(this.db); };
        r.onerror = () => rej(r.error);
      });
    },
    async tx(mode, fn) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const t = db.transaction("kv", mode); const st = t.objectStore("kv"); const out = fn(st);
        t.oncomplete = () => res(out && "result" in out ? out.result : undefined);
        t.onerror = () => rej(t.error);
      });
    },
    get(k) { return this.tx("readonly", (s) => s.get(k)); },
    set(k, v) { return this.tx("readwrite", (s) => s.put(v, k)); },
    del(k) { return this.tx("readwrite", (s) => s.delete(k)); },
    keys() { return this.tx("readonly", (s) => s.getAllKeys()); },
  };

  // ================================================================== state
  const S = {
    settings: LS.get("settings") || {},       // phoneName, folder, lock, credId, appKey
    own: null,                                 // this phone's file (entries + deleted)
    ownLists: null,                            // this phone's Lists file (new clients / matters)
    files: {},                                 // other computers' files: name -> {rev, kind, parsed}
    model: null,
    editing: null,
    syncing: false, syncAgain: false,
    lastError: LS.get("syncError") || "",
  };
  const saveSettings = () => LS.set("settings", S.settings);
  const unsynced = () => new Set(LS.get("unsynced") || []);
  const setUnsynced = (s) => LS.set("unsynced", [...s]);
  const last = () => Object.assign({ client: "", matter: {}, case: {} }, LS.get("last") || {});

  const folder = () => S.settings.folder;
  const ownFileName = () => `${C.DATA_PREFIX}${C.safeName(S.settings.phoneName)}.json`;
  const ownListsName = () => `Lists - ${C.safeName(S.settings.phoneName)}.json`;
  const ownPath = () => `${folder()}/Data/${ownFileName()}`;
  const ownListsPath = () => `${folder()}/Lists/${ownListsName()}`;
  const emptyLists = () => ({ clients: {}, matters: [], activities: [] });

  // ================================================================== the combined picture
  function buildModel() {
    const listsFiles = [];
    const dataFiles = [];
    for (const [name, f] of Object.entries(S.files)) {
      if (f.kind === "lists") listsFiles.push({ name, data: f.parsed });
      else if (f.kind === "clientlist") continue;
      else if (f.parsed) dataFiles.push(Object.assign({ name }, f.parsed));
    }
    listsFiles.push({ name: ownListsName(), data: S.ownLists || emptyLists() });
    const ownRes = C.readPhoneData(ownFileName(), S.own || C.emptyOwn(S.settings.phoneName));
    dataFiles.push(Object.assign({ name: ownFileName() }, ownRes));
    const changes = new C.ListChanges(listsFiles);
    const merged = C.mergeAll(dataFiles, changes);
    const lists = C.loadLists(listsFiles, merged.entries, changes);
    const all = C.allNames(listsFiles, merged.entries, changes);
    const caseIdx = C.caseIndex(merged.entries, C.caseRecords(listsFiles, changes));
    const clf = S.files[C.CLIENT_LIST_NAME];                       // Client Intake's client list (1.1.0)
    const cl = clf && clf.kind === "clientlist" ? C.parseClientList(clf.parsed) : null;
    const ids = C.clientIds(listsFiles, changes, cl);
    const nots = new Set(cl ? [...cl.notClients].map((n) => changes.canon("client", n)) : []);
    const extra = C.intakeExtra(lists.clients, ids, cl);
    S.model = { changes, entries: merged.entries, issues: merged.issues, lists, all, caseIdx, cl, ids, nots, extra,
      defaultActivity: C.defaultActivity(changes, lists.activities) };
    return S.model;
  }

  // ================================================================== Dropbox sync
  async function loadLocal() {
    S.own = (await idb.get("own")) || C.emptyOwn(S.settings.phoneName);
    S.ownLists = (await idb.get("ownLists")) || emptyLists();
    S.files = (await idb.get("files")) || {};
  }
  async function saveOwn() { S.own.updated = C.isoNow(); await idb.set("own", S.own); }
  async function saveOwnLists() { await idb.set("ownLists", S.ownLists); LS.set("ownListsDirty", true); }

  function parseFile(kind, name, buffer) {
    if (kind === "lists" || kind === "clientlist") {
      try { return JSON.parse(new TextDecoder().decode(buffer)); } catch (e) { return {}; }
    }
    if (kind === "phone") {
      let data = null;
      try { data = JSON.parse(new TextDecoder().decode(buffer)); } catch (e) { /* unreadable */ }
      return C.readPhoneData(name, data);
    }
    try {
      const wb = XLSX.read(new Uint8Array(buffer), { type: "array", cellDates: false, cellFormula: false, cellHTML: false });
      const sheets = {};
      for (const sn of wb.SheetNames) {
        if (sn !== "Entries" && sn !== "Corrections" && sn !== wb.SheetNames[0]) continue;
        sheets[sn] = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: null, blankrows: true });
      }
      return C.readWorkbookData(name, sheets);
    } catch (e) {
      return { entries: [], corrs: [], issues: [`Could not read '${name}': ${e.message}`] };
    }
  }

  /** Write this phone's file (and Lists file) if they changed, combining with the copy in Dropbox first. */
  async function pushOwn() {
    if (LS.get("ownDirty")) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const meta = await D.metadata(ownPath());
        if (meta && meta.rev !== LS.get("ownRev")) {
          const { buffer } = await D.download(ownPath());
          let remote = null;
          try { remote = JSON.parse(new TextDecoder().decode(buffer)); } catch (e) { /* ignore a damaged copy */ }
          if (remote && remote.format === C.PHONE_FORMAT) S.own = C.mergeOwn(S.own, remote);
        }
        const sent = new Set((S.own.entries || []).map((e) => e.id).concat(Object.keys(S.own.deleted || {})));
        S.own.app_version = C.PHONE_APP_VERSION;
        S.own.updated = C.isoNow();
        const text = JSON.stringify(S.own, null, 1);
        try {
          const res = await D.upload(ownPath(), text, meta ? meta.rev : null);
          LS.set("ownRev", res.rev);
          await idb.set("own", S.own);
          const u = unsynced();
          for (const id of sent) u.delete(id);
          setUnsynced(u);
          LS.set("ownDirty", u.size > 0);
          break;
        } catch (e) {
          if (!e.conflict || attempt === 2) throw e;      // changed meanwhile: read it again and retry
        }
      }
    }
    if (LS.get("ownListsDirty")) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const meta = await D.metadata(ownListsPath());
        let base = {};
        if (meta && meta.rev !== LS.get("ownListsRev")) {
          try { base = JSON.parse(new TextDecoder().decode((await D.download(ownListsPath())).buffer)); } catch (e) { base = {}; }
          S.ownLists = mergeLists(base, S.ownLists);
        }
        S.ownLists.updated = C.isoNow();
        try {
          const res = await D.upload(ownListsPath(), JSON.stringify(S.ownLists, null, 2), meta ? meta.rev : null);
          LS.set("ownListsRev", res.rev);
          await idb.set("ownLists", S.ownLists);
          LS.set("ownListsDirty", false);
          break;
        } catch (e) { if (!e.conflict || attempt === 2) throw e; }
      }
    }
  }

  function mergeLists(a, b) {
    const out = Object.assign({}, a, b);
    out.clients = Object.assign({}, a.clients || {});
    for (const [n, ms] of Object.entries(b.clients || {})) {
      const l = out.clients[n] = [...(out.clients[n] || [])];
      for (const m of ms) if (!l.includes(m)) l.push(m);
    }
    out.matters = [...new Set([...(a.matters || []), ...(b.matters || [])])];
    out.activities = [...new Set([...(a.activities || []), ...(b.activities || [])])];
    out.client_ids = Object.assign({}, a.client_ids || {});
    for (const [k, v] of Object.entries(b.client_ids || {})) if (!out.client_ids[k] || (v.at || "") >= (out.client_ids[k].at || "")) out.client_ids[k] = v;
    out.removed = Object.assign({}, a.removed || {});
    for (const [k, v] of Object.entries(b.removed || {})) if (!out.removed[k] || (v.at || "") > (out.removed[k].at || "")) out.removed[k] = v;
    return out;
  }

  /** Read the other computers' files that changed since last time. */
  async function pullOthers() {
    const want = {};
    const add = (list, dir) => {
      for (const m of list) {
        if (m[".tag"] !== "file") continue;
        const n = m.name;
        if (n.startsWith("~") || n.startsWith(".")) continue;
        const ln = n.toLowerCase();
        if (dir === "Data") {
          if (ln === ownFileName().toLowerCase()) continue;
          if (ln.endsWith(".xlsx")) want[n] = { kind: "xlsx", rev: m.rev, path: m.path_lower };
          else if (ln.endsWith(".json")) want[n] = { kind: "phone", rev: m.rev, path: m.path_lower };
        } else if (ln.endsWith(".json") && ln !== ownListsName().toLowerCase()) {
          want[n] = { kind: "lists", rev: m.rev, path: m.path_lower };
        }
      }
    };
    const safeList = async (p) => { try { return await D.listFolder(p); } catch (e) { if (e.notFound) return []; throw e; } };
    let dataList;
    try { dataList = await D.listFolder(`${folder()}/Data`); }
    catch (e) {
      if (e.notFound) throw new D.DropboxError(`The Activity folder (${folder()}) can't be found in Dropbox. In Settings, tap "Find the Activity folder".`, 409, "folder_missing");
      throw e;
    }
    add(dataList, "Data");
    add(await safeList(`${folder()}/Lists`), "Lists");
    const clMeta = await D.metadata(`${folder()}/${C.CLIENT_LIST_NAME}`);     // Client Intake's list (1.1.0)
    if (clMeta && clMeta[".tag"] === "file") want[C.CLIENT_LIST_NAME] = { kind: "clientlist", rev: clMeta.rev, path: clMeta.path_lower };
    let changed = false;
    for (const n of Object.keys(S.files)) if (!want[n]) { delete S.files[n]; changed = true; }
    for (const [n, w] of Object.entries(want)) {
      const cur = S.files[n];
      if (cur && cur.rev === w.rev) continue;
      const { buffer } = await D.download(w.path);
      S.files[n] = { kind: w.kind, rev: w.rev, parsed: parseFile(w.kind, n, buffer) };
      changed = true;
    }
    if (changed) await idb.set("files", S.files);
    return changed;
  }

  async function sync(reason) {
    if (!D.signedIn() || !S.settings.phoneName) return;
    if (S.syncing) { S.syncAgain = true; return; }
    S.syncing = true;
    renderPill();
    try {
      do {
        S.syncAgain = false;
        try { await pushOwn(); }
        catch (e) {
          if (e.notFound && !(await D.metadata(`${folder()}/Data`)))
            throw new D.DropboxError(`The Activity folder (${folder()}) can't be found in Dropbox. In Settings, tap "Find the Activity folder".`, 409, "folder_missing");
          throw e;
        }
        await pullOthers();
      } while (S.syncAgain);
      S.lastError = "";
      LS.set("lastSync", C.isoNow());
    } catch (e) {
      S.lastError = e.offline ? "offline" : e.signedOut ? "signedout" : (e.message || String(e));
      if (!e.offline) console.warn("sync", reason, e);
    } finally {
      LS.set("syncError", S.lastError);
      S.syncing = false;
      buildModel();
      if (!S.editing) refreshPickers(false);
      renderRecent();
      renderPill();
      if (!$("tab-settings").classList.contains("hidden")) renderSettings();
    }
  }

  // ================================================================== status pill
  function renderPill() {
    const p = $("syncPill");
    const n = unsynced().size;
    p.className = "pill";
    if (S.lastError === "signedout") { p.classList.add("bad"); p.textContent = "Sign in needed"; }
    else if (S.lastError === "offline" || !navigator.onLine) { p.classList.add("wait"); p.textContent = n ? `Offline · ${n} waiting` : "Offline"; }
    else if (S.lastError) { p.classList.add("bad"); p.textContent = "⚠ Problem"; }
    else if (S.syncing && n) { p.classList.add("wait"); p.textContent = "Sending…"; }
    else if (n) { p.classList.add("wait"); p.textContent = `${n} waiting`; }
    else { p.classList.add("ok"); p.textContent = S.syncing ? "Syncing…" : "✓ Synced"; }
  }
  $("syncPill").onclick = () => {
    const n = unsynced().size;
    if (S.lastError === "signedout") return dialog("Sign in to Dropbox", "The Dropbox sign-in has expired. Entries are kept on this phone until you sign in again.",
      [{ label: "Later" }, { label: "Sign in", primary: true, fn: () => setupSignIn("", "again") }]);
    const lastSync = LS.get("lastSync");
    let msg = S.lastError === "offline" ? "No connection to Dropbox right now." : S.lastError ? `Couldn't sync: ${S.lastError}` : "Everything is saved in Dropbox.";
    if (n) msg += `\n\n${n} change${n === 1 ? " is" : "s are"} kept on this phone and will be sent automatically.`;
    if (lastSync) msg += `\n\nLast synced ${fmtWhen(lastSync)}.`;
    dialog("Sync", msg, [{ label: "OK" }, { label: "Sync now", primary: true, fn: () => sync("manual") }]);
  };

  // ================================================================== small UI helpers
  let toastTimer = null;
  function toast(text, ms = 3500) {
    const t = $("toast");
    t.textContent = text;
    t.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add("hidden"), ms);
  }

  function dialog(title, body, buttons = [{ label: "OK", primary: true }], { html = false } = {}) {
    return new Promise((resolve) => {
      $("dialogTitle").textContent = title;
      if (html) $("dialogBody").innerHTML = body; else $("dialogBody").textContent = body;
      const box = $("dialogBtns");
      box.innerHTML = "";
      buttons.forEach((b) => {
        const el = document.createElement("button");
        el.textContent = b.label;
        if (b.primary) el.className = "primary";
        if (b.danger) el.className = "danger";
        el.onclick = () => {
          if (b.validate && !b.validate()) return;
          $("dialog").classList.add("hidden");
          if (b.fn) b.fn();
          resolve(b.value !== undefined ? b.value : b.label);
        };
        box.appendChild(el);
      });
      $("dialog").classList.remove("hidden");
      const inp = $("dialogBody").querySelector("input");
      if (inp) setTimeout(() => inp.focus(), 50);
    });
  }

  /** Bottom sheet with a list to pick from. items: {label, value, sub, sep, header, action} */
  function picker(title, items, current, { search = false } = {}) {
    return new Promise((resolve) => {
      $("sheetTitle").textContent = title;
      const inp = $("sheetSearch");
      inp.value = "";
      inp.classList.toggle("hidden", !search);
      const draw = () => {
        const q = inp.value.trim().toLowerCase();
        const list = $("sheetList");
        list.innerHTML = "";
        let shown = 0;
        for (const it of items) {
          if (q && (it.sep || it.header)) continue;
          if (it.sep) { list.insertAdjacentHTML("beforeend", '<div class="optsep"></div>'); continue; }
          if (it.header) { list.insertAdjacentHTML("beforeend", `<div class="opthdr">${esc(it.header)}</div>`); continue; }
          if (q && !it.action && !(it.search ? it.search(q) : it.label.toLowerCase().includes(q))) continue;
          const b = document.createElement("button");
          b.className = "opt" + (it.action ? " action" : "") + (!it.action && it.value === current ? " sel" : "");
          const label = it.dyn ? it.dyn(inp.value.trim()) : it.label;
          b.innerHTML = `<span>${esc(label)}${it.sub ? ` <span class="osub">${esc(it.sub)}</span>` : ""}</span>`;
          b.onclick = () => { close(); resolve(it.action ? { action: it.action, text: inp.value.trim() } : { value: it.value }); };
          list.appendChild(b);
          if (!it.action) shown++;
        }
        if (q && !shown) list.insertAdjacentHTML("afterbegin", '<div class="opthdr">No matches</div>');
      };
      const close = () => { $("sheet").classList.add("hidden"); inp.oninput = null; };
      inp.oninput = draw;
      $("sheetClose").onclick = () => { close(); resolve(null); };
      $("sheet").onclick = (ev) => { if (ev.target.id === "sheet") { close(); resolve(null); } };
      draw();
      $("sheet").classList.remove("hidden");
      $("sheetList").scrollTop = 0;
      const sel = $("sheetList").querySelector(".sel");
      if (sel) sel.scrollIntoView({ block: "center" });
    });
  }

  const fmtDay = (iso) => {
    const d = new Date(iso.slice(0, 10) + "T12:00:00");
    const o = { weekday: "short", month: "short", day: "numeric" };
    if (d.getFullYear() !== new Date().getFullYear()) o.year = "numeric";
    return d.toLocaleDateString("en-US", o);
  };
  const fmtUS = (iso) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
  const fmtWhen = (iso) => {
    const d = new Date(iso);
    return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  };

  // ================================================================== entry form
  const F = {
    client: "", matter: "", case: "", activity: "", role: "Attorney",
    caseOpts: [], caseShown: false,
  };

  function setPick(el, text, placeholder) {
    el.firstElementChild.textContent = text || placeholder || "";
    el.firstElementChild.className = text ? "" : "ph";
  }

  function setClient(name, keepMatter) {
    F.client = name;
    setPick($("fClient"), name, "Choose client");
    const m = S.model;
    const { linked, others } = C.mattersFor(m.lists, name);
    let choice = "";
    if (keepMatter && (linked.includes(keepMatter) || others.includes(keepMatter))) choice = keepMatter;
    else {
      const lm = last().matter;
      let lastM = null;
      for (const [k, v] of Object.entries(lm)) if (m.changes.canon("client", k) === name) lastM = m.changes.canon("matter", v);
      if (lastM && (linked.includes(lastM) || others.includes(lastM))) choice = lastM;
      else if (linked.length) choice = linked[0];
    }
    setMatter(choice);
  }

  function setMatter(name, keepCase) {
    F.matter = name;
    setPick($("fMatter"), name, "Choose matter");
    refreshCase(keepCase);
    markChanges();
  }

  function refreshCase(keep) {
    const m = S.model;
    const cases = C.casesFor(m.caseIdx, F.client, F.matter);
    let opts = cases.filter(([, i]) => !i.closed);
    const ed = S.editing;
    if (ed && ed.client === F.client && ed.matter === F.matter) {
      const ek = ed.case || "";
      if (!opts.some(([k]) => k === ek)) {
        const info = (cases.find(([k]) => k === ek) || [ek, { label: ek || "1" }])[1];
        opts.push([ek, Object.assign({}, info, { label: `${info.label} (closed)` })]);
        opts.sort((a, b) => C.caseSort(a[0]) - C.caseSort(b[0]));
      }
    }
    F.caseOpts = opts;
    const keys = opts.map(([k]) => k);
    if (keep === undefined && F.caseShown) keep = F.case;
    if (keep === undefined || !keys.includes(keep)) {
      const lc = last().case[`${F.client}||${F.matter}`];
      keep = keys.includes(lc) ? lc : (opts.length ? opts[opts.length - 1][0] : "");
    }
    F.case = keep;
    F.caseShown = opts.length >= 2;
    $("caseWrap").classList.toggle("hidden", !F.caseShown);
    const info = opts.find(([k]) => k === keep);
    setPick($("fCase"), info ? info[1].label : "", "");
  }

  function currentCase() {
    if (F.caseShown) return F.case || "";
    if (F.caseOpts.length) return F.caseOpts[F.caseOpts.length - 1][0];
    const all = C.casesFor(S.model.caseIdx, F.client, F.matter);
    return all[all.length - 1][0];
  }

  function setActivity(a) { F.activity = a; setPick($("fActivity"), a, "Choose activity"); markChanges(); }
  function setRole(r) {
    F.role = r;
    for (const b of $("fRole").children) b.classList.toggle("on", b.dataset.v === r);
    markChanges();
  }
  function setMinutes(total) {
    $("fHours").value = total >= 60 ? Math.floor(total / 60) : (total ? 0 : "");
    $("fMins").value = total ? total % 60 : "";
    markChanges();
  }
  const minutesValue = () => (parseInt($("fHours").value || "0", 10) || 0) * 60 + (parseInt($("fMins").value || "0", 10) || 0);

  function feeChanged() {
    const fee = C.parseMoney($("fFee").value).value;
    const has = !!fee;
    $("fCovered").disabled = has;
    if (has) $("fCovered").checked = false;
    $("coveredText").parentElement.classList.toggle("disabled", has);
    $("coveredHint").textContent = has ? "Time on an entry with a fixed fee is recorded, but not billed by the hour."
      : "Recorded, but not billed by the hour.";
  }

  function refreshPickers(resetActivity) {
    if (!S.model) return;
    if (F.client && !(F.client in S.model.lists.clients) && !(S.editing && S.editing.client === F.client)) {
      const cur = S.model.changes.canon("client", F.client);
      F.client = cur in S.model.lists.clients ? cur : F.client;
      setPick($("fClient"), F.client, "Choose client");
    }
    if (resetActivity || !F.activity) setActivity(S.model.defaultActivity);
    refreshCase(F.case);
    updateTodayBtn();
  }

  function resetForm(keepClient) {
    const m = S.model;
    if (!keepClient) {
      $("fDate").value = C.isoDate();
      let lc = m.changes.canon("client", last().client);
      if (lc && m.changes.isRemoved("client", lc)) lc = "";
      setClient(lc || "");
    }
    setRole("Attorney");
    setActivity(m.defaultActivity);
    setMinutes(0);
    $("fDesc").value = "";
    $("fCost").value = "";
    $("fFee").value = "";
    $("fCovered").checked = false;
    feeChanged();
    refreshCase();
    updateTodayBtn();
    markChanges();
  }

  function updateTodayBtn() { $("todayBtn").classList.toggle("hidden", $("fDate").value === C.isoDate()); }

  // ---- pickers
  /** A client used here that Client Intake has no record for yet (shown with a warning sign). */
  const unlinked = (name) => { const m = S.model; return !!(m && m.cl) && !m.ids[name] && !m.nots.has(name); };

  $("fClient").onclick = async () => {
    const m = S.model;
    const names = [...Object.keys(m.lists.clients), ...Object.keys(m.extra)].sort(N.compare);
    const items = names.map((n) => {
      const id = m.extra[n] ? m.extra[n].id : m.ids[n];
      const rec = id && m.cl ? m.cl.byId[id] : null;
      const others = (rec && rec.other_names) || [];
      return { label: n, value: n, sub: id || (unlinked(n) ? "⚠ not in Client Intake" : ""),
        search: (q) => N.searchMatches(q, n) || n.toLowerCase().includes(q) || others.some((o) => N.searchMatches(q, o)) };
    });
    items.push({ label: "+ New client…", action: "new",
      dyn: (q) => (q ? `+ ${m.cl ? "Not in Client Intake yet" : "New client"}: ${C.standardName(q)}` : "+ New client…") });
    const r = await picker("Client", items, F.client, { search: true });
    if (!r) return;
    if (r.action === "new") return newClient(r.text);
    setClient(r.value);
  };
  $("fMatter").onclick = async () => {
    const { linked, others } = C.mattersFor(S.model.lists, F.client);
    const items = linked.map((v) => ({ label: v, value: v }));
    if (linked.length && others.length) items.push({ sep: true });
    others.forEach((v) => items.push({ label: v, value: v }));
    if (S.editing && S.editing.matter && !linked.includes(S.editing.matter) && !others.includes(S.editing.matter))
      items.push({ label: S.editing.matter, value: S.editing.matter });
    items.push({ label: "+ New matter type…", action: "new" });
    const r = await picker("Matter", items, F.matter);
    if (!r) return;
    if (r.action === "new") return newMatter();
    setMatter(r.value);
  };
  $("fCase").onclick = async () => {
    const r = await picker("Case", F.caseOpts.map(([k, i]) => ({ label: i.label, value: k })), F.case);
    if (r) { F.case = r.value; refreshCase(r.value); markChanges(); }
  };
  $("fActivity").onclick = async () => {
    const acts = [...S.model.lists.activities];
    if (S.editing && S.editing.activity && !acts.includes(S.editing.activity)) acts.push(S.editing.activity);
    const r = await picker("Activity", acts.map((a) => ({ label: a, value: a })), F.activity);
    if (r) setActivity(r.value);
  };
  for (const b of $("fRole").children) b.onclick = () => setRole(b.dataset.v);
  for (const b of document.querySelectorAll(".chips button")) {
    b.onclick = () => {
      const mm = +b.dataset.m;
      if (mm >= 60) $("fHours").value = mm / 60; else { $("fMins").value = mm; if (!$("fHours").value) $("fHours").value = 0; }
      markChanges();
    };
  }
  $("todayBtn").onclick = () => { $("fDate").value = C.isoDate(); updateTodayBtn(); markChanges(); };
  $("fDate").onchange = () => { if (!$("fDate").value) $("fDate").value = C.isoDate(); updateTodayBtn(); markChanges(); };
  for (const id of ["fHours", "fMins"]) {
    $(id).onfocus = (ev) => setTimeout(() => ev.target.select(), 0);
    $(id).oninput = markChanges;
  }
  for (const id of ["fDesc", "fCost", "fFee"]) $(id).oninput = () => { if (id === "fFee") feeChanged(); markChanges(); };
  $("fCovered").onchange = markChanges;

  // ---- new client / matter type
  /** The client to use for a typed name: [name, Client ID to keep or null, kind] - kind "known", "intake",
      "removed" or "new". Any name order finds a client ("dong hyun kim" -> "Kim, Dong Hyun"). Same as Windows. */
  function resolveClient(text) {
    const m = S.model, ch = m.changes;
    text = text.split(/\s+/).filter(Boolean).join(" ");
    text = ch.canon("client", text) || text;
    const find = (pool, t) => pool.find((c) => c.toLowerCase() === t.toLowerCase());
    const known = Object.keys(m.lists.clients), extra = Object.keys(m.extra);
    const removed = Object.keys(m.all.clients).filter((c) => ch.isRemoved("client", c));
    const other = C.looksLikePerson(text) ? N.readings(text)[1] : null;
    for (const t of [...new Set([text, C.standardName(text), other ? N.standard(other) : null].filter(Boolean))]) {
      let hit = find(known, t); if (hit) return [hit, null, "known"];
      hit = find(extra, t); if (hit) return [hit, m.extra[hit].id, "intake"];
      hit = find(removed, t); if (hit) return [hit, null, "removed"];
    }
    return [text, null, "new"];
  }

  function nameHint(text) {
    const t = String(text || "").split(/\s+/).filter(Boolean).join(" ");
    if (!t) return "";
    const [name, id, kind] = resolveClient(t);
    const m = S.model;
    if (kind !== "new") return `${name !== t ? "→ " + esc(name) + " · " : ""}${id || m.ids[name] ? "Client Intake " + esc(id || m.ids[name]) : kind === "removed" ? "removed from the list" : "already a client"}`;
    if (!C.looksLikePerson(t)) return "New client – kept as typed";
    const [first, other] = N.readings(t);
    let h = `Family name <b>${esc(first.family)}</b>${first.given ? `, given names <b>${esc(first.given)}</b>` : ""}`;
    if (other && N.looksFamilyFirst(t)) h += `<br><span class="warn">Family name first? Type a comma after it.</span>`;
    if (m.cl) h += `<br><span class="warn">⚠ Not in Client Intake yet – billing needs a client record there.</span>`;
    return h;
  }

  async function newClient(prefill) {
    const m = S.model;
    const opts = m.lists.matters.map((x) => `<option>${esc(x)}</option>`).join("");
    let name = "", matter = "";
    const pending = dialog("New client", `<label>CLIENT NAME</label><input id="ncName" class="field" value="${esc(prefill || "")}" autocapitalize="words" autocomplete="off">` +
      `<div id="ncHint" class="hint"></div><label>MATTER</label><select id="ncMatter" class="field">${opts}</select>`,
      [{ label: "Cancel" }, { label: "Add", primary: true, value: "add",
        validate: () => {
          name = $("ncName").value.split(/\s+/).filter(Boolean).join(" ");
          matter = $("ncMatter").value;
          return !!name;
        } }], { html: true });
    const upd = () => { $("ncHint").innerHTML = nameHint($("ncName").value); };
    $("ncName").oninput = upd;
    upd();
    const r = await pending;
    if (r !== "add") return;
    const ch = m.changes;
    let [use, cid, kind] = resolveClient(name);
    if (kind === "removed") {
      const r2 = await dialog("Removed client", `'${use}' was removed from the client list. Put it back?`, [{ label: "No" }, { label: "Put back", primary: true }]);
      if (r2 !== "Put back") return;
      S.ownLists.removed = S.ownLists.removed || {};
      S.ownLists.removed[`client||${use}`] = { removed: false, at: C.isoNow(), by: S.settings.phoneName };
    } else if (kind === "new") {
      const std = C.standardName(use);
      const other = C.looksLikePerson(use) ? N.readings(use)[1] : null;
      const ff = other && N.looksFamilyFirst(use) && N.standard(other) !== std;
      if (std !== use || ff) {                     // offer the firm's form of the name
        const btns = [{ label: std, primary: true, value: std }];
        if (ff) btns.push({ label: N.standard(other), value: N.standard(other) });
        if (use !== std) btns.push({ label: "As typed", value: use });
        const pick = await dialog("Client name", `How should '${use}' be stored? The firm writes names family name first, with a comma.` +
          (m.cl ? "\n\nIt is marked 'not in Client Intake yet' until it is linked there." : ""), btns);
        use = pick;
      }
    }
    if (ch.canon("client", use) !== use) use = ch.canon("client", use);
    const l = S.ownLists.clients[use] = S.ownLists.clients[use] || [];
    if (matter && !l.includes(matter)) l.push(matter);
    if (cid) {
      S.ownLists.client_ids = S.ownLists.client_ids || {};
      S.ownLists.client_ids[use] = { id: cid, at: C.isoNow(), by: S.settings.phoneName };
    }
    await saveOwnLists();
    buildModel();
    setClient(use, matter);
    toast(`Added client ${use} (${matter}).`);
    sync("lists");
  }

  async function newMatter() {
    let text = "";
    const r = await dialog("New matter type", '<label>MATTER TYPE (e.g. Criminal)</label><input id="nmName" class="field" autocapitalize="words" autocomplete="off">',
      [{ label: "Cancel" }, { label: "Add", primary: true, value: "add", validate: () => { text = $("nmName").value.split(/\s+/).filter(Boolean).join(" "); return !!text; } }],
      { html: true });
    if (r !== "add") return;
    const m = S.model;
    text = m.changes.canon("matter", text);
    const known = m.all.matters.find((x) => x.toLowerCase() === text.toLowerCase());
    if (known && m.changes.isRemoved("matter", known)) {
      const r2 = await dialog("Removed matter type", `'${known}' was removed from the list. Put it back?`, [{ label: "No" }, { label: "Put back", primary: true }]);
      if (r2 !== "Put back") return;
      S.ownLists.removed = S.ownLists.removed || {};
      S.ownLists.removed[`matter||${known}`] = { removed: false, at: C.isoNow(), by: S.settings.phoneName };
    } else if (!known) {
      S.ownLists.matters.push(text);
    }
    await saveOwnLists();
    buildModel();
    setMatter(known || text);
    sync("lists");
  }

  // ---- change hints while editing
  function formValues() {
    return {
      date: $("fDate").value, role: F.role, client: F.client, matter: [F.matter, currentCase()].join("\u0001"),
      activity: F.activity, time: minutesValue(), desc: $("fDesc").value.trim(),
      cost: C.parseMoney($("fCost").value).value || null, fee: C.parseMoney($("fFee").value).value || null,
      covered: $("fCovered").checked && !$("fCovered").disabled,
    };
  }
  function markChanges() {
    const e = S.editing;
    const fields = { date: [$("fDate").parentElement], role: [], client: [$("fClient")], matter: [$("fMatter"), $("fCase")],
      activity: [$("fActivity")], time: [$("fHours").parentElement, $("fMins").parentElement], desc: [$("fDesc")],
      cost: [$("fCost").parentElement], fee: [$("fFee").parentElement], covered: [] };
    const labels = { date: "DATE", role: "ROLE", client: "CLIENT", matter: "MATTER", activity: "ACTIVITY", time: "LENGTH OF TIME",
      desc: "DESCRIPTION", cost: "OUT-OF-POCKET COST", fee: "FIXED FEE" };
    const now = e ? formValues() : {};
    const orig = e ? { date: e.date, role: e.role, client: e.client, matter: [e.matter, e.case || ""].join("\u0001"), activity: e.activity,
      time: e.minutes, desc: e.description || "", cost: e.cost || null, fee: e.fee || null, covered: !!e.covered && !e.fee } : {};
    const shown = { date: fmtUS, time: C.fmtDuration, cost: (v) => (v ? money(v) : "none"), fee: (v) => (v ? money(v) : "none"),
      desc: (v) => (v.length > 30 ? v.slice(0, 30) + "…" : v || "blank"),
      matter: (v) => { const [mt, cs] = v.split("\u0001"); return C.matterDisplay(S.model.caseIdx, e.client, mt, cs); } };
    for (const k of Object.keys(fields)) {
      const changed = !!e && now[k] !== orig[k];
      const lab = document.querySelector(`.lbl[data-f="${k}"]`);
      if (lab && labels[k]) lab.innerHTML = esc(labels[k]) + (changed ? `<span class="was">was ${esc((shown[k] || String)(orig[k]))}</span>` : "");
      for (const w of fields[k]) w.classList.toggle("changed", changed);
    }
    const cov = !!e && now.covered !== orig.covered;
    $("coveredText").textContent = "Time covered by a fixed fee" + (cov ? ` (was ${orig.covered ? "on" : "off"})` : "");
  }

  // ---- save
  function formMsg(text, ok) {
    const el = $("formMsg");
    el.textContent = text;
    el.className = "formmsg " + (ok ? "ok" : "err");
    clearTimeout(formMsg.t);
    formMsg.t = setTimeout(() => { if (el.textContent === text) el.textContent = ""; }, 6000);
  }

  async function save() {
    if (timerStart()) {
      const mins = timerMinutes();
      const r = await dialog("Timer still running", `Stop the timer and use its time (${C.fmtDuration(mins)})?`,
        [{ label: "Cancel" }, { label: "Stop & use", primary: true }]);
      if (r !== "Stop & use") return;
      stopTimer();
    }
    const m = S.model;
    const minutes = minutesValue();
    const raw = $("fDesc").value;
    const oldDesc = (S.editing && S.editing.description) || "";
    const norm = (s) => s.split(/\s+/).filter(Boolean).join(" ");
    const desc = S.editing && norm(raw) === norm(oldDesc) ? oldDesc.trim() : C.tidyDescription(raw);
    const cost = C.parseMoney($("fCost").value), fee = C.parseMoney($("fFee").value);
    const feeVal = fee.value || null;
    const v = { client: F.client, matter: F.matter, activity: F.activity, minutes, description: desc,
      cost: cost.value, fee: feeVal, costError: cost.error, feeError: fee.error };
    const err = C.validate(v);
    if (err) { formMsg(err, false); return; }
    const covered = $("fCovered").checked && !feeVal && minutes > 0;
    const client = F.client, matter = F.matter, cs = currentCase();
    if (!(m.lists.clients[client] || []).includes(matter)) {          // remember the pair, as on Windows
      const l = S.ownLists.clients[client] = S.ownLists.clients[client] || [];
      if (!l.includes(matter)) { l.push(matter); await saveOwnLists(); }
    }
    if (m.extra[client] && !m.ids[client]) {                          // a Client Intake client: keep its Client ID
      S.ownLists.client_ids = S.ownLists.client_ids || {};
      S.ownLists.client_ids[client] = { id: m.extra[client].id, at: C.isoNow(), by: S.settings.phoneName };
      await saveOwnLists();
    }
    const values = { date: $("fDate").value || C.isoDate(), role: F.role, minutes, activity: F.activity, client, matter,
      case: cs, description: desc, cost: cost.value, fee: feeVal, covered };
    const u = unsynced();
    if (S.editing) {
      const id = S.editing.id;
      const i = S.own.entries.findIndex((x) => x.id === id);
      if (i >= 0) {
        S.own.entries[i] = Object.assign({}, S.own.entries[i], values,
          { modified_at: C.isoNow(), modified_on: S.settings.phoneName, version: `iPhone ${C.PHONE_APP_VERSION}` });
        u.add(id);
      }
      finishEdit();
      formMsg(`✓ Changes saved: ${client} / ${C.matterDisplay(m.caseIdx, client, matter, cs)} - ${values.activity}`, true);
    } else {
      const e = Object.assign({ id: C.newId(S.settings.phoneName) }, values, { entered_at: C.isoNow(),
        computer: S.settings.phoneName, version: `iPhone ${C.PHONE_APP_VERSION}`, modified_at: null, modified_on: "" });
      S.own.entries.push(e);
      u.add(e.id);
      const l = last();
      l.client = client; l.matter[client] = matter; l.case[`${client}||${matter}`] = cs;
      LS.set("last", l);
      let extra = minutes ? C.fmtDuration(minutes) : "";
      if (feeVal) extra += (extra ? ", " : "") + `fixed fee ${money(feeVal)}`;
      if (cost.value) extra += (extra ? ", " : "") + `cost ${money(cost.value)}`;
      formMsg(`✓ Saved: ${client} / ${C.matterDisplay(m.caseIdx, client, matter, cs)} - ${values.activity}, ${extra}`, true);
      resetForm(true);
    }
    setUnsynced(u);
    LS.set("ownDirty", true);
    await saveOwn();
    buildModel();
    refreshCase();
    renderRecent();
    renderPill();
    window.scrollTo({ top: 0, behavior: "smooth" });
    sync("save");
  }
  $("saveBtn").onclick = save;

  // ---- editing this phone's own entries
  function startEdit(e) {
    S.editing = e;
    document.body.classList.add("editing");
    $("editBand").classList.remove("hidden");
    $("editDetail").textContent = `${fmtDay(e.date)} · made on this phone`;
    $("deleteBtn").classList.remove("hidden");
    $("saveBtn").textContent = "Save changes";
    $("saveBtn").classList.add("editing");
    $("timerCard").classList.add("hidden");
    $("pageTitle").textContent = "Edit entry";
    $("fDate").value = e.date;
    setRole(e.role || "Attorney");
    setClient(e.client, e.matter);
    if (F.matter !== e.matter) setMatter(e.matter);
    refreshCase(e.case || "");
    setActivity(e.activity);
    setMinutes(e.minutes);
    $("fDesc").value = e.description || "";
    $("fCost").value = e.cost ? e.cost.toFixed(2) : "";
    $("fFee").value = e.fee ? e.fee.toFixed(2) : "";
    $("fCovered").checked = !!e.covered;
    feeChanged();
    updateTodayBtn();
    showTab("new");
    markChanges();
    window.scrollTo({ top: 0 });
  }

  function finishEdit() {
    S.editing = null;
    document.body.classList.remove("editing");
    $("editBand").classList.add("hidden");
    $("deleteBtn").classList.add("hidden");
    $("saveBtn").textContent = "Save entry";
    $("saveBtn").classList.remove("editing");
    $("timerCard").classList.remove("hidden");
    if (!$("tab-new").classList.contains("hidden")) $("pageTitle").textContent = "New entry";
    resetForm(false);
  }
  $("cancelEdit").onclick = () => { finishEdit(); formMsg("Edit cancelled - the entry was not changed.", true); };

  $("deleteBtn").onclick = async () => {
    const e = S.editing;
    if (!e) return;
    let what = `${fmtUS(e.date)}  ${e.client} / ${C.matterDisplay(S.model.caseIdx, e.client, e.matter, e.case)}  ${e.activity}`;
    if (e.minutes) what += `  ${C.fmtDuration(e.minutes)}`;
    if (e.fee) what += `  fixed fee ${money(e.fee)}`;
    if (e.cost) what += `  cost ${money(e.cost)}`;
    const r = await dialog("Delete this entry?", what, [{ label: "Cancel" }, { label: "Delete", danger: true }]);
    if (r !== "Delete") return;
    S.own.entries = S.own.entries.filter((x) => x.id !== e.id);
    S.own.deleted[e.id] = { at: C.isoNow(), by: S.settings.phoneName };
    const u = unsynced(); u.add(e.id); setUnsynced(u);
    LS.set("ownDirty", true);
    await saveOwn();
    finishEdit();
    buildModel();
    renderRecent();
    renderPill();
    formMsg("✓ Entry deleted.", true);
    sync("delete");
  };

  // ================================================================== timer
  const timerStart = () => LS.get("timer");
  const timerMinutes = () => Math.max(1, Math.ceil((Date.now() - timerStart()) / 60000));
  function renderTimer() {
    const st = timerStart();
    const card = $("timerCard"), btn = $("timerBtn");
    card.classList.toggle("run", !!st);
    $("timerNote").classList.toggle("hidden", !st);
    if (st) {
      const s = Math.floor((Date.now() - st) / 1000);
      $("timerClock").textContent = `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
      $("timerLabel").textContent = `TIMER RUNNING · STARTED ${new Date(st).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toUpperCase()}`;
      btn.className = "btn stop"; btn.textContent = "■ Stop";
    } else {
      $("timerClock").textContent = "0:00:00";
      $("timerLabel").textContent = "TIMER";
      btn.className = "btn start"; btn.textContent = "▶ Start";
    }
  }
  function stopTimer() {
    const mins = timerMinutes();
    LS.del("timer");
    setMinutes(mins);
    renderTimer();
    formMsg(`Timer stopped: ${C.fmtDuration(mins)} filled in.`, true);
  }
  $("timerBtn").onclick = () => {
    if (timerStart()) stopTimer();
    else { LS.set("timer", Date.now()); renderTimer(); }
  };
  setInterval(() => { if (timerStart()) renderTimer(); }, 1000);

  // ================================================================== recent list
  function renderRecent() {
    if (!S.model) return;
    const u = unsynced();
    const rows = C.recent(S.model.entries);
    const box = $("recentList");
    if (!rows.length) { box.innerHTML = '<div class="empty">No entries yet.</div>'; return; }
    let html = "", lastDay = null;
    const today = C.isoDate();
    for (const e of rows) {
      if (e.date !== lastDay) {
        lastDay = e.date;
        html += `<div class="date">${e.date === today ? "TODAY · " : ""}${esc(fmtDay(e.date).toUpperCase())}</div>`;
      }
      const own = e.source === ownFileName();
      const pend = own && u.has(e.id);
      const notHourly = e.minutes && (e.fee || e.covered);
      const amt = [];
      if (e.minutes) amt.push(C.fmtDuration(e.minutes) + (notHourly ? " (fee)" : ""));
      if (e.fee) amt.push(`fee ${money(e.fee)}`);
      if (e.cost) amt.push(money(e.cost));
      const who = own ? "THIS PHONE" : (e.computer || e.source.replace(/^Activity Data - |\.(xlsx|json)$/g, "")).toUpperCase();
      html += `<button class="ent${pend ? " pend" : ""}" data-id="${esc(e.id)}">
        <div class="l1"><span>${unlinked(e.client) ? '<span class="warn" title="Not in Client Intake yet">⚠ </span>' : ""}${esc(e.client)}<span class="src">${e.modified_at ? "✎ " : ""}${esc(who)}</span></span><span class="amt">${esc(amt.join(" · "))}</span></div>
        <div class="l2">${esc(C.matterDisplay(S.model.caseIdx, e.client, e.matter, e.case))} · ${esc(e.activity)}${e.role === "Paralegal" ? " · Paralegal" : ""}</div>
        <div class="l3">${pend ? "Waiting to be sent - saved on this phone" : esc(e.description || "")}</div></button>`;
    }
    box.innerHTML = html;
    for (const b of box.querySelectorAll(".ent")) {
      b.onclick = () => {
        const e = S.model.entries.find((x) => x.id === b.dataset.id);
        if (!e) return;
        if (e.source === ownFileName()) {
          const mine = S.own.entries.find((x) => x.id === e.id);
          if (!mine) return;
          const cur = {};          // current values: a computer may have corrected this entry
          for (const k of ["date", "role", "minutes", "activity", "client", "matter", "case", "description", "cost", "fee", "covered"]) cur[k] = e[k];
          startEdit(Object.assign({}, mine, cur));
        } else {
          dialog("Made on " + (e.computer || "another computer"),
            `${fmtUS(e.date)} · ${e.client} / ${C.matterDisplay(S.model.caseIdx, e.client, e.matter, e.case)}\n${e.activity}${e.minutes ? " · " + C.fmtDuration(e.minutes) : ""}` +
            `${e.description ? "\n" + e.description : ""}\n\nEntries from other computers can be changed on a computer (double-click the entry in Activity Entry).`);
        }
      };
    }
  }

  // ================================================================== settings tab
  function renderSettings() {
    const info = D.info();
    const ls = LS.get("lastSync");
    const row = (k, v) => `<div class="set-row"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`;
    $("settingsBody").innerHTML = `
      <div class="set-title">THIS PHONE</div>
      <div class="card">${row("Name", S.settings.phoneName)}${row("Saves to", "Data\\" + ownFileName())}${row("Entries made here", String(S.own.entries.length))}</div>
      <div class="set-title">DROPBOX</div>
      <div class="card">${row("Account", info.email || "—")}${row("Activity folder", folder())}${row("Last synced", ls ? fmtWhen(ls) : "not yet")}
        ${row("Client Intake list", S.model && S.model.cl ? `${S.model.cl.active().length} clients` : "not found")}
        ${row("Waiting to be sent", String(unsynced().size))}
        <button id="setSync" class="btn secondary wide">Sync now</button>
        <button id="setFind" class="btn secondary wide">Find the Activity folder</button></div>
      <div class="set-title">SECURITY</div>
      <div class="card"><div class="row toggle-row"><span>Face ID / Touch ID to open the app</span>
        <label class="switch"><input id="setLock" type="checkbox" ${S.settings.lock ? "checked" : ""}><span></span></label></div>
        <div class="hint">Asked when the app has not been used for 15 minutes.</div></div>
      <div class="set-title">ABOUT</div>
      <div class="card">${row("Version", C.PHONE_APP_VERSION)}${S.model && S.model.issues.length ? row("Notes", S.model.issues.length + " (tap below)") : ""}
        ${S.model && S.model.issues.length ? '<button id="setIssues" class="btn secondary wide">Show notes</button>' : ""}
        <button id="setUpdate" class="btn secondary wide">Check for an update</button>
        <button id="setSignOut" class="btn danger wide">Sign out of Dropbox</button></div>`;
    $("setSync").onclick = () => sync("manual");
    $("setFind").onclick = () => setupFolder(true);
    $("setLock").onchange = async (ev) => {
      if (ev.target.checked) {
        const ok = await registerLock();
        ev.target.checked = ok;
      } else { S.settings.lock = false; S.settings.credId = null; saveSettings(); }
    };
    if ($("setIssues")) $("setIssues").onclick = () => dialog("Notes", S.model.issues.join("\n\n"));
    $("setUpdate").onclick = checkUpdate;
    $("setSignOut").onclick = async () => {
      const n = unsynced().size;
      const r = await dialog("Sign out of Dropbox?", (n ? `${n} change${n === 1 ? " hasn't" : "s haven't"} been sent yet. They stay on this phone and are sent after you sign in again.\n\n` : "") +
        "Entries stay on this phone.", [{ label: "Cancel" }, { label: "Sign out", danger: true }]);
      if (r === "Sign out") { D.signOut(); location.reload(); }
    };
  }

  // ================================================================== tabs
  function showTab(t) {
    for (const n of ["new", "recent", "settings"]) $("tab-" + n).classList.toggle("hidden", n !== t);
    for (const b of document.querySelectorAll(".tabs button")) b.classList.toggle("on", b.dataset.tab === t);
    $("pageTitle").textContent = { new: S.editing ? "Edit entry" : "New entry", recent: "Recent", settings: "Settings" }[t];
    $("pageSub").textContent = t === "recent" ? `Last ${C.RECENT_COUNT} entries · all computers` : `${S.settings.phoneName} · Attorney`;
    if (t === "recent") renderRecent();
    if (t === "settings") renderSettings();
    window.scrollTo({ top: 0 });
  }
  for (const b of document.querySelectorAll(".tabs button")) b.onclick = () => showTab(b.dataset.tab);

  // ================================================================== Face ID / Touch ID lock (a passkey kept on this phone)
  const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
  async function lockAvailable() {
    try { return !!(window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); }
    catch (e) { return false; }
  }
  async function registerLock() {
    if (!(await lockAvailable())) { await dialog("Not available", "This phone can't use Face ID or Touch ID for web apps."); return false; }
    try {
      const cred = await navigator.credentials.create({ publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: "Activity Entry" },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: `Activity Entry - ${S.settings.phoneName}`, displayName: `Activity Entry (${S.settings.phoneName})` },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "discouraged" },
        timeout: 60000, attestation: "none" } });
      S.settings.lock = true;
      S.settings.credId = b64u(cred.rawId);
      saveSettings();
      touch();
      return true;
    } catch (e) {
      await dialog("Face ID not set up", `It wasn't turned on (${e.name === "NotAllowedError" ? "cancelled" : e.message}). You can turn it on later in Settings.`);
      return false;
    }
  }
  const touch = () => LS.set("lastActive", Date.now());
  function needsLock() { return !!S.settings.lock && Date.now() - (LS.get("lastActive") || 0) > LOCK_AFTER_MS; }
  function showLock() { $("lock").classList.remove("hidden"); $("lockMsg").textContent = ""; }
  async function unlock() {
    try {
      await navigator.credentials.get({ publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ type: "public-key", id: unb64u(S.settings.credId) }], userVerification: "required", timeout: 60000 } });
      $("lock").classList.add("hidden");
      touch();
      sync("unlock");
    } catch (e) {
      $("lockMsg").innerHTML = 'Not unlocked - tap the button to try again.<br><br><button id="lockReset" class="linkbtn" style="color:#FFD8B5">Can\'t unlock? Sign in to Dropbox again</button>';
      $("lockReset").onclick = () => { $("lock").classList.add("hidden"); setupSignIn("", "reset"); };
    }
  }
  $("unlockBtn").onclick = unlock;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { if ($("lock").classList.contains("hidden")) touch(); return; }
    if (S.settings.phoneName && D.signedIn()) {
      if (needsLock()) showLock(); else touch();
      if (C.isoDate() !== S.today) { S.today = C.isoDate(); if (!S.editing && $("fDate").value < S.today) { $("fDate").value = S.today; updateTodayBtn(); } }
      renderTimer();
      sync("visible");
    }
  });
  ["touchstart", "click", "keydown"].forEach((ev) => document.addEventListener(ev, () => { if ($("lock").classList.contains("hidden")) touch(); }, { passive: true }));
  window.addEventListener("online", () => { renderPill(); sync("online"); });
  window.addEventListener("offline", renderPill);

  // ================================================================== first-time setup
  const appKey = () => CFG.dropboxAppKey || S.settings.appKey || "";

  function setupView(html) {
    $("main").classList.add("hidden");
    $("setup").classList.remove("hidden");
    $("setupBody").innerHTML = html;
  }

  /** mode: "setup" (first time), "again" (sign-in expired / signed out), "reset" (can't unlock with Face ID) */
  function setupSignIn(msg, mode = "setup") {
    const needKey = !CFG.dropboxAppKey;
    const head = { setup: "STEP 1 OF 3 · DROPBOX", again: "SIGN IN TO DROPBOX", reset: "UNLOCK BY SIGNING IN TO DROPBOX" }[mode];
    const intro = mode === "setup"
      ? "Entries are saved in the firm's Dropbox, in <b>INVOICE MATTER\\Activity</b>, next to the computers' files. Sign in with the Dropbox account that has that folder."
      : mode === "reset" ? "Sign in with this phone's Dropbox account to open the app. Face ID is then turned off - turn it on again in Settings."
      : "Sign in with this phone's Dropbox account. Entries made meanwhile are kept on the phone and sent afterwards.";
    setupView(`<div class="step">${head}</div>
      <div class="card"><p>${intro}</p>
      ${needKey ? `<div class="lbl">DROPBOX APP KEY</div><input id="suKey" class="field" value="${esc(S.settings.appKey || "")}" autocomplete="off" autocapitalize="none" autocorrect="off" placeholder="from the Dropbox App Console">` : ""}
      <button id="suOpen" class="btn save wide">1. Open Dropbox sign-in</button>
      <p class="hint" style="margin-top:12px">Dropbox opens in a browser view. Sign in, tap <b>Allow</b>, then copy the code it shows and come back here (tap Done).</p>
      <div class="lbl mt">2. PASTE THE CODE FROM DROPBOX</div>
      <input id="suCode" class="field" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="code">
      ${msg ? `<div class="err">${esc(msg)}</div>` : ""}
      <button id="suGo" class="btn save wide">Continue</button>
      ${mode !== "setup" && S.settings.phoneName ? '<button id="suBack" class="btn secondary wide">Back</button>' : ""}</div>`);
    $("suOpen").onclick = async () => {
      if (needKey) {
        const k = $("suKey").value.trim();
        if (!k) return;
        S.settings.appKey = k; saveSettings();
      }
      const url = await D.startSignIn(appKey());
      if (!window.open(url, "_blank")) location.assign(url);
    };
    if ($("suBack")) $("suBack").onclick = () => { if (mode === "reset") showLock(); showMain(); };
    $("suGo").onclick = async () => {
      const code = $("suCode").value.trim();
      if (!code) return;
      const prev = D.info();
      let id;
      try { id = await D.finishSignIn(code); } catch (e) { return setupSignIn(e.message, mode); }
      if (prev.account && id !== prev.account && S.settings.phoneName) {
        LS.set("dbx", prev);
        return setupSignIn("That is a different Dropbox account from the one this phone uses. Sign in with the firm's account.", mode);
      }
      if (mode === "reset") {
        S.settings.lock = false; S.settings.credId = null; saveSettings();
        touch();
        toast("Face ID was turned off. Turn it on again in Settings.", 6000);
      }
      S.lastError = "";
      if (!S.settings.folder) return setupFolder();
      if (!S.settings.phoneName) return setupName();
      try { await D.account(); } catch (e) { /* later */ }
      if (!S.started) { await loadLocal(); startMain(); } else { showMain(); sync("signin"); }
    };
  }

  function showMain() { $("setup").classList.add("hidden"); $("main").classList.remove("hidden"); }

  /* Same rules as the computers (shared/firm_folder.py): the path in config.js, then CHRIS FOLDER/INVOICE MATTER
     (or INVOICE MATTER) in each top-level folder, then Dropbox search. Only a folder with a Data folder counts;
     one whose INVOICE MATTER has the "_FIRM DATA.txt" marker wins. Returns [{path, how, marker}], best first. */
  const MARKER = "_FIRM DATA.txt";
  async function activityCandidates() {
    const out = [];
    const check = async (p, how) => {
      p = "/" + String(p || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
      if (p === "/" || out.some((c) => c.path.toLowerCase() === p.toLowerCase())) return;
      const data = await D.metadata(`${p}/Data`);
      if (!data || data[".tag"] !== "folder") return;
      const a = await D.metadata(p);
      const im = a.path_display.replace(/\/[^/]*$/, "");
      out.push({ path: a.path_display, how, marker: !!(await D.metadata(`${im}/${MARKER}`)) });
    };
    if (CFG.activityFolder) await check(CFG.activityFolder, "the firm's usual folder");
    if (!out.length) {
      await check("/CHRIS FOLDER/INVOICE MATTER/Activity", "the usual place");
      await check("/INVOICE MATTER/Activity", "the top of Dropbox");
      if (!out.length) {
        const top = (await D.listFolder("")).filter((m) => m[".tag"] === "folder").slice(0, 60);
        for (const f of top) await check(`${f.path_display}/INVOICE MATTER/Activity`, `in ${f.name}`);
      }
    }
    if (!out.length) {
      const hits = await D.search("INVOICE MATTER");
      for (const m of hits.filter((m) => m[".tag"] === "folder" && m.name.toLowerCase() === "invoice matter"))
        await check(`${m.path_display}/Activity`, "found by searching Dropbox");
    }
    const marked = out.filter((c) => c.marker);
    return marked.length ? marked : out;
  }

  async function setupFolder(again) {
    const head = again ? "ACTIVITY FOLDER" : "STEP 2 OF 3 · ACTIVITY FOLDER";
    setupView(`<div class="step">${head}</div><div class="card"><p>Looking for CHRIS FOLDER\\INVOICE MATTER\\Activity in Dropbox…</p></div>`);
    let cands = [];
    try { await D.account(); cands = await activityCandidates(); } catch (e) { return setupSignIn(e.message, again ? "again" : "setup"); }
    let found = cands.length ? cands[0].path : (S.settings.folder || "");
    const draw = (msg, ok) => {
      const choices = cands.length > 1 ? `<p class="hint">${cands.length} possible folders were found - tap the firm's (normally the one in CHRIS FOLDER):</p>` +
        cands.map((c, i) => `<button class="opt" data-i="${i}"><span>${esc(c.path)} <span class="osub">${esc(c.how)}</span></span></button>`).join("") : "";
      setupView(`<div class="step">${head}</div>
        <div class="card"><p>Signed in as <b>${esc(D.info().email || "")}</b>.</p>
        ${choices}
        <div class="lbl mt">ACTIVITY FOLDER IN DROPBOX</div>
        <input id="suFolder" class="field" value="${esc(found)}" placeholder="/CHRIS FOLDER/INVOICE MATTER/Activity" autocomplete="off" autocapitalize="none" autocorrect="off">
        ${msg ? `<div class="${ok ? "okmsg" : "err"}">${esc(msg)}</div>` : ""}
        <p class="hint">${cands.length === 1 ? `Found (${esc(cands[0].how)}) - check it is the right one.` : cands.length ? "" : "Couldn't find it automatically - type the path as it appears in Dropbox, e.g. /CHRIS FOLDER/INVOICE MATTER/Activity."}</p>
        <button id="suNext" class="btn save wide">${again ? "Use this folder" : "Next"}</button>
        ${again ? '<button id="suBack" class="btn secondary wide">Back</button>' : ""}</div>`);
      for (const b of document.querySelectorAll("#setupBody .opt")) b.onclick = () => { found = cands[+b.dataset.i].path; draw(); };
      if ($("suBack")) $("suBack").onclick = () => { showMain(); showTab("settings"); };
      $("suNext").onclick = async () => {
        const p = "/" + $("suFolder").value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
        let meta = null;
        try { meta = await D.metadata(p); } catch (e) { return draw(e.message); }
        if (!meta || meta[".tag"] !== "folder") { found = $("suFolder").value; return draw("That folder doesn't exist in this Dropbox."); }
        const data = await D.metadata(`${p}/Data`);
        if (!data) { found = p; return draw("That folder has no Data folder - is it the Activity folder?"); }
        const changed = S.settings.folder && S.settings.folder.toLowerCase() !== meta.path_display.toLowerCase();
        S.settings.folder = meta.path_display;
        saveSettings();
        if (again || S.started) {
          if (changed) { S.files = {}; await idb.set("files", S.files); LS.del("ownRev"); LS.del("ownListsRev"); LS.set("ownDirty", true); LS.set("ownListsDirty", true); }
          S.lastError = "";
          showMain(); showTab("settings"); sync("folder");
          return;
        }
        setupName();
      };
    };
    draw();
  }

  async function setupName(msg) {
    if (S.settings.phoneName) return setupLock();
    let files = [];
    try { files = (await D.listFolder(`${folder()}/Data`)).filter((m) => m[".tag"] === "file").map((m) => m.name); } catch (e) { msg = e.message; }
    const taken = (n) => files.find((f) => f.toLowerCase() === `${C.DATA_PREFIX}${C.safeName(n)}`.toLowerCase() + ".xlsx");
    const phone = (n) => files.find((f) => f.toLowerCase() === `${C.DATA_PREFIX}${C.safeName(n)}`.toLowerCase() + ".json");
    const computers = files.filter((f) => /\.(xlsx|json)$/i.test(f) && f.startsWith(C.DATA_PREFIX) && !/conflicted copy/i.test(f))
      .map((f) => f.slice(C.DATA_PREFIX.length).replace(/\.(xlsx|json)$/i, ""));
    setupView(`<div class="step">STEP 3 OF 3 · THIS PHONE'S NAME</div>
      <div class="card"><p>Give this phone a short name, different from the computers and other phones - e.g. <b>Chris iPhone</b>.
        Its entries are saved as <b>Data\\Activity Data - <i>name</i>.json</b>.</p>
      <div class="lbl">PHONE NAME</div>
      <input id="suName" class="field" autocomplete="off" autocapitalize="words" placeholder="e.g. Chris iPhone">
      ${computers.length ? `<p class="hint">Already used: ${esc(computers.join(", "))}</p>` : ""}
      ${msg ? `<div class="err">${esc(msg)}</div>` : ""}
      <button id="suNext" class="btn save wide">Next</button></div>`);
    $("suNext").onclick = async () => {
      const n = $("suName").value.split(/\s+/).filter(Boolean).join(" ");
      if (!n) return;
      if (taken(n)) return setupName(`'${n}' is already used by a computer. Choose another name.`);
      if (phone(n)) {
        const r = await dialog("Phone already set up", `A phone called '${n}' is already set up. If this IS that phone (for example after reinstalling the app), continue and its entries come back. Otherwise choose another name - two phones must never share a name.`,
          [{ label: "Other name" }, { label: "It's this phone", primary: true }]);
        if (r !== "It's this phone") return;
      }
      S.settings.phoneName = n;
      saveSettings();
      setupLock();
    };
  }

  async function setupLock() {
    const avail = await lockAvailable();
    setupView(`<div class="step">ALMOST DONE</div>
      <div class="card"><p>${avail ? "Use <b>Face ID</b> (or Touch ID / passcode) to open the app? It is asked when the app has not been used for 15 minutes."
        : "This phone can't use Face ID for web apps, so the app opens without it."}</p>
      ${avail ? `<div class="row toggle-row"><span>Face ID / Touch ID</span><label class="switch"><input id="suLock" type="checkbox" checked><span></span></label></div>` : ""}
      <button id="suDone" class="btn save wide">Start</button></div>`);
    $("suDone").onclick = async () => {
      if (avail && $("suLock").checked) await registerLock();
      await finishSetup();
    };
  }

  async function finishSetup() {
    setupView(`<div class="card"><p>Getting the client lists and recent entries…</p></div>`);
    await loadLocal();
    try {
      const meta = await D.metadata(ownPath());
      if (meta) {                                  // reinstalled: bring this phone's entries back
        const remote = JSON.parse(new TextDecoder().decode((await D.download(ownPath())).buffer));
        if (remote && remote.format === C.PHONE_FORMAT) { S.own = C.mergeOwn(S.own, remote); LS.set("ownRev", meta.rev); }
      }
      const lm = await D.metadata(ownListsPath());
      if (lm) { S.ownLists = mergeLists(JSON.parse(new TextDecoder().decode((await D.download(ownListsPath())).buffer)), S.ownLists); LS.set("ownListsRev", lm.rev); }
      await idb.set("own", S.own);
      await idb.set("ownLists", S.ownLists);
    } catch (e) { /* offline: carry on, sync later */ }
    touch();
    startMain();
  }

  // ================================================================== start
  function startMain() {
    S.started = true;
    showMain();
    S.today = C.isoDate();
    buildModel();
    resetForm(false);
    renderTimer();
    renderRecent();
    renderPill();
    showTab("new");
    if (needsLock()) { showLock(); setTimeout(unlock, 300); } else touch();
    sync("start");
    setInterval(() => { if (document.visibilityState === "visible") sync("timer"); }, SYNC_EVERY_MS);
  }

  async function checkUpdate() {
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    if (!reg) return location.reload();
    await reg.update();
    if (reg.waiting) { reg.waiting.postMessage("skipWaiting"); return; }
    toast("You have the latest version.");
  }

  function registerSW() {
    if (!("serviceWorker" in navigator) || window.AE_TEST_DROPBOX) return;
    navigator.serviceWorker.register("sw.js").then((reg) => {
      const offer = () => {
        if (!reg.waiting) return;
        dialog("Update ready", "A new version of Activity Entry is ready.", [{ label: "Later" },
          { label: "Restart now", primary: true, fn: () => reg.waiting && reg.waiting.postMessage("skipWaiting") }]);
      };
      if (reg.waiting) offer();
      reg.addEventListener("updatefound", () => {
        const w = reg.installing;
        if (w) w.addEventListener("statechange", () => { if (w.state === "installed" && navigator.serviceWorker.controller) offer(); });
      });
    });
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => { if (!reloaded) { reloaded = true; location.reload(); } });
  }

  async function boot() {
    registerSW();
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* optional */ }
    if (!D.signedIn()) return setupSignIn("", S.settings.phoneName ? "again" : "setup");
    if (!S.settings.folder) return setupFolder();
    if (!S.settings.phoneName) return setupName();
    await loadLocal();
    startMain();
  }

  window.AEApp = { S, sync, buildModel, showTab };     // for testing
  boot();
})();
