/* Garde-focus : quand un écran est redessiné (synchro, enregistrement d'un champ qu'on vient de quitter…)
 * les champs sont détruits puis recréés. Sans précaution, le champ où l'on écrivait (ou que l'on vient de
 * toucher) disparaît : le curseur part, le clavier se ferme ou le texte tapé est perdu.
 * Ce module, indépendant des écrans, retrouve le champ recréé au même endroit et y remet le curseur,
 * le texte déjà tapé et la sélection. Il ne touche à rien si le champ n'a pas été remplacé. */
(() => {
  'use strict';
  const CHAMPS = 'input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=button]):not([type=submit]):not([type=reset]):not([type=hidden]):not([type=range]):not([type=color]), textarea';
  const DELAI_MAX = 2000; // au-delà, le champ est considéré comme retiré volontairement

  let suivi = null; // { el, racine, sig, rang, valeur, saisi, debut, fin, perdu }
  let enCours = false;

  const estChamp = (n) => Boolean(n && n.nodeType === 1 && n.matches && n.matches(CHAMPS));
  const signature = (n) => [n.tagName, n.type || '', n.getAttribute('placeholder') || '', n.getAttribute('aria-label') || '', n.getAttribute('name') || '', n.getAttribute('data-champ') || '', n.getAttribute('data-article') || ''].join('|');

  // Conteneur stable de l'écran : premier ancêtre avec un identifiant sans chiffre (les identifiants des
  // champs eux-mêmes sont numérotés et changent à chaque redessin).
  function racineDe(n) {
    for (let p = n.parentElement; p; p = p.parentElement) {
      if (p.id && !/\d/.test(p.id)) return p.id;
    }
    return '';
  }
  function champsDe(racine, sig) {
    const base = racine ? document.getElementById(racine) : document;
    if (!base) return [];
    return [...base.querySelectorAll(CHAMPS)].filter((c) => signature(c) === sig && !c.disabled && c.offsetParent !== null);
  }
  function lireSelection(n) {
    try { return [n.selectionStart, n.selectionEnd]; } catch (e) { return [null, null]; }
  }
  function suivre(n, saisi) {
    if (!estChamp(n)) { suivi = null; return; }
    const sig = signature(n);
    const racine = racineDe(n);
    const [debut, fin] = lireSelection(n);
    const memeChamp = suivi && suivi.el === n;
    suivi = {
      el: n, racine, sig,
      rang: Math.max(0, champsDe(racine, sig).indexOf(n)),
      valeur: n.value,
      saisi: memeChamp ? (suivi.saisi || saisi) : saisi,
      debut, fin, perdu: 0,
    };
  }

  document.addEventListener('focusin', (e) => suivre(e.target, false), true);
  document.addEventListener('pointerdown', (e) => {
    const c = e.target && e.target.closest ? e.target.closest(CHAMPS) : null;
    if (c) suivre(c, false); else suivi = null; // un bouton, un lien… : on a quitté la saisie volontairement
  }, true);
  document.addEventListener('input', (e) => { if (estChamp(e.target)) suivre(e.target, true); }, true);
  document.addEventListener('keyup', (e) => {
    if (suivi && suivi.el === e.target) { [suivi.debut, suivi.fin] = lireSelection(e.target); }
  }, true);
  document.addEventListener('keydown', (e) => {
    // Entrée / Échap dans un champ : saisie terminée, rien à rétablir.
    if (suivi && suivi.el === e.target && (e.key === 'Enter' || e.key === 'Escape')) suivi = null;
  }, true);

  function restaurer() {
    if (!suivi || suivi.el.isConnected || enCours) return;
    if (!suivi.perdu) suivi.perdu = Date.now();
    if (Date.now() - suivi.perdu > DELAI_MAX) { suivi = null; return; }
    const actif = document.activeElement;
    if (estChamp(actif) && actif.isConnected && actif !== document.body) return; // l'utilisateur est déjà ailleurs, dans un champ
    const candidats = champsDe(suivi.racine, suivi.sig);
    if (!candidats.length) return; // écran pas encore reconstruit : on réessaiera au prochain changement
    const cible = candidats[Math.min(suivi.rang, candidats.length - 1)];
    const { valeur, saisi, debut, fin } = suivi; // focus() et input() réécrivent « suivi » : on garde une copie
    enCours = true;
    try {
      if (saisi && cible.value !== valeur) {
        cible.value = valeur;
        cible.dispatchEvent(new Event('input', { bubbles: true }));
      }
      cible.focus({ preventScroll: true });
      if (debut !== null && fin !== null) { try { cible.setSelectionRange(debut, fin); } catch (e) { /* type sans sélection */ } }
    } finally { enCours = false; }
  }

  new MutationObserver(() => {
    if (!suivi || suivi.el.isConnected) return;
    restaurer();
    // Le navigateur termine parfois son propre changement de focus juste après : on vérifie encore.
    [40, 250].forEach((d) => setTimeout(() => {
      if (suivi && suivi.el.isConnected && document.activeElement !== suivi.el && !estChamp(document.activeElement)) {
        try { suivi.el.focus({ preventScroll: true }); } catch (e) { /* champ retiré entre-temps */ }
      } else if (suivi && !suivi.el.isConnected) restaurer();
    }, d));
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
