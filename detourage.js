/**
 * Détourage automatique d'un objet photographié sur un fond uni ou peu chargé (table, feuille, plateau).
 * Tout se fait sur l'appareil, hors ligne, sans modèle à télécharger.
 *
 * Detourage.fondUni(source, options) → Promise<{ donnees, trouve }>
 *   source : data URL, Blob ou <canvas>.
 *   donnees : data URL JPEG — l'objet sur fond blanc, recadré autour de lui avec une marge
 *             (ou la photo d'origine si l'objet n'a pas été trouvé).
 *   trouve : false si le fond n'a pas pu être séparé de l'objet.
 *
 * Principe : le fond est « rempli » depuis les bords de la photo, de proche en proche, tant qu'on ne
 * franchit pas un contour net. Un éclairage inégal ou une ombre douce changent la couleur lentement :
 * ils sont traversés. Le bord d'un objet est un saut de couleur : il arrête le remplissage, même si
 * l'objet a presque la couleur du fond (tige métallique sur une table claire). Et le remplissage ne
 * prend jamais une teinte franchement différente de celle du fond (manche rouge), même par un contour
 * mou. Ensuite, on garde le
 * gros morceau du centre ; les rayures, taches et ce qui touche le bord de la photo (ordinateur posé à
 * côté…) sont écartés.
 *
 * Options : pas (saut de couleur toléré d'un point au voisin, défaut 3.2), teinte (écart de teinte
 * maximal avec le fond, quelle que soit la lumière, défaut 18), marge (part de la taille de
 * l'objet ajoutée autour, défaut 0.06), cote (plus grand côté en sortie, défaut 1600), qualite (JPEG, 0.9).
 */
