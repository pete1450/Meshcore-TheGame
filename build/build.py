#!/usr/bin/env python3
"""Build the single-file MeshCore signal-map game."""
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).parent
# optional output path arg (for CI); defaults to the local preview location
OUT = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path.home() / 'workspace/your_files/meshcore-signal/index.html'

# run node tests first
r = subprocess.run(['node', 'tests/test_logic.js'], cwd=HERE, capture_output=True, text=True)
print(r.stdout.strip())
if r.returncode != 0:
    print(r.stderr)
    raise SystemExit('logic tests failed — build aborted')

head = (HERE / 'head.html').read_text()
three = (HERE / 'three.min.js').read_text()
logic = (HERE / 'logic.js').read_text()
game = (HERE / 'game.js').read_text()

html = head.replace('/*__THREE__*/', three)
html = html.replace('/*__LOGIC__*/', logic)
html = html.replace('/*__GAME__*/', game)

OUT.write_text(html)
print(f'built {OUT} ({OUT.stat().st_size / 1024:.0f} KB)')
