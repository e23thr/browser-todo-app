/**
 * Portable QA-evidence output (t_61309e52).
 *
 * Several suites record a human-readable evidence file after they run — the QA gate reads those
 * artifacts. They used to write into the per-profile Hermes scratch directory of the dev host
 * (`<home>/.hermes/…`), a path that exists only on the machine that authored it, so the unit job
 * died with ENOENT on the GitHub runner (CI run 40194624821).
 *
 * Evidence now lands in `<repo>/test-results/evidence/`, which is already in `.gitignore`,
 * `.prettierignore` and the ESLint ignore list — the output never dirties the tree and needs no
 * committed fixture (these files are RUN OUTPUT; nothing reads them back). `QA_EVIDENCE_DIR`
 * redirects the output, e.g. a QA reviewer pointing the suite at their own scratch dir.
 *
 * The path is anchored on the working directory, not on `import.meta.url`: both runners start at
 * the repo root (`npm run test*` sets cwd to the package root; Playwright resolves from the
 * config), while the component suites run inside jsdom, whose URL implementation resolves
 * relative URLs against the document base (`http://localhost:3000/…`) instead of the module —
 * `fileURLToPath` on that is a scheme error. The directory is created with `recursive: true`, so
 * the write can never fail with ENOENT no matter where a run happens to start.
 */
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_EVIDENCE_DIR = path.resolve('test-results', 'evidence');

/** Evidence directory: `QA_EVIDENCE_DIR` override when set, otherwise the repo-local default. */
function evidenceDir(): string {
  const override = process.env['QA_EVIDENCE_DIR'];
  return override !== undefined && override !== '' ? override : DEFAULT_EVIDENCE_DIR;
}

/** Absolute path of `fileName` inside the evidence directory (no I/O performed). */
export function evidencePath(fileName: string): string {
  return path.join(evidenceDir(), fileName);
}

/** Create the evidence directory if needed and write `content` to `fileName`. */
export function writeEvidence(fileName: string, content: string): void {
  const file = evidencePath(fileName);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
