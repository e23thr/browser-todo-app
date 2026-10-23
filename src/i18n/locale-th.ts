/**
 * Thai locale pack — same lazy-chunk contract as `locale-en.ts` (§9.2: per-locale lazy load,
 * never in the initial payload; manifest key `src/i18n/locale-th.ts` → tag `th`). Thai text
 * renders through the system font stack — no webfont bytes ship with it (§9.2/§7.2).
 */
import messages from './th.json';

export default messages;
