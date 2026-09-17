#!/usr/bin/env python3
"""Refresh the pinned, offline encoder. Requires network only when vendoring."""
import hashlib
import re
import urllib.request
from pathlib import Path

VERSION = 'v0.6.8'
SHA256 = '18be6cbbb3b990409af51732c1ec33a495e5cd83ad35d0ba1b64ee7a12abb309'
ROOT = Path(__file__).resolve().parents[1] / 'public/vendor/cimbar'
BASE = f'https://raw.githubusercontent.com/sz3/libcimbar/{VERSION}/'

def fetch(url):
    with urllib.request.urlopen(url, timeout=60) as response:
        return response.read()

html = fetch(f'https://github.com/sz3/libcimbar/releases/download/{VERSION}/cimbar_js.html')
assert hashlib.sha256(html).hexdigest() == SHA256, 'Upstream release hash mismatch'
scripts = re.findall(rb'<script[^>]*>(.*?)</script>', html, re.S)
assert len(scripts) == 5 and b'_cimbare_init_encode' in scripts[4], 'Unexpected release structure'
ROOT.mkdir(parents=True, exist_ok=True)
(ROOT / 'cimbar.js').write_bytes(scripts[4])
(ROOT / 'LICENSE').write_bytes(fetch(BASE + 'LICENSE'))
licenses = ['PicoSHA2/LICENSE', 'base91/LICENSE', 'concurrentqueue/LICENSE.md', 'cxxopts/LICENSE',
            'fmt/LICENSE', 'intx/LICENSE', 'libcorrect/LICENSE', 'libpopcnt/LICENSE', 'stb/LICENSE',
            'wirehair/LICENSE', 'zstd/LICENSE']
(ROOT / 'licenses').mkdir(exist_ok=True)
for path in licenses:
    (ROOT / 'licenses' / (path.split('/')[0] + '.txt')).write_bytes(fetch(BASE + 'src/third_party_lib/' + path))
# OpenCV and Emscripten are build-time dependencies of the distributed WASM.
(ROOT / 'licenses/OpenCV.txt').write_bytes(fetch('https://raw.githubusercontent.com/opencv/opencv/4.12.0/LICENSE'))
(ROOT / 'licenses/Emscripten.txt').write_bytes(fetch('https://raw.githubusercontent.com/emscripten-core/emscripten/5.0.0/LICENSE'))
print('Vendored CIMBAR', VERSION, '- SHA256 verified; no runtime downloads')
