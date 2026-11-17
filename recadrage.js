/**
 * Recadrage commun à toutes les photos de l'application (matériel, inventaires, défauts, tickets,
 * informations, profil…).
 *
 * Recadrage.recadrer(source, options) : ouvre l'outil plein écran (rotation par quart de tour,
 * cadre déplaçable et redimensionnable aux coins). `source` : fichier (File/Blob) ou data URL.
 * Résout { donnees, transformer } ou null si annulé ; `transformer(x, y)` reporte un point
 * (0..1 sur l'ancienne photo) sur la nouvelle, ou null s'il en sort.
 *
 * Options : cote (plus grand côté en sortie, px), max (taille maximale de la data URL, caractères),
 * qualites (qualités JPEG essayées dans l'ordre), carre (cadre carré : photo de profil),
 * titre (titre de la fenêtre), detourer (true / false : détourage automatique à l'ouverture ; sans cette
 * option, on reprend le dernier choix fait avec le bouton « Détourer », mémorisé sur l'appareil).
 *
 * Bouton « Détourer » (si detourage.js est chargé) : l'objet posé sur un fond uni est mis sur fond blanc
 * et le cadre se place autour de lui ; un second appui revient à la photo d'origine.
 *
 * Recadrage.photo(source, options) : raccourci qui résout directement la data URL (ou null si annulé).
 */
