/**
 * English locale pack — a separate lazy chunk so the catalog is NOT part of the initial JS
 * closure (§9.2 `locales-lazy` gate; E1's manifest-key convention `^src/i18n/` with the tag
 * extracted from this file's basename, so the boot locale `en` is counted in the app-shell
 * sum). Loaded by `setLocale()`/`initLocale()` through `import()` in `index.ts`.
 */
import messages from './en.json';

export default messages;
