// Lecture de QR code sur les navigateurs sans BarcodeDetector (Safari / Chrome iOS, Firefox…).
// Définit window.BarcodeDetector avec la même interface que celle de Chrome Android
// (detect(source) → [{ rawValue, format, boundingBox, cornerPoints }]), via jsQR (lib/jsQR.js,
// Apache-2.0, embarqué pour fonctionner hors ligne). Seuls les QR codes sont lus : les autres
// formats (code 128, EAN…) sont ignorés sur ces navigateurs.
(function () {
  if ('BarcodeDetector' in window) return;

  let chargement = null;
  function chargerJsQR() {
    if (typeof window.jsQR === 'function') return Promise.resolve();
    if (!chargement) {
      chargement = new Promise((ok, ko) => {
        const s = document.createElement('script');
        s.src = 'lib/jsQR.js?v=1';
        s.onload = () => (typeof window.jsQR === 'function' ? ok() : ko(new Error('jsQR indisponible')));
        s.onerror = () => { chargement = null; ko(new Error('jsQR non chargé')); };
        document.head.appendChild(s);
      });
    }
    return chargement;
  }

  const LARGEUR_MAX = 640; // on réduit l'image : lecture bien plus rapide, suffisante pour un QR tenu devant la caméra
  let toile = null, ctx = null;

  function image(source) {
    const l = source.videoWidth || source.naturalWidth || source.width;
    const h = source.videoHeight || source.naturalHeight || source.height;
    if (!l || !h) return null;
    const k = Math.min(1, LARGEUR_MAX / l);
    const w = Math.max(1, Math.round(l * k)), hh = Math.max(1, Math.round(h * k));
    if (!toile) { toile = document.createElement('canvas'); ctx = toile.getContext('2d', { willReadFrequently: true }); }
    if (toile.width !== w) toile.width = w;
    if (toile.height !== hh) toile.height = hh;
    ctx.drawImage(source, 0, 0, w, hh);
    return { data: ctx.getImageData(0, 0, w, hh), k };
  }

  class BarcodeDetector {
    constructor(options) { this.formats = (options && options.formats) || ['qr_code']; }
    static async getSupportedFormats() { return ['qr_code']; }
    async detect(source) {
      if (!this.formats.includes('qr_code')) return [];
      await chargerJsQR();
      const img = image(source);
      if (!img) return [];
      const r = window.jsQR(img.data.data, img.data.width, img.data.height, { inversionAttempts: 'dontInvert' });
      if (!r || !r.data) return [];
      const c = r.location, k = img.k;
      const pts = [c.topLeftCorner, c.topRightCorner, c.bottomRightCorner, c.bottomLeftCorner].map((p) => ({ x: p.x / k, y: p.y / k }));
      const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
      const x = Math.min.apply(null, xs), y = Math.min.apply(null, ys);
      return [{
        rawValue: r.data,
        format: 'qr_code',
        boundingBox: { x, y, width: Math.max.apply(null, xs) - x, height: Math.max.apply(null, ys) - y },
        cornerPoints: pts,
      }];
    }
  }
  window.BarcodeDetector = BarcodeDetector;
})();
