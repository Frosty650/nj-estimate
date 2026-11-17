# Support Calculator for iPhone – how it works

Last updated: 2026-11-17 · Current version: **1.0.1** (1.0.0 was named "NJ Estimate"; the repository is still `nj-estimate`, the cache prefix `nj-estimate-` and the storage key `njest.state.v1`, so nothing on the phones is lost) · same calculation as **Family Cases 0.3.4** (`family/`).

Reference for anyone (or any Claude conversation) maintaining the phone app. User guide: `estimate/SETUP.txt`. The desktop app: `family/FAMILY-HOW-IT-WORKS.md`; decisions: `family/FAMILY-APP-CONSIDERATIONS.md` (decision 31).

## Decisions (Christopher, 2026-11-16)
- **Web app (PWA)**, the same approach as Activity Entry for iPhone (`phone/`), with **its own icon** (teal: the Family Cases scales with a dollar coin).
- **Step one only:** a calculator with no sign-in – child support (Simple and Full detail) and the alimony rule of thumb, worked out on the phone, the worksheet viewable and shareable. **Saving an estimate to a consultation: later, if needed** (it would need Dropbox, as Activity Entry has).
- Nothing leaves the phone; the last inputs are kept in `localStorage` (key `njest.state.v1`) until *Start over*.
- **Hosting:** GitHub Pages, a second public repository (`nj-estimate`) under the Activity Entry account.

## Files
| File | Role |
|---|---|
| `index.html`, `app.css` | A start-up guard in the head (1.0.1): `SC_FAIL(msg)` shows a red box (`.boot-error`) for a script that fails to load (`onerror` on each script tag; a check after them that `NJ_DATA`, `NJ`, `NJApp` exist) or any uncaught error, with "Repair and reload" (`SC_REPAIR`: unregisters this folder's service worker, deletes the `nj-estimate-*` caches, reloads with `?r=`; localStorage is kept). Then the screens: Child support (Simple / Full detail, result, what would change it, assumed), Alimony, About; the result bar; the worksheet sheet; dialog; toast. Print shows only the worksheet text (`#printText`). |
| `js/engine.js` | **The calculation – a line-for-line port** of `fc_njcs.py` (`compute`, `what_if`, `Result.text/summary`), `fc_figures.py` (set by date, table checks, IX-F/IX-H/IX-E), `fc_alimony.py` and the `fc_model.py` helpers (`money`, `round_half_up`, dates incl. partial dates, `age_on`, `to_weekly`/`to_annual`). Python's number formatting is copied exactly (`pyFixed`: the exact binary value, ties to even). Runs in Node for the tests. |
| `js/tables.js` | **Generated** by `tools/make_tables.py` from Family Cases' `NJ_SETS` and `data/*.csv` (tables as printed; `engine.js` applies the corrections and checks them on loading, as `fc_figures` does). Never edit by hand. Not stored in the project (generated, 58 KB): it is in the release zip, or run the tool. Likewise the `icons/` images (`tools/make_icon.py`). |
| `js/app.js` | Screens only. Mirrors the desktop `CalculatorWidget` / `AlimonyWidget` / `EstimateWindow`: ages kept as `age_entered` → a birthday half a year back from the age on the calculation date (`NJ.dobFromAge`); earnings kept as `income_amount` + `income_freq` beside the weekly `gross_taxable` (rounded to cents as Python's `round`); arrangement buttons (`PRESETS`) and `touched` (the other overnight box follows until typed in); the Assumed list and the sheet text built as `CalculatorWidget.calculate()` does; alimony starts from `gross_taxable × 52` (blue) until typed. The calculation date is today unless one is chosen in Full detail (`asOfTyped`). |
| `sw.js` | Offline cache, **network first** from 1.0.1 (online: the file is fetched – revalidated, `cache: "no-cache"`, except page loads – and the cache refreshed; offline: the cache). Install adds the files one by one, so one missing file doesn't leave nothing cached. **Bump `VERSION`** (and `APP_VERSION` in `js/app.js`) with every release. It shares `yourname.github.io` with Activity Entry, whose service worker deletes every cache but its own when it updates: this one deletes only `nj-estimate-*` caches and refills its cache from any online visit. |
| `manifest.webmanifest`, `icons/` | Home-screen name and icons (`tools/make_icon.py`). |
| `tools/make_tables.py`, `tools/make_icon.py` | Run on a computer: `python tools/make_tables.py <family folder>`. |
| `tests/parity.py` (+ `engine_runner.js`) | Generates thousands of varied scenarios (children, full / partial / missing birth dates, incomes typed as numbers or "$1,234.50", overnights, every Full detail adjustment, worksheet / custodial settings, deviations, dates before the figures) and compares **everything** the two engines give: every worksheet line and column, order, payer, roles, notes, warnings, comments, the worksheet text, the what-if lines and the alimony rows. Must end "0 differ". 1.0.0: 10,000 scenarios, 0 differ; a one-line change to the engine is caught (128 of 600 differ). |
| `tests/e2e.py` | Playwright + Chrome at iPhone size: types a case and checks the phone's figure and sheet text against Python; equal time → shared; Full detail (child care, health insurance, typed tax, names); the amber "Full detail holds" note; alimony from the child support incomes and typed monthly; restart keeps the inputs; offline; offline again after another app cleared the caches; Start over. Screenshots in `tests/shots/`. |

## Keeping it in step with Family Cases
1. Change the Python first (`family/fc_njcs.py`, `fc_figures.py`, `fc_alimony.py`) and its tests.
2. Make the same change in `js/engine.js`; if figures or tables changed, run `tools/make_tables.py`.
3. `python tests/parity.py <family folder> --n 10000` → 0 differ; `python tests/e2e.py <family folder>` → all passed.
4. Bump `VERSION` in `sw.js` and `APP_VERSION` in `js/app.js`; update the version here and in `SETUP.txt`; upload.

## History
- **1.0.1 (2026-11-17).** Renamed **Support Calculator** (Christopher). On Christopher's iPhone 1.0.0 showed the page with no children buttons and no response to any tap – the program had not run. The code is plain ES2017 (checked with acorn) and passes every test in Chrome; WebKit can't be run here, and the same picture appears in Chrome when `js/engine.js` is missing from the site, so the likely cause is a file that didn't reach the repository (or a stale cache). 1.0.1 adds the start-up guard (it names the file or the error), binds the tab buttons before anything else, and makes the service worker network-first. `tests/e2e.py` checks the guard with `js/engine.js` removed.
- **1.0.0 (2026-11-16).** First version. Porting found a bug in Family Cases (fixed in 0.3.4): when the shared worksheet's PPR household test (IX-D line 36) failed, the note said the sole worksheet was used but the shared result was kept. Both engines now use the sole worksheet, with that note first.
