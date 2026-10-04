#!/usr/bin/env bash
set -euo pipefail
mkdir -p .interop
if [[ ! -x .interop/venv/bin/python ]]; then python3 -m venv .interop/venv; fi
.interop/venv/bin/pip install --quiet -r tests/interop-requirements.txt
npm run build
.interop/venv/bin/python tests/interop.py
