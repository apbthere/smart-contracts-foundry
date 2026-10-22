#!/usr/bin/env bash
# Prints a Markdown coverage table from an lcov file and fails if any total metric is below a threshold.
# Usage: coverage-summary.sh <lcov.info> <min-percent>
set -euo pipefail

lcov_file="$1"
min="$2"

awk -F: -v min="$min" '
function pct(hit, found) { return found == 0 ? 100 : 100 * hit / found }
function cell(hit, found) { return sprintf("%.2f%% (%d/%d)", pct(hit, found), hit, found) }

/^SF:/  { file = $2; files[++n] = file }
/^LF:/  { lf[file] = $2; LF += $2 }
/^LH:/  { lh[file] = $2; LH += $2 }
/^BRF:/ { bf[file] = $2; BF += $2 }
/^BRH:/ { bh[file] = $2; BH += $2 }
/^FNF:/ { ff[file] = $2; FF += $2 }
/^FNH:/ { fh[file] = $2; FH += $2 }

END {
    print "| File | Lines | Branches | Functions |"
    print "|---|---|---|---|"
    for (i = 1; i <= n; i++) {
        f = files[i]
        printf "| %s | %s | %s | %s |\n", f, cell(lh[f], lf[f]), cell(bh[f], bf[f]), cell(fh[f], ff[f])
    }
    printf "| **Total** | **%s** | **%s** | **%s** |\n", cell(LH, LF), cell(BH, BF), cell(FH, FF)

    failed = 0
    if (pct(LH, LF) < min) { failed = 1; printf "\nLine coverage %.2f%% is below %s%%\n", pct(LH, LF), min }
    if (pct(BH, BF) < min) { failed = 1; printf "\nBranch coverage %.2f%% is below %s%%\n", pct(BH, BF), min }
    if (pct(FH, FF) < min) { failed = 1; printf "\nFunction coverage %.2f%% is below %s%%\n", pct(FH, FF), min }
    exit failed
}
' "$lcov_file"
