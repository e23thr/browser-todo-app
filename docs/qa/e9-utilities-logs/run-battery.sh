#!/bin/bash
cd "$(dirname "$0")/../../.."
LOG=docs/qa/e9-utilities-logs/battery-9ee9669.txt
: > "$LOG"
for s in format:check lint typecheck i18n:check test:coverage build budget audit:gate; do
  echo "=== npm run $s ===" >> "$LOG"
  npm run "$s" >> "$LOG" 2>&1
  echo "exit=$? for npm run $s" >> "$LOG"
done
echo "BATTERY_DONE" >> "$LOG"
