#!/usr/bin/env bash
set -euo pipefail
CALENDAR_TZ_RELEASE=2026e
CALENDAR_TZ_SHA=b26882805f26aac59d5b222978e6580484b834ccdc98be89df2f05a6dc53a652
CALENDAR_VZIC_REV=42f509c9a613874a04af0d35be166c703a77389f
calendar_tmp=$(mktemp -d)
trap 'rm -rf "$calendar_tmp"' EXIT
mkdir "$calendar_tmp/tzdata"
curl -fsSL "https://data.iana.org/time-zones/releases/tzdata${CALENDAR_TZ_RELEASE}.tar.gz" -o "$calendar_tmp/tzdata.tar.gz"
echo "$CALENDAR_TZ_SHA  $calendar_tmp/tzdata.tar.gz" | sha256sum --check
tar xzf "$calendar_tmp/tzdata.tar.gz" -C "$calendar_tmp/tzdata"
git clone --quiet https://github.com/libical/vzic "$calendar_tmp/vzic"
git -C "$calendar_tmp/vzic" checkout --quiet "$CALENDAR_VZIC_REV"
make -C "$calendar_tmp/vzic" TZID_PREFIX= OLSON_DIR="$calendar_tmp/tzdata"
"$calendar_tmp/vzic/vzic" --pure --olson-dir "$calendar_tmp/tzdata" --output-dir "$calendar_tmp/tzdata/zoneinfo"
python3 scripts/bundle-timezones.py "$calendar_tmp/tzdata"
