"""AWS-architecture-style figures: hand-placed SVG, service icons with labels underneath, groups, numbered orange flow steps,
a legend. Same look as ott-chat report/scripts/aws_arch_figs.py. Stdlib only; Chrome renders the PNG.

Usage in a repo (keep the generator and the icons it uses inside the repo, so it re-renders anywhere):
    from awsfig import Fig
    c = Fig(1600, 1000, icon_dir="docs/assets/icons")      # icons copied there by c.use("aws/ml/sagemaker-model", ...)
    c.title("law-rag", "subtitle")
    c.group(x0, y0, x1, y1, "label", stroke=..., dash="6,4", icon="onprem/container/docker")
    c.node(x, y, "programming/framework/fastapi", "QA service", ["POST /ask"])
    c.arrow([(x0, y0), (x1, y0)]); c.plate(x, y, "label"); c.step(x, y, 1)
    c.legend_steps(y, ["...", "..."]); c.legend_arrows(x, y, [("request", INK, ""), ...])
    c.save("docs/assets/architecture")       # writes .svg and .png (2x)

Icon names are paths under resources/ without .png (the `diagrams` package icon set: aws, gcp, azure, onprem, generic,
programming, saas, ...). The first use copies the PNG into icon_dir.
"""
import base64
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from xml.sax.saxutils import escape

