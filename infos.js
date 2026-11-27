/*
 * Mur d'informations : page d'accueil de l'appli.
 *
 * Chaque agent peut publier une information, une alerte ou un rappel : type (géré par les
 * administrateurs), importance (urgente, importante, normale : code couleur), période (début,
 * aujourd'hui par défaut ; fin facultative) et destinataires (ambulanciers, IADE, encadrement).
 * Tout le monde peut mettre fin à une information devenue obsolète.
 *
 * Pièces jointes : photos (réduites à 1280 px), documents (PDF, Office, texte ; 2 Mo au plus) et liens,
 * jusqu'à 6 par information ou commentaire. Commentaires : tout agent peut commenter une information
 * (bouton « Commenter » de la carte) ; l'auteur de l'information et les autres commentateurs sont notifiés.
 *
 * Classement : urgentes en tête, puis en cours (importance, puis les plus récentes), à venir
 * (par date de début), et terminées depuis moins d'une semaine (repliées).
 *
 * Notifications push : chaque publication est notifiée aux destinataires (sauf l'auteur) ;
 * un rappel programmé l'est le jour de son début, vers 7 h. L'agent active les notifications
 * une fois par appareil (bouton en haut du mur) ; l'appareil se réabonne seul à chaque ouverture.
 *
 * Rappels des commandes (pharmacie, magasin) : cartes hebdomadaires en tête de l'accueil, « Fait » ou « Complète » / « Incomplète » (RappelsCommandes.gs).
 *
 * Hors ligne : le dernier mur reçu est gardé sur l'appareil ; une publication ou une fin
 * passe par la file d'attente de app.js (actions « creerInfo », « terminerInfo », « commenterInfo »,
 * « supprimerCommentaire »). Backend : Infos.gs, CommentairesInfos.gs, PiecesJointes.gs et Push.gs (dépôt AVISMUR-backend).
 */
