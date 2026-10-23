# Thai translator notes — where English was ambiguous

English is the source of truth (PO Q9). This file records every spot where the Thai could
plausibly go two ways, what was chosen, and why — so a PO/QA review can disagree **here**
instead of discovering it later. Strings not listed below were considered unambiguous.

Status: Thai content authored by the i18n implementation card (t_5696ea45), pending the
PO validation that Q9 requires. Key/placeholder parity is machine-checked
(`npm run i18n:check`); this file is the human review list.

| Key | English | Thai chosen | Note / alternatives rejected |
| --- | --- | --- | --- |
| `app.name` | `Todo` | `Todo` | Product name is still the placeholder wordmark (ux-foundation §12.4 open question). Keep Latin script in both locales; do not transliterate to โทโด unless h_pm names the product in Thai. |
| `settings.language.english` | `English` | `English` | Endonym: identical in BOTH files, never translated — a language switcher always names languages in their own language. |
| `settings.language.thai` | `ไทย` | `ไทย` | Endonym: identical in BOTH files. |
| `common.top` / `common.bottom` | `top` / `bottom` | `ด้านบนสุด` / `ด้านล่างสุด` | Consumed only through `a11y.reorderBoundary` ("Already at the {edge}" → `อยู่ที่{edge}แล้ว`). Full forms chosen over bare `บน`/`ล่าง` so a screen reader hears an unambiguous position. No space before `{edge}` — Thai does not space before the noun phrase; placeholder parity is unaffected. |
| `nav.allOpen` / `view.allOpen` | `All open` | `ทั้งหมดที่ยังไม่เสร็จ` | "open" = a task not yet done → `ยังไม่เสร็จ`, not `เปิด` (physical open). Considerably longer than English: nav labels may wrap to 2 lines by design (ux-foundation §9.4), do not shorten to `ทั้งหมด` (loses the open/closed distinction against `เสร็จแล้ว`). |
| `all.empty.title` | `No open tasks` | `ไม่มีงานที่ยังไม่เสร็จ` | Same `open` decision as above, kept consistent. |
| `group.noDueDate` | `No due date` | `ไม่มีวันครบกำหนด` | `ครบกำหนด` (due/expire) chosen over `กำหนดส่ง` (reads as "submission deadline") and over bare `วันกำหนด` (ambiguous). |
| `list.color.teal` | `Teal` | `เขียวอมน้ำเงิน` | Thai has no single common word for teal (`เขียวน้ำเงิน`, `มรกต`/emerald all drift in hue). The compound stays distinguishable from `เขียว` (green) and `น้ำเงิน` (blue); colour is never the only signal anyway (§8: swatch + text label). |
| `view.count`, `list.item.count`, `search.results.count`, `a11y.listDeleted`, … | `{count} tasks` / `{count} results` | `{count} งาน` / `{count} ผลลัพธ์` | Thai has no plural inflection — one form is grammatically correct for 0, 1 and n. FLAG for PO (not silently fixed): the English source keeps the register's plural form even at `count = 1` ("1 results"). If that should change, add `.one`/`.other` key pairs per docs/i18n/README.md §2 instead of editing a register key in place. |
| `a11y.toggleTask` | `Mark "{title}" as complete` | `ทำเครื่องหมาย "{title}" ว่าเสร็จแล้ว` | The register defines only the "complete" direction; ux-foundation §6.8 describes a label that flips when done ("Mark … not complete"). The flip key (`a11y.toggleTask.undo` or similar → suggested `ยกเลิกเครื่องหมาย "{title}"`) is deliberately NOT invented here — the core-UI card must add it to BOTH locales when it implements the state-flipped accessible name. |
| `settings.appearance` | `Appearance` | `การแสดงผล` | The section groups the theme control; `รูปลักษณ์`/`หน้าตา` read as physical appearance. `settings.theme` separately renders `ธีม`, so the two headings stay distinct. |
| `settings.weekStart` | `Week starts on` | `วันเริ่มต้นสัปดาห์` | Rendered as a radio-group legend (not a sentence); `สัปดาห์เริ่มวัน` was rejected because it reads as an incomplete clause when announced alone. |
| `error.viewLoad.body` | `Try refreshing the page, or ` (trailing space) | `ลองรีเฟรชหน้านี้ หรือ ` | The sentence is split around a link (`error.viewLoad.back`). The trailing space is intentional — keep it verbatim; do not trim. |
| `app.tagline` | `A local-first todo app — …` | `แอป Todo แบบ local-first — …` | `local-first` kept as the English loanword (standard in Thai technical writing); no established Thai equivalent exists. |
| `a11y.languageChanged` | `Language changed to {language}` | `เปลี่ยนภาษาเป็น {language} แล้ว` | Announced after `lang` has already switched, i.e. in the NEW language, per §11.2/§9.4 — the message deliberately changes language with the locale. `แล้ว` marks completion (polite register). |
| `error.boot.body`, `confirm.deleteList.body`, `a11y.reorderUnavailable` | long instruction/consequence copy | see catalog | Highest-value strings for a PO spot-check: they carry the data-safety consequence ("data is still on this device") and the keyboard-reorder guidance. |
| `app.documentTitle` | `Todo — local-first` | `Todo — แอป local-first` | Tab title (QA defect D1, card t_a485d24d). A verbatim copy would render identically in both catalogs — the Thai tab would show no locale signal at all, which is the defect being fixed. `แอป` makes it read "local-first app" in Thai while `local-first` stays the English loanword (same decision as `app.tagline`). Rejected: the full meta-description sentence (far too long for a tab title) and any `โทโด` transliteration (`app.name` decision). FLAG for PO. |
| `app.metaDescription` | `A local-first, privacy-preserving todo app that runs entirely in your browser.` | `แอป Todo แบบ local-first ที่ปกป้องความเป็นส่วนตัว และทำงานในเบราว์เซอร์ของคุณเท่านั้น` | Opens with the exact `app.tagline` frame (`แอป Todo แบบ local-first`) so the two stay in register. `privacy-preserving` → `ที่ปกป้องความเป็นส่วนตัว` (verb phrase; `ที่เกี่ยวกับความเป็นส่วนตัว` reads as merely "privacy-related"). `runs entirely in your browser` → `ทำงานในเบราว์เซอร์ของคุณเท่านั้น` ("only in your browser") — `ทั้งหมด` was rejected because it dangles (all of what?) and the local-first claim is exclusivity, not volume. The space before `และ` mirrors the English comma boundary; no artificial spaces inside Thai words (general rules §9.3). FLAG for PO. |

General rules applied throughout (ux-foundation §9.3): no artificial spaces inside Thai words —
spaced-out Thai is broken Thai; spaces appear only where English has a punctuation boundary
(`·`, `—`, `:` mirrors). `…` and curly quotes are preserved as in the English source. Never add
`text-transform` or letter-spacing to these strings.