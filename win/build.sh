#!/usr/bin/env bash
# Manual build of the native helper (win/desktop.ts does the same on first use).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p out/win
/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe /nologo /optimize /platform:x64 /nowarn:0168,0649,0169 /main:PukWin \
  "/out:$(wslpath -w out/win/puk-win-dev.exe)" /r:System.Drawing.dll /r:System.Windows.Forms.dll \
  "$(wslpath -w win/helper.cs)" "$(wslpath -w win/vendor/VirtualDesktop11-24H2.cs)"
