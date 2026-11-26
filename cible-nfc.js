/**
 * Cible NFC : repère à l'écran l'endroit où se trouve l'antenne NFC (au dos du téléphone).
 *
 * L'agent place une fois la cible (réglage gardé sur l'appareil, par orientation) ; elle s'affiche ensuite,
 * en surimpression, pendant chaque lecture ou écriture de puce NFC.
 *
 *   const cacher = CibleNfc.montrer();   // pendant le scan ; cacher() à la fin
 *   CibleNfc.lien()                      // bouton « Placer / Déplacer la cible NFC », à mettre sur l'écran de scan
 *   CibleNfc.enReglage()                 // vrai pendant le réglage : les lecteurs ignorent alors les puces lues
 */
const CibleNfc = (() => {
  const CLE = 'avismur_cible_nfc';
  const dispo = () => 'NDEFReader' in window;
  const orientation = () => (window.innerWidth > window.innerHeight ? 'paysage' : 'portrait');

  function lireTout() {
    try { return JSON.parse(localStorage.getItem(CLE)) || {}; } catch (e) { return {}; }
  }
  function position() {
    const p = lireTout()[orientation()];
    return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null;
  }
  function enregistrer(p) {
    const tout = lireTout();
    if (p) tout[orientation()] = { x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 };
    else delete tout[orientation()];
    try { localStorage.setItem(CLE, JSON.stringify(tout)); } catch (e) { /* stockage plein */ }
  }

  function el(balise, attributs = {}, ...enfants) {
    const n = document.createElement(balise);
    Object.entries(attributs).forEach(([k, v]) => {
      if (v === undefined || v === null || v === false) return;
      if (k === 'texte') n.textContent = v;
      else if (k === 'classe') n.setAttribute('class', v);
      else if (k.startsWith('sur')) n.addEventListener(k.slice(3), v);
      else n.setAttribute(k, v === true ? '' : v);
    });
    n.append(...enfants.filter(Boolean));
    return n;
  }
  const anneau = (classe) => el('div', { classe: `cible-nfc ${classe}`, 'aria-hidden': 'true' },
    el('span', { classe: 'cible-nfc-centre' }), el('span', { classe: 'cible-nfc-texte', texte: 'NFC' }));
  const placerAnneau = (n, p) => { n.style.left = `${p.x * 100}%`; n.style.top = `${p.y * 100}%`; };

  // ---------- Affichage pendant un scan ----------
  // Élément « popover » : il passe au premier plan, y compris au-dessus des fenêtres modales (<dialog>).
  let affichages = 0;
  let reglage = false;
  let cible = null;
  const liens = new Set();

  function rafraichir({ remonter = false } = {}) {
    const p = position();
    const voulue = affichages > 0 && p && !reglage;
    if (!voulue) { if (cible) { cible.remove(); cible = null; } }
    else {
      if (!cible) {
        cible = el('div', { classe: 'cible-nfc-calque', 'aria-hidden': 'true' }, anneau(''));
        if ('popover' in cible) cible.setAttribute('popover', 'manual');
        document.body.append(cible);
        remonter = true;
      }
      placerAnneau(cible.firstChild, p);
      if (remonter && cible.showPopover) {
        try { if (cible.matches(':popover-open')) cible.hidePopover(); cible.showPopover(); } catch (e) { /* popover indisponible */ }
      }
    }
    liens.forEach((b) => { if (!b.isConnected) liens.delete(b); else majLien(b); });
  }
  window.addEventListener('resize', () => rafraichir());

  /** Affiche la cible (si elle a été placée) ; retourne la fonction qui la cache. */
  function montrer() {
    if (!dispo()) return () => {};
    affichages += 1;
    rafraichir({ remonter: true });
    let fait = false;
    return () => {
      if (fait) return;
      fait = true;
      affichages = Math.max(0, affichages - 1);
      rafraichir();
    };
  }

  function majLien(b) {
    const placee = Boolean(position());
    b.querySelector('.cible-nfc-lien-texte').textContent = placee ? 'Déplacer la cible NFC' : 'Afficher une cible sur la zone NFC';
    b.title = placee ? 'Changer l\'emplacement de la cible qui indique l\'antenne NFC' : 'Placer une cible à l\'écran, à l\'endroit de l\'antenne NFC du téléphone';
  }
  /** Bouton qui propose de placer (ou de déplacer) la cible. Rien si le NFC n'est pas disponible. */
  function lien({ classe = '' } = {}) {
    if (!dispo()) return null;
    const b = el('button', { type: 'button', classe: `cible-nfc-lien ${classe}`.trim(), surclick: (e) => { e.stopPropagation(); placer(); } },
      el('span', { classe: 'cible-nfc-lien-picto', 'aria-hidden': 'true' }), el('span', { classe: 'cible-nfc-lien-texte' }));
    majLien(b);
    liens.add(b);
    return b;
  }

  // ---------- Réglage ----------
  /** Écran plein : l'agent touche (ou fait glisser) l'endroit de l'écran au-dessus de l'antenne. */
  function placer() {
    if (reglage) return Promise.resolve(position());
    reglage = true;
    rafraichir();
    let p = position();
    const repere = anneau('reglage');
    repere.hidden = !p;
    if (p) placerAnneau(repere, p);
    const etat = el('p', { classe: 'cible-nfc-etat', role: 'status', 'aria-live': 'polite' });
    const valider = el('button', { type: 'button', classe: 'camera-bouton', texte: 'Valider', disabled: !p });
    const retirer = position() ? el('button', { type: 'button', classe: 'camera-bouton secondaire', texte: 'Retirer' }) : null;
    const annuler = el('button', { type: 'button', classe: 'camera-bouton secondaire', texte: 'Annuler' });
    const d = el('dialog', { classe: 'cible-nfc-reglage', 'aria-label': 'Placer la cible NFC' },
      el('div', { classe: 'cible-nfc-consignes' },
        el('h2', { texte: 'Où est l\'antenne NFC ?' }),
        el('p', { texte: 'Passez lentement une puce NFC au dos du téléphone : il vibre quand elle est détectée. Touchez alors l\'écran juste au-dessus de cet endroit, puis faites glisser la cible pour l\'ajuster.' }),
        etat),
      repere,
      el('div', { classe: 'camera-actions cible-nfc-actions' }, annuler, retirer, valider));

    const arret = new AbortController();
    if (dispo()) {
      try {
        const lecteur = new NDEFReader();
        let derniere = 0;
        lecteur.addEventListener('reading', () => {
          const t = Date.now();
          if (t - derniere < 800) return;
          derniere = t;
          Scannette.vibrer();
          etat.textContent = 'Puce détectée ✓ : touchez l\'écran à cet endroit.';
          d.classList.remove('detectee');
          void d.offsetWidth; // relance l'animation
          d.classList.add('detectee');
        });
        lecteur.scan({ signal: arret.signal }).catch(() => { etat.textContent = 'NFC désactivé : activez-le pour repérer l\'antenne, ou placez la cible au jugé.'; });
      } catch (e) { /* lecteur indisponible : placement au jugé */ }
    }

    const suivre = (e) => {
      const r = d.getBoundingClientRect();
      p = { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
      placerAnneau(repere, p);
      repere.hidden = false;
      valider.disabled = false;
    };
    let glisse = false;
    d.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      glisse = true;
      try { d.setPointerCapture(e.pointerId); } catch (err) { /* sans capture */ }
      suivre(e);
    });
    d.addEventListener('pointermove', (e) => { if (glisse) suivre(e); });
    const lacher = () => { glisse = false; };
    d.addEventListener('pointerup', lacher);
    d.addEventListener('pointercancel', lacher);

    return new Promise((resoudre) => {
      const fin = (garder) => {
        if (garder !== undefined) enregistrer(garder);
        d.close();
      };
      valider.addEventListener('click', () => fin(p));
      if (retirer) retirer.addEventListener('click', () => fin(null));
      annuler.addEventListener('click', () => fin());
      d.addEventListener('close', () => {
        arret.abort();
        d.remove();
        reglage = false;
        rafraichir({ remonter: true });
        resoudre(position());
      });
      document.body.append(d);
      d.showModal();
      if (!p) etat.textContent = '';
    });
  }

  return { montrer, lien, placer, enReglage: () => reglage, disponible: dispo };
})();