const Detourage = (() => {
  const TRAVAIL = 720; // côté du masque calculé : rapide sur smartphone, lissé ensuite à la taille réelle

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

  /** Flou de boîte séparable (rayon r), en place. */
  function flouter(t, w, h, r) {
    const tmp = new Float32Array(t.length);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        let s = 0; let c = 0;
        for (let i = -r; i <= r; i += 1) { const xx = x + i; if (xx >= 0 && xx < w) { s += t[y * w + xx]; c += 1; } }
        tmp[y * w + x] = s / c;
      }
    }
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        let s = 0; let c = 0;
        for (let j = -r; j <= r; j += 1) { const yy = y + j; if (yy >= 0 && yy < h) { s += tmp[yy * w + x]; c += 1; } }
        t[y * w + x] = s / c;
      }
    }
  }

  async function fondUni(source, options = {}) {
    const { pas = 3.2, teinte = 18, marge = 0.06, cote = 1600, qualite = 0.9 } = options;
    const image = await charger(source);
    const W0 = largeur(image); const H0 = hauteur(image);
    const echelle = Math.min(1, cote / Math.max(W0, H0));
    const W = Math.max(1, Math.round(W0 * echelle)); const H = Math.max(1, Math.round(H0 * echelle));
    const pleine = document.createElement('canvas');
    pleine.width = W; pleine.height = H;
    pleine.getContext('2d').drawImage(image, 0, 0, W, H);
    const original = () => pleine.toDataURL('image/jpeg', qualite);

    // 1. Petite copie pour calculer le masque, en Y/Cb/Cr (la luminosité pèse moins : ombres, éclairage).
    const k = Math.min(1, TRAVAIL / Math.max(W, H));
    const w = Math.max(8, Math.round(W * k)); const h = Math.max(8, Math.round(H * k));
    const petite = document.createElement('canvas');
    petite.width = w; petite.height = h;
    const pctx = petite.getContext('2d', { willReadFrequently: true });
    pctx.drawImage(pleine, 0, 0, w, h);
    const px = pctx.getImageData(0, 0, w, h).data;
    const n = w * h;
    const Y = new Float32Array(n); const Cb = new Float32Array(n); const Cr = new Float32Array(n);
    for (let p = 0; p < n; p += 1) {
      const r = px[p * 4]; const g = px[p * 4 + 1]; const b = px[p * 4 + 2];
      Y[p] = (0.299 * r + 0.587 * g + 0.114 * b) * 0.5;
      Cb[p] = -0.169 * r - 0.331 * g + 0.5 * b;
      Cr[p] = 0.5 * r - 0.419 * g - 0.081 * b;
    }
    // Léger flou : le grain du papier et le bruit de l'appareil ne doivent pas faire de faux contours.
    [Y, Cb, Cr].forEach((t) => flouter(t, w, h, 1));
    const saut = (p, q) => {
      const a = Y[p] - Y[q]; const b = Cb[p] - Cb[q]; const c = Cr[p] - Cr[q];
      return Math.sqrt(a * a + b * b + c * c);
    };

    // 2. Remplissage du fond depuis tout le pourtour, de voisin en voisin, sans franchir de contour net.
    //    Le seuil s'adapte au bruit de la photo (mesuré sur le pourtour).
    const sautsBord = [];
    for (let x = 1; x < w; x += 1) { sautsBord.push(saut(x, x - 1), saut((h - 1) * w + x, (h - 1) * w + x - 1)); }
    for (let y = 1; y < h; y += 1) { sautsBord.push(saut(y * w, (y - 1) * w), saut(y * w + w - 1, (y - 1) * w + w - 1)); }
    sautsBord.sort((a, b) => a - b);
    const seuil = Math.max(pas, Math.min(pas * 2.5, sautsBord[Math.floor(sautsBord.length * 0.75)] * 2));
    // Teinte du fond (sans la luminosité, qui varie avec l'éclairage) : médiane du pourtour.
    const med = (t) => { const v = []; for (let x = 0; x < w; x += 1) v.push(t[x], t[(h - 1) * w + x]); for (let y = 0; y < h; y += 1) v.push(t[y * w], t[y * w + w - 1]); v.sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
    const fondCb = med(Cb); const fondCr = med(Cr);
    const teinteProche = (q) => Math.hypot(Cb[q] - fondCb, Cr[q] - fondCr) <= teinte;
    const estFond = new Uint8Array(n);
    const file = new Int32Array(n);
    let debut = 0; let fin = 0;
    // Contours : point dont un voisin est trop différent. Épaissis d'un point pour boucher les petites
    // brèches (le remplissage passerait sinon par un trou d'un pixel dans le contour d'une pièce noire).
    const contour = new Uint8Array(n);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const p = y * w + x;
        if ((x < w - 1 && saut(p, p + 1) > seuil) || (y < h - 1 && saut(p, p + w) > seuil)) {
          contour[p] = 1;
          if (x < w - 1) contour[p + 1] = 1;
          if (y < h - 1) contour[p + w] = 1;
        }
      }
    }
    const barriere = new Uint8Array(n);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const p = y * w + x;
        if (contour[p] || (x > 0 && contour[p - 1]) || (x < w - 1 && contour[p + 1]) || (y > 0 && contour[p - w]) || (y < h - 1 && contour[p + w])) barriere[p] = 1;
      }
    }
    // Départ : le pourtour, sauf ce qui n'a pas la teinte du fond (objet voisin coupé par le cadre).
    const semer = (p) => { if (!estFond[p] && !barriere[p] && teinteProche(p)) { estFond[p] = 1; file[fin] = p; fin += 1; } };
    for (let x = 0; x < w; x += 1) { semer(x); semer((h - 1) * w + x); }
    for (let y = 0; y < h; y += 1) { semer(y * w); semer(y * w + w - 1); }
    const tenter = (q, p) => { if (!estFond[q] && !barriere[q] && saut(p, q) <= seuil && teinteProche(q)) { estFond[q] = 1; file[fin] = q; fin += 1; } };
    while (debut < fin) {
      const p = file[debut]; debut += 1;
      const x = p % w; const y = (p - x) / w;
      if (x > 0) tenter(p - 1, p);
      if (x < w - 1) tenter(p + 1, p);
      if (y > 0) tenter(p - w, p);
      if (y < h - 1) tenter(p + w, p);
    }

    // 3. Morceaux restants. Ce qui touche le bord de la photo (objet voisin, coin de table) est écarté ;
    //    parmi le reste, on garde le plus gros et ceux de taille comparable ; rayures et taches s'en vont.
    const etiquette = new Int32Array(n);
    const morceaux = [null];
    for (let p0 = 0; p0 < n; p0 += 1) {
      if (estFond[p0] || etiquette[p0]) continue;
      const id = morceaux.length;
      const m = { taille: 0, bord: 0, x1: w, y1: h, x2: -1, y2: -1 };
      debut = 0; fin = 0;
      etiquette[p0] = id; file[fin] = p0; fin += 1;
      while (debut < fin) {
        const p = file[debut]; debut += 1;
        const x = p % w; const y = (p - x) / w;
        m.taille += 1;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) m.bord += 1;
        if (x < m.x1) m.x1 = x; if (x > m.x2) m.x2 = x; if (y < m.y1) m.y1 = y; if (y > m.y2) m.y2 = y;
        const voisins = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
        voisins.forEach((v) => { if (v >= 0 && !estFond[v] && !etiquette[v]) { etiquette[v] = id; file[fin] = v; fin += 1; } });
      }
      morceaux.push(m);
    }
    // Un objet peut frôler le cadre (pointe d'un tournevis) ; ce qui le longe largement est autre chose.
    const longeBord = Math.max(6, (w + h) * 2 * 0.03);
    const interieurs = morceaux.filter((m) => m && m.bord <= longeBord);
    const candidats = interieurs.length ? interieurs : morceaux.filter(Boolean);
    const plusGrand = candidats.reduce((a, m) => Math.max(a, m.taille), 0);
    // Le plus gros morceau est l'objet ; un autre n'est gardé que s'il est assez gros et ne touche pas
    // le cadre (deuxième pièce posée à côté, pas un bord de table ni une rayure).
    const principal = candidats.find((m) => m.taille === plusGrand);
    const garde = morceaux.map((m) => Boolean(m) && (m === principal
      || (candidats.includes(m) && m.bord === 0 && m.taille >= Math.max(n * 0.002, plusGrand * 0.2))));
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
    if (surface < n * 0.005 || surface > n * 0.9) return { donnees: original(), trouve: false };

    // 4. Les contours épaissis ont un peu grossi l'objet : on le ramène (2 points), puis bord adouci
    //    (léger flou du masque) et agrandi en douceur à la taille réelle.
    let a = new Float32Array(n);
    for (let p = 0; p < n; p += 1) a[p] = masque.data[p * 4 + 3];
    for (let passe = 0; passe < 2; passe += 1) {
      const b = new Float32Array(n);
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          const p = y * w + x;
          b[p] = a[p] && (x === 0 || a[p - 1]) && (x === w - 1 || a[p + 1]) && (y === 0 || a[p - w]) && (y === h - 1 || a[p + w]) ? 255 : 0;
        }
      }
      a = b;
    }
    flouter(a, w, h, 1);
    for (let p = 0; p < n; p += 1) masque.data[p * 4 + 3] = a[p];
    const toileMasque = document.createElement('canvas');
    toileMasque.width = w; toileMasque.height = h;
    toileMasque.getContext('2d').putImageData(masque, 0, 0);

    const objet = document.createElement('canvas');
    objet.width = W; objet.height = H;
    const octx = objet.getContext('2d');
    octx.drawImage(pleine, 0, 0);
    octx.globalCompositeOperation = 'destination-in';
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(toileMasque, 0, 0, W, H);

    // 5. Objet sur fond blanc, recadré autour de lui avec une marge.
    const bx = x1 / k; const by = y1 / k; const bw = (x2 - x1 + 1) / k; const bh = (y2 - y1 + 1) / k;
    const mg = Math.max(bw, bh) * marge;
    const sx = Math.max(0, Math.floor(bx - mg)); const sy = Math.max(0, Math.floor(by - mg));
    const sw = Math.min(W, Math.ceil(bx + bw + mg)) - sx; const sh = Math.min(H, Math.ceil(by + bh + mg)) - sy;
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
