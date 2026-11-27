/**
 * Synchronisation entre appareils — transparente pour l'agent.
 *
 * 1. Données : toutes les 30 s (appli au premier plan, en ligne, agent connecté), l'appareil demande au
 *    serveur la « version » de chaque module (action « versions », Synchro.gs du backend : réponse très
 *    légère, sans lecture de Sheet). Un module modifié ailleurs est relu en silence ; s'il est affiché et
 *    que l'agent est en train de saisir (champ actif, fenêtre ouverte), on attend qu'il ait fini.
 * 2. Application : la version publiée sur le site (« avismur-vNNN » de sw.js) est comparée à celle
 *    chargée. Nouvelle version : la page se recharge d'elle-même au moment où l'agent ne fait rien
 *    (retour au premier plan, ou 2 min sans toucher l'écran), sur la même rubrique, au même endroit.
 *    Les brouillons et la file d'attente hors ligne sont gardés sur l'appareil : rien n'est perdu.
 *
 * Seul signe visible : une petite icône de synchronisation sur le bouton du menu, le temps de la relecture.
 */
const Synchro = (() => {
  const PERIODE_MS = 30 * 1000;
  const INACTIF_MS = 2 * 60 * 1000; // sans toucher l'écran : on peut recharger l'appli pour la mettre à jour
  const CLE_REPRISE = 'avismur_reprise_maj';

  let options = null;
  let connues = null; // versions des modules au dernier passage (null : pas encore de référence)
  const enAttente = new Set(); // modules modifiés ailleurs, pas encore relus (agent occupé)
  let verificationEnCours = false;
  let versionChargee = 0; // version de l'appli au chargement de la page
  let nouvelleVersion = false;
  let derniereActivite = Date.now();

  // ---------- Icône (bouton du menu, bandeau) ----------
  let actives = 0;
  let minuterieIcone = null;
  let affichageDepuis = 0;
  function icone() { return document.getElementById('synchro-icone'); }
  /** Début d'une synchronisation ; renvoie la fonction de fin. L'icône reste au moins 0,8 s pour être perçue. */
  function debut() {
    actives += 1;
    clearTimeout(minuterieIcone);
    const i = icone();
    if (i && i.hidden) { i.hidden = false; affichageDepuis = Date.now(); }
    let fini = false;
    return () => {
      if (fini) return;
      fini = true;
      actives = Math.max(0, actives - 1);
      if (actives) return;
      minuterieIcone = setTimeout(() => {
        if (!actives && icone()) icone().hidden = true;
      }, Math.max(0, 800 - (Date.now() - affichageDepuis)));
    };
  }

  // ---------- Agent occupé ? ----------
  const CHAMP_SAISIE = 'input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=reset]):not([type=range]), textarea, select, [contenteditable="true"]';
  /** Saisie en cours, fenêtre ou caméra ouverte : on ne redessine pas sous les doigts de l'agent. */
  function occupe() {
    const a = document.activeElement;
    if (a && a.matches && a.matches(CHAMP_SAISIE)) return true;
    return Boolean(document.querySelector('dialog[open]:not(#menu), [aria-modal="true"]'));
  }
  const visible = (ids) => (ids || []).some((id) => { const z = document.getElementById(id); return z && !z.hidden; });
  const actif = () => options && options.actif() && document.visibilityState === 'visible' && navigator.onLine;

  // ---------- Relecture des modules modifiés ----------
  async function relire() {
    if (!enAttente.size || !options) return;
    const taches = [];
    const scroll = window.scrollY;
    [...enAttente].forEach((nom) => {
      const m = options.modules[nom];
      if (!m) { enAttente.delete(nom); return; }
      const affiche = visible(m.zones);
      if (affiche && !m.gereSaisie && occupe()) return; // on attend la fin de la saisie
      enAttente.delete(nom);
      if (m.seulementAffiche && !affiche) return; // relu de toute façon à son ouverture
      try { taches.push(Promise.resolve(m.rafraichir()).catch(() => {})); } catch (e) { /* module indisponible */ }
    });
    if (!taches.length) return;
    const fin = debut();
    try { await Promise.all(taches); } finally { fin(); }
    // Contenu redessiné : on garde la position de lecture (si l'agent n'a pas défilé entre-temps).
    if (Math.abs(window.scrollY - scroll) > 2 && !occupe()) requestAnimationFrame(() => window.scrollTo(0, scroll));
  }

  /** Demande au serveur les versions des modules et relit ceux qui ont changé. */
  async function verifier() {
    if (!actif()) return;
    verifierAppli();
    if (verificationEnCours) return;
    verificationEnCours = true;
    try {
      const rep = await options.appeler('versions');
      if (rep && rep.ok && rep.versions) {
        const cle = options.simulation() ? 'sim' : 'reel';
        if (connues && connues.cle === cle) {
          Object.keys(rep.versions).forEach((nom) => {
            if (rep.versions[nom] !== connues.versions[nom]) enAttente.add(nom);
          });
        }
        connues = { cle, versions: rep.versions };
      }
    } catch (e) { /* hors ligne ou serveur pas encore à jour : on réessaiera */ } finally {
      verificationEnCours = false;
    }
    await relire();
  }

  // ---------- Nouvelle version de l'application ----------
  async function lireVersionSite() {
    const r = await fetch('sw.js', { cache: 'no-store' });
    const m = (await r.text()).match(/avismur-v(\d+)/);
    return m ? Number(m[1]) : 0;
  }
  async function verifierAppli() {
    if (!versionChargee || nouvelleVersion) { if (nouvelleVersion) rechargerSiPossible(); return; }
    try {
      const v = await lireVersionSite();
      if (v && v !== versionChargee) { nouvelleVersion = true; rechargerSiPossible(); }
    } catch (e) { /* hors ligne */ }
  }
  /** Recharge la page sur la même rubrique, si l'agent ne fait rien (ni saisie, ni fenêtre, ni envoi en cours). */
  function rechargerSiPossible(retourPremierPlan = false) {
    if (!nouvelleVersion || !options || document.visibilityState !== 'visible') return;
    if (occupe() || options.envoiEnCours()) return;
    if (!retourPremierPlan && Date.now() - derniereActivite < INACTIF_MS) return;
    try {
      sessionStorage.setItem(CLE_REPRISE, JSON.stringify({ vue: options.vue(), hash: location.hash, scroll: window.scrollY, le: Date.now() }));
    } catch (e) { /* stockage indisponible : on rouvrira l'accueil */ }
    debut();
    location.reload();
  }

  /** Après un rechargement automatique : rubrique et position à retrouver (une seule fois, dans la minute). */
  function reprise() {
    try {
      const r = JSON.parse(sessionStorage.getItem(CLE_REPRISE));
      sessionStorage.removeItem(CLE_REPRISE);
      return r && Date.now() - r.le < 60 * 1000 ? r : null;
    } catch (e) { return null; }
  }

  // ---------- Démarrage ----------
  /**
   * options : appeler(action), actif() (agent connecté, écran principal), simulation(), vue(),
   * envoiEnCours(), modules : { nom: { rafraichir(), zones: [ids], seulementAffiche, gereSaisie } }.
   */
  function demarrer(o) {
    options = o;
    lireVersionSite().then((v) => { versionChargee = v; }).catch(() => {
      // Hors ligne au chargement : version du cache de l'appareil.
      if (!('caches' in window)) return;
      caches.keys().then((cles) => {
        versionChargee = cles.filter((c) => /^avismur-v\d+$/.test(c)).map((c) => Number(c.split('-v')[1])).sort((a, b) => b - a)[0] || 0;
      }).catch(() => {});
    });
    setInterval(verifier, PERIODE_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (nouvelleVersion) { rechargerSiPossible(true); return; }
      verifier();
    });
    window.addEventListener('online', () => setTimeout(verifier, 3000)); // après l'envoi de la file d'attente
    ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((t) => window.addEventListener(t, () => { derniereActivite = Date.now(); }, { passive: true, capture: true }));
    // Fin d'une saisie : on relit tout de suite ce qui attendait.
    document.addEventListener('focusout', () => setTimeout(() => { if (enAttente.size && actif()) relire(); }, 1500));
    document.addEventListener('close', () => setTimeout(() => { if (enAttente.size && actif()) relire(); }, 500), true);
  }

  return {
    demarrer,
    verifier,
    reprise,
    /** Icône pendant un autre échange avec le serveur (envoi de la file d'attente) : renvoie la fonction de fin. */
    debut,
    /** Mode simulation activé ou quitté : nouvelle référence des versions. */
    oublier() { connues = null; enAttente.clear(); },
  };
})();
