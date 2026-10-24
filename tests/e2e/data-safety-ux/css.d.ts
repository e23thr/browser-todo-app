/**
 * Vite serves `*.css` imports at build time (the UX harness pulls the production
 * stylesheets so the real-browser a11y pass sees real focus styles). TypeScript's e2e
 * project has no `vite/client` types, so side-effect CSS imports need this ambient
 * module declaration.
 */
declare module '*.css';
