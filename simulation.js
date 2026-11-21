/**
 * Mode simulation (voir Simulation.gs du backend).
 *
 * Activé depuis le menu : l'agent part d'une journée vierge et peut tout faire (check-lists, inventaires, pleins,
 * fiche régulation, informations…). Le serveur range ces saisies à part : seuls les agents eux aussi en simulation
 * les voient. En sortant, tout ce qu'il a fait disparaît. Le paramétrage (véhicules, inventaires, articles,
 * matériel…) reste réel : une modification faite en simulation est gardée.
 *
 * Sur l'appareil, les données gardées pour le hors ligne (check-lists du jour, inventaires, file d'attente,
 * brouillons…) sont mises à part pendant la simulation : chaque clé « avismur_… » devient « avismur_sim__avismur_… »,
 * effacée à l'entrée et à la sortie. Les réglages de l'appareil (connexion, préférences d'affichage) sont communs.
 * Ce fichier est chargé juste après config.js, avant tous ceux qui lisent le stockage.
 *
 * La simulation s'arrête d'elle-même le lendemain, ou si un autre agent se connecte sur l'appareil.
 */
const Simulation = (() => {
  const CLE = 'avismur_simulation'; // { jour: 'aaaa-mm-jj', identifiant, depuis } : présente = mode simulation
  const PREFIXE = 'avismur_sim__';
  // Communes aux deux modes : connexion, réglages de l'appareil, paramétrage en attente d'envoi.
  const PARTAGEES = new Set([
    CLE, 'avismur_appareil', 'avismur_rester_connecte', 'avismur_config', 'avismur_inv_modifs', 'avismur_photo', 'avismur_profil',
    'avismur_annuaire', 'avismur_push_cle', 'avismur_push_desactive', 'avismur_detourage', 'avismur-echelle-mm',
    'mysmur.inventaires.impression', 'avismur_inv_astuce_retour', 'avismur_rafale', 'avismur_vrac_camera', 'avismur_cible_nfc',
    'avismur_infos_filtre', 'avismur_inv_tb_niveaux', 'avismur_inv_tableau', 'avismur-traceurs',
  ]);
  const proto = Storage.prototype;
  const brut = { get: proto.getItem, set: proto.setItem, remove: proto.removeItem };
  const aujourdhui = () => new Date().toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' }); // aaaa-mm-jj

  let etat = null;
  try { etat = JSON.parse(brut.get.call(localStorage, CLE)); } catch (e) { etat = null; }
  let messageFin = '';

  /** Efface les données de l'appareil propres à la simulation. */
  function viderDonnees() {
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.indexOf(PREFIXE) === 0) brut.remove.call(localStorage, k);
      }
    } catch (e) { /* stockage indisponible */ }
  }

  /** Fin de la simulation sur l'appareil (sans prévenir le serveur). */
  function terminerLocalement() {
    viderDonnees();
    try { brut.remove.call(localStorage, CLE); } catch (e) { /* stockage indisponible */ }
    etat = null;
  }

  // Simulation commencée un autre jour : terminée (le serveur a déjà effacé la journée simulée).
  if (etat && etat.jour !== aujourdhui()) {
    terminerLocalement();
    messageFin = 'Le mode simulation s\'est arrêté : nouvelle journée.';
  }

  // Stockage local : en simulation, les données de l'appli sont lues et écrites à part.
  const aPart = (stockage, k) => Boolean(etat) && stockage === localStorage && typeof k === 'string'
    && /^(avismur[_-]|mysmur\.)/.test(k) && k.indexOf(PREFIXE) !== 0 && !PARTAGEES.has(k);
  const cle = (stockage, k) => (aPart(stockage, k) ? PREFIXE + k : k);
  proto.getItem = function getItem(k) { return brut.get.call(this, cle(this, k)); };
  proto.setItem = function setItem(k, v) { return brut.set.call(this, cle(this, k), v); };
  proto.removeItem = function removeItem(k) { return brut.remove.call(this, cle(this, k)); };

  const $ = (id) => document.getElementById(id);

  function signaler(texte, classe = 'erreur') {
    const zone = $('statut');
    if (!zone) { window.alert(texte); return; }
    zone.textContent = texte;
    zone.className = `message ${classe}`;
    zone.scrollIntoView({ block: 'nearest' });
  }

  /** Bandeau rayé sous l'en-tête et libellé du bouton du menu. */
  function afficher(autres) {
    document.body.classList.toggle('mode-simulation', Boolean(etat));
    const bandeau = $('bandeau-simulation');
    if (bandeau) bandeau.hidden = !etat;
    const avec = $('simulation-avec');
    if (avec) {
      const liste = autres || [];
      avec.textContent = liste.length ? `Aussi en simulation : ${liste.join(', ')}.` : '';
      avec.hidden = !liste.length;
    }
    const bouton = $('bouton-simulation');
    if (bouton) {
      bouton.querySelector('.simulation-libelle').textContent = etat ? 'Quitter le mode simulation' : 'Mode simulation';
      bouton.querySelector('small').textContent = etat
        ? 'Tout ce qui a été fait en simulation sera effacé'
        : 'S\'entraîner sur une journée vierge, sans rien enregistrer';
      bouton.setAttribute('aria-pressed', String(Boolean(etat)));
    }
  }

  async function entrer() {
    if (!navigator.onLine) {
      signaler('Pas de réseau : le mode simulation ne peut être activé qu\'en ligne.');
      return;
    }
    if (!window.confirm('Passer en mode simulation ?\n\n'
      + '• Vous partez d\'une journée vierge : check-lists, inventaires, pleins, fiche régulation, informations…\n'
      + '• Seuls les agents eux aussi en simulation voient ce que vous faites.\n'
      + '• Rien n\'est envoyé : ni notification, ni mail à la régulation, ni SMS.\n'
      + '• En quittant le mode, tout ce que vous avez fait est effacé.\n'
      + '• Les modifications du paramétrage (véhicules, inventaires, articles, matériel) restent, elles, enregistrées.')) return;
    // Ce qui attend sur l'appareil part d'abord pour de vrai.
    await envoyerFileAttente();
    if (fileAttente.lire().length) {
      signaler('Des enregistrements attendent encore d\'être envoyés au serveur : le mode simulation sera disponible une fois qu\'ils seront partis.');
      return;
    }
    const fin = chargement.debut('Préparation de la journée simulée…');
    let rep;
    try {
      rep = await appeler('entrerSimulation');
    } catch (err) {
      signaler(ERREUR_RESEAU);
      return;
    } finally {
      fin();
    }
    if (!rep.ok) {
      signaler(rep.erreur || 'Le serveur a refusé le mode simulation.');
      return;
    }
    viderDonnees();
    etat = { jour: rep.jour || aujourdhui(), identifiant: (session.lire() || {}).identifiant || '', depuis: new Date().toISOString() };
    brut.set.call(localStorage, CLE, JSON.stringify(etat));
    location.reload(); // tout est relu, cette fois dans la journée simulée
  }

  /**
   * Sortie du mode : le serveur efface ce que l'agent a fait, l'appareil oublie les données simulées.
   * `confirmer` : false pour la déconnexion et le changement de jour.
   */
  async function sortir({ confirmer = true, recharger = true } = {}) {
    if (!etat) return;
    if (confirmer && !window.confirm('Quitter le mode simulation ?\n\nTout ce que vous avez fait en simulation sera effacé.')) return;
    // Paramétrage modifié pendant la simulation et encore sur l'appareil : envoyé avant d'effacer la file.
    if (navigator.onLine) { try { await envoyerFileAttente(); } catch (e) { /* tant pis */ } }
    const restantes = fileAttente.lire().length;
    if (confirmer && restantes && !window.confirm(`${restantes} enregistrement(s) n'ont pas pu partir (hors ligne ?). Ils seront perdus. Quitter quand même ?`)) return;
    const fin = chargement.debut('Effacement de la journée simulée…');
    try { await appeler('sortirSimulation'); } catch (e) { /* hors ligne : le serveur efface tout le lendemain */ } finally { fin(); }
    terminerLocalement();
    if (recharger) location.reload();
    else afficher();
  }

  /** Après la connexion : un autre agent sur l'appareil ne reste pas dans la simulation du précédent. */
  function verifierAgent(identifiant) {
    if (messageFin) { signaler(messageFin, 'message'); messageFin = ''; }
    if (!etat) { afficher(); return; }
    if (identifiant && etat.identifiant && identifiant !== etat.identifiant) {
      terminerLocalement();
      location.reload();
      return;
    }
    afficher();
    if (navigator.onLine) {
      appeler('etatSimulation').then((rep) => { if (rep.ok && etat) afficher(rep.autres); }).catch(() => {});
    }
  }

  // Application restée ouverte après minuit : la journée simulée est terminée.
  setInterval(() => {
    if (etat && etat.jour !== aujourdhui()) {
      messageFin = 'Le mode simulation s\'est arrêté : nouvelle journée.';
      sortir({ confirmer: false });
    }
  }, 60 * 1000);

  document.addEventListener('DOMContentLoaded', () => {
    afficher();
    const bouton = $('bouton-simulation');
    if (bouton) bouton.addEventListener('click', () => { if (typeof fermerMenu === 'function') fermerMenu(); return etat ? sortir() : entrer(); });
    const quitter = $('quitter-simulation');
    if (quitter) quitter.addEventListener('click', () => sortir());
  });

  return {
    actif: () => Boolean(etat),
    entrer,
    sortir,
    verifierAgent,
  };
})();
