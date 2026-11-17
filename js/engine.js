/* NJ Estimate - the New Jersey child support and alimony engine.

   A line-for-line port of Family Cases' fc_njcs.py (compute, what_if, Result), fc_figures.py, fc_alimony.py and the
   fc_model.py helpers they use (Family Cases 0.3.4). The two must give the same answer for the same inputs:
   tests/parity.js runs thousands of scenarios through both and compares every line, note and figure.
   Change the Python first, then this, then run the parity test.

   Every amount is weekly; every dollar figure is rounded to whole dollars at each line (50 cents or more up) and
   every ratio to two decimals, as the worksheet is filled by hand (IX-B). Runs in the browser and in Node. */
(function (root) {
  "use strict";
  const DATA = (typeof module !== "undefined" && module.exports) ? require("./tables.js") : root.NJ_DATA;

  // ------------------------------------------------------------------------------------------------ numbers
  function money(v) {            // '1,234.50', '$1234', 1234 -> 1234.5; blank / not a number -> null
    if (v === null || v === undefined || typeof v === "boolean") return null;
    if (typeof v === "number") return v;
    let s = String(v).trim().replace(/\$/g, "").replace(/,/g, "").replace(/ /g, "");
    if (!s) return null;
    const neg = s.startsWith("(") && s.endsWith(")");
    s = s.replace(/^\(+/, "").replace(/\)+$/, "");
    const x = pyFloat(s);
    if (x === null) return null;
    return neg ? -x : x;
  }
  function pyFloat(s) {          // float(s) as Python reads it (None when it can't)
    const t = String(s).trim();
    if (!/^[+-]?((\d+(_\d+)*)(\.(\d+(_\d+)*)?)?|\.\d+(_\d+)*)([eE][+-]?\d+(_\d+)*)?$/.test(t)) return null;
    return Number(t.replace(/_/g, ""));
  }
  function m0(v) { const x = money(v); return x !== null ? x : 0; }
  function R(x, places) {        // 50 cents or more goes up (negatives: away from zero)
    const q = Math.pow(10, places || 0);
    let r = x >= 0 ? Math.trunc(x * q + 0.5 + 1e-9) : -Math.trunc(-x * q + 0.5 + 1e-9);
    if (r === 0) r = 0;          // no -0
    return places ? r / q : r;
  }
  function intOf(v) {            // int(float(v or 0)), 0 when it isn't a number
    if (v === true) return 1;
    if (!v) return 0;
    const x = typeof v === "number" ? v : pyFloat(v);
    if (x === null || !isFinite(x)) return 0;
    const t = Math.trunc(x);
    return t === 0 ? 0 : t;
  }

  // Python's fixed-point formatting: the exact binary value, ties to even
  function pyFixed(x, d) {
    if (!isFinite(x)) return x > 0 ? "inf" : (x < 0 ? "-inf" : "nan");
    const neg = x < 0 || Object.is(x, -0);
    const s = Math.abs(x).toFixed(Math.min(100, d + 60));
    let [ip, fp] = s.split(".");
    fp = fp || "";
    const keep = ip + fp.slice(0, d), rest = fp.slice(d);
    let up = false;
    if (rest[0] > "5") up = true;
    else if (rest[0] === "5") up = /[1-9]/.test(rest.slice(1)) || Number(keep[keep.length - 1]) % 2 === 1;
    let digits = keep;
    if (up) {
      const a = digits.split("");
      let i = a.length - 1;
      while (i >= 0) {
        if (a[i] === "9") { a[i] = "0"; i--; } else { a[i] = String(Number(a[i]) + 1); break; }
      }
      if (i < 0) a.unshift("1");
      digits = a.join("");
    }
    const ilen = digits.length - d;
    const out = d ? digits.slice(0, ilen) + "." + digits.slice(ilen) : digits;
    return (neg ? "-" : "") + out;
  }
  function commas(s) {
    const neg = s.startsWith("-");
    const t = neg ? s.slice(1) : s;
    const [i, f] = t.split(".");
    const g = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (neg ? "-" : "") + g + (f !== undefined ? "." + f : "");
  }
  function fmt(x, d, sep) { const s = pyFixed(x, d || 0); return sep === false ? s : commas(s); }   // f"{x:,.{d}f}"
  function rjust(s, n) { s = String(s); return s.length >= n ? s : " ".repeat(n - s.length) + s; }
  function ljust(s, n) { s = String(s); return s.length >= n ? s : s + " ".repeat(n - s.length); }

  // ------------------------------------------------------------------------------------------------ dates ({y, m, d})
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september",
    "october", "november", "december"];
  function mk(y, m, d) {
    if (!(y >= 1 && m >= 1 && m <= 12 && d >= 1)) return null;
    const last = new Date(Date.UTC(2000, m, 0)).getUTCDate();
    const dim = m === 2 ? ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28) : last;
    return d <= dim ? { y, m, d } : null;
  }
  function today() { const t = new Date(); return { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate() }; }
  function isoOf(d) { return d ? `${String(d.y).padStart(4, "0")}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}` : ""; }
  function usDate(d) { return `${String(d.m).padStart(2, "0")}/${String(d.d).padStart(2, "0")}/${String(d.y).padStart(4, "0")}`; }
  function cmp(a, b) { return a.y - b.y || a.m - b.m || a.d - b.d; }
  function addDays(d, n) {
    const t = new Date(Date.UTC(2000, d.m - 1, d.d));
    t.setUTCFullYear(d.y);
    t.setUTCDate(t.getUTCDate() + n);
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
  }
  const MM = "(1[0-2]|0[1-9]|[1-9])", DD = "(3[01]|[12]\\d|0[1-9]|[1-9]| [1-9])";
  function monthWord(w, full) {
    w = w.toLowerCase();
    const i = (full ? MONTH_NAMES : MONTHS).indexOf(w);
    return i < 0 ? 0 : i + 1;
  }
  function parseDate(v) {        // a date from 'YYYY-MM-DD', 'MM/DD/YYYY', 'M/D/YY', ... ; null when not a date
    if (v === null || v === undefined) return null;
    if (typeof v === "object" && v.y) return v;
    const s = String(v).trim();
    if (!s) return null;
    const tries = [
      [new RegExp(`^(\\d{4})-${MM}-${DD}$`), (m) => [+m[1], +m[2], +m[3]]],
      [new RegExp(`^${MM}/${DD}/(\\d{4})$`), (m) => [+m[3], +m[1], +m[2]]],
      [new RegExp(`^${MM}/${DD}/(\\d\\d)$`), (m) => [(+m[3] < 69 ? 2000 : 1900) + +m[3], +m[1], +m[2]]],
      [new RegExp(`^${MM}-${DD}-(\\d{4})$`), (m) => [+m[3], +m[1], +m[2]]],
      [new RegExp(`^${MM}\\.${DD}\\.(\\d{4})$`), (m) => [+m[3], +m[1], +m[2]]],
      [new RegExp(`^${DD}\\s+([A-Za-z]{3})\\s+(\\d{4})$`), (m) => [+m[3], monthWord(m[2]), +m[1]]],
      [new RegExp(`^([A-Za-z]{3})\\s+${DD},\\s+(\\d{4})$`), (m) => [+m[3], monthWord(m[1]), +m[2]]],
      [new RegExp(`^([A-Za-z]+)\\s+${DD},\\s+(\\d{4})$`), (m) => [+m[3], monthWord(m[1], true), +m[2]]],
    ];
    for (const [re, f] of tries) {
      const m = s.match(re);
      if (!m) continue;
      const [y, mo, d] = f(m);
      const dt = mk(y, mo, d);
      if (dt && dt.y >= 1900) return dt;
    }
    return null;
  }
  function parsePartial(v) {     // ["date"|"month"|"year", first day it can be]; null blank; false not a date
    if (v === null || v === undefined || (typeof v === "string" && !v.trim())) return null;
    const d = parseDate(v);
    if (d) return ["date", d];
    const t = String(v).split(/\s+/).filter(Boolean).join(" ");
    let m = t.match(/^X\s+([A-Za-z]{3})\s+(\d{4})$/i);
    if (m) {
      const mon = m[1].toLowerCase();
      return MONTHS.includes(mon) ? ["month", { y: +m[2], m: MONTHS.indexOf(mon) + 1, d: 1 }] : ["year", { y: +m[2], m: 1, d: 1 }];
    }
    m = t.match(/^(\d{4})-(\d{1,2})$/) || t.match(/^(\d{1,2})\s*[/.-]\s*(\d{4})$/);
    if (m) {
      const a = +m[1], b = +m[2];
      const [y, mo] = a > 31 ? [a, b] : [b, a];
      return mo >= 1 && mo <= 12 && y >= 1900 ? ["month", { y, m: mo, d: 1 }] : false;
    }
    m = t.match(/^([A-Za-z]{3,9})\.?,?\s*(\d{4})$/);
    if (m && MONTHS.includes(m[1].toLowerCase().slice(0, 3))) {
      const word = m[1].toLowerCase();
      const i = MONTHS.indexOf(word.slice(0, 3));
      if (MONTH_NAMES[i].startsWith(word) && +m[2] >= 1900) return ["month", { y: +m[2], m: i + 1, d: 1 }];
      return false;
    }
    m = t.match(/^(\d{4})$/);
    if (m) return +t >= 1900 ? ["year", { y: +t, m: 1, d: 1 }] : false;
    return false;
  }
  function isPartial(v) { const p = parsePartial(v); return !!p && p[0] !== "date"; }
  function anyDate(v) { const p = parsePartial(v); return p ? p[1] : null; }
  function ageOn(dob, when) {
    const b = anyDate(dob), w = parseDate(when);
    if (!b || !w) return null;
    return w.y - b.y - ((w.m < b.m || (w.m === b.m && w.d < b.d)) ? 1 : 0);
  }
  /** A birthday half a year back from an age, so the child is that age on `on` (as the desktop calculator does). */
  function dobFromAge(age, on) {
    on = parseDate(on) || today();
    let d = mk(on.y - age, on.m, on.d) || { y: on.y - age, m: on.m, d: 28 };   // 29 February
    return isoOf(addDays(d, -182));
  }
  const WEEKS_PER_MONTH = 4.3;
  function toWeekly(amount, freq) {
    const a = m0(amount);
    return ({ weekly: a, biweekly: a / 2, semimonthly: a * 2 / WEEKS_PER_MONTH, monthly: a / WEEKS_PER_MONTH,
      quarterly: a / 13, annual: a / 52, total24: a / 24 / WEEKS_PER_MONTH, "one-time": 0 })[freq || "monthly"] || 0;
  }
  function toAnnual(amount, freq) {
    const a = m0(amount);
    return ({ weekly: a * 52, biweekly: a * 26, semimonthly: a * 24, monthly: a * 12, quarterly: a * 4, annual: a,
      total24: a / 2, "one-time": a })[freq || "monthly"] || 0;
  }

  // ------------------------------------------------------------------------------------------------ figures and tables
  class TableError extends Error {}
  class CalcError extends Error {}

  function njFigures(when) {
    const d = parseDate(when) || today();
    const sets = DATA.sets.slice().sort((a, b) => (a.effective < b.effective ? -1 : a.effective > b.effective ? 1 : 0));
    let chosen = sets[0];
    for (const s of sets) if (cmp(parseDate(s.effective), d) <= 0) chosen = s;
    const out = Object.assign({}, chosen);
    out.note = cmp(parseDate(chosen.effective), d) <= 0 ? "" :
      `No figures are loaded for ${usDate(d)}; the ${chosen.effective} figures were used.`;
    return out;
  }
  const cache = {};
  function ixf(name) {
    if (cache[name]) return cache[name];
    const out = {};
    let prev = null;
    for (const r of DATA.tables[name]) {
      const inc = r[0], vals = r.slice(1, 7);
      if (prev) {
        if (inc !== prev[0] + 10) throw new TableError(`${name}: gap after $${prev[0]}`);
        if (vals.some((b, i) => b < prev[1][i])) throw new TableError(`${name}: an award goes down at $${inc}`);
      }
      out[inc] = vals;
      prev = [inc, vals];
    }
    return (cache[name] = out);
  }
  function ixh(name) {
    if (cache[name]) return cache[name];
    const out = DATA.tables[name].map((r) => [r[0], r[1], r.slice(2, 11)]);
    for (let i = 1; i < out.length; i++) {
      const [, a1, av] = out[i - 1], [b0, , bv] = out[i];
      if (b0 !== a1) throw new TableError(`${name}: gap or overlap at $${b0}`);
      if (bv.some((y, j) => y < av[j])) throw new TableError(`${name}: tax goes down at $${b0}`);
    }
    return (cache[name] = out);
  }
  function ixeFederal(name, corrections) {
    const key = name + JSON.stringify(corrections);
    if (cache[key]) return cache[key];
    const out = DATA.tables[name].map((r) => r.slice());
    const cols = { credit_pct: 2, max_credit_1_child: 3, max_credit_2_plus: 4 };
    for (const [frm, col, printed, used] of corrections) {
      for (const row of out) {
        if (row[0] === frm) {
          if (row[cols[col]] !== printed)
            throw new TableError(`${name}: correction for ${frm} expected ${printed}, found ${row[cols[col]]} – ` +
              "the table may have been fixed; check the corrections.");
          row[cols[col]] = used;
        }
      }
    }
    for (let i = 1; i < out.length; i++) {
      const a = out[i - 1], b = out[i];
      if (a[1] === null || b[0] !== a[1] + 1) throw new TableError(`${name}: gap at $${a[1]}`);
      if (b[2] > a[2] || b[3] > a[3] || b[4] > a[4]) throw new TableError(`${name}: credit goes up at $${b[0]}`);
      if (a[4] !== 2 * a[3]) throw new TableError(`${name}: 2-or-more column isn't twice the 1-child column at $${a[0]}`);
    }
    return (cache[key] = out);
  }
  function scheduleAward(fig, combined, nChildren) {      // IX-F: [award, row used, notes]
    const notes = [];
    const table = ixf(fig.ixf);
    const n = Math.max(1, Math.min(Math.trunc(nChildren), 6));
    if (nChildren > 6) notes.push("The schedule stops at six children; the six-child column was used.");
    let row = Math.trunc(R(combined / 10)) * 10;
    if (row < fig.schedule_min) {
      notes.push(`Combined net income is under $${fig.schedule_min} a week: the court sets an award between ` +
        `$${fig.low_award_min} and the $${fig.schedule_min} amount (IX-F). The $${fig.schedule_min} ` +
        "amount is shown as the most.");
      row = fig.schedule_min;
    }
    if (row > fig.schedule_max) {
      notes.push(`Combined net income is over $${fmt(fig.schedule_max)} a week: the $${fmt(fig.schedule_max)} award ` +
        "is the minimum and the court adds a discretionary amount (IX-A ¶20(b)). Never extrapolated.");
      row = fig.schedule_max;
    }
    return [table[row][n - 1], row, notes];
  }
  function ixhTax(fig, x, dependents) {                  // IX-H withholding; null above the table
    const d = Math.max(0, Math.min(intOf(dependents), 8));
    if (x < 0) return 0;
    for (const [lo, hi, taxes] of ixh(fig.ixh)) if (lo <= x && x < hi) return taxes[d];
    return null;
  }
  function ixeNetWeekly(fig, agi, annualCost, nChildren, njResident) {
    const table = ixeFederal(fig.ixe, fig.ixe_corrections);
    agi = R(agi);
    const cap = nChildren <= 1 ? fig.child_care_max_1 : fig.child_care_max_2;
    const l2 = R(annualCost);
    const l3 = Math.min(l2, cap);
    let row = agi < table[0][0] ? table[0] : table[table.length - 1];
    for (const r of table) {
      if ((r[1] === null && agi >= r[0]) || (r[0] <= agi && agi <= (r[1] || 1e12))) { row = r; break; }
    }
    const pct = row[2] / 100;
    let l4, l5;
    if (l2 < cap) { l4 = pct; l5 = R(l3 * pct); } else { l4 = null; l5 = nChildren <= 1 ? row[3] : row[4]; }
    let njPct = 0;
    if (njResident) for (const [limit, p] of fig.nj_credit_bands) if (agi <= limit) { njPct = p; break; }
    const l6 = R(l5 * njPct);
    const l7 = l2 - l5 - l6;
    const l8 = R(l7 / 52);
    return { L1: R(agi), L2: l2, L3: l3, L4: l4, L5: l5, L6: l6, L7: l7, L8: l8, nj_pct: njPct, row };
  }

  // ------------------------------------------------------------------------------------------------ inputs
  const PARENT_INPUTS = [  // [key, label, kind, worksheet line]
    ["gross_taxable", "Gross taxable income (weekly)", "money", "1"],
    ["mand_retirement", "Mandatory retirement contributions", "money", "1a"],
    ["alimony_paid_deductible", "Tax-deductible alimony paid (orders before 2019)", "money", "1b"],
    ["alimony_recv_taxable", "Taxable alimony received (orders before 2019)", "money", "1c"],
    ["tax_method", "Tax withholding method", "choice", "2a"],
    ["tax_typed", "Withholding typed (weekly; methods 2-4)", "money", "2a"],
    ["eligible_dependents", "Eligible dependents (IX-H)", "int", "2a"],
    ["self_employed", "Self-employed", "check", "2a"],
    ["union_dues", "Mandatory union dues", "money", "2b"],
    ["other_orders", "Child support orders for other dependents", "money", "2c"],
    ["other_dep_deduction", "Other dependent deduction", "money", "2d"],
    ["nontaxable", "Non-taxable income", "money", "4"],
    ["nontaxable_source", "Source of non-taxable income", "text", "4"],
    ["alimony_paid_nondeductible", "Non-deductible alimony paid", "money", "4a"],
    ["alimony_recv_nontaxable", "Non-taxable alimony received", "money", "4b"],
    ["gov_benefits_child", "Government benefits for the child counted as this parent's income", "money", "5"],
    ["gov_benefits_credit", "Benefits for the child based on this parent's contribution (credit)", "money", "15/22"],
    ["child_care_annual", "Work-related child care paid (yearly)", "money", "9/16"],
    ["agi_annual", "Adjusted gross income for IX-E (yearly; blank = (L1 + L4) x 52)", "money", "IX-E 1"],
    ["nj_resident", "New Jersey resident (state child care credit)", "check", "IX-E 6"],
    ["health_premium_child", "Child's share of health insurance premium paid (weekly)", "money", "10/17"],
    ["unreimbursed_over250", "Unreimbursed health care over $250/child/year paid (weekly)", "money", "11/18"],
    ["extraordinary", "Court-approved extraordinary expenses paid (weekly)", "money", "12/19"],
    ["overnights", "Overnights a year with this parent", "int", "20a/9"],
    ["household_size", "Persons in this parent's household", "int", "36"],
    ["other_adults_income", "Net income of other adults in the household (weekly)", "money", "36"],
  ];
  function newParent(name) {
    const p = {};
    for (const [k] of PARENT_INPUTS) p[k] = "";
    Object.assign(p, { name: name || "", tax_method: "ixh", eligible_dependents: 0, self_employed: false,
      nj_resident: true, overnights: "" });
    return p;
  }
  function newScenario(name, asOf) {
    return { name: name || "Estimate", as_of: isoOf(parseDate(asOf) || today()), worksheet: "auto",
      initial_order_date: "", custodial: "auto", parenting_plan: true, separate_accommodations: true,
      parents: { client: newParent("Client"), other: newParent("Other party") },
      children: [], deviation_amount: "", deviation_reason: "", notes: "" };
  }
  const get = (o, k, dflt) => (o && Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined ? o[k] : dflt);

  // ------------------------------------------------------------------------------------------------ the result
  class Result {
    constructor() {
      this.worksheet = ""; this.lines = []; this.cols = []; this.notes = []; this.warnings = [];
      this.order = 0; this.payer = ""; this.payee = ""; this.roles = {}; this.comments = []; this.figures = {};
      this.detail = {};
    }
    add(line, label, vals) { this.lines.push([line, label, vals || {}]); }
    summary(names) {
      names = names || { client: "Client", other: "Other party" };
      if (!this.payer || this.order <= 0) return "No child support order results from these figures.";
      return `${names[this.payer] || this.payer} pays ${names[this.payee] || this.payee} $${fmt(this.order)} a week ` +
        `(about $${fmt(this.order * 52 / 12)} a month) – ${this.worksheet} parenting worksheet.`;
    }
    text(names) {
      names = names || { client: "Client", other: "Other party" };
      const out = [`${this.worksheet === "sole" ? "Sole" : "Shared"} parenting worksheet ` +
        `(${this.worksheet === "sole" ? "IX-C" : "IX-D"}) – all amounts weekly`, ""];
      out.push(ljust("Line", 5) + " " + ljust("", 46) + this.cols.map(([, h]) => rjust(h, 15)).join(""));
      for (const [line, label, vals] of this.lines) {
        const cells = this.cols.map(([k]) => {
          const v = vals[k];
          if (v === null || v === undefined || v === "") return rjust("", 15);
          if (label.startsWith("Each parent's share of income") || label.startsWith("Each parent's share of overnights"))
            return rjust(fmt(v, 2, false), 15);
          if (typeof v === "number") return rjust(Number.isInteger(v) ? fmt(v, 0) : fmt(v, 2), 15);
          return rjust(String(v), 15);
        });
        out.push(ljust(line, 5) + " " + ljust(label.slice(0, 46), 46) + cells.join(""));
      }
      out.push("");
      out.push(this.summary(names));
      if (this.comments.length) out.push("", "Comments:", ...this.comments.map((c) => `  - ${c}`));
      if (this.warnings.length) out.push("", "Check:", ...this.warnings.map((w) => `  ! ${w}`));
      if (this.notes.length) out.push("", "Notes:", ...this.notes.map((n) => `  - ${n}`));
      return out.join("\n");
    }
  }

  // ------------------------------------------------------------------------------------------------ helpers
  const _v = (p, k) => m0(get(p, k, null));
  const _i = (p, k) => intOf(get(p, k, null));
  const childrenIn = (scn) => (scn.children || []).filter((ch) => get(ch, "include", true));
  const s_ = (n, one, many) => (n !== 1 ? many : one);

  function teenCount(scn, fig) {
    const when = parseDate(scn.initial_order_date) || parseDate(scn.as_of) || today();
    const n = childrenIn(scn).filter((ch) => (ageOn(ch.dob, when) || 0) >= fig.teen_age).length;
    return [n, usDate(when)];
  }

  function income(p, fig, drop) {                         // lines 1 - 6 for one parent
    const L = {};
    L["1"] = R(_v(p, "gross_taxable"));
    L["1a"] = R(_v(p, "mand_retirement"));
    L["1b"] = R(_v(p, "alimony_paid_deductible"));
    L["1c"] = R(_v(p, "alimony_recv_taxable"));
    L["2"] = L["1"] - L["1a"] - L["1b"] + L["1c"];
    const notes = [];
    let method;
    if ((p.tax_method || "ixh") === "typed") {
      L["2a"] = R(_v(p, "tax_typed"));
      method = "Other (returns / YTD withholding / self-employed)";
    } else {
      let t = ixhTax(fig, L["2"], _i(p, "eligible_dependents"));
      if (t === null)
        throw new CalcError(`${p.name || "A parent"}'s gross taxable income ($${fmt(L["2"])} a week) is above the ` +
          "IX-H table ($5,800). Choose 'Typed' and enter the withholding from the returns or " +
          "year-to-date (IX-B line 2a methods 2-4).");
      if (L["1c"]) {
        t -= fig.fica_rate * L["1c"];
        notes.push("taxable alimony: 7.65% of it taken off the IX-H amount (no FICA on alimony)");
      }
      if (p.self_employed) {
        if (L["2"] <= fig.ixh_ss_cutoff_weekly) {
          t += fig.fica_rate * L["2"];
          notes.push("self-employed: + 7.65% of gross taxable income (IX-H)");
        } else {
          t += fig.medicare_rate * L["2"] + fig.ixh_ss_weekly_max;
          notes.push(`self-employed above $${fmt(fig.ixh_ss_cutoff_weekly)}: + 1.45% + $${fig.ixh_ss_weekly_max} (IX-H)`);
        }
      }
      L["2a"] = R(t);
      method = "App IX-H";
    }
    L["2b"] = R(_v(p, "union_dues"));
    L["2c"] = drop ? 0 : R(_v(p, "other_orders"));
    L["2d"] = drop ? 0 : R(_v(p, "other_dep_deduction"));
    L["3"] = L["2"] - L["2a"] - L["2b"] - L["2c"] - L["2d"];
    L["4"] = R(_v(p, "nontaxable"));
    L["4a"] = R(_v(p, "alimony_paid_nondeductible"));
    L["4b"] = R(_v(p, "alimony_recv_nontaxable"));
    L["5"] = R(_v(p, "gov_benefits_child"));
    L["6"] = L["3"] + L["4"] - L["4a"] + L["4b"] + L["5"];
    L._method = method;
    L._notes = notes;
    return L;
  }

  function childCare(p, L, fig, nCc) {
    const cost = _v(p, "child_care_annual");
    if (cost <= 0) return [0, null];
    let agi = money(get(p, "agi_annual", null));
    if (agi === null) agi = (L["1"] + L["4"]) * 52;
    const w = ixeNetWeekly(fig, agi, cost, Math.max(1, nCc), !!p.nj_resident);
    return [w.L8, w];
  }
  const ratio = (a, total) => (total ? R(a / total, 2) : 0);

  // ------------------------------------------------------------------------------------------------ the calculation
  function compute(scn) {
    const fig = njFigures(scn.as_of);
    const res = new Result();
    res.figures = { effective: fig.effective, source: fig.source };
    if (fig.note) res.warnings.push(fig.note);
    const kids = childrenIn(scn);
    if (kids.length === 0)
      throw new CalcError("No children are included. Add the children of this relationship who are under 18 or still in " +
        "high school (IX-A ¶18).");
    const part = kids.filter((ch) => isPartial(ch.dob)).map((ch) => ch.name || "a child");
    if (part.length)
      res.notes.push(`Date of birth known only to the month or year for ${part.join(", ")}: the age is counted ` +
        "from the first day it can be – check the teenage adjustment and the child care age.");
    const pc = scn.parents.client, po = scn.parents.other;
    let on = { client: _i(pc, "overnights"), other: _i(po, "overnights") };
    let totalOn = on.client + on.other;
    if (totalOn === 0) {
      on = { client: 365, other: 0 };
      totalOn = 365;
      res.notes.push("No overnights entered: the client was taken to have all overnights.");
    }
    if (totalOn > 366) res.warnings.push(`Overnights add up to ${totalOn}, more than a year.`);
    let cust = scn.custodial || "auto";
    if (cust === "auto") {
      if (on.client === on.other) {
        cust = "client";
        res.notes.push("Overnights are equal: the client was taken as the parent of primary residence (the " +
          "parent where the child lives for school; change 'Custodial parent' if not).");
      } else cust = on.client > on.other ? "client" : "other";
    }
    const other = cust === "client" ? "other" : "client";
    const parShare = ratio(on[other], totalOn);
    let kind = scn.worksheet || "auto";
    const plan = get(scn, "parenting_plan", true), sep = get(scn, "separate_accommodations", true);
    if (kind === "auto") {
      kind = parShare >= fig.shared_threshold && plan && sep ? "shared" : "sole";
      if (parShare >= fig.shared_threshold && kind === "sole")
        res.notes.push("The other parent has 28% or more of the overnights, but shared parenting needs a " +
          "parenting plan and separate living accommodations (IX-A ¶14): sole worksheet used.");
    } else if (kind === "shared" && parShare < fig.shared_threshold) {
      res.notes.push(`PAR time is ${fmt(parShare * 100, 0, false)}%, under 28%: the shared worksheet can't be used (IX-D line 10). ` +
        "Sole worksheet used.");
      kind = "sole";
    }
    const hasOtherDeps = [pc, po].some((p) => ["other_orders", "other_dep_deduction"].some((k) => _v(p, k) !== 0));
    let r = worksheet(kind, scn, fig, cust, other, on, totalOn, hasOtherDeps, res);
    if (r.worksheet === "shared" && r.detail.fallback_sole) {
      const why = r.notes.filter((x) => x.startsWith("PPR household income"));
      r = worksheet("sole", scn, fig, cust, other, on, totalOn, hasOtherDeps, res);
      r.notes = r.notes.slice(0, res.notes.length).concat(why, r.notes.slice(res.notes.length));
    }
    return r;
  }

  function worksheet(kind, scn, fig, cust, other, on, totalOn, hasOtherDeps, res) {
    const run = kind === "sole" ? sole : shared;
    const r = run(scn, fig, cust, other, on, totalOn, false);
    if (hasOtherDeps) {
      const r2 = (r.worksheet === "sole" ? sole : shared)(scn, fig, cust, other, on, totalOn, true);
      const with_ = r.detail.net_obligation, without = r2.detail.net_obligation;
      const adj = R((with_ + without) / 2);
      const [a, b, c] = r.worksheet === "sole" ? ["22", "23", "24"] : ["30", "31", "32"];
      const col = r.worksheet === "sole" ? "ncp" : "par";
      r.add(a, "Order WITH other dependents (L2c, L2d)", { [col]: with_ });
      r.add(b, "Order WITHOUT other dependent deduction", { [col]: without });
      r.add(c, "Adjusted order ((with + without) / 2)", { [col]: adj });
      r.detail.net_obligation = adj;
      r.comments.push("Other dependents: the order is the average of the worksheets with and without lines 2c/2d " +
        "(IX-B). The line 2d deduction itself comes from a separate worksheet.");
    }
    r.figures = { effective: fig.effective, source: fig.source };
    r.notes = res.notes.concat(r.notes);
    r.warnings = res.warnings.concat(r.warnings);
    finish(r, scn, fig);
    return r;
  }

  function commonLines(r, scn, fig, a, b, cols, drop) {  // lines 1 - 8
    const pa = scn.parents[a], pb = scn.parents[b];
    const La = income(pa, fig, drop), Lb = income(pb, fig, drop);
    const [ca, cb] = cols;
    const rows = [["1", "Gross taxable income"], ["1a", "Mandatory retirement contributions"],
      ["1b", "Tax-deductible alimony paid"], ["1c", "Taxable alimony received"],
      ["2", "Adjusted gross taxable income"], ["2a", "Federal, state and local tax withholding"],
      ["2b", "Mandatory union dues"], ["2c", "Child support orders for other dependents"],
      ["2d", "Other dependent deduction"], ["3", "Net taxable income"], ["4", "Non-taxable income"],
      ["4a", "Non-tax-deductible alimony paid"], ["4b", "Non-taxable alimony received"],
      ["5", "Government benefits for the child"]];
    for (const [ln, label] of rows) r.add(ln, label, { [ca]: La[ln], [cb]: Lb[ln] });
    const comb = La["6"] + Lb["6"];
    r.add("6", "Net income", { [ca]: La["6"], [cb]: Lb["6"], combined: comb });
    if (comb <= 0) throw new CalcError("Combined net income is zero or less: the worksheet can't be completed.");
    const sa = ratio(La["6"], comb);
    const sb = R(1 - sa, 2);
    r.add("7", "Each parent's share of income", { [ca]: sa, [cb]: sb, combined: 1.0 });
    const n = childrenIn(scn).length;
    const [base, row, notes] = scheduleAward(fig, comb, n);
    r.notes.push(...notes);
    const [teens, when] = teenCount(scn, fig);
    let l8 = base;
    if (teens) {
      const adj = R(base * fig.teen_pct * teens / n);
      l8 = base + adj;
      r.comments.push(`Teenage adjustment (IX-A ¶17): ${teens} of ${n} child${s_(n, "", "ren")} 12 or older at ` +
        `the initial order (${when}): $${fmt(base)} + ${fmt(fig.teen_pct * 100, 1, false)}% x ${teens}/${n} = $${fmt(l8)}.`);
    }
    r.add("8", "Basic child support amount (IX-F)", { combined: l8 });
    r.comments.unshift(`Line 8: IX-F schedule, ${n} child${s_(n, "", "ren")}, combined net income row $${fmt(row)}.`);
    for (const [who, L] of [[a, La], [b, Lb]]) {
      const name = scn.parents[who].name || who;
      const dep = _i(scn.parents[who], "eligible_dependents");
      r.comments.push(`${name} taxes: ${L._method}` + (L._method === "App IX-H" ? `, # eligible dependents ${dep}` : "") +
        (L._notes.length ? ` (${L._notes.join("; ")})` : ""));
    }
    Object.assign(r.detail, { L: { [a]: La, [b]: Lb }, share: { [a]: sa, [b]: sb }, L8: l8, L8_base: base, comb, n, teens });
    return [La, Lb, sa, sb, l8];
  }

  function supplements(scn, fig) {
    const out = {};
    const asOf = parseDate(scn.as_of) || today();
    const nCc = childrenIn(scn).filter((ch) => (ageOn(ch.dob, asOf) || 0) < fig.childcare_age_limit || ch.disabled).length;
    for (const who of ["client", "other"]) {
      const p = scn.parents[who];
      const L = income(p, fig, false);
      const [cc, det] = childCare(p, L, fig, nCc || 1);
      out[who] = { cc, ixe: det, health: R(_v(p, "health_premium_child")), unreimb: R(_v(p, "unreimbursed_over250")),
        extra: R(_v(p, "extraordinary")) };
    }
    return [out, nCc];
  }

  function sole(scn, fig, cp, ncp, on, totalOn, drop) {
    const r = new Result();
    r.worksheet = "sole";
    r.roles = { [cp]: "CP", [ncp]: "NCP" };
    r.cols = [["cp", "Custodial"], ["ncp", "Non-custodial"], ["combined", "Combined"]];
    const [Lc, , sc, sn, l8] = commonLines(r, scn, fig, cp, ncp, ["cp", "ncp"], drop);
    const [sup, nCc] = supplements(scn, fig);
    const l9 = sup[cp].cc + sup[ncp].cc, l10 = sup[cp].health + sup[ncp].health;
    const l11 = sup[cp].unreimb + sup[ncp].unreimb, l12 = sup[cp].extra + sup[ncp].extra;
    const l13 = l8 + l9 + l10 + l11 + l12;
    r.add("9", "Net work-related child care (IX-E)", { combined: l9 });
    r.add("10", "Child's share of health insurance premium", { combined: l10 });
    r.add("11", "Unreimbursed health care over $250/child/year", { combined: l11 });
    r.add("12", "Court-approved extraordinary expenses", { combined: l12 });
    r.add("13", "Total child support amount", { combined: l13 });
    const l14c = R(sc * l13), l14n = R(sn * l13);
    r.add("14", "Each parent's share of support obligation", { cp: l14c, ncp: l14n });
    const l15 = R(_v(scn.parents[ncp], "gov_benefits_credit"));
    const l16 = Math.min(sup[ncp].cc, l9), l17 = Math.min(sup[ncp].health, l10);
    const l18 = Math.min(sup[ncp].unreimb, l11), l19 = Math.min(sup[ncp].extra, l12);
    r.add("15", "Gov't benefits for the child (NCP's record)", { ncp: l15 });
    r.add("16", "Net work-related child care paid", { ncp: l16 });
    r.add("17", "Health insurance premium for the child paid", { ncp: l17 });
    r.add("18", "Unreimbursed health care paid (>$250/child/yr)", { ncp: l18 });
    r.add("19", "Court-approved extraordinary expenses paid", { ncp: l19 });
    const shc = ratio(on[cp], totalOn);
    const shn = totalOn ? R(1 - shc, 2) : 0;
    const l20 = on[ncp] > 0 ? R(l8 * shn * fig.par_variable) : 0;
    r.add("20a", "Annual overnights with each parent", { cp: on[cp], ncp: on[ncp], combined: totalOn });
    r.add("20b", "Each parent's share of overnights", { cp: shc, ncp: shn, combined: 1.0 });
    r.add("20", "Parenting time adjustment (L8 x L20b x 0.37)", { ncp: l20 });
    const l21 = l14n - l15 - l16 - l17 - l18 - l19 - l20;
    r.add("21", "Net child support obligation", { ncp: l21 });
    Object.assign(r.detail, { net_obligation: l21, l14: { [cp]: l14c, [ncp]: l14n }, l20, sup, cp, ncp });
    if (l20) {                                           // IX-A ¶13
      const hh = _i(scn.parents[cp], "household_size") || (1 + r.detail.n);
      const thr = fig.ppr_threshold[String(Math.min(Math.max(hh, 2), 8))];
      const hhIncome = Lc["6"] + R(_v(scn.parents[cp], "other_adults_income")) + Math.max(l21, 0);
      if (thr && hhIncome < thr)
        r.warnings.push(`The custodial household's income ($${fmt(hhIncome)} a week incl. the order) is under ` +
          `twice the poverty guideline for ${hh} people ($${fmt(thr)}): the line 20 parenting-time ` +
          "credit is not presumptive (IX-A ¶13).");
    }
    if (r.detail.sup[cp].ixe || r.detail.sup[ncp].ixe)
      r.notes.push(`Child care counted for ${nCc} child${s_(nCc, "", "ren")} under ${fig.childcare_age_limit} (or disabled).`);
    return r;
  }

  function shared(scn, fig, ppr, par, on, totalOn, drop) {
    const r = new Result();
    r.worksheet = "shared";
    r.roles = { [ppr]: "PPR", [par]: "PAR" };
    r.cols = [["ppr", "PPR"], ["par", "PAR"], ["combined", "Combined"]];
    const [, , sp, sa, l8] = commonLines(r, scn, fig, ppr, par, ["ppr", "par"], drop);
    const shp = ratio(on[ppr], totalOn);
    const sha = R(1 - shp, 2);
    r.add("9", "Overnights with each parent", { ppr: on[ppr], par: on[par], combined: totalOn });
    r.add("10", "Each parent's share of overnights", { ppr: shp, par: sha, combined: 1.0 });
    const l11 = R(l8 * sha * fig.shared_fixed * 2);
    const l12 = l8 + l11;
    const l13p = R(sp * l12), l13a = R(sa * l12);
    const l14 = R(sha * l8 * fig.par_variable);
    const l15 = l13a - l11 - l14;
    r.add("11", "PAR fixed expenses (L8 x PAR L10 x .38 x 2)", { combined: l11 });
    r.add("12", "Shared parenting basic child support amount", { combined: l12 });
    r.add("13", "Each parent's share of SP basic amount", { ppr: l13p, par: l13a });
    r.add("14", "PAR variable expenses (PAR L10 x L8 x .37)", { par: l14 });
    r.add("15", "PAR adjusted SP basic child support amount", { par: l15 });
    const [sup] = supplements(scn, fig);
    const l16 = sup[ppr].cc + sup[par].cc, l17 = sup[ppr].health + sup[par].health;
    const l18 = sup[ppr].unreimb + sup[par].unreimb, l19 = sup[ppr].extra + sup[par].extra;
    const l20 = l16 + l17 + l18 + l19;
    const l21 = R(sa * l20);
    const l22 = R(_v(scn.parents[par], "gov_benefits_credit"));
    const l23 = Math.min(sup[par].cc, l16), l24 = Math.min(sup[par].health, l17);
    const l25 = Math.min(sup[par].unreimb, l18), l26 = Math.min(sup[par].extra, l19);
    const l27 = l22 + l23 + l24 + l25 + l26;
    const l28 = l21 - l27;
    const l29 = l15 + l28;
    for (const [ln, label, v] of [["16", "Net work-related child care (IX-E)", l16], ["17", "Child's share of health premium", l17],
      ["18", "Unreimbursed health care over $250/child/year", l18],
      ["19", "Court-approved extraordinary expenses", l19], ["20", "Total supplemental expenses", l20]])
      r.add(ln, label, { combined: v });
    r.add("21", "PAR's share of total supplemental expenses", { par: l21 });
    r.add("22", "Gov't benefits for the child (PAR's record)", { par: l22 });
    r.add("23", "PAR net work-related child care paid", { par: l23 });
    r.add("24", "PAR health insurance for the child paid", { par: l24 });
    r.add("25", "PAR unreimbursed health care paid", { par: l25 });
    r.add("26", "PAR court-approved extraordinary expenses paid", { par: l26 });
    r.add("27", "PAR supplemental expenses paid (L22-L26)", { par: l27 });
    r.add("28", "PAR net supplemental expenses (L21 - L27)", { par: l28 });
    r.add("29", "PAR net child support obligation (L15 + L28)", { par: l29 });
    if (l22) r.comments.push("Line 27 includes line 22 (government benefits), as IX-B says; the printed IX-D formula " +
      "(L23 + ... + L26) leaves it out.");
    Object.assign(r.detail, { net_obligation: l29, sup, ppr, par, l13: { [ppr]: l13p, [par]: l13a } });
    return r;
  }

  function finish(r, scn, fig) {                         // self-support reserve, household test, the order
    const ssr = fig.ssr_weekly;
    const L = r.detail.L;
    const net = r.detail.net_obligation;
    if (r.worksheet === "sole") {
      const cp = r.detail.cp, ncp = r.detail.ncp;
      const l25n = L[ncp]["6"] - net;
      const l25c = L[cp]["6"] - r.detail.l14[cp];
      r.add("25", "Self-support reserve test", { cp: l25c, ncp: l25n });
      let order = net;
      if (l25n < ssr && l25c > ssr) {
        const l26 = L[ncp]["6"] - ssr;
        r.add("26", `Maximum obligation (L6 - $${ssr} reserve)`, { ncp: l26 });
        order = l26;
        r.comments.push(`Self-support reserve ($${ssr}/week) applied: the order is limited to the obligor's net ` +
          "income less the reserve.");
      }
      if (order < fig.low_award_min && net > 0) {
        r.notes.push(`The result is under $${fig.low_award_min}: IX-A sets a minimum award of ` +
          `$${fig.low_award_min} a week for a low-income obligor (court's discretion).`);
        order = fig.low_award_min;
      }
      if (order < 0) {
        r.notes.push("Line 21 is negative (the credits exceed the share): no order from the non-custodial parent.");
        order = 0;
      }
      r.add("27", "Child support order", { ncp: order });
      r.order = order; r.payer = ncp; r.payee = cp;
    } else {
      const ppr = r.detail.ppr, par = r.detail.par;
      let obligor, oblige, order;
      if (net >= 0) {
        obligor = par; oblige = ppr;
        const l33a = L[par]["6"] - net;
        const l33p = L[ppr]["6"] - r.detail.l13[ppr];
        r.add("33", "Self-support reserve test", { ppr: l33p, par: l33a });
        order = net;
        if (l33a < ssr && l33p > ssr) {
          const l34 = L[par]["6"] - ssr;
          r.add("34", `Maximum obligation (L6 - $${ssr} reserve)`, { par: l34 });
          order = l34;
          r.comments.push(`Self-support reserve ($${ssr}/week) applied to the PAR.`);
        }
        order = Math.max(order, 0);
        r.add("35", "Child support order", { par: order });
        const hh = _i(scn.parents[ppr], "household_size") || (1 + r.detail.n);
        const thr = fig.ppr_threshold[String(Math.min(Math.max(hh, 2), 8))];
        const l36 = L[ppr]["6"] + R(_v(scn.parents[ppr], "other_adults_income")) + order;
        r.add("36", `PPR household test (min $${fmt(thr)} for ${hh})`, { ppr: l36 });
        if (thr && l36 < thr) {
          r.detail.fallback_sole = true;
          r.notes.push(`PPR household income ($${fmt(l36)}) is under the threshold for ${hh} people ($${fmt(thr)}): ` +
            "the sole parenting worksheet is used instead (IX-A ¶14, IX-D line 36).");
        }
      } else {
        obligor = ppr; oblige = par;
        order = -net;
        r.notes.push("Line 29 is negative: the PPR pays the PAR (IX-B line 29). The PPR has priority for the " +
          "self-support reserve.");
        if (L[ppr]["6"] - order < ssr) {
          order = Math.max(L[ppr]["6"] - ssr, 0);
          r.comments.push(`Self-support reserve ($${ssr}/week) applied to the PPR.`);
        }
        r.add("35", "Child support order (paid by the PPR)", { ppr: order });
      }
      r.order = order; r.payer = obligor; r.payee = oblige;
    }
    const dev = money(get(scn, "deviation_amount", null));
    if (dev !== null)
      r.comments.push(`Order differs from the guidelines award ($${fmt(r.order)}): $${fmt(dev, 2)} ordered. Reason: ` +
        `${scn.deviation_reason || "(not given)"}`);
    for (const who of ["client", "other"]) {
      const g = (L[who] || {})["2"] || 0;
      if (g >= 3700 && g < 3850 && (scn.parents[who].tax_method || "ixh") === "ixh")
        r.warnings.push(`${scn.parents[who].name || who}: income is just under $3,850 a week, where the ` +
          "IX-H child credit stops at once (about $42 a week per dependent).");
    }
    if (r.detail.comb >= 3400 && r.detail.comb <= 3600)
      r.warnings.push("Combined net income is near the $3,600 schedule limit; above it the award is the minimum " +
        "and the court adds a discretionary amount.");
  }

  // ------------------------------------------------------------------------------------------------ what-if
  const clone = (o) => JSON.parse(JSON.stringify(o));
  function whatIf(scn) {
    const out = [];
    let base;
    try { base = compute(scn); } catch (e) { if (e instanceof CalcError) return out; throw e; }
    const names = { client: scn.parents.client.name || "client", other: scn.parents.other.name || "other" };
    const signed = (x) => (x.payer === "client" ? x.order : -x.order);
    const b = signed(base);
    for (const who of ["client", "other"]) {
      const s = clone(scn);
      s.parents[who].gross_taxable = m0(s.parents[who].gross_taxable) + 100;
      let d;
      try { d = signed(compute(s)) - b; } catch (e) { if (e instanceof CalcError) continue; throw e; }
      if (d) out.push(`$100 a week more gross income for ${names[who]}: $${fmt(Math.abs(d))} a week ` +
        `${d > 0 ? "worse" : "better"} for the client.`);
    }
    if (base.worksheet === "sole") {
      const ncp = base.detail.ncp, cp = base.detail.cp;
      const total = m0(scn.parents.client.overnights) + m0(scn.parents.other.overnights);
      if (total) {
        const need = Math.trunc(0.28 * total + 0.999) - Math.trunc(m0(scn.parents[ncp].overnights));
        if (need > 0 && need <= 40)
          out.push(`${names[ncp]} is ${need} overnight${s_(need, "", "s")} a year short of 28% (shared ` +
            "parenting worksheet, if there is a parenting plan and separate accommodations).");
      }
      const s = clone(scn);
      s.parents[ncp].overnights = Math.trunc(m0(s.parents[ncp].overnights)) + 26;
      s.parents[cp].overnights = Math.max(0, Math.trunc(m0(s.parents[cp].overnights)) - 26);
      try {
        const r2 = compute(s);
        const d = r2.order - base.order;
        if (d) out.push(`One more overnight every two weeks with ${names[ncp]} (26 a year): the order ` +
          `${d > 0 ? "rises" : "falls"} by $${fmt(Math.abs(d))} a week` +
          (r2.worksheet === "shared" ? " (the shared worksheet applies)." : "."));
      } catch (e) { if (!(e instanceof CalcError)) throw e; }
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------------ alimony
  const PERCENTAGES = [20, 25, 30];
  function alimony(grossClient, grossOther, percentages) {   // gross a year each; a rule of thumb, not a guideline
    const a = m0(grossClient), b = m0(grossOther);
    const diff = Math.abs(a - b);
    const payer = diff < 0.005 ? "" : (a > b ? "client" : "other");
    const rows = (percentages || PERCENTAGES).map((pct) => {
      const year = diff * pct / 100;
      return { pct, annual: R(year), monthly: R(year / 12), weekly: R(year / 52) };
    });
    return { difference: R(diff), payer, payee: { client: "other", other: "client" }[payer] || "", rows };
  }

  const NJ = { money, m0, R, intOf, fmt, pyFixed, parseDate, parsePartial, isPartial, anyDate, ageOn, isoOf, usDate,
    today, addDays, dobFromAge, toWeekly, toAnnual, njFigures, scheduleAward, ixhTax, ixeNetWeekly, PARENT_INPUTS,
    newParent, newScenario, compute, whatIf, alimony, PERCENTAGES, Result, CalcError, TableError, DATA };
  if (typeof module !== "undefined" && module.exports) module.exports = NJ;
  else root.NJ = NJ;
})(typeof self !== "undefined" ? self : this);
