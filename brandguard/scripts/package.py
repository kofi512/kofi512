"""Builds dist/BrandGuard.ccx — a plain zip with manifest.json at the root (what UDT's Package does)."""
import json, os, zipfile
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ver = json.load(open(os.path.join(root, 'manifest.json')))['version']
include = ['manifest.json', 'index.html', 'index.js', 'styles.css', 'src', 'icons']
out = os.path.join(root, 'dist', 'BrandGuard.ccx')
os.makedirs(os.path.dirname(out), exist_ok=True)
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for item in include:
        p = os.path.join(root, item)
        if os.path.isdir(p):
            for d, _, fs in os.walk(p):
                for f in sorted(fs):
                    full = os.path.join(d, f)
                    z.write(full, os.path.relpath(full, root))
        else:
            z.write(p, item)
print('wrote', out, ver)