RES = Path(os.environ.get("AWSFIG_RES", "~/.claude/skills/arch-diagram/aws/resources")).expanduser()   # only needed for icons not yet copied
CHROME = os.environ.get("CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
FONT = "Helvetica Neue, Helvetica, Arial, sans-serif"
INK, GREY, SUB = "#232f3e", "#78909c", "#455a64"
TEAL, BLUE, ORANGE, RED, PURPLE, GREEN = "#00a4a6", "#147eba", "#ed7100", "#d84315", "#6a1b9a", "#2e7d32"


def tw(s, size, bold=False):
    return len(s) * size * (0.56 if bold else 0.5)


class Fig:
    def __init__(self, w, h, icon_dir):
        self.W, self.H, self.icon_dir = w, h, Path(icon_dir)
        self.out, self.markers, self._uris = [], {}, {}

    # ---- icons
    def _uri(self, name):
        if name not in self._uris:
            local = self.icon_dir / (name.replace("/", "__") + ".png")
            if not local.exists():
                local.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy(RES / f"{name}.png", local)
            self._uris[name] = "data:image/png;base64," + base64.b64encode(local.read_bytes()).decode()
        return self._uris[name]

    def icon(self, x, y, name, size=56, opacity=1):
        self.out.append(f'<image href="{self._uri(name)}" x="{x - size / 2}" y="{y - size / 2}" width="{size}" '
                        f'height="{size}" opacity="{opacity}"/>')

    # ---- primitives
    def text(self, x, y, s, size=15, weight="normal", anchor="start", color=INK, italic=False, halo=False):
        st = ' font-style="italic"' if italic else ""
        h = ' stroke="#fff" stroke-width="4" paint-order="stroke" stroke-linejoin="round"' if halo else ""
        self.out.append(f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" text-anchor="{anchor}" '
                        f'fill="{color}"{st}{h}>{escape(s)}</text>')

    def rect(self, x0, y0, x1, y1, stroke=INK, dash="", fill="none", sw=1.8, rx=0):
        self.out.append(f'<rect x="{x0}" y="{y0}" width="{x1 - x0}" height="{y1 - y0}" rx="{rx}" fill="{fill}" '
                        f'stroke="{stroke}" stroke-width="{sw}" stroke-dasharray="{dash}"/>')

    def _marker(self, color):
        if color not in self.markers:
            self.markers[color] = f"m{len(self.markers)}"
        return self.markers[color]

    def arrow(self, pts, color=INK, sw=2.2, dash="", head=True, both=False):
        """Orthogonal polyline; head at the last point (and the first when both=True)."""
        d = "M" + " L".join(f"{x},{y}" for x, y in pts)
        mid = self._marker(color)
        ms = f' marker-end="url(#{mid})"' if head else ""
        if both:
            ms += f' marker-start="url(#{mid}s)"'
        self.out.append(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{sw}" stroke-dasharray="{dash}"{ms}/>')

    def plate(self, x, y, s, size=14.5, color="#37474f", italic=True):
        """Arrow label on a white plate, centred at x, baseline y."""
        w = tw(s, size) + 12
        self.out.append(f'<rect x="{x - w / 2}" y="{y - size + 1}" width="{w}" height="{size + 6}" fill="#fff"/>')
        self.text(x, y, s, size, "normal", "middle", color, italic)

    def step(self, x, y, n, r=14.5):
        self.out.append(f'<circle cx="{x}" cy="{y}" r="{r}" fill="{ORANGE}"/>')
        self.text(x, y + 5.5, str(n), 16, "bold", "middle", "#fff")

    # ---- AWS-style pieces
    def node(self, x, y, icon, title, subs=(), size=56, ts=17, ss=14.5, color=INK):
        """Icon centred at (x, y), bold title and grey sub-lines under it."""
        self.icon(x, y, icon, size)
        ty = y + size / 2 + 18
        self.text(x, ty, title, ts, "bold", "middle", color, halo=True)
        for i, s in enumerate(subs):
            self.text(x, ty + 17 * (i + 1), s, ss, "normal", "middle", SUB, halo=True)

    def group(self, x0, y0, x1, y1, label, stroke=INK, dash="", icon=None, fill="none", size=15, color=None):
        self.rect(x0, y0, x1, y1, stroke, dash, fill)
        lx = x0 + 10
        if icon:
            self.icon(x0 + 18, y0 + 18, icon, 30)
            lx = x0 + 40
        self.text(lx, y0 + 23, label, size, "bold", "start", color or stroke)

    def title(self, t, sub):
        self.text(40, 50, t, 34, "bold")
        self.text(40, 80, sub, 17, "normal", "start", SUB, italic=True)

    def legend_steps(self, x, y, items, cols=2, colw=640, lh=25):
        rows = (len(items) + cols - 1) // cols
        for i, s in enumerate(items):
            cx, cy = x + (i // rows) * colw, y + (i % rows) * lh
            self.step(cx + 10, cy - 5, i + 1, 10)
            self.text(cx + 30, cy, s, 15)

    def legend_arrows(self, x, y, items, lh=26):
        self.text(x, y, "Arrows", 16, "bold", "start", SUB)
        for i, (s, color, dash) in enumerate(items):
            yy = y + 26 + i * lh
            self.arrow([(x, yy - 5), (x + 60, yy - 5)], color=color, dash=dash)
            self.text(x + 72, yy, s, 15)

    # ---- output
    def svg(self):
        defs = []
        for color, mid in self.markers.items():
            for suffix, d in (("", "M0,0 L12,6 L0,12 z"), ("s", "M12,0 L0,6 L12,12 z")):
                ref = 11 if not suffix else 1
                defs.append(f'<marker id="{mid}{suffix}" markerWidth="12" markerHeight="12" refX="{ref}" refY="6" '
                            f'orient="auto" markerUnits="userSpaceOnUse"><path d="{d}" fill="{color}"/></marker>')
        return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.W}" height="{self.H}" viewBox="0 0 {self.W} {self.H}" '
                f'font-family="{FONT}"><defs>{"".join(defs)}</defs><rect width="{self.W}" height="{self.H}" fill="#fff"/>'
                + "".join(self.out) + "</svg>")

    def save(self, stem):
        stem = Path(stem)
        stem.parent.mkdir(parents=True, exist_ok=True)
        svg = self.svg()
        stem.with_suffix(".svg").write_text(svg, encoding="utf-8")
        png = stem.with_suffix(".png")
        with tempfile.TemporaryDirectory() as tmp:
            html = Path(tmp) / "p.html"
            html.write_text(f'<html><head><meta charset="utf-8"></head><body style="margin:0">{svg}</body></html>',
                            encoding="utf-8")
            for attempt in range(3):
                try:
                    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
                                    f"--user-data-dir={tmp}/p{attempt}", "--force-device-scale-factor=2",
                                    f"--window-size={self.W},{self.H}", f"--screenshot={png}", f"file://{html}"],
                                   stderr=subprocess.DEVNULL, timeout=90, check=True)
                    break
                except (subprocess.SubprocessError, OSError):
                    continue
        return png
