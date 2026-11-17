/**
 * Détourage automatique d'un objet photographié sur un fond uni (feuille blanche, plateau, paillasse…).
 * Tout se fait sur l'appareil, hors ligne, sans modèle à télécharger.
 *
 * Detourage.fondUni(source, options) → Promise<{ donnees, trouve }>
 *   source : data URL, Blob ou <canvas>.
 *   donnees : data URL JPEG — l'objet sur fond blanc, recadré autour de lui avec une marge
 *             (ou la photo d'origine si l'objet n'a pas été trouvé).
 *   trouve : false si le fond n'a pas pu être séparé de l'objet (fond chargé, objet de la couleur du fond…).
 *
 * Principe : la couleur du fond est estimée sur le pourtour de la photo, puis on « remplit » le fond
 * depuis les bords tant que la couleur reste proche (les ombres, plus sombres mais de même teinte, sont
 * tolérées). Ce qui n'est pas atteint est l'objet ; les petites taches isolées sont ignorées.
 *
 * Options : tolerance (écart de couleur admis, 10 à 80, défaut 32), marge (part de la taille de l'objet
 * ajoutée autour, défaut 0.08), cote (plus grand côté en sortie, défaut 1600), qualite (JPEG, défaut 0.9).
 */
const Detourage = (() => {
  const TRAVAIL = 480; // côté du masque calculé : rapide sur smartphone, lissé ensuite à la taille réelle

  function charger(source) {
    if (source instanceof HTMLCanvasElement) return Promise.resolve(source);
    return new Promise((ok, ko) => {
      const img = new Image();
      const url = typeof source === 'string' ? source : URL.createObjectURL(source);
      img.onload = () => { if (typeof source !== 'string') URL.revokeObjectURL(url); ok(img); };
      img.onerror = () => { if (typeof source !== 'string') URL.revokeObjectURL(url); ko(new Error('image')); };
      img.src = url;
    });
  }
  const largeur = (s) => s.naturalWidth || s.width;
  const hauteur = (s) => s.naturalHeight || s.height;

  /** Couleur en Y/Cb/Cr : la luminosité (Y) pèse moins que la teinte, pour tolérer les ombres. */
  function ycc(d, i) {
    const r = d[i]; const g = d[i + 1]; const b = d[i + 2];
    return [0.299 * r + 0.587 * g + 0.114 * b, -0.169 * r - 0.331 * g + 0.5 * b, 0.5 * r - 0.419 * g - 0.081 * b];
  }
  const mediane = (t) => { const s = t.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

  async function fondUni(source, options = {}) {
    const { tolerance = 32, marge = 0.08, cote = 1600, qualite = 0.9 } = options;
    const image = await charger(source);
    const W0 = largeur(image); const H0 = hauteur(image);
    const echelle = Math.min(1, cote / Math.max(W0, H0));
    const W = Math.max(1, Math.round(W0 * echelle)); const H = Math.max(1, Math.round(H0 * echelle));
    const pleine = document.createElement('canvas');
    pleine.width = W; pleine.height = H;
    pleine.getContext('2d').drawImage(image, 0, 0, W, H);
    const original = () => pleine.toDataURL('image/jpeg', qualite);

    // 1. Petite copie pour calculer le masque.
    const k = Math.min(1, TRAVAIL / Math.max(W, H));
    const w = Math.max(8, Math.round(W * k)); const h = Math.max(8, Math.round(H * k));
    const petite = document.createElement('canvas');
    petite.width = w; petite.height = h;
    const pctx = petite.getContext('2d', { willReadFrequently: true });
    pctx.drawImage(pleine, 0, 0, w, h);
    const px = pctx.getImageData(0, 0, w, h).data;
    const n = w * h;
    const Y = new Float32Array(n); const Cb = new Float32Array(n); const Cr = new Float32Array(n);
    for (let p = 0; p < n; p += 1) { const [a, b, c] = ycc(px, p * 4); Y[p] = a; Cb[p] = b; Cr[p] = c; }

    // 2. Couleur du fond : médiane d'une bande de 3 % sur le pourtour.
    const bande = Math.max(2, Math.round(Math.min(w, h) * 0.03));
    const bords = [];
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (x < bande || y < bande || x >= w - bande || y >= h - bande) bords.push(y * w + x);
      }
    }
    const fond = [mediane(bords.map((p) => Y[p])), mediane(bords.map((p) => Cb[p])), mediane(bords.map((p) => Cr[p]))];
    const ecart = (p, ref) => {
      const dy = (Y[p] - ref[0]) * 0.45; const db = Cb[p] - ref[1]; const dr = Cr[p] - ref[2];
      return Math.sqrt(dy * dy + db * db + dr * dr);
    };
    // Fond trop disparate sur le pourtour : pas un fond uni, on renonce.
    const horsFond = bords.filter((p) => ecart(p, fond) > tolerance * 1.5).length;
    if (horsFond > bords.length * 0.35) return { donnees: original(), trouve: false };

    // 3. Remplissage du fond depuis les bords : proche de la couleur du fond,
    //    ou, un peu plus loin, mais en dégradé doux avec le voisin (ombre portée, éclairage inégal).
    const estFond = new Uint8Array(n);
    const file = new Int32Array(n);
    let debut = 0; let fin = 0;
    const tenter = (p, depuis) => {
      if (estFond[p]) return;
      const e = ecart(p, fond);
      if (e > tolerance * 1.8) return;
      if (e > tolerance) {
        if (depuis < 0) return;
        const dy = (Y[p] - Y[depuis]) * 0.45; const db = Cb[p] - Cb[depuis]; const dr = Cr[p] - Cr[depuis];
        if (Math.sqrt(dy * dy + db * db + dr * dr) > tolerance * 0.18) return;
      }
      estFond[p] = 1;
      file[fin] = p; fin += 1;
    };
    for (let x = 0; x < w; x += 1) { tenter(x, -1); tenter((h - 1) * w + x, -1); }
    for (let y = 0; y < h; y += 1) { tenter(y * w, -1); tenter(y * w + w - 1, -1); }
    while (debut < fin) {
      const p = file[debut]; debut += 1;
      const x = p % w; const y = (p - x) / w;
      if (x > 0) tenter(p - 1, p);
      if (x < w - 1) tenter(p + 1, p);
      if (y > 0) tenter(p - w, p);
      if (y < h - 1) tenter(p + w, p);
    }

    // 4. Morceaux de l'objet : on garde les gros, on ignore les poussières et reflets isolés.
    const etiquette = new Int32Array(n);
    const tailles = [0];
    for (let p0 = 0; p0 < n; p0 += 1) {
      if (estFond[p0] || etiquette[p0]) continue;
      const id = tailles.length;
      let t = 0; debut = 0; fin = 0;
      etiquette[p0] = id; file[fin] = p0; fin += 1;
      while (debut < fin) {
        const p = file[debut]; debut += 1; t += 1;
        const x = p % w; const y = (p - x) / w;
        const voisins = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
        voisins.forEach((v) => { if (v >= 0 && !estFond[v] && !etiquette[v]) { etiquette[v] = id; file[fin] = v; fin += 1; } });
      }
      tailles.push(t);
    }
    const plusGrand = tailles.reduce((x, y) => Math.max(x, y), 0);
    const garde = tailles.map((t, i) => i > 0 && t >= Math.max(n * 0.002, plusGrand * 0.04));
    let surface = 0;
    let x1 = w; let y1 = h; let x2 = -1; let y2 = -1;
    const masque = pctx.createImageData(w, h);
    for (let p = 0; p < n; p += 1) {
      if (!garde[etiquette[p]]) continue;
      surface += 1;
      const x = p % w; const y = (p - x) / w;
      if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; if (y > y2) y2 = y;
      masque.data[p * 4 + 3] = 255;
    }
    // Rien trouvé, ou presque toute la photo : le détourage n'a pas de sens.
    if (surface < n * 0.01 || surface > n * 0.92) return { donnees: original(), trouve: false };

    // 5. Bord adouci : léger flou du masque (3 × 3), puis agrandi en douceur à la taille réelle.
    const a = new Uint8ClampedArray(n);
    for (let p = 0; p < n; p += 1) a[p] = masque.data[p * 4 + 3];
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        let s = 0; let c = 0;
        for (let j = -1; j <= 1; j += 1) {
          for (let i = -1; i <= 1; i += 1) {
            const xx = x + i; const yy = y + j;
            if (xx >= 0 && yy >= 0 && xx < w && yy < h) { s += a[yy * w + xx]; c += 1; }
          }
        }
        masque.data[(y * w + x) * 4 + 3] = s / c;
      }
    }
    const toileMasque = document.createElement('canvas');
    toileMasque.width = w; toileMasque.height = h;
    toileMasque.getContext('2d').putImageData(masque, 0, 0);

    const objet = document.createElement('canvas');
    objet.width = W; objet.height = H;
    const octx = objet.getContext('2d');
    octx.drawImage(pleine, 0, 0);
    octx.globalCompositeOperation = 'destination-in';
    octx.imageSmoothingEnabled = true;
    octx.drawImage(toileMasque, 0, 0, W, H);

    // 6. Objet sur fond blanc, recadré autour de lui avec une marge.
    const bx = x1 / k; const by = y1 / k; const bw = (x2 - x1 + 1) / k; const bh = (y2 - y1 + 1) / k;
    const m = Math.max(bw, bh) * marge;
    const sx = Math.max(0, Math.floor(bx - m)); const sy = Math.max(0, Math.floor(by - m));
    const sw = Math.min(W, Math.ceil(bx + bw + m)) - sx; const sh = Math.min(H, Math.ceil(by + bh + m)) - sy;
    const sortie = document.createElement('canvas');
    sortie.width = sw; sortie.height = sh;
    const sctx = sortie.getContext('2d');
    sctx.fillStyle = '#fff';
    sctx.fillRect(0, 0, sw, sh);
    sctx.drawImage(objet, sx, sy, sw, sh, 0, 0, sw, sh);
    return { donnees: sortie.toDataURL('image/jpeg', qualite), trouve: true };
  }

  return { fondUni };
})();
