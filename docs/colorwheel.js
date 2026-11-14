// Farbrad (HSV): Winkel = Farbton, Abstand zur Mitte = Sättigung, Regler = Helligkeit.
// Dazu Farb-Umrechnungen und das Ableiten eines kompletten Designs aus einer Akzentfarbe.

export function hsvToRgb(h, s, v) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)].map((x) => Math.round(x * 255));
}

export function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return [h, max ? d / max : 0, max];
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  const [h] = rgbToHsv(r * 255, g * 255, b * 255);
  return [h, s * 100, l * 100];
}

function hslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)].map((x) => Math.round(x * 255));
}

export const rgbToHex = (rgb) => '#' + rgb.map((x) => x.toString(16).padStart(2, '0')).join('');
export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance([r, g, b]) {
  const c = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
}

/** Leitet aus einer Akzentfarbe alle CSS-Variablen eines dunklen Designs ab. */
export function deriveTheme(hex) {
  const rgb = hexToRgb(hex) || [30, 215, 96];
  const [h, s, l] = rgbToHsl(...rgb);
  const tint = Math.min(s, 30);
  const c = (L, S = tint) => rgbToHex(hslToRgb(h, S, L));
  const bgRgb = hslToRgb(h, tint, 5);
  return {
    '--bg': rgbToHex(bgRgb),
    '--bg-rgb': bgRgb.join(', '),
    '--bg2': c(7.5),
    '--panel': c(9),
    '--panel2': c(12),
    '--line': c(17),
    '--hover': c(16),
    '--track': c(27, Math.min(s, 18)),
    '--muted': c(64, Math.min(s, 14)),
    '--glow': c(15, Math.min(s, 50)),
    '--accent': rgbToHex(rgb),
    '--accent-d': rgbToHex(hslToRgb(h, s, Math.max(0, l - 9))),
    '--accent-rgb': rgb.join(', '),
    '--on-accent': luminance(rgb) > 0.3 ? c(6, Math.min(s, 60)) : '#ffffff',
  };
}

/** Farbrad-Komponente auf einem <canvas> mit Markierung. */
export class ColorWheel {
  /**
   * @param {HTMLElement} root  Container (bekommt canvas + Marker)
   * @param {(hex: string) => void} onChange
   */
  constructor(root, onChange) {
    this.onChange = onChange;
    this.h = 140; this.s = 0.85; this.v = 0.85;
    this.canvas = document.createElement('canvas');
    this.marker = document.createElement('div');
    this.marker.className = 'wheel-marker';
    root.append(this.canvas, this.marker);
    this.root = root;

    const pick = (e) => {
      const r = this.canvas.getBoundingClientRect();
      const x = e.clientX - r.left - r.width / 2;
      const y = e.clientY - r.top - r.height / 2;
      const radius = r.width / 2;
      this.h = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
      this.s = Math.min(1, Math.hypot(x, y) / radius);
      this.update(true);
    };
    this.canvas.addEventListener('pointerdown', (e) => {
      this.canvas.setPointerCapture(e.pointerId);
      pick(e);
      const move = (ev) => pick(ev);
      const up = () => { this.canvas.removeEventListener('pointermove', move); this.canvas.removeEventListener('pointerup', up); };
      this.canvas.addEventListener('pointermove', move);
      this.canvas.addEventListener('pointerup', up);
    });
  }

  get hex() { return rgbToHex(hsvToRgb(this.h, this.s, this.v)); }

  setHex(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb) return;
    [this.h, this.s, this.v] = rgbToHsv(...rgb);
    this.draw();
    this.update(false);
  }

  setBrightness(v) {
    this.v = Math.max(0, Math.min(1, v));
    this.draw();
    this.update(true);
  }

  draw() {
    const size = this.root.clientWidth || 200;
    const dpr = window.devicePixelRatio || 1;
    const px = Math.round(size * dpr);
    if (this.canvas.width !== px) { this.canvas.width = px; this.canvas.height = px; }
    const ctx = this.canvas.getContext('2d');
    const img = ctx.createImageData(px, px);
    const R = px / 2;
    for (let y = 0; y < px; y++) {
      for (let x = 0; x < px; x++) {
        const dx = x - R + 0.5, dy = y - R + 0.5;
        const d = Math.hypot(dx, dy);
        const i = (y * px + x) * 4;
        if (d > R) continue;
        const [r, g, b] = hsvToRgb((Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360, d / R, this.v);
        img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b;
        img.data[i + 3] = d > R - 1 ? Math.round((R - d) * 255) : 255; // weicher Rand
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  update(notify) {
    const size = this.root.clientWidth || 200;
    const a = this.h * Math.PI / 180;
    const r = this.s * size / 2;
    this.marker.style.left = `${size / 2 + Math.cos(a) * r}px`;
    this.marker.style.top = `${size / 2 + Math.sin(a) * r}px`;
    this.marker.style.background = this.hex;
    if (notify) this.onChange(this.hex);
  }
}