const Infos = (() => {
  const CLE_MUR = 'avismur_infos';
  const CLE_FILTRE = 'avismur_infos_filtre';
  const CLE_PUSH = 'avismur_push_cle';
  const CLE_VUES = 'avismur_infos_vues'; // informations déjà vues sur cet appareil, par agent (clochette de la barre du bas)
  const CLE_SUPPRIMEES = 'avismur_notifs_supprimees'; // notifications lues que l'agent a retirées de sa liste (cet appareil)
  const METIERS = [
    { id: 'ambulancier', libelle: 'Ambulanciers' },
    { id: 'iade', libelle: 'IADE' },
    { id: 'medical', libelle: 'Médecins et internes' },
    { id: 'encadrement', libelle: 'Encadrement' },
  ];
  const IMPORTANCES = [
    { id: 'normale', libelle: 'Normale' },
    { id: 'importante', libelle: 'Importante' },
    { id: 'urgente', libelle: 'Urgente' },
  ];
  const RANG = { urgente: 0, importante: 1, normale: 2 };
  // Types d'origine, utilisés tant que le serveur n'a pas répondu (première ouverture hors ligne).
  const TYPES_DEFAUT = [
    { id: 'consigne', libelle: 'Consigne', icone: 'consigne', importance: 'importante' },
    { id: 'vehicule', libelle: 'Véhicule', icone: 'vehicule', importance: 'normale' },
    { id: 'panne', libelle: 'Panne', icone: 'panne', importance: 'importante' },
    { id: 'accident', libelle: 'Accident', icone: 'accident', importance: 'urgente' },
    { id: 'materiel-rendre', libelle: 'Matériel à rendre', icone: 'rendre', importance: 'normale' },
    { id: 'materiel-recuperer', libelle: 'Matériel à récupérer', icone: 'recuperer', importance: 'normale' },
    { id: 'information', libelle: 'Information', icone: 'info', importance: 'normale' },
  ];

  // Pictogrammes des types (24 × 24, trait). Les administrateurs choisissent parmi cette liste.
  const ICONES = {
    consigne: { nom: 'Consigne', d: '<path d="M9 4h6a1 1 0 0 1 1 1v1H8V5a1 1 0 0 1 1-1z"/><path d="M8 5H6a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2"/><path d="M9 11h6M9 15h4"/>' },
    vehicule: { nom: 'Véhicule', d: '<path d="M3 16V8a1 1 0 0 1 1-1h10l4 4h2a1 1 0 0 1 1 1v4"/><path d="M3 16h2m4 0h6m4 0h2"/><circle cx="7" cy="16.5" r="2"/><circle cx="17" cy="16.5" r="2"/><path d="M8 10.5h3M9.5 9v3"/>' },
    panne: { nom: 'Panne', d: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>' },
    accident: { nom: 'Alerte', d: '<path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5M12 17.3v.2"/>' },
    rendre: { nom: 'À rendre', d: '<path d="M4 9.5 12 5l8 4.5v8L12 22l-8-4.5z"/><path d="M12 13v-8M9 8l3-3 3 3"/>' },
    recuperer: { nom: 'À récupérer', d: '<path d="M4 9.5 12 5l8 4.5v8L12 22l-8-4.5z"/><path d="M12 5v8M9 10l3 3 3-3"/>' },
    info: { nom: 'Information', d: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.2"/>' },
    formation: { nom: 'Formation', d: '<path d="M2 9l10-5 10 5-10 5z"/><path d="M6 11v5c3 2.5 9 2.5 12 0v-5M22 9v6"/>' },
    reunion: { nom: 'Réunion', d: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.5 2.7-6 6-6s6 2.5 6 6"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.2c2.9.2 5 2.5 5 5.8"/>' },
    medicament: { nom: 'Médicament', d: '<rect x="3" y="8.5" width="18" height="7" rx="3.5" transform="rotate(-45 12 12)"/><path d="M9.5 9.5l5 5"/>' },
    telephone: { nom: 'Téléphone', d: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z"/>' },
    calendrier: { nom: 'Calendrier', d: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>' },
    oxygene: { nom: 'Oxygène', d: '<rect x="8" y="6" width="8" height="15" rx="3"/><path d="M10 6V3.5h4V6M12 3.5V2"/><path d="M10.5 12.5a1.8 1.8 0 1 0 3 0 1.8 1.8 0 1 0-3 0"/>' },
    outil: { nom: 'Entretien', d: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>' },
  };

  let App = null; // fonctions de app.js
  let zone = null;
  let mur = { aujourdhui: '', metier: '', types: TYPES_DEFAUT, infos: [], recu: '' };
  let filtre = { portee: '', type: '' }; // portee : 'moi' ou 'tous' ('' : selon le métier)
  let vue = 'mur'; // 'mur' ou 'types' (administration)
  let cible = ''; // information à mettre en évidence (lien d'une notification)
  let confirmerFin = ''; // information dont on confirme la fin
  let avis = { texte: '', classe: '' };
  let chargementEnCours = false;
  let brouillonTypes = null;

  // ---------- Outils ----------
  const SVG = 'http://www.w3.org/2000/svg';
  function el(balise, attributs = {}, ...enfants) {
    const n = balise.startsWith('svg:') ? document.createElementNS(SVG, balise.slice(4)) : document.createElement(balise);
    Object.entries(attributs).forEach(([k, v]) => {
      if (v === undefined || v === null || v === false) return;
      if (k === 'texte') n.textContent = v;
      else if (k === 'classe') n.setAttribute('class', v);
      else if (k === 'valeur') n.value = v;
      else if (k.startsWith('sur')) n.addEventListener(k.slice(3), v);
      else n.setAttribute(k, v === true ? '' : v);
    });
    n.append(...enfants.flat().filter((e) => e !== null && e !== undefined && e !== false));
    return n;
  }
  let compteur = 0;
  const nouvelId = () => `info-${++compteur}`;

  function icone(nom, classe = 'info-picto') {
    const s = document.createElementNS(SVG, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('class', classe);
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    s.innerHTML = (ICONES[nom] || ICONES.info).d; // contenu fixe, défini ci-dessus
    return s;
  }

  /** Date du jour sur l'appareil, « aaaa-mm-jj ». */
  function jour(decalage = 0) {
    const d = new Date();
    d.setDate(d.getDate() + decalage);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function dateLocale(iso) {
    const [a, m, j] = String(iso).split('-').map(Number);
    return new Date(a, m - 1, j);
  }
  const dateCourte = (iso) => dateLocale(iso).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
  function relatif(isoHorodatage) {
    const d = new Date(isoHorodatage);
    if (Number.isNaN(d.getTime())) return '';
    const minutes = Math.round((Date.now() - d.getTime()) / 60000);
    if (minutes < 1) return 'à l\'instant';
    if (minutes < 60) return `il y a ${minutes} min`;
    const heure = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const j = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (j === jour()) return `aujourd'hui à ${heure}`;
    if (j === jour(-1)) return `hier à ${heure}`;
    return `le ${d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} à ${heure}`;
  }

  const typeDe = (id) => mur.types.find((t) => t.id === id) || { id, libelle: 'Information', icone: 'info', importance: 'normale' };
  const typesActifs = () => mur.types.filter((t) => !t.archive);
  const agent = () => App.agent();

  // ---------- Données ----------
  function lireCache() {
    try {
      const m = JSON.parse(localStorage.getItem(CLE_MUR));
      if (m && Array.isArray(m.infos)) mur = { ...mur, ...m, types: m.types && m.types.length ? m.types : TYPES_DEFAUT };
    } catch (e) { /* rien en cache */ }
    try {
      const f = JSON.parse(localStorage.getItem(CLE_FILTRE));
      if (f) filtre.portee = f.portee || '';
    } catch (e) { /* défaut */ }
  }

  /** Mur reçu du serveur + ce qui attend dans la file d'attente de cet appareil. */
  function infosAffichees() {
    const file = App.fileAttente();
    const locales = file.filter((e) => e.action === 'creerInfo').map((e) => ({
      ...e.donnees,
      id: `local-${e.id}`,
      idFile: e.id,
      auteur: e.agent || agent(),
      creee: e.date,
      terminee: '',
      enAttente: true,
      suivi: e.donnees.suivi ? 'a-amener' : '',
    }));
    const fins = {};
    file.filter((e) => e.action === 'terminerInfo').forEach((e) => { fins[e.donnees.id] = e; });
    // Suivi biomédical : étapes déjà validées sur cet appareil, pas encore envoyées au serveur.
    const etapes = {};
    file.filter((e) => e.action === 'avancerSuiviBiomed').forEach((e) => { etapes[e.donnees.id] = e; });
    return mur.infos.concat(locales).map((i0) => {
      let i = i0;
      const e = etapes[i.id];
      if (e && i.suivi) {
        const cible = e.donnees.etape === 'recupere' ? 'recupere' : 'au-biomed';
        if (ORDRE_SUIVI.indexOf(i.suivi) < ORDRE_SUIVI.indexOf(cible)) {
          i = { ...i, suivi: cible, suiviEnAttente: true };
          if (cible === 'recupere' && !i.terminee) i.terminee = e.date;
        }
      }
      return fins[i.id] && !i.terminee
        ? { ...i, terminee: fins[i.id].date, termineePar: fins[i.id].agent || agent(), finEnAttente: true }
        : i;
    });
  }

  // Suivi d'un appareil en panne publié sur le mur : à amener → au biomédical → récupéré (SuiviBiomed.gs côté serveur).
  const ORDRE_SUIVI = ['a-amener', 'au-biomed', 'recupere'];
  const LIBELLES_SUIVI = { 'a-amener': 'À amener au service biomédical', 'au-biomed': 'Au service biomédical', recupere: 'Récupéré du service biomédical' };

  function statut(info, aujourdhui) {
    if (info.terminee || (info.fin && info.fin < aujourdhui)) return 'terminee';
    if (info.debut > aujourdhui) return 'avenir';
    return 'encours';
  }

  function porteeEffective() {
    return mur.metier && mur.metier !== 'encadrement' ? 'moi' : 'tous';
  }

  function pourMoi(info) {
    if (!mur.metier) return true;
    return info.auteur === agent() || !info.destinataires || !info.destinataires.length || info.destinataires.includes(mur.metier);
  }

  async function charger() {
    if (chargementEnCours) return;
    chargementEnCours = true;
    try {
      const rep = await App.appeler('lireInfos');
      if (rep.ok) {
        mur = { aujourdhui: rep.aujourdhui, metier: rep.metier || '', types: rep.types && rep.types.length ? rep.types : TYPES_DEFAUT, infos: rep.infos || [], commandes: rep.commandes || mur.commandes || null, recu: new Date().toISOString() };
        try { localStorage.setItem(CLE_MUR, JSON.stringify(mur)); } catch (e) { /* stockage plein */ }
      } else if (/Action inconnue/.test(rep.erreur || '')) {
        avis = { texte: 'Le serveur n\'a pas encore le mur d\'informations : prévenez l\'administrateur (Infos.gs à installer).', classe: 'erreur' };
      }
    } catch (err) { /* hors ligne : on garde le dernier mur connu */ } finally {
      chargementEnCours = false;
    }
    if (estVisible() && !saisieEnCours()) rendre();
    if (estVisible() && vue === 'mur') marquerVues(); else signalerCompteur();
  }

  // ---------- Clochette (barre d'actions rapide) ----------
  // Notifications : informations en cours qui me concernent, publiées par un autre. Non lues : pas encore vues sur
  // cet appareil. Une notification lue peut être supprimée : elle quitte la liste de la clochette (pas le mur).
  function lireListe(cle) {
    try { return new Set((JSON.parse(localStorage.getItem(cle)) || {})[agent()] || []); } catch (e) { return new Set(); }
  }
  function ecrireListe(cle, ids) {
    try {
      const toutes = JSON.parse(localStorage.getItem(cle)) || {};
      toutes[agent()] = [...ids].slice(-500);
      localStorage.setItem(cle, JSON.stringify(toutes));
    } catch (e) { /* stockage indisponible */ }
  }
  function notifications() {
    if (!agent()) return [];
    const supprimees = lireListe(CLE_SUPPRIMEES);
    const aujourdhui = jour();
    return infosAffichees().filter((i) => i.id && !i.enAttente && i.auteur !== agent() && pourMoi(i)
      && statut(i, aujourdhui) === 'encours' && !supprimees.has(i.id))
      .sort((x, y) => String(y.creee || y.debut).localeCompare(String(x.creee || x.debut)));
  }
  function nonLues() {
    const vues = lireListe(CLE_VUES);
    return notifications().filter((i) => !vues.has(i.id)).length;
  }
  function signalerCompteur() {
    document.dispatchEvent(new CustomEvent('infos-compteur', { detail: nonLues() }));
  }
  function marquerLues(ids) {
    if (!agent()) return;
    const vues = lireListe(CLE_VUES);
    ids.forEach((x) => vues.add(x));
    ecrireListe(CLE_VUES, vues);
    signalerCompteur();
  }
  /** Mur affiché : tout ce qui est en cours est considéré comme lu. */
  function marquerVues() { marquerLues(infosAffichees().map((i) => i.id).filter(Boolean)); }
  function supprimerNotifications(ids) {
    const supprimees = lireListe(CLE_SUPPRIMEES);
    ids.forEach((x) => supprimees.add(x));
    ecrireListe(CLE_SUPPRIMEES, supprimees);
    signalerCompteur();
  }

  /** Fenêtre de la clochette : liste des notifications, non lues en tête ; les lues se suppriment. */
  function ouvrirNotifications() {
    const idTitre = nouvelId();
    const corps = el('div', { classe: 'notifs' });
    function remplir() {
      const vues = lireListe(CLE_VUES);
      const liste = notifications();
      const lues = liste.filter((i) => vues.has(i.id));
      corps.innerHTML = '';
      if (!liste.length) { corps.append(el('p', { classe: 'consigne', texte: 'Aucune notification.' })); return; }
      const nonLuesListe = liste.filter((i) => !vues.has(i.id));
      corps.append(el('div', { classe: 'notifs-outils' },
        nonLuesListe.length ? el('button', { type: 'button', classe: 'secondaire', texte: 'Tout marquer comme lu',
          surclick: () => { marquerLues(nonLuesListe.map((i) => i.id)); remplir(); } }) : null,
        lues.length ? el('button', { type: 'button', classe: 'secondaire', texte: `Supprimer les lues (${lues.length})`,
          surclick: () => { supprimerNotifications(lues.map((i) => i.id)); remplir(); } }) : null));
      corps.append(el('ul', { classe: 'notifs-liste' }, ...nonLuesListe.concat(lues).map((i) => {
        const lue = vues.has(i.id);
        return el('li', { classe: `notif ${i.importance || 'normale'}${lue ? ' lue' : ''}` },
          el('button', { type: 'button', classe: 'notif-ouvrir', surclick: () => {
            marquerLues([i.id]);
            fermerFenetre();
            location.hash = `#info=${i.id}`;
          } },
          lue ? null : el('span', { classe: 'notif-point', 'aria-label': 'Non lue' }),
          el('strong', { texte: i.titre || 'Information' }),
          el('small', { texte: [i.auteur, i.creee ? dateCourte(String(i.creee).slice(0, 10)) : ''].filter(Boolean).join(' · ') })),
          lue ? el('button', { type: 'button', classe: 'notif-supprimer', 'aria-label': `Supprimer la notification « ${i.titre || 'Information'} »`, title: 'Supprimer',
            texte: '✕', surclick: () => { supprimerNotifications([i.id]); remplir(); } }) : null);
      })));
    }
    remplir();
    ouvrirFenetre('Notifications', idTitre, corps);
  }

  const estVisible = () => zone && !zone.hidden;

  // ---------- Affichage du mur ----------
  function rendre() {
    if (!zone) return;
    if (vue === 'types') { rendreTypes(); return; }
    const aujourdhui = jour();
    const toutes = infosAffichees();
    const portee = porteeEffective();
    const visibles = toutes.filter((i) => portee === 'tous' || pourMoi(i));
    const parType = visibles.filter((i) => !filtre.type || i.type === filtre.type);

    const encours = parType.filter((i) => statut(i, aujourdhui) === 'encours').sort((a, b) => (RANG[a.importance] - RANG[b.importance])
      || ((a.fin === aujourdhui) === (b.fin === aujourdhui) ? 0 : (a.fin === aujourdhui ? -1 : 1))
      || String(b.debut).localeCompare(String(a.debut))
      || String(b.creee).localeCompare(String(a.creee)));
    const urgentes = encours.filter((i) => i.importance === 'urgente');
    const autres = encours.filter((i) => i.importance !== 'urgente');
    const avenir = parType.filter((i) => statut(i, aujourdhui) === 'avenir').sort((a, b) => a.debut.localeCompare(b.debut) || RANG[a.importance] - RANG[b.importance]);
    const terminees = parType.filter((i) => statut(i, aujourdhui) === 'terminee')
      .sort((a, b) => String(b.terminee || b.fin).localeCompare(String(a.terminee || a.fin)));

    zone.innerHTML = '';
    ajouter(
      // En haut du mur (le bas de l'écran est pris par la barre d'actions rapide).
      el('button', { type: 'button', classe: 'principal mur-publier', surclick: () => formulaire() },
        el('span', { 'aria-hidden': 'true', texte: '+' }), 'Publier une nouvelle information'),
      blocNotifications(),
      blocRappelsCommandes(),
      blocRappelsMaintenance(),
      avis.texte ? el('p', { classe: `message ${avis.classe}`, role: 'status', texte: avis.texte }) : null,
      barreFiltres(visibles, aujourdhui, portee),
    );

    if (!encours.length && !avenir.length) {
      zone.append(el('div', { classe: 'mur-vide' },
        icone('info', 'mur-vide-picto'),
        el('p', { texte: filtre.type ? 'Aucune information de ce type en ce moment.' : 'Rien à signaler pour le moment.' }),
        el('button', { type: 'button', classe: 'lien', texte: 'Publier une information', surclick: () => formulaire() })));
    }
    if (urgentes.length) zone.append(section('Urgent', urgentes, aujourdhui, 'mur-section-urgente'));
    if (autres.length) zone.append(section('En cours', autres, aujourdhui));
    if (avenir.length) zone.append(section('À venir', avenir, aujourdhui, 'mur-section-avenir'));
    if (terminees.length) {
      const details = el('details', { classe: 'mur-terminees' },
        el('summary', {}, `Terminées cette semaine (${terminees.length})`),
        el('div', { classe: 'mur-grille' }, terminees.map((i) => carte(i, aujourdhui))));
      zone.append(details);
    }

    if (cible && !deplies.has(cible)) { deplies.add(cible); rendre(); return; }
    if (cible) {
      const c = zone.querySelector(`[data-id="${CSS.escape(cible)}"]`);
      if (c) {
        const repli = c.closest('details');
        if (repli) repli.open = true;
        c.classList.add('info-ciblee');
        c.scrollIntoView({ block: 'center', behavior: 'smooth' });
        c.focus({ preventScroll: true });
      }
      cible = '';
    }
  }

  /** zone.append sans les éléments absents (append écrirait « null »). */
  function ajouter(...enfants) {
    zone.append(...enfants.filter((e) => e !== null && e !== undefined && e !== false));
  }

  function resumeDuJour(n, urgentes) {
    const date = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    const nb = n ? `${n} information${n > 1 ? 's' : ''} en cours` : 'Aucune information en cours';
    return `${date.charAt(0).toUpperCase()}${date.slice(1)} · ${nb}${urgentes ? ` dont ${urgentes} urgente${urgentes > 1 ? 's' : ''}` : ''}`;
  }

  // ---------- Rappels des commandes (pharmacie, magasin) ----------
  // Rappels hebdomadaires : scanner la commande (IADE, « Fait ») et réceptionner la commande (tout le monde, « Complète » /
  // « Incomplète » + texte). Collectifs : le premier qui répond clôt le rappel pour tous. La liste des rappels, leurs jours
  // et leurs destinataires viennent du serveur (RappelsCommandes.gs), avec le mur ; copie ci-dessous pour une première
  // ouverture hors ligne. Réponses envoyées par la file d'attente (action « repondreRappelCommande »).
  const COMMANDES_DEFAUT = {
    retard: 3,
    reponses: [],
    definitions: [
      { id: 'scan-pharmacie', titre: 'Scanner la commande pharmacie', jours: [1, 4], cible: ['iade'], type: 'fait' },
      { id: 'scan-magasin', titre: 'Scanner la commande magasin', jours: [3], cible: ['iade'], type: 'fait' },
      { id: 'reception-pharmacie', titre: 'Réception commande pharmacie', jours: [2, 5], cible: null, type: 'reception' },
      { id: 'reception-magasin', titre: 'Réception commande magasin', jours: [5], cible: null, type: 'reception' },
      { id: 'fluides', titre: 'Inventaire et commande des fluides médicaux', jours: [4], cible: ['ambulancier'], type: 'fluides', vue: 'fluides' },
    ],
  };
  const brouillonsCommandes = new Map(); // « rappel|jour » → { incomplete: bool, texte } (garde la saisie entre deux affichages)
  const correctionsCommandes = new Set(); // « rappel|jour » dont on corrige la réponse

  const commandes = () => (mur.commandes && Array.isArray(mur.commandes.definitions) ? mur.commandes : COMMANDES_DEFAUT);
  /** 1 = lundi … 7 = dimanche. */
  function jourSemaine(iso) {
    const j = dateLocale(iso).getDay();
    return j === 0 ? 7 : j;
  }

  /** Réponses connues du serveur, complétées de celles qui attendent d'être envoyées depuis cet appareil. */
  function reponsesCommandes() {
    const reponses = new Map();
    (commandes().reponses || []).forEach((r) => reponses.set(`${r.rappel}|${r.jour}`, r));
    App.fileAttente().filter((e) => e.action === 'repondreRappelCommande' && e.donnees).forEach((e) => {
      const d = e.donnees;
      reponses.set(`${d.rappel}|${d.jour}`, { rappel: d.rappel, jour: d.jour, reponse: d.reponse, commentaire: d.commentaire || '', par: e.agent || agent(), le: e.date, enAttente: true });
    });
    // Commande des fluides envoyée depuis cet appareil, pas encore reçue : clôt le rappel du jeudi de la semaine.
    App.fileAttente().filter((e) => e.action === 'enregistrerFluides' && e.donnees && e.donnees.envoyee).forEach((e) => {
      const j = dateLocale(e.donnees.jour);
      j.setDate(j.getDate() - ((j.getDay() + 3) % 7)); // jeudi précédent ou le jour même
      const jeudi = `${j.getFullYear()}-${String(j.getMonth() + 1).padStart(2, '0')}-${String(j.getDate()).padStart(2, '0')}`;
      reponses.set(`fluides|${jeudi}`, { rappel: 'fluides', jour: jeudi, reponse: 'fait', par: e.agent || agent(), le: e.date, enAttente: true });
    });
    return reponses;
  }

  /** Rappels à afficher : ceux d'aujourd'hui, ceux des derniers jours restés sans réponse, et les réponses du jour. */
  function echeancesCommandes() {
    const c = commandes();
    const reponses = reponsesCommandes();
    const echeances = [];
    c.definitions.filter((d) => !d.cible || d.cible.includes(mur.metier)).forEach((def) => {
      for (let k = 0; k <= (c.retard || 0); k += 1) {
        const j = jour(-k);
        if (!def.jours.includes(jourSemaine(j))) continue;
        const rep = reponses.get(`${def.id}|${j}`);
        if (rep && k > 0) continue; // traité les jours précédents : on n'en parle plus
        echeances.push({ def, jour: j, retard: k > 0, rep });
      }
    });
    return echeances.sort((a, b) => (Boolean(a.rep) - Boolean(b.rep)) || a.jour.localeCompare(b.jour) || a.def.titre.localeCompare(b.def.titre, 'fr'));
  }

  function repondreCommande(echeance, reponse, commentaire = '') {
    const cle = `${echeance.def.id}|${echeance.jour}`;
    const ok = App.mettreEnFile({
      action: 'repondreRappelCommande',
      donnees: { rappel: echeance.def.id, jour: echeance.jour, reponse, commentaire, corriger: Boolean(echeance.rep) },
      agent: agent(),
    });
    if (!ok) return; // mémoire pleine : la saisie reste à l'écran
    brouillonsCommandes.delete(cle);
    correctionsCommandes.delete(cle);
    rendre();
  }

  const LIBELLES_COMMANDE = { fait: 'Fait', fluides: 'Commande envoyée', complete: 'Commande complète', incomplete: 'Commande incomplète' };

  function carteCommande(echeance) {
    const { def, rep } = echeance;
    const cle = `${def.id}|${echeance.jour}`;
    const enCorrection = correctionsCommandes.has(cle);
    const traite = Boolean(rep) && !enCorrection;
    const classe = ['mur-rappel', 'mur-commande', echeance.retard ? 'en-retard' : '', traite ? 'traite' : '', traite && rep.reponse === 'incomplete' ? 'incomplete' : ''].filter(Boolean).join(' ');
    const echeanceTexte = echeance.retard ? `En retard : prévu ${dateCourte(echeance.jour)}` : 'À faire aujourd\'hui';

    if (traite) {
      return el('div', { classe, 'data-commande': cle },
        el('p', { classe: 'mur-rappel-titre' }, el('strong', { texte: def.titre })),
        el('p', { classe: 'mur-commande-resultat', texte: `${rep.reponse === 'incomplete' ? '⚠ ' : '✓ '}${LIBELLES_COMMANDE[rep.reponse] || 'Fait'}` }),
        rep.commentaire ? el('p', { classe: 'mur-commande-manque', texte: rep.commentaire }) : null,
        el('p', { classe: 'mur-rappel-echeance', texte: [rep.par ? `par ${rep.par}` : '', rep.le ? relatif(rep.le) : '', rep.enAttente ? 'en attente d\'envoi' : ''].filter(Boolean).join(' · ') }),
        def.type === 'fluides' ? null : el('button', { type: 'button', classe: 'info-bouton', texte: 'Corriger', surclick: () => { correctionsCommandes.add(cle); rendre(); } }));
    }

    const brouillon = brouillonsCommandes.get(cle) || { incomplete: false, texte: '' };
    let actions;
    if (def.type === 'fluides') {
      actions = [el('button', { type: 'button', classe: 'info-bouton info-bouton-suivi', texte: 'Faire l\'inventaire', surclick: () => App.ouvrirVue(def.vue || 'fluides') })];
    } else if (def.type === 'fait') {
      actions = [el('button', { type: 'button', classe: 'info-bouton info-bouton-suivi', texte: 'Fait', surclick: () => repondreCommande(echeance, 'fait') })];
    } else if (brouillon.incomplete) {
      const champ = el('textarea', {
        rows: '3', maxlength: '500', placeholder: 'Ce qui manque ou ne correspond pas (facultatif)', 'aria-label': `Ce qui manque : ${def.titre}`,
        surinput: () => { brouillon.texte = champ.value; },
      });
      champ.value = brouillon.texte;
      actions = [
        champ,
        el('div', { classe: 'mur-commande-boutons' },
          el('button', { type: 'button', classe: 'info-bouton danger', texte: 'Envoyer : incomplète', surclick: () => repondreCommande(echeance, 'incomplete', champ.value) }),
          el('button', { type: 'button', classe: 'info-bouton', texte: 'Retour', surclick: () => { brouillonsCommandes.delete(cle); rendre(); } })),
      ];
    } else {
      actions = [el('div', { classe: 'mur-commande-boutons' },
        el('button', { type: 'button', classe: 'info-bouton info-bouton-suivi', texte: 'Complète', surclick: () => repondreCommande(echeance, 'complete') }),
        el('button', { type: 'button', classe: 'info-bouton', texte: 'Incomplète', surclick: () => {
          brouillonsCommandes.set(cle, { incomplete: true, texte: '' });
          rendre();
          const champ = zone.querySelector(`[data-commande="${CSS.escape(cle)}"] textarea`);
          if (champ) champ.focus();
        } }))];
    }
    if (enCorrection) {
      actions.push(el('button', { type: 'button', classe: 'lien', texte: 'Annuler la correction', surclick: () => { correctionsCommandes.delete(cle); brouillonsCommandes.delete(cle); rendre(); } }));
    }
    return el('div', { classe, 'data-commande': cle },
      el('p', { classe: 'mur-rappel-titre' }, el('strong', { texte: def.titre })),
      el('p', { classe: 'mur-rappel-echeance', texte: enCorrection ? 'Corriger la réponse' : echeanceTexte }),
      ...actions);
  }

  /** Rappels hebdomadaires des commandes pharmacie et magasin (pas pour les comptes étudiants, qui ne répondent pas). */
  function blocRappelsCommandes() {
    if (App.role() === 'etudiant-iade') return null;
    const echeances = echeancesCommandes();
    if (!echeances.length) return null;
    const aTraiter = echeances.filter((e) => !e.rep).length;
    return el('section', { classe: 'mur-section mur-rappels-commandes', 'aria-label': 'Commandes' },
      el('h2', { classe: 'mur-titre-section' }, 'Commandes', aTraiter ? el('span', { classe: 'mur-compte', texte: String(aTraiter) }) : null),
      el('div', { classe: 'mur-grille' }, echeances.map(carteCommande)));
  }

  /** Maintenances à cycle fixe du matériel (suivi du matériel) à faire aujourd'hui ou en retard. Disparaissent une fois acquittées. */
  function blocRappelsMaintenance() {
    if (typeof Materiel === 'undefined' || !Materiel.rappelsMaintenance) return null;
    const rappels = Materiel.rappelsMaintenance();
    if (!rappels.length) return null;
    const dateFr = (iso) => iso.split('-').reverse().join('/');
    const nb = rappels.reduce((n, r) => n + r.ids.length, 0);
    return el('section', { classe: 'mur-section mur-rappels-maintenance', 'aria-label': 'Maintenances à faire' },
      el('h2', { classe: 'mur-titre-section' }, 'Maintenances à faire', el('span', { classe: 'mur-compte', texte: String(nb) })),
      el('div', { classe: 'mur-grille' }, rappels.map((r) => el('div', { classe: `mur-rappel${r.retard ? ' en-retard' : ''}` },
        el('p', { classe: 'mur-rappel-titre' }, el('strong', { texte: r.libelle }), ` · ${r.appareil}`),
        el('p', { classe: 'mur-rappel-appareils', texte: `N° ${r.numeros.join(', ')}` }),
        el('p', { classe: 'mur-rappel-echeance', texte: `${r.retard ? `En retard : prévue le ${dateFr(r.depuis)}` : 'À faire aujourd\'hui'} (${r.cycle})` }),
        Materiel.peutControler() ? el('button', { type: 'button', classe: 'info-bouton', texte: 'Faire la maintenance', surclick: () => Materiel.ouvrirControle(r) }) : null))));
  }

  function section(titre, infos, aujourdhui, classe = '') {
    return el('section', { classe: `mur-section ${classe}`.trim(), 'aria-label': titre },
      el('h2', { classe: 'mur-titre-section' }, titre, el('span', { classe: 'mur-compte', texte: String(infos.length) })),
      el('div', { classe: 'mur-grille' }, infos.map((i) => carte(i, aujourdhui))));
  }

  function barreFiltres(visibles, aujourdhui, portee) {
    const actives = visibles.filter((i) => statut(i, aujourdhui) !== 'terminee');
    const compte = (id) => actives.filter((i) => i.type === id).length;
    const typesPresents = mur.types.filter((t) => compte(t.id) > 0 || t.id === filtre.type);
    const bouton = (texte, actif, faire, n, picto) => el('button', {
      type: 'button', classe: `mur-filtre${actif ? ' actif' : ''}`, 'aria-pressed': String(actif), surclick: faire,
    }, picto ? icone(picto, 'mur-filtre-picto') : null, texte, n !== undefined ? el('span', { classe: 'mur-filtre-n', texte: String(n) }) : null);

    const choisirPortee = (p) => {
      filtre.portee = p;
      try { localStorage.setItem(CLE_FILTRE, JSON.stringify({ portee: p })); } catch (e) { /* sans importance */ }
      rendre();
    };
    return el('div', { classe: 'mur-filtres' },
      // Pictogramme + nombre seulement ; toucher le type actif retire le filtre.
      typesPresents.length > 1 || filtre.type ? el('div', { classe: 'mur-types', role: 'group', 'aria-label': 'Filtrer par type' },
        typesPresents.map((t) => el('button', {
          type: 'button', classe: `mur-filtre mur-filtre-icone${filtre.type === t.id ? ' actif' : ''}`, 'aria-pressed': String(filtre.type === t.id),
          'aria-label': `${t.libelle} : ${compte(t.id)}`, title: t.libelle,
          surclick: () => { filtre.type = filtre.type === t.id ? '' : t.id; rendre(); },
        }, icone(t.icone, 'mur-filtre-picto'), el('span', { classe: 'mur-filtre-n', texte: String(compte(t.id)) })))) : null);
  }

  function periode(info, aujourdhui) {
    const st = statut(info, aujourdhui);
    if (info.fin && info.fin === info.debut) return info.debut === aujourdhui ? 'Aujourd\'hui seulement' : `Le ${dateCourte(info.debut)}`;
    if (st === 'avenir') return info.fin ? `Du ${dateCourte(info.debut)} au ${dateCourte(info.fin)}` : `À partir du ${dateCourte(info.debut)}`;
    const depuis = info.debut === aujourdhui ? 'Depuis aujourd\'hui' : `Depuis le ${dateCourte(info.debut)}`;
    if (st === 'terminee') return info.terminee ? `Terminée ${relatif(info.terminee)}${info.termineePar ? ` par ${info.termineePar}` : ''}` : `Terminée le ${dateCourte(info.fin)}`;
    if (!info.fin) return `${depuis} · sans date de fin`;
    if (info.fin === aujourdhui) return `${depuis} · dernier jour aujourd'hui`;
    return `${depuis} · jusqu'au ${dateCourte(info.fin)}`;
  }

  function carte(info, aujourdhui) {
    const type = typeDe(info.type);
    const st = statut(info, aujourdhui);
    const tous = !info.destinataires || info.destinataires.length === METIERS.length;
    const enConfirmation = confirmerFin === info.id;
    const pastilles = [];
    if (info.importance === 'urgente') pastilles.push(el('span', { classe: 'info-pastille urgente', texte: 'Urgent' }));
    else if (info.importance === 'importante') pastilles.push(el('span', { classe: 'info-pastille importante', texte: 'Important' }));
    if (st === 'encours' && info.fin === aujourdhui) pastilles.push(el('span', { classe: 'info-pastille dernier-jour', texte: 'Dernier jour' }));
    if (info.suivi) pastilles.push(el('span', { classe: `info-pastille suivi-${info.suivi}`, texte: LIBELLES_SUIVI[info.suivi] }));
    if (info.enAttente || info.finEnAttente || info.suiviEnAttente) pastilles.push(el('span', { classe: 'info-pastille attente', texte: 'En attente d\'envoi' }));
    // Commentaires : pas sur une information pas encore publiée (elle n'a pas d'identifiant sur le serveur).
    const commentaires = info.enAttente ? [] : commentairesDe(info);
    const ouvert = !info.enAttente && ouverts.has(info.id);
    const n = commentaires.length;
    const nbCom = n;
    const deplie = deplies.has(info.id);
    const boutonCommentaires = info.enAttente ? null : el('button', {
      type: 'button', classe: `info-bouton info-bouton-commentaires${ouvert ? ' actif' : ''}`, 'aria-expanded': String(ouvert),
      surclick: () => {
        if (ouvert) ouverts.delete(info.id); else ouverts.add(info.id);
        rendre();
        if (!ouvert) focaliser(`[data-id="${CSS.escape(info.id)}"] .commentaire-saisie textarea`);
      },
    }, el('span', { 'aria-hidden': 'true', texte: '💬 ' }), n ? `${n} commentaire${n > 1 ? 's' : ''}` : 'Commenter');

    return el('article', {
      classe: `info info-${info.importance} info-${st}${deplie ? ' deplie' : ''}`, 'data-id': info.id, tabindex: '-1', 'aria-label': `${type.libelle} : ${info.titre}`,
    },
    // Repliée : seul le titre est visible ; un toucher déplie la carte.
    el('h3', { classe: 'info-titre' }, el('button', {
      type: 'button', classe: 'info-deplier', 'aria-expanded': String(deplie),
      surclick: () => { if (deplie) deplies.delete(info.id); else deplies.add(info.id); rendre(); },
    }, icone(type.icone), el('span', { classe: 'info-titre-texte', texte: info.titre }),
    nbCom ? el('span', { classe: 'info-nb-com', 'aria-label': `${nbCom} commentaire${nbCom > 1 ? 's' : ''}`, texte: `💬 ${nbCom}` }) : null,
    el('span', { classe: 'info-chevron', 'aria-hidden': 'true', texte: '▾' }))),
    !deplie ? null : el('div', { classe: 'info-corps' },
    el('div', { classe: 'info-haut' },
      el('span', { classe: 'info-type' }, icone(type.icone), type.libelle),
      el('span', { classe: 'info-pastilles' }, pastilles)),
    info.texte ? el('p', { classe: 'info-texte', texte: info.texte }) : null,
    affichagePieces(info.pieces),
    el('p', { classe: 'info-periode' }, icone('calendrier', 'info-mini-picto'), periode(info, aujourdhui)),
    el('p', { classe: 'info-meta' },
      `${info.auteur || ''}${info.creee ? `, ${relatif(info.creee)}` : ''}`,
      tous ? null : el('span', { classe: 'info-destinataires' }, 'Pour : ',
        info.destinataires.map((d) => (METIERS.find((m) => m.id === d) || { libelle: d }).libelle).join(', '))),
    enConfirmation
      ? el('div', { classe: 'info-confirmation', role: 'group', 'aria-label': 'Confirmer' },
        el('p', { texte: 'Clôturer cette information pour tout le monde ?' }),
        el('div', { classe: 'info-confirmation-boutons' },
          el('button', { type: 'button', classe: 'info-bouton danger', texte: 'Oui, clôturer', surclick: () => terminer(info) }),
          el('button', { type: 'button', classe: 'info-bouton', texte: 'Annuler', surclick: () => { confirmerFin = ''; rendre(); } })))
      : el('div', { classe: 'info-actions' },
        boutonCommentaires,
        boutonSuivi(info),
        st === 'terminee' ? null : el('button', {
          type: 'button', classe: 'info-bouton', surclick: () => { confirmerFin = info.id; rendre(); focaliser(`[data-id="${CSS.escape(info.id)}"] .info-confirmation .danger`); },
        }, info.enAttente ? 'Annuler la publication' : 'Clôturer')),
    ouvert ? filCommentaires(info, commentaires) : null));
  }

  /** Bouton d'étape du suivi biomédical : « Envoyé au biomédical » puis « Récupéré » (pas sur une publication en attente d'envoi). */
  function boutonSuivi(info) {
    if (info.enAttente || info.terminee || !info.materiel) return null;
    if (info.suivi === 'a-amener') {
      return el('button', {
        type: 'button', classe: 'info-bouton info-bouton-suivi',
        surclick: () => avancerSuivi(info, 'envoye', ''),
      }, el('span', { 'aria-hidden': 'true', texte: '🚚 ' }), 'Envoyé au biomédical');
    }
    if (info.suivi === 'au-biomed') {
      return el('button', {
        type: 'button', classe: 'info-bouton info-bouton-suivi',
        surclick: () => ouvrirRecuperation(info),
      }, el('span', { 'aria-hidden': 'true', texte: '✅ ' }), 'Récupéré');
    }
    return null;
  }

  /** Enregistre l'étape (file d'attente : fonctionne hors ligne) ; la main courante et le statut de l'appareil suivent. */
  function avancerSuivi(info, etape, observation) {
    const ok = App.mettreEnFile({ action: 'avancerSuiviBiomed', donnees: { id: info.id, materiel: info.materiel, etape, observation }, agent: agent() });
    avis = ok
      ? { texte: etape === 'envoye' ? 'Envoi au biomédical consigné dans la main courante de l\'appareil.' : `« ${info.titre} » est close : appareil récupéré.`, classe: 'succes' }
      : { texte: 'Impossible d\'enregistrer sur cet appareil.', classe: 'erreur' };
    rendre();
  }

  /** « Récupéré » : observation facultative, puis l'information est close. */
  function ouvrirRecuperation(info) {
    const idTitre = nouvelId();
    const idObs = nouvelId();
    const obs = el('textarea', { id: idObs, rows: '3', maxlength: '600', placeholder: 'Réparation effectuée, appareil remplacé, réserve…' });
    const formulaireRecup = el('form', {
      novalidate: true,
      sursubmit: (e) => { e.preventDefault(); fermerFenetre(); avancerSuivi(info, 'recupere', obs.value.trim()); },
    },
    el('p', { texte: 'L\'appareil repasse « En service » et l\'information est close.' }),
    el('label', { for: idObs, texte: 'Observation (facultatif)' }), obs,
    el('div', { classe: 'info-confirmation-boutons' },
      el('button', { type: 'submit', classe: 'principal', texte: 'Valider la récupération' }),
      el('button', { type: 'button', classe: 'info-bouton', texte: 'Annuler', surclick: fermerFenetre })));
    ouvrirFenetre('Appareil récupéré', idTitre, formulaireRecup);
    obs.focus();
  }

  function focaliser(selecteur) {
    const n = zone.querySelector(selecteur);
    if (n) n.focus();
  }

  function liensRapides() {
    // Liens vers les fonctionnalités connexes (règle du README : accès sans passer par le menu).
    const liens = [];
    if (App.accesVehicules ? App.accesVehicules() : App.role() !== 'iade') liens.push(['Check-list des véhicules', 'checklist-ambulancier']);
    if (App.role() !== 'ambulancier') liens.push(['Check-list des inventaires', 'inventaires']);
    if (App.aDroit('COMMUNICATION')) liens.push(['Gérer les types d\'informations', 'types-infos']);
    return el('nav', { classe: 'mur-liens', 'aria-label': 'Accès rapides' },
      liens.map(([texte, v]) => el('button', { type: 'button', classe: 'lien', texte: `${texte} →`, surclick: () => App.ouvrirVue(v) })));
  }

  // ---------- Pièces jointes (photos, documents, liens) ----------
  const PIECES_MAX = 6;
  const DOCUMENT_MAX = 2 * 1024 * 1024; // 2 Mo : la pièce attend dans la file d'attente de l'appareil si hors ligne
  const TYPES_DOCUMENTS = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    odt: 'application/vnd.oasis.opendocument.text',
    ods: 'application/vnd.oasis.opendocument.spreadsheet',
    txt: 'text/plain',
    csv: 'text/csv',
  };
  const ACCEPTE_DOCUMENTS = Object.keys(TYPES_DOCUMENTS).map((e) => `.${e}`).join(',');
  const cachePieces = new Map(); // id Drive → Promise<dataUrl> (le temps de la session)

  /** Pièce du serveur ({ t, id, nom, mime, url }) ou en attente d'envoi ({ type, nom, donnees, url, titre }). */
  const piece = (p) => ({ t: p.t || p.type, id: p.id || '', nom: p.nom || p.titre || '', url: p.url || '', donnees: p.donnees || '', mime: p.mime || '' });

  /** Photo recadrée (outil commun, une par une), réduite à 1280 px et compressée (JPEG) ; null si annulée. */
  const reduirePhoto = (fichier) => Recadrage.photo(fichier, { cote: 1280, qualites: [0.7] });

  function lireDocument(fichier) {
    const ext = (fichier.name.split('.').pop() || '').toLowerCase();
    const mime = TYPES_DOCUMENTS[ext];
    if (!mime) return Promise.reject(new Error(`« ${fichier.name} » : format non accepté (PDF, Word, Excel, PowerPoint, texte).`));
    if (fichier.size > DOCUMENT_MAX) return Promise.reject(new Error(`« ${fichier.name} » dépasse 2 Mo.`));
    return new Promise((ok, echec) => {
      const lecteur = new FileReader();
      lecteur.onload = () => ok(`data:${mime};base64,${String(lecteur.result).split(',')[1] || ''}`);
      lecteur.onerror = () => echec(new Error(`« ${fichier.name} » est illisible.`));
      lecteur.readAsDataURL(fichier);
    });
  }

  function chargerPiece(id) {
    if (!cachePieces.has(id)) {
      const p = App.appeler('pieceJointe', { id }).then((rep) => {
        if (!rep.ok) throw new Error(rep.erreur || 'Pièce jointe introuvable');
        return rep.donnees;
      });
      p.catch(() => cachePieces.delete(id)); // réessayer plus tard (hors ligne)
      cachePieces.set(id, p);
    }
    return cachePieces.get(id);
  }

  const domaine = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return url; } };

  /** Éditeur de pièces jointes : modifie le tableau `pieces` sur place. */
  function editeurPieces(pieces) {
    const liste = el('ul', { classe: 'pj-edition' });
    const erreur = el('p', { classe: 'message erreur', role: 'status' });
    const ids = { photo: nouvelId(), doc: nouvelId(), url: nouvelId(), titre: nouvelId() };
    const entreePhoto = el('input', { id: ids.photo, type: 'file', accept: 'image/*', multiple: true, classe: 'invisible' });
    const entreeDoc = el('input', { id: ids.doc, type: 'file', accept: ACCEPTE_DOCUMENTS, multiple: true, classe: 'invisible' });
    const champUrl = el('input', { id: ids.url, type: 'url', inputmode: 'url', placeholder: 'https://…', autocomplete: 'off' });
    const champTitre = el('input', { id: ids.titre, maxlength: '120', placeholder: 'Ex. : protocole sur l\'intranet', autocomplete: 'off' });
    const saisieLien = el('div', { classe: 'pj-saisie-lien', hidden: true },
      el('div', { classe: 'champ' }, el('label', { for: ids.url, texte: 'Adresse du lien' }), champUrl),
      el('div', { classe: 'champ' }, el('label', { for: ids.titre }, 'Titre ', el('small', { texte: '(facultatif)' })), champTitre),
      el('div', { classe: 'pj-saisie-boutons' },
        el('button', { type: 'button', classe: 'info-bouton', texte: 'Ajouter le lien', surclick: ajouterLien }),
        el('button', { type: 'button', classe: 'lien', texte: 'Annuler', surclick: () => { saisieLien.hidden = true; } })));
    const boutonPhoto = el('label', { for: ids.photo, classe: 'pj-ajout' }, '📷 Photo');
    const boutonDoc = el('label', { for: ids.doc, classe: 'pj-ajout' }, '📎 Document');
    const boutonLien = el('button', { type: 'button', classe: 'pj-ajout', surclick: () => { saisieLien.hidden = false; champUrl.focus(); } }, '🔗 Lien');

    const signaler = (texte) => { erreur.textContent = texte; };
    function maj() {
      liste.innerHTML = '';
      pieces.forEach((brute, i) => {
        const p = piece(brute);
        const libelle = p.t === 'lien' ? (p.nom || domaine(p.url)) : p.nom;
        liste.append(el('li', { classe: `pj-element pj-${p.t}` },
          p.t === 'photo' ? el('img', { src: p.donnees, alt: '', classe: 'pj-mini' }) : el('span', { classe: 'pj-symbole', 'aria-hidden': 'true', texte: p.t === 'lien' ? '🔗' : '📄' }),
          el('span', { classe: 'pj-nom', texte: libelle }),
          el('button', { type: 'button', classe: 'pj-retirer', 'aria-label': `Retirer ${libelle}`, texte: '✕', surclick: () => { pieces.splice(i, 1); maj(); } })));
      });
      const plein = pieces.length >= PIECES_MAX;
      [boutonPhoto, boutonDoc, boutonLien].forEach((b) => b.classList.toggle('desactive', plein));
      entreePhoto.disabled = plein; entreeDoc.disabled = plein; boutonLien.disabled = plein;
    }
    function place(n) {
      if (pieces.length + n > PIECES_MAX) { signaler(`Pas plus de ${PIECES_MAX} pièces jointes.`); return false; }
      return true;
    }
    async function ajouterFichiers(entree, lire, type) {
      signaler('');
      const fichiers = [...entree.files];
      entree.value = '';
      if (!place(fichiers.length)) return;
      for (const f of fichiers) {
        try {
          const donnees = await lire(f);
          if (donnees) pieces.push({ type, nom: f.name.slice(0, 80), donnees });
        } catch (e) {
          signaler(e.message === 'image' ? `« ${f.name} » n'est pas une image lisible.` : e.message);
        }
      }
      maj();
    }
    function ajouterLien() {
      signaler('');
      let url = champUrl.value.trim();
      if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
      let valide = false;
      try { valide = /^https?:$/.test(new URL(url).protocol) && url.length <= 500; } catch (e) { /* invalide */ }
      if (!valide) { signaler('Adresse de lien invalide.'); champUrl.focus(); return; }
      if (!place(1)) return;
      pieces.push({ type: 'lien', url, titre: champTitre.value.replace(/\s+/g, ' ').trim() });
      champUrl.value = ''; champTitre.value = '';
      saisieLien.hidden = true;
      maj();
    }
    // Entrée dans le champ du lien : ajoute le lien au lieu d'envoyer le formulaire.
    [champUrl, champTitre].forEach((c) => c.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ajouterLien(); } }));
    entreePhoto.addEventListener('change', () => ajouterFichiers(entreePhoto, reduirePhoto, 'photo'));
    entreeDoc.addEventListener('change', () => ajouterFichiers(entreeDoc, lireDocument, 'document'));
    maj();
    return el('div', { classe: 'pj-editeur' },
      el('div', { classe: 'pj-boutons' }, boutonPhoto, entreePhoto, boutonDoc, entreeDoc, boutonLien),
      saisieLien, liste, erreur);
  }

  /** Affichage des pièces jointes d'une information ou d'un commentaire. */
  function affichagePieces(liste) {
    if (!liste || !liste.length) return null;
    const pieces = liste.map(piece);
    const photos = pieces.filter((p) => p.t === 'photo');
    const autres = pieces.filter((p) => p.t !== 'photo');
    return el('div', { classe: 'pj-affichage' },
      photos.length ? el('div', { classe: 'pj-vignettes' }, photos.map(vignette)) : null,
      autres.length ? el('ul', { classe: 'pj-fichiers' }, autres.map((p) => el('li', {}, p.t === 'lien'
        ? el('a', { classe: 'pj-puce', href: p.url, target: '_blank', rel: 'noopener noreferrer' },
          el('span', { 'aria-hidden': 'true', texte: '🔗' }), el('span', { classe: 'pj-nom', texte: p.nom || domaine(p.url) }))
        : boutonDocument(p)))) : null);
  }

  function vignette(p) {
    const img = el('img', { alt: p.nom || 'Photo jointe', classe: 'pj-vignette-img', loading: 'lazy' });
    const bouton = el('button', { type: 'button', classe: 'pj-vignette chargement', 'aria-label': `Agrandir la photo ${p.nom}`.trim() }, img);
    const afficher = (src) => { img.src = src; bouton.classList.remove('chargement'); };
    if (p.donnees) afficher(p.donnees);
    else if (p.id) chargerPiece(p.id).then(afficher).catch(() => { bouton.classList.replace('chargement', 'indisponible'); bouton.title = 'Photo indisponible hors ligne'; });
    bouton.addEventListener('click', () => {
      if (!img.getAttribute('src')) return;
      const idT = nouvelId();
      ouvrirFenetre(p.nom || 'Photo', idT, el('img', { classe: 'pj-grande', src: img.src, alt: p.nom || 'Photo jointe' }));
    });
    return bouton;
  }

  function boutonDocument(p) {
    const bouton = el('button', { type: 'button', classe: 'pj-puce' },
      el('span', { 'aria-hidden': 'true', texte: '📄' }), el('span', { classe: 'pj-nom', texte: p.nom || 'Document' }));
    bouton.addEventListener('click', async () => {
      bouton.disabled = true;
      bouton.classList.add('chargement');
      try {
        const donnees = p.donnees || await chargerPiece(p.id);
        const blob = await (await fetch(donnees)).blob();
        const url = URL.createObjectURL(blob);
        const a = el('a', { href: url, download: p.nom || 'document' });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      } catch (e) {
        avis = { texte: `Impossible d'ouvrir « ${p.nom} » (pas de réseau ?).`, classe: 'erreur' };
        rendre();
        return;
      }
      bouton.disabled = false;
      bouton.classList.remove('chargement');
    });
    return bouton;
  }

  // ---------- Commentaires ----------
  const deplies = new Set(); // cartes dépliées (repliées par défaut : titre seul)
  const ouverts = new Set(); // informations dont le fil de commentaires est déplié
  const brouillons = new Map(); // id d'information → { texte, pieces } (garde la saisie entre deux affichages)
  const brouillon = (id) => { if (!brouillons.has(id)) brouillons.set(id, { texte: '', pieces: [] }); return brouillons.get(id); };

  /** Commentaires reçus du serveur + ceux qui attendent dans la file d'attente de cet appareil. */
  function commentairesDe(info) {
    const file = App.fileAttente();
    const retires = new Set(file.filter((e) => e.action === 'supprimerCommentaire').map((e) => e.donnees.id));
    const locaux = file.filter((e) => e.action === 'commenterInfo' && e.donnees.info === info.id).map((e) => ({
      ...e.donnees, id: `local-${e.id}`, idFile: e.id, auteur: e.agent || agent(), creee: e.date, enAttente: true,
    }));
    return (info.commentaires || []).filter((c) => !retires.has(c.id)).concat(locaux);
  }

  function filCommentaires(info, commentaires) {
    const b = brouillon(info.id);
    const idTexte = nouvelId();
    const admin = App.aDroit('COMMUNICATION'); // retrait des commentaires des autres
    const zoneTexte = el('textarea', {
      id: idTexte, rows: '2', maxlength: '1000', placeholder: 'Votre commentaire…', valeur: b.texte,
      surinput: (e) => { b.texte = e.target.value; },
    });
    return el('div', { classe: 'info-fil' },
      commentaires.length ? el('ul', { classe: 'commentaires' }, commentaires.map((c) => el('li', { classe: `commentaire${c.enAttente ? ' attente' : ''}` },
        el('p', { classe: 'commentaire-meta' },
          el('strong', { texte: c.auteur || '' }), c.creee ? ` · ${relatif(c.creee)}` : '',
          c.enAttente ? el('span', { classe: 'info-pastille attente', texte: 'En attente d\'envoi' }) : null,
          c.auteur === agent() || admin
            ? el('button', { type: 'button', classe: 'lien commentaire-retirer', texte: 'Retirer', surclick: () => retirerCommentaire(c) }) : null),
        c.texte ? el('p', { classe: 'commentaire-texte', texte: c.texte }) : null,
        affichagePieces(c.pieces)))) : el('p', { classe: 'info-note', texte: 'Aucun commentaire pour l\'instant.' }),
      el('form', { classe: 'commentaire-saisie', novalidate: true, sursubmit: (e) => { e.preventDefault(); envoyerCommentaire(info); } },
        el('label', { for: idTexte, classe: 'invisible', texte: 'Commentaire' }),
        zoneTexte,
        editeurPieces(b.pieces),
        el('button', { type: 'submit', classe: 'info-bouton envoyer', texte: 'Envoyer' })));
  }

  function envoyerCommentaire(info) {
    const b = brouillon(info.id);
    const texte = b.texte.trim();
    if (!texte && !b.pieces.length) { focaliser(`[data-id="${CSS.escape(info.id)}"] .commentaire-saisie textarea`); return; }
    const ok = App.mettreEnFile({ action: 'commenterInfo', donnees: { info: info.id, texte, pieces: b.pieces }, agent: agent() });
    if (!ok) {
      avis = { texte: 'Impossible d\'enregistrer sur cet appareil (mémoire pleine : pièces jointes trop lourdes ?).', classe: 'erreur' };
      rendre();
      return;
    }
    brouillons.delete(info.id);
    avis = navigator.onLine ? { texte: '', classe: '' } : { texte: 'Commentaire enregistré sur cet appareil : il sera envoyé au retour du réseau.', classe: 'succes' };
    rendre();
  }

  function retirerCommentaire(c) {
    if (c.enAttente) App.retirerDeFile(c.idFile);
    else App.mettreEnFile({ action: 'supprimerCommentaire', donnees: { id: c.id }, agent: agent() });
    rendre();
  }

  /** Une saisie est en cours sur le mur : ne pas tout redessiner sous les doigts de l'agent. */
  const saisieEnCours = () => zone && zone.contains(document.activeElement) && /^(TEXTAREA|INPUT)$/.test(document.activeElement.tagName);

  // ---------- Fin d'une information ----------
  function terminer(info) {
    confirmerFin = '';
    if (info.enAttente) {
      // Pas encore envoyée : on la retire simplement de la file d'attente.
      App.retirerDeFile(info.idFile);
      avis = { texte: 'Publication annulée.', classe: 'succes' };
      rendre();
      return;
    }
    const ok = App.mettreEnFile({ action: 'terminerInfo', donnees: { id: info.id }, agent: agent() });
    avis = ok ? { texte: `« ${info.titre} » est terminée.`, classe: 'succes' } : { texte: 'Impossible d\'enregistrer sur cet appareil.', classe: 'erreur' };
    rendre();
  }

  // ---------- Publication ----------
  /**
   * Formulaire de publication. `prerempli` (facultatif, depuis un autre module) :
   * { types: [ids de type préférés, dans l'ordre], importance, titre, texte, pieces, surPublie() }.
   */
  function formulaire(prerempli = {}) {
    const actifs = typesActifs();
    const ids = { titre: nouvelId(), texte: nouvelId(), debut: nouvelId(), fin: nouvelId(), titreFen: nouvelId() };
    let typeChoisi = '';
    let importanceManuelle = false;

    const radioType = actifs.map((t) => el('label', { classe: 'choix-type' },
      el('input', { type: 'radio', name: 'info-type', value: t.id, required: true }),
      el('span', {}, icone(t.icone), t.libelle)));
    const radioImportance = IMPORTANCES.map((imp) => el('label', { classe: `choix-importance ${imp.id}` },
      el('input', { type: 'radio', name: 'info-importance', value: imp.id, checked: imp.id === 'normale' }),
      el('span', { texte: imp.libelle })));
    const casesDest = METIERS.map((m) => el('label', { classe: 'choix-dest' },
      el('input', { type: 'checkbox', name: 'info-dest', value: m.id, checked: true }), el('span', { texte: m.libelle })));
    const champDebut = el('input', { id: ids.debut, type: 'date', valeur: jour(), required: true });
    const champFin = el('input', { id: ids.fin, type: 'date', min: jour() });
    const noteNotif = el('p', { classe: 'info-note' });
    const message = el('p', { classe: 'message', role: 'status' });
    const pieces = (prerempli.pieces || []).slice(); // ex. photo d'un signalement de matériel

    const majNote = () => {
      const debut = champDebut.value || jour();
      champFin.min = debut;
      noteNotif.textContent = debut > jour()
        ? `Rappel : notification envoyée aux destinataires le ${dateCourte(debut)} vers 7 h.`
        : 'Une notification est envoyée tout de suite aux destinataires.';
    };
    const raccourci = (texte, faire) => el('button', { type: 'button', classe: 'raccourci-date', texte, surclick: () => { faire(); majNote(); } });

    const formulaireEl = el('form', { classe: 'formulaire formulaire-info', novalidate: true },
      el('fieldset', { classe: 'question' }, el('legend', { texte: 'Type' }), el('div', { classe: 'choix-types' }, radioType)),
      el('fieldset', { classe: 'question' }, el('legend', { texte: 'Importance' }), el('div', { classe: 'choix-importances' }, radioImportance)),
      el('div', { classe: 'champ' }, el('label', { for: ids.titre, texte: 'Titre' }),
        el('input', { id: ids.titre, maxlength: '120', required: true, placeholder: 'Ex. : F22 au garage jusqu\'à jeudi', autocomplete: 'off' })),
      el('div', { classe: 'champ' }, el('label', { for: ids.texte }, 'Détails ', el('small', { texte: '(facultatif)' })),
        el('textarea', { id: ids.texte, maxlength: '1500', rows: '3' })),
      el('fieldset', { classe: 'question' }, el('legend', {}, 'Photos, documents, liens ', el('small', { texte: '(facultatif)' })), editeurPieces(pieces)),
      el('div', { classe: 'dates-info' },
        el('div', { classe: 'champ' }, el('label', { for: ids.debut, texte: 'Début' }), champDebut),
        el('div', { classe: 'champ' }, el('label', { for: ids.fin }, 'Fin ', el('small', { texte: '(facultatif)' })), champFin)),
      el('div', { classe: 'raccourcis-dates' },
        raccourci('Aujourd\'hui seulement', () => { champDebut.value = jour(); champFin.value = jour(); }),
        raccourci('Une semaine', () => { const d = dateLocale(champDebut.value || jour()); d.setDate(d.getDate() + 6); champFin.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }),
        raccourci('Sans date de fin', () => { champFin.value = ''; })),
      el('fieldset', { classe: 'question' }, el('legend', { texte: 'Destinataires' }), el('div', { classe: 'choix-dests' }, casesDest)),
      noteNotif,
      el('button', { type: 'submit', classe: 'principal', texte: 'Publier' }),
      message);

    formulaireEl.addEventListener('change', (e) => {
      if (e.target.name === 'info-type') {
        typeChoisi = e.target.value;
        // L'importance suit le type tant que l'agent ne l'a pas changée lui-même.
        if (!importanceManuelle) {
          const imp = typeDe(typeChoisi).importance || 'normale';
          formulaireEl.querySelector(`input[name="info-importance"][value="${imp}"]`).checked = true;
        }
      }
      if (e.target.name === 'info-importance') importanceManuelle = true;
      if (e.target === champDebut) majNote();
    });

    formulaireEl.addEventListener('submit', (e) => {
      e.preventDefault();
      const titre = formulaireEl.querySelector(`#${ids.titre}`).value.replace(/\s+/g, ' ').trim();
      const destinataires = [...formulaireEl.querySelectorAll('input[name="info-dest"]:checked')].map((c) => c.value);
      const debut = champDebut.value || jour();
      const fin = champFin.value;
      const erreurs = [];
      if (!typeChoisi) erreurs.push('choisissez un type');
      if (!titre) erreurs.push('donnez un titre');
      if (!destinataires.length) erreurs.push('choisissez au moins un destinataire');
      if (fin && fin < debut) erreurs.push('la fin est avant le début');
      if (erreurs.length) {
        message.textContent = `À compléter : ${erreurs.join(', ')}.`;
        message.className = 'message erreur';
        return;
      }
      const donnees = {
        type: typeChoisi,
        importance: formulaireEl.querySelector('input[name="info-importance"]:checked').value,
        titre,
        texte: formulaireEl.querySelector(`#${ids.texte}`).value.trim(),
        debut,
        fin,
        destinataires,
        pieces,
      };
      // Information d'un appareil en panne (depuis le suivi du matériel) : suivi du biomédical dans l'information.
      if (prerempli.materiel) { donnees.materiel = prerempli.materiel; donnees.suivi = prerempli.suivi === true; }
      const ok = App.mettreEnFile({ action: 'creerInfo', donnees, agent: agent() });
      if (!ok) {
        message.textContent = 'Impossible d\'enregistrer sur cet appareil (mémoire pleine : pièces jointes trop lourdes ?).';
        message.className = 'message erreur';
        return;
      }
      fermerFenetre();
      if (prerempli.surPublie) { prerempli.surPublie(); return; }
      filtre.type = '';
      avis = { texte: navigator.onLine ? 'Information publiée.' : 'Information enregistrée sur cet appareil : elle sera publiée au retour du réseau.', classe: 'succes' };
      rendre();
    });

    majNote();
    ouvrirFenetre('Nouvelle information', ids.titreFen, formulaireEl);
    // Pré-remplissage : type (le premier disponible parmi ceux proposés), importance, titre, détails.
    const typePrefere = (prerempli.types || []).find((id) => actifs.some((t) => t.id === id));
    if (typePrefere) {
      const radio = formulaireEl.querySelector(`input[name="info-type"][value="${typePrefere}"]`);
      radio.checked = true;
      radio.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (prerempli.importance) {
      const imp = formulaireEl.querySelector(`input[name="info-importance"][value="${prerempli.importance}"]`);
      if (imp) imp.checked = true;
    }
    if (prerempli.titre) formulaireEl.querySelector(`#${ids.titre}`).value = prerempli.titre.slice(0, 120);
    if (prerempli.texte) {
      const zoneTexte = formulaireEl.querySelector(`#${ids.texte}`);
      zoneTexte.value = prerempli.texte;
      // Le curseur à la fin des détails : l'agent ajoute son commentaire.
      zoneTexte.focus();
      zoneTexte.setSelectionRange(zoneTexte.value.length, zoneTexte.value.length);
    }
  }

  // Fenêtre (mêmes classes que les fenêtres d'actions des véhicules).
  let fond = null;
  let retourFocus = null;
  function ouvrirFenetre(titre, idTitre, ...contenu) {
    fermerFenetre();
    retourFocus = document.activeElement;
    fond = el('div', { classe: 'fenetre-fond', surclick: (e) => { if (e.target === fond) fermerFenetre(); } });
    fond.addEventListener('keydown', (e) => { if (e.key === 'Escape') fermerFenetre(); });
    const panneau = el('div', { classe: 'fenetre fenetre-info', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': idTitre },
      el('div', { classe: 'fenetre-entete' }, el('h2', { id: idTitre, texte: titre }),
        el('button', { type: 'button', classe: 'fenetre-fermer', 'aria-label': 'Fermer', texte: '✕', surclick: fermerFenetre })),
      el('div', { classe: 'fenetre-corps' }, ...contenu));
    fond.append(panneau);
    document.body.append(fond);
    document.body.classList.add('fenetre-ouverte');
    const premier = panneau.querySelector('.fenetre-corps input');
    (premier || panneau.querySelector('.fenetre-fermer')).focus();
  }
  function fermerFenetre() {
    if (!fond) return;
    fond.remove();
    fond = null;
    document.body.classList.remove('fenetre-ouverte');
    if (retourFocus && document.contains(retourFocus)) retourFocus.focus();
  }

  // ---------- Notifications push ----------
  const pushPossible = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const iosHorsAppli = () => /iPhone|iPad|iPod/.test(navigator.userAgent)
    && !(window.matchMedia('(display-mode: standalone)').matches || navigator.standalone);
  let etatPush = ''; // '', 'actif', 'erreur'

  function blocNotifications() {
    if (iosHorsAppli()) {
      return el('div', { classe: 'mur-notif' }, icone('telephone', 'mur-notif-picto'),
        el('p', {}, el('strong', { texte: 'Notifications sur iPhone' }), ' Installez d\'abord l\'appli : bouton Partager, puis « Sur l\'écran d\'accueil ». Ouvrez-la depuis l\'écran d\'accueil pour activer les alertes.'));
    }
    if (!pushPossible()) return null;
    if (Notification.permission === 'granted') {
      if (pushCoupe()) return null; // choix de l'agent (Mon compte) : pas de relance sur le mur
      return etatPush === 'erreur'
        ? el('div', { classe: 'mur-notif' }, icone('accident', 'mur-notif-picto'),
          el('p', {}, el('strong', { texte: 'Notifications non activées.' }), ' Le serveur n\'a pas pu enregistrer cet appareil.'),
          el('button', { type: 'button', classe: 'info-bouton', texte: 'Réessayer', surclick: () => abonner(true) }))
        : null;
    }
    if (Notification.permission === 'denied') {
      return el('div', { classe: 'mur-notif discret' }, icone('info', 'mur-notif-picto'),
        el('p', { texte: 'Les notifications sont bloquées pour MySMUR sur cet appareil. Pour les recevoir, autorisez-les dans les réglages du navigateur (cadenas à côté de l\'adresse, ou Réglages > Notifications).' }));
    }
    return el('div', { classe: 'mur-notif' }, icone('telephone', 'mur-notif-picto'),
      el('p', {}, el('strong', { texte: 'Recevez les alertes sur cet appareil' }), ' Une notification à chaque nouvelle information qui vous concerne.'),
      el('button', { type: 'button', classe: 'principal mur-notif-bouton', texte: 'Activer', surclick: activer }));
  }

  async function activer() {
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') { rendre(); return; }
      await abonner(true);
    } catch (err) {
      etatPush = 'erreur';
    }
    rendre();
  }

  function cleVersOctets(b64) {
    const t = b64.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }

  /** Abonne cet appareil (ou rafraîchit son abonnement) et le transmet au serveur. Silencieux hors ligne. */
  // Notifications désactivées par l'agent dans « Mon compte » : pas de réabonnement silencieux à la connexion.
  const CLE_PUSH_COUPE = 'avismur_push_desactive';
  const pushCoupe = () => { try { return localStorage.getItem(CLE_PUSH_COUPE) === '1'; } catch (e) { return false; } };
  function couperPush(oui) {
    try { if (oui) localStorage.setItem(CLE_PUSH_COUPE, '1'); else localStorage.removeItem(CLE_PUSH_COUPE); } catch (e) { /* rien */ }
  }

  async function abonner(forcer = false) {
    if (!pushPossible() || Notification.permission !== 'granted') return;
    if (forcer) couperPush(false);
    else if (pushCoupe()) return;
    try {
      const enregistrement = await navigator.serviceWorker.ready;
      let cle = localStorage.getItem(CLE_PUSH);
      try {
        const rep = await App.appeler('clePush');
        if (rep.ok && rep.cle) cle = rep.cle;
        else if (/Action inconnue/.test(rep.erreur || '')) return; // backend pas encore mis à jour
      } catch (e) { if (!cle) return; /* hors ligne */ }
      let abonnement = await enregistrement.pushManager.getSubscription();
      const ancienne = localStorage.getItem(CLE_PUSH);
      if (abonnement && ancienne && ancienne !== cle) { // clés du serveur changées : nouvel abonnement
        await abonnement.unsubscribe();
        abonnement = null;
      }
      if (!abonnement) {
        abonnement = await enregistrement.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: cleVersOctets(cle) });
      }
      localStorage.setItem(CLE_PUSH, cle);
      const rep = await App.appeler('abonnerPush', { abonnement: abonnement.toJSON(), appareil: descriptionAppareil() });
      etatPush = rep.ok ? 'actif' : 'erreur';
    } catch (err) {
      if (forcer) etatPush = 'erreur';
    }
    if (estVisible()) rendre();
  }

  function descriptionAppareil() {
    const ua = navigator.userAgent;
    const systeme = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : 'Autre';
    const nav = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
    return `${systeme} ${nav}`.trim();
  }

  /** À la déconnexion : cet appareil ne doit plus recevoir les notifications de l'agent. */
  async function desabonner() {
    if (!pushPossible()) return;
    try {
      const enregistrement = await navigator.serviceWorker.getRegistration();
      const abonnement = enregistrement && await enregistrement.pushManager.getSubscription();
      if (!abonnement) return;
      try { await App.appeler('desabonnerPush', { adresse: abonnement.endpoint }); } catch (e) { /* hors ligne */ }
      await abonnement.unsubscribe();
    } catch (err) { /* sans conséquence */ }
  }

  // ---------- Administration : types d'informations ----------
  function rendreTypes() {
    if (!brouillonTypes) brouillonTypes = mur.types.map((t) => ({ ...t }));
    const message = el('p', { classe: 'message', role: 'status' });
    const lignes = brouillonTypes.map((t, i) => {
      const idLibelle = nouvelId();
      const choixIcone = el('details', { classe: 'choix-icone' },
        el('summary', { 'aria-label': `Pictogramme : ${(ICONES[t.icone] || ICONES.info).nom}` }, icone(t.icone)),
        el('div', { classe: 'choix-icone-grille' }, Object.keys(ICONES).map((nom) => el('button', {
          type: 'button', classe: `choix-icone-bouton${nom === t.icone ? ' actif' : ''}`, title: ICONES[nom].nom, 'aria-label': ICONES[nom].nom,
          surclick: () => { t.icone = nom; rendreTypes(); },
        }, icone(nom)))));
      // Deux lignes : pictogramme et nom ; puis importance par défaut, ordre et archivage.
      return el('li', { classe: `type-ligne${t.archive ? ' archive' : ''}` },
        choixIcone,
        el('div', { classe: 'type-champs' },
          el('label', { for: idLibelle, classe: 'invisible', texte: 'Nom du type' }),
          el('input', { id: idLibelle, valeur: t.libelle, maxlength: '40', placeholder: 'Nom du type', surinput: (e) => { t.libelle = e.target.value; } })),
        el('div', { classe: 'type-bas' },
          el('select', { classe: `type-importance-choix importance-${t.importance}`, 'aria-label': `Importance proposée par défaut pour ${t.libelle}`, title: 'Importance proposée par défaut à la publication',
            surchange: (e) => { t.importance = e.target.value; e.target.className = `type-importance-choix importance-${t.importance}`; } },
            IMPORTANCES.map((imp) => el('option', { value: imp.id, selected: imp.id === t.importance, texte: imp.libelle }))),
          el('span', { classe: 'type-boutons' },
            el('button', { type: 'button', classe: 'info-bouton', 'aria-label': `Monter ${t.libelle}`, disabled: i === 0, texte: '↑', surclick: () => { [brouillonTypes[i - 1], brouillonTypes[i]] = [brouillonTypes[i], brouillonTypes[i - 1]]; rendreTypes(); } }),
            el('button', { type: 'button', classe: 'info-bouton', 'aria-label': `Descendre ${t.libelle}`, disabled: i === brouillonTypes.length - 1, texte: '↓', surclick: () => { [brouillonTypes[i + 1], brouillonTypes[i]] = [brouillonTypes[i], brouillonTypes[i + 1]]; rendreTypes(); } }),
            el('button', { type: 'button', classe: 'info-bouton', texte: t.archive ? 'Réactiver' : 'Archiver', surclick: () => { t.archive = !t.archive; rendreTypes(); } }))));
    });

    zone.innerHTML = '';
    zone.append(
      el('button', { type: 'button', classe: 'lien', texte: '← Retour aux informations', surclick: () => App.ouvrirVue('accueil') }),
      el('h1', { texte: 'Types d\'informations' }),
      el('p', { classe: 'aide-question', texte: 'Ordre d\'affichage, pictogramme, nom et importance proposée par défaut à la publication. Un type déjà utilisé ne se supprime pas : archivez-le, il ne sera plus proposé.' }),
      el('ul', { classe: 'types-liste' }, lignes),
      el('button', { type: 'button', classe: 'lien', texte: '+ Ajouter un type', surclick: () => { brouillonTypes.push({ id: '', libelle: '', icone: 'info', importance: 'normale', archive: false }); rendreTypes(); focaliser('.types-liste li:last-child input'); } }),
      el('div', { classe: 'types-enregistrer' },
        el('button', {
          type: 'button', classe: 'principal', texte: 'Enregistrer les types',
          surclick: async (e) => {
            const bouton = e.currentTarget;
            const types = brouillonTypes.filter((t) => t.id || t.libelle.trim());
            if (types.some((t) => !t.libelle.trim())) { message.textContent = 'Chaque type doit avoir un nom.'; message.className = 'message erreur'; return; }
            bouton.disabled = true;
            message.textContent = 'Enregistrement…';
            message.className = 'message';
            try {
              const rep = await App.appeler('enregistrerTypesInfos', { types });
              if (rep.ok) {
                mur.types = rep.types;
                try { localStorage.setItem(CLE_MUR, JSON.stringify(mur)); } catch (err) { /* stockage plein */ }
                brouillonTypes = null;
                rendreTypes();
                const m = zone.querySelector('.types-enregistrer .message');
                m.textContent = 'Types enregistrés.';
                m.className = 'message succes';
                return;
              }
              message.textContent = rep.erreur || 'Refusé par le serveur.';
              message.className = 'message erreur';
            } catch (err) {
              message.textContent = 'Pas de réseau : les types se modifient en ligne.';
              message.className = 'message erreur';
            }
            bouton.disabled = false;
          },
        }),
        message));
  }

  // ---------- API ----------
  return {
    /** Publication depuis un autre module (ex. contenant mobile à retrouver) : formulaire pré-rempli. */
    publier(prerempli) { formulaire(prerempli); },
    /** Nombre d'informations non lues (clochette) ; relit le mur en ligne. */
    nonLues,
    ouvrirNotifications,
    actualiserCompteur() { signalerCompteur(); return charger(); },
    initialiser(fonctions) {
      App = fonctions;
      zone = document.getElementById('zone-infos');
      lireCache();
    },
    /** Ouvre le mur (vue « accueil ») ; idCible : information à mettre en évidence. */
    afficher(idCible) {
      vue = 'mur';
      if (idCible) cible = idCible;
      zone.hidden = false;
      rendre();
      marquerVues();
      charger();
    },
    afficherTypes() {
      vue = 'types';
      brouillonTypes = null;
      zone.hidden = false;
      rendre();
      charger();
    },
    masquer() {
      if (!zone) return;
      zone.hidden = true;
      avis = { texte: '', classe: '' };
      confirmerFin = '';
      fermerFenetre();
    },
    /** Après connexion : abonnement push silencieux si l'agent l'a déjà accepté sur cet appareil. */
    demarrer() {
      lireCache();
      document.addEventListener('avismur-materiel', () => { if (estVisible() && !saisieEnCours()) rendre(); });
      abonner();
      signalerCompteur();
    },
    /** Après un envoi de la file d'attente : relire le mur. */
    surEnvoi() {
      if (estVisible()) rendre();
      charger();
    },
    desabonner,
    // « Mon compte » (profil.js) : état et réglage des notifications de cet appareil.
    /** 'ios' (installer l'appli d'abord), 'impossible', 'bloque', 'actif', 'erreur' ou 'inactif'. */
    async etatNotifications() {
      if (iosHorsAppli()) return 'ios';
      if (!pushPossible()) return 'impossible';
      if (Notification.permission === 'denied') return 'bloque';
      if (Notification.permission !== 'granted') return 'inactif';
      try {
        const enregistrement = await navigator.serviceWorker.getRegistration();
        const abonnement = enregistrement && await enregistrement.pushManager.getSubscription();
        if (!abonnement) return etatPush === 'erreur' ? 'erreur' : 'inactif';
      } catch (e) { return 'inactif'; }
      return etatPush === 'erreur' ? 'erreur' : 'actif';
    },
    /** Demande l'autorisation puis abonne cet appareil ; renvoie le nouvel état. */
    async activerNotifications() {
      try {
        const permission = await Notification.requestPermission();
        if (permission === 'granted') await abonner(true);
      } catch (err) { etatPush = 'erreur'; }
      return this.etatNotifications();
    },
    /** « Désactiver » dans Mon compte : désabonne cet appareil et s'en souvient. */
    async desactiverNotifications() {
      couperPush(true);
      etatPush = '';
      await desabonner();
    },
    /** Fin de l'adresse d'abonnement de cet appareil (pour le reconnaître dans la liste du serveur). */
    async finAbonnement() {
      try {
        const enregistrement = await navigator.serviceWorker.getRegistration();
        const abonnement = enregistrement && await enregistrement.pushManager.getSubscription();
        return abonnement ? abonnement.endpoint.slice(-24) : '';
      } catch (e) { return ''; }
    },
    /** Vider l'affichage (déconnexion) : le prochain agent ne voit pas l'ancien filtre. */
    oublier() {
      mur = { aujourdhui: '', metier: '', types: TYPES_DEFAUT, infos: [], recu: '' };
      filtre = { portee: '', type: '' };
      etatPush = '';
      ouverts.clear();
      deplies.clear();
      brouillons.clear();
      brouillonsCommandes.clear();
      correctionsCommandes.clear();
      cachePieces.clear();
      try { localStorage.removeItem(CLE_MUR); localStorage.removeItem(CLE_FILTRE); } catch (e) { /* rien */ }
    },
  };
})();
