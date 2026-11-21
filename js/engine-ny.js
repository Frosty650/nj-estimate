/* Support Calculator - the New York maintenance and child support engine (1.2.0).

   A line-for-line port of Family Cases' fc_nysupport.py (ny_figures, income, maintenance, child_support,
   custodial_parent, duration, compute, Result.summary / text). The two must give the same answer for the same inputs:
   tests/parity_ny.py runs thousands of scenarios through both and compares every line, note and figure.
   Change the Python first, then this, then run the parity test.

   Everything is annual; nothing is rounded (as the court's calculator). The figures come from js/tables.js
   (ny_sets, made from fc_nysupport.NY_SETS). Uses the helpers of js/engine.js (NJ). Runs in the browser and in Node. */
(function (root) {
  "use strict";
  const node = typeof module !== "undefined" && module.exports;
  const NJ = node ? require("./engine.js") : root.NJ;
  const DATA = node ? require("./tables.js") : root.NJ_DATA;
  const { money, m0, fmt, pyFixed, parseDate, ageOn, usDate, today } = NJ;

  class CalcError extends Error {}

  // ------------------------------------------------------------------------------------------------ Python formatting
  const pct0 = (x) => pyFixed(x * 100, 0) + "%";                       // f"{x:.0%}"
  const pct2 = (x) => pyFixed(x * 100, 2) + "%";                       // f"{x:.2%}"
  const intc = (x) => fmt(x, 0);                                       // f"{x:,}" for whole numbers
  const rjust = (s, n) => { s = String(s); return s.length >= n ? s : " ".repeat(n - s.length) + s; };
  const ljust = (s, n) => { s = String(s); return s.length >= n ? s : s + " ".repeat(n - s.length); };
  const pyStr = (v) => String(v);
  const cmp = (a, b) => a.y - b.y || a.m - b.m || a.d - b.d;
  const days = (d) => Date.UTC(d.y, d.m - 1, d.d) / 86400000;
  const isNum = (v) => typeof v === "number";

  // ------------------------------------------------------------------------------------------------ dated figures
  function nyFigures(when) {
    const d = parseDate(when) || today();
    const sets = DATA.ny_sets.slice().sort((a, b) => (a.effective < b.effective ? -1 : a.effective > b.effective ? 1 : 0));
    let chosen = sets[0];
    for (const s of sets) if (cmp(parseDate(s.effective), d) <= 0) chosen = s;
    const out = Object.assign({}, chosen);
    out.note = cmp(parseDate(chosen.effective), d) <= 0 ? "" :
      `No New York figures are loaded for ${usDate(d)}; the ${chosen.effective} figures were used.`;
    return out;
  }

  // ------------------------------------------------------------------------------------------------ inputs
  const PARENT_INPUTS = [  // [key, label, kind, UD-8(1) item]
    ["gross_income", "Gross (total) income on the most recent federal return", "money", "1"],
    ["investment_income", "Investment income not in item 1, less its expenses", "money", "2"],
    ["deferred_comp", "Deferred compensation", "money", "3a"],
    ["workers_comp", "Workers' compensation", "money", "3b"],
    ["disability", "Disability benefits", "money", "3c"],
    ["unemployment", "Unemployment insurance benefits", "money", "3d"],
    ["social_security", "Social Security benefits", "money", "3e"],
    ["veterans", "Veterans' benefits", "money", "3f"],
    ["pensions", "Pensions and retirement benefits", "money", "3g"],
    ["fellowships", "Fellowships and stipends", "money", "3h"],
    ["annuity", "Annuity payments", "money", "3i"],
    ["voluntarily_reduced", "Former income or resources voluntarily reduced", "money", "4"],
    ["se_depreciation", "Self-employed: depreciation above straight-line", "money", "5a"],
    ["se_travel", "Self-employed: entertainment and travel that reduce personal spending", "money", "5b"],
    ["other_income", "Other income (perks, fringe benefits, help from family …)", "money", "6"],
    ["property_income", "Income from income-producing property to be distributed by the judgment", "money", "7"],
    ["business_expenses", "Unreimbursed employee business expenses", "money", "9"],
    ["maintenance_paid", "Maintenance paid to a former spouse (order or agreement)", "money", "10"],
    ["child_support_paid", "Child support paid for a child of another relationship", "money", "11"],
    ["public_assistance", "Public assistance (only if in gross income)", "money", "12"],
    ["ssi", "Supplemental Security Income (only if in gross income)", "money", "13"],
    ["nyc_tax", "New York City or Yonkers income tax", "money", "14"],
    ["fica_method", "Social Security and Medicare (FICA)", "choice", "15-16"],
    ["fica_wages", "Wages for FICA (blank = item 1)", "money", "15-16"],
    ["fica_ss", "Social Security tax actually paid", "money", "15"],
    ["fica_medicare", "Medicare tax actually paid", "money", "16"],
  ];
  const FICA_METHODS = [["estimate", "Worked out from wages"], ["typed", "Amounts actually paid (W-2 boxes 4 and 6)"]];
  const ADD_ITEMS = [["investment_income", "2"], ["deferred_comp", "3a"], ["workers_comp", "3b"], ["disability", "3c"],
    ["unemployment", "3d"], ["social_security", "3e"], ["veterans", "3f"], ["pensions", "3g"],
    ["fellowships", "3h"], ["annuity", "3i"], ["voluntarily_reduced", "4"], ["se_depreciation", "5a"],
    ["se_travel", "5b"], ["other_income", "6"], ["property_income", "7"]];
  const MAINTENANCE_KINDS = [["post", "Post-divorce guideline maintenance"], ["temporary", "Temporary (pendente lite) maintenance"],
    ["agreed", "An amount agreed or ordered"], ["none", "No maintenance"]];
  const HEALTH_BY = [["", "No health insurance cost"], ["client", "Client"], ["other", "Other party"]];

  function newParent(name) {
    const p = {};
    for (const [k] of PARENT_INPUTS) p[k] = "";
    Object.assign(p, { name: name || "", fica_method: "estimate", overnights: "" });
    return p;
  }
  function newScenario(name, asOf) {
    return { jurisdiction: "NY", name: name || "Estimate", as_of: NJ.isoOf(parseDate(asOf) || today()),
      maintenance: "post", maintenance_amount: "", custodial: "auto", child_care_annual: "", health_annual: "",
      health_by: "", cs_above_cap: "", marriage_date: "", commencement_date: "",
      parents: { client: newParent("Client"), other: newParent("Other party") }, children: [], notes: "" };
  }
  // dict.get(k, default): a key holding null (Python's None) gives null, not the default
  const get = (o, k, dflt) => (o && Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined ? o[k] : dflt);
  // Python's min(a, b) / max(a, b): the first argument unless the second is strictly smaller / larger (so -0.0 is kept)
  const pmin = (a, b) => (b < a ? b : a);
  const pmax = (a, b) => (b > a ? b : a);
  const or = (v, dflt) => (v ? v : dflt);                                // Python's "v or default"

  // ------------------------------------------------------------------------------------------------ the result
  class Result {
    constructor() {
      this.figures = {}; this.income = {}; this.maintenance = null; this.support = null; this.support_after = null;
      this.ncp = ""; this.cp = ""; this.ncp_reason = ""; this.duration = null; this.notes = []; this.warnings = [];
    }
    get maint_annual() { return this.maintenance ? this.maintenance.award : 0; }
    get cs_annual() { return this.support ? this.support.total : 0; }
    summary(names) {
      const n = names || { client: "Client", other: "Other party" };
      const parts = [];
      if (this.maintenance && this.maintenance.award > 0) {
        const m = this.maintenance;
        parts.push(`${n[m.payor]} pays ${n[m.payee]} maintenance $${fmt(m.award, 0)} a year ` +
          `(about $${fmt(m.award / 12, 0)} a month) – ${m.label.toLowerCase()}.`);
      }
      if (this.support && this.support.total > 0) {
        const s = this.support;
        parts.push(`${n[this.ncp]} pays ${n[this.cp]} child support $${fmt(s.total, 0)} a year ` +
          `(about $${fmt(s.total / 12, 0)} a month)` +
          (s.band === "ssr" ? " with the add-ons; the court decides on them" : "") + ".");
        if (this.support_after) {
          const a = this.support_after;
          parts.push(`After maintenance ends: $${fmt(a.total, 0)} a year (about $${fmt(a.total / 12, 0)} ` +
            "a month).");
        }
      }
      return parts.join(" ") || "No maintenance or child support results from these figures.";
    }
    text(names) {
      const n = names || { client: "Client", other: "Other party" };
      const out = [];
      const mon = (v) => (v === null || v === undefined ? "" : (isNum(v) ? rjust(fmt(v, 2), 14) : rjust(pyStr(v), 14)));
      const row = (label, ...vals) => out.push(ljust(label.slice(0, 58), 58) + vals.map(mon).join(""));
      out.push("New York – annual figures");
      out.push("");
      out.push("INCOME (UD-8(1) Appendix A)");
      out.push(ljust("", 58) + rjust(n.client.slice(0, 14), 14) + rjust(n.other.slice(0, 14), 14));
      for (const [key, lab, , item] of PARENT_INPUTS) {
        if (["fica_method", "fica_wages", "fica_ss", "fica_medicare"].includes(key)) continue;
        const a = this.income.client[item], b = this.income.other[item];
        if (a || b || item === "1") row(`${rjust(item, 4)}  ${lab}`, a, b);
        if (item === "7") row("   8  Gross annual income", this.income.client["8"], this.income.other["8"]);
      }
      for (const [item, lab] of [["15", "Social Security (FICA)"], ["16", "Medicare (FICA)"]])
        row(`${rjust(item, 4)}  ${lab}`, this.income.client[item], this.income.other[item]);
      row("  17  Total deductions", this.income.client["17"], this.income.other["17"]);
      row("  18  NET ANNUAL INCOME", this.income.client["18"], this.income.other["18"]);
      if (this.maintenance) {
        const m = this.maintenance;
        out.push("", `MAINTENANCE – ${m.label}`);
        for (const [lab, v] of m.lines) row(lab, v);
        if (this.duration) {
          const [y, lo, hi] = this.duration;
          out.push(`Advisory duration (post-divorce): married ${pyFixed(y, 1)} years to commencement – ` +
            `${pyFixed(lo, 1)} to ${pyFixed(hi, 1)} years.`);
        }
      }
      for (const [title, s] of [["CHILD SUPPORT" + (this.support_after ? " – with maintenance" : ""), this.support],
        ["CHILD SUPPORT – after maintenance ends", this.support_after]]) {
        if (!s) continue;
        out.push("", title, `Non-custodial parent: ${n[this.ncp]}   Custodial parent: ${n[this.cp]}`);
        for (const [lab, v] of s.lines) row(lab, v);
      }
      out.push("");
      out.push(this.summary(n));
      if (this.warnings.length) out.push("", "Check:", ...this.warnings.map((w) => `  ! ${w}`));
      if (this.notes.length) out.push("", "Notes:", ...this.notes.map((x) => `  - ${x}`));
      return out.join("\n");
    }
  }

  // ------------------------------------------------------------------------------------------------ the calculation
  const _v = (p, k) => m0(get(p, k, null));

  function ficaEstimate(wages, fig) {
    const w = pmax(wages, 0);
    const ss = pmin(w, fig.ss_wage_base) * fig.ss_rate;
    const med = w * fig.medicare_rate + pmax(w - fig.addl_medicare_threshold, 0) * fig.addl_medicare_rate;
    return [ss, med];
  }
  // Python's sum() of floats (3.12 and later): Neumaier's compensated sum (CPython's cs_add / cs_to_double), so the
  // totals agree with the desktop app to the last bit
  function sum(L, items) {
    let hi = 0, lo = 0;
    for (const i of items) {
      const x = L[i], t = hi + x;
      if (Math.abs(hi) >= Math.abs(x)) lo += (hi - t) + x; else lo += (x - t) + hi;
      hi = t;
    }
    return lo && isFinite(lo) ? hi + lo : hi;
  }

  function income(p, fig, temporary) {
    const L = { "1": _v(p, "gross_income") };
    for (const [key, item] of ADD_ITEMS) L[item] = temporary && item === "7" ? 0 : _v(p, key);
    L["3"] = sum(L, ["3a", "3b", "3c", "3d", "3e", "3f", "3g", "3h", "3i"]);
    L["5"] = L["5a"] + L["5b"];
    L["8"] = L["1"] + L["2"] + L["3"] + L["4"] + L["5"] + L["6"] + L["7"];
    for (const [key, item] of [["business_expenses", "9"], ["maintenance_paid", "10"], ["child_support_paid", "11"],
      ["public_assistance", "12"], ["ssi", "13"], ["nyc_tax", "14"]]) L[item] = _v(p, key);
    if (or(get(p, "fica_method", ""), "estimate") === "typed") {
      L["15"] = _v(p, "fica_ss"); L["16"] = _v(p, "fica_medicare");
      L._fica = "typed";
    } else {
      const wages = money(get(p, "fica_wages", null));
      [L["15"], L["16"]] = ficaEstimate(wages === null ? L["1"] : wages, fig);
      L._fica = "estimate";
    }
    L["17"] = sum(L, ["9", "10", "11", "12", "13", "14", "15", "16"]);
    L["18"] = L["8"] - L["17"];
    return L;
  }

  function childrenCounted(scn, fig) {
    const when = parseDate(scn.as_of) || today();
    let n = 0;
    const notes = [];
    for (const ch of scn.children || []) {
      if (!get(ch, "include", true)) continue;
      const age = ageOn(get(ch, "dob", null), when);
      if (age !== null && age >= fig.support_age) {
        notes.push(`${or(ch.name, "A child")} is ${age}: New York child support runs to ` +
          `${fig.support_age}, so not counted.`);
        continue;
      }
      n++;
    }
    return [n, notes];
  }

  function maintenance(Lpayor, Lpayee, payor, payee, fig, kind, csPaid, payorIsNcp) {
    const lines = [];
    const incPayor = Lpayor["18"], incPayee = Lpayee["18"];
    const l1 = pmin(incPayor, fig.maint_cap);
    const l2 = incPayee;
    lines.push([` 1  Payor's income (up to the cap of $${intc(fig.maint_cap)})`, l1], [" 2  Payee's income", l2]);
    const [a, b] = fig.maint_r1;
    const r1 = l1 * a - l2 * b;
    const [c, d] = fig.maint_r2;
    const r2 = l1 * c - l2 * d;
    lines.push([` 5  Result 1 (${pct0(a)} of payor – ${pct0(b)} of payee)`, r1],
      [` 5  Result 2 (${pct0(c)} of payor – ${pct0(d)} of payee)`, r2]);
    const useR1 = !!(csPaid && payorIsNcp);
    lines.push([" 6  Child support paid for children of the marriage", csPaid ? "Yes" : "No"],
      [" 7  Payor is the non-custodial parent", payorIsNcp ? "Yes" : "No"]);
    const l8 = l1 + l2;
    const l9 = l8 * fig.maint_r3;
    const r3 = l9 - l2;
    lines.push([" 8  Combined income", l8], [` 9  ${pct0(fig.maint_r3)} of combined income`, l9], ["10  Result 3", r3]);
    const stepB = useR1 ? r1 : r2;
    const l11 = pmax(pmin(stepB, r3), 0);
    lines.push([`11  Guideline amount (lower of Result ${useR1 ? "1" : "2"} and Result 3, not below 0)`, l11]);
    const l14 = l1 - l11;
    const low = l11 > 0 && l14 < fig.ssr;
    lines.push(["14  Payor's income less the guideline amount", l14]);
    let award = l11;
    if (low) {
      award = pmax(l1 - fig.ssr, 0);
      lines.push([`18  Low-income adjustment (payor's income – $${intc(fig.ssr)} reserve)`, award]);
    }
    lines.push(["19  ANNUAL MAINTENANCE", award]);
    lines.push(["     a month", award / 12], ["     a week", award / 52]);
    const label = kind === "post" ? "Post-divorce guideline maintenance" : "Temporary maintenance (guideline)";
    return { kind, label, payor, payee, award, low_income: low, uncapped_payor: incPayor, lines, result1_used: useR1 };
  }

  function childSupport(scn, fig, inc, payor, payee, maint, ncp, cp, nKids) {
    const lines = [];
    const payorAdj = inc[payor]["18"] - maint;
    const payeeAdj = inc[payee]["18"] + maint;
    const adj = { [payor]: payorAdj, [payee]: payeeAdj };
    const combined = payorAdj + payeeAdj;
    if (combined <= 0) throw new CalcError("Combined parental income is zero or less: child support can't be worked out.");
    const pct = fig.cs_pct[String(Math.min(Math.max(nKids, 1), 5))];
    const capped = pmin(combined, fig.cs_cap);
    const ncpInc = adj[ncp], cpInc = adj[cp];
    const ncpShare = ncpInc / combined, cpShare = cpInc / combined;
    const basicAll = capped * pct;
    const basic = basicAll * ncpShare;
    lines.push([maint ? ` 1  Payee's income adjusted for maintenance (+${fmt(maint, 2)})` : " 1  Payee's income", payeeAdj],
      [maint ? ` 2  Payor's income adjusted for maintenance (−${fmt(maint, 2)})` : " 2  Payor's income", payorAdj],
      [" 3  Combined parental income", combined],
      [" 4  Non-custodial parent's income", ncpInc],
      [" 4a Non-custodial parent's share", pct2(ncpShare)],
      [" 4b Custodial parent's share", pct2(cpShare)],
      [` 5  Children: ${nKids} – ${pct0(pct)}`, null],
      [` 6  Combined child support on income up to $${intc(fig.cs_cap)}`, basicAll],
      [" 7  Non-custodial parent's basic child support", basic]);
    const above = money(get(scn, "cs_above_cap", null));
    let infoAbove = null;
    if (combined > fig.cs_cap) {
      const amt = above !== null ? above : 0;
      infoAbove = amt * pct * ncpShare;
      lines.push([` 8a Income above $${intc(fig.cs_cap)} to be considered (of ${fmt(combined - fig.cs_cap, 2)})`, amt],
        [" 8c Non-custodial parent's share on it (information only)", infoAbove]);
    }
    const after = ncpInc - basic;
    lines.push(["II.3 NCP's income after basic child support", after]);
    let band = "none", basicLow;
    if (after < fig.poverty) {
      band = "poverty";
      basicLow = fig.poverty_award;
      lines.push([`II.4 Below the poverty level ($${intc(fig.poverty)}): $${fig.poverty_award}`, basicLow]);
    } else if (after < fig.ssr) {
      band = "ssr";
      const diff = ncpInc - fig.ssr;
      basicLow = diff > fig.ssr_min_award ? diff : fig.ssr_min_award;
      lines.push([`II.4 Below the self-support reserve ($${intc(fig.ssr)}): greater of ` +
        `$${fig.ssr_min_award} and income − reserve`, basicLow]);
    } else basicLow = basic;
    lines.push(["II.5 Basic child support (after any low-income adjustment)", basicLow]);
    const care = _v(scn, "child_care_annual");
    const health = _v(scn, "health_annual");
    const by = or(get(scn, "health_by", ""), "");
    const careShare = care * ncpShare;
    let healthAdj;
    if (!health || !by) healthAdj = 0;
    else if (by === ncp) healthAdj = -(health * cpShare);
    else healthAdj = health * ncpShare;
    const addons = careShare + healthAdj;
    if (band !== "poverty") {
      lines.push(["III.1 Child care (custodial parent working or in school)", care],
        [" III.3 NCP's share of child care", careShare],
        ["III.5 Health insurance for the children (paid by " +
          `${by === ncp ? "the non-custodial parent" : by === cp ? "the custodial parent" : "nobody"})`, health],
        [" III.7 Health care adjustment", healthAdj],
        [" III.8 Total add-ons", addons]);
    }
    const total = band === "poverty" ? basicLow : basicLow + addons;
    const totalWithout = band === "ssr" ? basicLow : null;
    lines.push(["IV  ANNUAL CHILD SUPPORT" + (band === "ssr" ? " (with the add-ons)" : ""), total]);
    if (band === "ssr") lines.push(["IV  ANNUAL CHILD SUPPORT without the add-ons (the court decides)", totalWithout]);
    lines.push(["     a month", total / 12], ["     a week", total / 52]);
    return { total, total_without_addons: totalWithout, band, basic, basic_low: basicLow, addons,
      info_above_cap: infoAbove, combined, ncp_share: ncpShare, lines };
  }

  function custodialParent(scn, inc) {
    const choice = or(get(scn, "custodial", ""), "auto");
    if (choice === "client" || choice === "other") return [choice, choice === "client" ? "other" : "client", "chosen in the settings"];
    const [a, b] = ["client", "other"].map((w) => Math.trunc(m0(get(scn.parents[w], "overnights", null))));
    if (a !== b) {
      const cp = a > b ? "client" : "other";
      return [cp, cp === "client" ? "other" : "client", "the majority of overnights"];
    }
    const ncp = inc.client["18"] > inc.other["18"] ? "client" : "other";
    const cp = ncp === "client" ? "other" : "client";
    const why = a ? "equal parenting time: the parent with the higher income is treated as the non-custodial parent " +
      "(Baraby v Baraby)" : "no overnights entered: the parent with the higher income is taken as the " +
      "non-custodial parent";
    return [cp, ncp, why];
  }

  function duration(scn, fig) {
    const m = parseDate(get(scn, "marriage_date", null)), c = parseDate(get(scn, "commencement_date", null));
    if (!(m && c) || cmp(c, m) <= 0) return null;
    const years = (days(c) - days(m)) / 365.25;
    for (const [limit, lo, hi] of fig.duration)
      if (limit === null || years <= limit) return [years, years * lo, years * hi];
    return null;
  }

  function compute(scn) {
    const fig = nyFigures(scn.as_of);
    const r = new Result();
    r.figures = { effective: fig.effective, source: fig.source };
    if (fig.note) r.warnings.push(fig.note);
    const kind = or(get(scn, "maintenance", ""), "post");
    const temporary = kind === "temporary";
    const inc = { client: income(scn.parents.client, fig, temporary), other: income(scn.parents.other, fig, temporary) };
    r.income = inc;
    if (temporary && ["client", "other"].some((w) => _v(scn.parents[w], "property_income")))
      r.notes.push("Temporary maintenance leaves out UD-8(1) item 7 (income from property to be distributed by " +
        "the judgment).");
    for (const w of ["client", "other"]) {
      if (inc[w]._fica === "estimate" && inc[w]["1"])
        r.notes.push(`${or(scn.parents[w].name, w)}: Social Security and Medicare worked out from wages ` +
          `(6.2% up to $${intc(fig.ss_wage_base)}, 1.45%, and 0.9% above ` +
          `$${intc(fig.addl_medicare_threshold)}); type the amounts actually paid if known.`);
    }
    const [nKids, kidNotes] = childrenCounted(scn, fig);
    r.notes.push(...kidNotes);
    const a = inc.client["18"], b = inc.other["18"];
    let payor, payee;
    if (a === b) { payor = "other"; payee = "client"; }
    else [payor, payee] = a > b ? ["client", "other"] : ["other", "client"];
    if (nKids) {
      [r.cp, r.ncp, r.ncp_reason] = custodialParent(scn, inc);
      r.notes.push(`Custodial parent: ${or(scn.parents[r.cp].name, r.cp)} (${r.ncp_reason}). New York has ` +
        "no parenting-time reduction: overnights only decide who is custodial.");
    }
    let maint = 0;
    if (kind === "post" || kind === "temporary") {
      if (a === b) r.notes.push("The two incomes are equal: no guideline maintenance.");
      r.maintenance = maintenance(inc[payor], inc[payee], payor, payee, fig, kind, !!nKids, !!nKids && r.ncp === payor);
      maint = r.maintenance.award;
      if (inc[payor]["18"] > fig.maint_cap)
        r.warnings.push(`The payor's income is over $${intc(fig.maint_cap)}: maintenance is worked out on ` +
          `$${intc(fig.maint_cap)}; the court may add more on the rest (15 factors post-divorce, ` +
          "13 for temporary maintenance).");
      if (r.maintenance.low_income)
        r.notes.push(`Maintenance low-income adjustment: the payor keeps the self-support reserve ` +
          `($${intc(fig.ssr)}).`);
      if (kind === "post") {
        r.duration = duration(scn, fig);
        if (r.duration === null) r.notes.push("Advisory duration: enter the marriage and commencement dates.");
      }
    } else if (kind === "agreed") {
      maint = m0(get(scn, "maintenance_amount", null));
      if (maint)
        r.maintenance = { kind: "agreed", label: "Maintenance agreed or ordered", payor, payee, award: maint,
          low_income: false, uncapped_payor: inc[payor]["18"],
          lines: [["     Maintenance agreed or ordered (a year)", maint], ["     a month", maint / 12]], result1_used: false };
    }
    if (nKids) {
      r.support = childSupport(scn, fig, inc, payor, payee, maint, r.ncp, r.cp, nKids);
      if (maint) r.support_after = childSupport(scn, fig, inc, payor, payee, 0, r.ncp, r.cp, nKids);
      const s = r.support;
      if (s.combined > fig.cs_cap) {
        const above = m0(get(scn, "cs_above_cap", null));
        r.warnings.push(`Combined parental income is over $${intc(fig.cs_cap)}: the court decides, using the 10 ` +
          "factors and/or the percentage, how much income above it counts. " +
          (above ? `On the $${fmt(above, 0)} entered the non-custodial parent's ` +
            `share would be $${fmt(s.info_above_cap, 0)} a year (information only).` :
            "Enter how much of it to consider to see that figure (information only)."));
      }
      if (s.band === "ssr")
        r.warnings.push("Low income: the non-custodial parent is below the self-support reserve after child " +
          "support. The court decides whether the child care and health add-ons apply – both " +
          "totals are shown.");
      if (s.band === "poverty")
        r.notes.push(`Below the poverty level: child support is $${fig.poverty_award} a year and the add-ons ` +
          "don't apply (the court can order less if $300 is unjust).");
      if (nKids >= 5) r.notes.push("Five or more children: 35% is the minimum percentage.");
    } else if (!r.maintenance) {
      throw new CalcError("Nothing to work out yet: add the children (for child support) or the incomes (for " +
        "maintenance).");
    }
    return r;
  }

  const NY = { nyFigures, PARENT_INPUTS, FICA_METHODS, ADD_ITEMS, MAINTENANCE_KINDS, HEALTH_BY, newParent, newScenario,
    income, ficaEstimate, maintenance, childSupport, custodialParent, duration, compute, Result, CalcError };
  if (node) module.exports = NY;
  else root.NY = NY;
})(typeof self !== "undefined" ? self : this);
