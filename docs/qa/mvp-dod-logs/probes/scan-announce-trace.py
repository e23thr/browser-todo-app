#!/usr/bin/env python3
"""Read the polite live-region sequence out of Playwright traces (MVP DoD gate t_7f1e8f29).

Usage:
    python3 docs/qa/mvp-dod-logs/probes/scan-announce-trace.py <dir-or-trace.zip> [...]

For every *.zip containing 'trace' under each argument (or the file itself), extract it and
print the `[role="status"]` text captured in each DOM snapshot with its trace timestamp. Used to
prove that `a11y.taskSaved` never reached the live region in the failing keyboard run — see
docs/qa/mvp-dod-logs/announce-taskSaved-race.md.

Only stdlib; safe (read-only).
"""

import os
import re
import sys
import zipfile

# The trace stores the snapshot as a JSON-in-JSON string: flatten one level of \" first.
PAT = re.compile(r'"role":"status","aria-live":"polite"\}?(?:,\s*"((?:[^"\\]|\\.)*)")?')
TS = re.compile(r'"timestamp":([0-9.]+)')


def scan_trace_file(path):
    rows = []
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if "live-regions" not in line:
                continue
            flat = line.replace('\\"', '"')
            m_ts = TS.search(flat)
            ts = float(m_ts.group(1)) if m_ts else None
            for m in PAT.finditer(flat):
                rows.append((ts, m.group(1)))
    return rows


def run(target):
    zips = []
    if os.path.isfile(target):
        zips = [target]
    else:
        for root, _dirs, files in os.walk(target):
            for f in files:
                if f.endswith(".zip") and "trace" in f:
                    zips.append(os.path.join(root, f))
    if not zips:
        print(f"[{target}] no trace.zip found")
        return
    for z in sorted(zips):
        ext = z + ".ext"
        os.makedirs(ext, exist_ok=True)
        with zipfile.ZipFile(z) as zf:
            zf.extractall(ext)
        tfiles = []
        for root, _d, files in os.walk(ext):
            for f in files:
                if f.endswith(".trace"):
                    tfiles.append(os.path.join(root, f))
        print(f"--- {z} (traces: {len(tfiles)}) ---")
        for tf in sorted(tfiles):
            rows = scan_trace_file(tf)
            if not rows:
                print("  (no live-region snapshots)")
                continue
            last = object()
            for ts, text in rows:
                if text == last:
                    continue
                last = text
                print(f"  {ts}\tstatus={text!r}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    for target in sys.argv[1:]:
        run(target)