const Recadrage = (() => {
  let compteur = 0;
  const CLE_DETOURAGE = 'avismur_detourage';
  const detourageDispo = () => typeof Detourage !== 'undefined';
  /** Dernier choix du bouton « Détourer » (mémorisé sur l'appareil, partagé par toutes les photos). */
  function detourageVoulu() { try { return localStorage.getItem(CLE_DETOURAGE) === '1'; } catch (e) { return false; } }
  function memoriserDetourage(oui) { try { localStorage.setItem(CLE_DETOURAGE, oui ? '1' : '0'); } catch (e) { /* stockage indisponible */ } }
  function el(balise, attributs = {}, ...enfants) {
    const n = document.createElement(balise);
    Object.entries(attributs).forEach(([cle, v]) => {
      if (v === undefined || v === null || v === false) return;
      if (cle === 'classe') n.className = v;
      else if (cle === 'texte') n.textContent = v;
      else if (cle === 'surclick') n.addEventListener('click', v);
      else n.setAttribute(cle, v === true ? '' : v);
    });
    enfants.flat().filter(Boolean).forEach((e) => n.append(e));
    return n;
  }

  function recadrer(source, options = {}) {
    const { cote = 1280, max = Infinity, qualites = [0.72, 0.6, 0.5], carre = false, titre = 'Recadrer la photo', detourer } = options;
    const charger = (src) => new Promise((ok, ko) => {
      const im = new Image();
      const url = typeof src === 'string' ? src : URL.createObjectURL(src);
      const liberer = () => { if (typeof src !== 'string') URL.revokeObjectURL(url); };
      im.onerror = () => { liberer(); ko(new Error('image')); };
      im.onload = () => { liberer(); if (!im.width || !im.height) ko(new Error('image')); else ok(im); };
      im.src = url;
    });
    return new Promise((ok, ko) => {
      charger(source).then((img0) => {
        let img = img0;
        const imgOriginale = img0;
        let lw = 0;
        let lh = 0;
        // Travail sur une copie limitée à 2400 px : fluide sur smartphone, largement assez pour la sortie.
        const mesurer = () => {
          const echelle = Math.min(1, 2400 / Math.max(img.width, img.height));
          lw = Math.round(img.width * echelle);
          lh = Math.round(img.height * echelle);
        };
        mesurer();
        let quarts = 0;
        const toile = el('canvas', { classe: 'inv-recadrage-toile' });
        // Cadre de départ : toute la photo, ou le plus grand carré centré.
        const initial = () => {
          if (!carre) return { x: 0, y: 0, w: 1, h: 1 };
          const W = toile.width; const H = toile.height; const c = Math.min(W, H);
          return { x: (W - c) / 2 / W, y: (H - c) / 2 / H, w: c / W, h: c / H };
        };
        const dessiner = () => {
          const tourne = quarts % 2 === 1;
          toile.width = tourne ? lh : lw;
          toile.height = tourne ? lw : lh;
          const ctx = toile.getContext('2d');
          ctx.fillStyle = '#fff'; // PNG transparent : fond blanc plutôt que noir
          ctx.fillRect(0, 0, toile.width, toile.height);
          ctx.save();
          ctx.translate(toile.width / 2, toile.height / 2);
          ctx.rotate((quarts * Math.PI) / 2);
          ctx.drawImage(img, -lw / 2, -lh / 2, lw, lh);
          ctx.restore();
        };
        dessiner();
        let r = initial();
        const poignees = ['nw', 'ne', 'sw', 'se'].map((coin) => el('span', { classe: `inv-recadrage-poignee ${coin}`, 'data-coin': coin }));
        const cadre = el('div', { classe: 'inv-recadrage-cadre' }, ...poignees);
        const scene = el('div', { classe: 'inv-recadrage-scene' }, toile, cadre);
        const placer = () => Object.assign(cadre.style, { left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` });
        const MIN = 0.06;
        const borne = (v, a, b) => Math.min(b, Math.max(a, v));
        cadre.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          const coin = e.target.dataset.coin || '';
          const boite = scene.getBoundingClientRect();
          const depart = { ...r, px: e.clientX, py: e.clientY };
          cadre.setPointerCapture(e.pointerId);
          const bouger = (m) => {
            const dx = (m.clientX - depart.px) / boite.width;
            const dy = (m.clientY - depart.py) / boite.height;
            if (!coin) {
              r.x = borne(depart.x + dx, 0, 1 - depart.w);
              r.y = borne(depart.y + dy, 0, 1 - depart.h);
            } else if (carre) {
              // Carré : le coin opposé reste fixe, le côté suit le plus grand déplacement (en pixels).
              const W = boite.width; const H = boite.height;
              const ouest = coin.includes('w'); const nord = coin.includes('n');
              const fixeX = ouest ? depart.x + depart.w : depart.x;
              const fixeY = nord ? depart.y + depart.h : depart.y;
              const cotePx = depart.w * W;
              const delta = Math.max((ouest ? -dx : dx) * W, (nord ? -dy : dy) * H);
              const dispo = Math.min(ouest ? fixeX * W : (1 - fixeX) * W, nord ? fixeY * H : (1 - fixeY) * H);
              const c = borne(cotePx + delta, MIN * Math.min(W, H), dispo);
              const w = c / W; const h = c / H;
              r = { x: ouest ? fixeX - w : fixeX, y: nord ? fixeY - h : fixeY, w, h };
            } else {
              let { x, y } = depart;
              let x2 = depart.x + depart.w;
              let y2 = depart.y + depart.h;
              if (coin.includes('w')) x = borne(x + dx, 0, x2 - MIN); else x2 = borne(x2 + dx, x + MIN, 1);
              if (coin.includes('n')) y = borne(y + dy, 0, y2 - MIN); else y2 = borne(y2 + dy, y + MIN, 1);
              r = { x, y, w: x2 - x, h: y2 - y };
            }
            placer();
          };
          const lacher = () => { cadre.removeEventListener('pointermove', bouger); cadre.removeEventListener('pointerup', lacher); cadre.removeEventListener('pointercancel', lacher); };
          cadre.addEventListener('pointermove', bouger);
          cadre.addEventListener('pointerup', lacher);
          cadre.addEventListener('pointercancel', lacher);
        });
        const fermer = () => { if (fond.open) fond.close(); fond.remove(); document.removeEventListener('keydown', clavier); };
        const clavier = (e) => { if (e.key === 'Escape') { fermer(); ok(null); } };
        const valider = () => {
          const sx = Math.round(r.x * toile.width);
          const sy = Math.round(r.y * toile.height);
          const sw = Math.max(1, Math.round(r.w * toile.width));
          const sh = Math.max(1, Math.round(r.h * toile.height));
          const ratio = Math.min(1, cote / Math.max(sw, sh));
          const sortie = document.createElement('canvas');
          sortie.width = Math.max(1, Math.round(sw * ratio));
          sortie.height = carre ? sortie.width : Math.max(1, Math.round(sh * ratio));
          const ctx = sortie.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, sortie.width, sortie.height);
          ctx.drawImage(toile, sx, sy, sw, sh, 0, 0, sortie.width, sortie.height);
          let donnees = '';
          for (const qualite of qualites) {
            donnees = sortie.toDataURL('image/jpeg', qualite);
            if (donnees.length <= max) break;
          }
          fermer();
          if (donnees.length > max) { ko(new Error('photo trop lourde')); return; }
          const q = quarts;
          const cr = { ...r };
          const transformer = (x, y) => {
            // Rotation horaire par quarts de tour, puis recadrage.
            let u = x; let v = y;
            for (let i = 0; i < q; i += 1) { const t = u; u = 1 - v; v = t; }
            const nx = (u - cr.x) / cr.w;
            const ny = (v - cr.y) / cr.h;
            return nx < 0 || nx > 1 || ny < 0 || ny > 1 ? null : { x: nx, y: ny };
          };
          ok({ donnees, transformer });
        };
        // Détourage : sur la photo d'origine (même taille, fond blanc), le cadre se pose autour de l'objet.
        const aide = el('p', { classe: 'aide-question', texte: 'Faites glisser le cadre ou ses coins.' });
        let detouree = null; // { img, boite } une fois calculée
        let enCours = false;
        const boutonDetourer = detourageDispo() ? el('button', { type: 'button', classe: 'cfg-mini inv-recadrage-variante', 'aria-pressed': 'false', title: 'Détourer : l\'objet posé sur un fond uni passe sur fond blanc', texte: '✨ Détourer' }) : null;
        const tourner = (b) => { let x = { ...b }; for (let i = 0; i < quarts; i += 1) x = { x: 1 - x.y - x.h, y: x.x, w: x.h, h: x.w }; return x; };
        const montrerDetourage = (oui) => {
          img = oui ? detouree.img : imgOriginale;
          mesurer();
          dessiner();
          r = oui && !carre ? tourner(detouree.boite) : initial();
          placer();
          boutonDetourer.classList.toggle('choisie', oui);
          boutonDetourer.setAttribute('aria-pressed', String(oui));
        };
        const detourer2 = async (oui) => {
          if (!boutonDetourer || enCours) return;
          if (!oui) { montrerDetourage(false); aide.textContent = 'Photo d\'origine. Faites glisser le cadre ou ses coins.'; return; }
          if (!detouree) {
            enCours = true;
            boutonDetourer.disabled = true;
            aide.textContent = 'Détourage…';
            try {
              const base = document.createElement('canvas');
              base.width = lw; base.height = lh;
              base.getContext('2d').drawImage(imgOriginale, 0, 0, lw, lh);
              const res = await Detourage.fondUni(base, { recadrer: false, cote: 2400 });
              if (res.trouve) detouree = { img: await charger(res.donnees), boite: res.boite };
            } catch (e) { detouree = null; }
            enCours = false;
            boutonDetourer.disabled = false;
          }
          if (!detouree) { aide.textContent = 'Objet non détouré (fond trop chargé, ou objet de la couleur du fond) : photo d\'origine gardée.'; return; }
          montrerDetourage(true);
          aide.textContent = 'Détourée. Ajustez le cadre si besoin ; « ✨ Détourer » de nouveau pour la photo d\'origine.';
        };
        if (boutonDetourer) {
          boutonDetourer.addEventListener('click', () => {
            const oui = boutonDetourer.getAttribute('aria-pressed') !== 'true';
            memoriserDetourage(oui);
            detourer2(oui);
          });
        }
        compteur += 1;
        const idTitre = `recadrage-titre-${compteur}`;
        // <dialog> ouvert en modal : passe au-dessus de toute fenêtre déjà ouverte (fiche matériel, information…),
        // alors qu'un simple <div> resterait caché derrière et la photo ne serait jamais validée.
        const fond = el('dialog', { classe: 'inv-recadrage', 'aria-labelledby': idTitre },
          el('div', { classe: 'inv-recadrage-tete' },
            el('h2', { id: idTitre, texte: titre }),
            boutonDetourer,
            el('button', { type: 'button', classe: 'cfg-mini', 'aria-label': 'Tourner d\'un quart de tour', title: 'Tourner', texte: '↻', surclick: () => { quarts = (quarts + 1) % 4; dessiner(); r = initial(); placer(); } }),
            el('button', { type: 'button', classe: 'cfg-mini', title: carre ? 'Plus grand carré' : 'Toute la photo', texte: 'Tout', surclick: () => { r = initial(); placer(); } })),
          el('div', { classe: 'inv-recadrage-zone' }, scene),
          aide,
          el('div', { classe: 'inv-recadrage-actions' },
            el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Annuler', surclick: () => { fermer(); ok(null); } }),
            el('button', { type: 'button', classe: 'cfg-bouton inv-actif', texte: 'Valider', surclick: valider })));
        placer();
        document.addEventListener('keydown', clavier);
        fond.addEventListener('cancel', (e) => { e.preventDefault(); fermer(); ok(null); }); // touche Échap / retour Android
        document.body.append(fond);
        if (fond.showModal) fond.showModal();
        if (boutonDetourer && (detourer === undefined ? detourageVoulu() : detourer)) detourer2(true);
      }).catch(ko);
    });
  }

  const photo = (source, options) => recadrer(source, options).then((res) => (res ? res.donnees : null));

  return { recadrer, photo, detourageVoulu, memoriserDetourage };
})();
