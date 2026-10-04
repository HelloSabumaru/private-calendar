"""Bundle vzic output as compressed data; no timezone downloads occur at runtime."""
import gzip
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
zones = {}
for path in sorted((root / 'zoneinfo').rglob('*.ics')):
    text = path.read_text().replace('\n', '\r\n')
    start, end = text.index('BEGIN:VTIMEZONE'), text.index('END:VTIMEZONE')
    zones[str(path.relative_to(root / 'zoneinfo')).removesuffix('.ics')] = text[start:end] + 'END:VTIMEZONE\r\n'
output = pathlib.Path('data/timezones.json.gz')
output.parent.mkdir(exist_ok=True)
payload = {'version': (root / 'version').read_text().strip(), 'zones': zones}
output.write_bytes(gzip.compress(json.dumps(payload, separators=(',', ':')).encode(), mtime=0))
print(f'Bundled {len(zones)} timezones ({output.stat().st_size} bytes).')
