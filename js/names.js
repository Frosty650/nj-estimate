/* The firm's name rule for Activity Entry for iPhone - a JavaScript copy of shared/firm_names.py (version 2,
   with titles). KEEP IT IN STEP WITH THE PYTHON FILE: phone/tests/names_parity.js checks every case of
   shared/test_firm_names.py and compares hundreds of names with the Python results.
     "Kim, Dong Hyun" (comma: family name first) = "Dong Hyun Kim" (no comma: last word is the family name)
     stored / shown as "Kim, Dong Hyun"; Western form "Dong Hyun Kim". */
(function (root) {
  "use strict";

  const NAMES_VERSION = 2;
  const SUFFIXES = { JR: "Jr.", SR: "Sr.", II: "II", III: "III", IV: "IV", V: "V", ESQ: "Esq." };
  const TITLES = { MR: "Mr", MRS: "Mrs", MS: "Ms", MISS: "Miss", DR: "Dr", REV: "Rev", MX: "Mx" };
  const KOREAN_FAMILY_NAMES = new Set(("AHN AN BAE BAEK PAIK BAN BANG BYUN BYEON CHA CHAE CHOI CHOE CHO JO CHOO CHU " +
    "CHUN JEON JUN CHUNG JUNG JEONG DO GO KO GOO KOO KU GU HA HAM HAN HEO HUR HUH HONG HWANG HYUN IM LIM YIM JANG " +
    "CHANG JI JIN JOO JU KANG KIM KWAK KWON GWON LEE YI RHEE RYU YOO YU MA MIN MOON MUN NA NAM NOH ROH OH OK PARK " +
    "BAK PYO SEO SUH SEOK SHIN SIN SHIM SIM SO SON SOHN SONG SUNG SEONG TAK UHM EOM UM WON WOO WU YANG YEO YOON YUN " +
    "YOUN GIL KIL MAENG MYUNG PI SEOL SUL WI YEOM GONG KONG GEUM KEUM KI GI EUN IN JE MO SA BONG GAM KAM").split(" "));
  const TOP_FAMILY_NAMES = new Set(("KIM LEE YI RHEE PARK BAK CHOI CHOE JUNG JEONG CHUNG KANG CHO JO YOON YUN JANG " +
    "CHANG LIM YIM HAN OH SEO SUH SHIN KWON HWANG AHN SONG YOO RYU HONG JEON CHUN KO GO MOON YANG SON SOHN BAE BAEK " +
    "PAIK HEO HUR NAM NOH ROH KWAK SUNG CHA JOO KOO UHM CHAE BYUN").split(" "));

  function Name(family = "", given = "", suffix = "", title = "") {
    return { family, given, suffix, title };
  }
  function standard(n) {
    const rest = [n.given, n.suffix].filter(Boolean).join(" ");
    if (n.family && rest) return `${n.family}, ${rest}`;
    return [n.title, n.family || rest].filter(Boolean).join(" ");
  }
  const western = (n) => [n.title, n.given, n.family, n.suffix].filter(Boolean).join(" ");
  const tab = (n) => standard(n).toUpperCase();

  function cleanSpaces(s) {
    s = String(s || "").normalize("NFC");
    s = s.replace(/ /g, " ").replace(/\s+/g, " ").trim();
    s = s.replace(/\s*,\s*/g, ", ");
    s = s.replace(/\s*-\s*/g, "-");
    return s.replace(/^[ ,]+|[ ,]+$/g, "");
  }
  const hasCased = (w) => w !== w.toUpperCase() || w !== w.toLowerCase();
  const isUpper = (w) => hasCased(w) && w === w.toUpperCase();
  const isLower = (w) => hasCased(w) && w === w.toLowerCase();
  const stripDots = (w) => w.toUpperCase().replace(/\.+$/, "");

  function tidyWord(w) {
    if (!w || !(isUpper(w) || isLower(w))) return w;
    if (stripDots(w) in SUFFIXES) return SUFFIXES[stripDots(w)];
    return w.replace(/[A-Za-zÀ-ÿ]+/g, (m) => m[0].toUpperCase() + m.slice(1).toLowerCase());
  }
  const tidyCase = (s) => cleanSpaces(s).split(" ").filter(Boolean).map(tidyWord).join(" ");

  function splitSuffix(words) {
    if (words.length >= 2 && stripDots(words[words.length - 1]) in SUFFIXES)
      return [words.slice(0, -1), SUFFIXES[stripDots(words[words.length - 1])]];
    return [words, ""];
  }
  function splitTitle(t) {
    const m = t.match(/^([A-Za-z]+)\.?\s+(\S.*)$/);
    if (m && m[1].toUpperCase() in TITLES) return [TITLES[m[1].toUpperCase()], m[2].replace(/^[ ,]+|[ ,]+$/g, "")];
    return ["", t];
  }

  function parse(text) {
    const [title, t] = splitTitle(cleanSpaces(text));
    if (!t) return Name();
    if (t.includes(",")) {
      const i = t.indexOf(",");
      const family = t.slice(0, i);
      let [rest, suffix] = splitSuffix(t.slice(i + 1).replace(/,/g, " ").split(" ").filter(Boolean));
      if (!rest.length && suffix) { rest = [suffix]; suffix = ""; }
      return Name(tidyCase(family), tidyCase(rest.join(" ")), suffix, title);
    }
    const [words, suffix] = splitSuffix(t.split(" "));
    if (words.length === 1) return Name(tidyCase(words[0]), "", suffix, title);
    return Name(tidyCase(words[words.length - 1]), tidyCase(words.slice(0, -1).join(" ")), suffix, title);
  }

  function fromParts(family, given, suffix = "", title = "") {
    const s = String(suffix).trim(), t = String(title).trim().replace(/\.+$/, "");
    return Name(tidyCase(family), tidyCase(given), SUFFIXES[stripDots(s)] || s, TITLES[t.toUpperCase()] || t);
  }

  /** [the rule's reading, the other reading (family name first) or null] for what was typed. */
  function readings(text) {
    const [title, t] = splitTitle(cleanSpaces(text));
    const first = parse(text);
    if (t.includes(",") || !first.given) return [first, null];
    const [words, suffix] = splitSuffix(t.split(" "));
    return [first, Name(tidyCase(words[0]), tidyCase(words.slice(1).join(" ")), suffix, title)];
  }

  function looksFamilyFirst(text) {
    const t = splitTitle(cleanSpaces(text))[1];
    if (t.includes(",")) return false;
    const words = splitSuffix(t.split(" "))[0];
    if (words.length < 2) return false;
    const first = words[0].toUpperCase().replace(/\./g, ""), last = words[words.length - 1].toUpperCase().replace(/\./g, "");
    return KOREAN_FAMILY_NAMES.has(first) && !TOP_FAMILY_NAMES.has(last);
  }

  function fold(s) {
    s = String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "");
    return s.toLowerCase().replace(/-/g, " ").replace(/'/g, "").replace(/[^a-z0-9 ]+/g, " ");
  }
  const asName = (x) => (x && typeof x === "object" ? x : parse(x));
  const tokens = (x) => { const n = asName(x); return fold(`${n.family} ${n.given}`).split(" ").filter(Boolean); };
  const joinedKey = (x) => { const n = asName(x); return fold(n.family).replace(/ /g, "") + "|" + fold(n.given).replace(/ /g, ""); };

  function samePersonLikely(a, b) {
    const ta = tokens(a), tb = tokens(b);
    if (!ta.length || !tb.length) return false;
    const sa = [...ta].sort(), sb = [...tb].sort();
    if (sa.join(" ") === sb.join(" ")) return true;
    return sa.join("") === sb.join("") || joinedKey(a) === joinedKey(b);
  }

  function searchMatches(query, candidate) {
    const q = fold(query).split(" ").filter(Boolean);
    if (!q.length) return true;
    const c = tokens(candidate);
    const joined = c.join("");
    return q.every((x) => c.some((w) => w.startsWith(x)) || joined.includes(x));
  }

  function sortKey(x) { const n = asName(x); return [fold(n.family).trim(), fold(n.given).trim(), n.suffix]; }
  function compare(a, b) {
    const ka = sortKey(a), kb = sortKey(b);
    for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    return 0;
  }

  const api = { NAMES_VERSION, Name, standard, western, tab, parse, fromParts, readings, looksFamilyFirst, tokens,
    samePersonLikely, searchMatches, sortKey, compare, tidyCase };
  root.AENames = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
