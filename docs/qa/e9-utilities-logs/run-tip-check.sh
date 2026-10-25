#!/bin/bash
cd "$(dirname "$0")/../../.."
LOG=docs/qa/e9-utilities-logs/battery-ad4acc3.txt
: > "$LOG"
echo "HEAD=$(git rev-parse --short HEAD)" >> "$LOG"
for s in format:check lint typecheck i18n:check test:coverage build budget audit:gate; do
  echo "=== npm run $s ===" >> "$LOG"
  npm run "$s" >> "$LOG" 2>&1
  echo "exit=$? for npm run $s" >> "$LOG"
done
echo "=== QA probes at tip ===" >> "$LOG"
npx vitest run tests/unit/portability/e9-qa-probes.test.ts tests/unit/data-safety/e9-qa-export-probes.test.ts tests/component/e9-qa-dashboard-probes.test.tsx >> "$LOG" 2>&1
echo "exit=$? for QA probes" >> "$LOG"
echo "TIP_CHECK_DONE" >> "$LOG"
