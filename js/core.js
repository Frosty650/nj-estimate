/* Activity Entry for iPhone - data rules shared with the Windows app (activity_entry.py 1.9.0).
   Pure functions only (no screen, no network) so they can be tested on their own.
   Keep in step with: ListChanges, Store.read_all/_read_file, all_names/load_lists, case_index,
   matter_display, default_activity, tidy_description, new_entry. */
(function (root) {
  "use strict";

  const N = root.AENames || (typeof require !== "undefined" ? require("./names.js") : null);   // firm_names rule
  const PHONE_APP_VERSION = "1.1.0";
  const CLIENT_LIST_NAME = "Client List.json";      // Client Intake's list, in the Activity folder (not in Lists)
  const DEFAULT_MATTERS = ["Appeal", "Family", "Civil", "Immigration"];
  const DEFAULT_CLIENTS = { "Jeong Sook Choi": [], "Paul Johnson": [] };
  const DEFAULT_ACTIVITIES = ["Phone Call", "Email", "Meeting", "Court Appearance", "Research",
    "Document Preparation", "Negotiation with Opposing Counsel", "Filing", "Serving"];
  const OTHER_ACTIVITY = "Other";
  const DEFAULT_ACTIVITY = "Phone Call";
  const RECENT_COUNT = 30;
  const LIST_KINDS = ["client", "matter", "activity"];
  const DATA_PREFIX = "Activity Data - ";
  const PHONE_FORMAT = "activity-entry-phone";

  // ------------------------------------------------------------------ small helpers
  const pad = (n, w = 2) => String(n).padStart(w, "0");

  function safeName(text) {
    let t = String(text || "").replace(/[<>:"/\\|?*]+/g, "-");
    t = t.replace(/^[ .]+|[ .]+$/g, "");
    return t || "Computer";
  }

  /** Local "naive" date-time string, like Python's datetime.isoformat() without microseconds. */
  function isoNow(d = new Date()) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  function isoDate(d = new Date()) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /** Excel serial number -> "YYYY-MM-DDTHH:MM:SS" (rounded to the second, as the Windows app does). */
  function serialToIso(v) {
    const ms = Math.round((v - 25569) * 86400) * 1000;
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  }

  function parseDate(v) {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "number") return serialToIso(v).slice(0, 10);
    if (v instanceof Date) return isoDate(v);
    const s = String(v).trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
    if (m) {
      let y = +m[3];
      if (m[3].length === 2) y += y < 69 ? 2000 : 1900;
      return `${y}-${pad(+m[1])}-${pad(+m[2])}`;
    }
    return null;
  }

  function parseDt(v) {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "number") return serialToIso(v);
    const s = String(v).trim();
    const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (m) return `${m[1]}T${m[2]}:${m[3]}:${m[4] || "00"}`;
    const d = parseDate(s);
    return d ? `${d}T00:00:00` : null;
  }

  function toNum(v, dflt = 0) {
    if (v === null || v === undefined || v === "") return dflt;
    if (typeof v === "number") return v;
    const n = parseFloat(String(v).replace(/[$,]/g, ""));
    return isNaN(n) ? dflt : n;
  }

  function normCase(v) {
    let t = String(v === null || v === undefined ? "" : v).trim();
    if (t.endsWith(".0")) t = t.slice(0, -2);
    return t === "" || t === "1" ? "" : t;
  }
  function caseSort(k) {
    const s = String(k || "1").trim();
    return /^[+-]?\d+$/.test(s) ? parseInt(s, 10) : 999;
  }

  const fmtDuration = (m) => `${Math.floor(m / 60)}:${pad(m % 60)}`;
  const lower = (s) => String(s).toLowerCase();
  const byLower = (a, b) => (lower(a) < lower(b) ? -1 : lower(a) > lower(b) ? 1 : 0);

  // ------------------------------------------------------------------ description tidy-ups
  const AUTO_FIXES = {
    teh: "the", hte: "the", adn: "and", nad: "and", taht: "that", wiht: "with", waht: "what",
    communicaiton: "communication", communicaitons: "communications", comunication: "communication",
    communciation: "communication", communcation: "communication", commnication: "communication",
    recieve: "receive", recieved: "received", seperate: "separate", definately: "definitely",
    occured: "occurred", untill: "until", wich: "which", thier: "their", becuase: "because",
    beacuse: "because", acheive: "achieve", accomodate: "accommodate", adress: "address",
    agian: "again", arguement: "argument", begining: "beginning", calender: "calendar",
    correspondance: "correspondence", existance: "existence", foward: "forward", goverment: "government",
    independant: "independent", occurence: "occurrence", persue: "pursue", prelimenary: "preliminary",
    recomend: "recommend", refered: "referred", tommorow: "tomorrow", tomorow: "tomorrow",
    documnet: "document", documnets: "documents", clinet: "client", cleint: "client",
    clinets: "clients", cleints: "clients", meetign: "meeting", emial: "email", eamil: "email",
    reveiw: "review", reveiwed: "reviewed", agreemnet: "agreement", contarct: "contract",
    contrcat: "contract", attorny: "attorney", attroney: "attorney", plantiff: "plaintiff",
    defendent: "defendant", heairng: "hearing", hearign: "hearing", filign: "filing",
    oppossing: "opposing", dicussed: "discussed", discusssed: "discussed", discused: "discussed",
    prepard: "prepared", prepaerd: "prepared", reciept: "receipt", neccessary: "necessary",
    necesary: "necessary", sumbit: "submit", sumbitted: "submitted", submited: "submitted",
  };
  const isLowerChar = (c) => c !== c.toUpperCase() && c === c.toLowerCase();
  const isUpperWord = (w) => w === w.toUpperCase() && w !== w.toLowerCase();

  function tidyDescription(text) {
    let t = String(text || "").split(/\s+/).filter(Boolean).join(" ");
    if (!t) return t;
    t = t.replace(/[A-Za-z]+/g, (w) => {
      const r = AUTO_FIXES[w.toLowerCase()];
      if (!r) return w;
      if (isUpperWord(w) && w.length > 1) return r.toUpperCase();
      return w[0] === w[0].toUpperCase() && w[0] !== w[0].toLowerCase() ? r[0].toUpperCase() + r.slice(1) : r;
    });
    t = t.replace(/(?<![\w.'])i(?=$|[\s,;:!?)])/g, "I");
    t = t.replace(/\s+([,.;:!?])/g, "$1");
    t = t.replace(/([,;:])(?=[A-Za-z])/g, "$1 ");
    t = t.replace(/\(\s+/g, "(");
    t = t.replace(/\s+\)/g, ")");
    if (isLowerChar(t[0])) t = t[0].toUpperCase() + t.slice(1);
    const last = t[t.length - 1];
    if (",;:".includes(last)) t = t.slice(0, -1).trimEnd() + ".";
    else if (!".!?".includes(last) && !(t.length > 1 && "\"')".includes(last) && ".!?".includes(t[t.length - 2]))) t += ".";
    return t;
  }

  // ------------------------------------------------------------------ renames / removals
  class ListChanges {
    /** listsFiles: array of {name, data} (parsed Lists JSON), any order. */
    constructor(listsFiles = []) {
      this.renames = [];
      this.removed = {};
      this.defaultActivity = null;
      const seen = new Set();
      const files = [...listsFiles].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const f of files) {
        const d = f.data || {};
        for (const r of d.renames || []) {
          if (!r || !r.kind || !r.old || !r.new || !r.at) continue;
          const key = [r.kind, r.old, r.new, r.at].join("\u0001");
          if (LIST_KINDS.includes(r.kind) && !seen.has(key)) {
            seen.add(key);
            this.renames.push(r);
          }
        }
        for (const [k, v] of Object.entries(d.removed || {})) {
          if (v && typeof v === "object" && (!(k in this.removed) || (v.at || "") > (this.removed[k].at || ""))) this.removed[k] = v;
        }
        const da = d.default_activity;
        if (da && typeof da === "object" && da.value &&
            (!this.defaultActivity || (da.at || "") > (this.defaultActivity.at || ""))) this.defaultActivity = da;
      }
      this.renames.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));   // stable, like Python
    }
    canon(kind, value) {
      if (!value) return value;
      for (const r of this.renames) if (r.kind === kind && r.old === value) value = r.new;
      return value;
    }
    isRemoved(kind, value) {
      const r = this.removed[`${kind}||${value}`];
      return !!(r && r.removed);
    }
  }

  // ------------------------------------------------------------------ reading data files
  const TRUE_WORDS = ["yes", "y", "true", "x", "1"];

  /** rows: array of arrays (first row = headers), as SheetJS sheet_to_json(header:1, raw:true) gives. */
  function readSheetRows(rows) {
    if (!rows || !rows.length) return { idx: {}, body: [] };
    const idx = {};
    rows[0].forEach((h, i) => { if (h !== null && h !== undefined && h !== "") idx[String(h).trim()] = i; });
    return { idx, body: rows.slice(1) };
  }

  function rowFields(g) {
    let client = g("Client");
    client = typeof client === "string" ? client.trim() : client;
    const cost = g("Cost"), fee = g("Fixed Fee");
    return {
      date: parseDate(g("Date")), role: String(g("Role") || ""),
      minutes: Math.round(toNum(g("Hours")) * 60 + toNum(g("Minutes"))),
      activity: String(g("Activity") || ""), client: String(client || ""),
      matter: String(g("Matter") || ""), description: String(g("Description") || ""),
      cost: cost === null || cost === undefined || cost === "" ? null : toNum(cost, null),
      fee: fee === null || fee === undefined || fee === "" ? null : toNum(fee, null),
      case: normCase(g("Case")),
      covered: TRUE_WORDS.includes(String(g("Covered By Fee") || "").trim().toLowerCase()),
      modified_at: parseDt(g("Modified At")),
      modified_on: String(g("Modified On") || ""),
    };
  }

  /** One Windows computer's workbook. sheets: {Entries: rows, Corrections: rows} -> {entries, corrs, issues} */
  function readWorkbookData(fileName, sheets) {
    const out = [], corrs = [], issues = [];
    const stem = fileName.replace(/\.[^.]+$/, "");
    const first = sheets.Entries ? "Entries" : Object.keys(sheets)[0];
    if (first) {
      const { idx, body } = readSheetRows(sheets[first]);
      body.forEach((row, i) => {
        const n = i + 2;
        if (!row || row.every((v) => v === null || v === undefined || v === "")) return;
        const g = (name) => (idx[name] !== undefined && idx[name] < row.length ? row[idx[name]] : null);
        const f = rowFields(g);
        if (!f.date || !f.client) {
          issues.push(`'${fileName}' row ${n}: skipped (missing or unreadable Date/Client).`);
          return;
        }
        const eid = g("Entry ID");
        const e = Object.assign(f, {
          id: eid ? String(eid) : `manual-${stem}-row${n}`,
          entered_at: parseDt(g("Entered At")) || `${f.date}T00:00:00`,
          computer: String(g("Computer") || ""), version: String(g("App Version") || ""), source: fileName,
        });
        if (!eid) e.row = n;
        out.push(e);
      });
    }
    if (sheets.Corrections) {
      const { idx, body } = readSheetRows(sheets.Corrections);
      for (const row of body) {
        const g = (name) => (idx[name] !== undefined && row && idx[name] < row.length ? row[idx[name]] : null);
        if (!row || !g("Target Entry ID")) continue;
        const c = rowFields(g);
        c.id = String(g("Target Entry ID"));
        c.action = String(g("Action") || "").trim().toLowerCase() === "delete" ? "Delete" : "Edit";
        c.source = fileName;
        if (c.modified_at) corrs.push(c);
      }
    }
    return { entries: out, corrs, issues };
  }

  /** A phone's JSON file (this format is also read by the Windows app and Billing). */
  function readPhoneData(fileName, data) {
    const out = [], issues = [];
    if (!data || data.format !== PHONE_FORMAT || !Array.isArray(data.entries)) {
      issues.push(`Could not read '${fileName}': not an Activity Entry phone file.`);
      return { entries: out, corrs: [], issues };
    }
    for (const r of data.entries) {
      const date = parseDate(r.date);
      if (!r.id || !date || !r.client) { issues.push(`'${fileName}': an entry was skipped (missing ID, Date or Client).`); continue; }
      out.push({
        id: String(r.id), date, role: String(r.role || ""), minutes: Math.round(toNum(r.minutes)),
        activity: String(r.activity || ""), client: String(r.client || "").trim(), matter: String(r.matter || ""),
        description: String(r.description || ""),
        cost: r.cost === null || r.cost === undefined || r.cost === "" ? null : toNum(r.cost, null),
        fee: r.fee === null || r.fee === undefined || r.fee === "" ? null : toNum(r.fee, null),
        case: normCase(r.case), covered: !!r.covered,
        modified_at: parseDt(r.modified_at), modified_on: String(r.modified_on || ""),
        entered_at: parseDt(r.entered_at) || `${date}T00:00:00`, computer: String(r.computer || ""),
        version: String(r.version || ""), source: fileName,
      });
    }
    return { entries: out, corrs: [], issues };
  }

  /** Same rules as Store.read_all: real files before conflicted copies, first ID wins, newest correction wins. */
  function mergeAll(fileResults, changes) {
    const issues = [];
    const base = new Map();
    const corrs = [];
    const files = [...fileResults].sort((a, b) => {
      const ca = a.name.toLowerCase().includes("conflicted copy"), cb = b.name.toLowerCase().includes("conflicted copy");
      if (ca !== cb) return ca ? 1 : -1;
      return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0;
    });
    for (const f of files) {
      issues.push(...(f.issues || []));
      for (const e of [...f.entries, ...f.corrs]) for (const k of LIST_KINDS) e[k] = changes.canon(k, e[k]);
      if (f.name.toLowerCase().includes("conflicted copy"))
        issues.push(`Dropbox conflicted copy found: '${f.name}'.`);
      for (const e of f.entries) if (!base.has(e.id)) base.set(e.id, e);
      corrs.push(...f.corrs);
    }
    const newest = new Map();
    for (const c of corrs)
      if (base.has(c.id) && (!newest.has(c.id) || c.modified_at > newest.get(c.id).modified_at)) newest.set(c.id, c);
    const result = [];
    for (let [id, e] of base) {
      const c = newest.get(id);
      if (c && c.modified_at > (e.modified_at || "")) {
        if (c.action === "Delete") continue;
        const m = Object.assign({}, e);
        for (const k of ["date", "role", "minutes", "activity", "client", "matter", "description",
          "cost", "fee", "covered", "case", "modified_at", "modified_on"]) m[k] = c[k];
        if (!m.date) m.date = e.date;
        e = m;
      }
      result.push(e);
    }
    return { entries: result, issues };
  }

  // ------------------------------------------------------------------ lists
  function allNames(listsFiles, entries, changes) {
    const ch = changes;
    const clients = {}; const matters = []; const activities = [];
    const addUnique = (lst, v) => { if (v && !lst.includes(v)) lst.push(v); };
    const addClient = (name, ms) => {
      name = ch.canon("client", name);
      if (!name) return;
      const lst = clients[name] || (clients[name] = []);
      for (let m of ms || []) { m = ch.canon("matter", m); addUnique(lst, m); addUnique(matters, m); }
    };
    for (const [n, ms] of Object.entries(DEFAULT_CLIENTS)) addClient(n, ms);
    for (const m of DEFAULT_MATTERS) addUnique(matters, ch.canon("matter", m));
    for (const a of DEFAULT_ACTIVITIES) addUnique(activities, ch.canon("activity", a));
    const files = [...listsFiles].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const f of files) {
      const d = f.data || {};
      for (const [n, ms] of Object.entries(d.clients || {})) addClient(n, ms);
      for (const m of d.matters || []) addUnique(matters, ch.canon("matter", m));
      for (const a of d.activities || []) addUnique(activities, ch.canon("activity", a));
    }
    for (const e of entries || []) {
      if (e.client) addClient(e.client, [e.matter]);
      addUnique(activities, ch.canon("activity", e.activity));
    }
    const i = activities.indexOf(OTHER_ACTIVITY);
    if (i >= 0) activities.splice(i, 1);
    return { clients, matters, activities };
  }

  /** What the drop-downs offer: current names, removed ones left out, activities A-Z with Other last. */
  function loadLists(listsFiles, entries, changes) {
    const { clients, matters, activities } = allNames(listsFiles, entries, changes);
    const ch = changes;
    const ms = matters.filter((m) => !ch.isRemoved("matter", m));
    const cl = {};
    for (const name of Object.keys(clients).sort(N.compare))            // family-name order (1.1.0)
      if (!ch.isRemoved("client", name)) cl[name] = clients[name].filter((m) => ms.includes(m));
    const acts = activities.filter((a) => !ch.isRemoved("activity", a)).sort(byLower);
    acts.push(OTHER_ACTIVITY);
    return { clients: cl, matters: ms, activities: acts };
  }

  function defaultActivity(changes, activities) {
    const da = changes.defaultActivity;
    let v = changes.canon("activity", da ? da.value : DEFAULT_ACTIVITY);
    if (activities && !activities.includes(v)) v = activities.find((a) => a !== OTHER_ACTIVITY) || OTHER_ACTIVITY;
    return v;
  }

  /** The client's own matters first, then the others (the Windows app shows a separator between). */
  function mattersFor(lists, client) {
    const linked = lists.clients[client] || [];
    return { linked, others: lists.matters.filter((m) => !linked.includes(m)) };
  }

  // ------------------------------------------------------------------ Client Intake (1.1.0, = Windows 1.9.0)
  const PERSON = /^[A-Za-z\u00C0-\u00FF .,'\u2019-]+$/;
  function looksLikePerson(text) {
    const t = String(text || "").split(/\s+/).filter(Boolean).join(" ");
    return !!t && PERSON.test(t) && /[A-Za-z\u00C0-\u00FF]/.test(t);
  }
  /** The stored form of a client name typed in: "Dong Hyun Kim" -> "Kim, Dong Hyun"; "Internal / Admin" as typed. */
  function standardName(text) {
    const t = String(text || "").split(/\s+/).filter(Boolean).join(" ");
    return looksLikePerson(t) ? N.standard(N.parse(t)) : t;
  }

  /** Client Intake's Client List.json (format "client-list") -> {clients, byId, links, notClients, active(), activityName(c)}. */
  function parseClientList(d) {
    if (!d || d.format !== "client-list" || !Array.isArray(d.clients)) return null;
    const clients = d.clients.filter((c) => c && typeof c === "object" && c.id);
    const std = (c) => String(c.standard || N.standard(N.fromParts(c.family || "", c.given || "", c.suffix || ""))).split(/\s+/).filter(Boolean).join(" ");
    const isActive = (c) => (c.status || "active") === "active";
    const counts = {};
    for (const c of clients) if (isActive(c)) { const k = std(c).toLowerCase(); counts[k] = (counts[k] || 0) + 1; }
    const links = {};
    for (const [k, v] of Object.entries(d.activity_links || {})) if (v && v.client_id) links[k] = String(v.client_id);
    return {
      writtenAt: String(d.written_at || ""), clients, links,
      byId: Object.fromEntries(clients.map((c) => [c.id, c])),
      notClients: new Set(Object.keys(d.not_clients || {})),
      active: () => clients.filter(isActive),
      activityName: (c) => { const s = std(c); return counts[s.toLowerCase()] > 1 ? `${s} (${c.id})` : s; },
    };
  }

  /** {current client name: Client ID}: client_ids in every Lists file (newest "at" wins), then Client Intake's links. */
  function clientIds(listsFiles, changes, cl) {
    const best = {};
    const files = [...listsFiles].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const f of files) {
      for (const [name, v] of Object.entries((f.data || {}).client_ids || {})) {
        if (!v || typeof v !== "object" || !v.id) continue;
        const n = changes.canon("client", name);
        if (!(n in best) || (v.at || "") >= best[n][1]) best[n] = [String(v.id), v.at || ""];
      }
    }
    const out = {};
    for (const [n, v] of Object.entries(best)) out[n] = v[0];
    if (cl) for (const [name, id] of Object.entries(cl.links)) { const n = changes.canon("client", name); if (!(n in out)) out[n] = id; }
    return out;
  }

  /** Client Intake's active clients not used in Activity Entry yet: {Activity name: record}, in family-name order. */
  function intakeExtra(clients, ids, cl) {
    if (!cl) return {};
    const have = new Set(Object.keys(clients).map((n) => ids[n]).filter(Boolean));
    const out = [];
    for (const c of cl.active()) {
      const n = cl.activityName(c);
      if (!have.has(c.id) && n && !(n in clients)) out.push([n, c]);
    }
    out.sort((a, b) => N.compare(a[0], b[0]));
    return Object.fromEntries(out);
  }

  // ------------------------------------------------------------------ cases
  function caseRecords(listsFiles, changes) {
    const recs = {};
    const files = [...listsFiles].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const f of files) {
      for (const [k, v] of Object.entries((f.data || {}).cases || {})) {
        const parts = k.split("||");
        if (parts.length !== 3 || !v || typeof v !== "object") continue;
        const ck = `${changes.canon("client", parts[0])}||${changes.canon("matter", parts[1])}||${normCase(parts[2])}`;
        if (!(ck in recs) || (v.at || "") >= (recs[ck].at || "")) recs[ck] = v;
      }
    }
    return recs;
  }

  /** {"client||matter": {caseKey: {label, closed}}} - case 1 (key "") always exists. */
  function caseIndex(entries, records) {
    const idx = {};
    const get = (cl, mt) => idx[`${cl}||${mt}`] || (idx[`${cl}||${mt}`] = {});
    for (const e of entries) { const c = get(e.client, e.matter); if (!c[e.case || ""]) c[e.case || ""] = {}; }
    for (const [ck, v] of Object.entries(records)) {
      const [cl, mt, cs] = ck.split("||");
      const c = get(cl, mt);
      c[cs] = Object.assign(c[cs] || {}, { label: v.label || "", closed: !!v.closed });
    }
    for (const cases of Object.values(idx)) {
      if (!cases[""]) cases[""] = {};
      for (const [k, info] of Object.entries(cases)) { info.label = info.label || (k || "1"); info.closed = !!info.closed; }
    }
    return idx;
  }

  function casesFor(idx, client, matter) {
    const cases = idx[`${client}||${matter}`] || { "": { label: "1", closed: false } };
    return Object.entries(cases).sort((a, b) => caseSort(a[0]) - caseSort(b[0]));
  }

  function matterDisplay(idx, client, matter, cs = "") {
    const cases = idx[`${client}||${matter}`];
    if (!cases || Object.keys(cases).length < 2) return matter;
    const info = cases[cs || ""];
    return `${matter} ${info ? info.label : (cs || "1")}`;
  }

  // ------------------------------------------------------------------ this phone's own file
  function newId(phoneName, now = new Date()) {
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const hex = Array.from(crypto.getRandomValues(new Uint8Array(2))).map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${safeName(phoneName)}-${stamp}-${hex}`;
  }

  function emptyOwn(phoneName) {
    return { format: PHONE_FORMAT, format_version: 1, computer: phoneName, app_version: PHONE_APP_VERSION,
      updated: null, entries: [], deleted: {} };
  }

  const changedAt = (e) => e.modified_at || e.entered_at || "";

  /** Combine two copies of this phone's file (e.g. the one in Dropbox and the one on the phone). */
  function mergeOwn(a, b) {
    const out = Object.assign({}, a, { entries: [], deleted: Object.assign({}, a.deleted || {}) });
    for (const [id, d] of Object.entries(b.deleted || {}))
      if (!out.deleted[id] || (d.at || "") > (out.deleted[id].at || "")) out.deleted[id] = d;
    const byId = new Map();
    for (const e of [...(a.entries || []), ...(b.entries || [])]) {
      const cur = byId.get(e.id);
      if (!cur || changedAt(e) > changedAt(cur)) byId.set(e.id, e);
    }
    for (const [id, e] of byId) {
      const d = out.deleted[id];
      if (d && (d.at || "") >= changedAt(e)) continue;
      if (d) delete out.deleted[id];          // edited again after a delete elsewhere: keep the entry
      out.entries.push(e);
    }
    out.entries.sort((x, y) => (x.entered_at < y.entered_at ? -1 : x.entered_at > y.entered_at ? 1 : 0));
    return out;
  }

  /** Entries for the recent list: everything merged, newest Entered At first. */
  function recent(entries, n = RECENT_COUNT) {
    return [...entries].sort((a, b) => (a.entered_at < b.entered_at ? 1 : a.entered_at > b.entered_at ? -1 : 0)).slice(0, n);
  }

  /** Same checks as the Windows app's Save. Returns an error message or "". */
  function validate(v) {
    if (!v.client) return "Please choose a client.";
    if (!v.matter) return "Please choose a matter.";
    if (v.costError) return "The cost isn't a valid amount.";
    if (v.feeError) return "The fixed fee isn't a valid amount.";
    if (!v.minutes && !v.cost && !v.fee) return "Enter a length of time, an out-of-pocket cost or a fixed fee.";
    if (v.activity === OTHER_ACTIVITY && !v.description) return "Please add a description for 'Other' activities.";
    return "";
  }

  function parseMoney(text) {
    const t = String(text || "").trim().replace(/[$,]/g, "");
    if (!t) return { value: null, error: false };
    if (!/^\d*(\.\d{0,2})?$/.test(t) || t === ".") return { value: null, error: true };
    return { value: Math.round(parseFloat(t) * 100) / 100, error: false };
  }

  const api = { PHONE_APP_VERSION, OTHER_ACTIVITY, DEFAULT_ACTIVITY, RECENT_COUNT, DATA_PREFIX, PHONE_FORMAT,
    safeName, isoNow, isoDate, parseDate, parseDt, serialToIso, toNum, normCase, caseSort, fmtDuration,
    tidyDescription, ListChanges, readWorkbookData, readPhoneData, mergeAll, allNames, loadLists,
    defaultActivity, mattersFor, caseRecords, caseIndex, casesFor, matterDisplay, newId, emptyOwn, mergeOwn,
    recent, validate, parseMoney, changedAt, CLIENT_LIST_NAME, looksLikePerson, standardName, parseClientList, clientIds,
    intakeExtra };
  root.AECore = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
