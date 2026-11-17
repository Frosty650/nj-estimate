/* NJ Estimate - the screens. The calculation is js/engine.js (the same as Family Cases' quick estimate); this file
   only collects the inputs, shows the result and shares the worksheet. Nothing leaves the phone: what is typed is kept
   on this phone only (localStorage), so the last estimate is there when the app is opened again. */
(function () {
  "use strict";
  window.APP_VERSION = "1.0.1";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const KEY = "njest.state.v1";
  const WHO = ["client", "other"];
  const DEFAULT_NAME = { client: "Client", other: "Other party" };
  const PRESETS = [["Little or none", 0], ["Every other weekend", 100], ["Two nights a week", 104], ["Equal time", 182]];
  const PER = [["annual", "a year"], ["monthly", "a month"], ["weekly", "a week"]];
  const PARENT_DEFAULTS = { tax_method: "ixh", nj_resident: true, eligible_dependents: 0, self_employed: false };
  const SIMPLE_KEYS = ["gross_taxable", "overnights"];
  const LABEL = {}; const LINE = {}; const KIND = {};
  for (const [k, label, kind, line] of NJ.PARENT_INPUTS) { LABEL[k] = label; LINE[k] = line; KIND[k] = kind; }
  const GROUPS = [
    ["Income", ["mand_retirement", "alimony_paid_deductible", "alimony_recv_taxable", "nontaxable", "nontaxable_source",
      "alimony_paid_nondeductible", "alimony_recv_nontaxable"]],
    ["Taxes", ["tax_method", "tax_typed", "eligible_dependents", "self_employed", "union_dues"]],
    ["Children of another relationship", ["other_orders", "other_dep_deduction"]],
    ["Government benefits for the child", ["gov_benefits_child", "gov_benefits_credit"]],
    ["Child care and health", ["child_care_annual", "agi_annual", "nj_resident", "health_premium_child",
      "unreimbursed_over250", "extraordinary"]],
    ["Household (low-income tests)", ["household_size", "other_adults_income"]],
  ];

  let S;                 // the state: {scn, mode, tab, adjWho, mainWith, touched, asOfTyped, alimony}
  let result = null, sheetText = "", timer = null;

  // ------------------------------------------------------------------------------------------------ state
  function fresh() {
    return { scn: NJ.newScenario("Estimate"), mode: "simple", tab: "support", adjWho: "client", mainWith: "client",
      touched: [], asOfTyped: false, alimony: { client_amount: "", client_freq: "annual", other_amount: "", other_freq: "annual" } };
  }
  function load() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) { s = null; }
    if (!s || !s.scn || !s.scn.parents) s = fresh();
    const f = fresh();
    for (const k of Object.keys(f)) if (s[k] === undefined) s[k] = f[k];
    for (const w of WHO) s.scn.parents[w] = Object.assign(NJ.newParent(DEFAULT_NAME[w]), s.scn.parents[w]);
    if (!s.asOfTyped) s.scn.as_of = NJ.isoOf(NJ.today());     // the figures in effect today, unless a date was chosen
    return s;
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* private mode: not kept */ } }
  const P = (w) => S.scn.parents[w];
  function names() {
    const o = {};
    for (const w of WHO) o[w] = (P(w).name || "").trim() || DEFAULT_NAME[w];
    return o;
  }
  const round2 = (x) => Number(NJ.pyFixed(x, 2));
  const money$ = (x, d) => "$" + NJ.fmt(x, d || 0);
  const otherOf = (w) => (w === "client" ? "other" : "client");

  // ------------------------------------------------------------------------------------------------ small widgets
  function seg(el, value, onPick) {
    for (const b of el.querySelectorAll("button")) {
      b.classList.toggle("on", b.dataset.v === String(value));
      b.onclick = () => { for (const x of el.querySelectorAll("button")) x.classList.toggle("on", x === b); onPick(b.dataset.v); };
    }
  }
  function segHtml(id, opts, value, cls) {
    return `<div class="seg ${cls || ""}" id="${id}">` + opts.map(([v, t]) =>
      `<button data-v="${esc(v)}" class="${String(v) === String(value) ? "on" : ""}">${esc(t)}</button>`).join("") + "</div>";
  }
  function moneyField(id, value, opts) {
    opts = opts || {};
    const v = value === "" || value === null || value === undefined ? "" : (typeof value === "number" ? NJ.fmt(value, 2) : value);
    return `<label class="field${opts.cls ? " " + opts.cls : ""}"><span class="unit">$</span><input id="${id}" type="text" ` +
      `inputmode="decimal" autocomplete="off" placeholder="${opts.ph !== undefined ? opts.ph : "0.00"}" value="${esc(v)}"></label>`;
  }
  function intField(id, value, unit, ph) {
    return `<label class="field"><input id="${id}" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" ` +
      `placeholder="${ph || "0"}" value="${esc(value === "" || value === null || value === undefined ? "" : value)}">` +
      (unit ? `<span class="unit after">${unit}</span>` : "") + "</label>";
  }
  function switchHtml(id, on) {
    return `<label class="switch"><input id="${id}" type="checkbox"${on ? " checked" : ""}><span></span></label>`;
  }
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(toast.t);
    toast.t = setTimeout(() => t.classList.add("hidden"), 2200);
  }
  function confirmBox(title, body, okText, fn) {
    $("dialogTitle").textContent = title;
    $("dialogBody").textContent = body;
    $("dialogBtns").innerHTML = `<button id="dlgNo">Cancel</button><button id="dlgOk" class="danger">${esc(okText)}</button>`;
    $("dialog").classList.remove("hidden");
    $("dlgNo").onclick = () => $("dialog").classList.add("hidden");
    $("dlgOk").onclick = () => { $("dialog").classList.add("hidden"); fn(); };
  }
  function bad(input, isBad) { input.closest(".field").classList.toggle("bad", !!isBad); }

  // ------------------------------------------------------------------------------------------------ tabs and mode
  function showTab(tab) {
    S.tab = tab;
    for (const b of document.querySelectorAll(".tabs button")) b.classList.toggle("on", b.dataset.tab === tab);
    for (const t of ["support", "alimony", "about"]) $("tab-" + t).classList.toggle("hidden", t !== tab);
    $("pageTitle").textContent = { support: "Child support", alimony: "Alimony", about: "About" }[tab];
    if (tab === "alimony") renderAlimony();
    updateBar();
    window.scrollTo(0, 0);
    save();
  }
  function setMode(m) {
    S.mode = m;
    seg($("mode"), m, setMode);
    const full = m === "full";
    $("fullCards").classList.toggle("hidden", !full);
    $("switchBox").classList.toggle("hidden", full);
    renderKids();
    if (full) { renderAdj(); renderSettings(); }
    hiddenNote();
    save();
  }
  function adjustments() {             // what Full detail holds other than the usual
    let n = 0;
    for (const w of WHO) {
      const p = P(w);
      for (const [k] of NJ.PARENT_INPUTS) {
        if (SIMPLE_KEYS.includes(k)) continue;
        const v = p[k];
        const dflt = Object.prototype.hasOwnProperty.call(PARENT_DEFAULTS, k) ? PARENT_DEFAULTS[k] : "";
        if (v === dflt || v === "" || v === null || v === undefined) continue;
        if ((v === 0 || v === false) && !Object.prototype.hasOwnProperty.call(PARENT_DEFAULTS, k)) continue;
        n++;
      }
    }
    const base = NJ.newScenario();
    for (const k of ["worksheet", "custodial", "parenting_plan", "separate_accommodations", "initial_order_date", "deviation_amount"])
      if (S.scn[k] !== undefined && S.scn[k] !== base[k]) n++;
    n += (S.scn.children || []).filter((c) => c.disabled).length;
    if (S.asOfTyped) n++;
    return n;
  }
  function hiddenNote() {
    const n = S.mode === "full" ? 0 : adjustments();
    $("hiddenNote").classList.toggle("hidden", !n);
    $("hiddenNote").textContent = n ? `Full detail holds ${n} adjustment${n !== 1 ? "s" : ""} or setting${n !== 1 ? "s" : ""} ` +
      `that ${n !== 1 ? "are" : "is"} counted in this estimate.` : "";
  }

  // ------------------------------------------------------------------------------------------------ 1 children
  function syncAges() {
    for (const ch of S.scn.children) {
      if (ch.by !== "dob" && ch.age_entered !== "" && ch.age_entered !== undefined && ch.age_entered !== null)
        ch.dob = NJ.dobFromAge(Number(ch.age_entered), S.scn.as_of);
      else if (ch.by !== "dob") ch.dob = "";
    }
  }
  function renderKids() {
    const kids = S.scn.children;
    $("kidCount").innerHTML = [1, 2, 3, 4, 5, 6].map((n) =>
      `<button data-n="${n}" class="${kids.length === n ? "on" : ""}">${n}</button>`).join("");
    for (const b of $("kidCount").querySelectorAll("button")) b.onclick = () => setKidCount(Number(b.dataset.n));
    const full = S.mode === "full";
    $("kids").innerHTML = kids.map((ch, i) => {
      const byDob = ch.by === "dob";
      const input = byDob
        ? `<label class="field left"><input id="kdob${i}" type="date" value="${esc(ch.dob || "")}"></label>`
        : intField(`kage${i}`, ch.age_entered, "years old", "Age");
      return `<div class="kid">
        <div class="kid-head"><b>Child ${i + 1}</b><button class="kid-x" data-i="${i}" aria-label="Remove">✕</button></div>
        <div class="kid-row">${input}<span class="kid-age" id="kshow${i}"></span></div>
        <div class="kid-opts">
          <button class="linkbtn" data-swap="${i}">${byDob ? "Type an age instead" : "Birth date"}</button>
          <span style="flex:1"></span>
          <label>Counted ${switchHtml("kinc" + i, ch.include !== false)}</label>
          ${full ? `<label>Disabled ${switchHtml("kdis" + i, !!ch.disabled)}</label>` : ""}
        </div></div>`;
    }).join("") + (kids.length >= 6 ? `<button class="linkbtn" id="kidMore">+ Another child</button>` : "") +
      (kids.length === 0 ? `<div class="hint">Tap the number of children.</div>` : "");
    kids.forEach((ch, i) => {
      const age = $("kage" + i), dob = $("kdob" + i);
      if (age) age.oninput = () => {
        const t = age.value.trim();
        const ok = !t || (/^\d+$/.test(t) && Number(t) <= 30);
        bad(age, !ok);
        if (!ok) return;
        ch.age_entered = t ? Number(t) : "";
        changed();
      };
      if (dob) dob.onchange = () => { ch.dob = NJ.parseDate(dob.value) ? dob.value : ""; kidAge(i); changed(); };
      $("kinc" + i).onchange = (e) => { ch.include = e.target.checked; changed(); };
      if ($("kdis" + i)) $("kdis" + i).onchange = (e) => { ch.disabled = e.target.checked; changed(); };
      kidAge(i);
    });
    for (const b of $("kids").querySelectorAll(".kid-x")) b.onclick = () => { kids.splice(Number(b.dataset.i), 1); renderKids(); changed(); };
    for (const b of $("kids").querySelectorAll("[data-swap]")) b.onclick = () => {
      const ch = kids[Number(b.dataset.swap)];
      if (ch.by === "dob") { ch.by = "age"; ch.dob = ""; } else { ch.by = "dob"; ch.age_entered = ""; ch.dob = ""; }
      renderKids(); changed();
    };
    if ($("kidMore")) $("kidMore").onclick = () => setKidCount(kids.length + 1);
  }
  function kidAge(i) {
    const ch = S.scn.children[i], el = $("kshow" + i);
    if (!el) return;
    const a = ch.by === "dob" && ch.dob ? NJ.ageOn(ch.dob, S.scn.as_of) : null;
    el.textContent = a !== null && a >= 0 ? `age ${a}` : "";
  }
  function setKidCount(n) {
    const kids = S.scn.children;
    while (kids.length < n) kids.push({ name: "", dob: "", age_entered: "", by: "age", include: true, disabled: false });
    if (kids.length > n) kids.length = n;
    renderKids();
    changed();
    const first = kids.findIndex((c) => c.by !== "dob" && (c.age_entered === "" || c.age_entered === undefined));
    if (first >= 0 && $("kage" + first)) $("kage" + first).focus();
  }

  // ------------------------------------------------------------------------------------------------ 2 earnings
  function renderEarn() {
    const nm = names();
    $("earn").innerHTML = WHO.map((w) => {
      const p = P(w);
      let amt = NJ.money(p.income_amount), per = p.income_freq || "annual";
      const g = NJ.money(p.gross_taxable);
      if (amt === null || g === null || Math.abs(round2(NJ.toWeekly(amt, per)) - g) > 0.005) {
        amt = g; per = g !== null ? "weekly" : "annual";
      }
      return `<div class="party"><div class="lbl" data-name="${w}">${esc(nm[w].toUpperCase())}</div>
        ${moneyField("inc_" + w, amt === null ? "" : amt)}
        ${segHtml("per_" + w, PER, per, "small")}</div>`;
    }).join("");
    for (const w of WHO) {
      const inp = $("inc_" + w);
      const go = () => {
        const t = inp.value.trim();
        const amt = t ? NJ.money(t) : null;
        bad(inp, t && amt === null);
        if (t && amt === null) return;
        const per = $("per_" + w).querySelector(".on").dataset.v;
        const p = P(w);
        if (amt === null) { p.gross_taxable = ""; delete p.income_amount; delete p.income_freq; }
        else { p.income_amount = amt; p.income_freq = per; p.gross_taxable = round2(NJ.toWeekly(amt, per)); }
        weekHint();
        changed();
      };
      inp.oninput = go;
      inp.onblur = () => { const a = NJ.money(inp.value); if (a !== null) inp.value = NJ.fmt(a, 2); };
      seg($("per_" + w), $("per_" + w).querySelector(".on").dataset.v, go);
    }
    weekHint();
  }
  function weekHint() {
    const nm = names(), parts = [];
    for (const w of WHO) {
      const g = NJ.money(P(w).gross_taxable);
      const on = $("per_" + w) && $("per_" + w).querySelector(".on");
      if (g && on && on.dataset.v !== "weekly") parts.push(`${esc(nm[w])} ${money$(g, 2)}`);
    }
    $("weekHint").innerHTML = parts.length ? "A week: " + parts.join("&nbsp;&nbsp;·&nbsp;&nbsp;") : "";
    $("weekHint").classList.toggle("hidden", !parts.length);
  }

  // ------------------------------------------------------------------------------------------------ 3 parenting time
  function renderTime() {
    const nm = names();
    for (const b of $("mainWith").querySelectorAll("button")) b.textContent = nm[b.dataset.v];
    seg($("mainWith"), S.mainWith, mainChanged);
    $("presetLbl").textContent = `WITH ${nm[otherOf(S.mainWith)].toUpperCase()}`;
    $("presets").innerHTML = PRESETS.map(([t, n]) => `<button data-n="${n}"><b>${esc(t)}</b><span>${n} overnights a year</span></button>`).join("");
    for (const b of $("presets").querySelectorAll("button")) b.onclick = () => preset(Number(b.dataset.n));
    $("nights").innerHTML = WHO.map((w) => `<div><div class="lbl" data-name="${w}">${esc(nm[w].toUpperCase())}</div>` +
      intField("on_" + w, P(w).overnights, "nights", "") + "</div>").join("");
    for (const w of WHO) $("on_" + w).oninput = () => nightTyped(w);
    showPresets();
  }
  function setNights(w, v, show) {
    P(w).overnights = v;
    if (show !== false) $("on_" + w).value = v === "" || v === null ? "" : String(v);
  }
  function preset(n) {
    const main = S.mainWith, oth = otherOf(main);
    setNights(main, 365 - n);
    setNights(oth, n);
    S.touched = [];
    showPresets();
    changed();
  }
  function nightTyped(w) {
    const inp = $("on_" + w);
    const t = inp.value.trim();
    const ok = !t || (/^\d+$/.test(t) && Number(t) <= 366);
    bad(inp, !ok);
    if (!ok) return;
    setNights(w, t ? Number(t) : "", false);
    if (!S.touched.includes(w)) S.touched.push(w);
    const oth = otherOf(w);
    if (!S.touched.includes(oth)) setNights(oth, t ? Math.max(0, 365 - Number(t)) : "");   // follows until typed in
    showPresets();
    changed();
  }
  function presetNow(swapped) {
    let main = S.mainWith, oth = otherOf(main);
    if (swapped) [main, oth] = [oth, main];
    const a = P(main).overnights, b = P(oth).overnights;
    if (a === "" || a === null || a === undefined || b === "" || b === null || b === undefined) return null;
    const x = Math.trunc(NJ.m0(a)), y = Math.trunc(NJ.m0(b));
    return x + y === 365 && PRESETS.some(([, n]) => n === y) ? y : null;
  }
  function showPresets() {
    const now = presetNow();
    for (const b of $("presets").querySelectorAll("button")) b.classList.toggle("on", Number(b.dataset.n) === now);
  }
  function mainChanged(v) {
    const n = presetNow(true);
    S.mainWith = v;
    $("presetLbl").textContent = `WITH ${names()[otherOf(v)].toUpperCase()}`;
    if (n !== null) preset(n); else { showPresets(); save(); }
  }

  // ------------------------------------------------------------------------------------------------ 4 adjustments
  function fieldHtml(id, key, value) {
    const kind = KIND[key];
    const lab = `<div class="lbl">${esc(LABEL[key])}<span class="ln">line ${esc(LINE[key])}</span></div>`;
    if (kind === "check") return `<div class="toggle-row fld"><span class="small">${esc(LABEL[key])} <span class="ln hint">line ${esc(LINE[key])}</span></span>${switchHtml(id, !!value)}</div>`;
    if (kind === "choice") return `<div class="fld">${lab}${segHtml(id, [["ixh", "IX-H tables"], ["typed", "Typed from returns / YTD"]], value || "ixh", "small")}</div>`;
    if (kind === "int") return `<div class="fld">${lab}${intField(id, value, "", key === "household_size" ? "" : "0")}` +
      (key === "household_size" ? `<div class="hint">Blank: this parent and the children (${1 + (S.scn.children || []).filter((c) => c.include !== false).length}).</div>` : "") + "</div>";
    if (kind === "text") return `<div class="fld">${lab}<label class="field left"><input id="${id}" type="text" value="${esc(value || "")}"></label></div>`;
    return `<div class="fld">${lab}${moneyField(id, value)}</div>`;
  }
  function renderAdj() {
    const nm = names();
    for (const b of $("adjWho").querySelectorAll("button")) b.textContent = nm[b.dataset.v];
    seg($("adjWho"), S.adjWho, (v) => { S.adjWho = v; renderAdj(); save(); });
    const p = P(S.adjWho);
    const typed = (p.tax_method || "ixh") === "typed";
    let h = "";
    for (const [title, keys] of GROUPS) {
      h += `<div class="grp">${esc(title.toUpperCase())}</div>`;
      for (const k of keys) {
        if (typed && (k === "eligible_dependents" || k === "self_employed")) continue;
        if (!typed && k === "tax_typed") continue;
        h += fieldHtml("a_" + k, k, p[k]);
      }
    }
    $("adj").innerHTML = h;
    for (const [, keys] of GROUPS) for (const k of keys) {
      const el = $("a_" + k);
      if (!el) continue;
      const kind = KIND[k];
      if (kind === "check") el.onchange = () => { p[k] = el.checked; changed(); };
      else if (kind === "choice") seg(el, p[k] || "ixh", (v) => { p[k] = v; renderAdj(); changed(); });
      else if (kind === "int") el.oninput = () => {
        const t = el.value.trim(); const ok = !t || /^\d+$/.test(t);
        bad(el, !ok); if (!ok) return;
        p[k] = t ? Number(t) : (k === "eligible_dependents" ? 0 : ""); changed();
      };
      else if (kind === "text") el.oninput = () => { p[k] = el.value; changed(); };
      else {
        el.oninput = () => {
          const t = el.value.trim(); const v = t ? NJ.money(t) : null;
          bad(el, t && v === null); if (t && v === null) return;
          p[k] = v === null ? "" : v; changed();
        };
        el.onblur = () => { const a = NJ.money(el.value); if (a !== null) el.value = NJ.fmt(a, 2); };
      }
    }
  }

  // ------------------------------------------------------------------------------------------------ how it is worked out
  function renderSettings() {
    const s = S.scn, nm = names();
    $("settings").innerHTML = `
      <div class="fld"><div class="lbl">Calculation date (figures in effect)</div>
        <label class="field left"><input id="s_as_of" type="date" value="${esc(s.as_of)}"></label></div>
      <div class="fld"><div class="lbl">Worksheet</div>${segHtml("s_worksheet", [["auto", "Automatic"], ["sole", "Sole (IX-C)"], ["shared", "Shared (IX-D)"]], s.worksheet || "auto", "small")}</div>
      <div class="fld"><div class="lbl">Custodial parent / PPR</div>${segHtml("s_custodial", [["auto", "Automatic"], ["client", nm.client], ["other", nm.other]], s.custodial || "auto", "small")}
        <div class="hint">Automatic: the parent with more overnights.</div></div>
      <div class="toggle-row fld"><span class="small">Parenting plan filed or ordered</span>${switchHtml("s_parenting_plan", s.parenting_plan !== false)}</div>
      <div class="toggle-row fld"><span class="small">Separate living accommodations for the child at the PAR's home</span>${switchHtml("s_separate_accommodations", s.separate_accommodations !== false)}</div>
      <div class="fld"><div class="lbl">Date of the initial child support order (teenage adjustment)</div>
        <label class="field left"><input id="s_initial_order_date" type="date" value="${esc(s.initial_order_date || "")}"></label></div>
      <div class="fld"><div class="lbl">Amount ordered, if different (weekly)</div>${moneyField("s_deviation_amount", s.deviation_amount, { ph: "" })}</div>
      <div class="fld"><div class="lbl">Reason for the difference</div><label class="field left"><input id="s_deviation_reason" type="text" value="${esc(s.deviation_reason || "")}"></label></div>
      <div class="fld"><div class="lbl">Client's name on the worksheet</div><label class="field left"><input id="s_name_client" type="text" autocomplete="off" value="${esc(P("client").name === "Client" ? "" : P("client").name)}" placeholder="Client"></label></div>
      <div class="fld"><div class="lbl">Other party's name on the worksheet</div><label class="field left"><input id="s_name_other" type="text" autocomplete="off" value="${esc(P("other").name === "Other party" ? "" : P("other").name)}" placeholder="Other party"></label></div>`;
    $("s_as_of").onchange = (e) => {
      const d = NJ.parseDate(e.target.value);
      S.asOfTyped = !!d && e.target.value !== NJ.isoOf(NJ.today());
      s.as_of = d ? NJ.isoOf(d) : NJ.isoOf(NJ.today());
      if (!d) e.target.value = s.as_of;
      S.scn.children.forEach((_, i) => kidAge(i));
      subTitle();
      changed();
    };
    seg($("s_worksheet"), s.worksheet || "auto", (v) => { s.worksheet = v; changed(); });
    seg($("s_custodial"), s.custodial || "auto", (v) => { s.custodial = v; changed(); });
    $("s_parenting_plan").onchange = (e) => { s.parenting_plan = e.target.checked; changed(); };
    $("s_separate_accommodations").onchange = (e) => { s.separate_accommodations = e.target.checked; changed(); };
    $("s_initial_order_date").onchange = (e) => { s.initial_order_date = NJ.parseDate(e.target.value) ? e.target.value : ""; changed(); };
    const dev = $("s_deviation_amount");
    dev.oninput = () => {
      const t = dev.value.trim(); const v = t ? NJ.money(t) : null;
      bad(dev, t && v === null); if (t && v === null) return;
      s.deviation_amount = v === null ? "" : v; changed();
    };
    $("s_deviation_reason").oninput = (e) => { s.deviation_reason = e.target.value; changed(); };
    for (const w of WHO) $("s_name_" + w).oninput = (e) => {
      P(w).name = e.target.value.trim() || DEFAULT_NAME[w];
      showNames();
      changed();
    };
  }
  function showNames() {
    const nm = names();
    for (const el of document.querySelectorAll("[data-name]")) el.textContent = nm[el.dataset.name].toUpperCase();
    for (const id of ["mainWith", "adjWho"]) for (const b of $(id).querySelectorAll("button")) b.textContent = nm[b.dataset.v];
    const c = $("s_custodial");
    if (c) for (const b of c.querySelectorAll("button")) if (b.dataset.v !== "auto") b.textContent = nm[b.dataset.v];
    $("presetLbl").textContent = `WITH ${nm[otherOf(S.mainWith)].toUpperCase()}`;
    weekHint();
  }

  // ------------------------------------------------------------------------------------------------ the result
  function changed() {
    save();
    clearTimeout(timer);
    timer = setTimeout(calculate, 120);
  }
  function calculate() {
    syncAges();
    hiddenNote();
    const nm = names();
    let r = null;
    try {
      r = NJ.compute(S.scn);
    } catch (e) {
      result = null; sheetText = "";
      headline(null, e instanceof NJ.CalcError ? e.message : "The calculation failed: " + e.message);
      side([], [], []);
      save();
      return;
    }
    result = r;
    headline(r, "");
    const assumed = [];
    if (WHO.every((w) => (P(w).tax_method || "ixh") === "ixh"))
      assumed.push("Income tax taken from the court's withholding tables (Appendix IX-H).");
    if (r.worksheet === "shared")
      assumed.push("A parenting plan and separate accommodations for the children (needed for the shared parenting worksheet).");
    assumed.push(...r.comments, ...r.notes);
    assumed.push(`Figures in effect ${NJ.usDate(NJ.parseDate(r.figures.effective))} – ${r.figures.source}`);
    side(NJ.whatIf(S.scn), assumed, r.warnings);
    sheetText = r.text(nm) + `\n\nFigures: ${r.figures.effective} – ${r.figures.source}`;
    if (!$("sheet").classList.contains("hidden")) renderSheet();
    save();
  }
  function headline(r, message) {
    const nm = names();
    let big, sub;
    if (!r) { big = "–"; sub = message; }
    else if (!r.payer || r.order <= 0) { big = "No order"; sub = "No child support order results from these figures."; }
    else {
      big = `${money$(r.order)} a week`;
      sub = `${nm[r.payer]} pays ${nm[r.payee]}  ·  about ${money$(r.order * 52 / 12)} a month  ·  ${r.worksheet} parenting worksheet`;
    }
    $("big").textContent = big;
    $("summary").textContent = sub;
    $("barBig").textContent = big;
    $("barSub").textContent = r ? sub : (message || "");
    $("sheetBtn").disabled = $("shareBtn").disabled = !r;
    updateBar();
  }
  function side(whatif, assumed, warnings) {
    $("check").classList.toggle("hidden", !warnings.length);
    $("check").textContent = warnings.length ? "To check: " + warnings.join("  ") : "";
    $("whatifCard").classList.toggle("hidden", !whatif.length);
    $("whatif").innerHTML = whatif.map((x) => `<p>${esc(x)}</p>`).join("");
    $("assumed").innerHTML = assumed.length ? assumed.map((x) => `<p>${esc(x)}</p>`).join("") : "Nothing yet.";
  }
  let resultVisible = true;
  function updateBar() {
    const show = S.tab === "support" && !!result && !resultVisible && $("sheet").classList.contains("hidden");
    $("bar").classList.toggle("hidden", !show);
  }

  // ------------------------------------------------------------------------------------------------ worksheet
  const KEY_LINES = { sole: ["6", "8", "13", "21", "27"], shared: ["6", "8", "12", "29", "35"] };
  function renderSheet() {
    const r = result, nm = names();
    if (!r) return;
    const heads = r.cols.map(([k, h]) => h);
    const who = Object.entries(r.roles).map(([w, role]) => `${({ CP: "Custodial", NCP: "Non-custodial", PPR: "PPR", PAR: "PAR" })[role]}: ${nm[w]}`).join("  ·  ");
    let h = `<div class="ws-title">${esc(r.worksheet === "sole" ? "Sole parenting worksheet (IX-C)" : "Shared parenting worksheet (IX-D)")} – all amounts weekly<br>${esc(who)}</div>`;
    h += `<table class="ws"><thead><tr><th>Line</th><th></th>${heads.map((x) => `<th>${esc(x)}</th>`).join("")}</tr></thead><tbody>`;
    for (const [ln, label, vals] of r.lines) {
      const ratio = label.startsWith("Each parent's share of income") || label.startsWith("Each parent's share of overnights");
      const key = KEY_LINES[r.worksheet].includes(ln) || /order/i.test(label) && /^(2[2-7]|3[0-5])$/.test(ln);
      h += `<tr class="${key ? "key" : ""}"><td class="ln">${esc(ln)}</td><td class="lab">${esc(label)}</td>` + r.cols.map(([k]) => {
        const v = vals[k];
        if (v === undefined || v === null || v === "") return "<td></td>";
        return `<td>${esc(ratio ? NJ.fmt(v, 2, false) : (Number.isInteger(v) ? NJ.fmt(v) : NJ.fmt(v, 2)))}</td>`;
      }).join("") + "</tr>";
    }
    h += "</tbody></table>";
    h += `<div class="ws-sum">${esc(r.summary(nm))}</div>`;
    const list = (title, xs) => (xs.length ? `<div class="ws-h">${title}</div><ul class="ws-list">${xs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "");
    h += list("COMMENTS", r.comments) + list("CHECK", r.warnings) + list("NOTES", r.notes);
    h += `<div class="ws-h">FIGURES</div><ul class="ws-list"><li>${esc(r.figures.effective)} – ${esc(r.figures.source)}</li></ul>`;
    $("sheetBody").innerHTML = h;
  }
  function openSheet() {
    if (!result) return;
    renderSheet();
    $("sheet").classList.remove("hidden");
    $("sheetBody").scrollTop = 0;
    updateBar();
  }
  function shareText() {
    const d = NJ.usDate(NJ.today());
    return `NJ child support estimate (${d}) – an estimate, not a court form\n\n${sheetText}`;
  }
  async function share(title, text) {
    if (navigator.share) {
      try { await navigator.share({ title, text }); return; } catch (e) { if (e && e.name === "AbortError") return; }
    }
    copy(text);
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast("Copied"); return; } catch (e) { /* fall back */ }
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); toast("Copied"); } catch (e) { toast("Couldn't copy on this phone"); }
    ta.remove();
  }
  function printText(text) { $("printText").textContent = text; window.print(); }

  // ------------------------------------------------------------------------------------------------ alimony
  function alFacts() {
    const out = {};
    for (const w of WHO) {
      const g = NJ.money(P(w).gross_taxable);
      out[w] = g ? round2(g * 52) : null;
    }
    return out;
  }
  let alYear = {}, alResult = null;
  function renderAlimony() {
    const d = S.alimony, facts = alFacts(), nm = names();
    $("alEarn").innerHTML = WHO.map((w) => {
      const typed = NJ.money(d[w + "_amount"]);
      const per = typed !== null ? (d[w + "_freq"] || "annual") : "annual";
      const amt = typed !== null ? typed : facts[w];
      return `<div class="party"><div class="lbl" data-name="${w}">${esc(nm[w].toUpperCase())}</div>
        ${moneyField("al_" + w, amt === null ? "" : amt, { cls: typed === null && amt !== null ? "fact" : "" })}
        ${segHtml("alper_" + w, PER, per, "small")}<div class="hint" id="alsrc_${w}"></div></div>`;
    }).join("");
    for (const w of WHO) {
      const inp = $("al_" + w);
      const go = () => {
        const t = inp.value.trim(); const amt = t ? NJ.money(t) : null;
        bad(inp, t && amt === null); if (t && amt === null) return;
        d[w + "_amount"] = amt === null ? "" : amt;
        d[w + "_freq"] = $("alper_" + w).querySelector(".on").dataset.v;
        inp.closest(".field").classList.remove("fact");
        alCalc(); save();
      };
      inp.oninput = go;
      inp.onblur = () => { const a = NJ.money(inp.value); if (a !== null) inp.value = NJ.fmt(a, 2); };
      seg($("alper_" + w), $("alper_" + w).querySelector(".on").dataset.v, go);
    }
    alCalc();
  }
  function alCalc() {
    const d = S.alimony, facts = alFacts(), nm = names();
    for (const w of WHO) {
      const typed = NJ.money(d[w + "_amount"]);
      const per = d[w + "_freq"] || "annual";
      let src;
      if (typed !== null) {
        alYear[w] = NJ.toAnnual(typed, per);
        src = "Typed here." + (per !== "annual" ? `  A year: ${money$(alYear[w])}.` : "");
      } else {
        alYear[w] = facts[w] || 0;
        src = facts[w] !== null ? "From the child support estimate." : "Nothing in the child support estimate yet – type it.";
      }
      $("alsrc_" + w).textContent = src;
    }
    const r = alResult = NJ.alimony(alYear.client, alYear.other);
    $("alDiff").textContent = `Difference in gross income: ${money$(r.difference)} a year`;
    $("alWho").textContent = r.payer ? `${nm[r.payer]} has the higher income and would pay ${nm[r.payee]}.`
      : "The two incomes are the same (or not entered yet).";
    $("alTable").innerHTML = `<tr><th>Share of the difference</th><th>A week</th><th>A month</th><th>A year</th></tr>` +
      r.rows.map((x) => `<tr><td>${x.pct}%</td><td>${money$(x.weekly)}</td><td>${money$(x.monthly)}</td><td>${money$(x.annual)}</td></tr>`).join("");
    $("alShare").disabled = !r.payer;
  }
  function alText() {
    const r = alResult, n = names();
    if (!r || !r.payer) return "";
    const lines = [`Alimony, rule of thumb (not a guideline): gross income a year ${n.client} ` +
      `${money$(alYear.client)}, ${n.other} ${money$(alYear.other)}; difference ` +
      `${money$(r.difference)}. ${n[r.payer]} would pay ${n[r.payee]}:`];
    for (const x of r.rows) lines.push(`  ${x.pct}%: ${money$(x.weekly)} a week, ${money$(x.monthly)} a month, ${money$(x.annual)} a year`);
    return lines.join("\n");
  }

  // ------------------------------------------------------------------------------------------------ start
  function subTitle() {
    const f = NJ.njFigures(S.scn.as_of);
    $("pageSub").textContent = `New Jersey · guidelines from ${NJ.usDate(NJ.parseDate(f.effective))}`;
  }
  function renderAll() {
    seg($("mode"), S.mode, setMode);
    renderEarn();
    renderTime();
    setMode(S.mode);
    subTitle();
    showTab(S.tab);
    calculate();
  }
  function start() {
    for (const b of document.querySelectorAll(".tabs button")) b.onclick = () => showTab(b.dataset.tab);
    S = load();
    $("toFull").onclick = () => setMode("full");
    $("clearBtn").onclick = () => confirmBox("Start over?", "Clear the children, incomes and adjustments on this phone?",
      "Start over", () => { const tab = S.tab; S = fresh(); S.tab = tab; save(); renderAll(); });
    $("sheetBtn").onclick = openSheet;
    $("shareBtn").onclick = () => share("Child support estimate", shareText());
    $("sheetClose").onclick = () => { $("sheet").classList.add("hidden"); updateBar(); };
    $("sheetShare").onclick = () => share("Child support estimate", shareText());
    $("sheetCopy").onclick = () => copy(shareText());
    $("sheetPrint").onclick = () => printText(shareText());
    $("bar").onclick = () => $("result").scrollIntoView({ behavior: "smooth", block: "start" });
    $("alFrom").onclick = () => {
      for (const w of WHO) { S.alimony[w + "_amount"] = ""; S.alimony[w + "_freq"] = "annual"; }
      save(); renderAlimony();
    };
    $("alShare").onclick = () => share("Alimony estimate", `NJ alimony estimate (${NJ.usDate(NJ.today())})\n\n${alText()}`);
    const f = NJ.njFigures();
    $("aboutText").innerHTML = `<p>Support Calculator: a quick estimate of New Jersey child support (Rules Appendix IX: the sole and shared ` +
      `parenting worksheets, IX-E child care, IX-H withholding, the IX-F schedule) and a rule-of-thumb alimony figure – ` +
      `the same calculation as the Family Cases app on the office computers.</p>` +
      `<p>Figures in effect from ${esc(NJ.usDate(NJ.parseDate(f.effective)))}: ${esc(f.source)}.</p>` +
      `<p>Nothing typed here leaves this phone. The last estimate is kept on this phone until <i>Start over</i>.</p>` +
      `<p>An estimate for discussion, not a court form.</p><p class="hint">Version ${esc(window.APP_VERSION || "")}</p>`;
    if ("IntersectionObserver" in window) {
      new IntersectionObserver((es) => { resultVisible = es[0].isIntersecting; updateBar(); }).observe($("result"));
    }
    renderAll();
    window.SC_STARTED = true;
    if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  window.NJApp = { state: () => S, result: () => result, sheetText: () => sheetText, alText };
  start();
})();
