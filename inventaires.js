/*
 * Inventaires emboîtés (IADE) : sac > sacoche > pochette…
 *
 * Chaque « contenant » a un nom, une photo, des points placés sur la photo (chaque point mène
 * à un sous-inventaire) et une liste d'articles à cocher, avec ou sans date de péremption.
 * Un contenant s'ouvre directement par le lien « …/#inv=<id> » : c'est ce lien que portent
 * son QR code et sa puce NFC.
 *
 * Hors ligne :
 *   - la structure et le dernier état connu sont gardés sur l'appareil (localStorage) ;
 *   - les photos sont gardées dans IndexedDB (base « avismur », magasin « photos ») ;
 *   - une vérification validée passe par la file d'attente de app.js (action « verifierInventaire ») ;
 *   - les modifications d'un administrateur sont gardées sur l'appareil puis envoyées au retour du réseau.
 *
 * Seuls les administrateurs créent et modifient les inventaires : menu > Administration > Gestion des inventaires.
 * Backend : Inventaires.gs (dépôt AVISMUR-backend).
 */
const Inventaires = (() => {
  const CLE_STRUCTURE = 'avismur_inv_structure';
  const CLE_ETAT = 'avismur_inv_etat';
  const CLE_BROUILLONS = 'avismur_inv_brouillons';
  const CLE_MODIFS = 'avismur_inv_modifs';
  const ID = /^[a-z0-9]{6,16}$/;
  // Version attendue de Inventaires.gs (VERSION_INVENTAIRES) : en dessous, des champs récents
  // (catégorie, vues, inventaires types, désaffectation…) seraient perdus à l'enregistrement.
  const VERSION_SERVEUR = 33;
  let versionServeur = null;
  const PHOTO_MAX = 1500000; // caractères base64 acceptés par le serveur

  let App = null; // fonctions de app.js (appeler, mettreEnFile, role, agent, fileAttente)
  let zone = null;
  let structure = { contenants: {}, catalogue: {}, reglages: { alerteJours: 30 } };
  let etat = { verifs: {}, peremptions: {}, dernierOui: {} };
  let brouillons = { jour: '', liste: {} };
  let modifs = { ids: {}, fiches: {}, reglages: false }; // contenants et fiches modifiés sur l'appareil, pas encore envoyés
  let rattacher = ''; // article sans fiche que l'on rattache à la base des articles
  let rechercheAjout = ''; // recherche en cours dans « Ajouter un article »
  let toutAfficherAjout = false; // tous les résultats de cette recherche affichés, sans limite
  let creation = null; // fiche en cours de création ({ denomination, … }) depuis « Ajouter un article »
  let filtreVehicule = ''; // gestion : inventaires types immobiles filtrés par véhicule ('' = tous, '-' = sans véhicule précisé, sinon id du contenant primaire)
  let ajoutSousOuvert = false; // formulaire « Ajouter un sous-inventaire » déplié (mode Modifier)
  let ajoutRacineOuvert = false; // gestion : formulaire « Nouveau contenant » de la page d'accueil déplié
  let ongletGestion = 'contenu'; // gestion d'un contenant : onglet affiché (contenu, reglages, etiquette, exemplaires)
  const optionsOuvertes = new Set(); // gestion : sous-inventaires dont les options sont dépliées
  let ongletDemande = ''; // gestion : onglet à ouvrir sur le prochain contenant affiché (sinon « Contenu »)
  let baseOuverte = ''; // fiche dépliée dans la base des articles ('nouvelle' : création)
  let fusion = null; // fusion de doublons en cours dans la base : { source, cible, texte }
  let baseFiltre = { texte: '', categorie: '', archives: false, sansPhoto: false };
  // Base des articles : nombre d'articles affichés (par paliers, « Afficher la suite ») et clé de recherche qui le réinitialise.
  let baseNbAffiches = 0, baseCleAffichage = '';
  let baseFiltresOuverts = false; // base des articles : panneau « Filtres » déplié
  const brouillonsBase = new Map(); // tableau de la base (ordinateur) : fiches modifiées, pas encore enregistrées
  let edition = false;
  let gestion = false;
  let dispositionTb = false; // tableau de bord : mode « Disposer » (place et largeur des sous-inventaires de niveau 1)
  // Identification d'un contenant mobile (check-list) : '<id>' (mobile prévu à cette place),
  // 'dans:<id>' (« un contenant mobile se trouve ici »), 'emp:<id>' (emplacement attendant un type de contenant).
  let identification = '';
  let typeChoisi = ''; // emplacement à plusieurs inventaires types : modèle choisi sur photo
  let familleChoisie = ''; // famille de modèles ouverte (ex. « Tempus Pro ») : on choisit ensuite la configuration
  let autoIdentifie = ''; // emplacement dont l'exemplaire unique a déjà été pris d'office (évite de boucler)
  let typePropose = ''; // emplacement dont le premier modèle a déjà été proposé (pour ne pas le reproposer)
  let placement = ''; // sous-inventaire dont on place le point sur la photo
  let avis = ''; // message affiché une fois en haut de la vue
  let supprimesServeur = []; // contenants supprimés connus du serveur (restaurables)
  let confirmer = ''; // action en attente d'une deuxième pression (valider avec manquants, supprimer)
  let recherche = '';
  let rechercheOuverte = false; // loupe de la page des inventaires dépliée
  /*
   * Contenant primaire dans lequel se trouve l'agent (véhicule, réserve), toujours affiché en haut d'un inventaire.
   * Il se déduit du contenant ouvert (ou de l'étiquette scannée sur place). Une recherche par le nom ne dit pas
   * où l'on est : sans contenant primaire choisi, l'inventaire trouvé s'ouvre en consultation seule (rien à cocher).
   */
  const CLE_CONTEXTE = 'avismur_inv_contexte';
  // Le contenant primaire est gardé sur l'appareil (localStorage, 12 h) : une étiquette QR ou NFC lue hors de
  // l'application ouvre un nouvel onglet, qui doit savoir où l'on est. La consultation demandée reste propre à l'onglet.
  const DUREE_CONTEXTE = 12 * 3600 * 1000;
  let contexte = (() => {
    let primaire = '';
    let consultation = false;
    try {
      const x = JSON.parse(localStorage.getItem(CLE_CONTEXTE));
      if (x && typeof x === 'object' && Date.now() - Number(x.t || 0) < DUREE_CONTEXTE) primaire = String(x.primaire || '');
    } catch (e) { /* stockage indisponible */ }
    try {
      const x = JSON.parse(sessionStorage.getItem(CLE_CONTEXTE));
      if (x && typeof x === 'object') { consultation = x.consultation === true; if (!primaire) primaire = String(x.primaire || ''); }
    } catch (e) { /* stockage indisponible */ }
    return { primaire, consultation };
  })();
  function fixerContexte(primaire, consultation) {
    contexte = { primaire: primaire || '', consultation: Boolean(consultation) };
    try { sessionStorage.setItem(CLE_CONTEXTE, JSON.stringify(contexte)); } catch (e) { /* stockage indisponible */ }
    try { if (contexte.primaire) localStorage.setItem(CLE_CONTEXTE, JSON.stringify({ primaire: contexte.primaire, t: Date.now() })); } catch (e) { /* stockage indisponible */ }
  }
  let dernierAffiche = null;
  let pile = [];
  const positionsDefilement = new Map(); // inventaire → défilement de la page quand on l'a quitté // inventaires ouverts à la suite : remonter d'un niveau revient en arrière dans l'historique du téléphone
  const synchro = { enCours: false, encore: false, texte: '', classe: '', serveurInconnu: false, photos: '' };

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
  const idChamp = () => `inv${(compteur += 1)}`;

  function lireJson(cle, defaut) {
    try { return JSON.parse(localStorage.getItem(cle)) || defaut; } catch (e) { return defaut; }
  }
  function ecrireJson(cle, valeur) {
    try { localStorage.setItem(cle, JSON.stringify(valeur)); return true; } catch (e) { return false; }
  }
  const CLE_LIENS_APPAREILS = 'avismur_liens_appareils';
  const sauverStructure = () => ecrireJson(CLE_STRUCTURE, structure);
  const sauverEtat = () => ecrireJson(CLE_ETAT, etat);
  const sauverModifs = () => ecrireJson(CLE_MODIFS, modifs);
  const sauverBrouillons = () => ecrireJson(CLE_BROUILLONS, brouillons);

  function nouvelId() {
    const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789'; // sans l, o, 0, 1 : relisible sur une étiquette
    return Array.from(crypto.getRandomValues(new Uint8Array(8)), (o) => alphabet[o % alphabet.length]).join('');
  }
  const pluriel = (n, mot, mots) => `${n} ${n > 1 ? (mots || `${mot}s`) : mot}`;
  // Droit INVENTAIRES (gestion des inventaires) ; la base des articles dépend du droit ARTICLES (vueBase).
  const aDroitApp = (code) => Boolean(App && (App.aDroit ? App.aDroit(code) : App.role() === 'admin'));
  const estAdmin = () => aDroitApp('INVENTAIRES');
  const heure = (iso) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

  // ---------- Dates ----------
  function jour(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /**
   * Date de péremption saisie au clavier numérique : « 0327 » ou « 03/2027 » (fin de mois),
   * « 15032027 » ou « 15/03/27 » (jour précis). Renvoie « 2027-03 », « 2027-03-15 »,
   * une chaîne vide (champ vidé) ou null (saisie non reconnue).
   */
  function analyserDate(saisie) {
    const chiffres = String(saisie || '').replace(/\D/g, '');
    if (!String(saisie || '').trim()) return '';
    if (!chiffres) return null;
    const essais = [];
    if (chiffres.length === 4) essais.push([0, chiffres.slice(0, 2), `20${chiffres.slice(2)}`]);
    if (chiffres.length === 6) {
      essais.push([0, chiffres.slice(0, 2), chiffres.slice(2)]);
      essais.push([chiffres.slice(0, 2), chiffres.slice(2, 4), `20${chiffres.slice(4)}`]);
    }
    if (chiffres.length === 8) essais.push([chiffres.slice(0, 2), chiffres.slice(2, 4), chiffres.slice(4)]);
    for (const [j, m, a] of essais) {
      const mois = Number(m);
      const annee = Number(a);
      const jourMois = Number(j);
      if (mois < 1 || mois > 12 || annee < 2000 || annee > 2100) continue;
      if (!j) return `${a}-${m}`;
      if (jourMois >= 1 && jourMois <= new Date(annee, mois, 0).getDate()) return `${a}-${m}-${j}`;
    }
    return null;
  }
  function afficherDate(iso) {
    if (!iso) return '';
    const [a, m, j] = iso.split('-');
    return j ? `${j}/${m}/${a}` : `${m}/${a}`;
  }
  /** Nombre de jours avant la fin de validité (négatif : périmé). « 2027-03 » vaut jusqu'au 31 mars. */
  function joursRestants(iso) {
    const [a, m, j] = iso.split('-').map(Number);
    const fin = j ? new Date(a, m - 1, j) : new Date(a, m, 0);
    const auj = new Date();
    return Math.round((fin - new Date(auj.getFullYear(), auj.getMonth(), auj.getDate())) / 86400000);
  }
  function etatPeremption(iso) {
    if (!iso) return { niveau: 'sans-date', texte: 'Date à saisir' };
    const jours = joursRestants(iso);
    if (jours < 0) return { niveau: 'perime', texte: 'Périmé' };
    if (jours <= structure.reglages.alerteJours) return { niveau: 'proche', texte: jours === 0 ? 'Expire aujourd\'hui' : `Expire dans ${jours} j` };
    return { niveau: 'ok', texte: '' };
  }

  // ---------- Structure ----------
  function normaliser(c) {
    return {
      id: c.id, parent: c.parent || '', nom: c.nom || '', ordre: Number(c.ordre) || 0, photo: c.photo || '',
      points: Array.isArray(c.points) ? c.points : [], articles: Array.isArray(c.articles) ? c.articles : [],
      // Vues supplémentaires (tout contenant : pièce, cellule sanitaire, sac vu sous plusieurs angles…).
      // La photo principale (`photo`, `points`, nom `nomVue`) est la vue 1.
      vues: Array.isArray(c.vues) ? c.vues.map((v) => ({ id: v.id, nom: v.nom || '', photo: v.photo || '', points: Array.isArray(v.points) ? v.points : [], fleches: flechesPropres(v.fleches), ...(champImmersif(v.immersif) ? { immersif: champImmersif(v.immersif) } : {}) })) : [],
      nomVue: c.nomVue || '',
      // Vue principale immersive (panorama pris au téléphone) : angle horizontal couvert, en degrés.
      ...(champImmersif(c.immersif) ? { immersif: champImmersif(c.immersif) } : {}),
      // Tableau de bord sur grand écran : largeur de la carte d'un sous-inventaire de niveau 1, en colonnes
      // (1 à 3, 4 = toute la ligne) ; absent = automatique d'après son contenu.
      ...([1, 2, 3, 4].includes(Number(c.largeurTb)) ? { largeurTb: Number(c.largeurTb) } : {}),
      // Vignette de la page des inventaires (contenant primaire : photo du véhicule…) ; à défaut, la photo principale.
      vignette: c.vignette || '',
      // Contenant primaire relié à un véhicule de la check-list ambulancier : son identifiant, '-' pour aucun ;
      // absent = d'après le nom (« F21 »). Photo (vignette) et état du jour sont alors communs aux deux check-lists.
      ...(c.vehicule ? { vehicule: String(c.vehicule) } : {}),
      fleches: flechesPropres(c.fleches), // flèches de la vue principale vers les autres vues
      scellable: c.scellable === true, // contenant fermé par un scellé (plomb) une fois vérifié
      // Inventaire libre : pas de liste attendue, le matériel présent est scanné « en vrac » puis compté par type.
      ...(c.vrac === true ? { vrac: true } : {}),
      categorie: CATEGORIES_CONTENANT[c.categorie] ? c.categorie : '', // primaire, immobile ou mobile
      // Étiquette QR : largeur × hauteur imprimées (mm) et logo central (puce NFC au dos, croix SMUR ou aucun).
      ...(c.etiquette ? { etiquette: normEtiquette(c.etiquette) } : {}),
      ...(c.modele ? { modele: true } : {}),
      // Inventaire type (immobile surtout) : contenants primaires (véhicules…) auxquels il est destiné. Vide = non précisé.
      ...(c.modele && Array.isArray(c.destinataires) && c.destinataires.some((x) => ID.test(String(x)))
        ? { destinataires: [...new Set(c.destinataires.map(String).filter((x) => ID.test(x)))] } : {}),
      ...(c.desaffecte ? { desaffecte: c.desaffecte } : {}), // mobile dont la place a été prise : à retrouver
      // Caisses d'un véhicule désarmé (répertoire virtuel, Desarmement.gs) : véhicule, date, agent ; copie : contenant d'origine.
      ...(c.stock && typeof c.stock === 'object' ? { stock: { ...c.stock } } : {}),
      // Emplacement : attend un exemplaire d'un inventaire type (ex. un « Ampoulier A » dans chaque sac) ;
      // l'exemplaire identifié en check-list y est rangé (enfant de l'emplacement).
      // Plusieurs inventaires types possibles (ex. scopes de marques différentes, Tempus à pochettes variables) :
      // `modeles` les liste tous ; `modele` (le premier) reste pour les versions précédentes.
      ...(c.emplacement && c.emplacement.modele ? { emplacement: (() => {
        const modeles = [...new Set([c.emplacement.modele, ...(Array.isArray(c.emplacement.modeles) ? c.emplacement.modeles : [])].filter((x) => ID.test(String(x))))];
        const e = modeles.length > 1 ? { modele: modeles[0], modeles } : { modele: modeles[0] };
        // Emplacement conditionnel (ex. pochette accessoires Schiller) : attendu seulement si l'emplacement `si.emplacement`
        // du même contenant primaire est occupé par l'un des modèles `si.modeles` (ex. le scope est un Schiller T7).
        const si = c.emplacement.si;
        const siModeles = si && Array.isArray(si.modeles) ? [...new Set(si.modeles.map(String).filter((x) => ID.test(x)))] : [];
        if (si && ID.test(String(si.emplacement || '')) && siModeles.length) e.si = { emplacement: String(si.emplacement), modeles: siModeles };
        return e;
      })() } : {}),
      ...(c.source ? { source: c.source } : {}), // exemplaire : contenant du modèle dont il est la copie
      ...(c.base ? { base: c.base } : {}), // exemplaire : état du modèle lors de la dernière répercussion
      ...(c.supprime ? { supprime: true } : {}),
      // Vérifié par la check-list ambulancier de ce véhicule (bouteilles d'oxygène) : pas de liste à cocher ici.
      // 'auto' : véhicule du contenant primaire (utile dans un inventaire type). `clElements` : éléments de la
      // check-list vérifiés ici (clés des réponses) ; vide = tous les niveaux d'oxygène.
      ...(c.clAmbulancier ? { clAmbulancier: String(c.clAmbulancier) } : {}),
      ...(c.clAmbulancier && Array.isArray(c.clElements) && c.clElements.length ? { clElements: c.clElements.map(String) } : {}),
      // Muni d'un traceur GeoTraceSMUR : nom du traceur (= son onglet dans GeoTrace). Exemplaire seulement.
      ...(c.traceur && !c.modele ? { traceur: String(c.traceur).slice(0, 60) } : {}),
    };
  }
  // ---------- Catégories de contenants ----------
  /** Seuls les contenants primaires sont listés à l'accueil ; les autres s'ouvrent par recherche, QR code ou NFC. */
  /** Inventaires types acceptés par un emplacement. */
  const modelesEmplacement = (e) => (e && e.emplacement ? (e.emplacement.modeles || [e.emplacement.modele]) : []);
  const CATEGORIES_CONTENANT = {
    primaire: { nom: 'Primaire', aide: 'véhicule, réserve : point de départ des inventaires' },
    immobile: { nom: 'Immobile', aide: 'tiroir, placard, armoire : ne change jamais de place' },
    mobile: { nom: 'Mobile', aide: 'sac, sacoche, ampoulier : peut changer de véhicule' },
  };

  // ---------- Vues (photos) d'un contenant ----------
  /**
   * Flèches posées sur une vue : rond transparent qui mène à une autre vue du même contenant
   * (tiroir fermé → ouvert, côté gauche → côté droit…). `vers` : clé de la vue ('' = vue principale),
   * `angle` : direction de la flèche en degrés (0 = vers la droite, par pas de 45).
   */
  function flechesPropres(liste) {
    return (Array.isArray(liste) ? liste : []).map((f) => {
      const x = Number(f && f.x); const y = Number(f && f.y);
      if (!f || typeof f.vers !== 'string' || !(x >= 0 && x <= 1) || !(y >= 0 && y <= 1)) return null;
      const a = ((Math.round((Number(f.angle) || 0) / 45) * 45) % 360 + 360) % 360;
      return { vers: f.vers, x, y, ...(a ? { angle: a } : {}) };
    }).filter(Boolean);
  }
  /**
   * Vue immersive : panorama (pris au téléphone, ou photo sphérique) que l'on fait pivoter du doigt.
   * `immersif` = angle horizontal couvert par l'image, en degrés (360 = tour complet) ; absent = photo classique.
   * Les gommettes gardent leurs coordonnées x/y (0 à 1) dans l'image : x donne la direction horizontale, y la verticale.
   */
  function champImmersif(n) { const v = Math.round(Number(n)); return v >= 30 && v <= 360 ? v : 0; }
  const sigFleche = (f) => ({ vers: f.vers, x: f.x, y: f.y, ...(f.angle ? { angle: f.angle } : {}) });
  /** Toutes les vues : la principale (clé '') puis les supplémentaires. */
  function vuesDe(c) {
    return [{ cle: '', nom: c.nomVue || 'Vue 1', photo: c.photo, points: c.points, fleches: c.fleches || [], immersif: c.immersif || 0 },
      ...c.vues.map((v, i) => ({ cle: v.id, nom: v.nom || `Vue ${i + 2}`, photo: v.photo, points: v.points, fleches: v.fleches || [], immersif: v.immersif || 0 }))];
  }
  /** Écrit dans une vue (principale : champs du contenant). */
  function majVue(c, cle, champs) {
    if (!cle) {
      if ('photo' in champs) c.photo = champs.photo;
      if ('points' in champs) c.points = champs.points;
      if ('nom' in champs) c.nomVue = champs.nom;
      if ('fleches' in champs) c.fleches = champs.fleches;
      if ('immersif' in champs) { if (champImmersif(champs.immersif)) c.immersif = champImmersif(champs.immersif); else delete c.immersif; }
    } else {
      const v = c.vues.find((x) => x.id === cle);
      if (v) { Object.assign(v, champs); if ('immersif' in champs && !champImmersif(champs.immersif)) delete v.immersif; }
    }
  }
  /**
   * Fait de la vue `cle` la vue affichée en premier par défaut : elle prend la place de la vue principale,
   * l'ancienne principale devient la première vue supplémentaire (même identifiant que la vue promue).
   * Les noms implicites (« Vue 1 », « Vue 3 »…) sont figés pour que chaque vue garde le sien.
   */
  function definirVueParDefaut(c, cle) {
    const i = c.vues.findIndex((v) => v.id === cle);
    if (i === -1) return;
    c.vues.forEach((x, j) => { if (!x.nom) x.nom = `Vue ${j + 2}`; }); // chaque vue garde le nom affiché
    const v = c.vues[i];
    const ancienne = { id: v.id, nom: c.nomVue || 'Vue 1', photo: c.photo, points: c.points, fleches: c.fleches || [], ...(c.immersif ? { immersif: c.immersif } : {}) };
    c.photo = v.photo; c.points = v.points; c.fleches = v.fleches || []; c.nomVue = v.nom || `Vue ${i + 2}`;
    if (v.immersif) c.immersif = v.immersif; else delete c.immersif;
    c.vues.splice(i, 1);
    c.vues.unshift(ancienne);
    // Les flèches suivent : la vue promue prend la clé '', l'ancienne principale prend la sienne.
    const echange = (f) => ({ ...f, vers: f.vers === v.id ? '' : (f.vers === '' ? v.id : f.vers) });
    c.fleches = c.fleches.map(echange);
    c.vues.forEach((x) => { x.fleches = (x.fleches || []).map(echange); });
  }
  const vueActive = new Map(); // contenant → clé de la vue affichée
  function vueCourante(c) {
    const toutes = vuesDe(c);
    return toutes.find((v) => v.cle === (vueActive.get(c.id) || '')) || toutes[0];
  }
  /** Retire les points d'un sous-inventaire sur toutes les vues. */
  function retirerCible(c, id) {
    c.points = c.points.filter((p) => p.cible !== id);
    c.vues.forEach((v) => { v.points = v.points.filter((p) => p.cible !== id); });
  }
  /** Traduit les cibles des points de toutes les vues (copie, exemplaire). */
  function traduireCibles(c, traduire) {
    const t = (points) => points.map((p) => { const cible = traduire(p.cible); return cible ? { ...p, cible } : null; }).filter(Boolean);
    c.points = t(c.points);
    c.vues = c.vues.map((v) => ({ ...v, points: t(v.points) }));
  }
  const photosDe = (c) => [c.photo, c.vignette, ...c.vues.map((v) => v.photo)].filter(Boolean);
  /**
   * Texte des gommettes d'un sous-inventaire (le même sur toutes les vues) : `undefined` = numéro automatique
   * (rang dans la liste), '' = gommette sans texte, sinon 1 à 4 caractères (lettres, chiffres…).
   */
  function texteChoisi(c, cible) {
    const p = vuesDe(c).flatMap((v) => v.points).find((x) => x.cible === cible && typeof x.texte === 'string');
    return p ? p.texte : undefined;
  }
  const texteGommette = (c, cible, rang) => { const t = texteChoisi(c, cible); return t === undefined ? String(rang + 1) : t; };
  function fixerTexteGommette(c, cible, texte) {
    vuesDe(c).forEach((v) => v.points.forEach((p) => {
      if (p.cible !== cible) return;
      if (texte === undefined) delete p.texte; else p.texte = texte;
    }));
  }
  /**
   * Taille d'une gommette sur une vue (facteur, 1 = normale). Propre à chaque photo : une photo vue de loin
   * (cellule sanitaire) demande des gommettes plus petites qu'un gros plan de tiroir.
   */
  const TAILLES_GOMMETTE = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2];
  const tailleGommette = (p) => { const t = Number(p && p.taille); return t > 0 ? t : 1; };
  /** Taille suivante (sens +1) ou précédente (-1) dans l'échelle. */
  function tailleVoisine(t, sens) {
    const i = TAILLES_GOMMETTE.findIndex((x) => x >= t - 0.001);
    const j = Math.min(TAILLES_GOMMETTE.length - 1, Math.max(0, (i === -1 ? TAILLES_GOMMETTE.length - 1 : i) + sens));
    return TAILLES_GOMMETTE[j];
  }
  /** Change la taille des gommettes de la vue `vc` (toutes, ou celle de `cible`). */
  function changerTaille(c, vc, sens, cible) {
    majVue(c, vc.cle, { points: vc.points.map((p) => {
      if (cible && p.cible !== cible) return p;
      const t = tailleVoisine(tailleGommette(p), sens);
      const { taille, ...reste } = p;
      return t === 1 ? reste : { ...reste, taille: t };
    }) });
  }
  /** Pose (ou repose) la gommette de `cible` sur la vue `vc`, en gardant son texte et sa taille. */
  function poserGommette(c, vc, cible, pos) {
    const t = texteChoisi(c, cible);
    const icone = iconeChoisie(c, cible);
    const avant = vc.points.find((p) => p.cible === cible);
    // Nouvelle gommette : taille des autres gommettes de la photo si elles ont toutes la même.
    const tailles = [...new Set(vc.points.map(tailleGommette))];
    const taille = avant ? tailleGommette(avant) : tailles.length === 1 ? tailles[0] : 1;
    majVue(c, vc.cle, { points: vc.points.filter((p) => p.cible !== cible).concat({ cible, x: pos.x, y: pos.y, ...(t === undefined ? {} : { texte: t }), ...(icone ? { icone } : {}), ...(taille === 1 ? {} : { taille }) }) });
  }
  /**
   * Icône facultative d'une gommette (à la place de son texte), la même sur toutes les vues :
   * poumon pour le respirateur, cœur avec éclair pour le défibrillateur. `undefined` = pas d'icône.
   */
  const ICONES_GOMMETTE = {
    poumon: { nom: 'Poumon (respirateur)', dessin: () => [
      el('svg:path', { d: 'M10 8.5C7.5 8.5 4.5 13 4 18c-.2 1.9.9 3 2.4 2.8 1.9-.3 3.6-1.2 3.6-3.3z', fill: 'currentColor' }),
      el('svg:path', { d: 'M14 8.5c2.5 0 5.5 4.5 6 9.5.2 1.9-.9 3-2.4 2.8-1.9-.3-3.6-1.2-3.6-3.3z', fill: 'currentColor' }),
      el('svg:path', { d: 'M12 3v8m0 0-2.2-1.8M12 11l2.2-1.8', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })] },
    defib: { nom: 'Cœur avec éclair (défibrillateur)', dessin: () => [
      el('svg:path', { d: 'M12 20.5s-7.5-4.8-7.5-10.4a4.3 4.3 0 0 1 7.5-2.9 4.3 4.3 0 0 1 7.5 2.9c0 5.6-7.5 10.4-7.5 10.4z', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.9', 'stroke-linejoin': 'round' }),
      el('svg:path', { d: 'M13.2 6.8 9.3 12.6h2.6l-1 4.6 4-6.2h-2.7z', fill: 'currentColor' })] },
    echo: { nom: 'Sonde (échographe)', dessin: () => [
      el('svg:rect', { x: '9.5', y: '2', width: '5', height: '6.5', rx: '1.6', fill: 'currentColor' }),
      el('svg:path', { d: 'M12 10.5 5.2 19.8Q12 23.6 18.8 19.8z', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.9', 'stroke-linejoin': 'round' }),
      el('svg:path', { d: 'M8.8 16.2q3.2 1.8 6.4 0', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round' })] },
  };
  const iconeValide = (i) => (typeof i === 'string' && ICONES_GOMMETTE[i] ? i : undefined);
  function iconeChoisie(c, cible) {
    const p = vuesDe(c).flatMap((v) => v.points).find((x) => x.cible === cible && iconeValide(x.icone));
    return p ? p.icone : undefined;
  }
  function fixerIconeGommette(c, cible, icone) {
    vuesDe(c).forEach((v) => v.points.forEach((p) => {
      if (p.cible !== cible) return;
      if (icone === undefined) delete p.icone; else p.icone = icone;
    }));
  }
  function logoGommette(icone) {
    const def = ICONES_GOMMETTE[icone];
    return el('svg:svg', { viewBox: '0 0 24 24', classe: 'inv-point-icone', 'aria-hidden': 'true' }, ...def.dessin());
  }
  /** Classes d'affichage d'une gommette selon son texte (vide, texte long). */
  const classesTexte = (t) => (t === '' ? ' vierge' : Array.from(t).length > 1 ? ` long${Array.from(t).length > 2 ? ' tres-long' : ''}${Array.from(t).length > 3 ? ' quatre' : ''}` : '');

  // ---------- Base des articles (catalogue) ----------
  const CATEGORIES = ['Médicament', 'DM', 'Magasin', 'Kit', 'Matériel', 'Biomed', 'Documents', 'Autre'];
  /** Texte comparable : minuscules, sans accents, espaces simples. */
  const cle = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  function normaliserFiche(f) {
    return {
      id: f.id, denomination: String(f.denomination || ''), categorie: CATEGORIES.includes(f.categorie) ? f.categorie : '',
      horsStock: f.horsStock === true, refInterne: String(f.refInterne || ''), refFournisseur: String(f.refFournisseur || ''),
      consommable: f.consommable === true, perissable: f.perissable === true, archive: f.archive === true,
      photo: String(f.photo || ''),
      // Case « Secrétariat » : propre à la catégorie « Documents ».
      secretariat: f.categorie === 'Documents' && f.secretariat === true,
    };
  }
  /** Fiche de la base d'un article d'inventaire (null pour un article ancien, saisi sans la base). */
  const fiche = (a) => (a && a.ref && structure.catalogue[a.ref]) || null;
  const nomArticle = (a) => (fiche(a) ? fiche(a).denomination : a.nom);
  /** Péremption suivie : d'après la fiche (« périssable »), sinon d'après l'article lui-même. */
  const suiviPeremption = (a) => (fiche(a) ? fiche(a).perissable : a.peremption === true);
  function resumeFiche(f) {
    return [f.categorie || 'Sans catégorie', f.refInterne ? `réf. ${f.refInterne}` : '', f.horsStock ? 'dotation hors stock' : '', f.secretariat ? 'secrétariat' : '',
      f.consommable ? '' : 'non consommable', f.perissable ? 'périssable' : '', f.archive ? 'archivé' : ''].filter(Boolean).join(' · ');
  }
  /**
   * Fiches correspondant à tous les mots cherchés, les plus pertinentes d'abord.
   * Un mot doit se trouver dans la dénomination ; il peut aussi se trouver dans une référence,
   * mais seulement à partir de 3 caractères (sinon « 8 » trouverait toutes les réf. contenant un 8).
   * Classement : dénomination identique, puis mots entiers, puis débuts de mots, puis le reste.
   */
  function chercherFiches(texte, { archives = false, categorie = '' } = {}) {
    const recherche = cle(texte);
    const mots = recherche.split(' ').filter(Boolean);
    const decouper = (t) => t.split(/[\s,;/()\-]+/).filter(Boolean);
    const score = (f) => {
      const nom = cle(f.denomination);
      const refs = cle(`${f.refInterne} ${f.refFournisseur}`);
      const motsNom = decouper(nom);
      // Les virgules décimales (« 3,5 ») restent aussi cherchables telles quelles.
      const motsNomBruts = nom.split(' ');
      const trouve = mots.every((m) => nom.includes(m) || (m.length >= 3 && refs.includes(m)));
      if (!trouve) return -1;
      if (nom === recherche) return 0;
      const entier = (m) => motsNom.includes(m) || motsNomBruts.includes(m);
      if (mots.every(entier)) return 1;
      const debut = (m) => motsNom.some((w) => w.startsWith(m)) || motsNomBruts.some((w) => w.startsWith(m));
      if (mots.every(debut)) return 2;
      if (mots.every((m) => nom.includes(m))) return 3;
      return 4; // trouvé grâce à une référence
    };
    return Object.values(structure.catalogue)
      .filter((f) => (archives || !f.archive) && (!categorie || f.categorie === categorie))
      .map((f) => ({ f, s: score(f) }))
      .filter((x) => x.s >= 0)
      .sort((x, y) => x.s - y.s || x.f.denomination.localeCompare(y.f.denomination, 'fr', { numeric: true }))
      .map((x) => x.f);
  }
  /** Autre fiche (non archivée) qui porte déjà ce nom ou cette réf. interne. */
  function doublon(f) {
    return Object.values(structure.catalogue).find((x) => x.id !== f.id && !x.archive
      && (cle(x.denomination) === cle(f.denomination) || (f.refInterne && cle(x.refInterne) === cle(f.refInterne)))) || null;
  }
  /** Inventaires où chaque fiche est utilisée : { idFiche: [contenant, …] }. */
  function utilisations() {
    const u = {};
    Object.values(structure.contenants).filter((c) => !c.supprime).forEach((c) => c.articles.forEach((a) => {
      if (a.ref) (u[a.ref] = u[a.ref] || []).includes(c) || u[a.ref].push(c);
    }));
    return u;
  }
  function enregistrerFiche(f) {
    structure.catalogue[f.id] = f;
    modifs.fiches[f.id] = (modifs.fiches[f.id] || 0) + 1;
    sauverStructure();
    sauverModifs();
    programmerEnvoi();
  }
  const enAttente = () => Object.keys(modifs.ids).length || Object.keys(modifs.fiches).length || modifs.reglages;

  /** Articles à cocher (sans les séparations, qui ne servent qu'à regrouper la liste). */
  const aCocher = (c) => c.articles.filter((a) => !a.separateur);
  // Repère « Photo » dans la liste des articles : la photo de navigation s'affiche à cet endroit de la check-list.
  // C'est une séparation particulière (rien à cocher) ; sans repère, la photo vient avant la liste
  // tant que l'inventaire n'est pas validé, puis passe dessous.
  const estReperePhoto = (a) => Boolean(a && a.separateur && a.photo === true);
  const reperePhoto = (c) => c.articles.findIndex(estReperePhoto);
  const nomSeparation = (a) => (estReperePhoto(a) ? 'emplacement de la photo' : `séparation « ${a.nom} »`);
  // ---------- Contrôles : valeur à relever au lieu d'une case ----------
  const CONTROLES = {
    scan: { nom: 'À renseigner', aide: 'valeur libre, choix dans une liste, durée ou valeur entre 2 bornes', defaut: 'Valeur' },
    materiel: { nom: 'Matériel attendu', aide: 'appareil filtré par type (PSE, respirateur…) : QR, NFC, saisie ou liste', defaut: 'Appareil' },
    temperature: { nom: 'Température', aide: '°C, avec plage', defaut: 'Température', unite: '°C' },
    batterie: { nom: 'Niveau de batterie', aide: '% ou 0 à 4', defaut: 'Batterie' },
    oui: { nom: 'Oui / Non', aide: 'branchement secteur, appairage, test', defaut: 'Test effectué' },
    valeur: { nom: 'Mesure', aide: 'nombre avec unité (bar, L…)', defaut: 'Pression' },
  };
  const estControle = (a) => Boolean(a && CONTROLES[a.controle]);
  /** Article facultatif (ex. détecteur de CO présent sur certains sacs) : son absence ne rend pas l'inventaire non conforme. */
  const estFacultatif = (a) => Boolean(a && a.facultatif === true);
  const seuilBatterie = (a) => (a.seuil !== undefined ? a.seuil : (a.echelle === '4' ? 2 : 50));
  /** Contrôle dont la valeur désigne un appareil : seul le « Matériel attendu » (le contrôle « À renseigner » est une valeur libre). */
  const estIdentifiant = (a) => a.controle === 'materiel';
  // ---------- Contrôle « À renseigner » : une valeur à relever, paramétrable ----------
  const MODES_SCAN = { libre: 'Totalement libre', liste: 'Choix dans une liste', duree: 'Durée', plage: 'Valeur entre 2 bornes' };
  const modeScan = (a) => (MODES_SCAN[a.mode] ? a.mode : 'libre');
  const choixScan = (a) => (Array.isArray(a.choix) ? a.choix.filter(Boolean) : []);
  /** Durée en minutes → « 1 h 30 », « 45 min ». */
  const texteDuree = (min) => {
    const m = Math.round(Number(min));
    if (!Number.isFinite(m) || m < 0) return '';
    const h = Math.floor(m / 60);
    return h ? `${h} h${m % 60 ? ` ${String(m % 60).padStart(2, '0')}` : ''}` : `${m} min`;
  };
  /** Durée saisie (« 1h30 », « 1:30 », « 2 h », « 45 », « 45 min ») → minutes, ou null si illisible (un nombre seul = minutes). */
  function minutesDe(texte) {
    const t = String(texte === undefined || texte === null ? '' : texte).trim().toLowerCase().replace(',', '.');
    let m = t.match(/^(\d+)\s*(?:h|:)\s*(\d{1,2})?\s*(?:min|m)?$/);
    if (m) return Number(m[1]) * 60 + Number(m[2] || 0);
    m = t.match(/^(\d+(?:\.\d+)?)\s*h$/);
    if (m) return Math.round(Number(m[1]) * 60);
    m = t.match(/^(\d+(?:\.\d+)?)\s*(?:min|m)?$/);
    return m ? Math.round(Number(m[1])) : null;
  }
  /** Contrôles dont la valeur du jour peut être reprise en grisé à la prochaine check-list (n° de matériel, valeur libre ou chiffrée). */
  const reprendPrecedent = (a) => estIdentifiant(a) || (a.controle === 'scan' && ['libre', 'plage'].includes(modeScan(a)));
  const appareilsConnus = () => (typeof Materiel !== 'undefined' && Materiel.appareils ? Materiel.appareils() : []);
  /** Appareils proposés pour un matériel attendu : ceux du type demandé (tous si aucun type). */
  /** Type d'appareil accepté par un contrôle : un « Scope/défibrillateur » vaut aussi pour « Scope » et pour « Défibrillateur ». */
  const typeAccepte = (typeAppareil, typeDemande) => !typeDemande || cle(typeAppareil) === cle(typeDemande)
    || String(typeAppareil || '').split('/').some((t) => cle(t) === cle(typeDemande));
  const appareilsPour = (a) => appareilsConnus().filter((x) => typeAccepte(x.type, a.typeMateriel));
  /** « Scope Corpuls3 n° 2 » : type, modèle puis n° interne SMUR. */
  const libelleAppareil = (x, num = x.numInterne) => [x.type || 'Appareil', x.modele, num && `n° ${num}`, x.pret && `(${x.pret})`].filter(Boolean).join(' ');
  /** Nom inscrit pour un matériel de prêt : « PRÊT » + son modèle (à défaut son type). */
  const nomPretBase = (x) => `PRÊT ${x.modele || x.type || ''}`.trim();
  /** Plusieurs prêts du même modèle : la référence est ajoutée pour les distinguer (« PRÊT Tempus Pro (03) »). */
  const nomPret = (x) => {
    const base = nomPretBase(x);
    const memeModele = appareilsConnus().filter((y) => y.pret && y.id !== x.id && cle(nomPretBase(y)) === cle(base));
    return memeModele.length ? `${base} (${String(x.pret).replace(/^PR[ÊE]T\s*/i, '')})` : base;
  };
  /** Appareil de la base correspondant à la valeur relevée (n° interne SMUR, sinon n° de série). */
  function appareilDe(a, v) {
    const t = cle(String(v || ''));
    if (!t) return null;
    const liste = appareilsPour(a);
    // N° interne propre à chaque modèle : deux appareils du même type peuvent porter le même n° (Osiris 3 n° 1, Monnal n° 1).
    const parNum = liste.filter((x) => x.numInterne && cle(x.numInterne) === t);
    return (parNum.length === 1 ? parNum[0] : null) || liste.find((x) => x.numSerie && cle(x.numSerie) === t)
      || liste.find((x) => x.numBiomed && cle(x.numBiomed) === t)
      || liste.find((x) => x.pret && cle(x.pret).replace(/ /g, '') === t.replace(/ /g, ''))
      // « PRÊT Tempus Pro » : matériel de prêt désigné par son modèle (plusieurs prêts du même modèle : le premier).
      || liste.find((x) => x.pret && cle(nomPret(x)) === t)
      || liste.find((x) => x.pret && cle(nomPretBase(x)) === t) || null;
  }
  /**
   * Valeur inscrite pour un appareil : « PRÊT Tempus Pro » (PRÊT + modèle) pour un matériel de prêt ; sinon son n° interne s'il est le seul
   * de ce type à le porter (deux modèles peuvent avoir le même n° : son n° de série ou biomed lève alors le doute).
   */
  function codeAppareil(a, x) {
    if (x.pret) return nomPret(x);
    const liste = a ? appareilsPour(a) : appareilsConnus().filter((y) => cle(y.type) === cle(x.type));
    const n = x.numInterne;
    if (n && liste.filter((y) => y.numInterne && cle(y.numInterne) === cle(n)).length <= 1) return String(n);
    return String(x.numSerie || x.numBiomed || n || x.pret || '');
  }
  /** Évalue une valeur relevée : { ok, rempli }. */
  function evaluer(a, v) {
    const t = String(v === undefined || v === null ? '' : v).trim();
    if (!t) return { ok: false, rempli: false };
    if (a.controle === 'materiel') {
      if (a.attendu && t.toLowerCase() !== String(a.attendu).trim().toLowerCase()) {
        // N° inscrit sous forme de n° de série (n° interne partagé par deux modèles) : on compare le n° interne de l'appareil.
        const x = appareilDe(a, t);
        if (!x || cle(x.numInterne) !== cle(String(a.attendu))) return { ok: false, rempli: true };
      }
      // Type demandé : l'appareil doit exister dans le suivi du matériel avec ce type (base non chargée : pas de blocage).
      if (a.typeMateriel && appareilsConnus().length && !appareilDe(a, t)) return { ok: false, rempli: true };
      return { ok: true, rempli: true };
    }
    if (a.controle === 'scan') {
      const mode = modeScan(a);
      if (mode === 'libre') return { ok: !a.attendu || t.toLowerCase() === String(a.attendu).trim().toLowerCase(), rempli: true };
      if (mode === 'liste') { const ch = choixScan(a); return { ok: !ch.length || ch.some((x) => x.toLowerCase() === t.toLowerCase()), rempli: true }; }
      if (mode === 'duree') {
        const n = Number(t);
        if (!Number.isFinite(n)) return { ok: false, rempli: true };
        return { ok: (a.min === undefined || n >= a.min) && (a.max === undefined || n <= a.max), rempli: true };
      }
      // « plage » : valeur chiffrée comparée aux bornes, comme une mesure (suite ci-dessous).
    }
    if (a.controle === 'oui') return { ok: t === 'Oui', rempli: true };
    const n = Number(t.replace(',', '.'));
    if (!Number.isFinite(n)) return { ok: false, rempli: true };
    if (a.controle === 'batterie') return { ok: n >= seuilBatterie(a), rempli: true };
    return { ok: (a.min === undefined || n >= a.min) && (a.max === undefined || n <= a.max), rempli: true };
  }
  /** Valeur affichée (avec unité). */
  function texteValeur(a, v) {
    if (v === '' || v === undefined) return 'non renseigné';
    if (a.controle === 'materiel') { const x = appareilDe(a, v); return x ? libelleAppareil(x, x.numInterne || v) : `n° ${v}`; }
    if (a.controle === 'scan' && modeScan(a) === 'duree') return texteDuree(v) || String(v);
    if (a.controle === 'scan' && modeScan(a) === 'plage' && a.unite) return `${v} ${a.unite}`;
    if (a.controle === 'temperature') return `${v} °C`;
    if (a.controle === 'batterie') return a.echelle === '4' ? `${v}/4` : `${v} %`;
    if (a.controle === 'valeur' && a.unite) return `${v} ${a.unite}`;
    return String(v);
  }
  /** Plage attendue, en clair. */
  function texteAttente(a) {
    // Check-list : le n° attendu n'est jamais dévoilé, l'agent lit ou scanne l'appareil présent.
    if (a.controle === 'scan') {
      const mode = modeScan(a);
      if (mode === 'libre') return a.attendu && gestion ? `attendu : ${a.attendu}` : '';
      if (mode === 'liste') return gestion ? choixScan(a).join(' / ') : '';
      if (mode === 'duree') {
        if (a.min !== undefined && a.max !== undefined) return `${texteDuree(a.min)} à ${texteDuree(a.max)}`;
        if (a.min !== undefined) return `≥ ${texteDuree(a.min)}`;
        return a.max !== undefined ? `≤ ${texteDuree(a.max)}` : '';
      }
    }
    if (a.controle === 'materiel') return [a.typeMateriel, a.attendu && gestion ? `n° ${a.attendu}` : ''].filter(Boolean).join(' ');
    if (a.controle === 'batterie') return `≥ ${seuilBatterie(a)}${a.echelle === '4' ? '/4' : ' %'}`;
    if (a.controle === 'oui') return '';
    const u = a.controle === 'temperature' ? ' °C' : (a.unite ? ` ${a.unite}` : '');
    if (a.min !== undefined && a.max !== undefined) return `${a.min} à ${a.max}${u}`;
    if (a.min !== undefined) return `≥ ${a.min}${u}`;
    if (a.max !== undefined) return `≤ ${a.max}${u}`;
    return '';
  }
  const contenant = (id) => {
    const c = structure.contenants[id];
    return c && !c.supprime ? c : null;
  };
  function enfants(idParent) {
    const liste = Object.values(structure.contenants)
      .filter((c) => !c.supprime && (c.parent || '') === (idParent || ''))
      .sort((a, b) => a.ordre - b.ordre || a.nom.localeCompare(b.nom, 'fr'));
    // Check-list : un emplacement conditionnel dont la condition n'est pas remplie n'existe pas (ni carte, ni gommette, ni compte).
    return gestion || simulation ? liste : liste.filter((f) => !enSommeil(f));
  }
  const calculsSommeil = new Set(); // garde-fou contre deux conditions qui se renverraient l'une à l'autre
  /**
   * Emplacement conditionnel en sommeil : sa condition n'est pas remplie (ex. le scope identifié aujourd'hui n'est pas
   * un Schiller) et rien n'y a été identifié aujourd'hui. Condition : l'emplacement `si.emplacement` — dans un exemplaire,
   * celui qui en est la copie — du même contenant primaire est occupé aujourd'hui par l'un des modèles `si.modeles`.
   * Emplacement de référence introuvable : la condition est considérée remplie (on ne cache rien par erreur).
   */
  function enSommeil(e) {
    const si = e && e.emplacement && e.emplacement.si;
    if (!si || calculsSommeil.has(e.id)) return false;
    calculsSommeil.add(e.id);
    try {
      return !conditionRemplie(e) && !occupantDuJour(e);
    } finally { calculsSommeil.delete(e.id); }
  }
  function conditionRemplie(e) {
    const si = e.emplacement.si;
    if (!si.modeles.length) return true; // condition en cours de réglage (aucun modèle coché)
    const racine = (chemin(e.id)[0] || {}).id;
    const memeEnsemble = Object.values(structure.contenants).filter((x) => !x.supprime && x.emplacement && x.id !== e.id && (chemin(x.id)[0] || {}).id === racine);
    // L'emplacement de référence, ou sa copie ; à défaut (emplacement recréé à la main), celui qui accepte ces modèles.
    const cibles = memeEnsemble.filter((x) => x.id === si.emplacement || x.source === si.emplacement);
    const parModeles = memeEnsemble.filter((x) => modelesEmplacement(x).some((m) => si.modeles.includes(m)));
    // Aucun emplacement de référence : condition non remplie (l'emplacement reste masqué).
    return (cibles.length ? cibles : parModeles).some((x) => { const occ = occupantDuJour(x); return Boolean(occ && si.modeles.includes(occ.source)); });
  }
  /** Du premier niveau jusqu'au contenant. */
  function chemin(id) {
    const suite = [];
    const vus = new Set();
    for (let c = contenant(id); c && !vus.has(c.id); c = contenant(c.parent)) { vus.add(c.id); suite.unshift(c); }
    return suite;
  }
  /**
   * Chemin affiché (« F21 › Tiroir F › Sac rouge n°3 ») : un emplacement porte le nom de l'inventaire type attendu
   * et n'a pas sa place dans le chemin, sauf s'il est lui-même le dernier élément (emplacement vide ouvert).
   */
  const cheminNoms = (id, sep = ' › ') => chemin(id).filter((x, i, t) => !x.emplacement || i === t.length - 1).map((x) => x.nom).join(sep);
  /** Le contenant et tout ce qu'il contient. */
  function descendants(id, vus = new Set()) {
    const c = contenant(id);
    if (!c || vus.has(id)) return [];
    vus.add(id);
    return [c, ...enfants(id).flatMap((f) => descendants(f.id, vus))];
  }
  /** Contenant primaire (véhicule, réserve) qui renferme ce contenant, lui compris. */
  const primaireDe = (id) => chemin(id).find((x) => x.categorie === 'primaire' && !x.modele) || null;
  // Consultation seule : demandée (recherche par le nom), ou aucun contenant primaire connu
  // (ex. contenant mobile désaffecté scanné sans avoir dit où l'on est) : rien à cocher ni à dater.
  /** Le contenant est (ou est rangé dans) un contenant mobile : il ne dit pas dans quel contenant primaire on se trouve. */
  /** Contenants scannés sur place (action rapide QR / NFC) → contenant primaire où l'on était au scan. */
  const scannesIci = new Map();
  const dansUnMobile = (c) => Boolean(c) && chemin(c.id).some((x) => x.categorie === 'mobile');
  // Consultation seule (inventaire impossible) : demandée (recherche par le nom) ; contenant mobile ouvert sans avoir
  // dit où l'on est, ou enregistré dans un autre contenant primaire que celui où l'on est ; aucun contenant primaire connu.
  const enConsultation = (c) => {
    if (contexte.consultation) return true;
    if (!c) return false;
    const ici = contenant(contexte.primaire);
    const structurel = primaireDe(c.id);
    if (!ici) return dansUnMobile(c) || !structurel;
    // Étiquette scannée par l'action rapide dans le contenant primaire où l'on est : il est là, on en fait l'inventaire.
    if (chemin(c.id).some((x) => scannesIci.get(x.id) === ici.id)) return false;
    return dansUnMobile(c) && (!structurel || structurel.id !== ici.id);
  };
  /**
   * Niveau du dessus, pour la flèche retour et le chemin : un emplacement (« ici, un exemplaire de tel
   * inventaire type ») s'efface derrière le contenant qui l'occupe, en check-list comme en gestion.
   */
  function parentVisible(c) {
    const vus = new Set();
    let p = contenant(c.parent);
    while (p && p.emplacement && !vus.has(p.id)) { vus.add(p.id); p = contenant(p.parent); }
    return p;
  }
  /** Étages au-dessus d'un contenant, du plus proche au plus lointain. */
  function etagesAuDessus(c) {
    const liste = [];
    const vus = new Set([c.id]);
    for (let p = parentVisible(c); p && !vus.has(p.id); p = parentVisible(p)) { vus.add(p.id); liste.push(p); }
    return liste;
  }
  const datePeremption = (idContenant, idArticle) => (etat.peremptions[`${idContenant}/${idArticle}`] || {}).date || '';
  /*
   * Contenants mobiles pointés aujourd'hui. L'inventaire repart de zéro chaque matin : le contenant identifié
   * la veille dans un emplacement n'est pas repris d'office, il faut le pointer de nouveau (QR, NFC ou liste).
   * Pointé = identifié aujourd'hui sur cet appareil, ou déjà vérifié aujourd'hui (par n'importe quel agent).
   */
  function brouillonsDuJour() {
    if (brouillons.jour !== jour()) brouillons = { jour: jour(), liste: {}, pointes: {} };
    if (!brouillons.pointes) brouillons.pointes = {};
    return brouillons;
  }
  function noterPointage(idEmplacement, idMobile) {
    const e = contenant(idEmplacement);
    if (!e) return;
    // Emplacement : son occupant du jour. Autre contenant : « m:<mobile> » → contenant où il a été pointé.
    if (e.emplacement) brouillonsDuJour().pointes[idEmplacement] = idMobile;
    else brouillonsDuJour().pointes[`m:${idMobile}`] = idEmplacement;
    sauverBrouillons();
  }
  /** Contenant mobile (hors emplacement) déjà pointé aujourd'hui là où il se trouve. */
  function mobilePointe(m) {
    return brouillonsDuJour().pointes[`m:${m.id}`] === m.parent || Boolean(verifDuJour(m.id));
  }
  /** Contenant mobile à ne pas nommer en check-list : pas encore pointé aujourd'hui (ni en consultation). */
  const masquerMobile = (m) => m.categorie === 'mobile' && !m.emplacement && Boolean(m.parent) && !enConsultation(m) && !mobilePointe(m);
  /** Identification à rouvrir au prochain affichage (icône « changer de contenant »). */
  let aIdentifier = '';
  /** L'agent s'est trompé ou a changé de contenant : on oublie le pointage et on redemande lequel est là. */
  function changerContenant(c) {
    const e = contenant(c.parent);
    const dessus = etagesAuDessus(c)[0];
    if (!e || !dessus) return;
    const pointes = brouillonsDuJour().pointes;
    if (e.emplacement) { delete pointes[e.id]; aIdentifier = `emp:${e.id}`; } else { delete pointes[`m:${c.id}`]; aIdentifier = c.id; }
    sauverBrouillons();
    aller(dessus.id);
  }
  /** Occupant d'un emplacement, seulement s'il a été pointé aujourd'hui (sinon null : « à identifier »). */
  function occupantDuJour(e) {
    const occ = enfants(e.id)[0];
    if (!occ) return null;
    return brouillonsDuJour().pointes[e.id] === occ.id || verifDuJour(occ.id) ? occ : null;
  }
  const verifDuJour = (id) => {
    const v = etat.verifs[id];
    return v && jour(new Date(v.date)) === jour() ? v : null;
  };

  // ---------- Contenant vérifié par la check-list ambulancier (bouteilles d'oxygène) ----------
  const seuilObus = () => (typeof SEUILS_ANOMALIE !== 'undefined' && SEUILS_ANOMALIE.obus !== undefined ? SEUILS_ANOMALIE.obus : 3);
  const listeVehicules = () => (typeof VEHICULES !== 'undefined' ? VEHICULES : []);
  /** Véhicule dont la check-list ambulancier vérifie ce contenant ('auto' : celui du contenant primaire). */
  function vehiculeAmbulancier(c) {
    if (!c || !c.clAmbulancier) return null;
    if (c.clAmbulancier !== 'auto') return listeVehicules().find((v) => v.id === c.clAmbulancier) || { id: c.clAmbulancier };
    const p = primaireDe(c.id);
    if (!p || p.vehicule === '-') return null;
    return p.vehicule ? listeVehicules().find((v) => v.id === p.vehicule) || { id: p.vehicule } : vehiculeDuNom(p);
  }
  /** Véhicule trouvé d'après le nom d'un contenant primaire (« F21 », « VL F21 »), ou null. */
  function vehiculeDuNom(p) {
    const nom = cle(p.nom);
    return listeVehicules().find((v) => cle(v.id) === nom || (v.nom && cle(v.nom) === nom))
      || listeVehicules().find((v) => new RegExp(`(^|[^a-z0-9])${cle(v.id)}([^a-z0-9]|$)`).test(nom)) || null;
  }
  /**
   * Véhicule de la check-list ambulancier relié à un contenant primaire : choisi en gestion (`vehicule`),
   * sinon d'après son nom. Les deux check-lists partagent alors la photo du véhicule et leur état du jour.
   */
  function vehiculeDuPrimaire(p) {
    if (!p || p.categorie !== 'primaire' || p.modele || p.vehicule === '-') return null;
    if (p.vehicule) return listeVehicules().find((v) => v.id === p.vehicule) || { id: p.vehicule };
    return vehiculeDuNom(p);
  }
  /** Contenant primaire dont le véhicule est désarmé d'après la dernière fiche régulation. */
  function vehiculeDesarme(p) {
    // Caisses d'un véhicule désarmé : inventaire normal (péremptions suivies), jamais grisé.
    if (!p || p.stock) return false;
    const v = vehiculeDuPrimaire(p);
    if (!v) return false;
    if (typeof Desarmement !== 'undefined') return Desarmement.estDesarme(v.id);
    try { return (JSON.parse(localStorage.getItem('avismur_armement')) || {})[v.id] === 'DÉSARMÉ'; } catch (e) { return false; }
  }
  /** Famille d'un contenant primaire sur la page des inventaires : VML, AR (UMH), HELICO (F00), LOCAUX. */
  function famillePrimaire(p) {
    const v = vehiculeDuPrimaire(p);
    const modele = String((v && (listeVehicules().find((x) => x.id === v.id) || v).modele) || '').toUpperCase();
    // Hélicoptère : l'appareil lui-même (contenant nommé « hélico… ») et l'UMH en DZ d'après le dernier état du parc connu.
    if (!v && /h[ée]lico|h135|ec ?135/i.test(p.nom || '')) return 'HELICO';
    if (v && (modele === 'F00' || /HELI|F00/i.test(v.id))) return 'HELICO';
    if (v && typeof Ambulancier !== 'undefined' && Ambulancier.positionConnue && Ambulancier.estDZ(Ambulancier.positionConnue(v.id))) return 'HELICO';
    if (modele === 'VML') return 'VML';
    if (modele === 'UMH') return 'AR';
    if (v && modele === 'COUVEUSE') return 'AR';
    return 'LOCAUX';
  }
  /** Contenant primaire relié à ce véhicule (inventaires gardés sur l'appareil), ou null. */
  function primaireDuVehicule(id) {
    return Object.values(structure.contenants).find((c) => !c.supprime && vehiculeDuPrimaire(c) && vehiculeDuPrimaire(c).id === id) || null;
  }
  /** Nombre de péremptions renseignées dans les tiroirs et placards (contenants immobiles) d'un véhicule. */
  function peremptionsVehicule(id) {
    const p = primaireDuVehicule(id);
    if (!p) return 0;
    return descendants(p.id).filter((c) => !c.supprime && c.categorie === 'immobile')
      .reduce((n, c) => n + (c.articles || []).filter((a) => datePeremption(c.id, a.id)).length, 0);
  }
  /**
   * Check-list ambulancier du jour d'un véhicule, vue depuis les inventaires : pastille (même couleur que la case
   * du véhicule) et texte court. null si l'appli n'a pas la check-list ambulancier.
   */
  function etatAmbulancier(v) {
    if (!v || typeof Ambulancier === 'undefined') return null;
    try {
      const vehicule = listeVehicules().find((x) => x.id === v.id) || v;
      const e = Ambulancier.etatVehicule(vehicule);
      const info = Ambulancier.infosVehicule(v.id);
      const carb = vehicule.sansPlein ? null : Ambulancier.carburantActuel(info);
      const seuilPlein = typeof SEUILS_ANOMALIE !== 'undefined' ? SEUILS_ANOMALIE.plein : 5;
      let texte = e.classe === 'indispo' ? 'Véhicule non disponible' : 'Check-list ambulancier à faire';
      if (e.statut) {
        texte = `Check-list ambulancier faite ${new Date(e.statut.date).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} · ${e.statut.agent}`;
        if (e.statut.anomalies.length) texte += ` · ${pluriel(e.statut.anomalies.length, 'anomalie')}`;
      }
      return { classe: e.classe, texte, anomalies: e.statut ? e.statut.anomalies : [], carburant: carb, pleinAFaire: Boolean(carb && carb.valeur <= seuilPlein) };
    } catch (e) { return null; }
  }
  /** Ligne « check-list ambulancier » d'un véhicule (carte de la page des inventaires, bande du contenant primaire). */
  function ligneAmbulancier(v, { court = false } = {}) {
    const e = etatAmbulancier(v);
    if (!e) return null;
    return el('span', { classe: `inv-amb-etat ${e.classe}`, title: e.anomalies.length ? `Anomalies : ${e.anomalies.join(' ; ')}` : e.texte },
      el('span', { classe: 'pastille-etat', 'aria-hidden': 'true' }),
      el('span', { texte: court ? e.texte.replace('Check-list ambulancier', 'CL ambu') : e.texte }),
      e.pleinAFaire ? el('span', { classe: 'inv-amb-plein', texte: ` · carburant ${e.carburant.valeur}/8` }) : null);
  }
  /**
   * Éléments que la check-list ambulancier peut vérifier : niveaux (obus, bouteilles) et éléments des listes à cocher.
   * Pour un véhicule : ceux de son modèle ; sans véhicule (inventaire type) : ceux de tous les modèles.
   */
  function elementsAmbulancier(v) {
    const modeles = typeof MODELES === 'object' && MODELES ? MODELES : {};
    const sources = v && modeles[v.modele] ? [modeles[v.modele]] : Object.values(modeles);
    const concerne = (x) => !v || ((!x.seulementPour || x.seulementPour.includes(v.id)) && (!x.exclusPour || !x.exclusPour.includes(v.id)));
    const vus = new Map();
    sources.forEach((m) => (m.questions || []).forEach((q) => {
      if (!q || !concerne(q)) return;
      if (q.type === 'niveau' && !vus.has(q.libelle)) vus.set(q.libelle, { cle: q.libelle, nom: q.affiche || q.libelle, type: 'niveau', groupe: 'Oxygène' });
      if (q.type === 'groupe') {
        q.items.map((i) => (typeof i === 'string' ? { libelle: i } : i)).filter(concerne).forEach((i) => {
          const k = i.colonne || `${q.titre} [${i.libelle}]`;
          if (!vus.has(k)) vus.set(k, { cle: k, nom: i.libelle, type: 'item', groupe: q.titre });
        });
      }
    }));
    return [...vus.values()];
  }
  /**
   * Check-list ambulancier du jour du véhicule lié et état des éléments vérifiés ici :
   * { vehicule, statut (null si pas encore faite), niveaux: [{ nom, valeur sur 10, bas }], items: [{ nom, ok }] }.
   */
  function releveAmbulancier(c) {
    if (!c || !c.clAmbulancier) return null;
    const v = vehiculeAmbulancier(c);
    const r = { vehicule: v, statut: null, niveaux: [], items: [] };
    if (!v) return r;
    try { r.statut = typeof Ambulancier !== 'undefined' ? Ambulancier.infosVehicule(v.id).statut : null; } catch (e) { r.statut = null; }
    const tous = elementsAmbulancier(listeVehicules().find((x) => x.id === v.id) || null);
    const choisis = c.clElements && c.clElements.length
      ? c.clElements.map((k) => tous.find((x) => x.cle === k) || elementsAmbulancier(null).find((x) => x.cle === k)).filter(Boolean)
      : tous.filter((x) => x.type === 'niveau');
    r.attendus = choisis;
    if (!r.statut || !r.statut.reponses) return r;
    choisis.forEach((x) => {
      const rep = r.statut.reponses[x.cle];
      if (x.type === 'niveau') {
        const n = parseInt(String(rep ?? ''), 10);
        if (!Number.isNaN(n)) r.niveaux.push({ nom: x.nom, valeur: n, bas: n <= seuilObus() });
      } else if (rep === 'OK' || rep === 'Manquant') r.items.push({ nom: x.nom, ok: rep === 'OK' });
    });
    return r;
  }
  /** Empreinte des check-lists ambulancier utiles à l'écran : on ne redessine que si elle change. */
  function empreinteAmbulancier() {
    return JSON.stringify(Object.values(structure.contenants).filter((c) => c.clAmbulancier && !c.supprime)
      .map((c) => { const r = releveAmbulancier(c); return [c.id, r.statut ? r.statut.date : '', r.niveaux.map((n) => n.valeur), r.items.map((i) => i.ok)]; })
      // Contenants primaires reliés à un véhicule : état de sa check-list ambulancier (carte et bande du haut).
      .concat(Object.values(structure.contenants).filter((c) => c.categorie === 'primaire' && !c.supprime)
        .map((c) => { const e = etatAmbulancier(vehiculeDuPrimaire(c)); return [c.id, e ? e.texte : '', e && e.pleinAFaire]; })));
  }

  /** État d'un contenant et de tout ce qu'il contient. */
  function bilan(id) {
    // listeManquants : le détail des manquants (affiché au clic sur le badge) ; remarques : notées à part, jamais comptées.
    const b = { total: 0, faits: 0, manquants: 0, perimes: 0, proches: 0, sansDate: 0, listeManquants: [], remarques: [], racine: id };
    descendants(id).forEach((c) => {
      if (dansUnModele(c.id)) return; // un inventaire type ne se vérifie pas
      if (c.emplacement && !occupantDuJour(c)) { b.total += 1; b.vides = (b.vides || 0) + 1; }
      // Bouteilles d'oxygène : vérifiées par la check-list ambulancier du véhicule.
      const r = c.clAmbulancier ? releveAmbulancier(c) : null;
      if (r && r.vehicule) {
        b.total += 1;
        if (r.statut) {
          b.faits += 1;
          const bas = r.niveaux.filter((n) => n.bas).length;
          if (bas) b.oxygeneBas = (b.oxygeneBas || 0) + bas;
          const manque = r.items.filter((i) => !i.ok).length;
          if (manque) b.ambManquants = (b.ambManquants || 0) + manque;
        }
      }
      if (aCocher(c).length || estVrac(c)) {
        b.total += 1;
        const v = verifDuJour(c.id);
        if (v) {
          b.faits += 1;
          b.manquants += v.manquants.length;
          v.manquants.forEach((m) => b.listeManquants.push({ nom: m.nom, ou: c.id }));
          if (v.remarque && !verifScellee(v)) b.remarques.push({ texte: v.remarque, ou: c.id, agent: v.agent });
        }
      }
      aCocher(c).filter(suiviPeremption).forEach((a) => {
        const p = etatPeremption(datePeremption(c.id, a.id)).niveau;
        if (p === 'perime') b.perimes += 1;
        else if (p === 'proche') b.proches += 1;
        else if (p === 'sans-date') b.sansDate += 1;
      });
    });
    b.complet = b.total > 0 && b.faits === b.total;
    // Anomalie (ici ou dans un sous-inventaire) : article manquant ou hors limite au dernier inventaire, ou périmé.
    b.anomalie = b.manquants > 0 || b.perimes > 0 || b.oxygeneBas > 0 || b.ambManquants > 0;
    b.classe = b.total === 0 ? 'vide' : (b.complet ? `fait${b.anomalie ? ' anomalie' : ''}` : (b.faits ? 'encours' : 'afaire'));
    b.texte = b.total === 0 ? 'Rien à cocher' : (b.complet ? 'Vérifié aujourd\'hui' : (b.faits ? `${b.faits} sur ${b.total} vérifiés` : 'À vérifier'));
    return b;
  }

  let simulation = false; // répercussion à blanc (recensement des conflits) : rien n'est enregistré
  function marquer(id) {
    if (simulation) return;
    modifs.ids[id] = (modifs.ids[id] || 0) + 1;
    sauverStructure();
    sauverModifs();
    programmerEnvoi();
  }

  // ---------- Photos (IndexedDB) ----------
  const Photos = (() => {
    const memoire = new Map();
    let base = null;
    function ouvrir() {
      if (!base) {
        base = new Promise((ok, ko) => {
          const r = indexedDB.open('avismur', 1);
          r.onupgradeneeded = () => r.result.createObjectStore('photos');
          r.onsuccess = () => ok(r.result);
          r.onerror = () => ko(r.error);
        });
      }
      return base;
    }
    function transaction(mode, faire) {
      return ouvrir().then((db) => new Promise((ok, ko) => {
        const t = db.transaction('photos', mode);
        const r = faire(t.objectStore('photos'));
        t.oncomplete = () => ok(r.result);
        t.onerror = () => ko(t.error);
        t.onabort = () => ko(t.error);
      }));
    }
    return {
      /** Photo déjà chargée depuis l'ouverture de l'appli : affichée sans attente, donc sans saut de page. */
      enMemoire: (id) => memoire.get(id) || '',
      async lire(id) {
        if (memoire.has(id)) return memoire.get(id);
        try {
          const v = await transaction('readonly', (m) => m.get(id));
          if (v) memoire.set(id, v);
          return v || '';
        } catch (e) { return ''; }
      },
      async ecrire(id, donnees) {
        memoire.set(id, donnees); // au pire, la photo reste disponible jusqu'à la fermeture de l'appli
        try { await transaction('readwrite', (m) => m.put(donnees, id)); } catch (e) { /* stockage indisponible */ }
      },
      async supprimer(id) {
        memoire.delete(id);
        try { await transaction('readwrite', (m) => m.delete(id)); } catch (e) { /* stockage indisponible */ }
      },
      async cles() {
        try { return await transaction('readonly', (m) => m.getAllKeys()); } catch (e) { return [...memoire.keys()]; }
      },
    };
  })();

  const telechargements = new Map();
  /** Photo d'un contenant : celle gardée sur l'appareil, sinon téléchargée puis gardée. */
  async function obtenirPhoto(id) {
    if (!id) return '';
    const locale = await Photos.lire(id);
    if (locale || id.startsWith('local-')) return locale;
    if (!telechargements.has(id)) {
      telechargements.set(id, (async () => {
        try {
          const rep = await App.appeler('photo', { id });
          if (!rep.ok || !rep.photo) return '';
          await Photos.ecrire(id, rep.photo);
          return rep.photo;
        } catch (e) {
          return '';
        } finally {
          telechargements.delete(id);
        }
      })());
    }
    return telechargements.get(id);
  }

  /** Recadrage (outil commun recadrage.js) : résout { donnees, transformer } ou null si annulé. */
  const recadrerImage = (source, cote = 1280) => Recadrage.recadrer(source, { cote, max: PHOTO_MAX });

  // ---------- Synchronisation ----------
  function etatSynchro(texte, classe = '') {
    synchro.texte = texte;
    synchro.classe = classe;
    const ligne = zone && zone.querySelector('.inv-synchro');
    if (ligne) majLigneSynchro(ligne);
  }
  function majLigneSynchro(ligne) {
    const attente = App.fileAttente().filter((e) => e.action === 'verifierInventaire').length;
    const morceaux = [synchro.texte, attente ? `${pluriel(attente, 'vérification')} en attente d'envoi.` : '', synchro.photos].filter(Boolean);
    ligne.textContent = morceaux.join(' ');
    ligne.className = `message inv-synchro ${synchro.classe}`.trim();
    ligne.hidden = !morceaux.length;
  }

  let minuterieEnvoi = null;
  function programmerEnvoi() {
    etatSynchro('Modification gardée sur cet appareil…');
    clearTimeout(minuterieEnvoi);
    minuterieEnvoi = setTimeout(synchroniser, 2500);
  }

  class RefusServeur extends Error {}

  /** Envoie les modifications de l'administrateur : d'abord les fiches de la base, puis les photos, puis les contenants. */
  async function pousser() {
    etatSynchro('Envoi des modifications…');
    // Photos des fiches de la base prises sur cet appareil : envoyées avant les fiches.
    for (const id of Object.keys(modifs.fiches)) {
      const f = structure.catalogue[id];
      if (!f || !f.photo.startsWith('local-')) continue;
      const locale = f.photo;
      const donnees = await Photos.lire(locale);
      let distante = '';
      if (donnees) {
        const repPhoto = await App.appeler('envoyerPhotoInventaire', { photo: donnees });
        if (!repPhoto.ok) throw new RefusServeur(repPhoto.erreur || 'photo refusée');
        distante = repPhoto.id;
        await Photos.ecrire(distante, donnees);
      }
      f.photo = distante;
      modifs.fiches[id] += 1;
      await Photos.supprimer(locale);
      sauverStructure();
      sauverModifs();
    }
    const fichesEnvoyees = { ...modifs.fiches };
    if (Object.keys(fichesEnvoyees).length) {
      const repFiches = await App.appeler('enregistrerCatalogue', { fiches: Object.keys(fichesEnvoyees).map((id) => structure.catalogue[id]).filter(Boolean) });
      if (!repFiches.ok) throw new RefusServeur(repFiches.erreur || 'base des articles refusée');
      Object.keys(fichesEnvoyees).forEach((id) => { if (modifs.fiches[id] === fichesEnvoyees[id]) delete modifs.fiches[id]; });
      sauverModifs();
    }
    for (const id of Object.keys(modifs.ids)) {
      const c = structure.contenants[id];
      if (!c) continue;
      for (const locale of photosDe(c).filter((ph) => ph.startsWith('local-'))) {
        const donnees = await Photos.lire(locale);
        let distante = '';
        if (donnees) {
          const rep = await App.appeler('envoyerPhotoInventaire', { photo: donnees });
          if (!rep.ok) throw new RefusServeur(rep.erreur || 'photo refusée');
          distante = rep.id;
          await Photos.ecrire(distante, donnees);
        }
        // Une copie d'inventaire peut partager la même photo en attente (photo principale ou vue).
        Object.values(structure.contenants).forEach((x) => {
          let change = false;
          if (x.photo === locale) { x.photo = distante; change = true; }
          if (x.vignette === locale) { x.vignette = distante; change = true; }
          x.vues.forEach((v) => { if (v.photo === locale) { v.photo = distante; change = true; } });
          // État du type gardé par un exemplaire : même traduction, sinon la photo passerait pour une personnalisation.
          if (x.base) {
            if (x.base.photo === locale) { x.base.photo = distante; change = true; }
            if (x.base.vignette === locale) { x.base.vignette = distante; change = true; }
            (x.base.vues || []).forEach((v) => { if (v.photo === locale) { v.photo = distante; change = true; } });
          }
          if (change) modifs.ids[x.id] = (modifs.ids[x.id] || 0) + 1;
        });
        await Photos.supprimer(locale);
        sauverStructure();
        sauverModifs();
      }
    }
    const envoyes = { ...modifs.ids };
    const reglages = modifs.reglages;
    const rep = await App.appeler('enregistrerContenants', {
      contenants: Object.keys(envoyes).map((id) => structure.contenants[id]).filter(Boolean),
      reglages: reglages ? structure.reglages : undefined,
    });
    if (!rep.ok) throw new RefusServeur(rep.erreur || 'refus du serveur');
    // Un contenant modifié de nouveau pendant l'envoi reste à envoyer.
    Object.keys(envoyes).forEach((id) => { if (modifs.ids[id] === envoyes[id]) delete modifs.ids[id]; });
    if (reglages) modifs.reglages = false;
    sauverModifs();
  }

  /** Relit les inventaires et leur état sur le serveur. */
  /** JSON aux clés triées : deux objets de même contenu donnent le même texte, quel que soit l'ordre des champs. */
  function canonique(v) {
    if (Array.isArray(v)) return `[${v.map(canonique).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonique(v[k])}`).join(',')}}`;
    return JSON.stringify(v);
  }
  const identiques = (a, b) => canonique(normaliser(a)) === canonique(normaliser(b));
  let changeDistant = false; // un inventaire affiché a été modifié ailleurs (autre appareil, Sheet)

  async function tirer() {
    const rep = await App.appeler('lireInventaires');
    if (!rep.ok) {
      synchro.serveurInconnu = rep.erreur === 'Action inconnue';
      if (!rep.reconnecter) throw new RefusServeur(synchro.serveurInconnu ? 'inventaires pas encore installés sur le serveur' : (rep.erreur || 'refus du serveur'));
      return;
    }
    synchro.serveurInconnu = false;
    versionServeur = Number(rep.version) || 0;
    if (typeof Desarmement !== 'undefined') Desarmement.majServeur(rep.armement, rep.desarmements);
    // Liens appareil → contenant partagés (serveur v33) ; ce qui n'est pas encore envoyé de cet appareil prime.
    if (rep.liensAppareils && typeof rep.liensAppareils === 'object') {
      const liens = { ...rep.liensAppareils };
      App.fileAttente().filter((e) => e.action === 'lierAppareilContenant').forEach((e) => { if (e.contenant) liens[e.appareil] = e.contenant; else delete liens[e.appareil]; });
      ecrireJson(CLE_LIENS_APPAREILS, liens);
    }
    supprimesServeur = (Array.isArray(rep.supprimes) ? rep.supprimes : []).filter((c) => c && ID.test(c.id));
    const contenants = {};
    rep.contenants.forEach((c) => {
      if (!c || !ID.test(c.id)) return;
      const recu = normaliser(c);
      const local = structure.contenants[c.id];
      // Inventaire identique à celui de l'appareil (cas courant : on vient de l'envoyer) : on garde l'objet
      // de l'appareil, auquel l'écran affiché est relié. Le remplacer ferait partir les ajouts suivants
      // dans une copie qui n'est plus enregistrée.
      if (local && identiques(local, recu)) contenants[c.id] = local;
      else { contenants[c.id] = recu; if (local && !modifs.ids[c.id]) changeDistant = true; }
    });
    // Ce qui n'est pas encore envoyé reste tel que sur l'appareil.
    Object.keys(modifs.ids).forEach((id) => { if (structure.contenants[id]) contenants[id] = structure.contenants[id]; });
    const catalogue = {};
    (rep.catalogue || []).forEach((f) => { if (f && ID.test(f.id)) catalogue[f.id] = normaliserFiche(f); });
    Object.keys(modifs.fiches).forEach((id) => { if (structure.catalogue[id]) catalogue[id] = structure.catalogue[id]; });
    structure = { contenants, catalogue, reglages: modifs.reglages ? structure.reglages : { alerteJours: Number(rep.reglages && rep.reglages.alerteJours) || 30 } };

    // État : entre l'appareil (vérifications pas encore envoyées) et le serveur, le plus récent l'emporte.
    const recent = Date.now() - 2 * 86400000;
    const verifs = { ...rep.etat.verifs };
    // Une vérification absente du serveur n'est gardée que si elle attend encore d'être envoyée :
    // sinon elle a été retirée (réinitialisation du jour) et ne doit pas réapparaître sur cet appareil.
    const enAttente = new Set(App.fileAttente().filter((x) => x.action === 'verifierInventaire').map((x) => x.contenant));
    Object.entries(etat.verifs).forEach(([id, v]) => {
      if (verifs[id] ? v.date > verifs[id].date : (enAttente.has(id) && new Date(v.date).getTime() > recent)) verifs[id] = v;
    });
    const peremptions = { ...rep.etat.peremptions };
    Object.entries(etat.peremptions).forEach(([cle, p]) => {
      if (peremptions[cle] ? (p.maj || '') > (peremptions[cle].maj || '') : new Date(p.maj || 0).getTime() > recent) peremptions[cle] = p;
    });
    // Dernier « Oui » coché par contrôle : le plus récent entre l'appareil et le serveur (s'il le fournit).
    const dernierOui = { ...((rep.etat && rep.etat.dernierOui) || {}) };
    Object.entries(etat.dernierOui || {}).forEach(([cle, d]) => { if (!dernierOui[cle] || d > dernierOui[cle]) dernierOui[cle] = d; });
    etat = { verifs, peremptions, dernierOui };
    reappliquerDeplacements();
    sauverStructure();
    sauverEtat();
  }

  /** Télécharge les photos manquantes pour le hors ligne, puis oublie celles qui ne servent plus. */
  async function prechargerPhotos() {
    const vivants = Object.values(structure.contenants).filter((c) => !c.supprime);
    const utiles = new Set(vivants.flatMap(photosDe));
    // Photos des articles : seulement ceux présents dans un inventaire (inutile de tout télécharger).
    vivants.forEach((c) => c.articles.forEach((a) => { const f = fiche(a); if (f && f.photo) utiles.add(f.photo); }));
    Object.values(structure.catalogue).forEach((f) => { if (f.photo && f.photo.startsWith('local-')) utiles.add(f.photo); });
    const presentes = new Set(await Photos.cles());
    const manquantes = [...utiles].filter((id) => !presentes.has(id) && !id.startsWith('local-'));
    let recues = 0;
    for (const id of manquantes) {
      synchro.photos = `Téléchargement des photos pour le hors ligne : ${recues + 1} sur ${manquantes.length}…`;
      etatSynchro(synchro.texte, synchro.classe);
      if (await obtenirPhoto(id)) recues += 1;
    }
    synchro.photos = recues < manquantes.length ? `${pluriel(manquantes.length - recues, 'photo')} pas encore disponible(s) hors ligne.` : '';
    etatSynchro(synchro.texte, synchro.classe);
    for (const id of presentes) if (!utiles.has(id)) await Photos.supprimer(id);
  }

  async function synchroniser() {
    if (!App || !zone) return;
    if (synchro.enCours) { synchro.encore = true; return; }
    synchro.enCours = true;
    clearTimeout(minuterieEnvoi);
    let recu = false;
    try {
      const aEnvoyer = enAttente();
      if (aEnvoyer && estAdmin()) await pousser();
      await tirer();
      recu = true;
      etatSynchro(aEnvoyer ? 'Modifications enregistrées.' : '', 'succes');
    } catch (e) {
      const attente = enAttente();
      if (e instanceof RefusServeur) {
        etatSynchro(synchro.serveurInconnu
          ? (estAdmin() ? `Le serveur ne connaît pas encore les inventaires : ajouter Inventaires.gs dans Apps Script puis redéployer (README du backend).${attente ? ' Vos modifications restent sur cet appareil.' : ''}` : 'Les inventaires ne sont pas encore disponibles.')
          : `Refusé par le serveur : ${e.message}.${attente ? ' Vos modifications restent sur cet appareil.' : ''}`, 'erreur');
      } else {
        etatSynchro(attente ? 'Hors ligne : vos modifications sont gardées sur cet appareil et seront envoyées au retour du réseau.' : '');
      }
    } finally {
      synchro.enCours = false;
    }
    // On ne redessine pas sous les doigts de quelqu'un qui est en train de saisir.
    const saisie = zone.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    // Un inventaire modifié ailleurs est redessiné même pendant une saisie : l'écran doit montrer
    // (et modifier) la version à jour.
    if (recu && (changeDistant || !saisie) && !placement) rendre({ garderPosition: true });
    changeDistant = false;
    if (synchro.encore) { synchro.encore = false; synchroniser(); return; }
    if (recu) prechargerPhotos();
  }

  // ---------- Navigation ----------
  const BASE = '@base'; // « #inv-base » : base des articles
  const TABLEAU = '@tableau'; // « #inv-tableau » : tableau de bord des contenants primaires
  function idCourant() {
    if (location.hash === '#inv-base') return BASE;
    if (location.hash === '#inv-tableau') return TABLEAU;
    const m = /^#inv=([a-z0-9]{6,16})$/.exec(location.hash);
    return m ? m[1] : '';
  }
  const lien = (id) => (id === BASE ? '#inv-base' : (id === TABLEAU ? '#inv-tableau' : (id ? `#inv=${id}` : '#inv')));
  function aller(id) {
    placement = '';
    confirmer = '';
    if (idCourant() === (id || '')) rendre();
    // Remonter vers le niveau d'où l'on vient : on recule dans l'historique au lieu de l'allonger,
    // pour que le bouton Retour du téléphone ne repasse pas par l'inventaire qu'on vient de quitter.
    else {
      // Plusieurs étages d'un coup (ex. retour au véhicule après le dernier sous-contenant) : on recule d'autant.
      location.hash = lien(id);
    }
  }
  /** Adresse complète d'un contenant : celle du QR code et de la puce NFC. */
  function adresse(id) {
    return `${location.origin}${location.pathname.replace(/index\.html$/, '')}#inv=${id}`;
  }

  // ---------- Brouillon de vérification ----------
  function brouillon(c) {
    brouillonsDuJour();
    if (!brouillons.liste[c.id]) {
      const v = verifDuJour(c.id);
      const coches = {};
      if (v) {
        const manquants = new Set(v.manquants.map((m) => m.id));
        aCocher(c).forEach((a) => { if (!manquants.has(a.id)) coches[a.id] = true; });
      }
      // Valeurs : celles du jour si déjà vérifié ; sinon, le n° scanné la dernière fois (même appareil en général).
      const valeurs = {};
      const der = etat.verifs[c.id];
      aCocher(c).filter(estControle).forEach((a) => {
        const dv = der && der.valeurs ? der.valeurs[a.id] : undefined;
        if (dv !== undefined && v) valeurs[a.id] = dv; // jamais la valeur de la veille : l'agent relit ou scanne
      });
      brouillons.liste[c.id] = { coches, quantites: {}, dates: {}, invalides: {}, valeurs, remarque: v ? v.remarque : '' };
    }
    const b = brouillons.liste[c.id];
    if (!b.quantites) b.quantites = {};
    if (!b.valeurs) b.valeurs = {};
    return b;
  }
  /** Quantité attendue (nombre) d'un article, ou null s'il n'en a pas. */
  const attendue = (a) => (/^\d+$/.test(String(a.quantite || '').trim()) ? Number(a.quantite) : null);
  /** Quantité trouvée : par défaut, la quantité attendue. */
  /** Quantité minimale (ex. consommables conditionnés par boîtes : « au moins 10 ») ; sinon quantité exacte. */
  const estMinimum = (a) => Boolean(a && a.quantiteMin === true);
  /** Quantité trouvée hors attente : en dessous, ou au-dessus si la quantité doit être exacte. */
  const ecartQuantite = (att, qte, min) => qte < att || (!min && qte > att);
  /** « 8/10 » (exacte) ou « 8/≥10 » (minimale). */
  const texteQuantite = (qte, att, min) => `${qte}/${min ? '≥' : ''}${att}`;
  const trouvee = (a, b) => (b.quantites[a.id] !== undefined ? b.quantites[a.id] : attendue(a));
  const dateCourante = (c, a, b) => (b.dates[a.id] !== undefined ? b.dates[a.id] : datePeremption(c.id, a.id));

  /** Ce que la vérification en cours relève pour un article (coché, valeur du contrôle, quantité trouvée, date). */
  function articleDuJour(c, a, b) {
    if (estControle(a)) {
      const val = String(b.valeurs[a.id] === undefined ? '' : b.valeurs[a.id]).trim();
      return { id: a.id, nom: nomArticle(a), controle: a.controle, ok: evaluer(a, val).ok, valeur: val, libelle: texteValeur(a, val), ...(estFacultatif(a) ? { facultatif: true } : {}) };
    }
    const att = attendue(a);
    const qte = trouvee(a, b);
    return {
      id: a.id, nom: nomArticle(a), ok: Boolean(b.coches[a.id]), ...(estFacultatif(a) ? { facultatif: true } : {}),
      ...(att !== null ? { attendu: att, quantite: qte === null || qte === '' ? 0 : Number(qte), ...(estMinimum(a) ? { min: true } : {}) } : {}),
      ...(suiviPeremption(a) ? { peremption: dateCourante(c, a, b) } : {}),
    };
  }
  /** Manquant : non coché, ou coché avec une quantité inférieure à celle attendue (jamais pour un article facultatif). */
  const articleIncomplet = (a) => !a.facultatif && (!a.ok || (a.attendu !== undefined && ecartQuantite(a.attendu, a.quantite, a.min)));
  /** Le champ à corriger pour un article incomplet : la saisie du contrôle, la quantité, ou la ligne à cocher. */
  function champIncomplet(li, x) {
    if (x.controle) return li.querySelector('.inv-valeur-zone, .inv-oui-non, .inv-batterie4');
    if (x.ok && x.attendu !== undefined) return li.querySelector('.inv-qte');
    return li.querySelector('.inv-ligne');
  }
  /** Entoure en rouge les champs des articles incomplets et amène l'utilisateur sur le premier. */
  function signalerManquants(c, ids) {
    zone.querySelectorAll('.champ-manquant').forEach((n) => n.classList.remove('champ-manquant'));
    const b = brouillon(c);
    let premier = null;
    ids.forEach((id) => {
      const li = zone.querySelector(`li[data-article="${id}"]`);
      const a = aCocher(c).find((x) => x.id === id);
      const champ = li && a && champIncomplet(li, articleDuJour(c, a, b));
      if (!champ) return;
      champ.classList.add('champ-manquant');
      if (!premier) premier = champ;
    });
    if (!premier) return;
    premier.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  /** Retire le cadre rouge des champs qui viennent d'être corrigés. */
  function majSignalement(c, b) {
    zone.querySelectorAll('.champ-manquant').forEach((champ) => {
      const li = champ.closest('li[data-article]');
      const a = li && aCocher(c).find((x) => x.id === li.getAttribute('data-article'));
      if (!a || !articleIncomplet(articleDuJour(c, a, b))) champ.classList.remove('champ-manquant');
    });
  }

  function valider(c) {
    if (enConsultation(c)) { messageVue('Consultation seule : indiquez d\'abord le contenant primaire où vous êtes.', 'erreur'); return; }
    const b = brouillon(c);
    if (aCocher(c).some((a) => b.invalides[a.id])) {
      messageVue('Une date de péremption n\'est pas reconnue : corrigez-la (ex. 03/2027 ou 15/03/2027).', 'erreur');
      return;
    }
    const articles = aCocher(c).map((a) => articleDuJour(c, a, b));
    const manquants = articles.filter(articleIncomplet);
    if (manquants.length && confirmer !== `valider-${c.id}`) {
      confirmer = `valider-${c.id}`;
      const libelle = (a) => (a.controle ? `${a.nom} (${a.libelle})` : (a.ok ? `${a.nom} (${texteQuantite(a.quantite, a.attendu, a.min)})` : a.nom));
      messageVue(`Sera noté manquant ou en anomalie : ${manquants.map(libelle).join(' ; ')}. Corrigez ou appuyez de nouveau pour valider quand même.`, 'erreur');
      zone.querySelector('.inv-valider').textContent = 'Valider quand même';
      signalerManquants(c, manquants.map((a) => a.id));
      return;
    }
    const ok = App.mettreEnFile({
      action: 'verifierInventaire', contenant: c.id,
      detail: { chemin: cheminNoms(c.id, ' > '), articles: articles.map(({ libelle, ...x }) => x), remarque: b.remarque.trim() },
    });
    if (!ok) {
      messageVue('Non enregistré : la mémoire de l\'appareil est pleine.', 'erreur');
      return;
    }
    // Affiché tout de suite, sans attendre la réponse du serveur.
    const maintenant = new Date().toISOString();
    const valeurs = {};
    articles.filter((a) => a.controle).forEach((a) => { valeurs[a.id] = a.valeur; });
    etat.verifs[c.id] = { date: maintenant, agent: App.agent(), manquants: manquants.map((a) => ({ id: a.id, nom: a.controle ? `${a.nom} (${a.libelle})` : (a.ok ? `${a.nom} (${texteQuantite(a.quantite, a.attendu, a.min)})` : a.nom) })), remarque: b.remarque.trim(), valeurs };
    articles.filter((a) => a.peremption !== undefined).forEach((a) => { etat.peremptions[`${c.id}/${a.id}`] = { date: a.peremption, maj: maintenant }; });
    // Contrôle Oui / Non : on retient la dernière fois que « Oui » a été coché.
    if (!etat.dernierOui) etat.dernierOui = {};
    articles.filter((a) => a.controle === 'oui' && a.valeur === 'Oui').forEach((a) => { etat.dernierOui[`${c.id}/${a.id}`] = maintenant; });
    delete brouillons.liste[c.id];
    sauverEtat();
    sauverBrouillons();
    confirmer = '';
    avis = `« ${c.nom} » vérifié${manquants.length ? ` : ${pluriel(manquants.length, 'manquant')}` : ''}.`;
    // S'il reste des sous-inventaires à vérifier, on reste ici. Sinon on remonte au contenant du dessus ;
    // si celui-ci est à son tour entièrement vérifié, on remonte encore (ex. dernier sous-contenant de B
    // validé → B est complet → retour à F21), jusqu'au premier étage incomplet ou au contenant primaire.
    // (L'emplacement s'efface derrière son occupant : on ne passe que par les niveaux visibles.)
    remonterApresValidation(c);
  }

  /**
   * Après une validation : s'il reste des sous-inventaires à faire, on reste ici. Sinon on remonte
   * au premier étage du dessus qui n'est pas entièrement vérifié (ex. dernier sous-contenant de B validé,
   * B complet → retour à F21), ou au contenant primaire si tout est fait.
   */
  function remonterApresValidation(c) {
    const aFinir = (x) => { const bx = bilan(x.id); return bx.total > 0 && !bx.complet; };
    if (enfants(c.id).some(aFinir)) { rendre(); return; }
    const etages = etagesAuDessus(c);
    const cible = etages.find(aFinir) || etages[etages.length - 1];
    allerDirect(cible ? cible.id : '');
  }
  /** Comme aller(), mais sans passer par l'historique : arrive toujours sur le bon inventaire. */
  function allerDirect(id) {
    placement = '';
    confirmer = '';
    if (idCourant() === (id || '')) rendre();
    else location.hash = lien(id);
  }

  // ---------- Vues ----------
  function messageVue(texte, classe = '') {
    const p = zone.querySelector('.inv-message');
    if (!p) return;
    p.textContent = texte;
    p.className = `message inv-message ${classe}`.trim();
    p.hidden = !texte;
    if (texte) p.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /** Fenêtre « Manquants » : ce qui a été noté manquant aujourd'hui, par inventaire, puis les remarques (non comptées). */
  function fenetreManquants(b) {
    const racine = contenant(b.racine);
    const fond = el('div', { classe: 'fenetre-fond', surclick: (e) => { if (e.target === fond) fermer(); } });
    const retour = document.activeElement;
    const fermer = () => { fond.remove(); document.body.classList.remove('fenetre-ouverte'); if (retour && retour.isConnected) retour.focus(); };
    const titre = idChamp();
    const groupes = (liste) => {
      const parOu = new Map();
      liste.forEach((x) => { if (!parOu.has(x.ou)) parOu.set(x.ou, []); parOu.get(x.ou).push(x); });
      return [...parOu.entries()];
    };
    const nomOu = (id) => (id === b.racine ? '' : chemin(id).slice(chemin(b.racine).length).filter((x, i, t) => !x.emplacement || i === t.length - 1).map((x) => x.nom).join(' › '));
    const lienOu = (id) => (id === b.racine ? null : el('a', { href: lien(id), classe: 'inv-manquants-ou', surclick: (e) => { e.preventDefault(); fermer(); aller(id); } }, nomOu(id)));
    fond.append(el('div', { classe: 'fenetre inv-tb-fenetre', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titre },
      el('div', { classe: 'fenetre-entete' }, el('h2', { id: titre, texte: `${pluriel(b.manquants, 'manquant')}${racine ? ` — ${racine.nom}` : ''}` }),
        el('button', { type: 'button', classe: 'fenetre-fermer', 'aria-label': 'Fermer', texte: '✕', surclick: fermer })),
      ...groupes(b.listeManquants).map(([ou, liste]) => el('section', { classe: 'inv-tb-rubrique' },
        lienOu(ou) ? el('h3', {}, lienOu(ou)) : null,
        el('ul', {}, ...liste.map((x) => el('li', { classe: 'rouge', texte: x.nom }))))),
      b.remarques.length ? el('section', { classe: 'inv-tb-rubrique' }, el('h3', { texte: 'Remarques (non comptées)' }),
        el('ul', {}, ...b.remarques.map((r) => el('li', {}, r.texte, el('small', { texte: ` — ${[nomOu(r.ou), r.agent].filter(Boolean).join(', ')}` }))))) : null));
    fond.addEventListener('keydown', (e) => { if (e.key === 'Escape') fermer(); });
    document.body.append(fond);
    document.body.classList.add('fenetre-ouverte');
    fond.querySelector('.fenetre-fermer').focus();
  }
  function badges(b) {
    const liste = [];
    if (b.manquants) {
      // Souvent dans une carte (lien) : le badge ouvre le détail sans suivre le lien.
      const ouvrir = (e) => { e.preventDefault(); e.stopPropagation(); fenetreManquants(b); };
      liste.push(el('span', { classe: 'inv-badge alerte inv-badge-cliquable inv-badge-manquant', role: 'button', tabindex: '0', title: 'Voir ce qui manque',
        'aria-label': `${pluriel(b.manquants, 'manquant')} : voir le détail`, texte: pluriel(b.manquants, 'manquant'),
        surclick: ouvrir, surkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') ouvrir(e); } }));
    }
    if (b.perimes) liste.push(el('span', { classe: 'inv-badge alerte', texte: pluriel(b.perimes, 'périmé') }));
    if (b.proches) liste.push(el('span', { classe: 'inv-badge proche', texte: `${b.proches} bientôt périmé${b.proches > 1 ? 's' : ''}` }));
    if (b.sansDate) liste.push(el('span', { classe: 'inv-badge', texte: `${pluriel(b.sansDate, 'date')} à saisir` }));
    if (b.vides) liste.push(el('span', { classe: 'inv-badge proche', texte: `${pluriel(b.vides, 'emplacement')} à identifier` }));
    if (b.ambManquants) liste.push(el('span', { classe: 'inv-badge alerte inv-badge-manquant', texte: `${pluriel(b.ambManquants, 'manquant')} (ambulancier)` }));
    if (b.oxygeneBas) liste.push(el('span', { classe: 'inv-badge alerte', texte: `${pluriel(b.oxygeneBas, 'bouteille')} O₂ basse${b.oxygeneBas > 1 ? 's' : ''}` }));
    return liste;
  }

  /** Carte cliquable d'un contenant : repère (numéro du point ou vignette), nom, état. */
  /** Photo d'un contenant : la principale, sinon celle de sa première vue qui en a une. */
  const photoDe = (x) => (x ? x.photo || ((x.vues || []).find((v) => v.photo) || {}).photo || '' : '');
  /** Miniature d'un sous-inventaire (à côté de son numéro), s'il a une photo. */
  function miniature(x) {
    const id = photoDe(x);
    if (!id) return null;
    const bloc = el('span', { classe: 'inv-carte-photo', 'aria-hidden': 'true' });
    const poser = (d) => { if (d) bloc.append(el('img', { src: d, alt: '' })); else bloc.remove(); };
    if (Photos.enMemoire(id)) poser(Photos.enMemoire(id)); else obtenirPhoto(id).then(poser, () => bloc.remove());
    return bloc;
  }
  /** `numero` : rang du sous-inventaire (gommette) ; `texte` : texte de sa gommette s'il remplace le numéro. */
  function carte(c, numero, texte, icone) {
    if (!gestion && !numero && c.categorie === 'primaire' && vehiculeDesarme(c)) return carteDesarme(c);
    const b = bilan(c.id);
    const t = numero ? (texte === undefined ? String(numero) : texte) : '';
    const repere = el('span', { classe: `inv-repere ${b.classe}${numero ? (icone ? ' avec-icone' : classesTexte(t)) : ''}`, 'aria-hidden': 'true', texte: icone ? '' : t });
    if (numero && icone) repere.append(logoGommette(icone));
    // Vignette : image choisie pour la liste (ex. photo du véhicule), sinon la photo d'inventaire.
    const imageCarte = numero ? '' : (c.vignette || c.photo);
    if (imageCarte) {
      const vignette = (donnees) => { if (donnees) repere.append(el('img', { src: donnees, alt: '' })); };
      if (Photos.enMemoire(imageCarte)) vignette(Photos.enMemoire(imageCarte));
      else obtenirPhoto(imageCarte).then(vignette);
    } else if (!numero && c.stock) {
      // Caisses sans photo : pictogramme de caisse.
      const ns = 'http://www.w3.org/2000/svg';
      const ic = document.createElementNS(ns, 'svg');
      ic.setAttribute('viewBox', '0 0 28 24'); ic.setAttribute('class', 'inv-picto-caisse'); ic.setAttribute('aria-hidden', 'true');
      ic.innerHTML = '<rect x="2" y="5" width="24" height="17" rx="1.5" fill="currentColor" opacity=".18" stroke="currentColor" stroke-width="2"/>'
        + '<path d="M2 11h24M9 5v4m10-4v4M10 15h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
      repere.append(ic);
    }
    // Check-list : un contenant mobile pas encore pointé aujourd'hui reste anonyme — l'agent doit le lire ou le scanner.
    if (!gestion && masquerMobile(c)) {
      return el('a', { classe: `inv-carte ${b.classe}`, href: lien(c.id) }, repere,
        el('span', { classe: 'inv-carte-texte' },
          el('strong', { texte: 'Contenant mobile' }),
          el('span', { classe: 'inv-carte-occupant vide', texte: 'à identifier (QR, NFC ou liste)' })),
        el('span', { classe: 'inv-chevron', 'aria-hidden': 'true', texte: '›' }));
    }
    const sous = c.emplacement ? 0 : enfants(c.id).length;
    const occupant = c.emplacement ? (gestion ? enfants(c.id)[0] : occupantDuJour(c)) : null;
    // Check-list : un emplacement occupé se présente sous le nom du contenant qui l'occupe (pas celui de l'inventaire type).
    if (c.emplacement && !gestion) {
      return el('a', { classe: `inv-carte ${b.classe}`, href: lien(c.id) }, repere, numero ? miniature(occupant || c) : null,
        el('span', { classe: 'inv-carte-texte' },
          el('strong', { texte: occupant ? occupant.nom : c.nom }),
          occupant ? null : el('span', { classe: 'inv-carte-occupant vide', texte: 'à identifier (QR, NFC ou liste)' }),
          el('span', { classe: 'inv-carte-etat' }, b.complet ? '✓ ' : '', b.texte),
          el('span', { classe: 'inv-badges' }, ...badges(b))),
        el('span', { classe: 'inv-chevron', 'aria-hidden': 'true', texte: '›' }));
    }
    return el('a', { classe: `inv-carte ${b.classe}`, href: lien(c.id) }, repere, numero ? miniature(c.emplacement ? occupant || c : c) : null,
      el('span', { classe: 'inv-carte-texte' },
        el('strong', {}, c.nom, c.categorie && c.categorie !== 'primaire' && !c.emplacement ? el('span', { classe: `inv-tag-scellable inv-tag-${c.categorie}`, texte: CATEGORIES_CONTENANT[c.categorie].nom }) : null,
          c.scellable ? el('span', { classe: 'inv-tag-scellable', texte: 'Scellable' }) : null,
          c.traceur ? el('span', { classe: 'inv-tag-scellable', title: `Traceur GeoTraceSMUR : ${c.traceur}`, texte: '📡' }) : null,
          c.modele ? el('span', { classe: 'inv-tag-scellable inv-tag-modele', texte: `Type · ${pluriel(exemplairesReels(c.id).length, 'exemplaire')}` }) : null,
          c.emplacement ? el('span', { classe: 'inv-tag-scellable inv-tag-emplacement', texte: 'Emplacement' }) : null,
          // Gestion : rappel qu'il est masqué en check-list hors condition (ex. « si Schiller T7 »).
          gestion && c.emplacement && c.emplacement.si && c.emplacement.si.modeles.length ? el('span', { classe: 'inv-tag-scellable inv-tag-emplacement', title: 'Masqué en check-list si la condition n\'est pas remplie', texte: `si ${c.emplacement.si.modeles.map((m) => (contenant(m) || {}).nom || '?').join(' / ')}` }) : null),
        c.emplacement ? el('span', { classe: `inv-carte-occupant${occupant ? '' : ' vide'}`, texte: occupant ? `↳ ${occupant.nom}` : '↳ à identifier (QR, NFC ou liste)' }) : null,
        el('span', { classe: 'inv-carte-etat' }, b.complet ? '✓ ' : '', b.texte,
          sous ? ` · ${pluriel(sous, 'sous-inventaire')}` : ''),
        // Véhicule : état de sa check-list ambulancier du jour (données communes aux deux check-lists).
        !numero && !gestion ? ligneAmbulancier(vehiculeDuPrimaire(c), { court: true }) : null,
        el('span', { classe: 'inv-badges' }, ...badges(b))),
      el('span', { classe: 'inv-chevron', 'aria-hidden': 'true', texte: '›' }));
  }

  /**
   * Inventaires de la page d'accueil en tuiles (2 par ligne sur téléphone). En gestion, chaque tuile porte
   * une poignée « ⠿ » : glisser pour changer l'ordre (enregistré dans `ordre`, commun à tous les appareils).
   */
  /** Véhicule désarmé : tuile grise hachurée, sans inventaire ; au toucher, devenir du contenu (ou la question). */
  function carteDesarme(c) {
    const v = vehiculeDuPrimaire(c);
    const e = typeof Desarmement !== 'undefined' ? Desarmement.desarmements()[v.id] : null;
    const aLocaliser = !e || e.statut === 'attente';
    const repere = el('span', { classe: 'inv-repere', 'aria-hidden': 'true' });
    const image = c.vignette || c.photo;
    if (image) {
      const vignette = (donnees) => { if (donnees) repere.append(el('img', { src: donnees, alt: '' })); };
      if (Photos.enMemoire(image)) vignette(Photos.enMemoire(image)); else obtenirPhoto(image).then(vignette);
    }
    return el('button', { type: 'button', classe: 'inv-carte inv-desarme', surclick: () => infoDesarme(v.id) }, repere,
      el('span', { classe: 'inv-carte-texte' },
        el('strong', { texte: c.nom }),
        el('span', { classe: 'inv-carte-etat', texte: aLocaliser ? 'Désarmé · contenu à localiser' : 'Désarmé' })));
  }
  /** Où est le contenu des tiroirs et placards du véhicule désarmé ; non renseigné : on le demande. */
  async function infoDesarme(vehicule) {
    if (typeof Desarmement === 'undefined') return;
    if (await Desarmement.info(vehicule)) { avis = Desarmement.estDesarme(vehicule) ? 'Contenu renseigné : les péremptions suivent.' : `${vehicule} réarmé${navigator.onLine ? '' : ' : envoi au retour du réseau'}.`; rendre({ garderPosition: true }); }
  }

  function listeTuiles(liste) {
    const ul = el('ul', { classe: 'inv-liste inv-tuiles' });
    liste.forEach((c) => {
      const li = el('li', { 'data-cle': c.id }, carte(c));
      if (edition) { li.classList.add('inv-ligne-triable'); li.prepend(poignee(c.nom)); }
      ul.append(li);
    });
    if (edition) {
      ul.classList.add('inv-liste-triable');
      triable(ul, (cles) => {
        cles.forEach((id, rang) => { const x = contenant(id); if (x && x.ordre !== rang) { x.ordre = rang; marquer(x.id); } });
        rendre({ garderPosition: true });
      });
    }
    return ul;
  }

  /**
   * La modification des inventaires se fait dans l'administration (menu > Administration >
   * Gestion des inventaires). On reste dans ce mode en naviguant ; pour réaliser un inventaire,
   * on repasse par le menu (Inventaires).
   */
  function bandeauGestion(c = null) {
    if (!gestion) return null;
    const ancien = versionServeur !== null && versionServeur < VERSION_SERVEUR
      ? el('p', { classe: 'message erreur inv-serveur-ancien', role: 'alert' },
        el('strong', { texte: 'Serveur pas à jour : certaines modifications ne seront pas enregistrées' }),
        ' (catégorie des contenants, vues, inventaires types…). Recopiez Inventaires.gs, Catalogue.gs, Code.gs et Installation.gs du dépôt AVISMUR-backend dans Apps Script, puis Déployer › Gérer les déploiements › nouvelle version.')
      : null;
    // Une ligne : on est en gestion (tout est enregistré au fur et à mesure) ; passer en check-list sur le même contenant.
    const verifiable = c && !dansUnModele(c.id) && !c.emplacement;
    return el('div', {}, ancien, el('p', { classe: 'inv-bandeau-gestion' },
      el('span', { title: 'Les modifications sont enregistrées au fur et à mesure (sur l\'appareil puis sur le serveur).' }, el('strong', { texte: 'Mode gestion' }), el('small', { classe: 'inv-bandeau-detail', texte: ' · enregistré au fur et à mesure' })),
      typeof ouvrirVue === 'function' ? el('button', { type: 'button', classe: 'lien inv-vers-checklist',
        texte: verifiable ? 'Vérifier ce contenant ›' : (c ? 'Check-list ›' : 'Faire les inventaires ›'),
        surclick: () => { if (c && !verifiable) aller(''); ouvrirVue('inventaires'); } }) : null));
  }

  function ligneSynchro() {
    const ligne = el('p', { classe: 'message inv-synchro', role: 'status' });
    majLigneSynchro(ligne);
    return ligne;
  }

  function ligneAvis() {
    const p = el('p', { classe: 'message succes inv-avis', role: 'status', texte: avis, hidden: !avis });
    avis = '';
    return p;
  }

  /** Formulaire d'ajout d'un inventaire (premier niveau) ou d'un sous-inventaire. */
  function formulaireAjout(parent) {
    const champ = idChamp();
    const saisie = el('input', { id: champ, maxlength: '80', autocomplete: 'off', placeholder: parent ? 'ex. Sacoche 1, Intercalaire, Pochette voies aériennes' : 'ex. Sac rouge 1re intention' });
    return el('form', {
      classe: 'inv-ajout',
      sursubmit: (e) => {
        e.preventDefault();
        const nom = saisie.value.trim();
        if (!nom) return;
        const fratrie = enfants(parent ? parent.id : '');
        const c = normaliser({ id: nouvelId(), parent: parent ? parent.id : '', nom, ordre: fratrie.length ? fratrie[fratrie.length - 1].ordre + 1 : 0 });
        structure.contenants[c.id] = c;
        marquer(c.id);
        // Nouveau contenant de premier niveau : on l'ouvre sur ses réglages (catégorie à choisir).
        if (!parent) { ajoutRacineOuvert = false; ongletDemande = 'reglages'; aller(c.id); return; }
        // Avec une photo, on enchaîne : toucher l'endroit où se trouve ce sous-inventaire.
        if (parent && vueCourante(parent).photo) { placement = c.id; rendre({ garderPosition: true }); zone.querySelector('.inv-photo').scrollIntoView({ block: 'center', behavior: 'smooth' }); }
        else rendre({ garderPosition: true, focus: '.inv-ajout input' });
      },
    }, el('label', { for: champ, texte: parent ? 'Ajouter un sous-inventaire' : 'Nouveau contenant (véhicule, réserve, sac type…)' }),
    el('div', { classe: 'cfg-ligne' }, saisie, el('button', { type: 'submit', classe: 'cfg-bouton', texte: 'Ajouter' })));
  }

  // ---------- Pictogrammes (traits, 24 × 24) ----------
  const TRACES = {
    retour: ['M19 12H5', 'M11 6l-6 6 6 6'],
    loupe: ['M10.5 4a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13z', 'M20 20l-4.8-4.8'],
    fermer: ['M6 6l12 12', 'M18 6L6 18'],
    ok: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z', 'M8.5 12.5l2.5 2.5 5-5.5'],
    anomalie: ['M12 4L2.8 19.5h18.4z', 'M12 10v4', 'M12 17v.01'],
    perime: ['M5 5h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z', 'M16 3v4', 'M8 3v4', 'M4 10h16', 'M10 13.5l4 4', 'M14 13.5l-4 4'],
    proche: ['M7 3h10', 'M7 21h10', 'M8 3c0 4 8 5 8 9s-8 5-8 9', 'M16 3c0 4-8 5-8 9s8 5 8 9'],
    date: ['M5 5h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z', 'M16 3v4', 'M8 3v4', 'M4 10h16', 'M12 14v.01', 'M12 17.5v.01'],
    branchement: ['M9 3v5', 'M15 3v5', 'M7 8h10v3a5 5 0 0 1-10 0z', 'M12 16v5'],
    debranche: ['M9 3v5', 'M15 3v5', 'M7 8h10v3a5 5 0 0 1-10 0z', 'M12 16v5', 'M3 3l18 18'],
    identifier: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z', 'M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.4', 'M12 17v.01'],
    afaire: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z'],
    consultation: ['M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z', 'M12 9.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5z'],
    lieu: ['M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z', 'M12 7a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5z'],
    appareil: ['M4 6h16v12H4z', 'M4 12h4l2-3 3 6 2-3h5'],
    changer: ['M4 8h14', 'M15 4l4 4-4 4', 'M20 16H6', 'M9 12l-4 4 4 4'],
  };
  /** Pictogramme : `nom` d'un tracé ci-dessus ; `etiquette` le rend lisible (sinon décoratif). */
  function picto(nom, etiquette = '', classe = '') {
    const svg = el('svg:svg', { viewBox: '0 0 24 24', classe: `inv-picto inv-picto-${nom} ${classe}`.trim(), fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', ...(etiquette ? { role: 'img', 'aria-label': etiquette } : { 'aria-hidden': 'true' }) },
      etiquette ? el('svg:title', { texte: etiquette }) : null,
      ...(TRACES[nom] || []).map((d) => el('svg:path', { d })));
    if (nom === 'afaire') svg.querySelector('path').setAttribute('stroke-dasharray', '3.5 3');
    return svg;
  }
  /** Batterie remplie selon le niveau relevé (0 à 1). */
  function pictoBatterie(niveau, etiquette, classe = '') {
    const largeur = Math.max(0, Math.min(1, niveau)) * 11;
    return el('svg:svg', { viewBox: '0 0 24 24', classe: `inv-picto inv-picto-batterie ${classe}`.trim(), role: 'img', 'aria-label': etiquette },
      el('svg:title', { texte: etiquette }),
      el('svg:rect', { x: '2.5', y: '7', width: '16', height: '10', rx: '2', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' }),
      el('svg:path', { d: 'M21 10.5v3', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' }),
      el('svg:rect', { x: '5', y: '9.5', width: String(largeur), height: '5', rx: '0.8', fill: 'currentColor' }));
  }

  // ---------- Barre du haut : flèche retour, contenant primaire, niveau affiché ----------
  const CLE_ASTUCE = 'avismur_inv_astuce_retour';
  /**
   * Fenêtre des étages (appui long sur la flèche) : du niveau le plus proche jusqu'à la page des inventaires.
   * `etages` : [{ nom, aller }] ; une ligne par étage, assez haute pour le pouce.
   */
  function choisirEtage(etages) {
    const fond = el('div', { classe: 'fenetre-fond', surclick: (e) => { if (e.target === fond) fermer(); } });
    const retour = document.activeElement;
    const fermer = () => { fond.remove(); document.body.classList.remove('fenetre-ouverte'); if (retour && retour.isConnected) retour.focus(); };
    const titre = idChamp();
    fond.append(el('div', { classe: 'fenetre inv-etages', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titre },
      el('div', { classe: 'fenetre-entete' }, el('h2', { id: titre, texte: 'Remonter à…' }),
        el('button', { type: 'button', classe: 'fenetre-fermer', 'aria-label': 'Fermer', texte: '✕', surclick: fermer })),
      el('ul', { classe: 'inv-etages-liste' }, ...etages.map((x, i) => el('li', {},
        el('button', { type: 'button', classe: `inv-etage${x.primaire ? ' primaire' : ''}`, surclick: () => { fermer(); x.aller(); } },
          el('span', { classe: 'inv-etage-rang', 'aria-hidden': 'true', texte: i === etages.length - 1 && !x.primaire ? '⌂' : String(i + 1) }),
          el('span', { classe: 'inv-etage-nom', texte: x.nom }),
          x.primaire ? el('small', { texte: 'contenant primaire' }) : null))))));
    fond.addEventListener('keydown', (e) => { if (e.key === 'Escape') fermer(); });
    document.body.append(fond);
    document.body.classList.add('fenetre-ouverte');
    const premier = fond.querySelector('.inv-etage');
    if (premier) premier.focus();
  }
  /**
   * Gestion : appui long sur une pastille → elle se décolle (vibration), suit le doigt,
   * et se pose là où on relâche. Un appui court ouvre le sous-inventaire (navigation par les gommettes).
   */
  function glisserPastille(pastille, img, c, vc, cible) {
    let minuterie = null;
    let saisie = false;
    let bouge = false;
    let idPointeur = null;
    const borne = (v) => Math.min(1, Math.max(0, v));
    const position = (e) => {
      const r = img.getBoundingClientRect();
      return { x: borne((e.clientX - r.left) / r.width), y: borne((e.clientY - r.top) / r.height) };
    };
    const annuler = () => { clearTimeout(minuterie); minuterie = null; };
    pastille.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      saisie = false; bouge = false; idPointeur = e.pointerId;
      annuler();
      minuterie = setTimeout(() => {
        saisie = true;
        if (navigator.vibrate) navigator.vibrate(20);
        pastille.classList.add('saisie');
        try { pastille.setPointerCapture(idPointeur); } catch (err) { /* pointeur déjà relâché */ }
      }, 450);
    });
    pastille.addEventListener('pointermove', (e) => {
      if (!saisie) return;
      e.preventDefault();
      bouge = true;
      const { x, y } = position(e);
      pastille.style.left = `${x * 100}%`;
      pastille.style.top = `${y * 100}%`;
    });
    const finir = (e, poser) => {
      annuler();
      if (!saisie) return;
      saisie = false;
      pastille.classList.remove('saisie');
      try { pastille.releasePointerCapture(idPointeur); } catch (err) { /* déjà libéré */ }
      if (poser && bouge) {
        poserGommette(c, vc, cible, position(e));
        placement = '';
        marquer(c.id);
      }
      pastille.dataset.glisse = '1'; // empêche le clic qui suit le relâcher
      rendre({ garderPosition: true });
    };
    pastille.addEventListener('pointerup', (e) => finir(e, true));
    pastille.addEventListener('pointercancel', (e) => finir(e, false));
    pastille.addEventListener('contextmenu', (e) => e.preventDefault());
    pastille.addEventListener('click', (e) => {
      if (pastille.dataset.glisse) { delete pastille.dataset.glisse; e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
  }

  /** Flèche retour : un appui remonte d'un étage ; un appui long (ou clic droit) propose de choisir l'étage. */
  function boutonRetour(retour, etages) {
    let minuterie = null;
    let long = false;
    const annuler = () => { clearTimeout(minuterie); minuterie = null; };
    const ouvrirEtages = () => { long = true; annuler(); if (navigator.vibrate) navigator.vibrate(15); choisirEtage(etages); };
    const titre = etages.length > 1 ? 'Retour (appui long : choisir l\'étage)' : 'Retour';
    return el('button', {
      type: 'button', classe: 'inv-retour', 'aria-label': etages.length > 1 ? 'Retour d\'un étage. Appui long ou clic droit : choisir l\'étage' : 'Retour', title: titre,
      surpointerdown: (e) => { long = false; if (etages.length > 1 && e.button === 0) minuterie = setTimeout(ouvrirEtages, 500); },
      surpointerup: annuler, surpointerleave: annuler, surpointercancel: annuler,
      surcontextmenu: (e) => { if (etages.length > 1) { e.preventDefault(); if (!long) ouvrirEtages(); } },
      surclick: (e) => { if (long) { long = false; e.preventDefault(); return; } retour(); },
    }, picto('retour'));
  }
  /** Liste « Je suis dans… » : tous les contenants primaires, celui donné en premier (toujours modifiable). */
  function choixPrimaire(actuel = '', suggere = '') {
    const primaires = Object.values(structure.contenants).filter((x) => !x.supprime && x.categorie === 'primaire' && !dansUnModele(x.id))
      .sort((x, y) => (y.id === suggere) - (x.id === suggere) || x.nom.localeCompare(y.nom, 'fr'));
    if (!primaires.length) return null;
    return el('select', { classe: 'inv-bande-action', 'aria-label': 'Je suis dans…', title: 'Changer le contenant primaire où je me trouve',
      surchange: (e) => { if (e.target.value && e.target.value !== actuel) { fixerContexte(e.target.value, false); rendre({ garderPosition: true }); } } },
      actuel ? null : el('option', { value: '', texte: 'Je suis dans…' }),
      ...primaires.map((x) => el('option', { value: x.id, texte: actuel ? x.nom : `Je suis dans ${x.nom}`, selected: x.id === actuel })));
  }
  /** Bande du contenant primaire : où l'on est (ou « consultation seule » après une recherche par le nom). */
  function bandeauPrimaire(c) {
    if (gestion) return null;
    const structurel = c ? primaireDe(c.id) : null;
    const ici = contenant(contexte.primaire);
    if (enConsultation(c) && ici && structurel && structurel.id !== ici.id && !contexte.consultation) {
      // Contenant mobile enregistré ailleurs : on reste où l'on est ; il se vérifie une fois identifié à sa place ici.
      return el('div', { classe: 'inv-bande-primaire consultation', role: 'status' }, picto('lieu'),
        el('span', { classe: 'inv-bande-texte' }, 'Vous êtes dans ', choixPrimaire(ici.id, structurel.id), ` · enregistré dans ${structurel.nom}`));
    }
    if (enConsultation(c)) {
      // Sans contenant primaire connu : l'agent dit dans lequel il se trouve pour pouvoir vérifier.
      return el('div', { classe: 'inv-bande-primaire consultation', role: 'status' }, picto('consultation'),
        el('span', { classe: 'inv-bande-texte' }, el('strong', { texte: 'Consultation seule' }), structurel ? ` · ${structurel.nom}` : ''),
        choixPrimaire('', structurel ? structurel.id : ''));
    }
    const p = contenant(contexte.primaire) || structurel;
    // Contenant mobile (ou rangé dans un mobile) : il ne dit pas où l'on est, le contenant primaire reste modifiable.
    const modifiable = c && p && dansUnMobile(c);
    return el('div', { classe: `inv-bande-primaire${p ? '' : ' aucun'}`, role: 'status' }, picto('lieu'),
      el('span', { classe: 'inv-bande-texte' }, p ? 'Vous vérifiez actuellement ' : '', modifiable ? choixPrimaire(p.id) : el('strong', { texte: p ? p.nom : 'Aucun contenant primaire' })),
      // Véhicule : sa check-list ambulancier du jour reste visible pendant tout l'inventaire.
      p ? ligneAmbulancier(vehiculeDuPrimaire(p), { court: true }) : null);
  }
  /**
   * Barre collée en haut de l'écran : bande du contenant primaire, puis flèche retour et nom du niveau affiché
   * (le chemin complet « Inventaires › F21 › … » est trop long pour un téléphone).
   */
  function barreHaut({ c = null, titre = '', retour, etages = [], h1 = true, bande = true, libelleRetour = '', changer = null }) {
    // À côté de la flèche : le contenant où elle ramène (le parent) ; le niveau affiché vient en dessous.
    if (libelleRetour) {
      return el('div', { classe: 'inv-barre-haut' }, bande ? bandeauPrimaire(c) : null,
        el('div', { classe: 'inv-barre-ligne' }, boutonRetour(retour, etages),
          el('button', { type: 'button', classe: 'inv-retour-nom', 'aria-hidden': 'true', tabindex: '-1', texte: libelleRetour, surclick: retour })),
        h1 ? el('div', { classe: 'inv-barre-ligne inv-barre-titre' }, el('h1', { tabindex: '-1', classe: 'inv-titre-niveau', texte: titre }),
          c && c.scellable ? el('span', { classe: 'inv-tag-scellable', texte: 'Scellable' }) : null,
          changer ? el('button', { type: 'button', classe: 'inv-changer', 'aria-label': 'Changer de contenant (erreur ou autre contenant)', title: 'Changer de contenant', surclick: changer }, picto('changer')) : null) : null);
    }
    const nom = h1 ? el('h1', { tabindex: '-1', classe: 'inv-titre-niveau', texte: titre }) : el('span', { classe: 'inv-titre-niveau secondaire', texte: titre });
    return el('div', { classe: 'inv-barre-haut' }, bande ? bandeauPrimaire(c) : null,
      el('div', { classe: 'inv-barre-ligne' }, boutonRetour(retour, etages), nom,
        c && c.scellable && h1 ? el('span', { classe: 'inv-tag-scellable', texte: 'Scellable' }) : null));
  }
  /** Barre du haut d'un contenant : la flèche remonte d'un étage (les emplacements s'effacent derrière leur occupant). */
  function barreContenant(c, { titre = c.nom, h1 = true, retour = null, libelleRetour = '' } = {}) {
    const dessus = etagesAuDessus(c);
    const etages = [...dessus.map((p) => ({ nom: p.nom, primaire: p.categorie === 'primaire', aller: () => aller(p.id) })),
      { nom: gestion ? 'Gestion des inventaires' : 'Tous les inventaires', aller: () => aller('') }];
    const parent = contenant(c.parent);
    const changeable = !gestion && !enConsultation(c) && c.categorie === 'mobile' && !dansUnModele(c.id) && parent && dessus.length;
    return barreHaut({ c, titre, h1, etages, retour: retour || (() => aller(dessus.length ? dessus[0].id : '')),
      libelleRetour: libelleRetour || (dessus.length ? dessus[0].nom : (gestion ? 'Gestion des inventaires' : 'Tous les inventaires')),
      changer: changeable ? () => changerContenant(c) : null });
  }
  /** Boutons QR code et NFC réduits à leur pictogramme (barre du bas, à côté de « Valider »). */
  function boutonsScanIcones() {
    return [
      el('button', { type: 'button', classe: 'inv-scan-icone', 'aria-label': 'Scanner un QR code', title: 'QR code', surclick: () => scanRapide('qr') }, logoQr()),
      el('button', { type: 'button', classe: 'inv-scan-icone', 'aria-label': 'Lire une puce NFC', title: 'NFC', surclick: () => scanRapide('nfc') }, logoNfc()),
    ];
  }

  // ----- Premier niveau -----
  function vueRacine() {
    if (gestion && estAdmin()) reparerEmplacements();
    const racines = enfants('');
    const tous = Object.values(structure.contenants).filter((c) => !c.supprime && (gestion || !dansUnModele(c.id)));
    // Base des articles et tableau de bord : par le menu. Ici, une loupe discrète déplie la recherche.
    const panneau = encadreRecherche(tous);
    const loupe = el('button', {
      type: 'button', classe: `inv-loupe${rechercheOuverte ? ' ouverte' : ''}`, 'aria-expanded': String(rechercheOuverte), 'aria-controls': panneau.id,
      'aria-label': rechercheOuverte ? 'Fermer la recherche' : 'Chercher un inventaire par son nom', title: 'Chercher un inventaire',
      surclick: () => {
        rechercheOuverte = !rechercheOuverte;
        if (!rechercheOuverte) recherche = '';
        rendre({ garderPosition: true, focus: rechercheOuverte ? '.inv-recherche-champ' : '.inv-loupe' });
      },
    }, picto(rechercheOuverte ? 'fermer' : 'loupe'));
    // Gestion : « + » à côté de la loupe déplie la création d'un contenant de premier niveau.
    const ajout = edition ? formulaireAjout(null) : null;
    if (ajout) { ajout.hidden = !ajoutRacineOuvert; ajout.classList.add('inv-ajout-racine'); }
    const plus = edition ? el('button', {
      type: 'button', classe: `inv-loupe inv-plus-racine${ajoutRacineOuvert ? ' ouverte' : ''}`, 'aria-expanded': String(ajoutRacineOuvert),
      'aria-label': 'Nouveau contenant (véhicule, réserve, inventaire type…)', title: 'Nouveau contenant', texte: ajoutRacineOuvert ? '−' : '+',
      surclick: () => { ajoutRacineOuvert = !ajoutRacineOuvert; rendre({ garderPosition: true, focus: ajoutRacineOuvert ? '.inv-ajout-racine input' : '.inv-plus-racine' }); },
    }) : null;
    const noeuds = [
      bandeauGestion(),
      el('div', { classe: 'inv-entete inv-entete-racine' }, el('h1', { tabindex: '-1', texte: gestion ? 'Gestion des inventaires' : 'Inventaires' }),
        el('span', { classe: 'inv-entete-outils' }, ...(gestion ? [] : boutonsScanIcones().map((b) => { b.classList.add('inv-scan-ecran-large'); return b; })), loupe, plus)),
      panneau, ajout,
      ligneSynchro(), ligneAvis(),
    ];
    noeuds.push(encadreARetrouver());
    if (!gestion) noeuds.push(encadreContenuALocaliser());
    if (!tous.length) {
      noeuds.push(el('p', { classe: 'consigne', texte: estAdmin()
        ? 'Aucun inventaire pour l\'instant. Menu > Administration > Gestion des inventaires pour créer le premier (un véhicule, la réserve…), puis ajoutez-lui une photo, des sous-inventaires et des articles.'
        : 'Aucun inventaire n\'a encore été créé.' }));
    }

    // Péremptions : tout ce qui est périmé ou le sera bientôt, avec le chemin pour y aller.
    const alertes = [];
    tous.forEach((c) => aCocher(c).filter(suiviPeremption).forEach((a) => {
      const date = datePeremption(c.id, a.id);
      const p = etatPeremption(date);
      if (dansUnModele(c.id)) return;
      if (p.niveau === 'perime' || p.niveau === 'proche') alertes.push({ c, a, date, p, jours: joursRestants(date) });
    }));
    if (alertes.length) {
      alertes.sort((x, y) => x.jours - y.jours);
      const perimes = alertes.filter((x) => x.p.niveau === 'perime').length;
      noeuds.push(el('details', { classe: 'inv-alertes' },
        el('summary', {}, 'Péremptions : ', [perimes ? pluriel(perimes, 'périmé') : '', alertes.length - perimes ? `${alertes.length - perimes} à moins de ${structure.reglages.alerteJours} jours` : ''].filter(Boolean).join(', ')),
        el('ul', {}, ...alertes.map((x) => el('li', { classe: x.p.niveau },
          el('a', { href: lien(x.c.id) }, el('strong', { texte: nomArticle(x.a) }), ` — ${cheminNoms(x.c.id)}`),
          el('span', { texte: `${afficherDate(x.date)} · ${x.p.texte}` }))))));
    }

    // Page des inventaires : seulement les contenants primaires (véhicules, réserve).
    // Véhicule désarmé : tuile grise hachurée, pas d'inventaire ; au toucher, où est passé le contenu des tiroirs.
    const primaires = tous.filter((c) => c.categorie === 'primaire' && !c.stock && !dansUnModele(c.id))
      .sort((x, y) => x.ordre - y.ordre || x.nom.localeCompare(y.nom, 'fr'));
    // Classés par famille : VML, AR (UMH), hélicoptère (F00), locaux (tout ce qui n'est pas un véhicule).
    const familles = [['VML', 'VML'], ['AR', 'AR'], ['HELICO', 'Hélicoptère'], ['LOCAUX', 'Locaux']];
    familles.forEach(([cle, titre]) => {
      const liste = primaires.filter((c) => famillePrimaire(c) === cle);
      if (liste.length) noeuds.push(el('h2', { classe: 'inv-titre-modeles', texte: titre }), listeTuiles(liste));
    });
    if (!primaires.length) noeuds.push(el('p', { classe: 'aide-question', texte: estAdmin() ? (gestion ? 'Aucun contenant primaire : ouvrez un inventaire et choisissez la catégorie « Primaire ».' : 'Aucun contenant primaire : menu > Administration > Gestion des inventaires.') : 'Aucun contenant primaire pour l\'instant : utilisez la loupe ci-dessus.' }));
    // Caisses : contenu des tiroirs et placards d'un véhicule désarmé, rangé au SMUR (répertoire virtuel des péremptions).
    const caisses = tous.filter((c) => c.categorie === 'primaire' && c.stock && !c.parent);
    if (caisses.length) {
      noeuds.push(el('h2', { classe: 'inv-titre-modeles', texte: 'Caisses (véhicules désarmés)' }),
        el('p', { classe: 'aide-question', texte: 'Contenu des tiroirs et placards rangé dans les locaux : ses péremptions sont suivies ici jusqu\'au réarmement d\'un véhicule.' }),
        listeTuiles(caisses));
    }
    if (!gestion) noeuds.push(blocArmement());
    // Inventaires types : visibles des administrateurs seulement.
    const modeles = racines.filter((c) => c.modele);
    if (gestion) {
      const immobiles = modeles.filter((c) => c.categorie === 'immobile');
      const mobiles = modeles.filter((c) => c.categorie !== 'immobile');
      noeuds.push(el('h2', { classe: 'inv-titre-modeles', texte: 'Inventaires types mobiles' }),
        el('p', { classe: 'aide-question', texte: 'Contenants qui se déplacent (sacs, ampouliers, scopes…) : on modifie le type, puis on répercute sur ses exemplaires. Ils ne se vérifient pas.' }),
        mobiles.length ? listeTuiles(mobiles)
          : el('p', { classe: 'aide-question', texte: 'Aucun pour l\'instant : créez un contenant (+), puis Réglages › « Inventaire type ».' }),
        el('h2', { classe: 'inv-titre-modeles', texte: 'Inventaires types immobiles' }),
        el('p', { classe: 'aide-question', texte: 'Tiroirs et placards des véhicules : une seule structure, modifiée une fois, répercutée sur tous les véhicules.' }),
        immobiles.length ? filtreImmobiles(immobiles)
          : el('p', { classe: 'aide-question', texte: 'Aucun pour l\'instant.' }));
    }
    // Administrateurs : inventaires de premier niveau pas encore classés.
    const aClasser = racines.filter((c) => !c.modele && !c.categorie);
    if (aClasser.length && gestion) {
      noeuds.push(el('h2', { classe: 'inv-titre-modeles', texte: `À classer (${aClasser.length})` }),
        el('p', { classe: 'aide-question', texte: 'Sans catégorie, ils ne sont visibles que des administrateurs. Ouvrez-les, puis Réglages › Catégorie.' }),
        el('ul', { classe: 'inv-liste' }, ...aClasser.map((c) => el('li', {}, carte(c)))));
    }

    if (edition) noeuds.push(blocSupprimes());
    if (edition) {
      const champ = idChamp();
      noeuds.push(el('section', { classe: 'inv-groupe-reglages inv-outils-gestion' },
        el('h2', { texte: 'Outils' }),
        el('div', { classe: 'cfg-actions' },
          tous.length ? el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Imprimer des étiquettes QR…', surclick: () => imprimerEtiquettes() }) : null,
          el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Base des articles', surclick: () => aller(BASE) })),
        el('div', { classe: 'champ' }, el('label', { for: champ, texte: 'Alerte de péremption (jours avant la date)' }),
          el('input', {
            id: champ, type: 'number', min: '1', max: '365', inputmode: 'numeric', classe: 'inv-court', valeur: structure.reglages.alerteJours,
            surchange: (e) => {
              const n = Math.round(Number(e.target.value));
              if (!(n >= 1 && n <= 365)) { e.target.value = structure.reglages.alerteJours; return; }
              structure.reglages.alerteJours = n;
              modifs.reglages = true;
              sauverStructure(); sauverModifs(); programmerEnvoi();
              rendre({ garderPosition: true });
            },
          }))));
    }
    if (gestion) noeuds.push(blocReinitialisationDev());
    return noeuds;
  }

  // ----- Développement : réinitialiser les inventaires du jour pour rejouer des tests -----
  function blocReinitialisationDev() {
    const enAttente = confirmer === 'reinit-jour';
    return el('details', { classe: 'cfg-section inv-dev', open: enAttente },
      el('summary', { texte: 'Développement' }),
      el('p', { classe: 'aide-question', texte: 'Efface les vérifications d\'aujourd\'hui (tous agents, tous appareils) et les contenants mobiles pointés, pour rejouer les tests. Les péremptions saisies et les contenants désaffectés ne sont pas annulés. Les lignes retirées sont rangées dans l\'onglet InventairesVerifsAnnulees.' }),
      el('button', {
        type: 'button', classe: `cfg-bouton${enAttente ? ' danger' : ''}`,
        texte: enAttente ? 'Confirmer la réinitialisation' : 'Réinitialiser les inventaires du jour',
        surclick: (e) => {
          if (!enAttente) { confirmer = 'reinit-jour'; rendre({ garderPosition: true }); return; }
          e.target.disabled = true;
          e.target.textContent = 'Réinitialisation…';
          reinitialiserJour();
        },
      }));
  }
  async function reinitialiserJour() {
    confirmer = '';
    // Vérifications pas encore envoyées : on les retire de la file, sinon elles repartiraient au serveur.
    if (App.retirerDeFile) {
      App.fileAttente().filter((x) => x.action === 'verifierInventaire' && jour(new Date(x.date)) === jour())
        .forEach((x) => App.retirerDeFile(x.id));
    }
    let rep;
    try { rep = await App.appeler('reinitialiserInventairesJour'); } catch (err) { rep = { ok: false, erreur: 'pas de réseau' }; }
    if (!rep || !rep.ok) {
      avis = `Réinitialisation impossible : ${(rep && rep.erreur) || 'erreur inconnue'}${rep && rep.erreur === 'Action inconnue' ? ' (déployez la nouvelle version du serveur)' : ''}.`;
      rendre({ garderPosition: true });
      return;
    }
    Object.keys(etat.verifs).forEach((id) => { if (jour(new Date(etat.verifs[id].date)) === jour()) delete etat.verifs[id]; });
    brouillons = { jour: jour(), liste: {}, pointes: {} };
    reponsesScelle.clear();
    aIdentifier = '';
    identification = '';
    sauverEtat();
    sauverBrouillons();
    avis = `Inventaires du jour réinitialisés (${pluriel(rep.retirees || 0, 'vérification retirée', 'vérifications retirées')} du serveur).`;
    rendre({ garderPosition: true });
    synchroniser();
  }

  // ----- Un contenant -----
  let flecheChoisie = ''; // « cléVue#rang » de la flèche sélectionnée en gestion
  const photosIndisponibles = new Set(); // photos non chargées (hors ligne) : la liste de secours s'affiche
  const DELAI_DEZOOM = 3000; // sans geste pendant 3 s, la photo reprend sa taille

  /**
   * Zoom de la photo seule (pincer à deux doigts, Ctrl + molette ou double-clic à la souris), déplacement
   * à un doigt une fois zoomé. Les gommettes gardent leur taille. Retour à la taille normale après 3 s sans geste.
   */
  function rendreZoomable(cadre, scene) {
    let z = 1; let tx = 0; let ty = 0;
    const doigts = new Map();
    let depart = null; // état au début du geste en cours
    let bouge = false;
    let minuterie = 0;
    const appliquer = (anime) => {
      scene.style.transition = anime ? 'transform .3s ease' : 'none';
      scene.style.transform = z === 1 ? '' : `translate(${tx}px, ${ty}px) scale(${z})`;
      scene.style.setProperty('--dezoom', String(1 / z));
      cadre.classList.toggle('zoome', z > 1);
    };
    const borner = () => {
      z = Math.min(5, Math.max(1, z));
      const l = cadre.clientWidth; const h = cadre.clientHeight;
      tx = Math.min(0, Math.max(l - l * z, tx));
      ty = Math.min(0, Math.max(h - h * z, ty));
    };
    const reinitialiser = () => { clearTimeout(minuterie); z = 1; tx = 0; ty = 0; appliquer(true); };
    const relancer = () => {
      clearTimeout(minuterie);
      if (z > 1) minuterie = setTimeout(() => { if (doigts.size) relancer(); else reinitialiser(); }, DELAI_DEZOOM);
    };
    const local = (x, y) => { const r = cadre.getBoundingClientRect(); return { x: x - r.left, y: y - r.top }; };
    /** Zoom vers le facteur `nz` autour du point (cx, cy) du cadre. */
    const zoomerVers = (nz, cx, cy) => {
      const k = Math.min(5, Math.max(1, nz)) / z;
      tx = cx - (cx - tx) * k; ty = cy - (cy - ty) * k; z *= k;
      borner(); appliquer(false); relancer();
    };
    const commencer = () => {
      const pts = [...doigts.values()];
      if (pts.length >= 2) {
        const [a, b] = pts;
        depart = { z, tx, ty, d: Math.hypot(a.x - b.x, a.y - b.y) || 1, m: local((a.x + b.x) / 2, (a.y + b.y) / 2) };
      } else if (pts.length === 1) depart = { z, tx, ty, p: { ...pts[0] } };
      else depart = null;
    };
    const libre = (e) => edition && e.target.closest && e.target.closest('button.inv-point');
    cadre.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' || libre(e)) return;
      if (!doigts.size) bouge = false;
      doigts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      commencer();
      clearTimeout(minuterie);
    });
    cadre.addEventListener('pointermove', (e) => {
      if (!doigts.has(e.pointerId) || !depart) return;
      doigts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const pts = [...doigts.values()];
      if (pts.length >= 2 && depart.d) {
        const [a, b] = pts;
        const nz = Math.min(5, Math.max(1, depart.z * (Math.hypot(a.x - b.x, a.y - b.y) / depart.d)));
        const m = local((a.x + b.x) / 2, (a.y + b.y) / 2);
        // Le point de la photo sous le milieu des doigts au départ reste sous leur milieu.
        z = nz;
        tx = m.x - (depart.m.x - depart.tx) * (nz / depart.z);
        ty = m.y - (depart.m.y - depart.ty) * (nz / depart.z);
        bouge = true;
        borner(); appliquer(false);
      } else if (pts.length === 1 && depart.p && z > 1) {
        const dx = pts[0].x - depart.p.x; const dy = pts[0].y - depart.p.y;
        if (Math.abs(dx) + Math.abs(dy) > 6) bouge = true;
        tx = depart.tx + dx; ty = depart.ty + dy;
        borner(); appliquer(false);
      }
    });
    const lever = (e) => {
      if (!doigts.delete(e.pointerId)) return;
      commencer();
      if (z < 1.05) reinitialiser(); else relancer();
    };
    cadre.addEventListener('pointerup', lever);
    cadre.addEventListener('pointercancel', lever);
    // Après un pincement ou un déplacement, le doigt levé n'ouvre pas la gommette qu'il touche.
    cadre.addEventListener('click', (e) => { if (bouge) { e.preventDefault(); e.stopPropagation(); bouge = false; } }, true);
    cadre.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return; // molette seule : la page défile normalement
      e.preventDefault();
      const p = local(e.clientX, e.clientY);
      zoomerVers(z * Math.exp(-e.deltaY / 200), p.x, p.y);
    }, { passive: false });
    cadre.addEventListener('dblclick', (e) => {
      const p = local(e.clientX, e.clientY);
      if (z > 1) reinitialiser(); else zoomerVers(2.5, p.x, p.y);
    });
  }

  /** Gestion : ajouter une flèche sur la vue, choisir sa destination, l'orienter, la déplacer, la retirer. */
  function reglagesFleches(c, vc, vues) {
    const n = flecheChoisie.startsWith(`${vc.cle}#`) ? Number(flecheChoisie.split('#')[1]) : -1;
    const f = vc.fleches[n];
    const ecrire = (liste) => { majVue(c, vc.cle, { fleches: liste }); marquer(c.id); rendre({ garderPosition: true }); };
    const ajouter = el('button', { type: 'button', classe: 'cfg-mini', texte: '＋ Flèche vers une vue', title: 'Placer sur la photo une flèche qui mène à une autre vue',
      surclick: () => { placement = 'fleche:nouvelle'; flecheChoisie = ''; rendre({ garderPosition: true }); } });
    if (!f) {
      return el('div', { classe: 'cfg-ligne inv-reglages-fleches' }, ajouter,
        vc.fleches.length ? el('small', { classe: 'aide-question', texte: 'Touchez une flèche pour la régler.' }) : null);
    }
    const idDest = idChamp();
    const tourner = (sens) => { const l = vc.fleches.slice(); l[n] = { ...f, angle: (((f.angle || 0) + sens * 45) % 360 + 360) % 360 }; ecrire(l); };
    return el('div', { classe: 'cfg-ligne inv-reglages-fleches' },
      el('label', { for: idDest, texte: 'Mène à' }),
      el('select', { id: idDest, surchange: (e) => { const l = vc.fleches.slice(); l[n] = { ...f, vers: e.target.value }; ecrire(l); } },
        ...vues.filter((v) => v.cle !== vc.cle).map((v) => el('option', { value: v.cle, selected: v.cle === f.vers, texte: v.nom }))),
      el('button', { type: 'button', classe: 'cfg-mini', texte: '↺', title: 'Tourner la flèche', 'aria-label': 'Tourner la flèche vers la gauche', surclick: () => tourner(-1) }),
      el('button', { type: 'button', classe: 'cfg-mini', texte: '↻', title: 'Tourner la flèche', 'aria-label': 'Tourner la flèche vers la droite', surclick: () => tourner(1) }),
      el('button', { type: 'button', classe: 'cfg-mini', texte: 'Déplacer', surclick: () => { placement = `fleche:${n}`; rendre({ garderPosition: true }); } }),
      el('button', { type: 'button', classe: 'cfg-mini', texte: 'Retirer', surclick: () => { flecheChoisie = ''; ecrire(vc.fleches.filter((x, i) => i !== n)); } }),
      ajouter);
  }

  /** Pose la gommette (ou la flèche) en cours de placement à la position `pos` (x, y de 0 à 1 dans l'image). */
  function poserA(c, vc, vues, pos) {
    if (!placement) return;
    if (placement.startsWith('fleche:')) {
      // Nouvelle flèche (vers la première autre vue) ou flèche déplacée.
      const n = placement.slice(7);
      const liste = vc.fleches.slice();
      if (n === 'nouvelle') {
        const autre = vues.find((v) => v.cle !== vc.cle);
        liste.push({ vers: autre ? autre.cle : '', x: pos.x, y: pos.y });
        flecheChoisie = `${vc.cle}#${liste.length - 1}`;
      } else if (liste[Number(n)]) liste[Number(n)] = { ...liste[Number(n)], ...pos };
      majVue(c, vc.cle, { fleches: liste });
    } else poserGommette(c, vc, placement, pos);
    placement = '';
    marquer(c.id);
    rendre({ garderPosition: true });
  }
  /** Gommette d'un sous-inventaire sur une vue (photo classique ou immersive) ; `position` : style CSS de placement. */
  function creerPastille(c, vc, p, fils, position) {
    const rang = fils.findIndex((f) => f.id === p.cible);
    if (rang === -1) return null;
    const b = bilan(fils[rang].id);
    // Validé par le scellé (« Oui, il est scellé ») : cadenas à la place du ✓, couleur du dernier inventaire.
    const scelle = !edition && b.complet && sousScelle(fils[rang]);
    const t = texteGommette(c, p.cible, rang);
    // Icône choisie (poumon, cœur-éclair) : elle remplace le texte, la couleur de la gommette dit l'état ; le cadenas garde la priorité.
    const icone = scelle ? undefined : iconeChoisie(c, p.cible);
    const affiche = icone ? '' : edition ? t : scelle ? '' : (b.complet ? '✓' : t);
    const commun = {
      classe: `inv-point ${b.classe}${scelle ? ' scelle' : ''}${icone ? ' avec-icone' : ''}${placement === p.cible ? ' deplace' : ''}${scelle || icone ? '' : classesTexte(affiche)}`, style: `${position}--t:${tailleGommette(p)}`,
      'aria-label': `${fils[rang].nom} : ${b.texte}`, title: fils[rang].nom,
    };
    const pastille = edition
      // Gestion : un appui ouvre le sous-inventaire (en gestion) ; appui long pour déplacer la gommette.
      ? el('button', { type: 'button', ...commun, 'aria-label': `${fils[rang].nom} : ouvrir. Appui long pour déplacer`, title: `${fils[rang].nom} — appui long pour déplacer`, texte: affiche, surclick: () => aller(p.cible) })
      : fils[rang].clAmbulancier && vehiculeAmbulancier(fils[rang])
        // Bouteilles d'oxygène (check-list ambulancier) : niveaux en fenêtre, sans quitter la photo.
        ? el('button', { type: 'button', ...commun, 'aria-haspopup': 'dialog', texte: affiche, surclick: () => voirOxygene(fils[rang]) })
        : el('a', { href: lien(p.cible), ...commun, texte: affiche });
    if (scelle) pastille.append(logoCadenas());
    if (icone) pastille.append(logoGommette(icone));
    if (!edition) { const pe = badgePeremption(b); if (pe) pastille.append(pe); }
    return pastille;
  }
  /** Flèche vers une autre vue : un rond transparent à toucher pour changer d'angle. */
  function creerFleche(c, vc, vues, f, n, position) {
    const dest = vues.find((v) => v.cle === f.vers);
    if (!dest && !edition) return null;
    const choisie = edition && flecheChoisie === `${vc.cle}#${n}`;
    return el('button', {
      type: 'button', classe: `inv-fleche${choisie ? ' choisie' : ''}${placement === `fleche:${n}` ? ' deplace' : ''}${dest ? '' : ' orpheline'}`,
      style: `${position}--a:${f.angle || 0}deg`,
      'aria-label': dest ? `Aller à la vue « ${dest.nom} »` : 'Flèche sans vue de destination', title: dest ? dest.nom : 'Vue supprimée',
      surclick: () => {
        if (edition) { flecheChoisie = choisie ? '' : `${vc.cle}#${n}`; rendre({ garderPosition: true }); return; }
        vueActive.set(c.id, f.vers);
        rendre({ garderPosition: true });
      },
    }, el('span', { classe: 'inv-fleche-trait', 'aria-hidden': 'true', texte: '➜' }));
  }
  /** Consigne affichée pendant le placement d'une gommette ou d'une flèche. */
  function consignesPlacement(c, vc, plusieurs) {
    const sortie = [];
    if (placement && placement.startsWith('fleche:')) {
      sortie.push(el('p', { classe: 'inv-consigne-placement', role: 'status' }, 'Touchez la photo à l\'endroit de la flèche. ',
        el('button', { type: 'button', classe: 'lien', texte: 'Annuler', surclick: () => { placement = ''; rendre({ garderPosition: true }); } })));
    }
    if (placement && contenant(placement)) {
      sortie.push(el('p', { classe: 'inv-consigne-placement', role: 'status' },
        `Touchez la photo${plusieurs ? ` « ${vc.nom} »` : ''} à l'endroit de « ${contenant(placement).nom} ». `,
        el('button', { type: 'button', classe: 'lien', texte: 'Plus tard', surclick: () => { placement = ''; rendre({ garderPosition: true }); } })));
    }
    return sortie;
  }
  /** Aide et réglage de la taille de toutes les gommettes d'une vue (gestion). */
  function reglageTailles(c, vc, aide) {
    const tailles = vc.points.map(tailleGommette);
    const tMin = Math.min(...tailles); const tMax = Math.max(...tailles);
    const regler = (sens) => { changerTaille(c, vc, sens); marquer(c.id); rendre({ garderPosition: true }); };
    return [el('p', { classe: 'aide-question inv-aide-gommettes', texte: aide }),
      el('div', { classe: 'cfg-ligne inv-taille-gommettes' },
        el('span', { texte: 'Taille des gommettes de la photo' }),
        el('button', { type: 'button', classe: 'cfg-mini', texte: 'A−', title: 'Réduire toutes les gommettes de cette photo', 'aria-label': 'Réduire toutes les gommettes', disabled: tMax <= TAILLES_GOMMETTE[0] || undefined, surclick: () => regler(-1) }),
        el('span', { classe: 'inv-taille-valeur', texte: tMin === tMax ? `${Math.round(tMin * 100)} %` : 'variable' }),
        el('button', { type: 'button', classe: 'cfg-mini', texte: 'A+', title: 'Agrandir toutes les gommettes de cette photo', 'aria-label': 'Agrandir toutes les gommettes', disabled: tMin >= TAILLES_GOMMETTE[TAILLES_GOMMETTE.length - 1] || undefined, surclick: () => regler(1) }))];
  }

  // ---------- Vue immersive (panorama) ----------
  // Afficheur Pannellum (lib/, licence MIT), chargé à la première vue immersive et gardé en cache hors ligne.
  let chargementPannellum = null;
  function chargerPannellum() {
    if (window.pannellum) return Promise.resolve();
    if (!chargementPannellum) {
      chargementPannellum = new Promise((ok, ko) => {
        if (!document.querySelector('link[data-pannellum]')) document.head.append(el('link', { rel: 'stylesheet', href: 'lib/pannellum.css?v=1', 'data-pannellum': '1' }));
        const s = document.createElement('script');
        s.src = 'lib/pannellum.js?v=1';
        s.onload = () => ok();
        s.onerror = () => { chargementPannellum = null; s.remove(); ko(new Error('Afficheur indisponible')); };
        document.head.append(s);
      });
    }
    return chargementPannellum;
  }
  let visionneuse = null; // { viewer, cle } : afficheur affiché (un seul à la fois)
  const orientations = new Map(); // « contenant#vue » → orientation gardée d'un affichage à l'autre
  /** Ferme l'afficheur immersif (avant chaque nouvel affichage), en gardant son orientation. */
  function fermerVisionneuse() {
    if (!visionneuse) return;
    const { viewer, cle } = visionneuse;
    visionneuse = null;
    try { orientations.set(cle, { yaw: viewer.getYaw(), pitch: viewer.getPitch(), hfov: viewer.getHfov() }); } catch (e) { /* afficheur pas encore prêt */ }
    try { viewer.destroy(); } catch (e) { /* déjà détruit */ }
  }
  /**
   * Géométrie d'un panorama : angle horizontal couvert (réglage de la vue) et angle vertical déduit des proportions
   * de l'image (une photo sphérique 2:1 sur 360° couvre 180° en hauteur).
   */
  const geometriePanorama = (champ, largeur, hauteur) => ({ haov: champ, vaov: Math.min(180, champ * hauteur / Math.max(1, largeur)) });
  const versAngles = (p, g) => ({ yaw: (p.x - 0.5) * g.haov, pitch: (0.5 - p.y) * g.vaov });
  const versPosition = (pitch, yaw, g) => {
    const borne = (v) => Math.min(1, Math.max(0, v));
    return { x: borne(yaw / g.haov + 0.5), y: borne(0.5 - pitch / g.vaov) };
  };
  /** Déclenche `action` sur un appui long (gestion : déplacer une gommette dans la vue immersive). */
  function appuiLong(element, action) {
    let minuterie = null;
    let depart = null;
    let declenche = false;
    const annuler = () => { clearTimeout(minuterie); minuterie = null; };
    element.addEventListener('pointerdown', (e) => {
      declenche = false;
      depart = { x: e.clientX, y: e.clientY };
      annuler();
      minuterie = setTimeout(() => { declenche = true; action(); }, 550);
    });
    element.addEventListener('pointermove', (e) => { if (depart && Math.hypot(e.clientX - depart.x, e.clientY - depart.y) > 10) annuler(); });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => element.addEventListener(t, annuler));
    element.addEventListener('contextmenu', (e) => e.preventDefault());
    // Le clic qui suit un appui long n'ouvre pas le sous-inventaire.
    element.addEventListener('click', (e) => { if (declenche) { e.preventDefault(); e.stopImmediatePropagation(); declenche = false; } }, true);
  }
  /** Cadre de la vue immersive : panorama à faire pivoter, gommettes et flèches accrochées à leur direction. */
  function cadreImmersif(c, vc, fils, vues) {
    const cadre = el('div', { classe: `inv-immersif${placement ? ' placement' : ''}`, role: 'img', 'aria-label': `Vue immersive : ${c.nom} — ${vc.nom}` },
      el('p', { classe: 'inv-photo-attente', texte: 'Chargement de la vue immersive…' }));
    const cle = `${c.id}#${vc.cle}`;
    const echec = (texte) => {
      const att = cadre.querySelector('.inv-photo-attente');
      if (att) att.textContent = texte;
      cadre.classList.add('sans-image');
      photosIndisponibles.add(vc.photo);
      if (zone) zone.querySelectorAll('.inv-liste-secours').forEach((x) => { x.hidden = false; });
    };
    const demarrer = async () => {
      const donnees = Photos.enMemoire(vc.photo) || await obtenirPhoto(vc.photo);
      if (!donnees) { echec('Photo pas encore disponible hors ligne : passez par la liste ci-dessous.'); return; }
      const image = new Image();
      await new Promise((ok, ko) => { image.onload = ok; image.onerror = ko; image.src = donnees; });
      try { await chargerPannellum(); } catch (e) { echec('Afficheur de la vue immersive indisponible : réessayez avec le réseau.'); return; }
      if (!cadre.isConnected) return; // l'écran a changé entre-temps
      cadre.querySelector('.inv-photo-attente').remove();
      const g = geometriePanorama(vc.immersif, image.naturalWidth, image.naturalHeight);
      const hotSpots = [];
      vc.points.forEach((p) => {
        const pastille = creerPastille(c, vc, p, fils, 'left:0;top:0;');
        if (!pastille) return;
        if (edition) appuiLong(pastille, () => { placement = p.cible; rendre({ garderPosition: true }); });
        hotSpots.push({ ...versAngles(p, g), cssClass: 'inv-hs', createTooltipFunc: (div) => div.append(pastille) });
      });
      vc.fleches.forEach((f, n) => {
        const fl = creerFleche(c, vc, vues, f, n, 'left:0;top:0;');
        if (fl) hotSpots.push({ ...versAngles(f, g), cssClass: 'inv-hs', createTooltipFunc: (div) => div.append(fl) });
      });
      const o = orientations.get(cle) || {};
      const viewer = window.pannellum.viewer(cadre, {
        type: 'equirectangular', panorama: donnees, autoLoad: true,
        haov: g.haov, vaov: g.vaov, vOffset: 0,
        yaw: o.yaw ?? 0, pitch: o.pitch ?? 0, hfov: o.hfov ?? Math.min(100, g.haov),
        minHfov: 30, maxHfov: Math.min(120, g.haov),
        showZoomCtrl: false, showFullscreenCtrl: true, compass: false, keyboardZoom: true, mouseZoom: true,
        hotSpots,
        strings: { loadingLabel: 'Chargement…', loadButtonLabel: 'Afficher la vue immersive', bylineLabel: '',
          noPanoramaError: 'Aucune image.', fileAccessError: 'Image illisible.', malformedURLError: 'Adresse de l\'image incorrecte.',
          iOS8WebGLError: 'Vue immersive impossible sur cet appareil.', genericWebGLError: 'Vue immersive impossible sur cet appareil (WebGL).',
          textureSizeError: 'Image trop grande pour cet appareil.', unknownError: 'Erreur d\'affichage.' },
      });
      visionneuse = { viewer, cle };
      // Gestion : un toucher bref (sans faire pivoter) pose la gommette ou la flèche en cours de placement.
      if (edition) {
        let depart = null;
        cadre.addEventListener('pointerdown', (e) => { depart = { x: e.clientX, y: e.clientY }; });
        cadre.addEventListener('pointerup', (e) => {
          if (!placement || !depart || Math.hypot(e.clientX - depart.x, e.clientY - depart.y) > 8) return;
          if (e.target.closest('.inv-hs, .pnlm-controls-container')) return;
          const [pitch, yaw] = viewer.mouseEventToCoords(e);
          poserA(c, vc, vues, versPosition(pitch, yaw, g));
        });
      }
    };
    demarrer().catch(() => echec('Photo illisible.'));
    return cadre;
  }
  /**
   * Panorama pris au téléphone : réduit (sans recadrage) pour rester léger hors ligne et lisible par tous les
   * appareils (4096 px de large au plus, limite des textures sur beaucoup de téléphones), sous la taille acceptée par le serveur.
   */
  async function reduirePanorama(fichier) {
    const url = URL.createObjectURL(fichier);
    try {
      const image = new Image();
      await new Promise((ok, ko) => { image.onload = ok; image.onerror = ko; image.src = url; });
      for (const largeurMax of [4096, 3072, 2048]) {
        const k = Math.min(1, largeurMax / image.naturalWidth, 2048 / image.naturalHeight);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(image.naturalWidth * k);
        canvas.height = Math.round(image.naturalHeight * k);
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        for (const q of [0.8, 0.7, 0.6]) {
          const donnees = canvas.toDataURL('image/jpeg', q);
          if (donnees.length <= PHOTO_MAX) return { donnees, largeur: canvas.width, hauteur: canvas.height };
        }
      }
      throw new Error('Panorama trop lourd');
    } finally { URL.revokeObjectURL(url); }
  }

  /** Gestion : vue classique ou immersive, et angle couvert par le panorama. */
  function reglagesImmersif(c, vc) {
    const idCase = idChamp();
    const idChampAngle = idChamp();
    const changer = (champs) => { majVue(c, vc.cle, champs); marquer(c.id); rendre({ garderPosition: true }); };
    return el('div', { classe: 'inv-reglages-immersif' },
      el('div', { classe: 'cfg-ligne' },
        el('input', { type: 'checkbox', id: idCase, checked: Boolean(vc.immersif), surchange: (e) => changer({ immersif: e.target.checked ? 360 : 0 }) }),
        el('label', { for: idCase, texte: '🌐 Vue immersive (panorama pris au téléphone, que l\'on fait pivoter du doigt)' })),
      vc.immersif ? el('div', { classe: 'cfg-ligne' },
        el('label', { for: idChampAngle, texte: 'Angle couvert par le panorama' }),
        el('select', { id: idChampAngle, surchange: (e) => changer({ immersif: Number(e.target.value) }) },
          ...[...new Set([360, 270, 240, 180, 150, 120, 90, vc.immersif])].sort((a, b) => b - a)
            .map((a) => el('option', { value: String(a), texte: a === 360 ? '360° (tour complet)' : `${a}°`, selected: a === vc.immersif })))) : null,
      vc.immersif ? el('p', { classe: 'aide-question', texte: 'Prenez la photo avec le mode « Panorama » ou « Photo Sphere » du téléphone, debout au centre, en tournant autour du téléphone. Si le panorama ne fait pas le tour complet, réglez l\'angle pour que les proportions soient justes.' }) : null);
  }
  function blocPhoto(c, fils) {
    const vues = vuesDe(c);
    const vc = vueCourante(c);
    const avecPhoto = vues.some((v) => v.photo);
    if (!avecPhoto && !edition) return null;
    const bloc = el('div', { classe: 'inv-bloc-photo' });
    // Onglets des vues (plusieurs angles d'une pièce, d'une cellule sanitaire…)
    const plusieurs = vues.length > 1;
    const peutAjouter = edition; // tout contenant peut avoir plusieurs vues (angles, tiroir fermé/ouvert…)
    // Check-list : pas d'onglets, on change de vue par les flèches posées sur la photo.
    if (edition && (plusieurs || peutAjouter)) {
      const onglets = el('div', { classe: 'inv-onglets-vues', role: 'tablist', 'aria-label': 'Vues' },
        ...vues.map((v) => {
          const nb = v.points.filter((p) => fils.some((f) => f.id === p.cible)).length;
          const defaut = edition && plusieurs && !v.cle; // repère, en gestion, la vue affichée en premier
          return el('button', { type: 'button', role: 'tab', classe: 'inv-onglet-vue', 'aria-selected': String(v.cle === vc.cle),
            ...(defaut ? { title: 'Vue affichée en premier' } : {}),
            surclick: () => { vueActive.set(c.id, v.cle); rendre({ garderPosition: true }); } },
          defaut ? '★ ' : null, v.immersif ? '🌐 ' : null, v.nom, nb ? el('small', { texte: ` · ${nb}` }) : null);
        }),
        peutAjouter ? el('button', { type: 'button', classe: 'inv-onglet-vue inv-onglet-ajout', 'aria-label': 'Ajouter une vue', title: 'Ajouter une vue (autre angle)', texte: '＋ Vue', surclick: () => {
          const v = { id: nouvelId(), nom: `Vue ${c.vues.length + 2}`, photo: '', points: [], fleches: [] };
          c.vues.push(v);
          vueActive.set(c.id, v.id);
          marquer(c.id);
          rendre({ garderPosition: true });
        } }) : null,
        peutAjouter ? el('button', { type: 'button', classe: 'inv-onglet-vue inv-onglet-ajout', 'aria-label': 'Ajouter une vue immersive', title: 'Panorama pris au téléphone, que l\'on fait pivoter du doigt', texte: '＋ 🌐 Vue immersive', surclick: () => {
          const v = { id: nouvelId(), nom: 'Vue immersive', photo: '', points: [], fleches: [], immersif: 360 };
          c.vues.push(v);
          vueActive.set(c.id, v.id);
          marquer(c.id);
          rendre({ garderPosition: true });
        } }) : null);
      bloc.append(onglets);
    }
    if (vc.photo && vc.immersif) {
      bloc.append(...consignesPlacement(c, vc, plusieurs));
      bloc.append(cadreImmersif(c, vc, fils, vues));
      if (edition && vues.length > 1) bloc.append(reglagesFleches(c, vc, vues));
      if (edition && vc.points.length) bloc.append(...reglageTailles(c, vc, 'Faites pivoter l\'image du doigt. Touchez une gommette pour ouvrir son inventaire ; pour la déplacer : appui long, puis touchez le nouvel endroit.'));
    } else if (vc.photo) {
      const img = el('img', { alt: `Photo : ${c.nom}${plusieurs ? ` — ${vc.nom}` : ''}` });
      const attente = el('p', { classe: 'inv-photo-attente', texte: 'Chargement de la photo…' });
      // La scène (photo, gommettes, flèches) se zoome seule, sans zoomer la page.
      const scene = el('div', { classe: 'inv-photo-scene' }, img);
      const cadre = el('div', { classe: `inv-photo${placement ? ' placement' : ''}` }, scene, attente);
      const montrer = (donnees) => {
        if (donnees) { img.src = donnees; attente.remove(); } else {
          attente.textContent = 'Photo pas encore disponible hors ligne : passez par la liste ci-dessous.';
          cadre.classList.add('sans-image');
          photosIndisponibles.add(vc.photo);
          if (zone) zone.querySelectorAll('.inv-liste-secours').forEach((x) => { x.hidden = false; });
        }
      };
      if (Photos.enMemoire(vc.photo)) montrer(Photos.enMemoire(vc.photo));
      else obtenirPhoto(vc.photo).then(montrer);
      img.draggable = false; // pas de « glisser l'image » du navigateur pendant le placement
      if (placement) {
        // Aperçu de la gommette qui suit la souris : on voit où elle sera posée, même sur une photo sombre.
        const rang = fils.findIndex((f) => f.id === placement);
        const texteApercu = rang === -1 ? (placement.startsWith('fleche:') ? '➜' : '') : texteGommette(c, placement, rang);
        const dejaPose = vc.points.find((p) => p.cible === placement);
        const taillesVue = [...new Set(vc.points.map(tailleGommette))];
        const tailleApercu = dejaPose ? tailleGommette(dejaPose) : taillesVue.length === 1 ? taillesVue[0] : 1;
        const iconeApercu = rang === -1 ? undefined : iconeChoisie(c, placement);
        const apercu = el('span', { classe: `inv-point inv-apercu${iconeApercu ? ' avec-icone' : classesTexte(texteApercu)}`, style: `--t:${tailleApercu}`, 'aria-hidden': 'true', texte: iconeApercu ? '' : texteApercu, hidden: true });
        if (iconeApercu) apercu.append(logoGommette(iconeApercu));
        scene.append(apercu);
        cadre.addEventListener('pointermove', (e) => {
          if (e.pointerType !== 'mouse') return;
          const r = img.getBoundingClientRect();
          apercu.hidden = false;
          apercu.style.left = `${((e.clientX - r.left) / r.width) * 100}%`; // rect zoomé : reste juste
          apercu.style.top = `${((e.clientY - r.top) / r.height) * 100}%`;
        });
        cadre.addEventListener('pointerleave', () => { apercu.hidden = true; });
      }
      img.addEventListener('click', (e) => {
        if (!placement) return;
        const r = img.getBoundingClientRect();
        const borne = (v) => Math.min(1, Math.max(0, v));
        poserA(c, vc, vues, { x: borne((e.clientX - r.left) / r.width), y: borne((e.clientY - r.top) / r.height) });
      });
      vc.points.forEach((p) => {
        const pastille = creerPastille(c, vc, p, fils, `left:${p.x * 100}%;top:${p.y * 100}%;`);
        if (!pastille) return;
        if (edition) glisserPastille(pastille, img, c, vc, p.cible);
        scene.append(pastille);
      });
      // Flèches vers les autres vues : un rond transparent à toucher pour changer d'angle.
      vc.fleches.forEach((f, n) => {
        const fl = creerFleche(c, vc, vues, f, n, `left:${f.x * 100}%;top:${f.y * 100}%;`);
        if (fl) scene.append(fl);
      });
      bloc.append(...consignesPlacement(c, vc, plusieurs));
      bloc.append(cadre);
      rendreZoomable(cadre, scene);
      if (edition && vues.length > 1) bloc.append(reglagesFleches(c, vc, vues));
      if (edition && vc.points.length) bloc.append(...reglageTailles(c, vc, 'Touchez une gommette pour ouvrir son inventaire. Pour la déplacer : appui long, glissez, relâchez.'));
    }
    if (edition) {
      const prendre = idChamp();
      const choisir = idChamp();
      const nomVue = idChamp();
      // Nouvelle photo (recadrée avant enregistrement) ou recadrage de la photo actuelle :
      // les points déjà posés suivent le recadrage ; ceux qui sortent du cadre sont à replacer.
      const appliquerRecadrage = async (source, reporterPoints) => {
        try {
          const res = await recadrerImage(source);
          if (!res) return;
          const id = `local-${nouvelId()}`;
          await Photos.ecrire(id, res.donnees);
          if (vc.photo.startsWith('local-')) await Photos.supprimer(vc.photo);
          const champs = { photo: id };
          let perdus = 0;
          if (reporterPoints) {
            champs.points = vc.points.map((p) => {
              const n = res.transformer(p.x, p.y);
              if (!n) { perdus += 1; return null; }
              return { ...p, x: n.x, y: n.y };
            }).filter(Boolean);
            champs.fleches = vc.fleches.map((f) => { const n = res.transformer(f.x, f.y); return n ? { ...f, x: n.x, y: n.y } : null; }).filter(Boolean);
          }
          majVue(c, vc.cle, champs);
          marquer(c.id);
          rendre({ garderPosition: true });
          if (perdus) messageVue(`${perdus} point${perdus > 1 ? 's' : ''} hors du cadre retiré${perdus > 1 ? 's' : ''} : replacez ${perdus > 1 ? 'les sous-inventaires concernés' : 'le sous-inventaire concerné'}.`, 'erreur');
        } catch (err) {
          messageVue('Photo illisible ou trop lourde : réessayez.', 'erreur');
        }
      };
      // Vue immersive : le panorama est seulement réduit (pas de recadrage) ; les gommettes gardent leur place dans l'image.
      const recevoirPanorama = async (fichier) => {
        try {
          const res = await reduirePanorama(fichier);
          const id = `local-${nouvelId()}`;
          await Photos.ecrire(id, res.donnees);
          if (vc.photo.startsWith('local-')) await Photos.supprimer(vc.photo);
          const champs = { photo: id };
          // Photo sphérique (proportions 2:1) : tour complet. Sinon on garde l'angle déjà réglé.
          if (Math.abs(res.largeur / res.hauteur - 2) < 0.05) champs.immersif = 360;
          majVue(c, vc.cle, champs);
          marquer(c.id);
          rendre({ garderPosition: true });
        } catch (err) {
          messageVue('Panorama illisible ou trop lourd : réessayez.', 'erreur');
        }
      };
      const recevoir = (e) => {
        const fichier = e.target.files[0];
        e.target.value = '';
        if (!fichier) return;
        if (vc.immersif) recevoirPanorama(fichier); else appliquerRecadrage(fichier, false);
      };
      const recadrerActuelle = async () => {
        const donnees = await obtenirPhoto(vc.photo);
        if (!donnees) { messageVue('Photo indisponible hors ligne : réessayez avec le réseau.', 'erreur'); return; }
        appliquerRecadrage(donnees, true);
      };
      if (plusieurs) {
        bloc.append(el('div', { classe: 'cfg-ligne inv-nom-vue' }, el('label', { for: nomVue, texte: 'Nom de la vue' }),
          el('input', { id: nomVue, maxlength: '40', valeur: vc.nom, placeholder: 'ex. côté gauche, plafond, porte arrière', surchange: (e) => { majVue(c, vc.cle, { nom: e.target.value.trim() }); marquer(c.id); rendre({ garderPosition: true }); } })));
      }
      bloc.append(el('div', { classe: 'champ-photo' },
        // Vue immersive : le panorama se prend dans l'appareil photo du téléphone (mode Panorama), puis se choisit ici.
        vc.immersif ? null : el('label', { for: prendre, classe: 'bouton-photo', texte: vc.photo ? '📷 Reprendre la photo' : '📷 Prendre la photo' }),
        vc.immersif ? null : el('input', { type: 'file', id: prendre, accept: 'image/*', capture: 'environment', classe: 'invisible', surchange: recevoir }),
        el('label', { for: choisir, classe: 'bouton-photo', texte: vc.immersif ? (vc.photo ? '🌐 Changer le panorama' : '🌐 Choisir le panorama') : 'Choisir une image' }),
        el('input', { type: 'file', id: choisir, accept: 'image/*', classe: 'invisible', surchange: recevoir }),
        vc.photo && !vc.immersif ? el('button', { type: 'button', classe: 'bouton-photo', texte: '✂ Recadrer', surclick: recadrerActuelle }) : null,
        vc.photo && !vc.cle ? el('button', { type: 'button', classe: 'lien danger', texte: 'Retirer la photo', surclick: () => { majVue(c, '', { photo: '', points: [], fleches: [] }); marquer(c.id); rendre({ garderPosition: true }); } }) : null,
        vc.cle ? el('button', { type: 'button', classe: 'bouton-photo', texte: '★ Afficher en premier', title: 'Cette vue s\'ouvrira par défaut', surclick: () => {
          definirVueParDefaut(c, vc.cle);
          vueActive.set(c.id, '');
          marquer(c.id);
          rendre({ garderPosition: true });
          messageVue(`« ${vuesDe(c)[0].nom} » s'affichera en premier.`);
        } }) : null,
        vc.cle ? el('button', { type: 'button', classe: 'lien danger', texte: confirmer === `vue-${vc.cle}` ? 'Confirmer : supprimer cette vue' : 'Supprimer cette vue', surclick: () => {
          if (confirmer !== `vue-${vc.cle}`) { confirmer = `vue-${vc.cle}`; rendre({ garderPosition: true }); return; }
          confirmer = '';
          c.vues = c.vues.filter((v) => v.id !== vc.cle);
          vuesDe(c).forEach((v) => majVue(c, v.cle, { fleches: v.fleches.filter((f) => f.vers !== vc.cle) }));
          vueActive.delete(c.id);
          marquer(c.id);
          rendre({ garderPosition: true });
        } }) : null));
      bloc.append(reglagesImmersif(c, vc));
      if (!avecPhoto) bloc.append(el('p', { classe: 'aide-question', texte: `La photo sert de plan : chaque sous-inventaire y est repéré par un point numéroté. « ＋ Vue » ajoute d\'autres photos (autres angles, faces, compartiments).` }));
    }
    return bloc;
  }

  /**
   * Texte de la gommette d'un sous-inventaire : numéro automatique (champ vide), lettres ou chiffres
   * au choix (4 caractères au plus), ou « Vide » : gommette sans texte.
   */
  function champTexteGommette(c, f, i) {
    const actuel = texteChoisi(c, f.id);
    const iconeActuelle = iconeChoisie(c, f.id);
    const id = idChamp();
    const idIcone = idChamp();
    const appliquer = (t) => { fixerTexteGommette(c, f.id, t); marquer(c.id); rendre({ garderPosition: true }); };
    return el('span', { classe: 'inv-texte-gommette' },
      el('label', { for: id, texte: 'Gommette' }),
      el('input', {
        id, maxlength: '4', size: '4', autocomplete: 'off', valeur: actuel || '', placeholder: actuel === '' ? '—' : String(i + 1),
        title: 'Texte de la gommette : laisser vide pour le numéro automatique',
        surchange: (e) => { const v = Array.from(e.target.value.trim()).slice(0, 4).join(''); appliquer(v ? v : undefined); },
      }),
      el('label', { for: idIcone, texte: 'Icône' }),
      el('select', {
        id: idIcone, title: 'Icône affichée sur la gommette à la place du texte',
        surchange: (e) => { const v = iconeValide(e.target.value); fixerIconeGommette(c, f.id, v); marquer(c.id); rendre({ garderPosition: true }); },
      }, el('option', { value: '', texte: 'Aucune', selected: !iconeActuelle }),
      ...Object.entries(ICONES_GOMMETTE).map(([k, d]) => el('option', { value: k, texte: d.nom, selected: k === iconeActuelle }))),
      el('button', {
        type: 'button', classe: `cfg-mini${actuel === '' ? ' inv-actif' : ''}`, 'aria-pressed': String(actuel === ''),
        title: actuel === '' ? 'Revenir au numéro automatique' : 'Gommette sans texte', texte: 'Vide',
        surclick: () => appliquer(actuel === '' ? undefined : ''),
      }),
      ...(() => {
        const vc = vueCourante(c);
        const p = vc.points.find((x) => x.cible === f.id);
        if (!p) return [];
        const t = tailleGommette(p);
        const regler = (sens) => { changerTaille(c, vc, sens, f.id); marquer(c.id); rendre({ garderPosition: true }); };
        return [
          el('button', { type: 'button', classe: 'cfg-mini', texte: 'A−', title: 'Réduire cette gommette (sur cette photo)', 'aria-label': `Réduire la gommette de ${f.nom}`, disabled: t <= TAILLES_GOMMETTE[0] || undefined, surclick: () => regler(-1) }),
          el('span', { classe: 'inv-taille-valeur', texte: `${Math.round(t * 100)} %` }),
          el('button', { type: 'button', classe: 'cfg-mini', texte: 'A+', title: 'Agrandir cette gommette (sur cette photo)', 'aria-label': `Agrandir la gommette de ${f.nom}`, disabled: t >= TAILLES_GOMMETTE[TAILLES_GOMMETTE.length - 1] || undefined, surclick: () => regler(1) }),
        ];
      })());
  }

  /** Ferme la fenêtre d'options d'un sous-inventaire ; renvoie la position de défilement qu'elle avait (0 si absente). */
  function retirerFenetreOptions() {
    const ancienne = document.querySelector('.inv-fenetre-options');
    const haut = ancienne ? (ancienne.querySelector('.fenetre') || {}).scrollTop || 0 : -1;
    if (ancienne) { ancienne.remove(); document.body.classList.remove('fenetre-ouverte'); }
    return haut;
  }
  /** Options d'un sous-inventaire (catégorie, scellable, gommette…) dans une fenêtre pop-up. */
  function ouvrirFenetreOptions(f, contenu, haut, titreFenetre) {
    const fermer = () => { optionsOuvertes.delete(f.id); retirerFenetreOptions(); };
    const fond = el('div', { classe: 'fenetre-fond inv-fenetre-options', surclick: (e) => { if (e.target === fond) fermer(); } });
    const titre = idChamp();
    fond.append(el('div', { classe: 'fenetre', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titre },
      el('div', { classe: 'fenetre-entete' }, el('h2', { id: titre, texte: titreFenetre || `Options · ${f.nom}` }),
        el('button', { type: 'button', classe: 'fenetre-fermer', 'aria-label': 'Fermer', texte: '✕', surclick: fermer })),
      contenu,
      el('button', { type: 'button', classe: 'principal', texte: 'Fermer', surclick: fermer })));
    fond.addEventListener('keydown', (e) => { if (e.key === 'Escape') fermer(); });
    document.body.append(fond);
    document.body.classList.add('fenetre-ouverte');
    const fen = fond.querySelector('.fenetre');
    if (haut > 0) fen.scrollTop = haut; else fond.querySelector('.fenetre-fermer').focus();
  }

  /**
   * Gestion : un sous-inventaire copié d'un inventaire type porte une pastille violette (la couleur « Type ») ;
   * s'il s'écarte du type (lui ou l'un de ses sous-inventaires), une icône « i » cliquable détaille les différences.
   */
  function marquesType(f) {
    const src = contenant(f.source);
    if (!src || !(src.modele || dansUnModele(src.id))) return null;
    const type = racineModele(src.id) || src;
    const nomType = src.id === type.id ? type.nom : `${type.nom} › ${src.nom}`;
    const pastille = el('span', { classe: 'inv-marque-type', role: 'img', 'aria-label': `Inventaire type : ${nomType}`,
      title: `Inventaire type « ${nomType} » : le contenu vient du type`, texte: '🔗' });
    if (!toutPersonnalise(f)) return el('div', { classe: 'inv-marques-type' }, pastille);
    const info = el('button', { type: 'button', classe: 'inv-marque-type inv-marque-perso', 'aria-haspopup': 'dialog',
      'aria-label': `Personnalisé par rapport au type : voir les différences de ${f.nom}`, title: 'Personnalisé par rapport à l\'inventaire type : voir les différences', texte: 'ⓘ',
      surclick: () => {
        retirerFenetreOptions();
        ouvrirFenetreOptions(f, el('div', { classe: 'inv-info-type' },
          el('p', {}, 'Exemplaire de l\'inventaire type ', el('a', { href: lien(src.id), texte: nomType }), '.'),
          panneauDifferences(f)), 0, `Personnalisé · ${f.nom}`);
      } });
    return el('div', { classe: 'inv-marques-type' }, pastille, info);
  }

  function blocEnfants(c, fils) {
    const hautFenetre = retirerFenetreOptions();
    if (!fils.length && !edition) return null;
    // Check-list : on ouvre un sous-inventaire en touchant sa gommette sur la photo (ou par QR / NFC).
    // Ne restent en liste que ceux qui n'ont de gommette sur aucune photo ; la liste complète
    // ne réapparaît que si une photo ne peut pas s'afficher (hors ligne).
    let secours = false;
    let montres = fils;
    if (!edition) {
      const avecPhoto = vuesDe(c).filter((v) => v.photo);
      const places = new Set(avecPhoto.flatMap((v) => v.points.map((p) => p.cible)));
      if (avecPhoto.length) {
        montres = fils.filter((f) => !places.has(f.id));
        secours = montres.length < fils.length;
      }
    }
    const liste = el('ul', { classe: 'inv-liste inv-tuiles' });
    fils.forEach((f, i) => {
      if (!montres.includes(f)) return;
      const li = el('li', { 'data-cle': f.id }, carte(f, i + 1, texteGommette(c, f.id, i), iconeChoisie(c, f.id)));
      if (edition) {
        const vc = vueCourante(c);
        const point = vc.points.some((p) => p.cible === f.id);
        const ailleurs = vuesDe(c).filter((v) => v.cle !== vc.cle && v.points.some((p) => p.cible === f.id)).map((v) => v.nom);
        li.classList.add('inv-ligne-triable');
        li.prepend(poignee(f.nom));
        const marques = marquesType(f);
        if (marques) { li.classList.add('inv-tuile-type'); li.prepend(marques); }
        // Réglages rapides sans ouvrir le sous-inventaire : Immobile / Mobile, scellable.
        const regler = (faire) => { faire(); marquer(f.id); rendre({ garderPosition: true }); };
        const reglages = el('div', { classe: 'inv-reglages-rapides' },
          f.emplacement ? null : el('span', { classe: 'inv-segment', role: 'group', 'aria-label': `Catégorie de ${f.nom}` },
            ...['immobile', 'mobile'].map((cle) => el('button', {
              type: 'button', classe: `cfg-mini${f.categorie === cle ? ' inv-actif' : ''}`, 'aria-pressed': String(f.categorie === cle),
              title: CATEGORIES_CONTENANT[cle].aide, texte: CATEGORIES_CONTENANT[cle].nom,
              surclick: () => { if (f.categorie !== cle) regler(() => { f.categorie = cle; }); },
            }))),
          el('button', {
            type: 'button', classe: `cfg-mini${f.scellable ? ' inv-actif' : ''}`, 'aria-pressed': String(f.scellable),
            title: 'Fermé par un scellé (plomb) une fois vérifié', texte: `${f.scellable ? '🔒' : '🔓'} Scellable`,
            surclick: () => regler(() => { f.scellable = !f.scellable; }),
          }));
        // Options repliées par défaut : la liste reste lisible. Seul « Placer sur la photo » reste visible
        // tant que le sous-inventaire n'a pas de gommette (c'est l'étape suivante logique).
        const ouvert = optionsOuvertes.has(f.id);
        li.append(el('div', { classe: 'inv-options-ligne' },
          vc.photo && !point && !ailleurs.length ? el('button', {
            type: 'button', classe: 'cfg-mini inv-actif', texte: `📍 Placer sur ${vuesDe(c).length > 1 ? `« ${vc.nom} »` : 'la photo'}`,
            surclick: () => { placement = f.id; rendre({ garderPosition: true }); zone.querySelector('.inv-photo').scrollIntoView({ block: 'center', behavior: 'smooth' }); },
          }) : null,
          el('button', { type: 'button', classe: 'lien inv-options-bouton', 'aria-haspopup': 'dialog',
            texte: 'Options',
            surclick: () => { optionsOuvertes.clear(); optionsOuvertes.add(f.id); rendre({ garderPosition: true }); } })));
        const options = el('div', { classe: 'inv-options-corps' });
        options.append(reglages);
        options.append(el('div', { classe: 'cfg-ligne inv-outils' },
          vc.photo ? el('button', {
            type: 'button', classe: `cfg-mini${placement === f.id ? ' inv-actif' : ''}`, texte: point ? 'Déplacer le point' : `Placer sur ${vuesDe(c).length > 1 ? `« ${vc.nom} »` : 'la photo'}`,
            surclick: () => { optionsOuvertes.delete(f.id); placement = f.id; rendre({ garderPosition: true }); zone.querySelector('.inv-photo').scrollIntoView({ block: 'center', behavior: 'smooth' }); },
          }) : null,
          point ? el('button', { type: 'button', classe: 'cfg-mini', texte: 'Retirer le point', surclick: () => { majVue(c, vc.cle, { points: vc.points.filter((p) => p.cible !== f.id) }); marquer(c.id); rendre({ garderPosition: true }); } }) : null,
          ailleurs.length ? el('small', { classe: 'aide-question', texte: `aussi sur : ${ailleurs.join(', ')}` }) : null,
          point || ailleurs.length ? champTexteGommette(c, f, i) : null));
        if (ouvert) ouvrirFenetreOptions(f, options, hautFenetre);
      }
      liste.append(li);
    });
    if (!edition) {
      const surPhoto = fils.filter((f) => !montres.includes(f));
      const indispo = vuesDe(c).some((v) => v.photo && photosIndisponibles.has(v.photo));
      const listeSecours = secours ? el('section', { classe: 'inv-section inv-liste-secours', hidden: !indispo },
        el('h2', { texte: 'Sous-inventaires' }),
        el('ul', { classe: 'inv-liste inv-tuiles' }, ...surPhoto.map((f) => el('li', { 'data-cle': f.id }, carte(f, fils.indexOf(f) + 1, texteGommette(c, f.id, fils.indexOf(f)), iconeChoisie(c, f.id)))))) : null;
      return [montres.length ? el('section', { classe: 'inv-section' }, el('h2', { texte: secours ? 'Hors photo' : 'Sous-inventaires' }), liste) : null, listeSecours];
    }
    liste.classList.add('inv-liste-triable');
    triable(liste, (cles) => {
      cles.forEach((id, rang) => { const x = contenant(id); if (x && x.ordre !== rang) { x.ordre = rang; marquer(x.id); } });
      rendre({ garderPosition: true });
    });
    const formulaire = formulaireAjout(c);
    formulaire.hidden = !ajoutSousOuvert;
    const plus = el('button', {
      type: 'button', classe: 'inv-plus', 'aria-label': 'Ajouter un sous-inventaire', 'aria-expanded': String(ajoutSousOuvert), title: 'Ajouter un sous-inventaire',
      texte: ajoutSousOuvert ? '−' : '+',
      surclick: () => {
        ajoutSousOuvert = !ajoutSousOuvert;
        formulaire.hidden = !ajoutSousOuvert;
        plus.textContent = ajoutSousOuvert ? '−' : '+';
        plus.setAttribute('aria-expanded', String(ajoutSousOuvert));
        if (ajoutSousOuvert) formulaire.querySelector('input').focus();
      },
    });
    // Emplacement : « ici, on attend un exemplaire de tel inventaire type » (ex. un Ampoulier A dans le sac).
    const types = Object.values(structure.contenants).filter((x) => !x.supprime && x.modele && x.id !== (racineModele(c.id) || {}).id)
      .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
    const idType = idChamp();
    // Types immobiles destinés à un véhicule : ceux prévus pour le véhicule où l'on se trouve passent en premier ;
    // un type destiné à d'autres véhicules seulement l'indique dans son libellé (rien n'est interdit).
    const ici = primaireDe(c.id);
    const prevusIci = (t) => Boolean(ici && (t.destinataires || []).includes(ici.id));
    const optionType = (t) => {
      const ailleurs = t.categorie === 'immobile' && !prevusIci(t) ? nomsDestinataires(t) : [];
      return el('option', { value: t.id, texte: t.categorie === 'immobile' ? `${t.nom} (immobile${ailleurs.length ? ` — prévu pour ${ailleurs.join(', ')}` : ''})` : t.nom });
    };
    const typesIci = types.filter(prevusIci);
    const autresTypes = types.filter((t) => !prevusIci(t));
    const choixType = el('select', { id: idType }, el('option', { value: '', texte: types.length ? 'Choisir l\'inventaire type attendu…' : 'Aucun inventaire type' }),
      typesIci.length ? el('optgroup', { label: `Prévus pour ${ici.nom}` }, ...typesIci.map(optionType)) : null,
      typesIci.length && autresTypes.length ? el('optgroup', { label: 'Autres inventaires types' }, ...autresTypes.map(optionType)) : null,
      typesIci.length ? null : autresTypes.map(optionType));
    const ajoutEmplacement = el('div', { classe: 'inv-ajout inv-ajout-emplacement', hidden: !ajoutSousOuvert },
      el('label', { for: idType, texte: 'Ou ajouter un inventaire type (emplacement pour un contenant mobile)' }),
      el('p', { classe: 'aide-question', texte: 'Type mobile : en check-list, l\'agent identifiera l\'exemplaire présent (QR, NFC ou liste) ; seuls les exemplaires de ce type seront acceptés. Type immobile : ajouté directement, sans rien à identifier.' }),
      el('div', { classe: 'cfg-ligne' }, choixType, el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Ajouter', disabled: !types.length, surclick: () => {
        const type = contenant(choixType.value);
        if (!type) return;
        const fratrie = enfants(c.id);
        const rang = fratrie.length ? fratrie[fratrie.length - 1].ordre + 1 : 0;
        // Inventaire type immobile (tiroir, placard) : il ne change jamais de place, donc rien à identifier en check-list.
        // Il est rattaché directement (copie liée au type) ; seuls les types mobiles donnent un emplacement à identifier.
        const emp = type.categorie === 'immobile'
          ? copierDepuisModele(type, c.id, rang)
          : normaliser({ id: nouvelId(), parent: c.id, nom: type.nom, categorie: 'mobile', emplacement: { modele: type.id }, ordre: rang });
        structure.contenants[emp.id] = emp;
        marquer(emp.id);
        if (vueCourante(c).photo) { placement = emp.id; rendre({ garderPosition: true }); zone.querySelector('.inv-photo').scrollIntoView({ block: 'center', behavior: 'smooth' }); } else rendre({ garderPosition: true });
      } })));
    plus.addEventListener('click', () => { ajoutEmplacement.hidden = !ajoutSousOuvert; });
    return el('section', { classe: 'inv-section' },
      el('h2', { classe: 'inv-titre-plus' }, el('span', { texte: 'Sous-inventaires' }), plus),
      fils.length ? null : el('p', { classe: 'aide-question', texte: 'Aucun sous-inventaire. Touchez « + » pour en ajouter un (sacoche, pochette, tiroir…) ou un emplacement de contenant mobile.' }),
      liste, formulaire, ajoutEmplacement);
  }

  /**
   * Liste à cocher d'un contenant : une ligne par article (case, désignation, quantité modifiable).
   * Les dates de péremption sont masquées ; un repère signale un article périmé ou bientôt périmé,
   * et le bouton « Péremptions » (ou ce repère) affiche les dates.
   */
  let peremptionsVisibles = false;
  const datesOuvertes = new Set(); // articles dont on a ouvert la date en touchant leur repère
  /** Ligne d'un contrôle en check-list : champ adapté au type, rouge si hors plage. */
  /** Petite mention « facultatif » après le nom d'un article qui peut manquer sans anomalie. */
  const mentionFacultatif = (a) => (estFacultatif(a) ? el('small', { classe: 'inv-facultatif', title: 'Facultatif : son absence ne rend pas l\'inventaire non conforme', texte: ' facultatif' }) : null);
  /** Commentaire d'un article (saisi en gestion), visible de tous sous l'article. */
  const noteCommentaire = (a) => (a && a.commentaire ? el('p', { classe: 'inv-commentaire', texte: a.commentaire }) : null);
  /** Liste déroulante des appareils du suivi du matériel (du type attendu) : le choix inscrit son n° interne SMUR. */
  function listeAppareils(a, remplir) {
    const appareils = appareilsPour(a).sort((x, y) => x.type.localeCompare(y.type, 'fr') || String(x.numInterne).localeCompare(String(y.numInterne), 'fr', { numeric: true }));
    if (!appareils.length) return null;
    const sel = el('select', { classe: 'inv-liste-appareils', 'aria-label': `Choisir dans la liste : ${nomArticle(a)}`, title: 'Choisir dans la liste' },
      el('option', { value: '', texte: 'Liste…' }),
      ...appareils.map((x, i) => el('option', { value: String(i), texte: libelleAppareil(x) })));
    sel.addEventListener('change', () => {
      const x = appareils[Number(sel.value)];
      sel.value = '';
      if (x) remplir(codeAppareil(a, x));
    });
    return sel;
  }
  /**
   * `precedent` : valeur relevée à la dernière check-list (n° de matériel). Pour un contrôle qui attend un numéro,
   * elle s'affiche en grisé dans le champ vide, avec une coche au bout pour la reprendre ; laissé tel quel, le champ
   * reste non renseigné.
   */
  function ligneControle(a, b, modifie, precedent = '', datePrecedent = '') {
    const li = el('li', { classe: `inv-article inv-controle inv-controle-${a.controle}`, 'data-article': a.id });
    const champ = idChamp();
    const attente = texteAttente(a);
    const etiquette = el('label', { for: champ, classe: 'inv-nom' }, nomArticle(a), attente ? el('small', { classe: 'inv-attente', texte: ` (${attente})` }) : null, mentionFacultatif(a));
    const val = () => (b.valeurs[a.id] === undefined ? '' : String(b.valeurs[a.id]));
    const ligne = el('div', { classe: 'inv-ligne' }, el('span', { classe: 'inv-pastille-controle', 'aria-hidden': 'true' }), etiquette);
    const etat_ = () => {
      const e = evaluer(a, val());
      li.classList.toggle('controle-ok', e.ok);
      li.classList.toggle('controle-anomalie', e.rempli && !e.ok);
    };
    const poser = (v) => { b.valeurs[a.id] = v; etat_(); modifie(); };
    // Coche « reprendre le n° de la dernière check-list » : visible tant que le champ est vide.
    const reprise = (entree, remplir) => {
      if (!precedent) return null;
      entree.placeholder = datePrecedent ? `${precedent} (${datePrecedent})` : precedent;
      entree.classList.add('inv-valeur-fantome');
      const coche = el('button', { type: 'button', classe: 'cfg-mini inv-reprendre', 'aria-label': `Reprendre le numéro de la dernière check-list (${precedent}) : ${nomArticle(a)}`,
        title: `Reprendre ${precedent}${datePrecedent ? ` (relevé le ${datePrecedent})` : ''}`, texte: '✓', surclick: () => { remplir(precedent); } });
      const maj = () => { coche.hidden = entree.value.trim() !== ''; };
      entree.addEventListener('input', maj);
      maj();
      return { coche, maj };
    };
    let saisie;
    if (a.controle === 'oui') {
      saisie = el('span', { classe: 'inv-oui-non', role: 'group', 'aria-label': nomArticle(a) },
        ...['Oui', 'Non'].map((x) => el('button', { type: 'button', id: x === 'Oui' ? champ : undefined, classe: 'cfg-mini', 'aria-pressed': String(val() === x), texte: x, surclick: (e) => {
          const nv = val() === x ? '' : x;
          saisie.querySelectorAll('button').forEach((bt) => bt.setAttribute('aria-pressed', String(bt.textContent === nv)));
          poser(nv);
        } })));
    } else if (a.controle === 'batterie' && a.echelle === '4') {
      saisie = el('span', { classe: 'inv-batterie4', role: 'group', 'aria-label': `${nomArticle(a)} de 0 à 4` },
        ...['0', '1', '2', '3', '4'].map((x) => el('button', { type: 'button', id: x === '0' ? champ : undefined, classe: 'cfg-mini', 'aria-pressed': String(val() === x), texte: x, surclick: () => {
          const nv = val() === x ? '' : x;
          saisie.querySelectorAll('button').forEach((bt) => bt.setAttribute('aria-pressed', String(bt.textContent === nv)));
          poser(nv);
        } })));
    } else if (a.controle === 'materiel') {
      const entree = el('input', { id: champ, classe: 'inv-valeur inv-valeur-texte', autocomplete: 'off', maxlength: '120', placeholder: 'N° ou scanner', valeur: val(), surinput: (e) => { poser(e.target.value.trim()); majNom(); } });
      const nomAppareil = el('small', { classe: 'inv-attente inv-appareil-reconnu' });
      const majNom = () => { const x = appareilDe(a, val()); nomAppareil.textContent = x ? ` ${x.type}${x.modele ? ` ${x.modele}` : ''}` : ''; };
      let rep = null;
      const remplir = (t) => { entree.value = t; poser(t); majNom(); if (rep) rep.maj(); };
      rep = reprise(entree, remplir);
      const bouton = (classe, label, title, contenu, action) => el('button', { type: 'button', classe: `cfg-mini inv-bouton-lecture ${classe}`, 'aria-label': `${label} : ${nomArticle(a)}`, title, surclick: action }, contenu);
      saisie = el('span', { classe: 'inv-valeur-zone' }, entree, rep && rep.coche,
        bouton('', 'Scanner le QR code', 'QR code / code-barres', logoQr(), () => lireCode(remplir, { qr: true, nfc: false, article: a })),
        bouton('', 'Lire la puce NFC', 'Puce NFC', logoNfc(), () => lireCode(remplir, { qr: false, nfc: true, article: a })),
        listeAppareils(a, remplir));
      etiquette.append(nomAppareil);
      majNom();
    } else if (a.controle === 'scan') {
      const mode = modeScan(a);
      if (mode === 'liste') {
        // Choix dans une liste : un seul menu, rien à scanner ni à saisir.
        const choix = choixScan(a);
        if (val() && !choix.includes(val())) choix.push(val());
        saisie = el('span', { classe: 'inv-valeur-zone' }, el('select', { id: champ, classe: 'inv-valeur inv-liste-choix', 'aria-label': nomArticle(a), surchange: (e) => poser(e.target.value) },
          el('option', { value: '', selected: val() === '', texte: 'Choisir…' }),
          ...choix.map((x) => el('option', { value: x, selected: x === val(), texte: x }))));
      } else if (mode === 'duree') {
        // Durée saisie en clair (1h30, 45 min, 90) et conservée en minutes.
        const entree = el('input', { id: champ, classe: 'inv-valeur inv-valeur-texte', autocomplete: 'off', maxlength: '12', placeholder: 'ex. 1 h 30', 'aria-label': `${nomArticle(a)} (durée)`, valeur: val() === '' ? '' : texteDuree(val()),
          surinput: (e) => { const n = minutesDe(e.target.value); poser(n === null ? '' : String(n)); },
          surchange: (e) => { const n = minutesDe(e.target.value); e.target.value = n === null ? '' : texteDuree(n); } });
        saisie = el('span', { classe: 'inv-valeur-zone' }, entree);
      } else {
        // Libre ou valeur chiffrée entre 2 bornes : simple champ, avec la valeur de la dernière check-list en grisé.
        const plage = mode === 'plage';
        const entree = el('input', { id: champ, classe: `inv-valeur${plage ? '' : ' inv-valeur-texte'}`, ...(plage ? { type: 'text', inputmode: 'decimal', maxlength: '10' } : { autocomplete: 'off', maxlength: '120', placeholder: 'Saisir' }), valeur: val(),
          surinput: (e) => poser(plage ? e.target.value.trim().replace(',', '.') : e.target.value.trim()) });
        let rep = null;
        const remplir = (t) => { entree.value = t; poser(t); if (rep) rep.maj(); };
        rep = reprendPrecedent(a) ? reprise(entree, remplir) : null;
        const lecture = (classe, label, title, logo, opts) => el('button', { type: 'button', classe: 'cfg-mini inv-bouton-lecture', 'aria-label': `${label} : ${nomArticle(a)}`, title, surclick: () => lireCode(remplir, { ...opts, brut: true }) }, logo);
        saisie = el('span', { classe: 'inv-valeur-zone' }, entree, rep && rep.coche, plage && a.unite ? el('span', { classe: 'inv-qte-attendue', texte: a.unite }) : null,
          a.qr ? lecture('', 'Scanner le QR code ou code-barres', 'QR code / code-barres', logoQr(), { qr: true, nfc: false }) : null,
          a.nfc ? lecture('', 'Lire la puce NFC', 'Puce NFC', logoNfc(), { qr: false, nfc: true }) : null);
      }
    } else {
      const unite = a.controle === 'temperature' ? '°C' : (a.controle === 'batterie' ? '%' : (a.unite || ''));
      const entree = el('input', { id: champ, type: 'text', inputmode: 'decimal', classe: 'inv-valeur', autocomplete: 'off', maxlength: '8', valeur: val(), surfocus: (e) => e.target.select(),
        surinput: (e) => poser(e.target.value.trim().replace(',', '.')) });
      saisie = el('span', { classe: 'inv-valeur-zone' }, entree, unite ? el('span', { classe: 'inv-qte-attendue', texte: unite }) : null);
    }
    ligne.append(saisie);
    li.append(ligne);
    const note = noteCommentaire(a);
    if (note) li.append(note);
    etat_();
    return li;
  }
  /** Liste des appareils du suivi du matériel (du type attendu) : le choix inscrit son n° interne SMUR. */
  function choisirAppareil(a, surChoix) {
    const fond = el('div', { classe: 'fenetre-fond', surclick: (e) => { if (e.target === fond) fermer(); } });
    const retour = document.activeElement;
    const fermer = () => { fond.remove(); document.body.classList.remove('fenetre-ouverte'); if (retour && retour.isConnected) retour.focus(); };
    const titre = idChamp();
    const liste = appareilsPour(a).sort((x, y) => x.type.localeCompare(y.type, 'fr') || String(x.numInterne).localeCompare(String(y.numInterne), 'fr', { numeric: true }));
    fond.append(el('div', { classe: 'fenetre inv-etages', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titre },
      el('div', { classe: 'fenetre-entete' }, el('h2', { id: titre, texte: a.typeMateriel ? `Quel « ${a.typeMateriel} » ?` : 'Quel appareil ?' }),
        el('button', { type: 'button', classe: 'fenetre-fermer', 'aria-label': 'Fermer', texte: '✕', surclick: fermer })),
      liste.length ? el('ul', { classe: 'inv-etages-liste' }, ...liste.map((x) => el('li', {},
        el('button', { type: 'button', classe: 'inv-etage', surclick: () => { fermer(); surChoix(codeAppareil(a, x)); } },
          el('span', { classe: 'inv-etage-rang', 'aria-hidden': 'true', texte: x.numInterne || '?' }),
          el('span', { classe: 'inv-etage-nom', texte: `${x.type}${x.modele ? ` ${x.modele}` : ''}` }),
          x.numSerie ? el('small', { texte: `S/N ${x.numSerie}` }) : null))))
        : el('p', { classe: 'aide-question', texte: 'Aucun appareil de ce type dans le suivi du matériel (ou base pas encore chargée sur cet appareil) : saisissez le numéro.' })));
    fond.addEventListener('keydown', (e) => { if (e.key === 'Escape') fermer(); });
    document.body.append(fond);
    document.body.classList.add('fenetre-ouverte');
    fond.querySelector('.fenetre-fermer').focus();
  }
  /** Lit une valeur : QR code / code-barres (caméra) et/ou puce NFC (texte, lien ou n° de série de la puce). */
  async function lireCode(surLu, choix = { qr: true, nfc: true }) {
    if (choix.qr && Scannette.ordinateur()) {
      // Ordinateur : la scannette tape le code dans un champ.
      const fondScan = el('div', { classe: 'fenetre-fond' });
      const fermerScan = () => { fondScan.remove(); document.body.classList.remove('camera-ouverte'); };
      fondScan.addEventListener('click', (e) => { if (e.target === fondScan) fermerScan(); });
      fondScan.addEventListener('keydown', (e) => { if (e.key === 'Escape') fermerScan(); });
      fondScan.append(el('div', { classe: 'fenetre', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Scanner un code' },
        el('div', { classe: 'fenetre-entete' }, el('h2', { texte: 'Scanner un code' }),
          el('button', { type: 'button', classe: 'fenetre-fermer', 'aria-label': 'Fermer', texte: '✕', surclick: fermerScan })),
        el('div', { classe: 'fenetre-corps' }, Scannette.champ((t) => { fermerScan(); surLu(t); }))));
      document.body.append(fondScan);
      document.body.classList.add('camera-ouverte');
      Scannette.focusChamp(fondScan);
      return;
    }
    const qr = choix.qr && 'BarcodeDetector' in window && navigator.mediaDevices;
    const nfc = choix.nfc && 'NDEFReader' in window;
    if (!qr && !nfc) { messageVue(choix.nfc && !choix.qr ? 'NFC non disponible sur cet appareil (Chrome sur Android requis) : saisissez la valeur.' : 'Lecture de code non disponible sur cet appareil : saisissez la valeur.', 'erreur'); return; }
    const video = el('video', { playsinline: '', muted: '', autoplay: '' });
    video.muted = true;
    const lecture = el('p', { classe: 'lecture', role: 'status', texte: qr ? 'Ouverture de la caméra…' : 'Approchez la puce NFC du dos du téléphone.' });
    let flux = null;
    let fini = false;
    const arretNfc = new AbortController();
    const cacherCible = nfc ? CibleNfc.montrer() : () => {};
    const fermer = () => {
      if (fini) return;
      fini = true;
      arretNfc.abort();
      cacherCible();
      if (flux) flux.getTracks().forEach((t) => t.stop());
      ecran.remove();
      document.body.classList.remove('camera-ouverte');
    };
    // Appareil du suivi du matériel (puce MySMUR, étiquette biomed, n° de série) : on inscrit son n° interne SMUR.
    const lu = (t, tout) => {
      const brut = String(t || '').trim();
      if (!brut || fini) return;
      Scannette.vibrer();
      const appareil = typeof Materiel !== 'undefined' && !choix.brut ? Materiel.identifier(tout || brut) || Materiel.identifier(brut) : null;
      const v = ((appareil && codeAppareil(choix.article, appareil)) || brut).slice(0, 120);
      fermer();
      surLu(v);
      if (appareil) messageVue(`${libelleAppareil(appareil)} reconnu.`);
    };
    const ecran = el('div', { classe: 'camera', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Lire un code' },
      el('div', { classe: `camera-vue${qr ? '' : ' inv-nfc-seul'}` }, qr ? video : el('div', { classe: 'inv-attente-nfc', 'aria-hidden': 'true' }, logoNfc()),
        qr ? el('div', { classe: 'viseur viseur-qr', 'aria-hidden': 'true' }) : null,
        el('p', { classe: 'consigne-camera consigne-qr', texte: [qr ? 'Visez le QR code ou le code-barres' : '', nfc ? 'approchez la puce NFC' : ''].filter(Boolean).join(' ou ') })),
      lecture, nfc ? el('div', { classe: 'cible-nfc-lien-zone' }, CibleNfc.lien()) : null,
      el('div', { classe: 'camera-actions' }, el('button', { type: 'button', classe: 'camera-bouton secondaire', texte: 'Annuler', surclick: fermer })));
    document.body.append(ecran);
    document.body.classList.add('camera-ouverte');
    if (nfc) {
      const lecteur = new NDEFReader();
      lecteur.addEventListener('reading', (e) => {
        if (CibleNfc.enReglage()) return; // puce passée pour repérer l'antenne
        // Puce : premier enregistrement texte ou lien ; sinon, son n° de série (identifiant unique).
        const r = [...e.message.records].find((x) => ['text', 'url', 'absolute-url'].includes(x.recordType));
        let t = '';
        if (r) { try { t = new TextDecoder(r.encoding || 'utf-8').decode(r.data); } catch (err) { t = ''; } }
        // Tous les enregistrements (lien + texte d'une puce MySMUR) servent à reconnaître un appareil.
        const tout = [...e.message.records].map((x) => { try { return new TextDecoder(x.encoding || 'utf-8').decode(x.data); } catch (err) { return ''; } }).join('\n');
        lu(t || e.serialNumber, tout);
      });
      lecteur.scan({ signal: arretNfc.signal }).catch(() => { if (!qr) lecture.textContent = 'NFC refusé ou désactivé : activez le NFC, ou annulez et saisissez la valeur.'; });
    }
    if (!qr) return;
    try {
      flux = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      if (fini) { flux.getTracks().forEach((t) => t.stop()); return; }
      video.srcObject = flux;
      await video.play();
      lecture.textContent = '';
      const formats = BarcodeDetector.getSupportedFormats ? await BarcodeDetector.getSupportedFormats() : undefined;
      const det = formats && formats.length ? new BarcodeDetector({ formats }) : new BarcodeDetector();
      const boucle = async () => {
        if (fini) return;
        try { const r = await det.detect(video); if (r.length) { lu(r[0].rawValue); return; } } catch (e) { /* image suivante */ }
        setTimeout(boucle, 250);
      };
      boucle();
    } catch (e) { lecture.textContent = `Caméra inaccessible${nfc ? ' : approchez la puce NFC' : ''}, ou annulez et saisissez la valeur.`; }
  }
  function blocVerification(c) {
    const articles = aCocher(c);
    if (!articles.length) return null;
    const b = brouillon(c);
    const liste = el('ul', { classe: 'inv-articles' });
    const toutCocher = el('button', { type: 'button', classe: 'lien tout-cocher' });
    const compte = el('span', { classe: 'inv-compte' });
    const suivis = articles.filter(suiviPeremption);
    const basculer = suivis.length ? el('button', { type: 'button', classe: 'lien inv-basculer-dates' }) : null;
    const majBascule = () => {
      if (!basculer) return;
      liste.classList.toggle('dates-visibles', peremptionsVisibles);
      basculer.setAttribute('aria-pressed', String(peremptionsVisibles));
      basculer.textContent = peremptionsVisibles ? 'Masquer les péremptions' : `Péremptions (${suivis.length})`;
    };
    // « Tout cocher » et le compteur ne portent que sur les articles obligatoires :
    // un article facultatif se coche à la main, seulement s'il est là.
    const obligatoires = articles.filter((a) => !estFacultatif(a));
    const cases = obligatoires.filter((a) => !estControle(a));
    const maj = () => {
      const n = obligatoires.filter((a) => (estControle(a) ? evaluer(a, b.valeurs[a.id]).rempli : b.coches[a.id])).length;
      compte.textContent = `${n}/${obligatoires.length}`;
      const nc = cases.filter((a) => b.coches[a.id]).length;
      toutCocher.hidden = !cases.length;
      toutCocher.textContent = nc === cases.length ? 'Tout décocher' : 'Tout cocher';
      groupes.forEach((g) => { g.bouton.textContent = g.membres.every((a) => b.coches[a.id]) ? 'Tout décocher' : 'Tout cocher'; });
    };
    // Séparations : un intertitre par section, avec « Tout cocher » pour toute la section.
    const groupes = [];
    const modifie = () => {
      sauverBrouillons();
      if (confirmer) { confirmer = ''; messageVue(''); zone.querySelector('.inv-valider').textContent = 'Valider cet inventaire'; }
      majSignalement(c, b);
      maj();
    };
    // Photo placée dans la liste par le repère (sauf en tête : elle passe alors avant toute la section).
    const iPhoto = reperePhoto(c);
    const photoDansListe = iPhoto > 0 && vuesDe(c).some((x) => x.photo);
    c.articles.forEach((a, rang) => {
      if (estReperePhoto(a)) {
        if (!photoDansListe || rang !== iPhoto) return;
        const fils = enfants(c.id);
        const photo = [blocPhoto(c, fils), ...[].concat(blocEnfants(c, fils))].filter(Boolean);
        if (photo.length) liste.append(el('li', { classe: 'inv-photo-dans-liste' }, ...photo));
        return;
      }
      if (a.separateur) {
        const g = { membres: [] };
        let i = c.articles.indexOf(a) + 1;
        while (i < c.articles.length && !c.articles[i].separateur) { if (!estControle(c.articles[i]) && !estFacultatif(c.articles[i])) g.membres.push(c.articles[i]); i++; }
        g.bouton = el('button', { type: 'button', classe: 'lien inv-cocher-groupe', 'aria-label': `Tout cocher : section ${a.nom}`, surclick: () => {
          const tout = !g.membres.every((x) => b.coches[x.id]);
          g.membres.forEach((x) => { b.coches[x.id] = tout; const box = liste.querySelector(`input[data-article="${x.id}"]`); if (box) box.checked = tout; });
          modifie();
        } });
        if (g.membres.length) groupes.push(g);
        liste.append(el('li', { classe: 'inv-separation' }, el('span', { texte: a.nom }), g.membres.length ? g.bouton : null));
        return;
      }
      if (estControle(a)) {
        // N° de matériel relevé à la dernière check-list validée : proposé en grisé (jamais repris d'office).
        const der = etat.verifs[c.id];
        const precedent = reprendPrecedent(a) && der && der.valeurs && der.valeurs[a.id] !== undefined ? String(der.valeurs[a.id]).trim() : '';
        const dateDer = precedent && der.date ? new Date(der.date).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }) : '';
        liste.append(ligneControle(a, b, modifie, precedent, dateDer));
        return;
      }
      const champCase = idChamp();
      const coche = el('input', { type: 'checkbox', id: champCase, 'data-article': a.id, checked: Boolean(b.coches[a.id]), surchange: (e) => { b.coches[a.id] = e.target.checked; modifie(); } });
      const li = el('li', { classe: 'inv-article', 'data-article': a.id });
      const ligne = el('div', { classe: 'inv-ligne' }, coche, el('label', { for: champCase, classe: 'inv-nom' }, nomArticle(a), mentionFacultatif(a)));
      const ficheA = fiche(a);
      if (ficheA && ficheA.photo) {
        // Vignette de l'article : la toucher ouvre la photo en grand et les informations de la fiche.
        const vignette = el('button', { type: 'button', classe: 'inv-vignette', 'aria-label': `Photo et informations : ${nomArticle(a)}`, surclick: () => voirFiche(ficheA) });
        const poser = (d) => { if (d) vignette.append(el('img', { src: d, alt: '' })); };
        if (Photos.enMemoire(ficheA.photo)) poser(Photos.enMemoire(ficheA.photo)); else obtenirPhoto(ficheA.photo).then(poser);
        ligne.insertBefore(vignette, ligne.children[1]);
      }
      const att = attendue(a);
      if (att !== null) {
        const champQte = el('input', {
          type: 'number', inputmode: 'numeric', min: '0', max: '999', step: '1', classe: 'inv-qte',
          'aria-label': `Quantité de ${nomArticle(a)} (attendu ${estMinimum(a) ? 'au moins ' : ''}${att})`, valeur: String(trouvee(a, b)),
          surfocus: (e) => e.target.select(),
          surinput: (e) => {
            const v = e.target.value === '' ? '' : Math.max(0, Math.round(Number(e.target.value)));
            b.quantites[a.id] = v;
            champQte.classList.toggle('insuffisant', v !== '' && ecartQuantite(att, v, estMinimum(a)));
            modifie();
          },
        });
        champQte.classList.toggle('insuffisant', ecartQuantite(att, Number(trouvee(a, b)), estMinimum(a)));
        ligne.append(el('span', { classe: 'inv-qte-zone' }, champQte, el('span', { classe: 'inv-qte-attendue', 'aria-hidden': 'true', title: estMinimum(a) ? 'Quantité minimale' : 'Quantité exacte', texte: `/${estMinimum(a) ? '≥' : ''}${att}` })));
      } else if (a.quantite) {
        ligne.append(el('span', { classe: 'inv-qte-attendue', texte: a.quantite }));
      }
      li.append(ligne);
      const note = noteCommentaire(a);
      if (note) li.append(note);
      if (suiviPeremption(a)) {
        const champ = idChamp();
        const echeance = el('span', { classe: 'inv-echeance' });
        // Le repère n'ouvre (ou ne referme) que la date de cet article ; « Péremptions » les affiche toutes.
        const repere = el('button', { type: 'button', classe: 'inv-repere-date', 'aria-expanded': String(datesOuvertes.has(a.id)), surclick: () => {
          const ouvrir = !datesOuvertes.has(a.id);
          if (ouvrir) datesOuvertes.add(a.id); else datesOuvertes.delete(a.id);
          li.classList.toggle('date-ouverte', ouvrir);
          repere.setAttribute('aria-expanded', String(ouvrir));
          if (ouvrir) liste.querySelector(`#${champ}`).focus();
        } });
        if (datesOuvertes.has(a.id)) li.classList.add('date-ouverte');
        const montrer = () => {
          const p = b.invalides[a.id] ? { niveau: 'perime', texte: 'Date non reconnue' } : etatPeremption(dateCourante(c, a, b));
          echeance.textContent = p.texte;
          li.className = `inv-article ${p.niveau}`;
          // Repère visible même dates masquées : seulement quand il y a quelque chose à voir.
          repere.hidden = p.niveau === 'ok';
          repere.textContent = p.niveau === 'perime' ? '!' : (p.niveau === 'proche' ? '⏳' : '?');
          repere.setAttribute('aria-label', `${nomArticle(a)} : ${p.texte}. Afficher sa date de péremption`);
          li.classList.toggle('date-ouverte', datesOuvertes.has(a.id));
          repere.title = p.texte;
        };
        ligne.insertBefore(repere, ligne.querySelector('.inv-qte-zone, .inv-qte-attendue'));
        li.append(el('div', { classe: 'inv-peremption' },
          el('label', { for: champ, texte: 'Pér.' }),
          el('input', {
            id: champ, inputmode: 'numeric', autocomplete: 'off', placeholder: 'MM/AAAA', classe: 'inv-date',
            valeur: afficherDate(dateCourante(c, a, b)),
            surchange: (e) => {
              const iso = analyserDate(e.target.value);
              if (iso === null) b.invalides[a.id] = true;
              else { delete b.invalides[a.id]; b.dates[a.id] = iso; e.target.value = afficherDate(iso); }
              montrer();
              modifie();
            },
          }), echeance));
        montrer();
      }
      liste.append(li);
    });
    toutCocher.addEventListener('click', () => {
      const tout = !cases.every((a) => b.coches[a.id]);
      cases.forEach((a) => { b.coches[a.id] = tout; });
      cases.forEach((a) => { const x = liste.querySelector(`input[data-article="${a.id}"]`); if (x) x.checked = tout; });
      modifie();
    });
    if (basculer) basculer.addEventListener('click', () => { peremptionsVisibles = !peremptionsVisibles; majBascule(); });
    // Une date non reconnue reste visible pour être corrigée.
    if (articles.some((a) => b.invalides[a.id])) peremptionsVisibles = true;
    maj();
    majBascule();
    const champRemarque = idChamp();
    const v = etat.verifs[c.id];
    const veille = v && !verifDuJour(c.id) && (v.manquants.length || v.remarque)
      ? el('p', { classe: `note-parc${v.manquants.length ? ' anomalie' : ''}`, texte: `Dernière vérification le ${new Date(v.date).toLocaleDateString('fr-FR')} par ${v.agent} : ${[v.manquants.length ? `manquant : ${v.manquants.map((m) => m.nom).join(', ')}` : '', v.remarque].filter(Boolean).join(' — ')}` })
      : null;
    // « Tout cocher » de l'en-tête coche toutes les sections d'un coup.
    if (groupes.length) toutCocher.setAttribute('aria-label', 'Tout cocher : toutes les sections');
    return [
      el('section', { classe: 'inv-section' },
        el('div', { classe: 'inv-liste-entete' },
          el('h2', {}, 'Contenu ', compte),
          el('div', { classe: 'inv-liste-actions' }, basculer, toutCocher)),
        veille, liste,
        el('details', { classe: 'inv-remarque', open: Boolean(b.remarque) },
          el('summary', { texte: 'Ajouter une remarque' }),
          el('textarea', { id: champRemarque, rows: '2', maxlength: '500', 'aria-label': 'Remarque', valeur: b.remarque, surinput: (e) => { b.remarque = e.target.value; sauverBrouillons(); } }))),
      // Barre collée en bas de l'écran : « Valider » toujours à portée du pouce, QR code et NFC en pictogrammes.
      el('div', { classe: 'inv-barre-bas' },
        el('p', { classe: 'message inv-message', role: 'alert', hidden: true }),
        el('div', { classe: 'inv-barre-bas-boutons' }, boutonsScanIcones()[0],
          el('button', { type: 'button', classe: 'principal inv-valider', texte: 'Valider cet inventaire', surclick: () => valider(c) }),
          boutonsScanIcones()[1])),
    ];
  }

  /** Éléments vérifiés par la check-list ambulancier (fenêtre de la gommette, page du contenant). */
  function blocNiveauxOxygene(c) {
    const r = releveAmbulancier(c);
    if (!r.vehicule) {
      return el('p', { classe: 'aide-question', texte: 'Vérifié par la check-list ambulancier, mais le véhicule n\'est pas reconnu (nom du contenant primaire).' });
    }
    const nomV = r.vehicule.nom || r.vehicule.id;
    if (!r.statut) {
      return el('div', { classe: 'inv-oxygene' },
        el('p', { classe: 'inv-statut afaire' }, el('strong', { texte: 'À vérifier' })),
        el('p', { classe: 'aide-question', texte: `Vérifié par la check-list ambulancier de ${nomV}, pas encore faite aujourd'hui.` }),
        r.attendus.length ? el('ul', { classe: 'inv-amb-attendus' }, ...r.attendus.map((x) => el('li', { texte: x.nom }))) : null);
    }
    const anomalie = r.niveaux.some((n) => n.bas) || r.items.some((i) => !i.ok);
    return el('div', { classe: 'inv-oxygene' },
      el('p', { classe: `inv-statut fait${anomalie ? ' anomalie' : ''}` }, el('strong', { texte: '✓ Vérifié aujourd\'hui par l\'ambulancier' })),
      r.niveaux.length
        ? el('ul', { classe: 'inv-oxy-liste' }, ...r.niveaux.map((n) => el('li', { classe: n.bas ? 'bas' : (n.valeur <= 5 ? 'moyen' : '') },
          el('span', { classe: 'inv-oxy-nom', texte: n.nom }),
          el('span', { classe: 'inv-oxy-jauge', 'aria-hidden': 'true' }, el('span', { style: `width:${Math.max(0, Math.min(10, n.valeur)) * 10}%` })),
          el('span', { classe: 'inv-oxy-valeur', texte: `${n.valeur}/10 · ${n.valeur * 20} bars` }))))
        : null,
      r.items.length
        ? el('ul', { classe: 'inv-amb-items' }, ...r.items.map((i) => el('li', { classe: i.ok ? 'ok' : 'manquant' },
          el('span', { classe: 'inv-amb-picto', 'aria-hidden': 'true', texte: i.ok ? '✓' : '✗' }),
          el('span', { texte: i.ok ? i.nom : `${i.nom} : manquant` }))))
        : null,
      !r.niveaux.length && !r.items.length ? el('p', { classe: 'aide-question', texte: 'Aucun des éléments vérifiés ici ne figure dans cette check-list.' }) : null,
      el('p', { classe: 'inv-mention-validation', texte: `Check-list ${nomV} à ${heure(r.statut.date)}${r.statut.agent ? ` par ${r.statut.agent}` : ''}` }));
  }
  function voirOxygene(c) {
    const fond = el('div', { classe: 'fenetre-fond', surclick: (e) => { if (e.target === fond) fermer(); } });
    const retour = document.activeElement;
    const fermer = () => { fond.remove(); document.body.classList.remove('fenetre-ouverte'); if (retour && retour.isConnected) retour.focus(); };
    const titre = idChamp();
    fond.append(el('div', { classe: 'fenetre', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titre },
      el('div', { classe: 'fenetre-entete' }, el('h2', { id: titre, texte: c.nom }),
        el('button', { type: 'button', classe: 'fenetre-fermer', 'aria-label': 'Fermer', texte: '✕', surclick: fermer })),
      el('div', { classe: 'fenetre-corps' }, blocNiveauxOxygene(c),
        aCocher(c).length || enfants(c.id).length || gestion
          ? el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Ouvrir l\'inventaire', surclick: () => { fermer(); aller(c.id); } }) : null)));
    fond.addEventListener('keydown', (e) => { if (e.key === 'Escape') fermer(); });
    document.body.append(fond);
    document.body.classList.add('fenetre-ouverte');
    fond.querySelector('.fenetre-fermer').focus();
  }

  /** Fenêtre d'un article de la base : photo en grand et informations (vérification). */
  function voirFiche(f) {
    const fond = el('div', { classe: 'fenetre-fond', surclick: (e) => { if (e.target === fond) fermer(); } });
    const retour = document.activeElement;
    const fermer = () => { fond.remove(); document.body.classList.remove('fenetre-ouverte'); if (retour) retour.focus(); };
    const img = el('img', { classe: 'inv-fiche-grande', alt: f.denomination });
    obtenirPhoto(f.photo).then((d) => { if (d) img.src = d; });
    const lignes = [['Catégorie', f.categorie], ['Réf. interne', f.refInterne], ['Réf. fournisseur', f.refFournisseur],
      ['Consommable', f.consommable ? 'Oui' : 'Non'], ['Périssable', f.perissable ? 'Oui' : 'Non'], ['Dotation hors stock', f.horsStock ? 'Oui' : 'Non'],
      ...(f.categorie === 'Documents' ? [['Secrétariat', f.secretariat ? 'Oui' : 'Non']] : [])];
    const titre = idChamp();
    fond.append(el('div', { classe: 'fenetre', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titre },
      el('div', { classe: 'fenetre-entete' }, el('h2', { id: titre, texte: f.denomination }),
        el('button', { type: 'button', classe: 'fenetre-fermer', 'aria-label': 'Fermer', texte: '✕', surclick: fermer })),
      el('div', { classe: 'fenetre-corps' }, f.photo ? img : null,
        el('dl', { classe: 'reponses' }, ...lignes.filter(([, v]) => v).map(([k, v]) => el('div', { classe: 'reponse' }, el('dt', { texte: k }), el('dd', { texte: v })))))));
    fond.addEventListener('keydown', (e) => { if (e.key === 'Escape') fermer(); });
    document.body.append(fond);
    document.body.classList.add('fenetre-ouverte');
    fond.querySelector('.fenetre-fermer').focus();
  }

  // ---------- Accès à un inventaire : saisie, QR code, NFC ----------
  function logoQr() {
    const carres = [[1, 1], [15, 1], [1, 15]].flatMap(([x, y]) => [
      el('svg:rect', { x, y, width: 8, height: 8, rx: 1.5, fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }),
      el('svg:rect', { x: x + 3, y: y + 3, width: 2, height: 2, fill: 'currentColor' })]);
    const points = [[15, 15], [19, 15], [17, 17], [15, 19], [19, 19], [21, 21], [12, 3], [12, 7], [3, 12], [7, 12], [12, 12]]
      .map(([x, y]) => el('svg:rect', { x, y, width: 2, height: 2, fill: 'currentColor' }));
    return el('svg:svg', { viewBox: '0 0 24 24', classe: 'inv-logo', 'aria-hidden': 'true' }, ...carres, ...points);
  }
  function logoNfc() {
    return el('svg:svg', { viewBox: '0 0 24 24', classe: 'inv-logo', 'aria-hidden': 'true' },
      el('svg:rect', { x: 3, y: 2, width: 18, height: 20, rx: 3, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8 }),
      el('svg:path', { d: 'M8 16V8l8 8V8', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  }
  /**
   * Recherche par le nom, dépliée par la loupe de la page des inventaires. Le nom ne dit pas où se trouve
   * l'agent : il choisit d'abord le contenant primaire dans lequel il est. Les inventaires de ce contenant
   * s'ouvrent pour être vérifiés ; sans choix, ou ailleurs, ils s'ouvrent en consultation seule.
   * (Le QR code et la puce NFC, lus sur place, ouvrent toujours l'inventaire pour le vérifier.)
   */
  let recherchePrimaire = '';
  let toutAfficherRecherche = false;
  let masquerTypes = false; // gestion : inventaires types (et leur contenu) masqués des résultats
  function encadreRecherche(tous) {
    const panneau = el('section', { id: 'inv-panneau-recherche', classe: 'inv-panneau-recherche', 'aria-label': 'Chercher un inventaire', hidden: !rechercheOuverte });
    if (!rechercheOuverte) return panneau;
    const primaires = tous.filter((c) => c.categorie === 'primaire' && !dansUnModele(c.id))
      .sort((x, y) => x.ordre - y.ordre || x.nom.localeCompare(y.nom, 'fr'));
    if (recherchePrimaire && !primaires.some((p) => p.id === recherchePrimaire)) recherchePrimaire = '';
    const resultats = el('ul', { classe: 'inv-liste inv-resultats-recherche' });
    const champ = idChamp();
    const groupe = idChamp();
    const dansPrimaire = (c) => Boolean(recherchePrimaire) && (primaireDe(c.id) || {}).id === recherchePrimaire;
    const filtrer = () => {
      resultats.innerHTML = '';
      const mots = cle(recherche).split(' ').filter(Boolean);
      if (!mots.length || cle(recherche).length < 2) return;
      // Sur le nom du contenant lui-même : « sac rouge » trouve les sacs rouges, pas tout ce qu'ils contiennent.
      const trouves = tous.filter((c) => !c.emplacement && !(gestion && masquerTypes && (c.modele || dansUnModele(c.id))) && mots.every((m) => cle(c.nom).includes(m)))
        .sort((a, b) => (dansPrimaire(b) - dansPrimaire(a)) || a.nom.localeCompare(b.nom, 'fr'));
      trouves.slice(0, toutAfficherRecherche ? trouves.length : 12).forEach((c) => {
        const verifiable = gestion || dansPrimaire(c);
        const parents = etagesAuDessus(c).reverse().map((x) => x.nom).join(' › ');
        const ligne = carte(c);
        if (parents) ligne.querySelector('.inv-carte-etat').prepend(`${parents} · `);
        if (!verifiable) ligne.querySelector('strong').append(el('span', { classe: 'inv-tag-scellable inv-tag-consultation', texte: 'Consultation' }));
        // Avant la navigation (écouteur de la zone) : on note où l'on est et ce que l'on peut faire.
        ligne.addEventListener('click', () => { if (!gestion) fixerContexte(verifiable ? recherchePrimaire : '', !verifiable); });
        resultats.append(el('li', {}, ligne));
      });
      if (trouves.length > 12 && !toutAfficherRecherche) {
        resultats.append(el('li', {}, el('button', {
          type: 'button', classe: 'inv-resultat inv-voir-tout',
          surclick: () => { toutAfficherRecherche = true; filtrer(); },
        }, el('strong', { texte: `Afficher les ${trouves.length - 12} autres résultats` }))));
      }
      if (!trouves.length) resultats.append(el('li', { classe: 'aide-question', texte: masquerTypes && gestion ? 'Aucun inventaire à ce nom (types masqués).' : 'Aucun inventaire à ce nom.' }));
    };
    const choix = gestion || !primaires.length ? null : el('div', { classe: 'inv-recherche-primaire' },
      el('span', { classe: 'inv-libelle-recherche', id: groupe, texte: 'Vous êtes dans :' }),
      el('div', { classe: 'puces', role: 'radiogroup', 'aria-labelledby': groupe },
        ...primaires.flatMap((p) => {
          const i = idChamp();
          return [el('input', { type: 'radio', name: groupe, id: i, checked: recherchePrimaire === p.id, surchange: () => { recherchePrimaire = p.id; rendre({ garderPosition: true, focus: '.inv-recherche-champ' }); } }),
            el('label', { for: i, texte: p.nom })];
        })),
      el('p', { classe: 'aide-question', texte: recherchePrimaire
        ? 'Les inventaires de ce contenant s\'ouvrent pour être vérifiés ; ceux d\'ailleurs, en consultation.'
        : 'Sans contenant primaire choisi, l\'inventaire trouvé s\'ouvre en consultation seule.' }));
    const caseTypes = idChamp();
    const filtreTypes = gestion ? el('label', { for: caseTypes, classe: 'inv-filtre-types' },
      el('input', { type: 'checkbox', id: caseTypes, checked: masquerTypes, surchange: (e) => { masquerTypes = e.target.checked; toutAfficherRecherche = false; filtrer(); } }),
      ' Masquer les inventaires types') : null;
    panneau.append(...[choix,
      el('label', { for: champ, classe: 'invisible', texte: 'Nom de l\'inventaire' })].filter(Boolean),
      el('input', { id: champ, type: 'search', classe: 'inv-recherche-champ', valeur: recherche, autocomplete: 'off', placeholder: 'F25, sac rouge, ampoulier…', surinput: (e) => { recherche = e.target.value; toutAfficherRecherche = false; filtrer(); } }),
      ...(filtreTypes ? [filtreTypes] : []), resultats);
    filtrer();
    return panneau;
  }

  // ---------- Contenants mobiles : identification et désaffectation ----------
  /**
   * Même règle que le serveur (action « deplacerContenant ») : `x` (identifié) prend la place de `y` (prévu) —
   * parent, rang, gommettes — et quitte son ancien contenant ; `y` est désaffecté jusqu'à ce qu'on
   * l'identifie ailleurs (perte de matériel possible : signalé sur la page des inventaires).
   */
  function affecterLocal(x, y, date = new Date().toISOString(), dans = '') {
    if (y && y.emplacement) { const e = y; y = enfants(e.id).find((c) => c.id !== x.id) || null; if (!y) { if (x.parent === e.id) return; dans = e.id; } }
    if (dansUnModele(x.id) || (y && dansUnModele(y.id))) return;
    const versY = y ? y.parent : dans;
    const p = contenant(versY);
    if (!versY || !p) return;
    // L'ancien contenant de x garde sa gommette : place libre pour le prochain mobile rangé là.
    if (y) {
      traduireCibles(p, (cible) => (cible === y.id ? x.id : cible));
      x.ordre = y.ordre;
      y.parent = '';
      y.desaffecte = { depuis: date, de: versY, deNom: cheminNoms(versY), par: App.agent() };
    } else {
      // Reprend une gommette libre de ce contenant, de préférence celle d'un contenant du même type.
      const libres = [p.points, ...p.vues.map((v) => v.points)].flat().map((pt) => pt.cible)
        .filter((id) => id !== x.id && (!structure.contenants[id] || structure.contenants[id].parent !== versY));
      const reprise = libres.find((id) => structure.contenants[id] && x.source && structure.contenants[id].source === x.source) || libres[0];
      if (reprise) traduireCibles(p, (cible) => (cible === reprise ? x.id : cible));
      x.ordre = Math.max(-1, ...enfants(versY).map((c) => c.ordre)) + 1;
    }
    x.parent = versY;
    delete x.desaffecte;
    sauverStructure();
  }
  /** Après un rechargement : les affectations encore en file d'attente restent appliquées sur l'appareil. */
  function reappliquerDeplacements() {
    App.fileAttente().filter((e) => e.action === 'deplacerContenant').forEach((e) => {
      const x = contenant(e.contenant);
      if (!x || x.parent === e.vers) return;
      if (e.dans) affecterLocal(x, null, e.date, e.dans);
      else { const y = structure.contenants[e.place]; if (y && y.parent === e.vers) affecterLocal(x, y, e.date); }
    });
    App.fileAttente().filter((e) => e.action === 'ignorerDesaffectation').forEach((e) => {
      const c = contenant(e.contenant);
      if (c && c.desaffecte && !c.parent && !c.desaffecte.ignore) c.desaffecte.ignore = { le: e.date, par: App.agent() };
    });
  }
  /*
   * Réparation (administrateur, gestion des inventaires) : avant le correctif, rouvrir un emplacement déjà pointé
   * pouvait désaffecter l'emplacement lui-même (il porte le nom de l'inventaire type attendu, ex. « Sac ROUGE »)
   * au lieu de son occupant. On le remet dans son contenant, avec les gommettes, et l'occupant y retourne.
   */
  function reparerEmplacements() {
    const remis = [];
    Object.values(structure.contenants).filter((e) => !e.supprime && e.emplacement && e.desaffecte && !e.parent).forEach((e) => {
      const p = contenant(e.desaffecte.de);
      if (!p || p.supprime) return;
      // Le contenant qui a pris sa place : même rang, contenant mobile d'un des modèles attendus.
      const modeles = modelesEmplacement(e);
      const x = enfants(p.id).find((c) => c.categorie === 'mobile' && !c.emplacement && c.ordre === e.ordre && (!c.source || modeles.includes(c.source)));
      e.parent = p.id;
      delete e.desaffecte;
      if (x && !enfants(e.id).length) {
        traduireCibles(p, (cible) => (cible === x.id ? e.id : cible));
        x.parent = e.id;
        x.ordre = 0;
        marquer(x.id);
      }
      marquer(e.id);
      marquer(p.id);
      remis.push(`« ${e.nom} » (${cheminNoms(p.id)})`);
    });
    if (remis.length) avis = `Emplacement remis en place : ${remis.join(', ')}. Il avait été désaffecté par erreur.`;
  }
  /** Contenants mobiles désaffectés (à retrouver), du plus ancien au plus récent. */
  const aRetrouver = () => Object.values(structure.contenants)
    .filter((c) => !c.supprime && c.desaffecte && !c.desaffecte.ignore && !c.parent && !c.emplacement && !dansUnModele(c.id))
    .sort((a, b) => String(a.desaffecte.depuis).localeCompare(String(b.desaffecte.depuis)));
  /** Publie sur le mur d'accueil un contenant mobile à retrouver, avec le commentaire libre de l'agent. */
  function publierARetrouver(c) {
    const d = c.desaffecte || {};
    const quand = d.depuis ? `le ${new Date(d.depuis).toLocaleDateString('fr-FR')} à ${heure(d.depuis)}` : '';
    App.publierSurMur({
      types: ['materiel-recuperer', 'accident', 'information'],
      importance: 'importante',
      titre: `${c.nom} à retrouver`,
      texte: `« ${c.nom} » n'est plus à sa place : il était dans ${d.deNom || '?'} (constaté ${quand}${d.par ? ` par ${d.par}` : ''}).\n`,
      surPublie: () => { avis = navigator.onLine ? 'Alerte publiée sur le mur.' : 'Alerte enregistrée : elle sera publiée sur le mur au retour du réseau.'; rendre({ garderPosition: true }); },
    });
  }
  /** Alerte ignorée (pas de publication) : le contenant reste désaffecté, noté sur sa fiche, mais n'est plus signalé ici. */
  function ignorerARetrouver(c) {
    const date = new Date().toISOString();
    const ok = App.mettreEnFile({ action: 'ignorerDesaffectation', contenant: c.id, date });
    if (!ok) { messageVue('Non enregistré : la mémoire de l\'appareil est pleine.', 'erreur'); return; }
    c.desaffecte.ignore = { le: date, par: App.agent() };
    sauverStructure();
    avis = `Alerte ignorée : « ${c.nom} » reste désaffecté (noté sur sa fiche) jusqu'à ce qu'on l'identifie quelque part.`;
    rendre({ garderPosition: true });
  }
  // ----- Désarmement des véhicules (desarmement.js, Desarmement.gs) -----
  /** Véhicule désarmé dont le contenu des tiroirs et placards n'a pas été localisé : question posée aux IADE. */
  function encadreContenuALocaliser() {
    if (typeof Desarmement === 'undefined') return null;
    const liste = Desarmement.enAttente();
    if (!liste.length) return null;
    return el('section', { classe: 'inv-a-retrouver dsm-a-localiser', role: 'alert' },
      el('h2', { texte: liste.length > 1 ? 'Contenu de véhicules désarmés à localiser' : `Contenu de ${liste[0].id} désarmé à localiser` }),
      el('p', { classe: 'aide-question', texte: 'L\'ambulancier ne savait pas ce qu\'était devenu le contenu des tiroirs et placards. Indiquez-le pour que les péremptions suivent.' }),
      el('ul', {}, ...liste.map((e) => el('li', {},
        el('strong', { texte: e.id }),
        el('span', { texte: ` — désarmé${e.depuis ? ` le ${new Date(e.depuis).toLocaleDateString('fr-FR')}` : ''}${e.par ? ` (${e.par})` : ''}` }),
        el('span', { classe: 'inv-a-retrouver-actions' },
          el('button', { type: 'button', classe: 'lien', texte: 'Où est le contenu ?', surclick: async () => { if (await Desarmement.repondre(e.id)) { avis = 'Contenu renseigné : les péremptions suivent.'; rendre({ garderPosition: true }); } } }))))));
  }
  /** Armement des véhicules : désarmer (avec la question du contenu) ou réarmer dans la journée. Ambulanciers et IADE. */
  function blocArmement() {
    if (typeof Desarmement === 'undefined' || estEtudiantApp()) return null;
    const vs = vehiculesArmables();
    if (!vs.length) return null;
    const desarmes = vs.filter((v) => Desarmement.estDesarme(v.id));
    return el('details', { classe: 'cfg-section dsm-armement', open: desarmes.length > 0 && Desarmement.enAttente().length > 0 },
      el('summary', { texte: `Armement des véhicules${desarmes.length ? ` — désarmé${desarmes.length > 1 ? 's' : ''} : ${desarmes.map((v) => v.id).join(', ')}` : ''}` }),
      el('ul', { classe: 'dsm-liste' }, ...vs.map((v) => {
        const desarme = Desarmement.estDesarme(v.id);
        const e = Desarmement.desarmements()[v.id];
        return el('li', { classe: desarme ? 'desarme' : '' },
          el('strong', { texte: v.nom || v.id }),
          el('span', { classe: 'dsm-etat', texte: desarme ? `Désarmé${e && Desarmement.resume(e) ? ` · ${Desarmement.resume(e)}` : ''}` : 'Armé' }),
          el('button', {
            type: 'button', classe: 'cfg-bouton', texte: desarme ? 'Réarmer' : 'Désarmer',
            surclick: async () => {
              if (await Desarmement.basculer(v.id, desarme)) {
                avis = navigator.onLine ? `${v.id} ${desarme ? 'armé' : 'désarmé'}.` : `${v.id} ${desarme ? 'armé' : 'désarmé'} : enregistré, envoi au retour du réseau.`;
                rendre({ garderPosition: true });
              }
            },
          }));
      })));
  }
  /** Véhicules qui s'arment et se désarment (VML, UMH). */
  const vehiculesArmables = () => listeVehicules().filter((v) => !v.inactif && /^(VML|UMH)$/i.test(String(v.modele || ''))).map((v) => ({ id: v.id, nom: v.nom || v.id }));
  const estEtudiantApp = () => App && App.role && App.role() === 'etudiant-iade';
  /** Caisses existantes (réarmement depuis des caisses). */
  const stocks = () => Object.values(structure.contenants).filter((c) => !c.supprime && c.stock && c.categorie === 'primaire' && !c.parent)
    .map((c) => ({ id: c.id, nom: c.nom, vehicule: c.stock.vehicule || '' }));

  /** Contenants supprimés par erreur : la suppression est douce (drapeau `supprime`), on peut les restaurer avec leurs sous-inventaires. */
  function blocSupprimes() {
    // Supprimés pendant cette session (encore en mémoire) ou connus du serveur.
    const parId = {};
    supprimesServeur.forEach((c) => { parId[c.id] = c; });
    Object.values(structure.contenants).filter((c) => c.supprime).forEach((c) => { parId[c.id] = c; });
    const tousC = Object.values(parId);
    const vivant = (id) => Boolean(id) && Boolean(structure.contenants[id]) && !structure.contenants[id].supprime;
    const sup = tousC.filter((c) => !vivant(c.id) && !(c.parent && parId[c.parent]));
    if (!sup.length) return null;
    const sousArbre = (id, vus = new Set()) => {
      if (vus.has(id)) return [];
      vus.add(id);
      return [id, ...tousC.filter((x) => x.parent === id).flatMap((x) => sousArbre(x.id, vus))];
    };
    return el('details', { classe: 'inv-groupe-reglages' },
      el('summary', { texte: `Contenants supprimés (${sup.length})` }),
      el('p', { classe: 'aide-question', texte: 'Supprimé par erreur ? « Restaurer » remet le contenant avec ses sous-inventaires. S\'il était dans un autre contenant, replacez sa gommette sur la photo du parent.' }),
      el('ul', { classe: 'inv-liste' }, ...sup.map((c) => el('li', {},
        el('strong', { texte: c.nom + (c.categorie ? ` (${c.categorie})` : '') }), ' ',
        el('button', {
          type: 'button', classe: 'cfg-bouton', texte: 'Restaurer',
          surclick: () => {
            const ids = sousArbre(c.id);
            ids.forEach((id) => {
              const brut = parId[id];
              if (!brut) return;
              const x = normaliser({ ...brut, supprime: undefined });
              delete x.supprime;
              structure.contenants[id] = x;
              marquer(id);
            });
            supprimesServeur = supprimesServeur.filter((x) => !ids.includes(x.id));
            avis = `« ${c.nom} » restauré${ids.length > 1 ? ` avec ses ${ids.length - 1} sous-inventaires` : ''}.`;
            rendre({ garderPosition: true });
          },
        }), ' ',
        el('button', {
          type: 'button', classe: 'cfg-bouton danger', texte: confirmer === `purge-${c.id}` ? 'Confirmer : effacer pour toujours' : 'Purger',
          surclick: async (e) => {
            if (confirmer !== `purge-${c.id}`) { confirmer = `purge-${c.id}`; rendre({ garderPosition: true }); return; }
            confirmer = '';
            e.target.disabled = true;
            const ids = sousArbre(c.id);
            let rep;
            try { rep = await App.appeler('purgerContenants', { ids }); } catch (err) { rep = { ok: false, erreur: 'pas de réseau' }; }
            if (!rep || !rep.ok) {
              avis = `Purge impossible : ${(rep && rep.erreur) || 'erreur inconnue'}${rep && rep.erreur === 'Action inconnue' ? ' (déployez la nouvelle version du serveur)' : ''}.`;
            } else {
              ids.forEach((id) => { if (structure.contenants[id] && structure.contenants[id].supprime) delete structure.contenants[id]; });
              supprimesServeur = supprimesServeur.filter((x) => !ids.includes(x.id));
              sauverStructure();
              avis = `« ${c.nom} » purgé définitivement${ids.length > 1 ? ` avec ses ${ids.length - 1} sous-inventaires` : ''}.`;
            }
            rendre({ garderPosition: true });
          },
        })))),
      sup.length > 1 ? el('p', { classe: 'aide-question', texte: 'La purge est définitive : le contenant ne pourra plus être restauré. Elle ne touche que des contenants déjà supprimés.' }) : null);
  }
  function encadreARetrouver() {
    const liste = aRetrouver();
    if (!liste.length) return null;
    return el('section', { classe: 'inv-a-retrouver', role: 'alert' },
      el('h2', { texte: `${pluriel(liste.length, 'contenant')} mobile${liste.length > 1 ? 's' : ''} à retrouver` }),
      el('p', { classe: 'aide-question', texte: 'Un autre a été trouvé à leur place lors d\'une vérification. Perte possible : à localiser avant la fin de la vérification du jour. Il suffit de l\'identifier dans le contenant où il se trouve.' }),
      el('ul', {}, ...liste.map((c) => {
        const d = c.desaffecte;
        const quand = d.depuis ? new Date(d.depuis) : null;
        return el('li', {}, el('a', { href: lien(c.id) }, el('strong', { texte: c.nom })),
          el('span', { texte: ` — était dans ${d.deNom || '?'}${quand ? `, désaffecté le ${quand.toLocaleDateString('fr-FR')} à ${heure(d.depuis)}` : ''}${d.par ? ` (${d.par})` : ''}` }),
          el('span', { classe: 'inv-a-retrouver-actions' },
            el('button', { type: 'button', classe: 'lien inv-publier-mur', texte: 'Publier une alerte sur le mur', surclick: () => publierARetrouver(c) }),
            el('button', { type: 'button', classe: 'lien inv-ignorer-alerte', texte: 'Ignorer', title: 'Ne pas publier et ne plus signaler ici (le contenant reste désaffecté)', surclick: () => ignorerARetrouver(c) })));
      })));
  }
  /** Le contenant `x`, identifié par l'agent, est celui qui se trouve à la place de `y`. */
  function confirmerIdentification(y, idX, dans = '') {
    const x = enregistrerIdentification(y, idX, dans);
    if (x) aller(x.id);
  }
  /** Enregistre l'identification (pointage, et déplacement si besoin) sans changer d'écran : le contenant `x`, ou null. */
  function enregistrerIdentification(y, idX, dans = '') {
    // Un emplacement ne quitte jamais son contenant : c'est son occupant qui est remplacé (ou, vide, il reçoit le contenant).
    if (y && y.emplacement) { const e = y; y = enfants(e.id)[0] || null; if (!y) dans = e.id; }
    if ((y && dansUnModele(y.id)) || (dans && dansUnModele(dans))) { messageVue('Un inventaire type ne se range pas dans un contenant.', 'erreur'); return null; }
    const x = contenant(idX);
    if (!x) { messageVue('Inventaire inconnu : vérifiez l\'étiquette ou la saisie.', 'erreur'); return null; }
    if (y && x.id === y.id) { noterPointage(y.parent, y.id); identification = ''; return x; }
    if (!y && x.parent === dans) { noterPointage(dans, x.id); identification = ''; return x; }
    if (x.categorie !== 'mobile' || x.emplacement || dansUnModele(x.id)) { messageVue(`« ${x.nom} » n'est pas un contenant mobile : choisissez celui qui se trouve réellement ici.`, 'erreur'); return null; }
    const vers = y ? y.parent : dans;
    const emp = contenant(vers) && contenant(vers).emplacement ? contenant(vers) : null;
    if (emp && !modelesEmplacement(emp).includes(x.source)) {
      const noms = modelesEmplacement(emp).map((m) => (contenant(m) || {}).nom).filter(Boolean);
      messageVue(`Cet emplacement attend un exemplaire de ${noms.length ? noms.map((n) => `« ${n} »`).join(' ou ') : 'l\'inventaire type prévu'} : « ${x.nom} » n'en est pas un.`, 'erreur');
      return null;
    }
    if (chemin(vers).some((c) => c.id === x.id)) { messageVue('Un contenant ne peut pas être rangé dans lui-même.', 'erreur'); return null; }
    const parent = contenant(vers);
    const date = new Date().toISOString();
    const ok = App.mettreEnFile({ action: 'deplacerContenant', contenant: x.id, ...(y ? { place: y.id } : { dans }), vers, date });
    if (!ok) { messageVue('Non enregistré : la mémoire de l\'appareil est pleine.', 'erreur'); return null; }
    affecterLocal(x, y, date, dans);
    noterPointage(vers, x.id);
    identification = '';
    // Ni l'emplacement précédent ni le contenant prévu ne sont dévoilés : les écarts sortent en fin de vérification.
    avis = `« ${x.nom} » identifié dans « ${parent ? parent.nom : '?'} ».`;
    return x;
  }
  /** Emplacement à plusieurs inventaires types : une photo par modèle, l'agent touche celui qu'il a sous les yeux. */
  /**
   * Familles de modèles d'après leur nom : les modèles qui commencent par les mêmes mots sont regroupés
   * (« Tempus Pro US », « Tempus Pro UK », « Tempus Pro hélico » → famille « Tempus Pro »). Un modèle sans
   * voisin (« LP15 », « Schiller T7 ») forme sa propre famille. L'ordre des modèles est conservé.
   */
  function famillesDe(types) {
    const mots = (t) => String(t.nom || '').trim().split(/\s+/);
    const commun = (a, b) => { let k = 0; while (k < a.length && k < b.length && cle(a[k]) === cle(b[k])) k += 1; return k; };
    const groupes = new Map();
    types.forEach((t) => {
      const m = mots(t);
      const k = Math.max(0, ...types.filter((u) => u.id !== t.id).map((u) => commun(m, mots(u))));
      const nom = k ? m.slice(0, k).join(' ') : t.nom;
      const id = k ? `f:${cle(nom)}` : `t:${t.id}`;
      if (!groupes.has(id)) groupes.set(id, { cle: id, nom, types: [] });
      groupes.get(id).types.push(t);
    });
    return [...groupes.values()];
  }
  /**
   * Appareil scanné qui désigne ce contenant : le contrôle « Matériel attendu » du contenant reçoit son n° sans nouveau scan, s'il est de ce type et vide. Jamais d'écrasement d'une valeur saisie.
   */
  function preRemplirMateriel(c, appareil) {
    if (!c || !appareil) return;
    const b = brouillon(c);
    let change = false;
    aCocher(c).filter((a) => a.controle === 'materiel').forEach((a) => {
      if (String(b.valeurs[a.id] || '').trim()) return;
      if (!typeAccepte(appareil.type, a.typeMateriel)) return;
      if (a.attendu && cle(appareil.numInterne) !== cle(String(a.attendu))) return;
      b.valeurs[a.id] = codeAppareil(a, appareil);
      change = true;
    });
    if (change) sauverBrouillons();
  }
  /**
   * Contenant lié à un appareil du suivi du matériel (ex. Schiller vissé dans sa housse) : scanner l'étiquette
   * biomed ou la puce de l'appareil désigne alors le contenant. Lien fort : le contenant porte un contrôle
   * « Matériel attendu » dont le n° désigne cet appareil. À défaut, par le nom : n° interne SMUR dans le nom du
   * contenant et modèle de l'appareil dans le nom du contenant ou de son inventaire type (« Schiller T7 » › « Schiller 1 »).
   * Renvoie le contenant s'il est seul à correspondre, sinon null.
   */
  function contenantDeAppareil(appareil, candidats) {
    if (!appareil) return null;
    // Lien choisi à la main (ex. matériel de prêt sans n° interne) : le contenant désigné, s'il est proposé ici.
    const manuel = candidats.find((c) => c.id === lireJson(CLE_LIENS_APPAREILS, {})[appareil.id]);
    if (manuel) return manuel;
    const lies = candidats.filter((c) => c.articles.some((a) => a.controle === 'materiel' && a.attendu
      && (appareilDe(a, a.attendu) || {}).id === appareil.id));
    if (lies.length === 1) return lies[0];
    if (lies.length > 1) return null;
    // Matériel de prêt (sans n° interne) : contenant nommé d'après la référence du prêt (« PRÊT 03 »).
    if (!cle(appareil.numInterne) && appareil.pret) {
      const ref = cle(appareil.pret).replace(/ /g, '');
      const parPret = candidats.filter((c) => cle(c.nom).replace(/ /g, '').includes(ref));
      if (parPret.length === 1) return parPret[0];
    }
    const num = cle(appareil.numInterne);
    if (!num) return null;
    const motsModele = cle(appareil.modele).split(' ').filter((m) => m.length >= 2);
    const numDans = new RegExp(`(^|[^0-9])${num.replace(/[^0-9a-z]/g, '')}([^0-9]|$)`);
    const parNom = candidats.filter((c) => {
      const noms = `${cle(c.nom)} ${cle((contenant(c.source) || {}).nom)}`;
      return numDans.test(cle(c.nom)) && (!motsModele.length || motsModele.some((m) => noms.includes(m)));
    });
    return parNom.length === 1 ? parNom[0] : null;
  }
  /** Photo d'un modèle : sa vignette (ex. scope dans sa housse, de face), sinon sa photo d'inventaire. */
  function photoModele(t) {
    const image = el('span', { classe: 'inv-type-photo', 'aria-hidden': 'true' });
    return remplirPhoto(image, t);
  }
  /** Images propres à une famille de modèles (clé = nom de la famille), affichées avant le choix de la configuration. */
  const IMAGES_FAMILLES = { 'tempus pro': 'img/scopes/tempus-pro.jpg' };
  /** Vignette d'une famille (ex. « Tempus Pro ») : son image dédiée si elle existe, sinon la photo de sa première configuration. */
  function photoFamille(g) {
    const src = IMAGES_FAMILLES[cle(g.nom)];
    if (!src) return photoModele(g.types[0]);
    return el('span', { classe: 'inv-type-photo inv-type-photo-famille', 'aria-hidden': 'true' }, el('img', { src, alt: '' }));
  }
  function remplirPhoto(image, t) {
    const imageType = t.vignette || t.photo;
    if (imageType) {
      const mettre = (d) => { if (d) image.append(el('img', { src: d, alt: '' })); };
      if (Photos.enMemoire(imageType)) mettre(Photos.enMemoire(imageType)); else obtenirPhoto(imageType).then(mettre);
    } else image.textContent = 'Pas de photo';
    return image;
  }
  /**
   * Choix sur photo du modèle présent. Si des modèles sont regroupés en famille (Tempus Pro), on touche
   * d'abord la famille puis sa configuration. Une seule famille (ex. les LS acceptés dans un Tempus Pro) :
   * ses configurations s'affichent directement, la première étant proposée.
   */
  function choixTypeEnPhotos(types, groupes, choisir) {
    const seule = groupes.length === 1;
    const famille = seule ? groupes[0]
      : groupes.find((g) => g.types.length > 1 && (g.cle === familleChoisie || g.types.some((t) => t.id === typeChoisi))) || null;
    const boutonType = (t, libelle) => {
      const n = exemplairesDe(t.id).length;
      return el('button', { type: 'button', role: 'radio', 'aria-checked': String(typeChoisi === t.id), classe: `inv-type${typeChoisi === t.id ? ' choisi' : ''}`,
        surclick: () => {
          // Un seul exemplaire de ce modèle : pas besoin de l'identifier, il est pris d'office.
          const ex = exemplairesDe(t.id).filter((x) => x.categorie === 'mobile' && !dansUnModele(x.id));
          if (ex.length === 1) { typeChoisi = t.id; choisir(ex[0].id); return; }
          typeChoisi = typeChoisi === t.id ? '' : t.id; rendre({ garderPosition: true });
        } },
        photoModele(t), el('strong', { texte: libelle }), el('small', { texte: pluriel(n, 'exemplaire') }));
    };
    const suiteNom = (t) => (famille && !seule ? t.nom.trim().split(/\s+/).slice(famille.nom.split(/\s+/).length).join(' ') : '') || t.nom;
    const etape = famille && !seule ? 3 : 2;
    const aide = typeChoisi ? `${etape}. Identifiez maintenant l'exemplaire : QR code, NFC ou liste.`
      : 'Vous pouvez aussi scanner directement l\'étiquette : le modèle sera reconnu.';
    if (famille) {
      return el('section', { classe: 'inv-choix-types', 'aria-label': 'Configuration présente' },
        seule ? null : el('button', { type: 'button', classe: 'inv-type-retour', surclick: () => { familleChoisie = ''; typeChoisi = ''; rendre({ garderPosition: true }); } }, `‹ ${famille.nom} : autre modèle`),
        el('p', { classe: 'inv-libelle-recherche', texte: seule ? '1. Touchez la configuration présente :' : `2. ${famille.nom} : touchez la configuration présente :` }),
        el('div', { classe: 'inv-types-grille', role: 'radiogroup' }, ...famille.types.map((t) => boutonType(t, suiteNom(t)))),
        seule && typeChoisi === famille.types[0].id ? el('p', { classe: 'aide-question', texte: 'Configuration proposée : touchez une autre photo si ce n\'est pas celle-ci.' }) : null,
        el('p', { classe: 'aide-question', texte: aide }));
    }
    return el('section', { classe: 'inv-choix-types', 'aria-label': 'Modèle présent' },
      el('p', { classe: 'inv-libelle-recherche', texte: '1. Touchez le modèle présent :' }),
      el('div', { classe: 'inv-types-grille', role: 'radiogroup' }, ...groupes.map((g) => {
        if (g.types.length === 1) return boutonType(g.types[0], g.types[0].nom);
        return el('button', { type: 'button', classe: 'inv-type inv-type-famille', 'aria-label': `${g.nom} : choisir la configuration`,
          surclick: () => { familleChoisie = g.cle; typeChoisi = ''; rendre({ garderPosition: true }); } },
          photoFamille(g), el('strong', { texte: g.nom }), el('small', { texte: `${g.types.length} configurations ›` }));
      })),
      el('p', { classe: 'aide-question', texte: aide }));
  }
  /** Écran « Quel … se trouve ici ? » : QR code, NFC ou saisie, avant l'inventaire d'un contenant mobile. */
  function vueIdentification(y, dans = '') {
    const lieu = contenant(y ? y.parent : dans);
    // Pour un emplacement, l'écran s'affiche depuis le contenant de l'emplacement (le sac).
    const parent = lieu && lieu.emplacement ? contenant(lieu.parent) : lieu;
    // Appareil reconnu mais sans contenant lié : le contenant choisi ensuite lui est rattaché (mémorisé sur l'appareil).
    let appareilEnAttente = null;
    const choisir = (id) => {
      const x = appareilEnAttente;
      if (appareilEnAttente) {
        const liens = lireJson(CLE_LIENS_APPAREILS, {});
        liens[appareilEnAttente.id] = id;
        ecrireJson(CLE_LIENS_APPAREILS, liens);
        // Partagé avec tous les appareils : envoyé au serveur (mis en file hors réseau).
        App.mettreEnFile({ action: 'lierAppareilContenant', appareil: appareilEnAttente.id, contenant: id });
        appareilEnAttente = null;
      }
      confirmerIdentification(y, id, dans);
      if (x) preRemplirMateriel(contenant(id), x);
    };
    const champ = idChamp();
    const resultats = el('ul', { classe: 'inv-liste inv-resultats-recherche' });
    // Emplacement : seuls les exemplaires de l'inventaire type attendu sont proposés.
    const emp = (() => { const p = contenant(y ? y.parent : dans); return p && p.emplacement ? p : null; })();
    // Plusieurs inventaires types acceptés : l'agent choisit d'abord, sur photo, le modèle présent.
    // Tous les modèles acceptés par l'emplacement sont proposés, même sans exemplaire pour l'instant
    // (le nombre d'exemplaires est indiqué sous chaque photo).
    const typesTous = emp ? modelesEmplacement(emp).map(contenant).filter(Boolean) : [];
    const typesAcceptes = typesTous;
    if (typeChoisi && !typesAcceptes.some((t) => t.id === typeChoisi)) typeChoisi = '';
    const plusieurs = typesAcceptes.length > 1;
    const groupes = famillesDe(typesAcceptes);
    if (familleChoisie && !groupes.some((g) => g.cle === familleChoisie)) familleChoisie = '';
    // Une seule famille (ex. LS attendu dans un Tempus Pro) : la première configuration est proposée, une fois.
    if (plusieurs && groupes.length === 1 && emp && typePropose !== emp.id) { typePropose = emp.id; if (!typeChoisi) typeChoisi = typesAcceptes[0].id; }
    const typeAttendu = plusieurs ? (typeChoisi ? contenant(typeChoisi) : null) : (typesAcceptes[0] || null);
    // Emplacement à un seul modèle, qui n'a qu'un exemplaire : rien à choisir, il est pris d'office.
    if (emp && !plusieurs && typeAttendu && autoIdentifie !== emp.id) {
      const ex = exemplairesDe(typeAttendu.id).filter((x) => x.categorie === 'mobile' && !dansUnModele(x.id));
      if (ex.length === 1) { autoIdentifie = emp.id; queueMicrotask(() => choisir(ex[0].id)); }
    }
    const familleOuverte = groupes.find((g) => g.cle === familleChoisie);
    const filtreTypes = typeAttendu ? [typeAttendu.id] : (familleOuverte || { types: typesAcceptes }).types.map((t) => t.id);
    const mobiles = Object.values(structure.contenants).filter((c) => !c.supprime && c.categorie === 'mobile' && !dansUnModele(c.id)
      && (!emp || filtreTypes.includes(c.source)));
    // Appareil scanné (étiquette biomed, n° de série, puce) : le contenant qui lui est lié, parmi tous les modèles acceptés.
    const candidatsAppareil = Object.values(structure.contenants).filter((c) => !c.supprime && c.categorie === 'mobile' && !dansUnModele(c.id)
      && (!emp || typesAcceptes.some((t) => t.id === c.source)));
    const parAppareil = (code) => {
      const app = appareilParCode(code);
      return app ? { appareil: app, c: contenantDeAppareil(app, candidatsAppareil) } : null;
    };
    const viaAppareil = (code) => {
      const r = parAppareil(code);
      if (!r) return null;
      if (!r.c && !mobiles.length) return () => messageVue(`${libelleAppareil(r.appareil)} reconnu, mais aucun contenant n'existe pour ce modèle : un administrateur doit d'abord créer l'exemplaire (Gestion des inventaires › inventaire type › Exemplaires, nom « ${r.appareil.pret || r.appareil.numInterne || 'n° de l\'appareil'} »).`, 'erreur');
      if (!r.c) return () => { appareilEnAttente = r.appareil; messageVue(`${libelleAppareil(r.appareil)} reconnu, mais aucun contenant ici ne lui est rattaché : choisissez le contenant dans la liste : il sera retenu pour cet appareil.`, 'erreur'); };
      return () => { choisir(r.c.id); preRemplirMateriel(r.c, r.appareil); };
    };
    // Même type d'abord : exemplaires du même contenant d'inventaire type, puis noms proches.
    const memeType = (c) => (emp ? true : y ? (y.source && c.source === y.source) || cle(c.nom).replace(/\d+|n°/g, '').trim() === cle(y.nom).replace(/\d+|n°/g, '').trim() : Boolean(c.desaffecte));
    const filtrer = (texte) => {
      resultats.innerHTML = '';
      // N° biomed ou de série saisi (ou douchette) : contenant de l'appareil en tête de liste.
      const r = String(texte || '').trim().length >= 3 ? parAppareil(texte) : null;
      if (r && r.c) {
        resultats.append(el('li', {}, el('button', { type: 'button', classe: 'inv-resultat', surclick: () => { choisir(r.c.id); preRemplirMateriel(r.c, r.appareil); } },
          el('strong', { texte: r.c.nom }), el('small', { texte: `${libelleAppareil(r.appareil)} reconnu` }))));
      }
      const mots = cle(texte).split(' ').filter(Boolean);
      const trouves = mobiles.filter((c) => mots.every((m) => cle(c.nom).includes(m)))
        .sort((a, b) => (memeType(b) - memeType(a)) || a.nom.localeCompare(b.nom, 'fr'));
      // Avant saisie : tous les contenants du même type, par ordre alphabétique (sans mettre en avant le prévu).
      (mots.length ? trouves : trouves.filter(memeType)).slice(0, 30).forEach((c) => {
        const ou = contenant(c.parent);
        resultats.append(el('li', {}, el('button', { type: 'button', classe: 'inv-resultat', surclick: () => choisir(c.id) },
          el('strong', { texte: c.nom }), el('small', { classe: c.desaffecte ? 'inv-desaffecte' : '', texte: c.desaffecte ? 'désaffecté : à retrouver' : '' }))));
      });
    };
    const saisie = el('input', { id: champ, type: 'search', autocomplete: 'off', placeholder: y ? `ex. ${y.nom.replace(/\s*n°\s*\d+$/i, '')}` : 'ex. ampoulier, sacoche, n° biomed', surinput: (e) => filtrer(e.target.value) });
    // Douchette : le n° biomed arrive suivi d'Entrée, l'appareil reconnu ouvre directement son contenant.
    saisie.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const suite = viaAppareil(saisie.value);
      if (suite) { e.preventDefault(); suite(); }
    });
    filtrer('');
    const qr = 'BarcodeDetector' in window;
    const nfc = 'NDEFReader' in window;
    return [
      parent ? barreContenant(parent, { h1: false, libelleRetour: parent.nom, retour: () => { identification = ''; rendre(); } }) : null,
      el('h1', { tabindex: '-1', texte: typeAttendu ? `Quel « ${typeAttendu.nom} » se trouve ici ?` : (plusieurs ? `Quel « ${emp.nom} » se trouve ici ?` : (y ? `Quel « ${y.nom.replace(/\s*n°\s*\d+$/i, '')} » se trouve ici ?` : 'Quel contenant mobile se trouve ici ?')) }),
      plusieurs ? choixTypeEnPhotos(typesAcceptes, groupes, choisir) : null,
      el('p', { classe: 'consigne' }, `Avant de vérifier son contenu et ses péremptions, identifiez le contenant réellement présent dans « ${parent ? parent.nom : ''} » : scannez son QR code, lisez sa puce NFC ou choisissez-le dans la liste.`),
      el('section', { classe: 'inv-encadre-recherche' },
        el('div', { classe: 'inv-boutons-scan' },
          el('button', { type: 'button', classe: 'inv-bouton-scan', disabled: !qr, surclick: () => scanner({ qr: true, nfc: false }, choisir, viaAppareil) }, logoQr(), el('span', { texte: 'Scanner son QR code' })),
          el('button', { type: 'button', classe: 'inv-bouton-scan', disabled: !nfc, surclick: () => scanner({ qr: false, nfc: true }, choisir, viaAppareil) }, logoNfc(), el('span', { texte: 'Lire sa puce NFC' }))),
        el('label', { for: champ, classe: 'inv-libelle-recherche inv-libelle-identif', texte: 'Ou choisissez-le :' }), saisie, resultats),
      el('p', { classe: 'message inv-message', role: 'alert', hidden: true }),
      el('p', { classe: 'aide-question', texte: `Lisez le nom sur le contenant ou scannez-le : il est à identifier à chaque vérification. Le contenant choisi sera rangé dans « ${parent ? parent.nom : ''} ».` }),
    ];
  }

  // ---------- Arborescence (ordinateur, à droite) ----------
  /**
   * Arborescence de l'inventaire dans lequel on travaille : l'inventaire type, ou le contenant primaire
   * (à défaut, le premier niveau). Le contenant affiché est mis en évidence ; un clic ouvre un contenant.
   * Affichée seulement sur grand écran (CSS).
   */
  function blocArborescence(c) {
    const ch = chemin(c.id);
    // Check-list : l'arborescence part du contenant primaire, jamais d'un inventaire type.
    const racine = (gestion ? racineModele(c.id) : null) || ch.find((x) => x.categorie === 'primaire') || ch[0];
    if (!racine) return null;
    const ouverts = new Set(ch.map((x) => x.id));
    const noeud = (x0, profondeur) => {
      // Check-list : un emplacement ne s'affiche pas, son occupant prend sa place (sinon « à identifier »).
      let x = x0;
      if (!gestion && masquerMobile(x)) return el('li', {}, el('span', { classe: 'inv-arbre-lien inv-arbre-vide' }, el('span', { classe: 'inv-arbre-nom', texte: 'À identifier (QR, NFC ou liste)' })));
      if (x.emplacement) {
        const occ = gestion ? enfants(x.id)[0] : occupantDuJour(x);
        if (!occ && gestion) return el('li', {}, el('a', { href: lien(x.id), classe: `inv-arbre-lien inv-arbre-vide${x.id === c.id ? ' actuel' : ''}` }, el('span', { classe: 'inv-arbre-nom', texte: 'Emplacement vide' })));
        if (!occ) return el('li', {}, el('span', { classe: 'inv-arbre-lien inv-arbre-vide' }, el('span', { classe: 'inv-arbre-nom', texte: 'À identifier (QR, NFC ou liste)' })));
        x = occ;
      }
      const fils = enfants(x.id);
      const b = dansUnModele(x.id) ? null : bilan(x.id);
      const actuel = x.id === c.id;
      const lienNoeud = el('a', { href: lien(x.id), classe: `inv-arbre-lien${actuel ? ' actuel' : ''}`, 'aria-current': actuel ? 'page' : null },
        b && b.total ? el('span', { classe: `inv-arbre-etat ${b.classe}`, title: b.texte, 'aria-label': b.texte }) : null,
        el('span', { classe: 'inv-arbre-nom', texte: x.nom }),
        aCocher(x).length ? el('small', { classe: 'inv-arbre-nb', texte: ` ${aCocher(x).length}` }) : null);
      if (!fils.length) return el('li', {}, lienNoeud);
      // Branches dépliées sur le chemin du contenant affiché et jusqu'au 2e niveau ; les autres repliées.
      const deplie = ouverts.has(x.id) || profondeur < 1;
      return el('li', {}, el('details', { open: deplie }, el('summary', {}, lienNoeud),
        el('ul', {}, ...fils.map((f) => noeud(f, profondeur + 1)))));
    };
    return el('aside', { classe: 'inv-arbre', 'aria-label': 'Arborescence' },
      el('h2', { texte: racine.modele && gestion ? 'Inventaire type' : 'Arborescence' }),
      el('ul', { classe: 'inv-arbre-racine' }, noeud(racine, 0)),
      el('p', { classe: 'aide-question inv-arbre-legende', texte: 'Le nombre indique les articles à cocher.' }));
  }

  // ---------- Tableau de bord : un grand cadre par contenant primaire ----------
  /**
   * « #inv-tableau » : chaque contenant primaire est un grand cadre ; chaque contenant qu'il renferme est un
   * cadre dans le cadre de son parent, à tous les niveaux (véhicule > tiroir > sac > sacoche > pochette…).
   *   - couleur du cadre : état du jour du contenant et de tout ce qu'il contient (comme les cartes) ;
   *   - cadenas : contenant scellable non ouvert aujourd'hui, validé par son scellé ;
   *   - en gras : le matériel biomédical (respirateur, échographe, PSE, HemoCue…), c'est-à-dire les articles
   *     dont la fiche est de catégorie « Matériel » ; un contenant qui attend un tel article dans sa propre
   *     liste (ex. « Scope Tempus n°2 » : le scope et ses pochettes) a aussi son nom en gras.
   * Un seul contenant primaire à la fois, sur toute la largeur de l'écran ; le choix est gardé sur l'appareil.
   */
  const CLE_TABLEAU = 'avismur_inv_tableau';
  // Vérification faite par le scellé : marquée sur l'appareil (`scelle`), reconnue à sa remarque sinon.
  const verifScellee = (v) => Boolean(v) && (v.scelle === true || /^Scellé :/.test(v.remarque || ''));
  /** Contenant scellable resté fermé aujourd'hui : toutes ses listes ont été validées par le scellé. */
  function sousScelle(c) {
    if (!c.scellable) return false;
    const listes = descendants(c.id).filter((d) => aCocher(d).length);
    return listes.length > 0 && listes.every((d) => verifScellee(verifDuJour(d.id)));
  }
  const articleBiomed = (a) => Boolean(fiche(a)) && ['Matériel', 'Biomed', 'Biomédical'].includes(fiche(a).categorie); // « Biomédical » : ancien nom de « Matériel »
  /** Contenant d'un appareil biomédical (ex. un scope et ses pochettes) : sa liste attend un article « Matériel ». */
  // Seul le contrôle « Matériel attendu » désigne un appareil biomédical (le contrôle « À renseigner » est une valeur libre).
  const appareilScanne = (a) => !a.separateur && estIdentifiant(a);
  const contenantBiomed = (c) => aCocher(c).some((a) => articleBiomed(a) || appareilScanne(a));
  /**
   * Petit badge au bord d'une gommette selon les péremptions du sous-inventaire (le plus grave seulement) :
   * triangle rouge = date dépassée, « ! » orange = date proche, « ? » gris = date à renseigner.
   */
  function badgePeremption(b) {
    const [classe, texte, titre] = b.perimes ? ['perime', '', `${pluriel(b.perimes, 'article')} périmé${b.perimes > 1 ? 's' : ''}`]
      : b.proches ? ['proche', '!', `${pluriel(b.proches, 'péremption')} proche${b.proches > 1 ? 's' : ''}`]
        : b.sansDate ? ['sans-date', '?', `${pluriel(b.sansDate, 'date')} à saisir`] : [];
    if (!classe) return null;
    const badge = el('span', { classe: `inv-point-per ${classe}`, title: titre, 'aria-label': titre, texte });
    if (classe === 'perime') {
      badge.append(el('svg:svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' },
        el('svg:path', { d: 'M12 2.5 23 21.5H1Z', fill: '#c62828', stroke: '#fff', 'stroke-width': '1.6', 'stroke-linejoin': 'round' }),
        el('svg:path', { d: 'M12 9v6', stroke: '#fff', 'stroke-width': '2.6', 'stroke-linecap': 'round' }),
        el('svg:circle', { cx: '12', cy: '18.4', r: '1.5', fill: '#fff' })));
    }
    return badge;
  }
  function logoCadenas() {
    return el('svg:svg', { viewBox: '0 0 24 24', classe: 'inv-tb-cadenas', role: 'img', 'aria-label': 'Scellé : non ouvert aujourd\'hui' },
      el('svg:title', { texte: 'Scellé : non ouvert, validé sur la base du dernier inventaire' }),
      el('svg:rect', { x: '5', y: '10.5', width: '14', height: '10', rx: '2', fill: 'currentColor' }),
      el('svg:path', { d: 'M8 10.5V7.5a4 4 0 0 1 8 0v3', fill: 'none', stroke: 'currentColor', 'stroke-width': '2.2', 'stroke-linecap': 'round' }));
  }
  /** Branchement secteur : contrôle Oui / Non dont le nom parle de secteur, de charge ou de branchement. */
  const estBranchement = (a) => a.controle === 'oui' && /branch|secteur|charge|chargeur|prise/i.test(cle(nomArticle(a)));
  /**
   * Ce que montre une tuile du tableau de bord, et le détail de son pop-up : état du jour du contenant et de tout
   * ce qu'il contient, manquants, péremptions, batteries et branchements relevés (aujourd'hui, sinon la dernière fois).
   */
  function resumeTableau(c) {
    const b = bilan(c.id);
    const detail = { manquants: [], peremptions: [], controles: [], appareils: [] };
    let batterie = null; // la plus faible relevée
    let branchement = null; // { ok }
    let controleKo = false;
    descendants(c.id).forEach((d) => {
      if (dansUnModele(d.id) || d.emplacement) return;
      const v = verifDuJour(d.id);
      const derniere = etat.verifs[d.id];
      const valeurs = (v && v.valeurs) || (derniere && derniere.valeurs) || {};
      const ici = d.id === c.id ? '' : d.nom;
      if (v) v.manquants.forEach((m) => detail.manquants.push({ nom: m.nom, ou: ici }));
      aCocher(d).forEach((a) => {
        if (suiviPeremption(a)) {
          const date = datePeremption(d.id, a.id);
          const pe = etatPeremption(date);
          if (pe.niveau === 'perime' || pe.niveau === 'proche') detail.peremptions.push({ nom: nomArticle(a), ou: ici, date, pe, jours: joursRestants(date) });
        }
        if (!estControle(a)) return;
        const val = valeurs[a.id];
        const e = evaluer(a, val);
        if (a.controle === 'materiel') {
          if (val) detail.appareils.push({ nom: texteValeur(a, val), ou: ici, ok: e.ok });
          else if (!estFacultatif(a)) detail.controles.push({ nom: nomArticle(a), ou: ici, texte: 'non identifié', ok: false, rempli: false });
          if (e.rempli && !e.ok && !estFacultatif(a)) controleKo = true;
          return;
        }
        detail.controles.push({ nom: nomArticle(a), ou: ici, texte: texteValeur(a, val), ok: e.ok, rempli: e.rempli, facultatif: estFacultatif(a),
          ...(a.controle === 'oui' ? { dernierOui: (etat.dernierOui || {})[`${d.id}/${a.id}`] || '' } : {}) });
        if (e.rempli && !e.ok && !estFacultatif(a)) controleKo = true;
        if (a.controle === 'batterie' && e.rempli) {
          const niveau = Number(String(val).replace(',', '.')) / (a.echelle === '4' ? 4 : 100);
          if (!batterie || niveau < batterie.niveau) batterie = { niveau, ok: e.ok, texte: texteValeur(a, val) };
        }
        if (estBranchement(a) && e.rempli) branchement = { ok: e.ok && (!branchement || branchement.ok) };
      });
    });
    detail.peremptions.sort((x, y) => x.jours - y.jours);
    const anomalie = detail.manquants.length > 0 || b.perimes > 0 || b.oxygeneBas > 0 || b.ambManquants > 0 || controleKo;
    const classe = b.total === 0 && !detail.controles.length ? 'vide' : (anomalie ? 'anomalie' : b.classe);
    const pictos = [];
    if (sousScelle(c)) pictos.push(logoCadenas());
    if (b.total) {
      if (b.complet && !anomalie) pictos.push(picto('ok', 'Vérifié aujourd\'hui', 'vert'));
      else if (!b.faits) pictos.push(picto('afaire', 'À vérifier', 'orange'));
      else if (!b.complet) pictos.push(el('span', { classe: 'inv-tb-compte', title: b.texte, texte: `${b.faits}/${b.total}` }));
    }
    if (detail.manquants.length || controleKo) pictos.push(picto('anomalie', `Anomalie : ${pluriel(detail.manquants.length, 'manquant')}${controleKo ? ', contrôle hors limite' : ''}`, 'rouge'));
    if (b.perimes) pictos.push(picto('perime', pluriel(b.perimes, 'périmé'), 'rouge'));
    else if (b.proches) pictos.push(picto('proche', `${b.proches} bientôt périmé${b.proches > 1 ? 's' : ''}`, 'orange'));
    if (b.sansDate) pictos.push(picto('date', `${pluriel(b.sansDate, 'date')} à saisir`, 'gris'));
    if (batterie) pictos.push(pictoBatterie(batterie.niveau, `Batterie : ${batterie.texte}`, batterie.ok ? 'vert' : 'rouge'));
    if (branchement) pictos.push(picto(branchement.ok ? 'branchement' : 'debranche', branchement.ok ? 'Branché sur secteur' : 'Non branché', branchement.ok ? 'vert' : 'rouge'));
    if (b.vides) pictos.push(picto('identifier', `${pluriel(b.vides, 'emplacement')} à identifier`, 'orange'));
    return { b, classe, pictos, detail, biomed: contenantBiomed(c) || estVrac(c) };
  }
  /** Pop-up d'une tuile : le détail, et l'accès à l'inventaire. */
  /** Qui a validé l'inventaire et à quelle heure : en tout petit, grisé, seulement dans les détails. */
  const mentionValidation = (v) => (v ? el('p', { classe: 'inv-mention-validation',
    texte: `Validé${v.scelle ? ' (scellé)' : ''} à ${heure(v.date)}${v.agent ? ` par ${v.agent}` : ''}` }) : null);
  function detailTableau(c, place = '') {
    const r = resumeTableau(c);
    const v = aCocher(c).length || estVrac(c) ? verifDuJour(c.id) : null;
    const fond = el('div', { classe: 'fenetre-fond', surclick: (e) => { if (e.target === fond) fermer(); } });
    const retour = document.activeElement;
    const fermer = () => { fond.remove(); document.body.classList.remove('fenetre-ouverte'); if (retour && retour.isConnected) retour.focus(); };
    const titre = idChamp();
    const ou = (x) => (x.ou ? el('small', { texte: ` — ${x.ou}` }) : null);
    const rubrique = (nom, lignes) => (lignes.length ? el('section', { classe: 'inv-tb-rubrique' }, el('h3', { texte: nom }), el('ul', {}, ...lignes)) : null);
    const sous = enfants(c.id).length;
    fond.append(el('div', { classe: 'fenetre inv-tb-fenetre', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titre },
      el('div', { classe: 'fenetre-entete' }, el('h2', { id: titre, texte: c.nom }),
        el('button', { type: 'button', classe: 'fenetre-fermer', 'aria-label': 'Fermer', texte: '✕', surclick: fermer })),
      el('p', { classe: 'fenetre-resume', texte: etagesAuDessus(c).reverse().map((x) => x.nom).join(' › ') }),
      el('p', { classe: `inv-tb-statut ${r.classe}` }, el('span', { classe: 'inv-tb-pictos' }, ...r.pictos),
        el('strong', { texte: sousScelle(c) ? 'Scellé : non ouvert aujourd\'hui' : r.b.texte }),
        sous ? ` · ${pluriel(sous, 'sous-inventaire')}` : ''),
      mentionValidation(v),
      rubrique('Manquants', r.detail.manquants.map((x) => el('li', { classe: 'rouge' }, x.nom, ou(x)))),
      rubrique('Péremptions', r.detail.peremptions.map((x) => el('li', { classe: x.pe.niveau === 'perime' ? 'rouge' : 'orange' }, `${x.nom} : ${afficherDate(x.date)} (${x.pe.texte})`, ou(x)))),
      rubrique('Appareils', r.detail.appareils.map((x) => el('li', { classe: x.ok ? '' : 'rouge' }, el('strong', { texte: x.nom }), ou(x)))),
      rubrique('Contrôles', r.detail.controles.map((x) => el('li', { classe: x.rempli && !x.ok && !x.facultatif ? 'rouge' : '' }, `${x.nom}${x.facultatif ? ' (facultatif)' : ''} : ${x.texte}`, ou(x),
        x.dernierOui !== undefined ? el('small', { classe: 'inv-dernier-oui', texte: x.dernierOui ? ` — dernier Oui : ${new Date(x.dernierOui).toLocaleDateString('fr-FR')} à ${heure(x.dernierOui)}` : ' — jamais coché Oui' }) : null))),
      estVrac(c) && etat.verifs[c.id] ? el('section', { classe: 'inv-tb-rubrique' },
        el('h3', { texte: `Matériel présent (relevé ${verifDuJour(c.id) ? 'du jour' : `du ${new Date(etat.verifs[c.id].date).toLocaleDateString('fr-FR')}`})` }),
        comptesVrac(itemsDeVerif(etat.verifs[c.id]))) : null,
      el('button', { type: 'button', classe: 'principal', texte: 'Ouvrir l\'inventaire', surclick: () => { fermer(); aller(c.id); } })));
    fond.addEventListener('keydown', (e) => { if (e.key === 'Escape') fermer(); });
    document.body.append(fond);
    document.body.classList.add('fenetre-ouverte');
    fond.querySelector('.fenetre-fermer').focus();
  }
  /**
   * Tuile d'un contenant : fond coloré selon son état, son nom et des pictogrammes ; ce qu'il contient en tuiles
   * côte à côte (carrés), autant par ligne que la largeur le permet. Un appui ouvre le détail.
   * `place` : nom de l'emplacement qu'il occupe.
   */
  const CLE_TB_NIVEAUX = 'avismur_inv_tb_niveaux';
  /** Nombre de niveaux affichés sous le contenant primaire (0 = tous), réglé par l'utilisateur sur cet appareil. */
  function niveauxTableau() {
    let n = 2;
    try { const v = localStorage.getItem(CLE_TB_NIVEAUX); if (v !== null && !Number.isNaN(Number(v))) n = Number(v); } catch (e) { /* stockage indisponible */ }
    return Math.max(0, Math.min(9, n));
  }
  /** Profondeur de l'arborescence sous ce contenant (pour borner le réglage). */
  function profondeur(id, vus = new Set()) {
    if (vus.has(id)) return 0;
    vus.add(id);
    const f = enfants(id);
    return f.length ? 1 + Math.max(...f.map((x) => profondeur(x.emplacement ? ((gestion ? enfants(x.id)[0] : occupantDuJour(x)) || {}).id || '' : x.id, vus))) : 0;
  }
  /** Largeur automatique (en colonnes) d'une carte de niveau 1 : d'après le nombre de tuiles qu'elle contient. */
  function largeurAuto(nbFils) { return nbFils <= 2 ? 1 : (nbFils <= 6 ? 2 : 3); }
  const LIBELLES_LARGEUR = { 0: 'Auto', 1: '1', 2: '2', 3: '3', 4: 'Ligne' };
  /** Mode « Disposer » : poignée de déplacement et choix de largeur d'une carte de niveau 1 (`rang` = contenant rangé sous le primaire). */
  function outilsDisposition(rang) {
    const choisie = rang.largeurTb || 0;
    return el('div', { classe: 'inv-tb-dispo' },
      poignee(rang.nom),
      el('div', { classe: 'inv-tb-largeurs', role: 'group', 'aria-label': `Largeur de ${rang.nom}` },
        ...[0, 1, 2, 3, 4].map((n) => el('button', { type: 'button', classe: 'cfg-mini', 'aria-pressed': String(choisie === n),
          title: n === 0 ? 'Largeur automatique (selon le contenu)' : (n === 4 ? 'Toute la ligne' : `${pluriel(n, 'colonne')}`), texte: LIBELLES_LARGEUR[n],
          surclick: () => {
            if (choisie === n) return;
            if (n) rang.largeurTb = n; else delete rang.largeurTb;
            marquer(rang.id);
            rendre({ garderPosition: true });
          } }))));
  }
  function tuileTableau(c, niveau = 0, vus = new Set(), place = '', max = 0, rang = null) {
    if (vus.has(c.id)) return null;
    vus.add(c.id);
    // Sous-inventaire de niveau 1 : c'est lui (l'emplacement, pas son occupant) qui porte la place et la largeur.
    if (niveau === 1 && !rang) rang = c;
    if (c.emplacement) {
      const occupant = gestion ? enfants(c.id)[0] : occupantDuJour(c);
      if (occupant) return tuileTableau(occupant, niveau, vus, c.nom, max, rang);
      const disposer = dispositionTb && niveau === 1;
      return el('div', { classe: 'inv-tb-tuile avide', ...(niveau === 1 ? { 'data-cle': rang.id, 'data-largeur': String(rang.largeurTb || 1) } : {}) },
        disposer ? outilsDisposition(rang) : null,
        el('button', { type: 'button', classe: 'inv-tb-tete', 'aria-haspopup': 'dialog', surclick: () => aller(c.id) },
          el('span', { classe: 'inv-tb-nom', texte: c.nom }),
          el('span', { classe: 'inv-tb-pictos' }, picto('identifier', 'À identifier', 'orange'))));
    }
    const disposer = dispositionTb && niveau === 1;
    const r = resumeTableau(c);
    // Au-delà du nombre de niveaux choisi, le contenant reste un carré (son contenu n'est pas déplié).
    const replie = niveau > 0 && max > 0 && niveau >= max;
    const nbFils = enfants(c.id).length;
    const fils = replie ? [] : enfants(c.id).map((f) => tuileTableau(f, niveau + 1, vus, '', max)).filter(Boolean);
    const attrsRang = niveau === 1 ? { 'data-cle': rang.id, 'data-largeur': String(rang.largeurTb || largeurAuto(fils.length)) } : {};
    return el('div', { classe: `inv-tb-tuile ${r.classe}${fils.length ? ' parent' : ''}${niveau === 0 ? ' inv-tb-primaire' : ''}${niveau === 0 && dispositionTb ? ' inv-tb-disposition' : ''}`, ...attrsRang },
      disposer ? outilsDisposition(rang) : null,
      el('button', { type: 'button', classe: 'inv-tb-tete', 'aria-haspopup': 'dialog', title: place && cle(place) !== cle(c.nom) ? `Emplacement : ${place}` : null, surclick: () => { if (!dispositionTb) detailTableau(c, place); } },
        fils.length || niveau === 0 ? null : miniature(c),
        replie && nbFils ? el('span', { classe: 'inv-tb-replie', title: `${pluriel(nbFils, 'sous-inventaire')} non affichés`, texte: `+${nbFils}` }) : null,
        el('span', { classe: `inv-tb-nom${r.biomed ? ' inv-tb-biomed' : ''}`, texte: c.nom }),
        // Matériel biomédical relevé dans ce contenant : en gras, avec son n° interne SMUR (« Scope Corpuls3 n° 2 »).
        ...r.detail.appareils.filter((x) => !x.ou).map((x) => el('span', { classe: `inv-tb-appareil${x.ok ? '' : ' ko'}`, texte: x.nom })),
        el('span', { classe: 'inv-tb-pictos' }, ...r.pictos)),
      fils.length ? (() => {
        const grille = el('div', { classe: 'inv-tb-grille' }, ...fils);
        // Mode « Disposer » : les cartes de niveau 1 se déplacent par leur poignée (ordre commun à tous les appareils).
        if (niveau === 0 && dispositionTb) {
          triable(grille, (cles) => {
            cles.forEach((id, n) => { const x = contenant(id); if (x && x.ordre !== n) { x.ordre = n; marquer(x.id); } });
            rendre({ garderPosition: true });
          });
        }
        return grille;
      })() : null);
  }
  function vueTableau() {
    const primaires = Object.values(structure.contenants).filter((c) => !c.supprime && c.categorie === 'primaire' && !dansUnModele(c.id))
      .sort((x, y) => x.ordre - y.ordre || x.nom.localeCompare(y.nom, 'fr'));
    const legende = (p, texte) => el('li', {}, p, texte);
    return [
      barreHaut({ titre: 'Inventaires', h1: false, bande: false, retour: () => aller('') }),
      el('div', { classe: 'inv-entete' }, el('h1', { tabindex: '-1', texte: 'Tableau de bord des contenants' })),
      ligneSynchro(), ligneAvis(),
      el('details', { classe: 'inv-tb-legende' }, el('summary', { texte: 'Légende' }),
        el('ul', {},
          legende(picto('ok', '', 'vert'), 'vérifié aujourd\'hui'), legende(picto('afaire', '', 'orange'), 'à vérifier'),
          legende(el('span', { classe: 'inv-tb-compte', texte: '2/5' }), 'en cours'), legende(picto('anomalie', '', 'rouge'), 'anomalie (manquant, contrôle)'),
          legende(picto('perime', '', 'rouge'), 'périmé'), legende(picto('proche', '', 'orange'), 'bientôt périmé'), legende(picto('date', '', 'gris'), 'date à saisir'),
          legende(pictoBatterie(0.6, '', 'vert'), 'batterie'), legende(picto('branchement', '', 'vert'), 'branché'), legende(picto('debranche', '', 'rouge'), 'non branché'),
          legende(logoCadenas(), 'scellé, non ouvert'), legende(picto('identifier', '', 'orange'), 'emplacement à identifier'),
          legende(el('strong', { texte: 'Gras' }), 'matériel biomédical'))),
      ...(() => {
        if (!primaires.length) return [el('p', { classe: 'consigne', texte: 'Aucun contenant primaire pour l\'instant.' })];
        let choisi = '';
        try { choisi = localStorage.getItem(CLE_TABLEAU) || ''; } catch (e) { /* stockage indisponible */ }
        const actuel = primaires.find((c) => c.id === choisi) || primaires[0];
        const onglets = el('div', { classe: 'inv-tb-onglets', role: 'tablist', 'aria-label': 'Contenant primaire' }, ...primaires.map((c) => {
          const r = resumeTableau(c);
          return el('button', { type: 'button', role: 'tab', classe: `inv-tb-onglet ${r.classe}`, 'aria-selected': String(c.id === actuel.id), title: r.b.texte,
            surclick: () => { try { localStorage.setItem(CLE_TABLEAU, c.id); } catch (e) { /* stockage indisponible */ } rendre({ garderPosition: true }); } },
            el('span', { classe: `inv-tb-pastille ${r.classe}`, 'aria-hidden': 'true' }), c.nom);
        }));
        const max = niveauxTableau();
        const prof = Math.max(1, profondeur(actuel.id));
        const regler = (n) => { try { localStorage.setItem(CLE_TB_NIVEAUX, String(n)); } catch (e) { /* stockage indisponible */ } rendre({ garderPosition: true }); };
        const affiche = max === 0 || max >= prof ? prof : max;
        const niveaux = el('div', { classe: 'inv-tb-niveaux', role: 'group', 'aria-label': 'Niveaux affichés' },
          el('span', { texte: 'Niveaux' }),
          el('button', { type: 'button', classe: 'cfg-mini', 'aria-label': 'Afficher un niveau de moins', disabled: affiche <= 1, texte: '−', surclick: () => regler(affiche - 1) }),
          el('strong', { 'aria-live': 'polite', texte: affiche >= prof ? `${prof} (tout)` : String(affiche) }),
          el('button', { type: 'button', classe: 'cfg-mini', 'aria-label': 'Afficher un niveau de plus', disabled: affiche >= prof, texte: '+', surclick: () => regler(affiche + 1 >= prof ? 0 : affiche + 1) }));
        // Administrateurs : disposer les sous-inventaires de niveau 1 (place, largeur) ; visible sur grand écran.
        const disposer = estAdmin() ? el('button', { type: 'button', classe: `cfg-mini inv-tb-bouton-disposer${dispositionTb ? ' actif' : ''}`, 'aria-pressed': String(dispositionTb),
          texte: dispositionTb ? 'Terminer' : 'Disposer', title: 'Place et largeur des sous-inventaires de niveau 1 (grand écran)',
          surclick: () => { dispositionTb = !dispositionTb; rendre({ garderPosition: true }); } }) : null;
        const aideDispo = dispositionTb ? el('p', { classe: 'consigne inv-tb-aide-dispo', texte: 'Glissez une carte par sa poignée ⠿ pour la déplacer ; choisissez sa largeur en colonnes (Auto : selon son contenu). L\'ordre est aussi celui des sous-inventaires dans la check-list.' }) : null;
        return [onglets, el('div', { classe: 'inv-tb-outils' }, niveaux, disposer), aideDispo, el('div', { classe: 'inv-tb', role: 'tabpanel' }, tuileTableau(actuel, 0, new Set(), '', max))];
      })(),
    ];
  }

  // ---------- Glisser-déposer ----------
  /**
   * Poignée « ⠿ » d'une ligne déplaçable. À la souris ou au doigt : on attrape la poignée et on glisse.
   * Au clavier : flèches haut et bas sur la poignée.
   */
  function poignee(nom) {
    return el('button', { type: 'button', classe: 'inv-poignee', 'aria-label': `Déplacer ${nom} (glisser, ou flèches haut et bas)`, title: 'Glisser pour déplacer', texte: '⠿' });
  }

  /**
   * Rend les lignes de `liste` (enfants directs portant data-cle) réordonnables par leur poignée.
   * `surFin(cles)` reçoit le nouvel ordre des clés, seulement s'il a changé.
   */
  function triable(liste, surFin) {
    const ordre = () => [...liste.children].filter((x) => x.dataset.cle).map((x) => x.dataset.cle);
    let depart = '';
    const terminer = () => {
      const apres = ordre().join(',');
      if (apres !== depart) surFin(ordre());
    };
    liste.addEventListener('keydown', (e) => {
      const p = e.target.closest('.inv-poignee');
      if (!p || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      e.preventDefault();
      const ligne = p.closest('[data-cle]');
      const voisin = e.key === 'ArrowUp' ? ligne.previousElementSibling : ligne.nextElementSibling;
      if (!voisin || !voisin.dataset.cle) return;
      depart = ordre().join(',');
      if (e.key === 'ArrowUp') liste.insertBefore(ligne, voisin); else liste.insertBefore(voisin, ligne);
      const cle = ligne.dataset.cle;
      terminer();
      // La liste est redessinée : on remet le focus sur la poignée de la ligne déplacée.
      const nouvelle = zone.querySelector(`[data-cle="${cle}"] .inv-poignee`);
      if (nouvelle) nouvelle.focus();
    });
    liste.addEventListener('pointerdown', (e) => {
      const p = e.target.closest('.inv-poignee');
      if (!p || (e.pointerType === 'mouse' && e.button !== 0)) return;
      e.preventDefault();
      const ligne = p.closest('[data-cle]');
      depart = ordre().join(',');
      // Pas de capture du pointeur : déplacer la ligne dans la page la ferait perdre au navigateur.
      // On suit donc le pointeur sur toute la fenêtre.
      const pointeur = e.pointerId;
      ligne.classList.add('inv-deplacee');
      liste.classList.add('inv-tri-en-cours');
      let defilement = 0;
      let dernierY = e.clientY;
      let parti = false;
      let dernierX = e.clientX;
      const placer = (y, x = dernierX) => {
        // La ligne se place avant la première ligne (dans l'ordre de lecture) que le pointeur précède :
        // au-dessus d'elle, ou sur sa rangée et à gauche de son milieu (listes sur deux colonnes).
        const autres = [...liste.children].filter((n) => n !== ligne && n.dataset.cle);
        const suivante = autres.find((n) => {
          const r = n.getBoundingClientRect();
          const surDeuxColonnes = autres.some((o) => o !== n && Math.abs(o.getBoundingClientRect().top - r.top) < 4);
          if (!surDeuxColonnes) return y < r.top + r.height / 2;
          return y < r.top || (y <= r.bottom && x < r.left + r.width / 2);
        });
        if (suivante) { if (ligne.nextElementSibling !== suivante) liste.insertBefore(ligne, suivante); } else if (autres.length && liste.lastElementChild !== ligne) {
          autres[autres.length - 1].after(ligne);
        }
      };
      // Près du haut ou du bas de l'écran, la page défile toute seule.
      const boucle = setInterval(() => {
        const marge = 70;
        if (!parti) return;
        defilement = dernierY < marge ? -12 : (dernierY > window.innerHeight - marge ? 12 : 0);
        if (defilement) { window.scrollBy(0, defilement); placer(dernierY); }
      }, 16);
      const bouger = (ev) => { if (ev.pointerId !== pointeur) return; ev.preventDefault(); if (Math.abs(ev.clientY - e.clientY) > 6 || Math.abs(ev.clientX - e.clientX) > 6) parti = true; dernierY = ev.clientY; dernierX = ev.clientX; placer(ev.clientY, ev.clientX); };
      const lacher = (ev) => {
        if (ev && ev.pointerId !== pointeur) return;
        clearInterval(boucle);
        window.removeEventListener('pointermove', bouger);
        window.removeEventListener('pointerup', lacher);
        window.removeEventListener('pointercancel', lacher);
        ligne.classList.remove('inv-deplacee');
        liste.classList.remove('inv-tri-en-cours');
        terminer();
      };
      window.addEventListener('pointermove', bouger, { passive: false });
      window.addEventListener('pointerup', lacher);
      window.addEventListener('pointercancel', lacher);
    });
  }

  /**
   * Formulaire d'une fiche de la base des articles.
   * `surEnregistrer(fiche)` reçoit la fiche validée ; `utiliser(fiche)`, s'il est fourni, propose
   * d'utiliser la fiche existante quand la dénomination ou la réf. interne est déjà dans la base.
   */
  function formulaireFiche(depart, { titre, surEnregistrer, surAnnuler, utiliser, actions = [] }) {
    const f = { ...depart };
    const perissableTouche = { valeur: Boolean(depart.id && structure.catalogue[depart.id]) };
    const ids = { nom: idChamp(), interne: idChamp(), fourn: idChamp(), cat: idChamp() };
    const erreur = el('p', { classe: 'message erreur', role: 'alert', hidden: true });
    const caseFiche = (champ, texte, aide) => {
      const i = idChamp();
      return el('label', { classe: 'cfg-case inv-case-fiche', for: i },
        el('input', { type: 'checkbox', id: i, checked: f[champ] === true, 'data-champ': champ, surchange: (e) => {
          f[champ] = e.target.checked;
          if (champ === 'perissable') perissableTouche.valeur = true;
        } }), el('span', {}, texte, aide ? el('small', { texte: aide }) : null));
    };
    const casePerissable = caseFiche('perissable', 'Périssable', 'date de péremption suivie dans les inventaires');
    // Propre aux documents : n'apparaît que pour cette catégorie.
    const caseSecretariat = caseFiche('secretariat', 'Secrétariat', 'document géré par le secrétariat');
    caseSecretariat.hidden = f.categorie !== 'Documents';
    // Photo de l'article : gardée sur l'appareil, envoyée avec la fiche.
    const apercu = el('img', { classe: 'inv-fiche-photo', alt: 'Photo de l\'article', hidden: !f.photo });
    const montrerPhoto = () => {
      apercu.hidden = !f.photo;
      retirerPhoto.hidden = !f.photo;
      if (f.photo) obtenirPhoto(f.photo).then((d) => { if (d) apercu.src = d; });
    };
    const recevoirPhoto = async (e) => {
      const fichier = e.target.files[0];
      if (!fichier) return;
      try {
        e.target.value = '';
        const res = await recadrerImage(fichier, 900);
        if (!res) return;
        const id = `local-${nouvelId()}`;
        await Photos.ecrire(id, res.donnees);
        f.photo = id;
        montrerPhoto();
      } catch (err) { erreur.textContent = 'Photo illisible ou trop lourde : réessayez.'; erreur.hidden = false; }
    };
    const idPrendre = idChamp();
    const idChoisir = idChamp();
    const retirerPhoto = el('button', { type: 'button', classe: 'lien danger', texte: 'Retirer la photo', hidden: !f.photo, surclick: () => { f.photo = ''; montrerPhoto(); } });
    const blocPhotoFiche = el('div', { classe: 'champ' }, el('span', { classe: 'inv-libelle', texte: 'Photo' }),
      el('div', { classe: 'champ-photo' },
        el('label', { for: idPrendre, classe: 'bouton-photo', texte: '📷 Prendre' }),
        el('input', { type: 'file', id: idPrendre, accept: 'image/*', capture: 'environment', classe: 'invisible', surchange: recevoirPhoto }),
        el('label', { for: idChoisir, classe: 'bouton-photo', texte: 'Choisir une image' }),
        el('input', { type: 'file', id: idChoisir, accept: 'image/*', classe: 'invisible', surchange: recevoirPhoto }),
        retirerPhoto),
      apercu);
    setTimeout(montrerPhoto);
    const categories = el('div', { classe: 'puces', role: 'radiogroup', 'aria-labelledby': ids.cat });
    CATEGORIES.forEach((cat) => {
      const i = idChamp();
      categories.append(el('input', { type: 'radio', name: ids.cat, id: i, value: cat, checked: f.categorie === cat, surchange: () => {
        f.categorie = cat;
        caseSecretariat.hidden = cat !== 'Documents';
        if (cat !== 'Documents') { f.secretariat = false; caseSecretariat.querySelector('input').checked = false; }
        // Un médicament est périssable par défaut, tant qu'on n'a pas choisi soi-même.
        if (!perissableTouche.valeur) { f.perissable = cat === 'Médicament'; casePerissable.querySelector('input').checked = f.perissable; }
      } }), el('label', { for: i, texte: cat }));
    });
    const valider = () => {
      f.denomination = f.denomination.trim().replace(/\s+/g, ' ');
      f.refInterne = f.refInterne.trim();
      f.refFournisseur = f.refFournisseur.trim();
      const probleme = !f.denomination ? 'Indiquez la dénomination.' : (!f.categorie ? 'Choisissez la catégorie (Médicament, DM, Magasin, Kit, Matériel, Biomed, Documents ou Autre).' : '');
      erreur.innerHTML = '';
      if (probleme) { erreur.textContent = probleme; erreur.hidden = false; return; }
      const autre = doublon(f);
      if (autre) {
        erreur.append(cle(autre.denomination) === cle(f.denomination)
          ? `« ${autre.denomination} » existe déjà dans la base. `
          : `La réf. interne ${f.refInterne} est déjà celle de « ${autre.denomination} ». `);
        if (utiliser) erreur.append(el('button', { type: 'button', classe: 'lien', texte: 'Utiliser cet article', surclick: () => utiliser(autre) }));
        erreur.hidden = false;
        return;
      }
      surEnregistrer(normaliserFiche(f));
    };
    const texte = (champ, id, libelle, attributs = {}) => el('div', { classe: 'champ' }, el('label', { for: id, texte: libelle }),
      el('input', { id, valeur: f[champ], autocomplete: 'off', surinput: (e) => { f[champ] = e.target.value; }, ...attributs }));
    return el('form', { classe: 'inv-fiche', novalidate: true, sursubmit: (e) => { e.preventDefault(); valider(); } },
      titre ? el('h3', { texte: titre }) : null,
      texte('denomination', ids.nom, 'Dénomination', { maxlength: '120', required: true }),
      el('div', { classe: 'champ' }, el('span', { classe: 'inv-libelle', id: ids.cat, texte: 'Catégorie' }), categories),
      el('div', { classe: 'inv-refs' },
        texte('refInterne', ids.interne, 'Réf. interne', { maxlength: '60', inputmode: 'text' }),
        texte('refFournisseur', ids.fourn, 'Réf. fournisseur', { maxlength: '120' })),
      el('div', { classe: 'inv-cases-fiche' },
        caseFiche('consommable', 'Consommable', 'usage unique, à remplacer après utilisation'),
        casePerissable,
        caseFiche('horsStock', 'Dotation hors stock', 'ne fait pas partie du stock de la pharmacie'),
        caseSecretariat),
      blocPhotoFiche,
      erreur,
      el('div', { classe: 'cfg-actions' },
        el('button', { type: 'submit', classe: 'cfg-bouton inv-actif', texte: 'Enregistrer la fiche' }),
        surAnnuler ? el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Annuler', surclick: surAnnuler }) : null,
        ...actions));
  }

  /** Édition des articles d'un contenant (administrateurs). */
  /** Édition d'un contrôle : libellé et réglages selon le type. */
  /** Case « Facultatif » de l'édition : décochée = article obligatoire pour un inventaire conforme. */
  function caseFacultatif(c, a) {
    return el('label', { classe: 'inv-qte-libelle inv-case-facultatif', title: 'Facultatif : s\'il est absent, l\'inventaire reste conforme (ex. détecteur de CO sur certains sacs)' },
      el('input', { type: 'checkbox', checked: estFacultatif(a), 'aria-label': `Facultatif (${nomArticle(a)}) : son absence ne rend pas l'inventaire non conforme`, surchange: (e) => {
        if (e.target.checked) a.facultatif = true; else delete a.facultatif;
        marquer(c.id);
      } }), ' Facultatif');
  }
  /** Champ « Commentaire » de l'édition : texte libre affiché à tous sous l'article en check-list. */
  const commentairesOuverts = new Set(); // gestion : articles sans commentaire dont on a ouvert le champ
  function champCommentaire(c, a) {
    // Sans commentaire : un simple lien, pour ne pas alourdir la liste d'un champ vide par article.
    if (!a.commentaire && !commentairesOuverts.has(a.id)) {
      return el('button', { type: 'button', classe: 'lien inv-ajout-commentaire', texte: '💬 Ajouter un commentaire',
        surclick: () => { commentairesOuverts.add(a.id); rendre({ garderPosition: true, focus: `[data-cle="${a.id}"] .inv-commentaire-saisie` }); } });
    }
    return el('input', {
      classe: 'inv-commentaire-saisie', maxlength: '300', placeholder: '💬 Commentaire (visible de tous)', valeur: a.commentaire || '',
      'aria-label': `Commentaire visible de tous (${nomArticle(a)})`,
      surchange: (e) => { const t = e.target.value.trim(); if (t) a.commentaire = t; else delete a.commentaire; e.target.value = t; marquer(c.id); },
    });
  }
  function ligneEditionControle(c, a, outils) {
    const nombre = (cle, libelle) => el('label', { classe: 'inv-qte-libelle' }, `${libelle} `, el('input', {
      type: 'text', inputmode: 'decimal', classe: 'inv-qte', valeur: a[cle] === undefined ? '' : String(a[cle]), placeholder: '–', 'aria-label': `${libelle} (${a.nom})`,
      surchange: (e) => { const t = e.target.value.trim().replace(',', '.'); const n = Number(t); if (t === '' || !Number.isFinite(n)) { delete a[cle]; e.target.value = ''; } else a[cle] = n; marquer(c.id); },
    }));
    const reglages = [];
    if (a.controle === 'temperature' || a.controle === 'valeur') reglages.push(nombre('min', 'Min'), nombre('max', 'Max'));
    if (a.controle === 'valeur') reglages.push(el('label', { classe: 'inv-qte-libelle' }, 'Unité ', el('input', { classe: 'inv-qte', maxlength: '10', valeur: a.unite || '', 'aria-label': `Unité (${a.nom})`, surchange: (e) => { const t = e.target.value.trim(); if (t) a.unite = t; else delete a.unite; marquer(c.id); } })));
    if (a.controle === 'batterie') {
      reglages.push(el('label', { classe: 'inv-qte-libelle' }, 'Échelle ', el('select', { 'aria-label': `Échelle (${a.nom})`, surchange: (e) => { if (e.target.value === '4') a.echelle = '4'; else delete a.echelle; delete a.seuil; marquer(c.id); rendre({ garderPosition: true }); } },
        el('option', { value: 'pct', selected: a.echelle !== '4', texte: '%' }), el('option', { value: '4', selected: a.echelle === '4', texte: '0 à 4' }))),
      nombre('seuil', 'Seuil'));
    }
    if (a.controle === 'materiel') {
      // Filtre du matériel attendu : un type du suivi du matériel (PSE, Respirateur, Scope…), ou tout appareil.
      const types = (typeof Materiel !== 'undefined' && Materiel.types ? Materiel.types() : []);
      if (a.typeMateriel && !types.some((t) => cle(t) === cle(a.typeMateriel))) types.push(a.typeMateriel);
      reglages.push(el('label', { classe: 'inv-qte-libelle' }, 'Type attendu ', el('select', {
        'aria-label': `Type d'appareil attendu (${a.nom})`,
        surchange: (e) => {
          const t = e.target.value;
          const ancien = a.typeMateriel || '';
          if (t) a.typeMateriel = t; else delete a.typeMateriel;
          // Libellé resté par défaut (ou égal à l'ancien type) : il prend le nom du type choisi.
          if (t && (a.nom === CONTROLES.materiel.defaut || a.nom === ancien)) a.nom = t;
          marquer(c.id); rendre({ garderPosition: true });
        },
      }, el('option', { value: '', selected: !a.typeMateriel, texte: 'Tout appareil' }),
      ...types.map((t) => el('option', { value: t, selected: cle(t) === cle(a.typeMateriel), texte: t })))),
      el('label', { classe: 'inv-qte-libelle' }, 'N° précis ', el('input', { classe: 'inv-qte', maxlength: '60', placeholder: 'tout', valeur: a.attendu || '', 'aria-label': `N° interne attendu, facultatif (${a.nom})`, surchange: (e) => { const t = e.target.value.trim(); if (t) a.attendu = t; else delete a.attendu; marquer(c.id); } })));
    }
    if (a.controle === 'scan') {
      const mode = modeScan(a);
      const duree = (cle, libelle) => el('label', { classe: 'inv-qte-libelle' }, `${libelle} `, el('input', {
        classe: 'inv-qte', maxlength: '12', placeholder: '–', valeur: a[cle] === undefined ? '' : texteDuree(a[cle]), 'aria-label': `${libelle} (${a.nom}), en durée`,
        surchange: (e) => { const n = minutesDe(e.target.value); if (n === null) { delete a[cle]; e.target.value = ''; } else { a[cle] = n; e.target.value = texteDuree(n); } marquer(c.id); },
      }));
      reglages.push(el('label', { classe: 'inv-qte-libelle' }, 'Saisie ', el('select', { 'aria-label': `Type de saisie (${a.nom})`, surchange: (e) => {
        const nv = e.target.value;
        // Chaque saisie a ses propres réglages : on repart de zéro pour ne rien garder d'une autre.
        ['attendu', 'choix', 'min', 'max', 'unite', ...(nv === 'liste' || nv === 'duree' ? ['qr', 'nfc'] : [])].forEach((k) => delete a[k]);
        if (nv === 'libre') delete a.mode; else a.mode = nv;
        marquer(c.id); rendre({ garderPosition: true });
      } }, ...Object.entries(MODES_SCAN).map(([k, t]) => el('option', { value: k, selected: k === mode, texte: t })))));
      if (mode === 'libre' || mode === 'plage') {
        const coche = (cle, libelle) => el('label', { classe: 'inv-qte-libelle' }, el('input', { type: 'checkbox', checked: a[cle] === true, 'aria-label': `${libelle} autorisé (${a.nom})`,
          surchange: (e) => { if (e.target.checked) a[cle] = true; else delete a[cle]; marquer(c.id); } }), ` ${libelle}`);
        reglages.push(coche('qr', 'Scan QR'), coche('nfc', 'NFC'));
      }
      if (mode === 'libre') reglages.push(el('label', { classe: 'inv-qte-libelle' }, 'Attendu ', el('input', { classe: 'inv-attendu', maxlength: '60', placeholder: 'facultatif', valeur: a.attendu || '', 'aria-label': `Valeur attendue (${a.nom})`, surchange: (e) => { const t = e.target.value.trim(); if (t) a.attendu = t; else delete a.attendu; marquer(c.id); } })));
      if (mode === 'liste') reglages.push(el('label', { classe: 'inv-qte-libelle' }, 'Choix ', el('input', { classe: 'inv-attendu', maxlength: '300', placeholder: 'séparés par ;', valeur: choixScan(a).join(' ; '), 'aria-label': `Choix proposés, séparés par des points-virgules (${a.nom})`, surchange: (e) => {
        const l = e.target.value.split(/[;\n]/).map((x) => x.trim()).filter(Boolean);
        if (l.length) a.choix = [...new Set(l)]; else delete a.choix;
        e.target.value = choixScan(a).join(' ; '); marquer(c.id);
      } })));
      if (mode === 'duree') reglages.push(duree('min', 'Min'), duree('max', 'Max'));
      if (mode === 'plage') {
        reglages.push(nombre('min', 'Min'), nombre('max', 'Max'),
          el('label', { classe: 'inv-qte-libelle' }, 'Unité ', el('input', { classe: 'inv-qte', maxlength: '10', valeur: a.unite || '', 'aria-label': `Unité (${a.nom})`, surchange: (e) => { const t = e.target.value.trim(); if (t) a.unite = t; else delete a.unite; marquer(c.id); } })));
      }
    }
    return el('div', { classe: 'inv-edition-article inv-edition-fiche inv-edition-controle', 'data-cle': a.id }, poignee(a.nom),
      el('div', { classe: 'inv-edition-nom' },
        el('input', { 'aria-label': 'Libellé du contrôle', maxlength: '120', valeur: a.nom, classe: 'inv-nom-article', surchange: (e) => { const t = e.target.value.trim(); if (t) { a.nom = t; marquer(c.id); } else e.target.value = a.nom; } }),
        el('small', { texte: `Contrôle : ${CONTROLES[a.controle].nom}${texteAttente(a) ? ` (${texteAttente(a)})` : ''}` }),
        champCommentaire(c, a)),
      el('div', { classe: 'cfg-ligne inv-edition-outils' }, ...reglages, caseFacultatif(c, a), ...outils));
  }
  function blocArticles(c) {
    const liste = el('div', { classe: 'inv-edition-articles' });
    const dansLaListe = new Set(c.articles.filter((a) => a.ref).map((a) => a.ref));
    c.articles.forEach((a, i) => {
      const nom = nomArticle(a);
      const retirer = el('button', { type: 'button', classe: 'cfg-mini danger', 'aria-label': `Retirer ${nom} de cet inventaire`, texte: '✕', surclick: () => { c.articles.splice(c.articles.indexOf(a), 1); marquer(c.id); rendre({ garderPosition: true }); } });
      const fleches = [retirer];
      if (estReperePhoto(a)) {
        liste.append(el('div', { classe: 'cfg-ligne inv-edition-article inv-edition-separation inv-edition-repere-photo', 'data-cle': a.id }, poignee('Photo'),
          el('span', { classe: 'inv-etiquette-separation', texte: '📷 Photo' }),
          el('small', { classe: 'inv-repere-aide', texte: i === 0 ? 'Affichée avant la liste' : (i === c.articles.length - 1 ? 'Affichée après la liste' : 'Affichée ici, dans la liste') }),
          el('button', { type: 'button', classe: 'cfg-mini danger', 'aria-label': 'Retirer l\'emplacement de la photo (retour au placement automatique)', title: 'Retour au placement automatique', texte: '✕', surclick: () => { c.articles.splice(c.articles.indexOf(a), 1); marquer(c.id); rendre({ garderPosition: true }); } })));
        return;
      }
      if (a.separateur) {
        liste.append(el('div', { classe: 'cfg-ligne inv-edition-article inv-edition-separation', 'data-cle': a.id }, poignee(a.nom),
          el('span', { classe: 'inv-etiquette-separation', 'aria-hidden': 'true', texte: 'Séparation' }),
          el('input', { 'aria-label': 'Titre de la séparation', maxlength: '120', valeur: a.nom, classe: 'inv-nom-article', surchange: (e) => { const t = e.target.value.trim(); if (t) { a.nom = t; marquer(c.id); } else e.target.value = a.nom; } }),
          ...fleches));
        return;
      }
      if (estControle(a)) { liste.append(ligneEditionControle(c, a, fleches)); return; }
      const f = fiche(a);
      const qte = el('input', {
        type: 'number', inputmode: 'numeric', min: '0', max: '999', step: '1', classe: 'inv-qte', 'aria-label': `Quantité attendue de ${nom}`,
        valeur: /^\d+$/.test(String(a.quantite || '')) ? a.quantite : '', placeholder: '–',
        surfocus: (e) => e.target.select(),
        surchange: (e) => { const n = Math.round(Number(e.target.value)); a.quantite = e.target.value === '' || !(n >= 0) ? '' : String(Math.min(n, 999)); e.target.value = a.quantite; marquer(c.id); },
      });
      liste.append(el('div', { classe: `inv-edition-article inv-edition-fiche${rattacher === a.id ? ' inv-rattache' : ''}`, 'data-cle': a.id }, poignee(nom),
        el('div', { classe: 'inv-edition-nom' },
          el('strong', {}, f && f.photo ? el('span', { classe: 'inv-pastille-photo', title: 'Photo', 'aria-label': 'avec photo', texte: '📷 ' }) : null, nom),
          f ? el('small', { texte: resumeFiche(f) })
            : el('small', { classe: 'inv-hors-base' }, a.ref ? 'Fiche supprimée de la base des articles. ' : 'Pas dans la base des articles. ',
              el('button', { type: 'button', classe: 'lien', texte: rattacher === a.id ? 'Annuler' : 'Rattacher', surclick: () => {
                rattacher = rattacher === a.id ? '' : a.id;
                rechercheAjout = rattacher ? a.nom : '';
                creation = null;
                rendre({ garderPosition: true, focus: rattacher ? '.inv-recherche-article input' : '' });
              } })),
          champCommentaire(c, a)),
        el('div', { classe: 'cfg-ligne inv-edition-outils' }, el('label', { classe: 'inv-qte-libelle' }, 'Qté ',
          el('select', { classe: 'inv-qte-mode', 'aria-label': `Quantité exacte ou minimale (${nom})`, title: 'Exacte : ni plus ni moins. Minimale : au moins cette quantité (consommables conditionnés par boîtes…)', surchange: (e) => {
            if (e.target.value === 'min') a.quantiteMin = true; else delete a.quantiteMin;
            marquer(c.id);
          } }, el('option', { value: 'exact', selected: !estMinimum(a), texte: '=' }), el('option', { value: 'min', selected: estMinimum(a), texte: '≥' })),
          qte), caseFacultatif(c, a)), retirer));
    });

    triable(liste, (cles) => {
      const parId = {};
      c.articles.forEach((x) => { parId[x.id] = x; });
      c.articles = cles.map((id) => parId[id]).filter(Boolean);
      marquer(c.id);
      rendre({ garderPosition: true });
    });

    // ----- Ajout : recherche dans la base, sinon création de la fiche -----
    // Toucher une proposition ne retire pas le focus du champ de recherche : le clavier reste ouvert,
    // la page ne bouge pas sous le doigt et le clic arrive bien sur la proposition touchée.
    const garderFocus = { surmousedown: (e) => e.preventDefault(), surpointerdown: (e) => { if (e.pointerType !== 'mouse') e.preventDefault(); } };
    const cible = rattacher && c.articles.find((x) => x.id === rattacher);
    const champ = idChamp();
    const resultats = el('ul', { classe: 'inv-resultats', role: 'list' });
    const zoneCreation = el('div', { classe: 'inv-zone-creation' });
    const ajouterFiche = (f) => {
      if (cible) {
        cible.ref = f.id; cible.nom = f.denomination; cible.peremption = f.perissable;
        rattacher = '';
      } else {
        c.articles.push({ id: nouvelId(), ref: f.id, nom: f.denomination, quantite: '1', peremption: f.perissable });
      }
      rechercheAjout = '';
      creation = null;
      marquer(c.id);
      // Le curseur revient dans la recherche pour enchaîner les ajouts ; la quantité reste modifiable dans la liste.
      rendre({ garderPosition: true, focus: '.inv-recherche-article input' });
    };
    const ouvrirCreation = () => {
      creation = creation || { id: nouvelId(), denomination: rechercheAjout.trim(), categorie: '', horsStock: false, refInterne: '', refFournisseur: '', consommable: true, perissable: false, archive: false, secretariat: false };
      zoneCreation.innerHTML = '';
      zoneCreation.append(formulaireFiche(creation, {
        titre: 'Nouvel article dans la base',
        surEnregistrer: (f) => { enregistrerFiche(f); ajouterFiche(f); },
        surAnnuler: () => { creation = null; zoneCreation.innerHTML = ''; afficherResultats(); },
        utiliser: ajouterFiche,
      }));
      resultats.innerHTML = '';
      zoneCreation.querySelector('input').focus();
    };
    const afficherResultats = () => {
      resultats.innerHTML = '';
      const texte = rechercheAjout.trim();
      if (cle(texte).length < 2) return;
      const trouvees = chercherFiches(texte);
      trouvees.slice(0, toutAfficherAjout ? trouvees.length : 8).forEach((f) => {
        const deja = dansLaListe.has(f.id);
        resultats.append(el('li', {}, el('button', { type: 'button', classe: 'inv-resultat', surclick: () => ajouterFiche(f), ...garderFocus },
          el('strong', { texte: f.denomination }),
          el('small', { texte: `${resumeFiche(f)}${deja ? ' · déjà dans cet inventaire' : ''}` }))));
      });
      if (trouvees.length > 8 && !toutAfficherAjout) {
        resultats.append(el('li', {}, el('button', {
          type: 'button', classe: 'inv-resultat inv-voir-tout', ...garderFocus,
          surclick: () => { toutAfficherAjout = true; afficherResultats(); },
        }, el('strong', { texte: `Afficher les ${trouvees.length - 8} autres résultats` }))));
      }
      // On ne propose de créer que si la dénomination exacte n'existe pas déjà.
      if (!trouvees.some((f) => cle(f.denomination) === cle(texte))) {
        resultats.append(el('li', {}, el('button', { type: 'button', classe: 'inv-resultat inv-creer', surclick: ouvrirCreation, ...garderFocus },
          el('strong', { texte: `＋ Créer « ${texte} » dans la base` }),
          el('small', { texte: trouvees.length ? 'Aucun des articles ci-dessus ne convient' : 'Aucun article de la base ne correspond' }))));
      }
    };
    const recherche = el('input', {
      id: champ, type: 'search', autocomplete: 'off', valeur: rechercheAjout, placeholder: 'Nom ou référence (ex. KT 18, 404448)',
      surinput: (e) => {
        // Android renvoie le texte quand le clavier se ferme : sans changement, on ne reconstruit pas la liste
        // (sinon la proposition touchée disparaît avant que le clic n'arrive).
        if (e.target.value === rechercheAjout) return;
        rechercheAjout = e.target.value; toutAfficherAjout = false; creation = null; zoneCreation.innerHTML = ''; afficherResultats();
      },
      surkeydown: (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const premier = resultats.querySelector('button');
        if (premier) premier.click();
      },
    });
    afficherResultats();
    if (creation) setTimeout(() => { if (document.contains(zoneCreation)) ouvrirCreation(); });

    return el('section', { classe: 'inv-section' }, el('h2', { texte: 'Articles et contrôles' }),
      c.articles.length ? null : el('p', { classe: 'aide-question', texte: 'Aucun article : ce niveau sert seulement à ouvrir ses sous-inventaires.' }),
      liste,
      el('div', { classe: 'champ inv-recherche-article' },
        el('label', { for: champ, texte: cible ? `Rattacher « ${cible.nom} » à un article de la base` : 'Ajouter un article' }),
        recherche, resultats, zoneCreation,
        cible ? null : el('div', { classe: 'cfg-actions inv-boutons-ajout' },
          el('details', { classe: 'inv-ajout-controle' },
            el('summary', { classe: 'cfg-bouton', texte: 'Ajouter un contrôle' }),
            el('div', { classe: 'inv-types-controle' }, ...Object.entries(CONTROLES).map(([k, t]) => el('button', { type: 'button', classe: 'cfg-bouton', surclick: () => {
              c.articles.push({ id: nouvelId(), nom: t.defaut, controle: k, ...(k === 'temperature' ? { min: 2, max: 8 } : {}) });
              marquer(c.id);
              rendre({ garderPosition: true, focus: '.inv-edition-controle:last-of-type input' });
              const ch = zone.querySelector('.inv-edition-controle:last-of-type input');
              if (ch) ch.select();
            } }, el('strong', { texte: t.nom }), el('small', { texte: ` — ${t.aide}` }))))),
          reperePhoto(c) < 0 ? el('button', { type: 'button', classe: 'cfg-bouton', title: 'Choisir où la photo s\'affiche dans la check-list : faites glisser le repère « Photo » parmi les articles', texte: '📷 Placer la photo', surclick: () => {
            c.articles.unshift({ id: nouvelId(), nom: 'Photo', separateur: true, photo: true });
            marquer(c.id);
            rendre({ garderPosition: true });
          } }) : null,
          el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Ajouter une séparation', surclick: () => {
            c.articles.push({ id: nouvelId(), nom: 'Nouvelle séparation', separateur: true });
            marquer(c.id);
            rendre({ garderPosition: true, focus: '.inv-edition-separation:last-of-type input' });
            const champTitre = zone.querySelector('.inv-edition-separation:last-of-type input');
            if (champTitre) champTitre.select();
          } }),
          el('a', { classe: 'lien', href: lien(BASE), texte: 'Base des articles' }))));
  }

  /** Base des articles : recherche, filtre par catégorie, création et modification des fiches. */
  /** Enregistre une fiche ; la copie du nom dans les inventaires suit (historique des vérifications plus lisible). */
  function enregistrerFicheEtInventaires(g) {
    enregistrerFiche(g);
    Object.values(structure.contenants).forEach((c) => {
      let change = false;
      c.articles.forEach((a) => { if (a.ref === g.id && (a.nom !== g.denomination || a.peremption !== g.perissable)) { a.nom = g.denomination; a.peremption = g.perissable; change = true; } });
      if (change) marquer(c.id);
    });
  }

  /**
   * Fusionne une fiche en doublon (`src`) dans la fiche à conserver (`cib`) : tous les articles d'inventaire
   * qui pointaient vers `src` pointent désormais vers `cib`, les champs vides de `cib` sont complétés
   * avec ceux de `src` (catégorie, réfs, photo), puis `src` est archivée.
   */
  function fusionnerFiches(src, cib) {
    const touches = new Set();
    const doubles = new Set(); // inventaires qui contenaient déjà les deux fiches
    Object.values(structure.contenants).forEach((c) => {
      const avait = c.articles.some((a) => a.ref === cib.id);
      let change = false;
      c.articles.forEach((a) => { if (a.ref === src.id) { a.ref = cib.id; change = true; } });
      if (change) { touches.add(c.id); if (avait) doubles.add(c.id); }
    });
    const photoReprise = !cib.photo && Boolean(src.photo);
    enregistrerFicheEtInventaires(normaliserFiche({
      ...cib, categorie: cib.categorie || src.categorie, refInterne: cib.refInterne || src.refInterne,
      refFournisseur: cib.refFournisseur || src.refFournisseur, photo: cib.photo || src.photo,
    }));
    touches.forEach(marquer);
    enregistrerFiche({ ...src, archive: true, photo: photoReprise ? '' : src.photo });
    brouillonsBase.delete(src.id);
    brouillonsBase.delete(cib.id);
    return { inventaires: touches.size, doubles: doubles.size };
  }

  const icone = (...formes) => el('svg:svg', { viewBox: '0 0 24 24', width: '20', height: '20', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
    ...formes.map((d) => el('svg:path', { d })));
  const iconeAppareil = () => icone('M3 8h3.5l2-3h7l2 3H21v11H3z', 'M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z');
  const iconeImage = () => icone('M3 4h18v16H3z', 'M3 16l5-5 4 4 3-3 6 6', 'M15.5 9.5a1.5 1.5 0 1 0 0-.01');
  const iconeArchive = () => icone('M3 4h18v4H3z', 'M5 8v12h14V8', 'M10 12h4');
  const iconeFusion = () => icone('M6 3v6a6 6 0 0 0 6 6', 'M18 3v6a6 6 0 0 1-6 6', 'M12 15v6');
  const iconeReactiver = () => icone('M4 12a8 8 0 1 0 2.5-5.8', 'M4 4v4h4');

  /** Miniature carrée de la photo d'une fiche (ou pictogramme gris s'il n'y en a pas). */
  function miniatureFiche(id) {
    if (!id) return el('span', { classe: 'inv-miniature-vide', 'aria-hidden': 'true' }, iconeImage());
    const img = el('img', { alt: '' });
    const d = Photos.enMemoire(id);
    if (d) img.src = d; else obtenirPhoto(id).then((x) => { if (x) img.src = x; });
    return img;
  }

  /**
   * Base des articles sur ordinateur : tableau éditable. Les modifications de plusieurs lignes
   * sont gardées en brouillon (brouillonsBase) et enregistrées ensemble.
   */
  function tableauBase(fiches, usages, rafraichir) {
    const valeur = (f) => brouillonsBase.get(f.id) || f;
    const modifier = (f, champ, v) => {
      const d = { ...valeur(f), [champ]: v };
      const origine = structure.catalogue[f.id];
      const pareil = ['denomination', 'categorie', 'refInterne', 'refFournisseur', 'consommable', 'perissable', 'horsStock', 'archive', 'photo', 'secretariat']
        .every((k) => String(d[k]) === String(origine[k]));
      if (pareil) brouillonsBase.delete(f.id); else brouillonsBase.set(f.id, d);
      majCompte();
      return d;
    };
    const corps = el('tbody');
    const compteur = el('span', { classe: 'inv-tb-base-compte', role: 'status' });
    const erreur = el('p', { classe: 'message erreur', role: 'alert', hidden: true });
    const boutons = [];
    function majCompte() {
      const n = brouillonsBase.size;
      compteur.textContent = n ? `${pluriel(n, 'article modifié', 'articles modifiés')}, non enregistré${n > 1 ? 's' : ''}` : 'Aucune modification en attente.';
      boutons.forEach((b) => { b.disabled = !n; });
      corps.querySelectorAll('tr').forEach((tr) => tr.classList.toggle('modifie', brouillonsBase.has(tr.dataset.id)));
    }
    const enregistrer = () => {
      const fautes = [];
      corps.querySelectorAll('tr.faute').forEach((tr) => { tr.classList.remove('faute'); tr.removeAttribute('title'); });
      const prets = [...brouillonsBase.values()].map((d) => {
        const g = normaliserFiche({ ...d, denomination: String(d.denomination).trim().replace(/\s+/g, ' '), refInterne: String(d.refInterne).trim(), refFournisseur: String(d.refFournisseur).trim() });
        let probleme = !g.denomination ? 'dénomination vide' : (!g.categorie ? 'catégorie à choisir' : '');
        const autre = !probleme && !g.archive ? doublon(g) : null;
        if (autre) probleme = cle(autre.denomination) === cle(g.denomination) ? `« ${autre.denomination} » existe déjà` : `réf. interne déjà utilisée par « ${autre.denomination} »`;
        if (probleme) {
          fautes.push(`${g.denomination || '(sans nom)'} : ${probleme}`);
          const tr = corps.querySelector(`tr[data-id="${g.id}"]`);
          if (tr) { tr.classList.add('faute'); tr.title = probleme; }
        }
        return g;
      });
      if (fautes.length) { erreur.textContent = `Rien n'a été enregistré. À corriger : ${fautes.join(' ; ')}.`; erreur.hidden = false; return; }
      prets.forEach(enregistrerFicheEtInventaires);
      brouillonsBase.clear();
      avis = `${pluriel(prets.length, 'fiche enregistrée', 'fiches enregistrées')}.`;
      rendre({ garderPosition: true });
    };
    const annuler = () => { brouillonsBase.clear(); erreur.hidden = true; rafraichir(); };
    const barre = () => {
      const b = el('button', { type: 'button', classe: 'cfg-bouton inv-actif', texte: 'Enregistrer les modifications', surclick: enregistrer });
      const a = el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Annuler les modifications', surclick: annuler });
      boutons.push(b, a);
      return el('div', { classe: 'cfg-actions inv-tb-base-actions' }, b, a);
    };

    fiches.forEach((f0) => {
      const f = valeur(f0);
      const nb = (usages[f0.id] || []).length;
      const tr = el('tr', { 'data-id': f0.id, classe: f.archive ? 'archive' : '' });
      const texte = (champ, libelle, max) => el('td', {}, el('input', {
        type: 'text', valeur: f[champ], maxlength: max, 'aria-label': `${libelle} : ${f0.denomination}`, autocomplete: 'off',
        surinput: (e) => { modifier(f0, champ, e.target.value); },
      }));
      const caseC = (champ, libelle) => el('td', { classe: 'inv-tb-base-case' }, el('input', {
        type: 'checkbox', checked: f[champ] === true, 'aria-label': `${libelle} : ${f0.denomination}`,
        surchange: (e) => { modifier(f0, champ, e.target.checked); },
      }));
      // Case « Secrétariat » : cochable seulement pour la catégorie « Documents ».
      const inputSecr = el('input', {
        type: 'checkbox', checked: f.secretariat === true, 'aria-label': `Secrétariat : ${f0.denomination}`,
        surchange: (e) => { modifier(f0, 'secretariat', e.target.checked); },
      });
      inputSecr.disabled = f.categorie !== 'Documents';
      const cat = el('select', { 'aria-label': `Catégorie : ${f0.denomination}`, surchange: (e) => {
        modifier(f0, 'categorie', e.target.value);
        const docs = e.target.value === 'Documents';
        if (!docs && valeur(f0).secretariat) { modifier(f0, 'secretariat', false); inputSecr.checked = false; }
        inputSecr.disabled = !docs;
      } },
        el('option', { value: '', texte: '—' }), ...CATEGORIES.map((c) => el('option', { value: c, texte: c })));
      cat.value = f.categorie;
      // Miniature de la photo (rafraîchie quand on en ajoute une) : la toucher l'ouvre en grand,
      // ou, sans photo, ouvre l'appareil photo.
      const idPrendre = idChamp();
      const idChoisir = idChamp();
      const vignette = el('button', { type: 'button', classe: 'inv-miniature' });
      const montrer = (id) => {
        vignette.replaceChildren(miniatureFiche(id));
        vignette.title = id ? 'Voir la photo en grand' : 'Pas de photo : en prendre une';
        vignette.setAttribute('aria-label', `${id ? 'Voir la photo' : 'Prendre une photo'} : ${f0.denomination}`);
      };
      vignette.addEventListener('click', () => {
        const g = valeur(f0);
        if (g.photo) voirFiche(g); else document.getElementById(idPrendre).click();
      });
      montrer(f.photo);
      const recevoir = async (e) => {
        const fichier = e.target.files[0];
        e.target.value = '';
        if (!fichier) return;
        try {
          const res = await recadrerImage(fichier, 900);
          if (!res) return;
          const id = `local-${nouvelId()}`;
          await Photos.ecrire(id, res.donnees);
          modifier(f0, 'photo', id);
          montrer(id);
        } catch (err) { erreur.textContent = `Photo illisible ou trop lourde pour « ${f0.denomination} » : réessayez.`; erreur.hidden = false; }
      };
      const archive = el('button', { type: 'button', classe: 'cfg-mini inv-tb-base-icone' });
      const majArchive = () => {
        const a = valeur(f0).archive;
        tr.classList.toggle('archive', a);
        archive.innerHTML = '';
        archive.append(a ? iconeReactiver() : iconeArchive());
        archive.classList.toggle('danger', !a);
        archive.disabled = !a && nb > 0;
        const t = a ? `Réactiver « ${f0.denomination} »` : (nb ? `Archivage impossible : utilisé dans ${pluriel(nb, 'inventaire')}` : `Archiver « ${f0.denomination} »`);
        archive.title = t;
        archive.setAttribute('aria-label', t);
      };
      archive.addEventListener('click', () => { modifier(f0, 'archive', !valeur(f0).archive); majArchive(); });
      majArchive();
      tr.append(
        el('td', { classe: 'inv-tb-base-photo' }, vignette),
        el('td', { classe: 'inv-tb-base-nom' }, el('input', {
          type: 'text', valeur: f.denomination, maxlength: '120', 'aria-label': 'Dénomination', autocomplete: 'off',
          title: nb ? `Dans ${pluriel(nb, 'inventaire')}` : 'Utilisé dans aucun inventaire',
          surinput: (e) => { modifier(f0, 'denomination', e.target.value); },
        })),
        el('td', {}, cat),
        texte('refInterne', 'Réf. interne', '60'),
        texte('refFournisseur', 'Réf. fournisseur', '120'),
        caseC('consommable', 'Consommable'),
        caseC('perissable', 'Périssable'),
        caseC('horsStock', 'Hors stock'),
        el('td', { classe: 'inv-tb-base-case' }, inputSecr),
        el('td', { classe: 'inv-tb-base-outils' },
          el('label', { for: idPrendre, classe: 'cfg-mini inv-tb-base-icone', title: 'Prendre une photo', 'aria-label': `Prendre une photo : ${f0.denomination}` }, iconeAppareil()),
          el('input', { type: 'file', id: idPrendre, accept: 'image/*', capture: 'environment', classe: 'invisible', surchange: recevoir }),
          el('label', { for: idChoisir, classe: 'cfg-mini inv-tb-base-icone', title: 'Choisir une photo', 'aria-label': `Choisir une photo : ${f0.denomination}` }, iconeImage()),
          el('input', { type: 'file', id: idChoisir, accept: 'image/*', classe: 'invisible', surchange: recevoir }),
          el('button', { type: 'button', classe: 'cfg-mini inv-tb-base-icone', title: `Fusionner « ${f0.denomination} » avec un autre article (doublon)`, 'aria-label': `Fusionner : ${f0.denomination}`,
            disabled: f.archive, surclick: () => { fusion = { source: f0.id, cible: '', texte: f0.denomination }; rendre({ garderPosition: true }); } }, iconeFusion()),
          archive));
      corps.append(tr);
    });
    const tete = el('thead', {}, el('tr', {}, ...['Photo', 'Dénomination', 'Catégorie', 'Réf. interne', 'Réf. fournisseur', 'Consommable', 'Périssable', 'Hors stock', 'Secrétariat', '']
      .map((t) => el('th', { scope: 'col', texte: t }))));
    const bloc = el('div', { classe: 'inv-tb-base' }, barre(), compteur, erreur,
      el('div', { classe: 'inv-tb-base-defile' }, el('table', { classe: 'inv-tb-base-table' }, tete, corps)), barre());
    majCompte();
    return bloc;
  }

  /**
   * Photos en série des articles de la base : la caméra reste ouverte, l'article à photographier est
   * affiché par-dessus, les articles défilent dans un bandeau en bas. Après chaque prise : détourage
   * automatique (fond uni, désactivable), recadrage, puis passage tout seul à l'article suivant.
   * Les articles proposés suivent la recherche et la catégorie de la base ; « Sans photo » par défaut.
   */
  function rafalePhotos() {
    const reglages = lireJson('avismur_rafale', {});
    // Détourage : même réglage que le bouton « ✨ Détourer » de l'outil de recadrage (toutes les photos).
    const detourageDispo = typeof Detourage !== 'undefined';
    if (detourageDispo && reglages.detourage !== undefined) { Recadrage.memoriserDetourage(reglages.detourage !== false); delete reglages.detourage; ecrireJson('avismur_rafale', reglages); }
    let detourer = detourageDispo && Recadrage.detourageVoulu();
    let sansPhoto = reglages.sansPhoto !== false;
    let categorie = baseFiltre.categorie;
    let liste = [];
    let index = 0;
    let flux = null;
    let fini = false;
    let occupe = false;
    let torche = false;
    const faites = new Map(); // id de fiche → photo prise pendant la séance (vignette du bandeau)

    const preparer = () => {
      // Liste figée à l'ouverture et à chaque changement de filtre : un article photographié reste
      // dans le bandeau (coché) au lieu de disparaître sous le doigt.
      liste = chercherFiches(baseFiltre.texte, { categorie }).filter((f) => !sansPhoto || !f.photo || faites.has(f.id));
      index = Math.max(0, liste.findIndex((f) => !faites.has(f.id)));
    };
    const courant = () => liste[index] || null;

    const video = el('video', { playsinline: '', muted: '', autoplay: '' });
    video.muted = true;
    const nomArticle0 = el('strong', { classe: 'inv-rafale-nom' });
    const detailArticle = el('small', { classe: 'inv-rafale-detail' });
    const etiquette = el('div', { classe: 'inv-rafale-article', 'aria-live': 'polite' }, nomArticle0, detailArticle);
    const vue = el('div', { classe: 'camera-vue inv-rafale-video' }, video, el('div', { classe: 'inv-rafale-cadre', 'aria-hidden': 'true' }), etiquette);
    const lecture = el('p', { classe: 'lecture', role: 'status', 'aria-live': 'polite' });
    const compte = el('span', { classe: 'inv-vrac-total' });
    const bandeau = el('ol', { classe: 'inv-rafale-bandeau', 'aria-label': 'Articles à photographier' });
    const fichierSecours = el('input', { type: 'file', accept: 'image/*', capture: 'environment', classe: 'invisible' });
    const fichierGalerie = el('input', { type: 'file', accept: 'image/*', classe: 'invisible' });
    const declencheur = el('button', { type: 'button', classe: 'inv-rafale-declencheur', 'aria-label': 'Prendre la photo' }, el('span'));
    const precedent = el('button', { type: 'button', classe: 'inv-vrac-outil', 'aria-label': 'Article précédent', texte: '‹' });
    const suivant = el('button', { type: 'button', classe: 'inv-vrac-outil', 'aria-label': 'Passer à l\'article suivant', texte: '›' });
    const boutonGalerie = el('button', { type: 'button', classe: 'inv-vrac-outil', title: 'Choisir une image', 'aria-label': 'Choisir une image enregistrée' }, iconeImage());
    const boutonDetourage = el('button', { type: 'button', classe: 'inv-vrac-outil inv-rafale-detourage', title: 'Détourage automatique (objet posé sur un fond uni)' });
    const boutonTorche = el('button', { type: 'button', classe: 'inv-vrac-outil', title: 'Lampe', 'aria-label': 'Allumer la lampe', 'aria-pressed': 'false', hidden: true, texte: '🔦' });
    const caseSansPhoto = el('input', { type: 'checkbox', checked: sansPhoto });
    const choixCategorie = el('select', { 'aria-label': 'Catégorie' }, el('option', { value: '', texte: 'Toutes catégories' }), ...CATEGORIES.map((c) => el('option', { value: c, texte: c })));
    choixCategorie.value = categorie;

    const annonce = (texte, classe = '') => { lecture.textContent = texte; lecture.className = `lecture ${classe}`.trim(); };
    const sauverReglages = () => { ecrireJson('avismur_rafale', { sansPhoto }); if (detourageDispo) Recadrage.memoriserDetourage(detourer); };
    const majDetourage = () => {
      boutonDetourage.hidden = !detourageDispo;
      boutonDetourage.setAttribute('aria-pressed', String(detourer));
      boutonDetourage.setAttribute('aria-label', detourer ? 'Détourage automatique activé : appuyer pour le couper' : 'Détourage automatique coupé : appuyer pour l\'activer');
      boutonDetourage.replaceChildren(icone('M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8z', 'M5 16l.9 2.1L8 19l-2.1.9L5 22l-.9-2.1L2 19l2.1-.9z', ...(detourer ? [] : ['M3 3l18 18'])));
    };
    const majArticle = () => {
      const f = courant();
      const reste = liste.filter((x) => !faites.has(x.id)).length;
      compte.textContent = liste.length ? `${faites.size ? `${faites.size} faite${faites.size > 1 ? 's' : ''} · ` : ''}${pluriel(reste, 'restant', 'restants')}` : '';
      nomArticle0.textContent = f ? f.denomination : (liste.length ? 'Tous les articles ont une photo' : 'Aucun article');
      detailArticle.textContent = f ? [f.categorie, f.refInterne && `réf. ${f.refInterne}`, faites.has(f.id) ? '✓ photo prise' : (f.photo ? 'a déjà une photo (sera remplacée)' : '')].filter(Boolean).join(' · ') : (sansPhoto ? 'Décochez « Sans photo » pour reprendre une photo existante.' : 'Modifiez la catégorie ou la recherche.');
      declencheur.disabled = !f || occupe;
      boutonGalerie.disabled = !f || occupe;
      precedent.disabled = index <= 0;
      suivant.disabled = index >= liste.length - 1;
      bandeau.querySelectorAll('li').forEach((li, i) => {
        li.classList.toggle('courant', i === index);
        li.querySelector('button').setAttribute('aria-current', i === index ? 'true' : 'false');
      });
      const li = bandeau.children[index];
      if (li) li.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    };
    const carte = (f, i) => {
      const image = el('img', { alt: '', hidden: true });
      const photo = faites.get(f.id) || f.photo;
      if (photo) {
        const d = faites.has(f.id) ? faites.get(f.id) : Photos.enMemoire(photo);
        if (d) { image.src = d; image.hidden = false; } else obtenirPhoto(photo).then((x) => { if (x) { image.src = x; image.hidden = false; } });
      }
      return el('li', { classe: faites.has(f.id) ? 'faite' : '' },
        el('button', { type: 'button', 'aria-label': `${f.denomination}${faites.has(f.id) ? ' (photo prise)' : ''}`, surclick: () => { index = i; majArticle(); } },
          el('span', { classe: 'inv-rafale-vignette' }, image, faites.has(f.id) ? el('span', { classe: 'inv-rafale-coche', texte: '✓' }) : null),
          el('span', { classe: 'inv-rafale-carte-nom', texte: f.denomination })));
    };
    const majBandeau = () => {
      bandeau.replaceChildren(...liste.map(carte));
      majArticle();
    };
    const allerSuivantSansPhoto = () => {
      const apres = liste.findIndex((f, i) => i > index && !faites.has(f.id));
      const avant = liste.findIndex((f) => !faites.has(f.id));
      if (apres >= 0) index = apres; else if (avant >= 0) index = avant;
    };

    /** Image de la caméra à pleine définition. */
    const saisirImage = () => {
      const toile = document.createElement('canvas');
      toile.width = video.videoWidth;
      toile.height = video.videoHeight;
      toile.getContext('2d').drawImage(video, 0, 0);
      return toile.toDataURL('image/jpeg', 0.92);
    };
    /** Détourage éventuel, recadrage, puis enregistrement sur la fiche. */
    const traiter = async (source) => {
      const f = courant();
      if (!f || occupe) return;
      occupe = true;
      majArticle();
      try {
        const recadre = await Recadrage.recadrer(source, { cote: 900, max: PHOTO_MAX, titre: f.denomination, detourer });
        // « ✨ Détourer » a pu être changé dans le recadrage : le bouton de la séance suit.
        detourer = detourageDispo && Recadrage.detourageVoulu();
        majDetourage();
        if (!recadre) { annonce('Photo abandonnée : reprenez-la ou passez à l\'article suivant.'); return; }
        const id = `local-${nouvelId()}`;
        await Photos.ecrire(id, recadre.donnees);
        enregistrerFiche({ ...structure.catalogue[f.id], photo: id });
        faites.set(f.id, recadre.donnees);
        const li = bandeau.children[index];
        if (li) li.replaceWith(carte(structure.catalogue[f.id], index));
        signalVrac(true);
        annonce(`✓ Photo enregistrée : ${f.denomination}.`, 'ok');
        allerSuivantSansPhoto();
      } catch (e) {
        annonce('Photo illisible ou trop lourde : réessayez.', 'erreur');
      } finally {
        occupe = false;
        majArticle();
      }
    };

    const arreterCamera = () => {
      if (flux) flux.getTracks().forEach((t) => t.stop());
      flux = null;
      video.srcObject = null;
    };
    const demarrerCamera = async () => {
      if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) throw new Error('caméra');
      const f = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false });
      if (fini) { f.getTracks().forEach((t) => t.stop()); return; }
      flux = f;
      video.srcObject = f;
      const piste = f.getVideoTracks()[0];
      const capacites = piste && piste.getCapabilities ? piste.getCapabilities() : {};
      boutonTorche.hidden = !capacites.torch;
    };
    declencheur.addEventListener('click', () => {
      if (!courant() || occupe) return;
      if (!flux || video.readyState < 2 || !video.videoWidth) { fichierSecours.click(); return; }
      vue.classList.remove('flash');
      void vue.offsetWidth; // relance l'animation
      vue.classList.add('flash');
      traiter(saisirImage());
    });
    const recevoirFichier = (e) => {
      const fichier = e.target.files[0];
      e.target.value = '';
      if (!fichier) return;
      const lecteur = new FileReader();
      lecteur.onload = () => traiter(lecteur.result);
      lecteur.onerror = () => annonce('Image illisible.', 'erreur');
      lecteur.readAsDataURL(fichier);
    };
    fichierSecours.addEventListener('change', recevoirFichier);
    fichierGalerie.addEventListener('change', recevoirFichier);
    boutonGalerie.addEventListener('click', () => fichierGalerie.click());
    precedent.addEventListener('click', () => { if (index > 0) { index -= 1; majArticle(); } });
    suivant.addEventListener('click', () => { if (index < liste.length - 1) { index += 1; majArticle(); } });
    boutonDetourage.addEventListener('click', () => {
      detourer = !detourer;
      sauverReglages();
      majDetourage();
      annonce(detourer ? 'Détourage automatique activé : posez l\'objet sur un fond uni et contrasté.' : 'Détourage automatique coupé.');
    });
    boutonTorche.addEventListener('click', async () => {
      const piste = flux && flux.getVideoTracks()[0];
      if (!piste) return;
      try {
        torche = !torche;
        await piste.applyConstraints({ advanced: [{ torch: torche }] });
        boutonTorche.setAttribute('aria-pressed', String(torche));
        boutonTorche.setAttribute('aria-label', torche ? 'Éteindre la lampe' : 'Allumer la lampe');
      } catch (e) { torche = false; }
    });
    caseSansPhoto.addEventListener('change', () => { sansPhoto = caseSansPhoto.checked; sauverReglages(); preparer(); majBandeau(); });
    choixCategorie.addEventListener('change', () => { categorie = choixCategorie.value; preparer(); majBandeau(); });

    const fermerBouton = el('button', { type: 'button', classe: 'inv-vrac-outil', 'aria-label': 'Fermer', texte: '✕' });
    const ecran = el('div', { classe: 'camera inv-rafale', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Photos des articles en série' },
      el('div', { classe: 'inv-vrac-haut' },
        el('div', { classe: 'inv-vrac-titre' }, el('strong', { texte: 'Photos des articles' }), compte),
        boutonTorche, boutonDetourage, fermerBouton),
      el('div', { classe: 'inv-rafale-filtres' },
        el('label', { classe: 'inv-rafale-sans' }, caseSansPhoto, ' Sans photo'), choixCategorie),
      vue,
      el('div', { classe: 'inv-rafale-commandes' }, precedent, boutonGalerie, declencheur, el('span', { classe: 'inv-rafale-vide' }), suivant),
      lecture, bandeau, fichierSecours, fichierGalerie);
    const fermer = () => {
      if (fini) return;
      fini = true;
      arreterCamera();
      ecran.remove();
      document.body.classList.remove('camera-ouverte');
      if (faites.size) avis = `${pluriel(faites.size, 'photo enregistrée', 'photos enregistrées')} dans la base des articles.`;
      rendre({ garderPosition: true });
    };
    fermerBouton.addEventListener('click', fermer);
    ecran.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { fermer(); return; }
      if (e.target.closest('select, input')) return;
      if (e.key === 'ArrowRight') suivant.click();
      else if (e.key === 'ArrowLeft') precedent.click();
      else if ((e.key === ' ' || e.key === 'Enter') && !e.target.closest('button')) { e.preventDefault(); declencheur.click(); }
    });
    preparer();
    document.body.append(ecran);
    document.body.classList.add('camera-ouverte');
    majDetourage();
    majBandeau();
    declencheur.focus();
    annonce(detourer ? 'Posez l\'article sur un fond uni (feuille blanche…) et déclenchez.' : 'Cadrez l\'article et déclenchez.');
    demarrerCamera().catch(() => {
      vue.classList.add('sans-camera');
      annonce('Caméra inaccessible ici : le déclencheur ouvre l\'appareil photo du téléphone.', 'deja');
    });
  }

  /** Fusion d'un doublon : choix de la fiche à conserver, récapitulatif, confirmation. */
  function blocFusion(usages) {
    const src = structure.catalogue[fusion.source];
    if (!src) { fusion = null; return null; }
    const annuler = () => { fusion = null; rendre({ garderPosition: true }); };
    const nb = (usages[src.id] || []).length;
    const cib = fusion.cible && structure.catalogue[fusion.cible];
    const entete = el('h2', { texte: `Fusionner « ${src.denomination} »` });
    if (cib) {
      const communs = (usages[src.id] || []).filter((c) => (usages[cib.id] || []).includes(c)).length;
      const reprises = [!cib.categorie && src.categorie ? 'catégorie' : '', !cib.refInterne && src.refInterne ? 'réf. interne' : '',
        !cib.refFournisseur && src.refFournisseur ? 'réf. fournisseur' : '', !cib.photo && src.photo ? 'photo' : ''].filter(Boolean);
      return el('section', { classe: 'inv-fusion' }, entete,
        el('p', { texte: `« ${src.denomination} » sera remplacé par « ${cib.denomination} » dans ${nb ? pluriel(nb, 'inventaire') : 'aucun inventaire'}, puis archivé.` }),
        reprises.length ? el('p', { classe: 'aide-question', texte: `Repris de la fiche fusionnée, car vide sur celle conservée : ${reprises.join(', ')}.` }) : null,
        communs ? el('p', { classe: 'message erreur', texte: `${pluriel(communs, 'inventaire contient', 'inventaires contiennent')} déjà les deux articles : les deux lignes seront conservées, à regrouper à la main.` }) : null,
        el('p', { classe: 'aide-question', texte: 'Les dates de péremption déjà saisies et l\'historique des vérifications sont conservés.' }),
        el('div', { classe: 'cfg-actions' },
          el('button', { type: 'button', classe: 'cfg-bouton danger', texte: 'Confirmer la fusion', surclick: () => {
            const r = fusionnerFiches(src, cib);
            fusion = null; baseOuverte = ''; baseFiltre.texte = cib.denomination;
            avis = `« ${src.denomination} » fusionné dans « ${cib.denomination} » (${pluriel(r.inventaires, 'inventaire')} mis à jour).`;
            rendre({ garderPosition: true });
          } }),
          el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Choisir un autre article', surclick: () => { fusion.cible = ''; rendre({ garderPosition: true }); } }),
          el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Annuler', surclick: annuler })));
    }
    const liste = el('ul', { classe: 'inv-base-liste' });
    const champ = idChamp();
    const remplir = () => {
      liste.innerHTML = '';
      const trouvees = chercherFiches(fusion.texte || src.denomination).filter((f) => f.id !== src.id).slice(0, 8);
      if (!trouvees.length) liste.append(el('li', {}, el('small', { texte: 'Aucun article ne correspond.' })));
      trouvees.forEach((f) => liste.append(el('li', { classe: 'inv-base-article' },
        el('button', { type: 'button', classe: 'inv-resultat inv-resultat-photo', surclick: () => { fusion.cible = f.id; rendre({ garderPosition: true }); } },
          el('span', { classe: 'inv-miniature' }, miniatureFiche(f.photo)),
          el('span', { classe: 'inv-resultat-texte' }, el('strong', { texte: f.denomination }), el('small', { texte: resumeFiche(f) }))))));
    };
    remplir();
    return el('section', { classe: 'inv-fusion' }, entete,
      el('p', { classe: 'aide-question', texte: 'Quel article faut-il conserver ? Celui-ci sera remplacé par lui dans tous les inventaires.' }),
      el('label', { for: champ, classe: 'invisible', texte: 'Chercher l\'article à conserver' }),
      el('input', { id: champ, type: 'search', autocomplete: 'off', placeholder: 'Nom ou référence de l\'article à conserver', valeur: fusion.texte || src.denomination, surinput: (e) => { fusion.texte = e.target.value; remplir(); } }),
      liste,
      el('div', { classe: 'cfg-actions' }, el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Annuler', surclick: annuler })));
  }

  function vueBase() {
    const admin = aDroitApp('ARTICLES');
    // Sur ordinateur (écran large), les gestionnaires éditent la base dans un tableau.
    const enTableau = admin && window.matchMedia('(min-width: 1100px)').matches;
    const usages = utilisations();
    const liste = el('ul', { classe: 'inv-base-liste' });
    const compte = el('p', { classe: 'aide-question', role: 'status' });
    const nouvelle = el('div');
    const tableau = el('div');
    const suite = el('div', { classe: 'inv-suite' });
    const fermer = () => { baseOuverte = ''; remplir(); };
    const detail = (f) => {
      const ou = usages[f.id] || [];
      const lieux = ou.length
        ? el('p', { classe: 'inv-usages' }, `Dans ${pluriel(ou.length, 'inventaire')} : `,
          ...ou.flatMap((c, i) => [i ? ', ' : '', el('a', { href: lien(c.id), texte: cheminNoms(c.id) })]))
        : el('p', { classe: 'inv-usages', texte: 'Utilisé dans aucun inventaire.' });
      if (!admin) {
        return el('div', { classe: 'inv-fiche-detail' },
          el('dl', { classe: 'reponses' }, ...[['Catégorie', f.categorie], ['Réf. interne', f.refInterne], ['Réf. fournisseur', f.refFournisseur],
            ['Dotation hors stock', f.horsStock ? 'Oui' : 'Non'], ['Consommable', f.consommable ? 'Oui' : 'Non'], ['Périssable', f.perissable ? 'Oui' : 'Non'],
            ...(f.categorie === 'Documents' ? [['Secrétariat', f.secretariat ? 'Oui' : 'Non']] : [])]
            .map(([k, v]) => el('div', { classe: 'reponse' }, el('dt', { texte: k }), el('dd', { texte: v || '—' })))), lieux);
      }
      const archiver = f.archive
        ? el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Réactiver', surclick: () => { enregistrerFiche({ ...f, archive: false }); avis = `« ${f.denomination} » réactivé.`; rendre({ garderPosition: true }); } })
        : (ou.length ? null : el('button', { type: 'button', classe: 'cfg-bouton danger', texte: 'Archiver', surclick: () => { enregistrerFiche({ ...f, archive: true }); baseOuverte = ''; avis = `« ${f.denomination} » archivé : il n'est plus proposé à l'ajout.`; rendre({ garderPosition: true }); } }));
      return el('div', { classe: 'inv-fiche-detail' },
        formulaireFiche(f, {
          surEnregistrer: (g) => {
            enregistrerFicheEtInventaires(g);
            baseOuverte = '';
            avis = `Fiche « ${g.denomination} » enregistrée.`;
            rendre({ garderPosition: true });
          },
          surAnnuler: fermer,
          actions: [archiver, f.archive ? null : el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Fusionner avec un autre article…', title: 'Cet article est un doublon : le remplacer par un autre dans les inventaires',
            surclick: () => { fusion = { source: f.id, cible: '', texte: f.denomination }; baseOuverte = ''; rendre({ garderPosition: true }); } })],
        }),
        lieux, ou.length && !f.archive ? el('p', { classe: 'aide-question', texte: 'Pour l\'archiver, retirez-le d\'abord de ces inventaires.' }) : null);
    };
    function remplir() {
      liste.innerHTML = '';
      const trouvees = chercherFiches(baseFiltre.texte, { archives: baseFiltre.archives, categorie: baseFiltre.categorie })
        .filter((f) => !baseFiltre.sansPhoto || !f.photo);
      const pas = enTableau ? 300 : 60;
      const cle = [baseFiltre.texte, baseFiltre.categorie, baseFiltre.archives, baseFiltre.sansPhoto, enTableau].join('|');
      if (cle !== baseCleAffichage || baseNbAffiches < pas) { baseCleAffichage = cle; baseNbAffiches = pas; }
      const max = baseNbAffiches;
      const affichees = trouvees.slice(0, max);
      compte.textContent = trouvees.length ? `${pluriel(trouvees.length, 'article')}${trouvees.length > max ? ` — ${max} affichés` : ''}` : 'Aucun article ne correspond.';
      suite.innerHTML = '';
      if (trouvees.length > max) {
        const reste = trouvees.length - max;
        suite.append(el('button', { type: 'button', classe: 'cfg-bouton inv-suite-bouton',
          texte: `Afficher la suite (${reste > pas ? pas : reste} sur ${reste} restants)`,
          surclick: () => { baseNbAffiches += pas; remplir(); } }));
      }
      if (enTableau) {
        liste.hidden = true;
        tableau.innerHTML = '';
        if (affichees.length) tableau.append(tableauBase(affichees, usages, remplir));
        return;
      }
      affichees.forEach((f) => {
        const ouvert = baseOuverte === f.id;
        const nb = (usages[f.id] || []).length;
        const li = el('li', { classe: `inv-base-article${f.archive ? ' archive' : ''}${ouvert ? ' ouvert' : ''}` },
          el('button', { type: 'button', classe: 'inv-resultat inv-resultat-photo', 'aria-expanded': String(ouvert), surclick: () => { baseOuverte = ouvert ? '' : f.id; remplir(); } },
            el('span', { classe: 'inv-miniature' }, miniatureFiche(f.photo)),
            el('span', { classe: 'inv-resultat-texte' },
              el('strong', { texte: f.denomination }),
              el('small', { texte: `${resumeFiche(f)}${nb ? ` · ${pluriel(nb, 'inventaire')}` : ''}` }))));
        if (ouvert) li.append(detail(f));
        liste.append(li);
      });
    }
    const champ = idChamp();
    const filtres = el('div', { classe: 'puces inv-filtres', role: 'radiogroup', 'aria-label': 'Catégorie' });
    ['', ...CATEGORIES].forEach((cat) => {
      const i = idChamp();
      filtres.append(el('input', { type: 'radio', name: 'inv-filtre-cat', id: i, checked: baseFiltre.categorie === cat, surchange: () => { baseFiltre.categorie = cat; rendre({ garderPosition: true }); } }),
        el('label', { for: i, texte: cat || 'Toutes' }));
    });
    const caseArchives = idChamp();
    const caseSansPhoto = idChamp();
    remplir();
    if (baseOuverte === 'nouvelle') {
      nouvelle.append(formulaireFiche({ id: nouvelId(), denomination: baseFiltre.texte.trim(), categorie: baseFiltre.categorie, horsStock: false, refInterne: '', refFournisseur: '', consommable: true, perissable: baseFiltre.categorie === 'Médicament', archive: false, secretariat: false }, {
        titre: 'Nouvel article',
        surEnregistrer: (f) => { enregistrerFiche(f); baseOuverte = ''; avis = `« ${f.denomination} » ajouté à la base.`; rendre({ garderPosition: true }); },
        surAnnuler: () => { baseOuverte = ''; rendre({ garderPosition: true }); },
        utiliser: (f) => { baseOuverte = f.id; baseFiltre.texte = f.denomination; rendre({ garderPosition: true }); },
      }));
    }
    // Recherche toujours visible ; catégorie, archivés et « sans photo » repliés derrière « Filtres ».
    const nbFiltres = [baseFiltre.categorie, baseFiltre.archives, baseFiltre.sansPhoto].filter(Boolean).length;
    const panneauFiltres = el('div', { classe: 'inv-base-filtres', id: 'inv-base-filtres', hidden: !baseFiltresOuverts },
      el('span', { classe: 'inv-libelle', texte: 'Catégorie' }), filtres,
      el('label', { classe: 'cfg-case', for: caseArchives }, el('input', { type: 'checkbox', id: caseArchives, checked: baseFiltre.archives, surchange: (e) => { baseFiltre.archives = e.target.checked; rendre({ garderPosition: true }); } }), 'Afficher les articles archivés'),
      el('label', { classe: 'cfg-case', for: caseSansPhoto }, el('input', { type: 'checkbox', id: caseSansPhoto, checked: baseFiltre.sansPhoto, surchange: (e) => { baseFiltre.sansPhoto = e.target.checked; rendre({ garderPosition: true }); } }), 'Seulement les articles sans photo'),
      nbFiltres ? el('button', { type: 'button', classe: 'lien', texte: 'Effacer les filtres', surclick: () => { baseFiltre = { ...baseFiltre, categorie: '', archives: false, sansPhoto: false }; rendre({ garderPosition: true }); } }) : null);
    return [
      barreHaut({ titre: gestion ? 'Gestion des inventaires' : 'Inventaires', h1: false, bande: false, retour: () => aller('') }),
      el('div', { classe: 'inv-entete inv-entete-racine' }, el('h1', { tabindex: '-1', texte: 'Base des articles' }),
        admin && baseOuverte !== 'nouvelle' ? el('span', { classe: 'inv-entete-outils' },
          el('button', { type: 'button', classe: 'inv-loupe', 'aria-label': 'Photos en série', title: 'Photos en série : caméra ouverte, les articles défilent en bas, une photo après l\'autre', surclick: rafalePhotos }, iconeAppareil()),
          el('button', { type: 'button', classe: 'inv-loupe inv-plus-racine', 'aria-label': 'Nouvel article', title: 'Nouvel article', texte: '+', surclick: () => { baseOuverte = 'nouvelle'; rendre({ garderPosition: true, focus: '.inv-fiche input' }); } })) : null),
      ligneSynchro(), ligneAvis(),
      el('p', { classe: 'aide-question', texte: 'Chaque article est décrit ici une seule fois : une modification de fiche s\'applique à tous les inventaires qui l\'utilisent.' }),
      nouvelle,
      fusion && admin ? blocFusion(usages) : null,
      el('div', { classe: 'inv-base-recherche' },
        el('label', { for: champ, classe: 'invisible', texte: 'Rechercher (nom ou référence)' }),
        el('input', { id: champ, type: 'search', autocomplete: 'off', placeholder: 'Nom ou référence', valeur: baseFiltre.texte, surinput: (e) => { baseFiltre.texte = e.target.value; remplir(); } }),
        el('button', { type: 'button', classe: `cfg-bouton${baseFiltresOuverts || nbFiltres ? ' inv-actif' : ''}`, 'aria-expanded': String(baseFiltresOuverts), 'aria-controls': 'inv-base-filtres',
          texte: nbFiltres ? `Filtres (${nbFiltres})` : 'Filtres', surclick: () => { baseFiltresOuverts = !baseFiltresOuverts; rendre({ garderPosition: true }); } })),
      panneauFiltres,
      compte, liste, tableau, suite,
    ];
  }

  /**
   * Réglages d'une étiquette (taille, couleur, négatif, lignes libres, logo). `regler(champ, valeur)` est appelé à
   * chaque changement ; `format(l, h)` pour les formats courants (par défaut : regler largeur puis hauteur).
   */
  function controlesEtiquette(r0, regler, format) {
    const champMm = (champ, libelle) => el('label', {}, el('span', { texte: libelle }),
      el('input', { type: 'number', min: 15, max: 150, step: 1, valeur: r0[champ], inputmode: 'numeric', surchange: (e) => regler(champ, e.target.value) }));
    const formats = [[40, 40], [30, 30], [60, 30], [50, 25], [70, 35], [25, 50]];
    const largeur = champMm('largeur', 'Largeur (mm)'), hauteur = champMm('hauteur', 'Hauteur (mm)');
    let pastilles = [];
    const choisir = (coul) => {
      regler('couleur', coul);
      pastilles.forEach(([p, v]) => p.classList.toggle('choisie', v.toLowerCase() === coul.toLowerCase()));
    };
    pastilles = PALETTE_ETIQUETTE.map((coul) => [el('button', {
      type: 'button', classe: `inv-pastille${(r0.couleur || COULEUR_DEFAUT_ETIQUETTE).toLowerCase() === coul.toLowerCase() ? ' choisie' : ''}`,
      style: `background:${coul}`, title: coul, 'aria-label': `Couleur ${coul}`, surclick: () => choisir(coul) }), coul]);
    return el('div', { classe: 'inv-etiquette-reglages' },
      largeur, hauteur,
      el('div', { classe: 'inv-etiquette-couleurs' }, el('span', { texte: 'Couleur :' }), ...pastilles.map(([p]) => p),
        el('input', { type: 'color', valeur: r0.couleur || COULEUR_DEFAUT_ETIQUETTE, 'aria-label': 'Autre couleur', surchange: (e) => choisir(e.target.value) }),
        el('label', { classe: 'inv-negatif' }, el('input', { type: 'checkbox', checked: r0.negatif === true, surchange: (e) => regler('negatif', e.target.checked) }), el('span', { texte: 'Négatif' }))),
      el('label', {}, el('span', { texte: 'Ligne libre 1 (ex. nom)' }),
        el('input', { type: 'text', maxlength: 40, valeur: r0.champ1 || '', surchange: (e) => regler('champ1', e.target.value) })),
      el('label', {}, el('span', { texte: 'Ligne libre 2 (ex. téléphone)' }),
        el('input', { type: 'text', maxlength: 40, inputmode: 'tel', valeur: r0.champ2 || '', surchange: (e) => regler('champ2', e.target.value) })),
      el('label', {}, el('span', { texte: 'Logo' }),
        el('select', { surchange: (e) => regler('logo', e.target.value) },
          ...[['', 'Aucun'], ['nfc', 'Pictogramme NFC sur le côté (puce au dos)'], ['smur', 'Croix SMUR au centre']].map(([v, t]) => el('option', { value: v, selected: r0.logo === v, texte: t })))),
      el('div', { classe: 'inv-etiquette-formats' }, el('span', { texte: 'Formats courants :' }),
        ...formats.map(([l, h]) => el('button', { type: 'button', classe: 'cfg-mini', texte: `${l}×${h}`, surclick: () => {
          if (format) { format(l, h); return; }
          largeur.querySelector('input').value = l; hauteur.querySelector('input').value = h;
          regler('largeur', l); regler('hauteur', h);
        } }))));
  }

  /** Étiquette d'un objet hors inventaires (ex. référence de prêt) : { nom, url } et ses réglages. */
  const objetEtiquette = (o, reglage) => ({ id: '', nom: o.nom, url: o.url, etiquette: normEtiquette(reglage || {}) });

  /** Impression directe sur A4 portrait (marges 8 mm, espace 3 mm, traits de coupe) d'étiquettes d'objets. */
  function imprimerEtiquettesObjets(objets, reglage) {
    const o = { orientation: 'portrait', marge: 8, espace: 3, coupe: true, ...lireJson(CLE_IMPRESSION, {}) };
    const pages = rangerEtiquettes(objets.map((x) => objetEtiquette(x, reglage)), o);
    if (!pages.length) return;
    const [pw, ph] = A4[o.orientation] || A4.portrait;
    const regle = el('style', { id: 'imp-page-a4', texte: `@page { size: A4 ${o.orientation === 'paysage' ? 'landscape' : 'portrait'}; margin: 0; }` });
    document.head.append(regle);
    window.addEventListener('afterprint', () => regle.remove(), { once: true });
    lancerImpression(pages.map((p) => el('div', { classe: 'imp-page', style: `width:${pw}mm;height:${ph}mm` },
      ...p.etiquettes.map((e) => el('div', {
        classe: `imp-etiquette${o.coupe ? ' imp-coupe' : ''}`,
        style: `left:${o.marge + e.x}mm;top:${o.marge + e.y}mm;width:${e.w}mm;height:${e.h}mm;--demi-espace:${Math.min(o.espace / 2, 1.5)}mm`,
      }, etiquetteSvg(e.c, e.r))))), 'imp-etiquettes');
  }

  /** QR code, lien, puce NFC, copie et suppression (administrateurs). */
  function blocEtiquette(c) {
    const url = adresse(c.id);
    const etatNfc = el('p', { classe: 'message', role: 'status' });
    const nfc = 'NDEFReader' in window
      ? el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Écrire sur une puce NFC', surclick: () => ecrireNfc(url, etatNfc) })
      : el('p', { classe: 'aide-question', texte: 'Puce NFC : l\'écriture depuis l\'appli demande Chrome sur Android. Sinon, enregistrez ce lien sur la puce avec une appli NFC (type « URL »).' });
    // Étiquette : aperçu et réglages (taille imprimée, logo central), propres à ce contenant.
    const apercu = el('div', { classe: 'inv-etiquette-apercu' }, etiquetteSvg(c));
    const regler = (champ, valeur) => {
      c.etiquette = normEtiquette({ ...reglageEtiquette(c), [champ]: valeur });
      marquer(c.id);
      apercu.replaceChildren(etiquetteSvg(c));
    };
    const reglages = el('div', {}, controlesEtiquette(reglageEtiquette(c), regler, (l, h) => {
          c.etiquette = normEtiquette({ ...reglageEtiquette(c), largeur: l, hauteur: h });
          marquer(c.id); rendre({ garderPosition: true });
        }),
      c.modele ? el('p', { classe: 'aide-question', texte: 'Format répercuté sur les exemplaires avec les autres modifications de l\'inventaire type.' }) : null);
    return el('section', { classe: 'inv-groupe-reglages' }, el('h2', { texte: 'Étiquette QR et puce NFC' }),
      el('p', { classe: 'aide-question', texte: 'Le QR code et la puce NFC ouvrent directement ce contenant. Ils restent valables s\'il est renommé.' }),
      el('div', { classe: 'inv-acces' }, apercu,
        el('div', { classe: 'inv-acces-actions' },
          el('div', { classe: 'cfg-actions' },
            el('button', { type: 'button', classe: 'cfg-bouton inv-actif', texte: 'Imprimer l\'étiquette QR…', surclick: () => imprimerEtiquettes([c]) }),
            el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Aperçu taille réelle', surclick: () => apercuTailleReelle(c) })),
          nfc, etatNfc, CibleNfc.lien(),
          el('details', { classe: 'inv-details-reglages' }, el('summary', { texte: 'Format, couleur et texte de l\'étiquette' }), reglages),
          el('p', { classe: 'inv-url', texte: url }))));
  }
  /** Actions sur le contenant (onglet Réglages) : dupliquer, liste papier, supprimer. */
  function blocActions(c) {
    const supprimer = el('button', {
      type: 'button', classe: 'cfg-bouton danger', texte: c.emplacement ? 'Supprimer cet emplacement' : 'Supprimer ce contenant',
      surclick: () => {
        const tout = descendants(c.id);
        if (confirmer !== `supprimer-${c.id}`) {
          confirmer = `supprimer-${c.id}`;
          supprimer.textContent = tout.length > 1 ? `Confirmer : supprimer avec ses ${tout.length - 1} sous-inventaires` : 'Confirmer la suppression';
          return;
        }
        const parent = contenant(c.parent);
        if (parent) { retirerCible(parent, c.id); marquer(parent.id); }
        tout.forEach((x) => { x.supprime = true; marquer(x.id); });
        avis = `« ${c.nom} » supprimé.`;
        aller(c.parent);
      },
    });
    return el('section', { classe: 'inv-groupe-reglages' }, el('h2', { texte: 'Actions' }),
      el('div', { classe: 'cfg-actions' },
        c.emplacement ? null : el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Dupliquer (avec son contenu)', surclick: () => dupliquer(c) }),
        c.emplacement ? null : el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Imprimer la liste papier', surclick: () => imprimerListe(c) }),
        c.emplacement ? null : el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Exporter en Word', surclick: (e) => exporterWord(c, e.currentTarget) })),
      el('div', { classe: 'inv-zone-danger' }, supprimer));
  }

  // ---------- Inventaires types (modèles) et exemplaires ----------
  /*
   * Un inventaire type (`modele: true`) sert de structure à ses exemplaires (ex. les 7 sacs d'intervention).
   * Chaque contenant d'un exemplaire garde `source` (le contenant du modèle qu'il copie) et `base`
   * (l'état du modèle lors de la dernière répercussion). Répercuter compare, champ par champ :
   *   - l'exemplaire n'a pas été modifié depuis (égal à `base`) : il prend la nouvelle valeur du modèle ;
   *   - il a été modifié localement : on garde sa valeur (personnalisation propre à ce sac).
   * Les articles sont comparés un par un (même identifiant dans le modèle et ses exemplaires),
   * les sous-inventaires aussi (ajoutés, retirés, modifiés).
   */
  const dansUnModele = (id) => chemin(id).some((x) => x.modele);
  const racineModele = (id) => chemin(id).find((x) => x.modele) || null;
  /** Racines des exemplaires d'un modèle (contenants dont la source est la racine du modèle). */
  const exemplairesDe = (idModele) => Object.values(structure.contenants).filter((x) => !x.supprime && x.source === idModele);
  /**
   * Exemplaires réels (hors inventaires types) d'un type, y compris ceux atteints via un autre type qui le contient :
   * « Pochette pansement » rangée dans « Tiroir 4 type » et dans « Sac rouge type » compte aussi les tiroirs 4 de F25 et F26
   * et les 7 sacs rouges. Un exemplaire direct qui n'est dans aucun type compte pour lui-même.
   */
  function exemplairesReels(idModele) {
    const vus = new Set();
    const reels = (e, profondeur) => {
      if (!dansUnModele(e.id)) return [e];
      if (profondeur > 10) return [];
      const hote = racineModele(e.id);
      return exemplairesDe(hote.id).flatMap((r) => descendants(r.id).filter((d) => d.source === e.id && !d.supprime))
        .flatMap((d) => reels(d, profondeur + 1));
    };
    return exemplairesDe(idModele).flatMap((e) => reels(e, 0)).filter((x) => !vus.has(x.id) && vus.add(x.id));
  }
  /** Racine de l'exemplaire auquel appartient ce contenant (null s'il n'en fait pas partie). */
  function racineExemplaire(id) {
    const ch = chemin(id);
    for (let i = ch.length - 1; i >= 0; i--) {
      const src = contenant(ch[i].source);
      if (src && src.modele) return ch[i];
    }
    return null;
  }
  const egal = (a, b) => canonique(a === undefined ? null : a) === canonique(b === undefined ? null : b);
  const copieProfonde = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  /** Article réduit à ce qui se répercute (le nom des articles de la base vient de la fiche). */
  const sigArticle = (a) => (a.separateur ? { separateur: true, nom: a.nom, photo: a.photo === true || undefined }
    : a.controle ? { controle: a.controle, nom: a.nom, min: a.min, max: a.max, unite: a.unite, echelle: a.echelle, seuil: a.seuil, attendu: a.attendu, mode: a.mode, choix: a.choix, qr: a.qr, nfc: a.nfc, typeMateriel: a.typeMateriel, facultatif: a.facultatif === true || undefined, commentaire: a.commentaire || undefined }
      : { ref: a.ref || '', nom: a.ref ? '' : a.nom, quantite: String(a.quantite || ''), quantiteMin: a.quantiteMin === true || undefined, facultatif: a.facultatif === true || undefined, commentaire: a.commentaire || undefined });
  /** Gommette réduite à ce qui se répercute : position, texte et taille éventuels. */
  const sigPoint = (p) => ({ cible: p.cible, x: p.x, y: p.y, ...(typeof p.texte === 'string' ? { texte: p.texte } : {}), ...(iconeValide(p.icone) ? { icone: p.icone } : {}), ...(Number(p.taille) > 0 && Number(p.taille) !== 1 ? { taille: Number(p.taille) } : {}) });
  /** Instantané d'un contenant du modèle : ce que ses exemplaires doivent reproduire. */
  function instantane(m) {
    return {
      nom: m.nom, ordre: m.ordre, photo: m.photo, vignette: m.vignette || '', scellable: m.scellable, categorie: m.categorie, etiquette: m.etiquette,
      clAmbulancier: m.clAmbulancier, clElements: m.clElements, emplacement: m.emplacement,
      points: [...m.points.map(sigPoint), ...(m.fleches || []).map(sigFleche)],
      nomVue: m.nomVue, immersif: m.immersif || undefined,
      vues: m.vues.map((v) => ({ id: v.id, nom: v.nom, photo: v.photo, ...(v.immersif ? { immersif: v.immersif } : {}), points: [...v.points.map(sigPoint), ...(v.fleches || []).map(sigFleche)] })),
      articles: m.articles.map((a) => ({ id: a.id, ...sigArticle(a), ...(a.ref ? { refNom: a.nom } : {}) })),
      enfants: enfants(m.id).map((x) => x.id),
    };
  }
  /** Le même instantané, vu depuis un contenant d'exemplaire (identifiants traduits vers ceux du modèle). */
  function vueExemplaire(e) {
    const versModele = (id) => (contenant(id) || {}).source || id;
    return {
      nom: e.nom, ordre: e.ordre, photo: e.photo, vignette: e.vignette || '', scellable: e.scellable, categorie: e.categorie, etiquette: e.etiquette,
      clAmbulancier: e.clAmbulancier, clElements: e.clElements, emplacement: e.emplacement,
      points: [...e.points.map((p) => sigPoint({ ...p, cible: versModele(p.cible) })), ...(e.fleches || []).map(sigFleche)],
      nomVue: e.nomVue, immersif: e.immersif || undefined,
      vues: e.vues.map((v) => ({ id: v.id, nom: v.nom, photo: v.photo, ...(v.immersif ? { immersif: v.immersif } : {}), points: [...v.points.map((p) => sigPoint({ ...p, cible: versModele(p.cible) })), ...(v.fleches || []).map(sigFleche)] })),
      articles: e.articles.map((a) => ({ id: a.id, ...sigArticle(a) })),
      enfants: enfants(e.id).filter((x) => !(contenant(x.source) || {}).modele).map((x) => x.source).filter(Boolean),
    };
  }
  const sansNoms = (articles) => (articles || []).map(({ refNom, ...a }) => a);
  const CHAMPS_LIBELLES = { nom: 'nom', ordre: 'place', photo: 'photo', vignette: 'vignette', nomVue: 'nom de la vue', immersif: 'vue immersive', vues: 'vues', scellable: 'scellable', categorie: 'catégorie', etiquette: 'format d\'étiquette', clAmbulancier: 'check-list ambulancier', clElements: 'éléments vérifiés par l\'ambulancier', points: 'points sur la photo', articles: 'articles', enfants: 'sous-inventaires' };
  /**
   * Check-list ambulancier (véhicule relié, éléments vérifiés) : réglage propre à chaque véhicule (F21, F22…).
   * Tant que le type n'en définit pas (ni maintenant, ni à la dernière répercussion), ce que l'exemplaire a réglé
   * lui appartient : ce n'est ni une personnalisation à signaler ni un conflit à proposer d'écraser.
   */
  const clPropreAuVehicule = (k, courant, base) => (k === 'clAmbulancier' ? !courant.clAmbulancier && !base.clAmbulancier
    : k === 'clElements' ? !(courant.clElements || []).length && !(base.clElements || []).length : false);
  /** Champs d'un contenant d'exemplaire modifiés localement depuis la dernière répercussion. */
  function personnalisations(e) {
    if (!e.base) return [];
    const v = vueExemplaire(e);
    const racine = !contenant(e.parent) || !contenant(e.parent).source;
    return Object.keys(CHAMPS_LIBELLES).filter((k) => !(racine && (k === 'nom' || k === 'ordre')))
      .filter((k) => !(k === 'etiquette' && !v.etiquette))
      .filter((k) => !clPropreAuVehicule(k, contenant(e.source) || {}, e.base))
      // Base antérieure à la répercussion des vignettes : sans vignette propre, le contenant suit le type.
      .filter((k) => !(k === 'vignette' && e.base.vignette === undefined && !v.vignette))
      .filter((k) => !egal(k === 'articles' ? v.articles : v[k], k === 'articles' ? sansNoms(e.base.articles) : e.base[k]));
  }
  const estPersonnalise = (e) => personnalisations(e).length > 0;
  const toutPersonnalise = (e) => estPersonnalise(e) || enfants(e.id).some(toutPersonnalise);

  /** Ce qu'un contenant d'exemplaire a de propre, en phrases lisibles (comparé à sa dernière répercussion). */
  function differencesLisibles(e) {
    const b = e.base;
    if (!b) return [];
    const v = vueExemplaire(e);
    const lignes = [];
    const oui = (x) => (x ? 'oui' : 'non');
    const nomBase = (a) => (a.separateur ? nomSeparation(a) : (fiche(a) ? fiche(a).denomination : (a.refNom || a.nom || 'article')));
    const nomLocal = (a) => (a.separateur ? nomSeparation(a) : nomArticle(a));
    personnalisations(e).forEach((k) => {
      if (k === 'nom') lignes.push(`Nom : « ${b.nom} » → « ${e.nom} »`);
      else if (k === 'ordre') lignes.push('Place changée parmi les sous-inventaires');
      else if (k === 'photo') lignes.push(!e.photo ? 'Photo retirée' : (!b.photo ? 'Photo ajoutée' : 'Photo remplacée'));
      else if (k === 'vignette') lignes.push(!e.vignette ? 'Vignette retirée' : (!b.vignette ? 'Vignette propre' : 'Vignette remplacée'));
      else if (k === 'nomVue') lignes.push(`Nom de la vue : « ${b.nomVue || '—'} » → « ${e.nomVue || '—'} »`);
      else if (k === 'vues') lignes.push(`Vues supplémentaires modifiées (${pluriel((b.vues || []).length, 'vue')} dans le type, ${(v.vues || []).length} ici)`);
      else if (k === 'scellable') lignes.push(`Scellable : ${oui(b.scellable)} → ${oui(e.scellable)}`);
      else if (k === 'categorie') lignes.push(`Catégorie : ${b.categorie || '—'} → ${e.categorie || '—'}`);
      else if (k === 'etiquette') lignes.push('Format d\'étiquette QR propre');
      else if (k === 'points') lignes.push('Gommettes de la photo déplacées, ajoutées ou retirées');
      else if (k === 'enfants') {
        enfants(e.id).filter((x) => !(contenant(x.source) || {}).modele && (!x.source || !(b.enfants || []).includes(x.source)))
          .forEach((x) => lignes.push(`Sous-inventaire ajouté : ${x.nom}`));
        (b.enfants || []).filter((id) => !v.enfants.includes(id))
          .forEach((id) => lignes.push(`Sous-inventaire retiré : ${(contenant(id) || {}).nom || 'contenant supprimé du type'}`));
      } else if (k === 'articles') {
        const B = Object.fromEntries((b.articles || []).map((a) => [a.id, a]));
        const I = Object.fromEntries(e.articles.map((a) => [a.id, a]));
        e.articles.filter((a) => !B[a.id]).forEach((a) => {
          lignes.push(`Ajouté : ${nomLocal(a)}${!a.separateur && a.quantite ? ` × ${a.quantite}` : ''}`);
        });
        (b.articles || []).filter((a) => !I[a.id]).forEach((a) => lignes.push(`Retiré : ${nomBase(a)}`));
        e.articles.filter((a) => B[a.id]).forEach((a) => {
          const sa = sigArticle(a); const sb = sigArticle(B[a.id]);
          if (egal(sa, sb)) return;
          const d = [];
          if (a.separateur) d.push(`nom « ${sb.nom} » → « ${sa.nom} »`);
          else if (sa.controle || sb.controle) {
            if (sa.nom !== sb.nom) d.push(`nom « ${sb.nom} » → « ${sa.nom} »`);
            if (['controle', 'min', 'max', 'unite', 'echelle', 'seuil', 'attendu', 'mode', 'choix', 'qr', 'nfc', 'typeMateriel'].some((c) => !egal(sa[c], sb[c]))) d.push('réglages du contrôle');
          } else {
            if (sa.ref !== sb.ref || sa.nom !== sb.nom) d.push(`était « ${nomBase(B[a.id])} »`);
            if (sa.quantite !== sb.quantite) d.push(`quantité ${sb.quantite || '—'} → ${sa.quantite || '—'}`);
            if (!egal(sa.quantiteMin, sb.quantiteMin)) d.push(sa.quantiteMin ? 'quantité devenue minimale' : 'quantité devenue exacte');
          }
          if (!egal(sa.facultatif, sb.facultatif)) d.push(sa.facultatif ? 'devenu facultatif' : 'devenu obligatoire');
          if (!egal(sa.commentaire, sb.commentaire)) d.push(sa.commentaire ? `commentaire « ${sa.commentaire} »` : 'commentaire retiré');
          lignes.push(`Modifié : ${nomLocal(a)} (${d.join(', ') || 'détail modifié'})`);
        });
        const communs = (l) => l.map((a) => a.id).filter((id) => B[id] && I[id]);
        if (!egal(communs(e.articles), communs(b.articles || []))) lignes.push('Ordre des articles changé');
      }
    });
    return lignes;
  }

  /** Panneau détaillant, contenant par contenant, ce qu'un exemplaire a de propre par rapport à l'inventaire type. */
  function panneauDifferences(e) {
    const debut = chemin(e.id).length;
    const blocs = descendants(e.id).map((x) => ({ x, lignes: differencesLisibles(x) })).filter((d) => d.lignes.length);
    const enRetard = descendants(e.id).some((x) => {
      const src = contenant(x.source);
      return src && x.base && !egal(sansNoms(instantane(src).articles), sansNoms(x.base.articles));
    });
    return el('div', { classe: 'inv-diff' },
      blocs.length ? null : el('p', { texte: 'Aucune différence propre à cet exemplaire.' }),
      ...blocs.map(({ x, lignes }) => el('div', { classe: 'inv-diff-bloc' },
        el('a', { href: lien(x.id), classe: 'inv-diff-titre', texte: x.id === e.id ? e.nom : chemin(x.id).slice(debut).map((y) => y.nom).join(' › ') }),
        el('ul', {}, ...lignes.map((l) => el('li', { texte: l }))))),
      enRetard ? el('p', { classe: 'aide-question', texte: 'Le type a aussi évolué depuis la dernière répercussion : ces nouveautés arriveront en appuyant sur « Répercuter ».' }) : null,
      blocs.length ? el('p', { classe: 'aide-question', texte: 'Ces différences sont conservées lors d\'une répercussion. Pour en annuler une, ouvrez le contenant puis « Revenir au modèle ».' }) : null);
  }

  /** Copie d'un contenant du modèle (et de tout ce qu'il contient) dans un exemplaire. */
  function copierDepuisModele(m, parent, ordre) {
    const copie = normaliser({ ...copieProfonde(m), id: nouvelId(), parent, ordre, source: m.id, base: instantane(m) });
    delete copie.modele;
    delete copie.destinataires; // la destination appartient au type, pas à ses exemplaires
    structure.contenants[copie.id] = copie;
    const fils = enfants(m.id).map((f) => copierDepuisModele(f, copie.id, f.ordre));
    traduireCibles(copie, (cible) => (fils.find((x) => x.source === cible) || {}).id);
    marquer(copie.id);
    return copie;
  }

  /** Fusion des articles : modèle (nouveau), base (ancien modèle), exemplaire. Renvoie [articles, nb conservés]. */
  function fusionnerArticles(e, base, m, forcer, decider = () => false) {
    const parId = (l) => Object.fromEntries((l || []).map((a) => [a.id, a]));
    const I = parId(e.articles); const B = parId(base); const M = parId(m.articles);
    let conserves = 0;
    const idsI = e.articles.map((a) => a.id);
    const ordreInchange = egal(idsI, (base || []).map((a) => a.id));
    const nomA = (a) => (a.separateur ? nomSeparation(a) : nomArticle(a));
    const communs = (l) => l.map((a) => a.id).filter((id) => I[id] && M[id]);
    const ordreConflit = !forcer && !ordreInchange && !egal(communs(e.articles), communs(m.articles));
    const ordreModele = forcer || ordreInchange || (ordreConflit && decider(e, 'ordre-articles', 'Ordre des articles changé dans ce contenant'));
    const ordre = ordreModele
      ? [...m.articles.map((a) => a.id), ...idsI.filter((id) => !M[id])]
      : [...idsI, ...m.articles.map((a) => a.id).filter((id) => !I[id] && !B[id])];
    if (ordreConflit && !ordreModele) conserves += 1;
    const resultat = [];
    ordre.forEach((id) => {
      const i = I[id]; const b = B[id]; const mm = M[id];
      const depuisModele = () => { const a = copieProfonde(mm); return a; };
      if (i && mm) {
        const conflit = !forcer && !(b && egal(sigArticle(i), sigArticle(b))) && !egal(sigArticle(i), sigArticle(mm));
        if (forcer || (b && egal(sigArticle(i), sigArticle(b))) || (conflit && decider(e, `article:${id}`, `Article modifié ici : ${nomA(i)}`))) {
          const a = mm.controle || i.controle ? depuisModele() : { ...i, ...depuisModele() };
          if (!mm.facultatif) delete a.facultatif; // redevenu obligatoire dans le modèle
          if (!mm.quantiteMin) delete a.quantiteMin; // redevenue exacte dans le modèle
          if (!mm.commentaire) delete a.commentaire; // commentaire retiré du modèle
          resultat.push(a);
        }
        else { resultat.push(i); if (!egal(sigArticle(i), sigArticle(mm))) conserves += 1; }
      } else if (i && !mm) {
        if (b && (forcer || egal(sigArticle(i), sigArticle(b)))) return; // retiré du modèle
        if (b && decider(e, `article:${id}`, `Retiré du type mais modifié ici : ${nomA(i)}`)) return;
        if (forcer && !b) return; // ajouté localement : « Revenir au modèle » le retire
        resultat.push(i);
        if (b) conserves += 1;
      } else if (!i && mm) {
        if (!b || forcer) resultat.push(depuisModele()); // nouveau dans le modèle
        else if (decider(e, `article:${id}`, `Retiré de ce contenant : ${nomA(mm)}`)) resultat.push(depuisModele());
        else conserves += 1; // retiré localement : conservé si l'utilisateur le décide
      }
    });
    return [resultat, conserves];
  }

  /**
   * Répercute le contenant `m` du modèle sur le contenant `e` de l'exemplaire, et récursivement.
   * `forcer` : « Revenir au modèle » (ce contenant seulement : ses sous-inventaires gardent leurs personnalisations).
   * Renvoie { modifies, conserves }.
   */
  const LIBELLES_CONFLIT = { nom: 'Nom', ordre: 'Place parmi les sous-inventaires', photo: 'Photo', vignette: 'Vignette', nomVue: 'Nom de la vue', immersif: 'Vue immersive (panorama)', scellable: 'Scellable', categorie: 'Catégorie', etiquette: 'Format d\'étiquette QR', clAmbulancier: 'Check-list ambulancier', clElements: 'Éléments vérifiés par l\'ambulancier', emplacement: 'Modèles acceptés / condition de l\'emplacement' };
  function repercuter(e, m, forcer = false, racine = false, decider = () => false) {
    const bilanR = { modifies: 0, conserves: 0 };
    const base = e.base || instantane(m); // exemplaire ancien sans base : tout est considéré comme non modifié
    const v = vueExemplaire(e);
    const nm = instantane(m);
    const avant = canonique(e);
    ['nom', 'ordre', 'photo', 'vignette', 'nomVue', 'immersif', 'scellable', 'categorie', 'etiquette', 'clAmbulancier', 'clElements', 'emplacement'].forEach((k) => {
      if (racine && (k === 'nom' || k === 'ordre')) return; // le sac garde son nom et sa place
      if (!forcer && clPropreAuVehicule(k, m, base)) return; // check-list ambulancier : réglage du véhicule, conservé tel quel
      // Étiquette : un exemplaire sans format propre suit toujours le modèle (formats effacés par un ancien serveur).
      // Vignette : avant sa répercussion, la base n'en gardait pas ; sans vignette propre, l'exemplaire suit le type.
      // Emplacement (modèles acceptés, condition) : la base ne le gardait pas avant ; l'exemplaire suit alors le type.
      const suit = (k === 'etiquette' && !v.etiquette) || (k === 'vignette' && base.vignette === undefined && !v.vignette)
        || (k === 'emplacement' && !('emplacement' in base));
      if (k === 'emplacement' && !m.emplacement && !e.emplacement) return;
      if (forcer || suit || egal(v[k], base[k])) e[k] = k === 'vignette' ? (m.vignette || '') : copieProfonde(m[k]);
      else if (!egal(v[k], nm[k])) {
        const val = (x) => (k === 'emplacement' ? (x ? `${modelesEmplacement({ emplacement: x }).map((id) => (contenant(id) || {}).nom || '?').join(', ')}${x.si ? ' (conditionnel)' : ''}` : '—') : k === 'photo' ? (x ? 'photo' : 'aucune') : k === 'scellable' ? (x ? 'oui' : 'non') : k === 'etiquette' ? (x ? `${x.largeur}×${x.hauteur} mm` : '—') : (x === undefined || x === '' ? '—' : String(x)));
        const libelle = k === 'photo' ? (e[k] ? (m[k] ? 'Photo remplacée ici' : 'Photo ajoutée ici') : 'Photo retirée ici')
          : k === 'vignette' ? (e[k] ? (m[k] ? 'Vignette différente ici' : 'Vignette propre ici (aucune dans le type)') : 'Vignette retirée ici')
          : `${LIBELLES_CONFLIT[k]} : « ${val(e[k])} » ici, « ${val(m[k])} » dans le type`;
        if (decider(e, k, libelle)) e[k] = copieProfonde(m[k]); else bilanR.conserves += 1;
      }
    });
    // Sous-inventaires
    enfants(m.id).forEach((mf) => {
      const ef = enfants(e.id).find((x) => x.source === mf.id);
      if (ef) {
        const r = repercuter(ef, mf, false, false, decider);
        bilanR.modifies += r.modifies; bilanR.conserves += r.conserves;
      } else if (forcer || !base.enfants.includes(mf.id)) {
        copierDepuisModele(mf, e.id, mf.ordre);
        bilanR.modifies += 1;
      } else if (decider(e, `enfant:${mf.id}`, `Sous-inventaire retiré ici : ${mf.nom}`)) {
        copierDepuisModele(mf, e.id, mf.ordre);
        bilanR.modifies += 1;
      } else bilanR.conserves += 1; // retiré de ce sac : conservé si l'utilisateur le décide
    });
    enfants(e.id).forEach((ef) => {
      if (!ef.source || nm.enfants.includes(ef.source)) return;
      if (base.enfants.includes(ef.source) && (forcer || !toutPersonnalise(ef))) {
        descendants(ef.id).forEach((x) => { x.supprime = true; marquer(x.id); });
        retirerCible(e, ef.id);
        bilanR.modifies += 1;
      } else if (base.enfants.includes(ef.source) && decider(e, `enfant:${ef.source}`, `Sous-inventaire retiré du type mais modifié ici : ${ef.nom} (il sera supprimé)`)) {
        descendants(ef.id).forEach((x) => { x.supprime = true; marquer(x.id); });
        retirerCible(e, ef.id);
        bilanR.modifies += 1;
      } else if (base.enfants.includes(ef.source)) bilanR.conserves += 1;
    });
    // Points : traduits vers les sous-inventaires de cet exemplaire
    const versExemplaire = (cible) => (enfants(e.id).find((x) => x.source === cible) || {}).id;
    const pointsConflit = !forcer && !egal(vueExemplaire(e).points, base.points) && !egal(vueExemplaire(e).points, nm.points);
    if (forcer || egal(vueExemplaire(e).points, base.points) || (pointsConflit && decider(e, 'points', 'Gommettes de la photo (position ou texte) modifiées ici'))) {
      e.points = m.points.map((p) => { const id = versExemplaire(p.cible); return id ? { ...p, cible: id } : null; }).filter(Boolean);
      e.fleches = copieProfonde(m.fleches || []);
    } else if (pointsConflit) bilanR.conserves += 1;
    // Vues supplémentaires : comme les points, l'ensemble suit le modèle tant que le sac ne les a pas modifiées.
    const vuesConflit = !forcer && !egal(vueExemplaire(e).vues, base.vues || []) && !egal(vueExemplaire(e).vues, nm.vues);
    if (forcer || egal(vueExemplaire(e).vues, base.vues || []) || (vuesConflit && decider(e, 'vues', 'Vues supplémentaires (photos, gommettes) modifiées ici'))) {
      e.vues = m.vues.map((v) => ({ ...copieProfonde(v), points: v.points.map((p) => { const id = versExemplaire(p.cible); return id ? { ...p, cible: id } : null; }).filter(Boolean) }));
    } else if (vuesConflit) bilanR.conserves += 1;
    // Articles
    const [articles, conserves] = fusionnerArticles(e, sansNoms(base.articles), m, forcer, decider);
    e.articles = articles;
    bilanR.conserves += conserves;
    e.base = nm;
    if (canonique(e) !== avant) { bilanR.modifies += 1; marquer(e.id); }
    return bilanR;
  }

  /** Crée `noms.length` exemplaires du modèle, au premier niveau. */
  function creerExemplaires(m, noms) {
    const fratrie = enfants('');
    let ordre = fratrie.length ? fratrie[fratrie.length - 1].ordre + 1 : 0;
    const crees = noms.map((nom) => {
      const e = copierDepuisModele(m, '', ordre++);
      e.nom = nom.slice(0, 80);
      delete e.modele;
      marquer(e.id);
      return e;
    });
    return crees;
  }

  /**
   * Répercussion en chaîne : répercute le type `m` sur les exemplaires `choisis`, puis, si ces exemplaires sont eux-mêmes
   * rangés dans un autre inventaire type (ex. « Pochette pansement » dans « Tiroir 4 type »), répercute ce type-là sur
   * tous ses exemplaires (ex. les tiroirs 4 de F25 et F26), et ainsi de suite jusqu'aux contenants réels.
   * `decider(x, cle, libelle, etape)` : voir `repercuter` ; `etape` = { racine, premiere }.
   * Renvoie { modifies, conserves, etapes: [{ type, exemplaires }] }.
   */
  function repercuterEnChaine(choisis, m, decider) {
    const bilanC = { modifies: 0, conserves: 0, etapes: [] };
    const vus = new Set([m.id]);
    const file = [{ modele: m.id, ids: choisis.map((x) => x.id), premiere: true }];
    for (let n = 0; file.length && n < 20; n++) {
      const { modele, ids, premiere } = file.shift();
      const mm = contenant(modele);
      if (!mm) continue;
      const racines = ids.map((id) => contenant(id)).filter(Boolean);
      racines.forEach((e) => {
        const r = repercuter(e, mm, false, true, (x, cle, libelle) => decider(x, cle, libelle, { racine: e, premiere }));
        bilanC.modifies += r.modifies; bilanC.conserves += r.conserves;
      });
      bilanC.etapes.push({ type: mm.nom, exemplaires: racines.map((x) => x.nom) });
      // Étape suivante : types qui contiennent ces exemplaires (chacun répercuté sur tous ses propres exemplaires).
      racines.forEach((e) => {
        const parent = racineModele(e.id);
        if (!parent || parent.id === e.id || vus.has(parent.id)) return;
        vus.add(parent.id);
        file.push({ modele: parent.id, ids: exemplairesDe(parent.id).map((x) => x.id), premiere: false });
      });
    }
    return bilanC;
  }

  /** Répercussion à blanc (en chaîne) sur les exemplaires choisis : liste des personnalisations en conflit avec le type. */
  function recenserConflits(choisis, m) {
    const sauve = JSON.stringify(structure.contenants);
    const conflits = [];
    simulation = true;
    try {
      repercuterEnChaine(choisis, m, (x, cle, libelle, etape) => {
        // Premier niveau : chemin depuis l'exemplaire ; niveaux suivants : chemin complet (véhicule › tiroir › …).
        const debut = etape.premiere ? chemin(etape.racine.id).length - 1 : 0;
        conflits.push({ cle: `${x.id}|${cle}`, exemplaire: etape.racine.nom, ou: chemin(x.id).slice(debut).map((y) => y.nom).join(' › '), libelle });
        return false;
      });
    } finally {
      simulation = false;
      structure.contenants = JSON.parse(sauve);
    }
    return conflits;
  }

  /** Fenêtre : pour chaque personnalisation en conflit, écraser (prendre le type) ou conserver. */
  function demanderConflits(conflits, appliquer) {
    const fond = el('div', { classe: 'fenetre-fond' });
    const retour = document.activeElement;
    const fermer = () => { fond.remove(); document.body.classList.remove('fenetre-ouverte'); if (retour && retour.isConnected) retour.focus(); };
    const titre = idChamp();
    const cases = conflits.map((c) => { const i = idChamp(); return { c, i, box: el('input', { type: 'checkbox', id: i, value: c.cle }) }; });
    const tout = (v) => cases.forEach((x) => { x.box.checked = v; });
    const parOu = new Map();
    cases.forEach((x) => { const k = x.c.ou; if (!parOu.has(k)) parOu.set(k, []); parOu.get(k).push(x); });
    fond.append(el('div', { classe: 'fenetre', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titre },
      el('div', { classe: 'fenetre-entete' }, el('h2', { id: titre, texte: 'Personnalisations rencontrées' }),
        el('button', { type: 'button', classe: 'fenetre-fermer', 'aria-label': 'Annuler', texte: '✕', surclick: fermer })),
      el('div', { classe: 'fenetre-corps' },
        el('p', { classe: 'aide-question', texte: 'Tout le reste du type (photos, gommettes, sous-inventaires, articles) sera répercuté. Cochez les personnalisations à écraser par le type ; celles non cochées sont conservées.' }),
        el('div', { classe: 'cfg-actions' },
          el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Tout écraser', surclick: () => tout(true) }),
          el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Tout conserver', surclick: () => tout(false) })),
        ...[...parOu.entries()].map(([ou, xs]) => el('div', { classe: 'inv-diff-bloc' },
          el('strong', { classe: 'inv-diff-titre', texte: ou }),
          ...xs.map((x) => el('label', { classe: 'cfg-case', for: x.i }, x.box, el('span', { texte: `Écraser — ${x.c.libelle}` }))))),
        el('div', { classe: 'cfg-actions' },
          el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Annuler', surclick: fermer }),
          el('button', { type: 'button', classe: 'cfg-bouton inv-actif', texte: 'Répercuter', surclick: () => {
            const ecraser = new Set(cases.filter((x) => x.box.checked).map((x) => x.c.cle));
            fermer();
            appliquer(ecraser);
          } })))));
    fond.addEventListener('keydown', (e) => { if (e.key === 'Escape') fermer(); });
    document.body.append(fond);
    document.body.classList.add('fenetre-ouverte');
    fond.querySelector('.fenetre-fermer').focus();
  }

  /** Vrai si l'inventaire type a évolué depuis la dernière répercussion sur au moins un de ses exemplaires. */
  function typeNonRepercute(m) {
    const cles = [...Object.keys(CHAMPS_LIBELLES), 'emplacement'];
    return exemplairesDe(m.id).some((r) => [r, ...descendants(r.id)].some((x) => {
      const src = contenant(x.source);
      if (!src || !x.base) return false;
      const nm = instantane(src);
      return cles.some((k) => {
        if (k === 'vignette' && x.base.vignette === undefined) return false; // base antérieure aux vignettes
        if (k === 'etiquette' && x.base.etiquette === undefined) return false;
        if (k === 'emplacement' && x.base.emplacement === undefined) return false;
        return !egal(k === 'articles' ? sansNoms(nm.articles) : nm[k], k === 'articles' ? sansNoms(x.base.articles) : x.base[k]);
      });
    }));
  }
  /** Bouton bien visible en tête d'un inventaire type modifié : mène à l'onglet Exemplaires pour répercuter. */
  function boutonRepercuter(c) {
    const m = racineModele(c.id);
    if (!m || !edition || ongletGestion === 'exemplaires' || !exemplairesDe(m.id).length || !typeNonRepercute(m)) return null;
    return el('div', { classe: 'inv-repercuter-bandeau' },
      el('button', { type: 'button', classe: 'cfg-bouton inv-actif inv-repercuter', title: 'Le type a changé : répercuter sur ses exemplaires', surclick: () => {
        if (c.id !== m.id) { ongletDemande = 'exemplaires'; aller(m.id); return; }
        ongletGestion = 'exemplaires';
        rendre({ garderPosition: true }); window.scrollTo(0, 0);
      } }, icone('M12 16V4', 'M7 9l5-5 5 5', 'M4 20h16'), el('span', { texte: 'Répercuter' })),
      el('span', { classe: 'inv-repercuter-aide', texte: 'Cet inventaire type a été modifié.' }));
  }

  /** Gestion : liste des types immobiles, filtrable par véhicule (contenant primaire) auquel ils sont destinés. */
  function filtreImmobiles(immobiles) {
    const primaires = primairesDestinataires();
    if (filtreVehicule && filtreVehicule !== '-' && !primaires.some((p) => p.id === filtreVehicule)) filtreVehicule = '';
    const garde = (t) => (!filtreVehicule ? true : filtreVehicule === '-' ? !nomsDestinataires(t).length : (t.destinataires || []).includes(filtreVehicule));
    const visibles = immobiles.filter(garde);
    const id = idChamp();
    const option = (valeur, texte) => el('option', { value: valeur, texte, selected: filtreVehicule === valeur });
    return el('div', {},
      el('div', { classe: 'champ inv-filtre-vehicule' }, el('label', { for: id, texte: 'Véhicule' }),
        el('select', { id, surchange: (e) => { filtreVehicule = e.target.value; rendre({ garderPosition: true }); } },
          option('', 'Tous les véhicules'), ...primaires.map((p) => option(p.id, p.nom)), option('-', 'Sans véhicule précisé'))),
      visibles.length ? listeTuiles(visibles) : el('p', { classe: 'aide-question', texte: 'Aucun inventaire type immobile pour ce véhicule.' }));
  }

  /** Contenants primaires (véhicules, réserve, locaux…) auxquels un inventaire type peut être destiné. */
  const primairesDestinataires = () => Object.values(structure.contenants)
    .filter((x) => !x.supprime && x.categorie === 'primaire' && !x.modele && !x.stock && !dansUnModele(x.id))
    .sort((a, b) => a.nom.localeCompare(b.nom, 'fr', { numeric: true }));
  /** Noms des contenants primaires encore existants auxquels ce type est destiné. */
  const nomsDestinataires = (m) => {
    const ids = new Set(m.destinataires || []);
    return primairesDestinataires().filter((p) => ids.has(p.id)).map((p) => p.nom);
  };

  /**
   * Gestion d'un inventaire type immobile : véhicules (contenants primaires) auxquels il est destiné. Sert de repère :
   * le « + » d'un véhicule propose d'abord les types prévus pour lui, et la liste ci-dessous montre où le type reste à ajouter.
   */
  function blocDestinataires(m, exemplaires) {
    const primaires = primairesDestinataires();
    const choisis = new Set(m.destinataires || []);
    const presents = new Set(exemplaires.map((e) => (primaireDe(e.id) || {}).id).filter(Boolean));
    const regler = (id, coche) => {
      const s = new Set(m.destinataires || []);
      if (coche) s.add(id); else s.delete(id);
      if (s.size) m.destinataires = [...s]; else delete m.destinataires;
      marquer(m.id);
      rendre({ garderPosition: true });
    };
    const manquants = primaires.filter((p) => choisis.has(p.id) && !presents.has(p.id)).length;
    return el('div', { classe: 'champ inv-destinataires' },
      el('span', { classe: 'inv-libelle', texte: 'Destiné aux véhicules' }),
      primaires.length ? el('div', { classe: 'inv-destinataires-liste' }, ...primaires.map((p) => {
        const i = idChamp();
        const prevu = choisis.has(p.id);
        const present = presents.has(p.id);
        return el('label', { classe: 'cfg-case', for: i },
          el('input', { type: 'checkbox', id: i, checked: prevu, surchange: (e) => regler(p.id, e.target.checked) }),
          el('span', {}, p.nom,
            prevu && present ? el('small', { classe: 'inv-attente', texte: ' — déjà ajouté' }) : null,
            prevu && !present ? el('small', { classe: 'inv-attente' }, ' — ', el('a', { href: lien(p.id), texte: 'à ajouter' })) : null,
            !prevu && present ? el('small', { classe: 'inv-attente', texte: ' — présent, non prévu' }) : null));
      })) : el('p', { classe: 'aide-question', texte: 'Aucun contenant primaire (véhicule) n\'existe pour l\'instant.' }),
      el('p', { classe: 'aide-question', texte: !choisis.size
        ? 'Aucun véhicule précisé : ce type est proposé partout. Cochez les véhicules qui doivent le contenir ; il sera alors proposé en premier dans leur « + ».'
        : (manquants ? `${pluriel(manquants, 'véhicule')} ${manquants > 1 ? 'n\'ont' : 'n\'a'} pas encore ce type : ouvrez-le (« à ajouter ») puis ajoutez le type depuis le « + » d'un de ses contenants.`
          : 'Tous les véhicules prévus contiennent ce type.') }));
  }

  const diffsOuvertes = new Set(); // exemplaires dont le détail « personnalisé » est déplié
  /** Bloc affiché en tête d'un inventaire type (racine ou sous-inventaire). */
  function blocModele(c) {
    const m = racineModele(c.id);
    if (!m) return null;
    const exemplaires = exemplairesDe(m.id);
    const indirects = exemplairesReels(m.id).filter((x) => !exemplaires.includes(x));
    const destines = m.categorie === 'immobile' ? nomsDestinataires(m) : [];
    if (!edition) {
      return el('p', { classe: 'note-parc inv-note-modele' }, el('strong', { texte: 'Inventaire type. ' }),
        `Il ne se vérifie pas : il sert de structure à ${pluriel(exemplairesReels(m.id).length, 'exemplaire')}. Modifiez-le puis répercutez les changements.`,
        destines.length ? ` Destiné à : ${destines.join(', ')}.` : '');
    }
    const resultat = el('p', { classe: 'message', role: 'status' });
    const liste = el('div', { classe: 'inv-exemplaires' });
    exemplaires.forEach((e) => {
      const i = idChamp();
      const perso = toutPersonnalise(e);
      const panneau = perso ? panneauDifferences(e) : null;
      if (panneau) { panneau.id = `${i}-diff`; panneau.hidden = !diffsOuvertes.has(e.id); }
      const bouton = perso ? el('button', { type: 'button', classe: 'lien inv-perso', 'aria-controls': `${i}-diff`, 'aria-expanded': String(!panneau.hidden),
        texte: `personnalisé ${panneau.hidden ? '▸' : '▾'}`, surclick: (ev) => {
          panneau.hidden = !panneau.hidden;
          if (panneau.hidden) diffsOuvertes.delete(e.id); else diffsOuvertes.add(e.id);
          ev.currentTarget.setAttribute('aria-expanded', String(!panneau.hidden));
          ev.currentTarget.textContent = `personnalisé ${panneau.hidden ? '▸' : '▾'}`;
        } }) : null;
      liste.append(el('div', { classe: 'inv-exemplaire' },
        el('label', { classe: 'cfg-case', for: i }, el('input', { type: 'checkbox', id: i, checked: true, value: e.id }),
          el('span', {}, el('a', { href: lien(e.id), texte: e.nom }),
            // Type immobile : un exemplaire n'a ni numéro ni identification, on le situe par son véhicule (contenant primaire).
            m.categorie === 'immobile' && chemin(e.id).length > 1 ? el('small', { classe: 'inv-attente', texte: ` — ${chemin(e.id)[0].nom}` }) : null)),
        bouton, panneau));
    });
    // Suppression d'exemplaires (douce, comme « Supprimer ce contenant » : restaurable). Le type n'est jamais touché.
    const boutonSupprimer = el('button', { type: 'button', classe: 'cfg-bouton danger', texte: 'Supprimer les exemplaires cochés', surclick: () => {
      const choisis = [...liste.querySelectorAll('input:checked')].map((x) => contenant(x.value)).filter(Boolean);
      if (!choisis.length) { resultat.textContent = 'Cochez au moins un exemplaire.'; return; }
      const cle = `supprimer-exemplaires-${choisis.map((x) => x.id).sort().join(',')}`;
      if (confirmer !== cle) {
        confirmer = cle;
        const nbSous = choisis.reduce((n, x) => n + descendants(x.id).length - 1, 0);
        boutonSupprimer.textContent = `Confirmer : supprimer ${pluriel(choisis.length, 'exemplaire')}${nbSous ? ` et ${pluriel(nbSous, 'sous-inventaire')}` : ''}`;
        return;
      }
      confirmer = '';
      choisis.forEach((e) => {
        const parent = contenant(e.parent);
        if (parent) { retirerCible(parent, e.id); marquer(parent.id); }
        descendants(e.id).forEach((x) => { x.supprime = true; marquer(x.id); });
      });
      avis = `${pluriel(choisis.length, 'exemplaire')} supprimé${choisis.length > 1 ? 's' : ''} (le type n'est pas modifié).`;
      rendre({ garderPosition: true });
    } });
    const boutonRepercuter = el('button', { type: 'button', classe: 'cfg-bouton inv-actif', texte: `Répercuter sur les exemplaires cochés`, surclick: () => {
      const choisis = [...liste.querySelectorAll('input:checked')].map((x) => contenant(x.value)).filter(Boolean);
      if (!choisis.length) { resultat.textContent = 'Cochez au moins un exemplaire.'; return; }
      // 1. Répercussion à blanc : recense les personnalisations qui entrent en conflit avec le type.
      const conflits = recenserConflits(choisis, m);
      const appliquer = (ecraser) => {
        // Objets relus : la répercussion à blanc a restauré la structure.
        const mm = contenant(m.id);
        const r = repercuterEnChaine(choisis.map((x) => contenant(x.id)).filter(Boolean), mm, (x, cle) => ecraser.has(`${x.id}|${cle}`));
        const { modifies, conserves } = r;
        const suite = r.etapes.slice(1);
        avis = `${pluriel(choisis.length, 'exemplaire')} mis à jour (${pluriel(modifies, 'contenant')} modifié${modifies > 1 ? 's' : ''})`
          + `${suite.length ? ` ; en chaîne : ${suite.map((e) => `${e.type} (${e.exemplaires.join(', ')})`).join(', puis ')}` : ''}`
          + `${ecraser.size ? ` ; ${pluriel(ecraser.size, 'personnalisation')} écrasée${ecraser.size > 1 ? 's' : ''}` : ''}`
          + `${conserves ? ` ; ${pluriel(conserves, 'personnalisation')} conservée${conserves > 1 ? 's' : ''}` : ''}.`;
        rendre({ garderPosition: true });
      };
      // 2. Sans conflit : tout part (photos, gommettes, sous-inventaires, articles). Sinon : on demande.
      if (!conflits.length) appliquer(new Set());
      else demanderConflits(conflits, appliquer);
    } });
    // Création d'exemplaires
    const champNb = idChamp();
    const nb = el('input', { id: champNb, type: 'number', min: '1', max: '30', valeur: '1', inputmode: 'numeric', classe: 'inv-court' });
    const creer = el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Créer', surclick: () => {
      const n = Math.min(30, Math.max(1, Math.round(Number(nb.value)) || 1));
      const depart = exemplaires.length;
      const crees = creerExemplaires(m, Array.from({ length: n }, (x, k) => (m.categorie === 'immobile' ? m.nom : `${m.nom} n°${depart + k + 1}`)));
      avis = `${pluriel(crees.length, 'exemplaire')} créé${crees.length > 1 ? 's' : ''} : renommez-les si besoin, puis imprimez leurs étiquettes QR.`;
      rendre({ garderPosition: true });
    } });
    return el('section', { classe: 'cfg-section inv-bloc-modele' },
      el('h2', { texte: 'Inventaire type' }),
      c.id !== m.id ? el('p', { classe: 'aide-question' }, 'Ce sous-inventaire fait partie de l\'inventaire type ', el('a', { href: lien(m.id), texte: m.nom }), '.') : null,
      el('p', { classe: 'aide-question', texte: 'Les modifications du type ne partent pas toutes seules : appuyez sur « Répercuter ». Tout est répercuté (photos, gommettes, sous-inventaires, articles) ; si un sac a une personnalisation contraire, on vous demande s\'il faut l\'écraser. Si le type est rangé dans un autre inventaire type (ex. une pochette dans un tiroir), la répercussion se poursuit en chaîne jusqu\'aux véhicules.' }),
      // Type immobile (racine) : véhicules auxquels il est destiné.
      m.categorie === 'immobile' && c.id === m.id ? blocDestinataires(m, exemplaires) : null,
      exemplaires.length ? liste : el('p', { texte: 'Aucun exemplaire pour l\'instant.' }),
      // Exemplaires atteints par un autre type (ex. pochette rangée dans un tiroir type, lui-même dans F25 et F26).
      indirects.length ? el('div', { classe: 'inv-exemplaires-indirects' },
        el('h3', { texte: `Dans les contenants réels, via un autre type (${indirects.length})` }),
        el('ul', {}, ...indirects.map((x) => el('li', {}, el('a', { href: lien(x.id), texte: chemin(x.id).map((y) => y.nom).join(' › ') }),
          toutPersonnalise(x) ? el('small', { classe: 'inv-attente', texte: ' — personnalisé' }) : null))),
        el('p', { classe: 'aide-question', texte: 'Ils se mettent à jour par la répercussion en chaîne : « Répercuter » ci-dessus met d\'abord à jour les copies rangées dans les autres types, puis ces types sur leurs propres exemplaires.' })) : null,
      exemplaires.length ? el('div', { classe: 'cfg-actions' }, boutonRepercuter, boutonSupprimer,
        // Étiquettes QR de tous les exemplaires et de ce qu'ils contiennent (pré-cochées, modifiables dans la fenêtre).
        el('button', { type: 'button', classe: 'cfg-bouton', texte: `Imprimer les étiquettes QR des exemplaires (${etiquettesExemplaires(exemplaires).length})…`,
          surclick: () => imprimerEtiquettes(etiquettesExemplaires(exemplaires)) })) : null,
      resultat,
      // Type immobile : pas de création d'exemplaires libres (non numérotés, on s'y perdrait). Il s'ajoute directement dans
      // le contenant d'un véhicule (« + » d'un sous-inventaire) ; une modification du type se répercute ensuite sur tous les véhicules.
      m.categorie === 'immobile'
        ? (c.id === m.id ? el('p', { classe: 'aide-question', texte: 'Type immobile : ajoutez-le dans chaque véhicule depuis « + » d\'un contenant. Pas de numéro ni d\'identification ; l\'état (vérification, péremptions) reste propre à chaque véhicule.' }) : null)
        : (c.id === m.id ? el('div', { classe: 'cfg-ligne inv-creer-exemplaires' }, el('label', { for: champNb, texte: 'Créer des exemplaires :' }), nb, creer) : null));
  }

  /** Bloc affiché dans un contenant d'exemplaire (mode Modifier) : lien vers le modèle, personnalisations. */
  function blocExemplaire(c) {
    const r = racineExemplaire(c.id);
    if (!r || !edition) return null;
    const m = contenant(r.source);
    const src = contenant(c.source);
    const perso = personnalisations(c);
    return el('div', { classe: 'note-parc inv-note-modele' },
      el('p', {}, 'Exemplaire de l\'inventaire type ', el('a', { href: lien(src ? src.id : m.id), texte: src ? (src.id === m.id ? m.nom : `${m.nom} › ${src.nom}`) : m.nom }),
        '. Une modification ici ne concerne que ce sac.'),
      perso.length ? el('p', {}, el('strong', { texte: 'Personnalisé : ' }), perso.map((k) => CHAMPS_LIBELLES[k]).join(', '), '. ',
        src ? el('button', { type: 'button', classe: 'lien', texte: confirmer === `revenir-${c.id}` ? 'Confirmer : revenir au modèle' : 'Revenir au modèle', surclick: () => {
          if (confirmer !== `revenir-${c.id}`) { confirmer = `revenir-${c.id}`; rendre({ garderPosition: true }); return; }
          confirmer = '';
          repercuter(c, src, true, c.id === r.id);
          avis = 'Ce contenant reprend le contenu de l\'inventaire type.';
          rendre({ garderPosition: true });
        } }) : null) : null);
  }

  function dupliquer(c) {
    const correspondance = {};
    const copies = descendants(c.id).map((x) => {
      const copie = normaliser(JSON.parse(JSON.stringify(x)));
      copie.id = nouvelId();
      delete copie.traceur; // un traceur est collé sur un seul objet : la copie n'en a pas
      correspondance[x.id] = copie.id;
      return copie;
    });
    copies.forEach((copie, i) => {
      if (i === 0) {
        const fratrie = enfants(c.parent);
        copie.nom = `${c.nom} (copie)`.slice(0, 80);
        copie.ordre = fratrie[fratrie.length - 1].ordre + 1;
      } else {
        copie.parent = correspondance[copie.parent];
      }
      traduireCibles(copie, (cible) => correspondance[cible]);
      structure.contenants[copie.id] = copie;
      marquer(copie.id);
    });
    avis = `Copie créée : renommez-la, puis imprimez son étiquette.`;
    aller(copies[0].id);
  }

  /** Contenu d'un inventaire type, hors mode Modifier : simple liste, rien à cocher. */
  function blocContenuModele(c) {
    if (!c.articles.length) return null;
    return el('section', { classe: 'inv-section' }, el('h2', { texte: 'Contenu' }),
      el('ul', { classe: 'inv-liste-modele' }, ...c.articles.filter((a) => !estReperePhoto(a)).map((a) => (a.separateur
        ? el('li', { classe: 'inv-separation', texte: a.nom })
        : el('li', {}, nomArticle(a), a.quantite ? el('span', { classe: 'inv-qte-attendue', texte: ` × ${a.quantite}` }) : null)))));
  }

  // ---------- Traceur GeoTraceSMUR (contenant mobile) ----------
  /**
   * Un exemplaire de contenant mobile (sac, ampoulier, scope…) peut porter un traceur GeoTraceSMUR.
   * Le serveur signale alors à GeoTrace le contenant primaire où il est vérifié ou identifié (GeoTrace.gs).
   */
  function blocTraceur(c) {
    const caseTraceur = idChamp();
    // Nom choisi dans la liste de GeoTraceSMUR (traceurs.js) : liaison exacte avec l'onglet du traceur.
    const choix = el('div', { classe: 'champ' }, el('span', { classe: 'inv-libelle', texte: 'Traceur' }),
      Traceurs.champ({ appeler: App.appeler, valeur: c.traceur || '', proprietaire: { genre: 'contenant', id: c.id }, surchange: (nom) => {
        if (nom) c.traceur = nom; else delete c.traceur;
        marquer(c.id);
      } }));
    choix.hidden = !c.traceur;
    const coche = el('input', { type: 'checkbox', id: caseTraceur, checked: Boolean(c.traceur), surchange: (e) => {
      choix.hidden = !e.target.checked;
      if (!e.target.checked && c.traceur) { delete c.traceur; marquer(c.id); rendre({ garderPosition: true }); }
    } });
    return el('div', { classe: 'inv-bloc-traceur' },
      el('label', { classe: 'cfg-case inv-case-fiche', for: caseTraceur }, coche,
        el('span', {}, 'Muni d\'un traceur GeoTraceSMUR', el('small', { texte: 'son contenant primaire est signalé à GeoTrace à chaque vérification ou identification' }))),
      choix);
  }

  // ---------- Inventaire libre : matériel scanné « en vrac » (réserve, étagère biomédicale) ----------
  /*
   * Contenant sans liste attendue (ex. étagère biomédicale de la réserve, où le matériel des véhicules désarmés
   * se retrouve) : l'agent scanne à la volée tout ce qui est posé là, sans se soucier de ce que c'est —
   * caméra (QR code, code-barres biomed), douchette Bluetooth (clavier : le n° saisi s'enregistre seul et le
   * champ est prêt pour le suivant), puce NFC ou liste. Les comptes par type se font ensuite, tout seuls.
   * La validation passe par « verifierInventaire » : une ligne par appareil, avec sa valeur (n° biomed, n° de
   * série…) ; le serveur met ainsi à jour leur dernier emplacement (suivi du matériel) et GeoTrace.
   */
  const VRAC_MAX = 200; // INV_MAX_ARTICLES côté serveur
  const NON_IDENTIFIE = 'Non identifié';
  const estVrac = (c) => Boolean(c && c.vrac === true && !c.emplacement && !dansUnModele(c.id));
  const cleCode = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  /** Appareil du suivi du matériel correspondant à un code (lien de puce, n° biomed, n° de série ou identifiant). */
  function appareilParCode(code) {
    const t = String(code || '').trim();
    if (!t || typeof Materiel === 'undefined') return null;
    return (Materiel.identifier && Materiel.identifier(t)) || appareilsConnus().find((x) => x.id === t) || null;
  }
  /** Valeur gardée pour un appareil reconnu : la plus lisible de celles qui l'identifient sans ambiguïté. */
  const valeurAppareil = (x) => String(x.numBiomed || x.numSerie || x.pret || x.id);
  
  const avecAppareil = (code) => ({ code, appareil: appareilParCode(code) });
  const cleItem = (x) => (x.appareil ? `a:${x.appareil.id}` : `c:${cleCode(x.code)}`);
  /** Regroupe par type d'appareil (les non identifiés en dernier), triés par n° interne. */
  function compterVrac(items) {
    const groupes = new Map();
    items.forEach((x) => {
      const type = x.appareil ? (x.appareil.type || 'Autre appareil') : NON_IDENTIFIE;
      if (!groupes.has(type)) groupes.set(type, []);
      groupes.get(type).push(x);
    });
    const num = (x) => String((x.appareil && x.appareil.numInterne) || x.code);
    groupes.forEach((l) => l.sort((a, b) => num(a).localeCompare(num(b), 'fr', { numeric: true })));
    return [...groupes.entries()].sort(([a], [b]) => Number(a === NON_IDENTIFIE) - Number(b === NON_IDENTIFIE) || a.localeCompare(b, 'fr'));
  }
  /** Appareils du dernier relevé d'un contenant (recalculés : un appareil ajouté depuis à la base est reconnu). */
  const itemsDeVerif = (v) => Object.values((v && v.valeurs) || {}).filter((x) => String(x || '').trim()).map(avecAppareil);
  function ligneVrac(x, retirer = null) {
    const a = x.appareil;
    return el('li', { classe: `inv-vrac-item${a ? '' : ' inconnu'}`, 'data-item': x.id || null },
      el('span', { classe: 'inv-vrac-nom' },
        el('strong', { texte: a ? libelleAppareil(a) : NON_IDENTIFIE }),
        el('small', { texte: a ? [a.numBiomed ? `biomed ${a.numBiomed}` : '', !a.numBiomed && a.numSerie ? `S/N ${a.numSerie}` : ''].filter(Boolean).join(' · ') : x.code })),
      retirer ? el('button', { type: 'button', classe: 'inv-vrac-retirer', 'aria-label': `Retirer ${a ? libelleAppareil(a) : x.code}`, texte: '✕', surclick: retirer }) : null);
  }
  /** Comptes par type : une ligne par type, dépliable pour voir les appareils. */
  function comptesVrac(items, ouvert = false) {
    return el('ul', { classe: 'inv-vrac-comptes' }, ...compterVrac(items).map(([type, liste]) => el('li', { classe: type === NON_IDENTIFIE ? 'inconnu' : '' },
      el('details', { open: ouvert || null },
        el('summary', {}, el('span', { classe: 'inv-vrac-nombre', texte: String(liste.length) }), el('span', { texte: type })),
        el('ul', { classe: 'inv-vrac-liste' }, ...liste.map((x) => ligneVrac(x)))))));
  }
  /** Page du contenant (check-list) : dernier relevé compté par type, et le bouton pour scanner. */
  function blocVrac(c, lectureSeule = false) {
    const v = etat.verifs[c.id];
    const b = lectureSeule ? {} : brouillon(c);
    const enCours = Array.isArray(b.vrac) ? b.vrac.length : 0;
    const items = v ? itemsDeVerif(v) : [];
    const inconnus = items.filter((x) => !x.appareil).length;
    return [
      el('section', { classe: 'inv-section inv-vrac' },
        el('div', { classe: 'inv-liste-entete' }, el('h2', {}, 'Matériel présent ', v ? el('span', { classe: 'inv-compte', texte: String(items.length) }) : null)),
        v ? el('p', { classe: 'inv-vrac-quand', texte: `Relevé ${verifDuJour(c.id) ? 'aujourd\'hui' : `le ${new Date(v.date).toLocaleDateString('fr-FR')}`} à ${heure(v.date)}${v.agent ? ` par ${v.agent}` : ''}` })
          : el('p', { classe: 'consigne', texte: 'Aucun relevé pour l\'instant. Scannez tout le matériel posé ici, sans vous soucier de ce que c\'est : les comptes par type se font tout seuls.' }),
        items.length ? comptesVrac(items) : (v ? el('p', { classe: 'consigne', texte: 'Aucun matériel au dernier relevé.' }) : null),
        inconnus ? el('p', { classe: 'aide-question', texte: `${pluriel(inconnus, 'code')} non reconnu${inconnus > 1 ? 's' : ''} : appareil absent du suivi du matériel (ou base pas encore chargée sur ce téléphone). Il sera compté dès qu'il y sera ajouté.` }) : null),
      lectureSeule ? null : el('div', { classe: 'inv-barre-bas' },
        el('p', { classe: 'message inv-message', role: 'alert', hidden: true }),
        el('div', { classe: 'inv-barre-bas-boutons' }, boutonsScanIcones()[0],
          el('button', { type: 'button', classe: 'principal inv-valider', surclick: () => sessionVrac(c),
            texte: enCours ? `Reprendre le scan (${enCours})` : (verifDuJour(c.id) ? 'Refaire le relevé' : 'Scanner le matériel') }),
          boutonsScanIcones()[1])),
    ];
  }
  function validerVrac(c, liste) {
    const articles = liste.map((x) => ({ id: x.id, nom: x.appareil ? libelleAppareil(x.appareil) : NON_IDENTIFIE, controle: 'materiel', ok: true, valeur: String(x.code).slice(0, 120) }));
    const ok = App.mettreEnFile({ action: 'verifierInventaire', contenant: c.id, detail: { chemin: cheminNoms(c.id, ' > '), articles, remarque: '', vrac: true } });
    if (!ok) return false;
    const valeurs = {};
    articles.forEach((a) => { valeurs[a.id] = a.valeur; });
    etat.verifs[c.id] = { date: new Date().toISOString(), agent: App.agent(), manquants: [], remarque: '', valeurs };
    delete brouillons.liste[c.id];
    sauverEtat();
    sauverBrouillons();
    avis = `« ${c.nom} » : ${pluriel(articles.length, 'appareil')} relevé${articles.length > 1 ? 's' : ''}.`;
    return true;
  }

  let sonVrac = null;
  /** Bip court (scan accepté) ou grave (déjà scanné, refusé), et vibration. */
  function signalVrac(bon) {
    try { if (navigator.vibrate) navigator.vibrate(bon ? 30 : [40, 60, 40]); } catch (e) { /* rien */ }
    try {
      if (!sonVrac) sonVrac = new (window.AudioContext || window.webkitAudioContext)();
      const o = sonVrac.createOscillator();
      const g = sonVrac.createGain();
      o.frequency.value = bon ? 1320 : 330;
      g.gain.setValueAtTime(0.12, sonVrac.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, sonVrac.currentTime + (bon ? 0.09 : 0.2));
      o.connect(g).connect(sonVrac.destination);
      o.start();
      o.stop(sonVrac.currentTime + (bon ? 0.1 : 0.22));
    } catch (e) { /* pas de son : la vibration et l'affichage suffisent */ }
  }

  /**
   * Écran de scan à la volée : le lecteur reste ouvert, chaque code lu s'ajoute en haut de la liste.
   * Douchette Bluetooth (mode clavier) : le champ garde le focus (sans clavier à l'écran) ; Entrée, Tab ou la fin
   * d'une rafale de caractères enregistre la saisie et vide le champ pour la suivante.
   */
  function sessionVrac(c) {
    if (enConsultation(c)) { messageVue('Consultation seule : indiquez d\'abord le contenant primaire où vous êtes.', 'erreur'); return; }
    if (typeof Materiel !== 'undefined' && Materiel.actualiser && navigator.onLine) Materiel.actualiser();
    const b = brouillon(c);
    if (!Array.isArray(b.vrac)) b.vrac = [];
    const items = () => b.vrac.map((x) => ({ ...x, ...avecAppareil(x.code) }));
    const detecteurDispo = 'BarcodeDetector' in window && Boolean(navigator.mediaDevices);
    const nfcDispo = 'NDEFReader' in window;
    let cameraVoulue = detecteurDispo && lireJson('avismur_vrac_camera', true) !== false;
    let fini = false;
    let flux = null;
    let minuterie = null;
    let terminerVide = false;
    const arretNfc = new AbortController();
    const recent = new Map(); // code → instant de la dernière lecture (la caméra relit le même code en boucle)

    const video = el('video', { playsinline: '', muted: '', autoplay: '' });
    video.muted = true;
    const vue = el('div', { classe: 'camera-vue inv-vrac-video' }, video, el('div', { classe: 'viseur inv-vrac-viseur', 'aria-hidden': 'true' }));
    const lecture = el('p', { classe: 'lecture', role: 'status', 'aria-live': 'polite' });
    const compte = el('span', { classe: 'inv-vrac-total' });
    const resume = el('div', { classe: 'inv-vrac-resume' });
    const liste = el('ul', { classe: 'inv-vrac-liste inv-vrac-session' });
    const champ = el('input', { type: 'text', inputmode: 'none', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'enter',
      classe: 'inv-vrac-champ', 'aria-label': 'N° biomed ou n° de série (douchette ou saisie)', placeholder: 'N° biomed…' });
    const boutonCamera = detecteurDispo ? el('button', { type: 'button', classe: 'inv-vrac-outil', 'aria-pressed': 'false', title: 'Caméra' }) : null;
    const boutonClavier = el('button', { type: 'button', classe: 'inv-vrac-outil', 'aria-pressed': 'false', title: 'Clavier à l\'écran', 'aria-label': 'Afficher le clavier pour saisir un numéro', texte: '⌨' });
    const terminer = el('button', { type: 'button', classe: 'camera-bouton' });
    const fermerBouton = el('button', { type: 'button', classe: 'camera-bouton secondaire', texte: 'Fermer' });
    const reprise = etat.verifs[c.id];
    const boutonReprise = reprise && verifDuJour(c.id) && itemsDeVerif(reprise).length
      ? el('button', { type: 'button', classe: 'lien inv-vrac-reprise', texte: `Repartir du relevé de ${heure(reprise.date)} (${itemsDeVerif(reprise).length})` }) : null;

    const annonce = (texte, classe = '') => { lecture.textContent = texte; lecture.className = `lecture ${classe}`.trim(); };
    const majTerminer = () => {
      const n = b.vrac.length;
      terminer.textContent = terminerVide ? 'Valider un relevé vide ?' : `Terminé${n ? ` (${n})` : ''}`;
    };
    const majListe = (nouveau = '') => {
      const tous = items();
      compte.textContent = tous.length ? pluriel(tous.length, 'appareil') : 'Rien de scanné';
      resume.replaceChildren(...compterVrac(tous).map(([type, l]) => el('span', { classe: `inv-vrac-puce${type === NON_IDENTIFIE ? ' inconnu' : ''}` }, el('strong', { texte: String(l.length) }), ` ${type}`)));
      // Le dernier scanné en haut : c'est lui que l'on veut voir.
      liste.replaceChildren(...tous.slice().reverse().map((x) => ligneVrac(x, () => {
        b.vrac = b.vrac.filter((y) => y.id !== x.id);
        sauverBrouillons();
        annonce(`Retiré : ${x.appareil ? libelleAppareil(x.appareil) : x.code}.`);
        majListe();
      })));
      if (boutonReprise) boutonReprise.hidden = tous.length > 0;
      ecran.classList.toggle('vide', !tous.length);
      terminerVide = false;
      majTerminer();
      if (nouveau) {
        const li = liste.querySelector(`[data-item="${nouveau}"]`);
        if (li) { li.classList.add('nouveau'); li.scrollIntoView({ block: 'nearest' }); }
      }
    };
    const surligner = (id) => {
      const li = liste.querySelector(`[data-item="${id}"]`);
      if (!li) return;
      li.classList.remove('deja');
      void li.offsetWidth; // relance l'animation
      li.classList.add('deja');
      li.scrollIntoView({ block: 'nearest' });
    };
    const ajouter = (brut, tout = '') => {
      const code = String(brut || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 200);
      if (!code || fini) return;
      if (/#inv=[a-z0-9]{6,16}/.test(code)) { annonce('QR code d\'un inventaire, pas d\'un appareil : ignoré.', 'erreur'); signalVrac(false); return; }
      const appareil = (tout && appareilParCode(tout)) || appareilParCode(code);
      const nouveau = { code: appareil ? valeurAppareil(appareil) : code };
      const k = cleItem({ ...nouveau, appareil });
      if (k.length < 3) return;
      const deja = items().find((x) => cleItem(x) === k);
      if (deja) {
        annonce(`Déjà scanné : ${appareil ? libelleAppareil(appareil) : code}.`, 'deja');
        signalVrac(false);
        surligner(deja.id);
        return;
      }
      if (b.vrac.length >= VRAC_MAX) { annonce(`Liste pleine (${VRAC_MAX}) : appuyez sur Terminé.`, 'erreur'); signalVrac(false); return; }
      nouveau.id = nouvelId();
      b.vrac.push(nouveau);
      sauverBrouillons();
      signalVrac(true);
      annonce(appareil ? `✓ ${libelleAppareil(appareil)}` : `✓ Code ${code} (non reconnu, compté à part)`, appareil ? 'ok' : 'inconnu');
      majListe(nouveau.id);
    };

    // Douchette Bluetooth : elle « tape » le code très vite puis Entrée (ou Tab, ou rien selon son réglage).
    let dernierCar = 0;
    let rafale = 0;
    let finRafale = null;
    const soumettre = () => {
      clearTimeout(finRafale);
      const t = champ.value.trim();
      champ.value = '';
      rafale = 0;
      if (t) ajouter(t);
    };
    const frappe = () => {
      const t = performance.now();
      rafale = t - dernierCar < 60 ? rafale + 1 : 0;
      dernierCar = t;
      clearTimeout(finRafale);
      if (rafale >= 3) finRafale = setTimeout(soumettre, 300); // douchette réglée sans suffixe
    };
    champ.addEventListener('input', frappe);
    champ.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || (e.key === 'Tab' && champ.value.trim())) { e.preventDefault(); soumettre(); }
    });
    const garderFocus = () => { if (!fini && document.activeElement !== champ && !document.querySelector('.inv-vrac-choix')) champ.focus({ preventScroll: true }); };

    const arreterCamera = () => {
      clearInterval(minuterie);
      minuterie = null;
      if (flux) flux.getTracks().forEach((t) => t.stop());
      flux = null;
      video.srcObject = null;
    };
    const demarrerCamera = async () => {
      vue.hidden = false;
      try {
        const formats = BarcodeDetector.getSupportedFormats ? await BarcodeDetector.getSupportedFormats() : [];
        const det = formats.length ? new BarcodeDetector({ formats }) : new BarcodeDetector();
        const f = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        if (fini || !cameraVoulue) { f.getTracks().forEach((t) => t.stop()); return; }
        flux = f;
        video.srcObject = f;
        let occupe = false;
        minuterie = setInterval(async () => {
          if (occupe || video.readyState < 2 || fini) return;
          occupe = true;
          try {
            const codes = await det.detect(video);
            const maintenant = Date.now();
            codes.forEach((x) => {
              const v = String(x.rawValue || '').trim();
              if (!v || maintenant - (recent.get(v) || 0) < 2500) { if (v) recent.set(v, maintenant); return; }
              recent.set(v, maintenant);
              ajouter(v);
            });
          } catch (e) { /* image pas encore prête */ } finally { occupe = false; }
        }, 250);
      } catch (e) {
        annonce('Caméra inaccessible : utilisez la douchette, la puce NFC ou la liste.', 'erreur');
        cameraVoulue = false;
        majCamera();
      }
    };
    const majCamera = () => {
      if (!boutonCamera) { vue.hidden = true; return; }
      boutonCamera.setAttribute('aria-pressed', String(cameraVoulue));
      boutonCamera.setAttribute('aria-label', cameraVoulue ? 'Couper la caméra' : 'Allumer la caméra');
      boutonCamera.replaceChildren(icone('M3 8h3.5l2-3h7l2 3H21v11H3z', 'M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', ...(cameraVoulue ? [] : ['M3 3l18 18'])));
      vue.hidden = !cameraVoulue;
      if (cameraVoulue && !flux) demarrerCamera(); else if (!cameraVoulue) arreterCamera();
    };
    if (boutonCamera) boutonCamera.addEventListener('click', () => { cameraVoulue = !cameraVoulue; ecrireJson('avismur_vrac_camera', cameraVoulue); majCamera(); garderFocus(); });
    boutonClavier.addEventListener('click', () => {
      const ouvrir = champ.inputMode === 'none';
      champ.inputMode = ouvrir ? 'text' : 'none';
      boutonClavier.setAttribute('aria-pressed', String(ouvrir));
      champ.blur();
      champ.focus();
    });

    if (nfcDispo) {
      const lecteur = new NDEFReader();
      lecteur.addEventListener('reading', (e) => {
        if (CibleNfc.enReglage()) return; // puce passée pour repérer l'antenne
        const recs = [...e.message.records];
        const dec = (x) => { try { return new TextDecoder(x.encoding || 'utf-8').decode(x.data); } catch (err) { return ''; } };
        const r = recs.find((x) => ['text', 'url', 'absolute-url'].includes(x.recordType));
        const code = (r && dec(r)) || e.serialNumber || '';
        const maintenant = Date.now();
        if (maintenant - (recent.get(`nfc:${code}`) || 0) < 1500) return;
        recent.set(`nfc:${code}`, maintenant);
        ajouter(code, recs.map(dec).join('\n'));
      });
      lecteur.scan({ signal: arretNfc.signal }).catch(() => { /* NFC refusé ou éteint : les autres moyens restent possibles */ });
    }

    // Choix dans la liste des appareils du suivi du matériel (ceux qui ne sont pas encore scannés).
    const choisirDansListe = () => {
      const deja = new Set(items().filter((x) => x.appareil).map((x) => x.appareil.id));
      const tous = appareilsConnus().filter((x) => !deja.has(x.id));
      const coches = new Set();
      let filtre = '';
      const panneau = el('div', { classe: 'inv-vrac-choix', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Ajouter depuis la liste' });
      const recherche = el('input', { type: 'search', placeholder: 'Type, n° interne, modèle…', 'aria-label': 'Filtrer les appareils', surinput: (e) => { filtre = cle(e.target.value); dessiner(); } });
      const corps = el('div', { classe: 'inv-vrac-choix-corps' });
      const ajouterBouton = el('button', { type: 'button', classe: 'camera-bouton' });
      const fermerPanneau = () => { panneau.remove(); garderFocus(); };
      const dessiner = () => {
        const visibles = tous.filter((x) => !filtre || cle(`${x.type} ${x.numInterne} ${x.modele} ${x.numSerie}`).includes(filtre));
        const parType = new Map();
        visibles.forEach((x) => { const t = x.type || 'Autre appareil'; if (!parType.has(t)) parType.set(t, []); parType.get(t).push(x); });
        corps.replaceChildren(...(visibles.length ? [...parType.entries()].sort(([a], [z]) => a.localeCompare(z, 'fr')).map(([type, l]) => el('fieldset', { classe: 'inv-vrac-groupe' },
          el('legend', { texte: type }),
          ...l.sort((x, y) => String(x.numInterne).localeCompare(String(y.numInterne), 'fr', { numeric: true })).map((x) => {
            const i = idChamp();
            return el('label', { for: i, classe: 'inv-vrac-option' },
              el('input', { type: 'checkbox', id: i, checked: coches.has(x.id), surchange: (e) => { if (e.target.checked) coches.add(x.id); else coches.delete(x.id); majAjout(); } }),
              el('span', {}, el('strong', { texte: [x.modele, x.numInterne && `n° ${x.numInterne}`].filter(Boolean).join(' ') || '—' }), x.numSerie ? el('small', { texte: ` S/N ${x.numSerie}` }) : null));
          })))
          : [el('p', { classe: 'consigne', texte: tous.length ? 'Aucun appareil ne correspond.' : 'Aucun autre appareil dans le suivi du matériel (ou base pas encore chargée sur ce téléphone).' })]));
      };
      const majAjout = () => { ajouterBouton.textContent = coches.size ? `Ajouter (${coches.size})` : 'Ajouter'; ajouterBouton.disabled = !coches.size; };
      ajouterBouton.addEventListener('click', () => {
        tous.filter((x) => coches.has(x.id)).forEach((x) => ajouter(x.id));
        fermerPanneau();
      });
      panneau.append(
        el('div', { classe: 'inv-vrac-haut' }, el('strong', { texte: 'Ajouter depuis la liste' }),
          el('button', { type: 'button', classe: 'inv-vrac-outil', 'aria-label': 'Fermer la liste', texte: '✕', surclick: fermerPanneau })),
        el('div', { classe: 'inv-vrac-filtre' }, recherche), corps,
        el('div', { classe: 'camera-actions' }, el('button', { type: 'button', classe: 'camera-bouton secondaire', texte: 'Annuler', surclick: fermerPanneau }), ajouterBouton));
      panneau.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); fermerPanneau(); } });
      dessiner();
      majAjout();
      ecran.append(panneau);
      recherche.focus();
    };

    const liens = [boutonReprise, nfcDispo ? CibleNfc.lien() : null].filter(Boolean);
    const ecran = el('div', { classe: 'camera inv-vrac-ecran vide', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Scanner le matériel : ${c.nom}` },
      el('div', { classe: 'inv-vrac-haut' },
        el('div', { classe: 'inv-vrac-titre' }, el('strong', { texte: c.nom }), compte),
        el('button', { type: 'button', classe: 'inv-vrac-outil inv-vrac-bouton-liste', texte: 'Liste', 'aria-label': 'Ajouter depuis la liste des appareils', surclick: choisirDansListe }),
        boutonCamera, boutonClavier),
      vue,
      el('form', { classe: 'inv-vrac-saisie', sursubmit: (e) => { e.preventDefault(); soumettre(); } },
        champ,
        el('button', { type: 'submit', classe: 'inv-vrac-outil', 'aria-label': 'Ajouter ce numéro', texte: '+' })),
      lecture,
      el('div', { classe: 'inv-vrac-corps' }, resume, liste,
        el('p', { classe: 'inv-vrac-vide', texte: 'Les appareils scannés s\'afficheront ici, le dernier en haut.' })),
      liens.length ? el('div', { classe: 'inv-vrac-liens' }, ...liens) : null,
      el('div', { classe: 'camera-actions' }, fermerBouton, terminer));
    const cacherCible = nfcDispo ? CibleNfc.montrer() : () => {};
    const fermer = () => {
      if (fini) return;
      fini = true;
      clearTimeout(finRafale);
      arreterCamera();
      arretNfc.abort();
      cacherCible();
      ecran.remove();
      document.body.classList.remove('camera-ouverte');
    };
    fermerBouton.addEventListener('click', () => {
      fermer();
      if (b.vrac.length) avis = `Scan en cours gardé (${pluriel(b.vrac.length, 'appareil')}) : « Reprendre le scan » pour le terminer.`;
      rendre({ garderPosition: true });
    });
    terminer.addEventListener('click', () => {
      if (!b.vrac.length && !terminerVide) { terminerVide = true; majTerminer(); annonce('Rien n\'a été scanné : appuyez de nouveau pour noter qu\'il n\'y a aucun matériel ici.', 'deja'); return; }
      if (!validerVrac(c, items())) { annonce('Non enregistré : la mémoire de l\'appareil est pleine.', 'erreur'); return; }
      fermer();
      rendre();
    });
    if (boutonReprise) {
      boutonReprise.addEventListener('click', () => {
        itemsDeVerif(reprise).forEach((x) => { b.vrac.push({ id: nouvelId(), code: x.code }); });
        sauverBrouillons();
        annonce('Relevé précédent repris : scannez ce qui a été ajouté, retirez ce qui est parti.');
        majListe();
      });
    }
    // Touche ailleurs que dans le champ : il reprend le focus (la douchette écrit toujours au bon endroit).
    ecran.addEventListener('click', (e) => { if (!e.target.closest('input, .inv-vrac-choix')) setTimeout(garderFocus, 0); });
    ecran.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { fermerBouton.click(); return; }
      // Caractère tapé (douchette) alors que le focus est sur un bouton : il va dans le champ.
      if (e.target !== champ && !e.target.closest('.inv-vrac-choix') && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        champ.focus({ preventScroll: true });
        champ.value += e.key;
        frappe();
      }
    });
    document.body.append(ecran);
    document.body.classList.add('camera-ouverte');
    annonce(['Visez un code', nfcDispo ? 'approchez une puce NFC' : '', 'ou utilisez la douchette'].filter(Boolean).join(', ') + '.');
    majListe();
    majCamera();
    champ.focus({ preventScroll: true });
  }

  // ---------- Contenant scellable : « est-il scellé ? » ----------
  const reponsesScelle = new Set(); // contenants pour lesquels l'agent a répondu « non, il est ouvert » (cette visite)
  /**
   * Contenant scellé : son inventaire (et celui de tout ce qu'il contient) est validé sur la base du dernier
   * réalisé — mêmes articles présents ou manquants, mêmes dates de péremption connues. Impossible si l'un
   * des contenants n'a encore jamais été vérifié, ou si un emplacement est vide.
   */
  function obstaclesScelle(c) {
    const obstacles = [];
    descendants(c.id).forEach((d) => {
      if (d.emplacement && !enfants(d.id).length) obstacles.push(`${d.nom} (emplacement vide)`);
    });
    return obstacles;
  }
  /** Valide par le scellé le contenant et tout ce qu'il contient : nombre d'inventaires validés, ou -1 (mémoire pleine). */
  function appliquerScelle(c) {
    const maintenant = new Date().toISOString();
    let n = 0;
    for (const d of descendants(c.id)) {
      if (!aCocher(d).length || verifDuJour(d.id)) continue;
      // Jamais inventorié : plombé = complet et opérationnel, on le valide comme complet (quantités attendues).
      const derniere = etat.verifs[d.id] || { manquants: [], valeurs: {} };
      const manquants = new Set(derniere.manquants.map((m) => m.id));
      const articles = aCocher(d).map((a) => {
        if (estControle(a)) {
          const val = derniere.valeurs && derniere.valeurs[a.id] !== undefined ? String(derniere.valeurs[a.id]) : '';
          return { id: a.id, nom: nomArticle(a), controle: a.controle, ok: !manquants.has(a.id), valeur: val, ...(estFacultatif(a) ? { facultatif: true } : {}) };
        }
        const att = attendue(a);
        return {
          id: a.id, nom: nomArticle(a), ok: !manquants.has(a.id), ...(estFacultatif(a) ? { facultatif: true } : {}),
          ...(att !== null ? { attendu: att, quantite: att, ...(estMinimum(a) ? { min: true } : {}) } : {}),
          ...(suiviPeremption(a) ? { peremption: datePeremption(d.id, a.id) } : {}),
        };
      });
      const remarque = derniere.date
        ? `Scellé : validé sur la base de l'inventaire du ${new Date(derniere.date).toLocaleDateString('fr-FR')} (${derniere.agent}).`
        : 'Scellé : aucun inventaire antérieur, réputé complet.';
      const ok = App.mettreEnFile({ action: 'verifierInventaire', contenant: d.id, detail: { chemin: cheminNoms(d.id, ' > '), articles, remarque, scelle: true } });
      if (!ok) { sauverEtat(); return -1; }
      etat.verifs[d.id] = { date: maintenant, agent: App.agent(), manquants: derniere.manquants, remarque, scelle: true, valeurs: derniere.valeurs || {} };
      n += 1;
    }
    sauverEtat();
    return n;
  }
  function validerScelle(c) {
    const n = appliquerScelle(c);
    if (n < 0) { avis = 'Non enregistré : la mémoire de l\'appareil est pleine.'; rendre(); return; }
    avis = `« ${c.nom} » scellé : ${pluriel(n, 'inventaire')} validé${n > 1 ? 's' : ''} sur la base du dernier réalisé.`;
    if (gestion) aller(c.id); else remonterApresValidation(c);
  }
  function blocQuestionScelle(c) {
    const obstacles = obstaclesScelle(c);
    return el('section', { classe: 'inv-question-scelle' },
      el('h2', { texte: 'Ce contenant est-il scellé ?' }),
      el('p', { texte: 'Scellé (plomb intact) : il est complet et opérationnel, son inventaire est validé sur la base du dernier réalisé. Ouvert ou déplombé : faites l\'inventaire.' }),
      obstacles.length ? el('p', { classe: 'message erreur', texte: `Validation par le scellé impossible : ${obstacles.join(', ')}. Faites l'inventaire complet.` }) : null,
      el('div', { classe: 'inv-boutons-scelle' },
        el('button', { type: 'button', classe: 'principal', disabled: obstacles.length > 0, texte: 'Oui, il est scellé', surclick: () => validerScelle(c) }),
        el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Non, il est ouvert', surclick: () => { reponsesScelle.add(c.id); rendre({ garderPosition: true }); } })));
  }

  // ---------- Sous-contenants scellables : « tout est scellé » en une fois ----------
  /**
   * Sous-contenants scellables (à toute profondeur) du contenant affiché, pas encore vérifiés aujourd'hui :
   *   - prets : identifiés (fixes, ou mobiles pointés aujourd'hui), validables d'un coup ;
   *   - aIdentifier : emplacements ou contenants mobiles scellables pas encore pointés aujourd'hui (jamais nommés).
   * On ne descend pas dans un scellable (sa validation couvre son contenu) ni dans un mobile non identifié.
   */
  function scellablesSous(c) {
    const prets = [];
    const aIdentifier = [];
    const vus = new Set([c.id]);
    const scellableAttendu = (e) => modelesEmplacement(e).some((m) => contenant(m) && contenant(m).scellable);
    const parcourir = (p) => enfants(p.id).forEach((f) => {
      if (vus.has(f.id) || dansUnModele(f.id)) return;
      vus.add(f.id);
      let x = f;
      if (f.emplacement) {
        x = occupantDuJour(f);
        if (!x) { if (scellableAttendu(f)) aIdentifier.push(f); return; }
        vus.add(x.id);
      } else if (masquerMobile(f)) {
        if (f.scellable) aIdentifier.push(f);
        return;
      }
      if (x.scellable) { const bx = bilan(x.id); if (bx.total > 0 && !bx.complet && !reponsesScelle.has(x.id)) prets.push(x); return; }
      parcourir(x);
    });
    parcourir(c);
    return { prets, aIdentifier };
  }
  /** Où se trouve `x` sous `c` (« Tiroir D › Case 2 »), sans les emplacements ni `x` lui-même. */
  function cheminSous(c, x) {
    const suite = chemin(x.id);
    const i = suite.findIndex((z) => z.id === c.id);
    return suite.slice(i + 1, -1).filter((z) => !z.emplacement).map((z) => z.nom).join(' › ');
  }
  /**
   * « Tout est scellé » : les sous-contenants scellables pas encore vérifiés passent en « scellé ». Les non scellables
   * ne sont jamais touchés. S'il ne reste rien à vérifier ici, retour au niveau du dessus ; sinon on reste.
   */
  function validerScellesGroupes(c, liste, ouverts = []) {
    let n = 0;
    const faits = [];
    for (const x of liste) {
      const k = appliquerScelle(x);
      if (k < 0) { avis = `Non enregistré : la mémoire de l'appareil est pleine${faits.length ? ` (validés avant l'erreur : ${faits.join(', ')})` : ''}.`; rendre({ garderPosition: true }); return; }
      n += k;
      faits.push(x.nom);
      scellesDecoches.delete(x.id);
    }
    // Déclarés ouverts : l'agent fera l'inventaire, sans qu'on lui redemande s'ils sont scellés.
    ouverts.forEach((x) => { reponsesScelle.add(x.id); scellesDecoches.delete(x.id); });
    const morceaux = [];
    if (faits.length) morceaux.push(`Scellés : ${faits.map((f) => `« ${f} »`).join(', ')}`);
    if (ouverts.length) morceaux.push(`Ouverts : ${ouverts.map((x) => `« ${x.nom} »`).join(', ')}`);
    avis = morceaux.length ? `${morceaux.join(' — ')}.` : '';
    const bc = bilan(c.id);
    if (bc.complet) {
      const dessus = etagesAuDessus(c)[0];
      allerDirect(dessus ? dessus.id : '');
    } else rendre({ garderPosition: true });
  }
  /** Fenêtre de confirmation « Les autres contenants sont-ils bien scellés ? ». */
  function confirmerScelles(c, prets, bloques, aIdentifier) {
    const fond = el('div', { classe: 'fenetre-fond', surclick: (e) => { if (e.target === fond) fermer(); } });
    const retour = document.activeElement;
    const fermer = () => { fond.remove(); document.body.classList.remove('fenetre-ouverte'); if (retour && retour.isConnected) retour.focus(); };
    const titre = idChamp();
    const ok = prets.filter((x) => !bloques.has(x.id));
    const exclus = [
      ...prets.filter((x) => bloques.has(x.id)).map((x) => `« ${x.nom} » (inventaire complet requis : ${bloques.get(x.id).join(', ')})`),
      ...aIdentifier.map((f) => `${f.emplacement ? `« ${f.nom} »` : 'un contenant mobile'} (à identifier)`),
    ];
    fond.append(el('div', { classe: 'fenetre inv-confirmer-scelles', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': titre },
      el('div', { classe: 'fenetre-entete' }, el('h2', { id: titre, texte: ok.length ? 'Les autres contenants sont-ils bien scellés ?' : 'Validation par le scellé impossible' }),
        el('button', { type: 'button', classe: 'fenetre-fermer', 'aria-label': 'Fermer', texte: '✕', surclick: fermer })),
      el('ul', { classe: 'inv-scelles-liste' }, ...ok.map((x) => {
        const ou = cheminSous(c, x);
        return el('li', {}, logoCadenas(), el('span', {}, el('strong', { texte: x.nom }), ou ? el('small', { texte: ` · ${ou}` }) : null));
      })),
      exclus.length ? el('p', { classe: 'aide-question inv-scelle-obstacle', texte: `Non concernés : ${exclus.join(', ')}.` }) : null,
      el('div', { classe: 'inv-boutons-scelle' },
        ok.length ? el('button', { type: 'button', classe: 'principal', texte: 'Oui', surclick: () => { fermer(); validerScellesGroupes(c, ok); } }) : null,
        el('button', { type: 'button', classe: ok.length ? 'cfg-bouton' : 'principal', texte: ok.length ? 'Non' : 'Fermer', surclick: fermer }))));
    fond.addEventListener('keydown', (e) => { if (e.key === 'Escape') fermer(); });
    document.body.append(fond);
    document.body.classList.add('fenetre-ouverte');
    fond.querySelector('.inv-boutons-scelle button').focus();
  }
  /**
   * Identification à la suite des scellables non pointés : le lecteur se rouvre après chaque contenant reconnu
   * tant qu'il en reste. Le contenant scanné prend la place qui lui correspond (lui-même, ou un emplacement de son modèle).
   */
  function scannerScelles(c) {
    scanner({ qr: true, nfc: true }, (id) => {
      const x = contenant(id);
      const places = scellablesSous(c).aIdentifier;
      if (!x) { alerteBreve('Inventaire inconnu : vérifiez l\'étiquette.'); return; }
      const exacte = places.find((s) => (s.emplacement ? (enfants(s.id)[0] || {}).id === x.id : s.id === x.id));
      const parModele = places.find((s) => (s.emplacement ? modelesEmplacement(s).includes(x.source) : (x.source && s.source === x.source)));
      const s = exacte || parModele;
      if (!s) { alerteBreve(`« ${x.nom} » n'a pas de place à identifier ici.`); return; }
      if (!identifierPlace(s, x)) return;
      if (scellablesSous(c).aIdentifier.length) setTimeout(() => { if (idCourant() === c.id) scannerScelles(c); }, 900);
    });
  }
  /** Le contenant `x` est celui qui se trouve à la place `s` (emplacement ou mobile scellable non pointé) : vrai si enregistré. */
  function identifierPlace(s, x) {
    let ok;
    if (s.emplacement) { const occ = enfants(s.id)[0]; ok = enregistrerIdentification(occ || null, x.id, occ ? '' : s.id); } else ok = enregistrerIdentification(s, x.id);
    if (!ok) return false;
    scellesChoisis.set(s.id, x.nom);
    avis = '';
    alerteBreve(`« ${x.nom} » identifié.`);
    rendre({ garderPosition: true });
    return true;
  }
  /**
   * Contenants mobiles correspondant à la place `s` : exemplaires du ou des modèles attendus (emplacement), de même
   * modèle que le contenant prévu, ou à défaut de même nom (au numéro près). Ordre alphabétique, sans mettre en avant
   * le prévu ni dire où se trouvait chaque contenant.
   */
  function candidatsPlace(s) {
    const sansNumero = (x) => cle(x.nom).replace(/\d+|n°/g, '').trim();
    const modeles = s.emplacement ? modelesEmplacement(s) : [];
    return Object.values(structure.contenants)
      .filter((x) => !x.supprime && x.categorie === 'mobile' && !x.emplacement && !dansUnModele(x.id)
        && (s.emplacement ? modeles.includes(x.source)
          : x.id === s.id || (s.source ? x.source === s.source : sansNumero(x) === sansNumero(s))))
      .sort((a, b) => a.nom.localeCompare(b.nom, 'fr', { numeric: true }));
  }
  /** Liste déroulante des contenants correspondant à la place `s` : le choix vaut identification. */
  function listeCandidats(c, s) {
    const candidats = candidatsPlace(s);
    if (!candidats.length) return null;
    const id = idChamp();
    const select = el('select', { id, classe: 'inv-scelles-choix', 'aria-label': `Contenant présent : ${s.nom}` },
      el('option', { value: '', texte: 'Choisir le contenant…' }),
      ...candidats.map((x) => el('option', { value: x.id, texte: x.nom })));
    select.addEventListener('change', () => {
      const x = contenant(select.value);
      if (x && !identifierPlace(s, x)) select.value = '';
    });
    return el('div', { classe: 'inv-scelles-liste-deroulante' }, select);
  }
  /**
   * Bouton « Tout est scellé » du contenant affiché : l'agent vérifie d'abord les sous-contenants de son choix
   * en y entrant, puis valide d'un coup les scellables restants (après confirmation).
   */
  /** Contenants dont la liste des scellables non vérifiés est dépliée (conservé entre deux rendus). */
  const scellesDeroules = new Set();
  /** Place à identifier (id du contenant prévu ou de l'emplacement) → nom du contenant choisi ; affiché en coche verte. */
  const scellesChoisis = new Map();
  /** Places à identifier d'un contenant, dans l'ordre d'affichage (stable après chaque identification). */
  const scellesPlaces = new Map();
  /** Scellables passés en « Ouvert » par l'agent dans la liste ; par défaut tout est scellé. */
  const scellesDecoches = new Set();
  function blocScellesGroupes(c) {
    const { prets, aIdentifier } = scellablesSous(c);
    const dejaIds = (scellesPlaces.get(c.id) || []).filter((id) => scellesChoisis.has(id) || aIdentifier.some((f) => f.id === id));
    const places = [...dejaIds, ...aIdentifier.map((f) => f.id).filter((id) => !dejaIds.includes(id))];
    scellesPlaces.set(c.id, places);
    if (!prets.length && !places.length) return null;
    const bloques = new Map(prets.map((x) => [x.id, obstaclesScelle(x)]).filter(([, o]) => o.length));
    const n = prets.length + aIdentifier.length;
    const ligne = (x, etat, cochable) => {
      const ou = cheminSous(c, x);
      const contenu = [el('strong', { texte: x.nom }), ou ? el('small', { texte: ` · ${ou}` }) : null,
        el('span', { classe: 'inv-scelles-etat', texte: etat })];
      if (!cochable) return el('li', {}, el('span', { classe: 'inv-scelles-case-vide' }), ...contenu);
      const ouvert = scellesDecoches.has(x.id);
      const bascule = el('button', { type: 'button', classe: `inv-scelles-bascule ${ouvert ? 'ouvert' : 'scelle'}`, 'aria-pressed': String(!ouvert),
        'aria-label': `${x.nom} : ${ouvert ? 'ouvert' : 'scellé'}. Appuyer pour changer`, texte: ouvert ? '🔓 Ouvert' : '🔒 Scellé' });
      bascule.addEventListener('click', () => {
        const devientOuvert = !scellesDecoches.has(x.id);
        if (devientOuvert) scellesDecoches.add(x.id); else scellesDecoches.delete(x.id);
        bascule.className = `inv-scelles-bascule ${devientOuvert ? 'ouvert' : 'scelle'}`;
        bascule.setAttribute('aria-pressed', String(!devientOuvert));
        bascule.setAttribute('aria-label', `${x.nom} : ${devientOuvert ? 'ouvert' : 'scellé'}. Appuyer pour changer`);
        bascule.textContent = devientOuvert ? '🔓 Ouvert' : '🔒 Scellé';
        majBouton();
      });
      return el('li', {}, el('span', { classe: 'inv-scelles-ligne' }, ...contenu.slice(0, -1), bascule));
    };
    // Place à identifier : nom et liste déroulante sur une seule ligne ; une fois choisi, le contenant remplace le prévu, avec une coche verte.
    const lignePlace = (id) => {
      const f = contenant(id);
      if (!f) return null;
      const ou = cheminSous(c, f);
      const choisi = scellesChoisis.get(id);
      const nom = el('span', { classe: 'inv-scelles-nom' }, el('strong', { texte: choisi || f.nom }), ou ? el('small', { texte: ` · ${ou}` }) : null);
      if (choisi) return el('li', { classe: 'inv-scelles-ident fait', title: 'Identifié' }, nom, el('span', { classe: 'inv-scelles-ok', 'aria-label': 'identifié', texte: '✓' }));
      return el('li', { classe: 'inv-scelles-ident' }, nom, listeCandidats(c, f));
    };
    const cochables = prets.filter((x) => !bloques.has(x.id));
    const choisis = () => cochables.filter((x) => !scellesDecoches.has(x.id));
    const ouvertsChoisis = () => cochables.filter((x) => scellesDecoches.has(x.id));
    let bouton = null;
    const majBouton = () => {
      if (!bouton) return;
      const k = choisis().length;
      const o = ouvertsChoisis().length;
      bouton.disabled = !cochables.length;
      bouton.textContent = !o ? (k === cochables.length ? 'Tout est scellé' : 'Valider') : `Valider : ${k} scellé${k > 1 ? 's' : ''}, ${o} ouvert${o > 1 ? 's' : ''}`;
    };
    const deroule = el('details', { classe: 'inv-scelles-details' },
      el('summary', { classe: 'inv-scelles-resume' }, logoCadenas(),
        el('span', { texte: n ? `${pluriel(n, 'contenant')} scellable${n > 1 ? 's' : ''} non vérifié${n > 1 ? 's' : ''}` : 'Contenants identifiés' }),
        el('span', { classe: 'inv-scelles-chevron', 'aria-hidden': 'true', texte: '▾' })),
      el('ul', { classe: 'inv-scelles-detail-liste' },
        ...prets.map((x) => ligne(x, 'inventaire incomplet', !bloques.has(x.id))),
        ...places.map(lignePlace)));
    if (scellesDeroules.has(c.id)) deroule.open = true;
    deroule.addEventListener('toggle', () => { if (deroule.open) scellesDeroules.add(c.id); else scellesDeroules.delete(c.id); });
    const section = el('section', { classe: 'inv-scelles-groupes' },
      deroule,
      el('div', { classe: 'inv-boutons-scelle' },
        cochables.length ? (bouton = el('button', { type: 'button', classe: 'principal', texte: 'Tout est scellé', surclick: () => {
          // Ce que l'agent n'a pas passé en « Ouvert » est scellé ; plus de confirmation ni de question ensuite.
          validerScellesGroupes(c, choisis(), ouvertsChoisis());
        } })) : null,
        aIdentifier.length ? el('button', { type: 'button', classe: 'cfg-bouton inv-bouton-lecture', surclick: () => scannerScelles(c) },
          logoQr(), el('span', { texte: ` Identifier ${aIdentifier.length > 1 ? `les ${aIdentifier.length}` : 'le contenant'}` })) : null));
    majBouton();
    return section;
  }

  /** Administration d'un emplacement : inventaires types acceptés (un ou plusieurs). */
  function blocTypesEmplacement(c) {
    const acceptes = modelesEmplacement(c);
    const autres = Object.values(structure.contenants).filter((x) => !x.supprime && x.modele && !acceptes.includes(x.id))
      .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
    const idSel = idChamp();
    const sel = el('select', { id: idSel }, el('option', { value: '', texte: autres.length ? 'Choisir un autre inventaire type…' : 'Aucun autre inventaire type' }),
      ...autres.map((t) => el('option', { value: t.id, texte: t.nom })));
    // Nom générique : l'emplacement prend à sa création le nom du premier modèle (« LP15 ») ; avec plusieurs
    // modèles, il faut un nom qui les couvre tous (« Scope/défibrillateur »), affiché en check-list.
    const nomDeModele = (liste) => liste.some((m) => cle((contenant(m) || {}).nom) === cle(c.nom));
    const renommer = () => {
      const champNom = document.getElementById('inv-nom');
      if (champNom) { champNom.scrollIntoView({ block: 'center' }); champNom.focus(); champNom.select(); }
    };
    const fixer = (liste) => {
      const avant = acceptes.length;
      const si = c.emplacement && c.emplacement.si;
      c.emplacement = liste.length > 1 ? { modele: liste[0], modeles: liste } : { modele: liste[0] };
      if (si) c.emplacement.si = si;
      marquer(c.id);
      rendre({ garderPosition: true });
      if (avant < 2 && liste.length > 1 && nomDeModele(liste)) setTimeout(renommer, 50);
    };
    const alerteNom = acceptes.length > 1 && nomDeModele(acceptes)
      ? el('p', { classe: 'inv-alerte-nom' },
        `Cet emplacement porte le nom d'un des modèles (« ${c.nom} »). Donnez-lui un nom générique, par exemple « Scope/défibrillateur » : c'est ce nom que voit l'agent en check-list. `,
        el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Renommer', surclick: renommer }))
      : null;
    return el('section', { classe: 'note-parc inv-note-emplacement inv-types-emplacement' },
      el('strong', { texte: 'Emplacement — inventaires types acceptés' }),
      alerteNom,
      el('p', { classe: 'aide-question', texte: 'Avec plusieurs modèles (ex. scopes de marques différentes, ou un même scope avec des pochettes différentes), l\'agent choisit en check-list le modèle présent d\'après sa photo : mettez une vignette ou une photo sur chaque inventaire type. Des modèles de la même famille (noms qui commencent pareil, ex. « Tempus LS … ») : le premier (★) est proposé.' }),
      el('ul', {}, ...acceptes.map((m) => {
        const t = contenant(m);
        const premier = acceptes[0] === m;
        return el('li', {}, t ? el('a', { href: lien(t.id), texte: t.nom }) : '(supprimé)', t && !t.photo && !t.vignette ? el('small', { classe: 'inv-desaffecte', texte: ' sans photo' }) : null,
          acceptes.length > 1 && premier ? el('small', { classe: 'inv-propose', texte: ' ★ proposé en premier' }) : null,
          // Le premier modèle de la liste est proposé en check-list quand tous sont de la même famille (ex. Tempus LS).
          acceptes.length > 1 && !premier ? el('button', { type: 'button', classe: 'cfg-mini', 'aria-label': `Proposer ${t ? t.nom : 'ce modèle'} en premier`, title: 'Proposer en premier', texte: '★',
            surclick: () => fixer([m, ...acceptes.filter((x) => x !== m)]) }) : null,
          acceptes.length > 1 ? el('button', { type: 'button', classe: 'cfg-mini danger', 'aria-label': `Retirer ${t ? t.nom : 'ce modèle'}`, texte: '✕',
            surclick: () => {
              const occ = enfants(c.id)[0];
              if (occ && occ.source === m) { messageVue(`« ${occ.nom} » occupe l'emplacement : ce modèle ne peut pas être retiré.`, 'erreur'); return; }
              fixer(acceptes.filter((x) => x !== m));
            } }) : null);
      })),
      el('div', { classe: 'cfg-ligne' }, sel, el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Accepter aussi', disabled: !autres.length,
        surclick: () => { if (sel.value) fixer([...acceptes, sel.value]); } })),
      blocConditionEmplacement(c));
  }

  /**
   * « Attendu seulement si… » : l'emplacement n'existe en check-list que si un autre emplacement du même ensemble
   * (ex. « Scope/défibrillateur » du véhicule) est occupé par l'un des modèles cochés (ex. Schiller T7).
   */
  function blocConditionEmplacement(c) {
    const si = c.emplacement.si || null;
    const racine = chemin(c.id)[0];
    const dedans = new Set(descendants(c.id).map((x) => x.id));
    const candidats = descendants(racine.id).filter((x) => x.emplacement && !dedans.has(x.id) && !dansUnModele(x.id) === !dansUnModele(c.id))
      .filter((x) => !(x.emplacement.si && x.emplacement.si.emplacement === c.id));
    const nomPlace = (x) => { const ou = contenant(x.parent); return `${x.nom}${ou ? ` (${ou.nom})` : ''}`; };
    const fixerSi = (nv) => {
      if (nv && nv.emplacement && nv.modeles.length) c.emplacement.si = nv; else delete c.emplacement.si;
      marquer(c.id);
      rendre({ garderPosition: true });
    };
    const idSel = idChamp();
    const sel = el('select', { id: idSel, surchange: (e) => {
      const cible = contenant(e.target.value);
      if (!cible) { fixerSi(null); return; }
      // Emplacement choisi, modèles pas encore cochés : rien n'est enregistré tant qu'aucun modèle n'est coché.
      if (!(si && si.emplacement === cible.id)) { c.emplacement.si = { emplacement: cible.id, modeles: [] }; rendre({ garderPosition: true }); }
    } },
    el('option', { value: '', texte: 'Toujours attendu' }),
    ...candidats.map((x) => el('option', { value: x.id, selected: Boolean(si && si.emplacement === x.id), texte: `Seulement si « ${nomPlace(x)} » est…` })));
    const cible = si ? contenant(si.emplacement) : null;
    const coches = cible ? el('div', { classe: 'puces', role: 'group', 'aria-label': 'Modèles qui rendent cet emplacement attendu' },
      ...modelesEmplacement(cible).flatMap((m) => {
        const t = contenant(m);
        const i = idChamp();
        return [el('input', { type: 'checkbox', id: i, checked: si.modeles.includes(m), surchange: (e) => {
          const l = e.target.checked ? [...si.modeles, m] : si.modeles.filter((x) => x !== m);
          if (l.length) fixerSi({ emplacement: si.emplacement, modeles: modelesEmplacement(cible).filter((x) => l.includes(x)) });
          else { c.emplacement.si = { emplacement: si.emplacement, modeles: [] }; rendre({ garderPosition: true }); }
        } }), el('label', { for: i, texte: t ? t.nom : '(supprimé)' })];
      })) : null;
    const resume = cible && si.modeles.length
      ? `En check-list, « ${c.nom} » n'apparaît que si « ${cible.nom} » est ${si.modeles.map((m) => `« ${(contenant(m) || {}).nom || '?'} »`).join(' ou ')}.`
      : (cible ? 'Cochez le ou les modèles qui rendent cet emplacement attendu.' : 'Ex. pochette accessoires attendue seulement si le scope du véhicule est un Schiller.');
    return el('div', { classe: 'inv-condition-emplacement' },
      el('label', { for: idSel, classe: 'inv-libelle', texte: 'Attendu seulement si…' }), sel, coches,
      el('p', { classe: 'aide-question', texte: resume }),
      !candidats.length ? el('p', { classe: 'aide-question', texte: 'Aucun autre emplacement dans cet inventaire : ajoutez d\'abord celui dont dépend celui-ci (ex. « Scope/défibrillateur »).' }) : null);
  }

  /** Gestion : contenant vérifié par la check-list ambulancier (véhicule, éléments vérifiés ici). */
  function blocChoixAmbulancier(c) {
    const id = idChamp();
    const auto = primaireDe(c.id);
    // Le véhicule est celui du contenant primaire (champ « Véhicule » de sa fiche) : rien à préciser ici.
    const vAuto = vehiculeAmbulancier({ ...c, clAmbulancier: 'auto' });
    const regler = (faire) => { faire(); marquer(c.id); rendre({ garderPosition: true }); };
    const bloc = el('div', { classe: 'champ inv-choix-ambulancier' },
      el('label', { classe: 'cfg-case inv-case-fiche', for: id },
        el('input', { type: 'checkbox', id, checked: Boolean(c.clAmbulancier), surchange: (e) => regler(() => {
          if (e.target.checked) c.clAmbulancier = 'auto'; else { delete c.clAmbulancier; delete c.clElements; }
        }) }),
        el('span', {}, 'Vérifié par la check-list ambulancier',
          el('small', { texte: vAuto ? `check-list de ${vAuto.nom || vAuto.id}, le véhicule de ce contenant primaire`
            : (auto ? 'véhicule du contenant primaire' : 'véhicule du contenant primaire de chaque exemplaire') }))));
    if (!c.clAmbulancier) {
      bloc.append(el('p', { classe: 'aide-question', texte: 'La gommette passe au vert quand la check-list ambulancier du jour est faite ; un clic montre ce qui a été relevé.' }));
      return bloc;
    }
    if (auto && !vAuto) {
      bloc.append(el('p', { classe: 'note-parc anomalie', texte: `« ${auto.nom} » n'est relié à aucun véhicule : choisissez-le dans le champ « Véhicule » de sa fiche.` }));
    }
    // Ancien réglage (véhicule choisi ici) : on suit désormais le véhicule du contenant primaire.
    if (c.clAmbulancier !== 'auto' && vAuto && vAuto.id === c.clAmbulancier) c.clAmbulancier = 'auto';
    if (c.clAmbulancier !== 'auto' && vAuto) {
      bloc.append(el('p', { classe: 'note-parc anomalie' }, `Réglé sur la check-list de ${c.clAmbulancier}, alors que le contenant primaire est ${vAuto.nom || vAuto.id}. `,
        el('button', { type: 'button', classe: 'lien', texte: `Suivre ${vAuto.nom || vAuto.id}`, surclick: () => regler(() => { c.clAmbulancier = 'auto'; }) })));
    }
    const v = c.clAmbulancier === 'auto' ? vAuto : listeVehicules().find((x) => x.id === c.clAmbulancier);
    const elements = elementsAmbulancier(v || null);
    const choisis = new Set(c.clElements || []);
    const groupes = [...new Set(elements.map((x) => x.groupe))];
    bloc.append(el('p', { classe: 'aide-question', texte: 'Éléments vérifiés ici (aucun coché : tous les niveaux d\'oxygène) :' }),
      ...groupes.map((g) => el('fieldset', { classe: 'inv-amb-groupe' }, el('legend', { texte: g }),
        ...elements.filter((x) => x.groupe === g).map((x) => {
          const i = idChamp();
          return el('label', { classe: 'cfg-case', for: i },
            el('input', { type: 'checkbox', id: i, checked: choisis.has(x.cle), surchange: (e) => regler(() => {
              const s2 = new Set(c.clElements || []);
              if (e.target.checked) s2.add(x.cle); else s2.delete(x.cle);
              if (s2.size) c.clElements = [...s2]; else delete c.clElements;
            }) }), el('span', { texte: x.nom }));
        }))));
    return bloc;
  }

  /**
   * Gestion : véhicule de la check-list ambulancier relié à ce contenant primaire. Les deux check-lists partagent
   * alors la photo du véhicule (vignette ci-dessous, affichée aussi sur la case du véhicule côté ambulancier)
   * et leur état du jour (check-list ambulancier visible ici, inventaire IADE visible sur la case du véhicule).
   */
  function blocVehicule(c) {
    const id = idChamp();
    const parNom = vehiculeDuNom(c);
    const option = (valeur, texte) => el('option', { value: valeur, texte, selected: (c.vehicule || '') === valeur });
    const v = vehiculeDuPrimaire(c);
    return el('div', { classe: 'champ inv-choix-vehicule' },
      el('label', { for: id, texte: 'Véhicule (check-list ambulancier)' }),
      el('select', { id, surchange: (e) => {
        if (e.target.value) c.vehicule = e.target.value; else delete c.vehicule;
        marquer(c.id); rendre({ garderPosition: true });
      } }, option('', parNom ? `D'après le nom : ${parNom.nom || parNom.id}` : 'D\'après le nom (aucun véhicule reconnu)'),
      ...listeVehicules().filter((x) => !x.inactif || x.id === c.vehicule).map((x) => option(x.id, x.nom || x.id)),
      option('-', 'Aucun véhicule (réserve, pièce…)')),
      el('p', { classe: 'aide-question', texte: v
        ? `Relié à ${v.nom || v.id} : la vignette est aussi la photo du véhicule dans la check-list ambulancier ; l'état de chaque check-list du jour est visible de l'autre côté.`
        : 'Sans véhicule relié, rien n\'est partagé avec la check-list ambulancier.' }));
  }

  /**
   * Vignette d'un contenant primaire sur la page des inventaires : une image qui le désigne (photo du
   * véhicule, porte de la réserve…) plutôt que la photo d'inventaire. Celle d'un inventaire type se répercute sur
   * ses exemplaires comme la photo ; un exemplaire peut en avoir une propre (personnalisation). Sans vignette,
   * la photo principale est utilisée.
   */
  function blocVignette(c) {
    const prendre = idChamp();
    const choisir = idChamp();
    const apercu = el('span', { classe: 'inv-vignette-apercu', 'aria-hidden': 'true' });
    const montrer = (d) => { if (d) apercu.append(el('img', { src: d, alt: '' })); };
    if (c.vignette) { if (Photos.enMemoire(c.vignette)) montrer(Photos.enMemoire(c.vignette)); else obtenirPhoto(c.vignette).then(montrer); }
    const remplacer = async (id) => {
      if (c.vignette && c.vignette.startsWith('local-')) await Photos.supprimer(c.vignette);
      c.vignette = id;
      marquer(c.id);
      rendre({ garderPosition: true });
    };
    const recevoir = async (e) => {
      const fichier = e.target.files[0];
      e.target.value = '';
      if (!fichier) return;
      try {
        const donnees = await Recadrage.photo(fichier, { cote: 480, max: PHOTO_MAX, carre: true, titre: 'Cadrer la vignette' });
        if (!donnees) return;
        const id = `local-${nouvelId()}`;
        await Photos.ecrire(id, donnees);
        await remplacer(id);
      } catch (err) {
        messageVue('Photo illisible ou trop lourde : réessayez.', 'erreur');
      }
    };
    return el('div', { classe: 'champ inv-vignette-primaire' },
      el('span', { classe: 'inv-libelle', texte: 'Vignette de la page des inventaires' }),
      el('div', { classe: 'inv-vignette-ligne' }, c.vignette ? apercu : null,
        el('div', { classe: 'champ-photo' },
          el('label', { for: prendre, classe: 'bouton-photo', texte: c.vignette ? '📷 Reprendre' : '📷 Prendre la photo' }),
          el('input', { type: 'file', id: prendre, accept: 'image/*', capture: 'environment', classe: 'invisible', surchange: recevoir }),
          el('label', { for: choisir, classe: 'bouton-photo', texte: 'Choisir une image' }),
          el('input', { type: 'file', id: choisir, accept: 'image/*', classe: 'invisible', surchange: recevoir }),
          c.vignette ? el('button', { type: 'button', classe: 'lien danger', texte: 'Retirer', surclick: () => remplacer('') }) : null)),
      el('p', { classe: 'aide-question', texte: (c.vignette
        ? 'Image affichée dans la liste des contenants (cadre carré).'
        : 'Une image qui désigne ce contenant (ex. photo du véhicule). Sans vignette, la liste affiche la photo d\'inventaire.')
        + (c.modele ? ' Elle se répercute sur les exemplaires avec le reste du type.' : '') }));
  }

  // ---------- Gestion d'un contenant (administrateurs) : onglets Contenu / Réglages / Étiquette / Exemplaires ----------
  /*
   * Avant, la page d'un contenant en gestion empilait tout (nom, catégorie, cases à cocher, photo,
   * sous-inventaires, articles, étiquette, suppression) sur plusieurs écrans. Elle est rangée en onglets,
   * dans la barre collée en haut : ce qu'on fait le plus souvent (photo, sous-inventaires, articles)
   * est dans « Contenu », ouvert par défaut ; le paramétrage du contenant dans « Réglages ».
   */
  function ongletsGestion(c) {
    const m = racineModele(c.id);
    const liste = [['contenu', 'Contenu'], ['reglages', 'Réglages']];
    if (!c.emplacement) liste.push(['etiquette', 'Étiquette']);
    if (m) liste.push(['exemplaires', `Exemplaires ${exemplairesReels(m.id).length}`]);
    return liste;
  }
  /** Pastilles d'état sous le nom : ce qu'est ce contenant, d'un coup d'œil, quel que soit l'onglet. */
  function pastillesGestion(c) {
    const p = (texte, classe = '', titre = '') => el('span', { classe: `inv-pastille-etat ${classe}`, texte, title: titre || texte });
    const r = racineExemplaire(c.id);
    const veh = c.categorie === 'primaire' && !dansUnModele(c.id) ? vehiculeDuPrimaire(c) : null;
    return el('div', { classe: 'inv-pastilles-etat' },
      c.emplacement ? p('Emplacement', 'emplacement', 'Place attendant un contenant mobile')
        : (c.categorie ? p(CATEGORIES_CONTENANT[c.categorie].nom, c.categorie, CATEGORIES_CONTENANT[c.categorie].aide) : p('Sans catégorie', 'alerte', 'Choisissez une catégorie dans Réglages')),
      c.modele ? p('Inventaire type', 'type') : (dansUnModele(c.id) ? p('Dans un inventaire type', 'type') : null),
      r ? p('Exemplaire', 'exemplaire', 'Copie d\'un inventaire type') : null,
      c.scellable ? p('🔒 Scellable') : null,
      estVrac(c) ? p('Scan en vrac') : null,
      c.clAmbulancier ? p('Vérifié par l\'ambulancier') : null,
      c.traceur ? p(`Traceur ${c.traceur}`) : null,
      veh ? p(`Véhicule ${veh.nom || veh.id}`) : null);
  }
  /** Case à cocher d'un réglage, avec son explication en dessous. */
  function caseReglage(libelle, aide, coche, surChange) {
    const i = idChamp();
    return el('label', { classe: 'cfg-case inv-case-fiche', for: i },
      el('input', { type: 'checkbox', id: i, checked: coche, surchange: (e) => surChange(e.target.checked) }),
      el('span', {}, libelle, el('small', { texte: aide })));
  }
  function groupeReglages(titre, ...contenu) {
    const enfantsUtiles = contenu.flat().filter(Boolean);
    if (!enfantsUtiles.length) return null;
    return el('section', { classe: 'inv-groupe-reglages' }, el('h2', { texte: titre }), ...enfantsUtiles);
  }
  function ongletReglages(c) {
    const modele = dansUnModele(c.id);
    const groupeCategorie = idChamp();
    const choixCategorie = c.emplacement ? null : el('div', { classe: 'champ inv-choix-categorie' },
      el('span', { classe: 'inv-libelle', id: groupeCategorie, texte: 'Catégorie' }),
      el('div', { classe: 'puces', role: 'radiogroup', 'aria-labelledby': groupeCategorie },
        ...Object.entries(CATEGORIES_CONTENANT).flatMap(([cle, v]) => {
          const i = idChamp();
          return [el('input', { type: 'radio', name: groupeCategorie, id: i, checked: c.categorie === cle, surchange: () => { c.categorie = cle; marquer(c.id); rendre({ garderPosition: true }); } }),
            el('label', { for: i, title: v.aide, texte: v.nom })];
        })),
      el('p', { classe: 'aide-question', texte: c.categorie ? `${CATEGORIES_CONTENANT[c.categorie].aide.replace(/^./, (x) => x.toUpperCase())}.${c.categorie === 'primaire' ? ' Affiché sur la page des inventaires.' : ' S\'ouvre depuis son contenant, par QR code, NFC ou recherche.'}` : 'Seuls les contenants primaires sont affichés sur la page des inventaires.' }));
    return [
      groupeReglages('Identité',
        el('div', { classe: 'champ inv-champ-nom' }, el('label', { for: 'inv-nom', texte: 'Nom' }),
          el('input', { id: 'inv-nom', maxlength: '80', valeur: c.nom, surchange: (e) => { const t = e.target.value.trim(); if (t) { c.nom = t; marquer(c.id); rendre({ garderPosition: true }); } else e.target.value = c.nom; } })),
        choixCategorie,
        c.categorie === 'primaire' && !modele ? blocVehicule(c) : null,
        c.categorie === 'primaire' || c.modele || (contenant(c.source) || {}).modele ? blocVignette(c) : null),
      c.emplacement ? null : groupeReglages('Vérification',
        caseReglage('Contenant scellable', 'fermé par un scellé (plomb) une fois vérifié : en check-list, « Est-il scellé ? » évite de refaire l\'inventaire', c.scellable,
          (v) => { c.scellable = v; marquer(c.id); rendre({ garderPosition: true }); }),
        !modele ? caseReglage('Inventaire libre (scan en vrac)', 'pas de liste attendue : l\'agent scanne à la volée le matériel présent, compté ensuite par type', c.vrac === true,
          (v) => { if (v) c.vrac = true; else delete c.vrac; marquer(c.id); rendre({ garderPosition: true }); }) : null,
        c.parent ? blocChoixAmbulancier(c) : null,
        c.categorie === 'mobile' && !modele && typeof Traceurs !== 'undefined' ? blocTraceur(c) : null),
      !c.parent && !racineExemplaire(c.id) && !c.emplacement ? groupeReglages('Série de contenants identiques',
        caseReglage('Inventaire type', 'sert de structure à des exemplaires identiques (ex. les 7 sacs d\'intervention) ; il ne se vérifie pas. L\'onglet « Exemplaires » apparaît une fois coché.', c.modele === true,
          (v) => { if (v) c.modele = true; else delete c.modele; marquer(c.id); rendre({ garderPosition: true }); })) : null,
      blocActions(c),
    ];
  }
  function vueGestion(c) {
    const fils = enfants(c.id);
    const onglets = ongletsGestion(c);
    if (!onglets.some(([cle]) => cle === ongletGestion)) ongletGestion = 'contenu';
    const barre = barreContenant(c, { h1: true });
    // Onglets dans la barre collée en haut : on change d'onglet sans remonter la page.
    barre.append(pastillesGestion(c), el('div', { classe: 'inv-onglets-gestion', role: 'tablist', 'aria-label': 'Sections du contenant' },
      ...onglets.map(([cle, nom]) => el('button', {
        type: 'button', role: 'tab', classe: 'inv-onglet-gestion', 'aria-selected': String(ongletGestion === cle), 'aria-controls': 'inv-panneau-gestion',
        texte: nom, surclick: () => { if (ongletGestion === cle) return; ongletGestion = cle; rendre({ garderPosition: true }); window.scrollTo(0, 0); },
      }))));
    let panneau;
    if (ongletGestion === 'reglages') panneau = ongletReglages(c);
    else if (ongletGestion === 'etiquette') panneau = [blocEtiquette(c)];
    else if (ongletGestion === 'exemplaires') panneau = [blocModele(c)];
    else {
      panneau = [
        blocExemplaire(c),
        c.emplacement ? blocTypesEmplacement(c) : null,
        // Inventaire libre : pas de liste, on le rappelle plutôt que d'afficher un bloc d'articles inutile.
        estVrac(c) ? el('p', { classe: 'note-parc', texte: 'Inventaire libre : en check-list, l\'agent scanne le matériel présent (pas de liste attendue). Réglage dans l\'onglet « Réglages ».' }) : null,
        c.clAmbulancier ? el('p', { classe: 'note-parc', texte: 'Vérifié par la check-list ambulancier du véhicule (réglage dans « Réglages »).' }) : null,
        blocPhoto(c, fils),
        ...[].concat(blocEnfants(c, fils)),
        c.emplacement ? null : blocArticles(c),
      ];
    }
    return [
      barre,
      bandeauGestion(c),
      boutonRepercuter(c),
      ligneSynchro(), ligneAvis(),
      c.desaffecte && !c.parent ? el('p', { classe: 'note-parc anomalie' }, el('strong', { texte: 'Désaffecté — à retrouver. ' }),
        `Était dans ${c.desaffecte.deNom || '?'}. `,
        el('button', { type: 'button', classe: 'lien', texte: 'Publier une alerte sur le mur', surclick: () => publierARetrouver(c) })) : null,
      el('div', { id: 'inv-panneau-gestion', role: 'tabpanel', classe: 'inv-panneau-gestion' }, ...panneau.flat().filter(Boolean)),
      el('p', { classe: 'message inv-message', role: 'alert', hidden: true }),
    ];
  }

  function vueContenant(c) {
    if (edition) return vueGestion(c);
    const fils = enfants(c.id);
    const b = bilan(c.id);
    const v = verifDuJour(c.id);
    // Ouvert depuis une recherche par le nom, sans dire où l'on est : consultation seule.
    const consultation = enConsultation(c);
    // Check-list d'un contenant scellable pas encore vérifié aujourd'hui : on demande d'abord s'il est scellé.
    const questionScelle = !consultation && !dansUnModele(c.id) && c.scellable && !b.complet && !reponsesScelle.has(c.id);
    const modele = dansUnModele(c.id);
    const verification = c.emplacement || questionScelle || modele || (c.clAmbulancier && !aCocher(c).length) ? null
      : (consultation ? (estVrac(c) ? blocVrac(c, true) : blocConsultation(c)) : (estVrac(c) ? blocVrac(c) : blocVerification(c)));
    const avecPhoto = vuesDe(c).some((x) => x.photo);
    // Repère « Photo » posé dans la liste (gestion des inventaires) : c'est lui qui décide de la place de la photo,
    // avant comme après validation. En tête de liste : la photo passe avant la liste.
    const iPhoto = !consultation && !estVrac(c) && aCocher(c).length ? reperePhoto(c) : -1;
    const photoDansListe = Boolean(verification) && iPhoto > 0 && avecPhoto;
    const listeAvant = Boolean(verification) && !consultation && !v && avecPhoto && iPhoto < 0;
    return [
      // Contenant primaire : son nom est déjà dans le bandeau « Vous vérifiez actuellement … ».
      barreContenant(c, { h1: !(c.categorie === 'primaire' && !gestion) }),
      bandeauGestion(c),
      ligneSynchro(), ligneAvis(),
      blocModele(c),
      c.emplacement ? (() => {
        const type = contenant(c.emplacement.modele);
        const occ = enfants(c.id)[0];
        const autres = modelesEmplacement(c).slice(1).map(contenant).filter(Boolean);
        if (autres.length) {
          return el('p', { classe: 'note-parc inv-note-emplacement' }, el('strong', { texte: 'Emplacement. ' }),
            `Accepte : ${[type, ...autres].filter(Boolean).map((t) => t.nom).join(', ')}. `,
            occ ? `Actuellement : « ${occ.nom} ».` : 'Vide pour l\'instant : le modèle et l\'exemplaire seront identifiés en check-list.');
        }
        return el('p', { classe: 'note-parc inv-note-emplacement' }, el('strong', { texte: 'Emplacement. ' }),
          `Attend : ${type ? type.nom : '(supprimé)'}. `,
          occ ? `Actuellement : « ${occ.nom} ».` : 'Vide pour l\'instant : l\'exemplaire sera identifié en check-list.');
      })() : null,
      c.desaffecte && !c.parent ? el('p', { classe: 'note-parc anomalie' }, el('strong', { texte: 'Désaffecté — à retrouver. ' }),
        `Était dans ${c.desaffecte.deNom || '?'}. Il sera réaffecté dès qu'on l'identifiera à sa place lors d'une vérification. `,
        c.desaffecte.ignore ? el('small', { classe: 'inv-trace', texte: `Alerte ignorée${c.desaffecte.ignore.par ? ` par ${c.desaffecte.ignore.par}` : ''}${c.desaffecte.ignore.le ? ` le ${new Date(c.desaffecte.ignore.le).toLocaleDateString('fr-FR')}` : ''}. ` }) : null,
        el('button', { type: 'button', classe: 'lien', texte: 'Publier une alerte sur le mur', surclick: () => publierARetrouver(c) })) : null,
      ...(questionScelle ? [blocQuestionScelle(c)] : []),
      !consultation && !modele && !questionScelle && !gestion ? blocScellesGroupes(c) : null,
      c.clAmbulancier && !modele ? blocNiveauxOxygene(c) : null,
      // Check-list : pas de récapitulatif (place laissée à la photo ; l'état se lit sur les gommettes).
      modele || !gestion ? null : el('p', { classe: `inv-statut ${b.classe}` },
        el('strong', { texte: `${b.complet ? '✓ ' : ''}${b.texte}` }),
        el('span', { classe: 'inv-badges' }, ...badges(b))),
      // Photo de navigation ET éléments à cocher, sans repère « Photo » : la liste passe avant la photo
      // tant que l'inventaire n'est pas validé (pour ne pas l'oublier), puis redescend sous la photo.
      ...(listeAvant ? [].concat(verification) : []),
      questionScelle || photoDansListe ? null : blocPhoto(c, fils),
      ...(questionScelle || photoDansListe ? [] : [].concat(blocEnfants(c, fils))),
      c.emplacement || questionScelle || !modele ? null : blocContenuModele(c),
      ...(verification && !listeAvant ? [].concat(verification) : []),
      !aCocher(c).length && !fils.length && !estVrac(c) ? el('p', { classe: 'consigne', texte: estAdmin() ? 'Inventaire vide : menu > Administration > Gestion des inventaires pour ajouter une photo, des sous-inventaires ou des articles.' : 'Cet inventaire est vide pour l\'instant.' }) : null,
      (!aCocher(c).length && !(estVrac(c) && verification)) || consultation ? el('p', { classe: 'message inv-message', role: 'alert', hidden: true }) : null,
    ];
  }

  /** Consultation seule (recherche par le nom sans contenant primaire) : le contenu, sans case à cocher. */
  /** Péremption mise à jour hors inventaire (consultation d'un contenant mobile) : locale tout de suite, envoyée au retour du réseau. */
  function enregistrerPeremption(c, a, iso) {
    const maj = new Date().toISOString();
    const ok = App.mettreEnFile({ action: 'majPeremption', contenant: c.id, article: a.id,
      detail: { chemin: cheminNoms(c.id, ' > '), nom: nomArticle(a), peremption: iso } });
    if (!ok) { messageVue('Non enregistré : la mémoire de l\'appareil est pleine.', 'erreur'); return; }
    etat.peremptions[`${c.id}/${a.id}`] = { date: iso, maj };
    sauverEtat();
  }
  function blocConsultation(c) {
    const articles = aCocher(c);
    if (!articles.length) return null;
    const p = primaireDe(c.id);
    // Sans contenant primaire précisé : pas d'inventaire, mais les péremptions restent modifiables (quel que soit l'accès).
    const datesModifiables = true;
    const ici = contenant(contexte.primaire);
    const ailleurs = ici && p && p.id !== ici.id && !contexte.consultation;
    return el('section', { classe: 'inv-section inv-consultation' },
      el('div', { classe: 'inv-liste-entete' }, el('h2', {}, 'Contenu ', el('span', { classe: 'inv-compte', texte: String(articles.length) }))),
      el('p', { classe: 'aide-question', texte: ailleurs
        ? `Consultation seule : ce contenant est enregistré dans ${p.nom}. Pour le vérifier dans ${ici.nom}, ouvrez sa place dans ${ici.nom} et identifiez-le (QR code, NFC ou liste).`
        : p
        ? `Consultation seule. Pour vérifier : touchez « Je suis dans ${p.nom} » en haut, ou scannez l'étiquette sur place.`
        : 'Consultation seule. Pour vérifier : choisissez en haut le contenant primaire où vous êtes.' }),
      datesModifiables && articles.some(suiviPeremption) ? el('p', { classe: 'aide-question', texte: 'Les dates de péremption restent modifiables : chaque date est enregistrée dès sa saisie.' }) : null,
      el('ul', { classe: 'inv-liste-modele' }, ...c.articles.filter((a) => !estReperePhoto(a)).map((a) => {
        if (a.separateur) return el('li', { classe: 'inv-separation', texte: a.nom });
        const date = suiviPeremption(a) ? datePeremption(c.id, a.id) : '';
        const pe = suiviPeremption(a) ? etatPeremption(date) : null;
        if (datesModifiables && suiviPeremption(a)) {
          // Contenant mobile sans contenant primaire : pas d'inventaire, mais les péremptions se mettent à jour.
          const li = el('li', { classe: pe.niveau }, nomArticle(a),
            a.quantite ? el('span', { classe: 'inv-qte-attendue', texte: ` × ${a.quantite}` }) : null);
          const echeance = el('small', { classe: 'inv-consultation-date', texte: pe.texte ? ` ${pe.texte}` : '' });
          const champ = el('input', { inputmode: 'numeric', autocomplete: 'off', placeholder: 'MM/AAAA', classe: 'inv-date',
            'aria-label': `Péremption de ${nomArticle(a)}`, valeur: afficherDate(date),
            surchange: (e) => {
              const iso = analyserDate(e.target.value);
              if (iso === null) { echeance.textContent = ' Date non reconnue'; li.className = 'perime'; return; }
              e.target.value = afficherDate(iso);
              enregistrerPeremption(c, a, iso);
              const n = etatPeremption(iso);
              echeance.textContent = n.texte ? ` ${n.texte}` : '';
              li.className = n.niveau;
            } });
          li.append(el('div', { classe: 'inv-peremption' }, el('span', { texte: 'Pér. ' }), champ, echeance));
          const note = noteCommentaire(a);
          if (note) li.append(note);
          return li;
        }
        return el('li', { classe: pe ? pe.niveau : '' }, nomArticle(a),
          a.quantite ? el('span', { classe: 'inv-qte-attendue', texte: ` × ${a.quantite}` }) : null,
          date ? el('small', { classe: 'inv-consultation-date', texte: ` · pér. ${afficherDate(date)}${pe.texte ? ` (${pe.texte})` : ''}` }) : null,
          noteCommentaire(a));
      })));
  }

  function rendre({ garderPosition = false, focus = '' } = {}) {
    fermerVisionneuse(); // l'afficheur immersif est recréé à chaque affichage
    if (!zone || zone.hidden) return;
    let id = idCourant();
    let c = contenant(id);
    // Check-list : un emplacement n'est pas un inventaire. On ouvre le contenant qui l'occupe ;
    // s'il est vide, on demande depuis le contenant du dessus lequel se trouve là.
    let identifierEmplacement = '';
    if (c && !gestion && c.emplacement) {
      // Pointé aujourd'hui ; sinon, à identifier de nouveau (sauf en consultation : rien à vérifier).
      const occ = occupantDuJour(c) || (contexte.consultation ? enfants(c.id)[0] : null);
      const dessus = parentVisible(c);
      if (occ) id = occ.id;
      else if (dessus) { id = dessus.id; if (!contexte.consultation && c.parent === dessus.id) identifierEmplacement = `emp:${c.id}`; }
      if (id !== c.id) { history.replaceState(null, '', lien(id)); c = contenant(id); }
    }
    // Véhicule désarmé : pas d'inventaire (lien, QR, NFC…) ; retour à la page des inventaires avec l'information.
    if (!gestion && c && !contexte.consultation && !dansUnMobile(c)) {
      const p = primaireDe(c.id);
      if (p && vehiculeDesarme(p)) {
        history.replaceState(null, '', lien(''));
        id = ''; c = null;
        setTimeout(() => infoDesarme(vehiculeDuPrimaire(p).id), 0);
      }
    }
    // Contenant primaire où l'on est : celui du contenant ouvert. La page des inventaires remet à zéro la consultation.
    if (!gestion) {
      if (!id) fixerContexte(contexte.primaire, false);
      // Seul un contenant fixe (pièce, véhicule, tiroir…) dit où l'on est ; un contenant mobile peut être ailleurs.
      else if (c && !contexte.consultation && !dansUnMobile(c)) { const p = primaireDe(c.id); if (p) fixerContexte(p.id, false); }
    }
    const nouveau = dernierAffiche !== id;
    let retourArriere = false;
    if (nouveau && dernierAffiche !== null) positionsDefilement.set(dernierAffiche, window.scrollY);
    dernierAffiche = id;
    if (nouveau) {
      const dejaVu = pile.lastIndexOf(id);
      retourArriere = dejaVu >= 0 && dejaVu < pile.length - 1;
      identification = '';
      typeChoisi = '';
      familleChoisie = '';
      typePropose = '';
      autoIdentifie = '';
      placement = '';
      confirmer = '';
      if (retourArriere) pile.length = dejaVu + 1;
      else pile.push(id);
      rattacher = '';
      rechercheAjout = '';
      creation = null;
      ajoutSousOuvert = false;
      ongletGestion = ongletDemande || 'contenu';
      ongletDemande = '';
    }
    if (identifierEmplacement) identification = identifierEmplacement;
    if (aIdentifier) { identification = aIdentifier; aIdentifier = ''; }
    // Même page redessinée (modification, synchro…) : on garde la hauteur pendant la reconstruction,
    // sinon la page vidée ramène le défilement en haut dès qu'une mesure force la mise en page.
    const yAvant = window.scrollY;
    if (!nouveau) zone.style.minHeight = `${zone.offsetHeight}px`;
    zone.innerHTML = '';
    const empId = identification.startsWith('emp:') ? identification.slice(4) : '';
    if (empId && contenant(empId) && contenant(empId).parent === id) {
      const occupant = enfants(empId)[0];
      zone.append(...vueIdentification(occupant || null, occupant ? '' : empId).filter(Boolean));
    } else if (identification === `dans:${id}`) {
      zone.append(...vueIdentification(null, id).filter(Boolean));
    } else if (identification && contenant(identification) && contenant(identification).parent === id) {
      zone.append(...vueIdentification(contenant(identification)).filter(Boolean));
    } else if (id === BASE) {
      identification = '';
      zone.append(...vueBase().filter(Boolean));
    } else if (id === TABLEAU) {
      identification = '';
      zone.append(...vueTableau().filter(Boolean));
    } else if (id && !c) {
      zone.append(el('h1', { tabindex: '-1', texte: 'Inventaire introuvable' }), ligneSynchro(),
        el('p', { classe: 'consigne', texte: synchro.enCours ? 'Chargement des inventaires…' : 'Cet inventaire n\'existe pas ou a été supprimé. Si vous venez de scanner une étiquette, elle n\'est plus à jour.' }),
        el('a', { classe: 'lien', href: lien(''), texte: '← Tous les inventaires' }));
    } else {
      const contenu = (c ? vueContenant(c) : vueRacine()).filter(Boolean);
      const arbre = c ? blocArborescence(c) : null;
      // Les barres du haut et du bas restent hors de la grille (pleine largeur, collées au bord de l'écran).
      const haut = contenu.filter((n) => n.classList && n.classList.contains('inv-barre-haut'));
      const bas = contenu.filter((n) => n.classList && n.classList.contains('inv-barre-bas'));
      const corps = contenu.filter((n) => !haut.includes(n) && !bas.includes(n));
      if (arbre) zone.append(...haut, el('div', { classe: 'inv-mise-en-page' }, el('div', { classe: 'inv-corps' }, ...corps), arbre), ...bas);
      else zone.append(...haut, ...corps, ...bas);
    }
    document.body.classList.toggle('inv-avec-valider', Boolean(zone.querySelector('.inv-barre-bas')));
    // Fond coloré dans un inventaire type, pour ne pas le confondre avec un inventaire réel.
    document.body.classList.toggle('inv-dans-modele', Boolean(c && dansUnModele(c.id)));
    // Une fois : l'appui long sur la flèche permet de remonter de plusieurs étages.
    if (nouveau && c && !gestion && etagesAuDessus(c).length > 1) {
      let vue = true;
      try { vue = localStorage.getItem(CLE_ASTUCE) === '1'; if (!vue) localStorage.setItem(CLE_ASTUCE, '1'); } catch (e) { /* stockage indisponible */ }
      if (!vue) alerteBreve('Astuce : maintenez la flèche ← pour remonter de plusieurs étages d\'un coup.');
    }
    // Sous-inventaire ouvert depuis la photo : il arrive en plein écran ; au retour, le parent
    // réapparaît à l'endroit où on l'avait laissé (même vue, même défilement).
    if (nouveau && c && !gestion) {
      zone.classList.remove('inv-entree', 'inv-sortie');
      void zone.offsetWidth; // relance l'animation
      zone.classList.add(retourArriere ? 'inv-sortie' : 'inv-entree');
    }
    if (!nouveau) {
      zone.style.minHeight = '';
      if (window.scrollY !== yAvant) window.scrollTo(0, yAvant);
    }
    if (focus && zone.querySelector(focus)) zone.querySelector(focus).focus();
    else if (nouveau && retourArriere && positionsDefilement.has(id)) {
      window.scrollTo(0, positionsDefilement.get(id));
      const titre = zone.querySelector('h1, #inv-nom');
      if (titre) titre.focus({ preventScroll: true });
    } else if (nouveau && !garderPosition) {
      const titre = zone.querySelector('h1, #inv-nom');
      zone.scrollIntoView({ block: 'start' });
      if (titre) titre.focus({ preventScroll: true });
    }
  }

  /** Réglages d'étiquette QR normalisés : largeur × hauteur (mm), logo, couleur, négatif, deux lignes libres. */
  function normEtiquette(e) {
    const mm = (v, d) => Math.min(150, Math.max(15, Math.round(Number(v) || d)));
    const largeur = mm(e.largeur || e.taille, 40);
    return { largeur, hauteur: mm(e.hauteur || e.taille, largeur),
      logo: ['nfc', 'smur'].includes(e.logo) ? e.logo : '',
      ...(/^#[0-9a-f]{6}$/i.test(e.couleur || '') && e.couleur.toLowerCase() !== '#1d4f9f' ? { couleur: e.couleur.toLowerCase() } : {}),
      ...(e.negatif === true ? { negatif: true } : {}),
      // Deux lignes libres (ex. nom et téléphone), imprimées en pied d'étiquette.
      ...(String(e.champ1 || '').trim() ? { champ1: String(e.champ1).trim().slice(0, 40) } : {}),
      ...(String(e.champ2 || '').trim() ? { champ2: String(e.champ2).trim().slice(0, 40) } : {}) };
  }

  // ---------- QR code, NFC, impression ----------
  function qrSvg(texte) {
    const q = qrcode(0, 'M');
    q.addData(texte);
    q.make();
    const n = q.getModuleCount();
    const marge = 4;
    let trace = '';
    for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) if (q.isDark(r, col)) trace += `M${col + marge} ${r + marge}h1v1h-1z`;
    return el('svg:svg', { classe: 'inv-qr', viewBox: `0 0 ${n + 2 * marge} ${n + 2 * marge}`, role: 'img', 'aria-label': 'QR code de cet inventaire' },
      el('svg:rect', { width: '100%', height: '100%', fill: '#fff' }), el('svg:path', { d: trace, fill: '#000' }));
  }

  /** Réglages d'étiquette d'un contenant (par défaut : carré de 40 mm, sans logo). */
  const reglageEtiquette = (c) => ({ largeur: 40, hauteur: 40, logo: '', ...(c.etiquette || {}) });
  const COULEURS_ETIQUETTE = { bleu: '#1D4F9F', fonce: '#163E7E', accent: '#163E7E', encre: '#13294B', orange: '#E07A12' };
  const COULEUR_DEFAUT_ETIQUETTE = '#1D4F9F';
  const PALETTE_ETIQUETTE = ['#1D4F9F', '#13294B', '#C62828', '#E07A12', '#2E7D32', '#6A1B9A', '#00838F', '#455A64'];
  /** Mélange une couleur « #rrggbb » avec du noir (t > 0) ou du blanc (t < 0). */
  function nuance(hex, t) {
    const n = parseInt(hex.slice(1), 16);
    const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(t >= 0 ? v * (1 - t) : v + (255 - v) * -t));
    return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  }
  function luminance(hex) {
    const n = parseInt(hex.slice(1), 16);
    const l = [n >> 16, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];
  }
  /**
   * Couleurs d'une étiquette. Normal : fond blanc, décor dans la couleur choisie (assombrie si trop claire pour
   * se lire sur du blanc). Négatif : fond de la couleur choisie, décor et textes en blanc ; le QR code reste
   * sombre sur une pastille blanche (beaucoup de lecteurs ne lisent pas un QR code inversé).
   */
  function paletteEtiquette(r) {
    let c = /^#[0-9a-f]{6}$/i.test(r.couleur || '') ? r.couleur : COULEUR_DEFAUT_ETIQUETTE;
    if (r.negatif) {
      while (luminance(c) > 0.3) c = nuance(c, 0.1); // texte blanc lisible sur le fond
      return { fond: c, bleu: '#fff', fonce: '#fff', accent: '#fff', encre: luminance(c) < 0.06 ? c : nuance(c, 0.55), tuile: '#fff', negatif: true };
    }
    while (luminance(c) > 0.25) c = nuance(c, 0.1);
    return { fond: '#fff', bleu: c, fonce: nuance(c, 0.25), accent: nuance(c, 0.25), encre: luminance(c) < 0.06 ? c : nuance(c, 0.55), tuile: '', negatif: false };
  }
  const LOGOS_ETIQUETTE = {
    nfc: (k) => [el('svg:rect', { x: 3, y: 2, width: 18, height: 20, rx: 3, fill: 'none', stroke: k.bleu, 'stroke-width': 1.8 }),
      el('svg:path', { d: 'M8 16V8l8 8V8', fill: 'none', stroke: k.bleu, 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })],
    smur: (k) => [el('svg:path', { d: 'M12 3v18M3 12h18', stroke: k.bleu, 'stroke-width': 4, 'stroke-linecap': 'round' })],
  };
  // Logo NFC officiel (N-Mark du NFC Forum), fourni par Louis et vectorisé (copie dans img/nfc-n-mark.svg).
  // Intégré au code pour s'afficher hors ligne et à l'impression.
  const LOGO_NFC = { viewBox: '0 0 900 901', d: 'M96.5 899.9C81.6 897.7 63.8 890.8 50.0 881.9C41.7 876.5 24.7 859.5 19.2 851.0C9.7 836.6 3.3 819.8 1.1 803.6C-0.4 792.7 -0.4 109.3 1.1 98.4C3.3 82.2 9.7 65.5 19.1 51.0C24.6 42.6 41.6 25.6 50.0 20.1C64.4 10.7 81.1 4.4 98.2 1.9C109.6 0.2 789.6 0.3 802.0 2.0C839.7 7.2 872.1 30.8 889.0 65.5C893.6 74.9 897.4 87.7 898.9 98.4C900.4 109.3 900.4 792.7 898.9 803.6C896.7 819.8 890.3 836.6 880.8 851.0C875.0 859.9 858.1 876.6 849.0 882.5C835.0 891.6 818.8 897.7 802.6 899.9C793.1 901.2 105.7 901.2 96.5 899.9ZM263.0 825.5C263.0 825.2 261.3 822.6 259.2 819.7C250.4 807.7 239.8 786.9 234.5 771.5C230.7 760.3 227.3 744.3 226.1 732.1C225.3 725.1 225.0 617.8 225.0 398.9L225.0 76.0L166.0 76.0C108.9 76.0 106.7 76.1 100.8 78.1C88.6 82.2 80.7 90.1 77.0 101.9C75.0 108.2 75.0 110.7 75.0 451.0C75.0 781.6 75.1 794.0 76.8 799.8C80.5 811.4 88.7 819.8 100.5 823.9C106.4 825.9 108.4 825.9 184.8 826.0C227.8 826.0 263.0 825.8 263.0 825.5ZM674.0 825.5C674.0 825.3 656.6 809.2 635.2 789.9C587.2 746.2 531.3 695.3 494.6 661.9C466.7 636.6 424.6 598.3 392.2 569.0L375.1 553.5L375.1 502.7L375.0 451.8L385.3 461.2C399.4 473.9 565.7 625.2 584.5 642.2L599.5 655.9L599.8 418.2C600.0 203.2 599.9 179.5 598.5 170.5C590.7 122.7 553.4 85.4 505.4 77.6C496.5 76.1 481.4 76.0 360.7 76.2L226.0 76.5L248.0 96.5C274.5 120.5 268.2 114.8 319.9 161.9C343.3 183.1 367.6 205.2 374.0 211.0C380.4 216.8 408.3 242.2 436.1 267.4C463.8 292.7 495.2 321.3 505.8 330.9L525.0 348.3L525.0 398.7C525.0 426.3 524.8 449.0 524.5 449.0C524.2 449.0 514.0 439.9 501.7 428.7C489.5 417.6 466.7 396.8 451.0 382.6C435.3 368.3 408.3 343.8 391.0 328.0C373.7 312.2 346.2 287.3 330.0 272.6L300.5 245.8L300.2 481.6C300.0 639.6 300.3 720.5 301.0 726.6C305.3 764.8 330.3 799.3 365.3 815.5C373.9 819.5 387.7 823.6 396.5 824.9C402.5 825.8 674.0 826.4 674.0 825.5ZM799.3 823.9C807.3 821.2 813.9 816.3 818.3 809.8C825.6 799.0 825.0 831.6 825.0 450.9C825.0 120.4 824.9 108.0 823.2 102.2C819.5 90.4 810.6 81.5 798.9 77.9C793.2 76.1 788.4 76.0 715.0 76.0L637.1 76.0L643.7 85.8C651.2 97.0 660.6 115.7 664.9 128.1C668.7 139.1 672.6 156.9 673.9 169.2C674.7 175.8 675.0 282.2 675.0 502.5L675.0 826.0L734.0 826.0C791.3 826.0 793.3 825.9 799.3 823.9Z' };
  // Identité graphique de l'appli (bandeau, index.html) : complexe QRS et silhouette d'Avignon
  // (pont Saint-Bénézet, rocher des Doms, Palais des Papes). Ligne de base à y = 38, hauteur utile ≈ 0–60.
  const TRACE_QRS = { l: 96, d: 'M0 38 l8 -6 l8 6 h10 l6 6 l10 -40 l10 52 l8 -18 h16 q10 -14 20 0' };
  const TRACE_AVIGNON = { l: 260, d: 'M0 38 H12 V31 l2 -3 H40 V23 h3 V19 h3 V23 l5 -3 l5 3 V28 H94 V20 h3 v-2.5 h3 v2.5 h3 v-2.5 h3 v2.5 V26 H110 L120 21 H124 V11 H126 V7 H128 V5 l0.5 -1.5 a1 1 0 1 1 1 0 l0.5 1.5 V7 H132 V11 H134 V21 H140 V6 h3 v-2.5 h3 v2.5 h3 v-2.5 h3 v2.5 V13 h2 v-2 h3 v2 h4 v-2 h3 v2 h2 V10 l2 -5 l2 5 H178 l2 -5 l2 5 V13 H188 V3 h3 v-2.5 h3 v2.5 h3 v-2.5 h3 v2.5 h3 v-2.5 h3 v2.5 V15 h2 v-2 h3 v2 h4 v-2 h3 v2 h2 V8 h3 v-2.5 h3 v2.5 h3 v-2.5 h3 v2.5 V20 L242 28 V38 H260',
    details: 'M12 38 H16 Q25 29 34 38 H38 Q47 29 56 38 H59 Q67 29 76 38 H79 Q87 29 95 38 M156 21 V17 Q160 11 164 17 V21 M191 21 V12 Q197 4 203 12 V21 M209 21 V18 Q213 12 217 18 V21 M223 21 V15 Q226 10 229 15 V21' };

  /** Coupe un texte en lignes et choisit la plus grande police (mm) qui tient dans le cadre donné. */
  /** Largeur réelle d'un texte (police de l'étiquette), rapportée à une taille de police de 1. */
  let toile = null;
  const largeursMesurees = new Map();
  function largeurTexte(t, gras) {
    const cle = `${gras ? 1 : 0}${t}`;
    if (largeursMesurees.has(cle)) return largeursMesurees.get(cle);
    let w = 0;
    try {
      toile = toile || document.createElement('canvas').getContext('2d');
      toile.font = `${gras ? '800' : 'italic 400'} 100px system-ui, sans-serif`;
      w = toile.measureText(t).width / 100;
    } catch (e) { w = 0; }
    // Repli (ou mesure aberrante) : estimation prudente, majuscules plus larges.
    if (!(w > 0)) w = [...t].reduce((sx, ch) => sx + (/[A-ZÀ-Ý0-9MW]/.test(ch) ? 0.72 : 0.58), 0) * (gras ? 1.05 : 0.95);
    largeursMesurees.set(cle, w);
    return w;
  }

  function ajusterTexte(texte, largeur, hauteur, maxPolice, maxLignes, gras = true) {
    largeur *= 0.94; // petite réserve : le texte ne touche jamais le cadre
    const mots = String(texte || '').split(/\s+/).filter(Boolean);
    if (!mots.length) return { lignes: [], police: 0 };
    // Meilleure police pour chaque nombre de lignes ; on ne coupe en plus de lignes que si le gain est net
    // (évite « Ampoulier / A »).
    const meilleur = {};
    for (let police = maxPolice; police >= 1; police -= 0.1) {
      const tient = (t) => largeurTexte(t, gras) * police <= largeur;
      const lignes = [];
      mots.forEach((m) => {
        const der = lignes[lignes.length - 1];
        if (der !== undefined && tient(`${der} ${m}`)) lignes[lignes.length - 1] = `${der} ${m}`;
        else lignes.push(m);
      });
      if (lignes.length <= maxLignes && lignes.every(tient) && lignes.length * police * 1.15 <= hauteur
        && !meilleur[lignes.length]) meilleur[lignes.length] = { lignes, police };
    }
    const choix = Object.keys(meilleur).map(Number).sort((x, y) => x - y);
    const plusGrande = Math.max(0, ...choix.map((nb) => meilleur[nb].police));
    const retenu = choix.find((nb) => meilleur[nb].police >= plusGrande * 0.8);
    if (retenu) return meilleur[retenu];
    return { lignes: [texte], police: 1 };
  }

  /**
   * Étiquette QR aux couleurs de l'appli, carrée ou rectangulaire (dimensions réelles en mm : le viewBox est en mm).
   * La zone calme (4 modules blancs) reste intacte : cadre bleu, coins verts, filet orange, textes et tracé sont autour.
   * Agencement selon les proportions :
   *  - carré : nom en gras en haut, primaire (immobile) en italique en bas ou, à défaut, tracé ECG + Avignon ;
   *  - paysage : QR à gauche, textes à droite sur plusieurs lignes, tracé en pied de la colonne de texte ;
   *  - portrait : QR en haut, textes dessous, tracé en pied.
   * Correction d'erreur H : le logo central reste lisible.
   */
  function etiquetteSvg(c, reglage = reglageEtiquette(c)) {
    const k = paletteEtiquette(reglage);
    const W = reglage.largeur, H = reglage.hauteur, petit = Math.min(W, H);
    const q = qrcode(0, 'H');
    q.addData(c.url || adresse(c.id));
    q.make();
    const n = q.getModuleCount();
    const primaire = c.categorie === 'immobile' ? chemin(c.id)[0] : null;
    const nom = c.nom || '';
    const sous = primaire && primaire.id !== c.id ? primaire.nom : '';
    const perso = [reglage.champ1, reglage.champ2].filter(Boolean);
    const ratio = W / H;
    const mode = ratio > 1.3 ? 'paysage' : (ratio < 0.77 ? 'portrait' : 'carre');

    const ep = Math.min(1.4, Math.max(0.5, petit * 0.025)); // épaisseur du cadre
    const marge = ep * 1.6; // du bord au cadre intérieur
    const coin = Math.min(7, petit * 0.18);
    const enfants = [
      el('svg:rect', { width: W, height: H, fill: k.fond }),
      el('svg:rect', { x: ep / 2 + 0.3, y: ep / 2 + 0.3, width: W - ep - 0.6, height: H - ep - 0.6, rx: Math.min(3, petit * 0.07), fill: 'none', stroke: k.bleu, 'stroke-width': ep }),
    ];
    const a = ep / 2 + 0.3, cr = Math.min(3, petit * 0.07);
    [[a, a, 1, 1], [W - a, a, -1, 1], [a, H - a, 1, -1], [W - a, H - a, -1, -1]].forEach(([x, y, sx, sy]) => enfants.push(el('svg:path', {
      d: `M${x} ${y + sy * coin}V${y + sy * cr}Q${x} ${y} ${x + sx * cr} ${y}H${x + sx * coin}`,
      fill: 'none', stroke: k.accent, 'stroke-width': ep * 1.7, 'stroke-linecap': 'round' })));

    // Emplacement du QR (zone calme comprise) et des zones de texte.
    let qr, zoneNom, zoneSous, zoneTrace;
    const ecart = marge + ep;
    if (mode === 'paysage') {
      const S = H - 2 * ecart;
      qr = { x: ecart, y: ecart, s: S };
      const x0 = ecart + S + ep * 2.5, l = W - x0 - ecart - ep * 1.5;
      const hTrace = perso.length ? H * (perso.length > 1 ? 0.3 : 0.18) : Math.min(H * 0.22, l / 4.6);
      zoneTrace = { x: x0, y: H - ecart - hTrace, l, h: hTrace };
      const hTexte = zoneTrace.y - ecart - ep;
      zoneNom = { x: x0, y: ecart + ep * 0.5, l, h: hTexte * (sous ? 0.66 : 1), lignes: 3, centre: true };
      if (sous) zoneSous = { x: x0, y: zoneNom.y + zoneNom.h, l, h: hTexte * 0.34, lignes: 2, centre: true };
    } else if (mode === 'portrait') {
      const S = W - 2 * ecart;
      qr = { x: ecart, y: ecart, s: S };
      const y0 = ecart + S + ep * 0.5, l = W - 2 * ecart;
      const hTrace = perso.length ? (H - y0) * (perso.length > 1 ? 0.36 : 0.22) : Math.min((H - y0) * 0.28, l / 4.6);
      zoneTrace = { x: ecart, y: H - ecart - hTrace, l, h: hTrace };
      const hTexte = zoneTrace.y - y0 - ep * 0.5;
      zoneNom = { x: ecart, y: y0, l, h: hTexte * (sous ? 0.62 : 1), lignes: 3, centre: true };
      if (sous) zoneSous = { x: ecart, y: y0 + zoneNom.h, l, h: hTexte * 0.38, lignes: 2, centre: true };
    } else {
      // Bandeaux un peu plus hauts avec le pictogramme NFC ou des lignes libres (QR légèrement réduit).
      const bande = petit * (reglage.logo === 'nfc' || perso.length ? 0.19 : 0.15);
      const S = Math.min(W - 2 * ecart, H - 2 * (marge + bande));
      qr = { x: (W - S) / 2, y: (H - S) / 2, s: S };
      // Bandeaux entre le cadre et la zone calme : texte en haut, primaire ou tracé en bas.
      const hb = qr.y - ecart;
      zoneNom = { x: coin * 0.5 + ep, y: ecart, l: W - 2 * (coin * 0.5 + ep), h: hb, lignes: 1, centre: true };
      const yBas = qr.y + S + 0.3;
      if (perso.length) {
        const zx = coin * 0.5 + ep, zl = W - 2 * zx;
        if (sous) { zoneSous = { x: zx, y: yBas, l: zl, h: hb * 0.4, lignes: 1, centre: true }; zoneTrace = { x: zx, y: yBas + hb * 0.4, l: zl, h: hb * 0.6 }; }
        else zoneTrace = { x: zx, y: yBas, l: zl, h: hb };
      } else if (sous) zoneSous = { x: coin * 0.5 + ep, y: yBas, l: W - 2 * (coin * 0.5 + ep), h: hb, lignes: 1, centre: true };
      else zoneTrace = { x: coin * 0.6 + ep, y: yBas + hb * 0.2, l: W - 2 * (coin * 0.6 + ep), h: hb * 0.72 };
    }

    // Puce NFC collée au dos : pictogramme bien visible, accolé au QR code (jamais dessus).
    let badge = null;
    if (reglage.logo === 'nfc') {
      if (mode === 'paysage') { // au pied de la colonne de texte, contre le QR ; le tracé part après
        const b = Math.min(14, zoneTrace.l * 0.35, Math.max(qr.s * 0.3, 5));
        badge = { x: zoneTrace.x, y: qr.y + qr.s - b - 0.4, b };
        zoneTrace.x += b + ep; zoneTrace.l -= b + ep;
      } else if (mode === 'portrait') { // juste sous le QR, centré ; le nom descend d'autant
        const b = Math.min(14, W * 0.35, Math.max(5, zoneNom.h * 0.5));
        badge = { x: (W - b) / 2, y: qr.y + qr.s + ep * 0.4, b };
        const decale = b + ep * 0.8;
        zoneNom.y += decale; zoneNom.h -= decale * (zoneSous ? 0.62 : 1);
        if (zoneSous) { zoneSous.y += decale * 0.62; zoneSous.h -= decale * 0.38; }
      } else {
        const cote = (W - qr.s) / 2 - ecart; // place libre à droite du QR
        // (le filet orange de la zone calme est à 0,4 mm du QR : le pictogramme reste à l'extérieur)
        const hb = qr.y - ecart;
        if (cote - 0.4 - ep * 0.9 >= Math.max(5, hb * 0.92)) { // à droite du QR, calé sur son bas
          const b = Math.min(14, cote - 0.4 - ep * 0.9);
          badge = { x: qr.x + qr.s + 0.4 + ep * 0.6, y: qr.y + qr.s - b, b };
        } else { // sous le QR, calé sur son bord droit
          const b = Math.min(14, hb * 0.96);
          badge = { x: qr.x + qr.s - b, y: qr.y + qr.s + (hb - b) / 2, b };
          [zoneSous, zoneTrace].forEach((z) => { if (z) z.l = badge.x - ep - z.x; });
        }
      }
    }

    // QR code
    const mod = qr.s / (n + 8);
    const o = 4 * mod;
    const L = reglage.logo === 'smur' ? (Math.round(n * 0.2) | 1) : 0, l0 = (n - L) / 2;
    // Modules arrondis : un coin n'est arrondi que s'il n'a de voisin sombre sur aucun de ses deux côtés,
    // si bien que les modules voisins restent soudés (lecture inchangée) ; repères d'angle en carrés arrondis.
    const masque = (r, col) => L && r >= l0 - 0.5 && r < l0 + L && col >= l0 - 0.5 && col < l0 + L;
    const repere = (r, col) => (r < 7 && col < 7) || (r < 7 && col >= n - 7) || (r >= n - 7 && col < 7);
    const sombre = (r, col) => r >= 0 && col >= 0 && r < n && col < n && !masque(r, col) && !repere(r, col) && q.isDark(r, col);
    const R = 0.5;
    let trace = '';
    for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) {
      if (!sombre(r, col)) continue;
      const h = sombre(r - 1, col), b = sombre(r + 1, col), g = sombre(r, col - 1), d = sombre(r, col + 1);
      const [hg, hd, bd, bg] = [!h && !g, !h && !d, !b && !d, !b && !g].map((x) => (x ? R : 0));
      trace += `M${col + hg} ${r}H${col + 1 - hd}${hd ? `a${R} ${R} 0 0 1 ${R} ${R}` : ''}V${r + 1 - bd}${bd ? `a${R} ${R} 0 0 1 -${R} ${R}` : ''}H${col + bg}${bg ? `a${R} ${R} 0 0 1 -${R} -${R}` : ''}V${r + hg}${hg ? `a${R} ${R} 0 0 1 ${R} -${R}` : ''}Z`;
    }
    [[0, 0], [0, n - 7], [n - 7, 0]].forEach(([r, col]) => {
      trace += `M${col + 2.2} ${r}H${col + 4.8}a2.2 2.2 0 0 1 2.2 2.2V${r + 4.8}a2.2 2.2 0 0 1 -2.2 2.2H${col + 2.2}a2.2 2.2 0 0 1 -2.2 -2.2V${r + 2.2}a2.2 2.2 0 0 1 2.2 -2.2Z`
        + `M${col + 2} ${r + 1}a1 1 0 0 0 -1 1V${r + 5}a1 1 0 0 0 1 1H${col + 5}a1 1 0 0 0 1 -1V${r + 2}a1 1 0 0 0 -1 -1Z`
        + `M${col + 3} ${r + 2}H${col + 4}a1 1 0 0 1 1 1V${r + 4}a1 1 0 0 1 -1 1H${col + 3}a1 1 0 0 1 -1 -1V${r + 3}a1 1 0 0 1 1 -1Z`;
    });
    enfants.push(
      ...(k.tuile ? [el('svg:rect', { x: qr.x, y: qr.y, width: qr.s, height: qr.s, rx: mod * 2.5, fill: k.tuile })] : []),
      el('svg:g', { transform: `translate(${qr.x + o} ${qr.y + o}) scale(${mod})` }, el('svg:path', { d: trace, fill: k.encre })));
    if (L) {
      const p = (L + 1) * mod, x = qr.x + o + (l0 - 0.5) * mod, y = qr.y + o + (l0 - 0.5) * mod;
      enfants.push(el('svg:rect', { x, y, width: p, height: p, rx: p * 0.12, fill: '#fff', stroke: k.negatif ? k.encre : k.bleu, 'stroke-width': mod * 0.35 }),
        el('svg:svg', { x: x + p * 0.12, y: y + p * 0.12, width: p * 0.76, height: p * 0.76, viewBox: '0 0 24 24' }, ...LOGOS_ETIQUETTE[reglage.logo](k.negatif ? { ...k, bleu: k.encre } : k)));
    }

    // Textes
    const ecrire = (zone, texte, gras, plafond = 99) => {
      if (!zone || !texte) return 0;
      // Le nom prend toute la place disponible ; le primaire reste discret.
      const max = Math.min(plafond, mode === 'carre' ? zone.h * 0.8 : zone.h, gras ? petit * 0.3 : Math.min(4.5, petit * 0.1));
      const { lignes, police } = ajusterTexte(texte, zone.l, zone.h, max, zone.lignes, gras);
      const total = lignes.length * police * 1.15;
      const y0 = zone.y + (zone.h - total) / 2 + police * 0.88;
      enfants.push(el('svg:text', {
        x: zone.centre ? zone.x + zone.l / 2 : zone.x, y: y0, 'text-anchor': zone.centre ? 'middle' : 'start',
        'font-family': 'system-ui, sans-serif', 'font-size': police, fill: gras ? k.fonce : k.bleu,
        ...(gras ? { 'font-weight': 800 } : { 'font-style': 'italic' }),
      }, ...lignes.map((t, i) => el('svg:tspan', { x: zone.centre ? zone.x + zone.l / 2 : zone.x, dy: i ? police * 1.15 : 0, texte: t }))));
      return police;
    };
    const policeNom = ecrire(zoneNom, nom, true);
    ecrire(zoneSous, sous, false, policeNom ? policeNom * 0.85 : 99); // le primaire reste plus discret que le nom

    // Tracé ECG prolongé par Avignon : la ville seulement s'il y a la place.
    if (zoneTrace && perso.length) {
      // Lignes libres : une ligne chacune, même taille, plus discrètes que le nom.
      const z = zoneTrace, hl = z.h / perso.length;
      const ajust = perso.map((t) => ajusterTexte(t, z.l, hl, Math.min(hl * 0.85, petit * 0.12, policeNom ? policeNom * 0.8 : 99), 1, true));
      const police = Math.min(...ajust.map((a) => a.police));
      perso.forEach((t, i) => enfants.push(el('svg:text', {
        x: z.x + z.l / 2, y: z.y + hl * i + hl / 2 + police * 0.35, 'text-anchor': 'middle',
        'font-family': 'system-ui, sans-serif', 'font-size': police, 'font-weight': 600, fill: k.fonce, texte: t })));
    } else if (zoneTrace) {
      // Avec la ville si elle tient avec une hauteur lisible (≥ 3,5 mm), sinon le complexe QRS seul.
      const eVille = Math.min(zoneTrace.h / 60, (zoneTrace.l * 0.94) / (TRACE_QRS.l * 0.8 + TRACE_AVIGNON.l));
      const avecVille = eVille * 60 >= 3.5;
      const e = avecVille ? eVille : zoneTrace.h / 60; // échelle du tracé (hauteur de référence 60)
      const lq = TRACE_QRS.l * e * 0.8, la = TRACE_AVIGNON.l * e;
      const yBase = zoneTrace.y + zoneTrace.h - 60 * e; // tracé calé en bas de sa zone
      const ligne = { fill: 'none', stroke: k.bleu, 'stroke-width': Math.max(0.25, ep * 0.45), 'stroke-linejoin': 'round', 'stroke-linecap': 'round' };
      const x0 = zoneTrace.x, x1 = zoneTrace.x + zoneTrace.l, yl = yBase + 38 * e;
      const xq = avecVille ? x0 + zoneTrace.l * 0.03 : x0 + (zoneTrace.l - lq) / 2;
      const xv = x1 - la;
      enfants.push(el('svg:path', { ...ligne, d: `M${x0} ${yl} H${xq}` }),
        el('svg:path', { ...ligne, 'stroke-width': ligne['stroke-width'] / e, transform: `translate(${xq} ${yBase}) scale(${e * 0.8} ${e})`, d: TRACE_QRS.d }),
        el('svg:path', { ...ligne, d: `M${xq + lq} ${yl} H${avecVille ? xv : x1}` }));
      if (avecVille) {
        enfants.push(el('svg:path', { ...ligne, 'stroke-width': ligne['stroke-width'] / e, transform: `translate(${xv} ${yBase}) scale(${e})`, d: TRACE_AVIGNON.d }),
          el('svg:path', { ...ligne, 'stroke-width': ligne['stroke-width'] * 0.7 / e, transform: `translate(${xv} ${yBase}) scale(${e})`, d: TRACE_AVIGNON.details }));
      }
    }
    if (badge) {
      const { x, y, b } = badge;
      enfants.push(el('svg:svg', { x, y, width: b, height: b, viewBox: LOGO_NFC.viewBox, role: 'img', 'aria-label': 'NFC' },
        el('svg:path', { d: LOGO_NFC.d, fill: k.negatif ? '#fff' : k.encre, 'fill-rule': 'evenodd' })));
    }
    return el('svg:svg', {
      classe: 'inv-etiquette-qr', viewBox: `0 0 ${W} ${H}`, width: `${W}mm`, height: `${H}mm`, role: 'img',
      'aria-label': `Étiquette QR ${W} × ${H} mm : ${nom}`, 'data-module': mod.toFixed(2),
    }, ...enfants);
  }

  // ---------- Aperçu en taille réelle ----------
  // Un « mm » CSS n'est juste que sur un écran à 96 ppp : on étalonne une fois avec une carte bancaire (85,6 mm).
  const CLE_ECHELLE = 'avismur-echelle-mm';
  function apercuTailleReelle(c) {
    const r = reglageEtiquette(c);
    let echelle = Number(lireJson(CLE_ECHELLE, 1)) || 1;
    const svg = etiquetteSvg(c, r);
    const carte = el('div', { classe: 'inv-carte-etalon', 'aria-hidden': 'true' }, el('span', { texte: 'carte bancaire' }));
    const appliquer = () => {
      svg.setAttribute('width', `${r.largeur * echelle}mm`);
      svg.setAttribute('height', `${r.hauteur * echelle}mm`);
      carte.style.width = `${85.6 * echelle}mm`;
      carte.style.height = `${53.98 * echelle}mm`;
    };
    const curseur = el('input', { type: 'range', min: 0.6, max: 1.8, step: 0.005, valeur: echelle, 'aria-label': 'Étalonnage de l\'écran',
      surinput: (e) => { echelle = Number(e.target.value); ecrireJson(CLE_ECHELLE, echelle); appliquer(); } });
    const module = Number(svg.getAttribute('data-module'));
    const fermer = () => fond.remove();
    const fond = el('div', { classe: 'inv-apercu-reel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Aperçu taille réelle', surclick: (e) => { if (e.target === fond) fermer(); } },
      el('div', { classe: 'inv-apercu-reel-boite' },
        el('h2', { texte: `Taille réelle : ${r.largeur} × ${r.hauteur} mm` }),
        el('div', { classe: 'inv-apercu-reel-etiquette' }, svg),
        module < 0.33 ? el('p', { classe: 'message erreur', texte: `QR code très dense (module de ${module.toFixed(2)} mm) : lecture difficile. Agrandissez l'étiquette ou retirez le logo.` }) : null,
        el('details', {}, el('summary', { texte: 'Étalonner l\'écran (une fois par appareil)' }),
          el('p', { classe: 'aide-question', texte: 'Posez une carte bancaire sur l\'écran et réglez le curseur jusqu\'à ce que le rectangle ait exactement sa taille.' }),
          curseur, carte),
        el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Fermer', surclick: fermer })));
    appliquer();
    document.body.append(fond);
  }

  async function ecrireNfc(url, sortie) {
    const delai = new AbortController();
    const minuterie = setTimeout(() => delai.abort(), 30000);
    sortie.className = 'message';
    sortie.textContent = 'Approchez la puce du dos du téléphone…';
    const cacherCible = CibleNfc.montrer();
    try {
      await new NDEFReader().write({ records: [{ recordType: 'url', data: url }] }, { signal: delai.signal });
      sortie.textContent = 'Puce écrite : elle ouvre maintenant cet inventaire.';
      sortie.className = 'message succes';
    } catch (e) {
      sortie.textContent = e.name === 'AbortError' ? 'Aucune puce détectée. Réessayez en la gardant contre le téléphone.'
        : (e.name === 'NotAllowedError' ? 'Autorisez le NFC pour cette application, et vérifiez qu\'il est activé sur le téléphone.' : 'Écriture impossible : puce verrouillée ou non compatible.');
      sortie.className = 'message erreur';
    } finally {
      clearTimeout(minuterie);
      cacherCible();
    }
  }

  function lancerImpression(contenu, classe) {
    document.querySelectorAll('#inv-impression').forEach((n) => n.remove());
    const page = el('div', { id: 'inv-impression', classe }, ...contenu);
    document.body.append(page);
    document.body.classList.add('impression-inventaire');
    const nettoyer = () => { page.remove(); document.body.classList.remove('impression-inventaire'); window.removeEventListener('afterprint', nettoyer); };
    window.addEventListener('afterprint', nettoyer);
    window.print();
  }

  // ---------- Impression des étiquettes QR : choix, exemplaires, planches A4 ----------
  const CLE_IMPRESSION = 'mysmur.inventaires.impression';
  const A4 = { portrait: [210, 297], paysage: [297, 210] };

  /** Contenants qui ont une étiquette : réels (hors inventaires types), sauf les emplacements vides de sens. */
  function etiquetables() {
    return Object.values(structure.contenants).filter((c) => !c.supprime && !c.emplacement && !dansUnModele(c.id));
  }

  /**
   * Range les étiquettes sur des pages (rangées successives, les plus hautes d'abord).
   * Retourne [{ etiquettes: [{ c, r, x, y }] }] en mm depuis le coin de la zone imprimable.
   */
  function rangerEtiquettes(liste, opt) {
    const [pw, ph] = A4[opt.orientation] || A4.portrait;
    const L = pw - 2 * opt.marge, H = ph - 2 * opt.marge, g = opt.espace;
    const items = liste.map((c) => ({ c, r: reglageEtiquette(c) }))
      .map((x) => ({ ...x, w: Math.min(x.r.largeur, L), h: Math.min(x.r.hauteur, H) }))
      .sort((a, b) => b.h - a.h || b.w - a.w);
    const pages = [];
    items.forEach((it) => {
      for (const p of pages) {
        for (const rg of p.rangees) {
          if (it.h <= rg.h && rg.x + it.w <= L + 0.01) { p.etiquettes.push({ ...it, x: rg.x, y: rg.y }); rg.x += it.w + g; return; }
        }
        if (p.bas + it.h <= H + 0.01) {
          p.rangees.push({ y: p.bas, h: it.h, x: it.w + g });
          p.etiquettes.push({ ...it, x: 0, y: p.bas });
          p.bas += it.h + g;
          return;
        }
      }
      pages.push({ rangees: [{ y: 0, h: it.h, x: it.w + g }], bas: it.h + g, etiquettes: [{ ...it, x: 0, y: 0 }] });
    });
    return pages;
  }

  /** Chemin d'une étiquette : à partir du contenant mobile le plus haut (il change de place), sinon complet. */
  function cheminEtiquette(c) {
    const ch = chemin(c.id).filter((x, i, t) => !x.emplacement || i === t.length - 1);
    const i = ch.findIndex((x) => x.categorie === 'mobile');
    return ch.slice(i >= 0 ? i : 0).map((x) => x.nom).join(' › ');
  }

  /** Exemplaires d'un inventaire type et tout ce qu'ils renferment, qui ont une étiquette. */
  function etiquettesExemplaires(exemplaires) {
    const ok = new Set(etiquetables().map((c) => c.id));
    return exemplaires.flatMap((e) => descendants(e.id)).filter((c) => ok.has(c.id));
  }

  /** Fenêtre d'impression : cocher les étiquettes (par contenant primaire), nombre d'exemplaires, mise en page A4. */
  function imprimerEtiquettes(preselection = []) {
    const opt = { orientation: 'portrait', marge: 8, espace: 3, coupe: true, ...lireJson(CLE_IMPRESSION, {}) };
    const nb = new Map(preselection.map((c) => [c.id, 1]));
    const tous = etiquetables();
    // Groupes : chaque contenant primaire avec ce qu'il renferme, puis les contenants hors de tout primaire.
    const primaires = tous.filter((c) => c.categorie === 'primaire').sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
    // Ouverte depuis un inventaire ou un inventaire type : la sélection vient en premier, à part.
    const ranges = new Set(preselection.map((c) => c.id));
    const choisis = tous.filter((c) => ranges.has(c.id));
    const groupes = primaires.map((p) => {
      const liste = descendants(p.id).filter((x) => tous.includes(x) && !ranges.has(x.id) && !dansUnMobile(x));
      liste.forEach((x) => ranges.add(x.id));
      return { nom: p.nom, liste };
    }).filter((g) => g.liste.length);
    if (choisis.length) groupes.unshift({ nom: 'Sélection', liste: choisis, ouvert: true });
    const libres = tous.filter((c) => !ranges.has(c.id)).sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
    // Les contenants mobiles changent de place : un groupe à part, sans le contenant où ils se trouvent.
    const mobiles = libres.filter((c) => dansUnMobile(c)).sort((a, b) => cheminEtiquette(a).localeCompare(cheminEtiquette(b), 'fr', { numeric: true }));
    const autres = libres.filter((c) => !dansUnMobile(c));
    if (mobiles.length) groupes.push({ nom: 'Contenants mobiles', liste: mobiles });
    if (autres.length) groupes.push({ nom: 'Hors contenant primaire', liste: autres });

    const fond = el('div', { classe: 'fenetre-fond', surclick: (e) => { if (e.target === fond) fermer(); } });
    const retour = document.activeElement;
    const fermer = () => { fond.remove(); document.body.classList.remove('fenetre-ouverte'); if (retour && retour.isConnected) retour.focus(); };
    const titre = idChamp();
    const resume = el('p', { classe: 'fenetre-resume', role: 'status' });
    const apercu = el('div', { classe: 'imp-apercu' });
    const bouton = el('button', { type: 'button', classe: 'cfg-bouton principal', texte: 'Imprimer', surclick: () => lancer() });
    const selection = () => tous.flatMap((c) => Array(nb.get(c.id) || 0).fill(c));
    const options = () => ({ ...opt, marge: Math.max(0, Math.min(30, Number(opt.marge) || 0)), espace: Math.max(0, Math.min(20, Number(opt.espace) || 0)) });

    const majApercu = () => {
      const liste = selection();
      const o = options();
      const pages = rangerEtiquettes(liste, o);
      resume.textContent = liste.length ? `${pluriel(liste.length, 'étiquette')} · ${pluriel(pages.length, 'page')} A4` : 'Aucune étiquette choisie.';
      bouton.disabled = !liste.length;
      const [pw, ph] = A4[o.orientation];
      apercu.replaceChildren(...pages.slice(0, 6).map((p, i) => el('svg:svg', { viewBox: `0 0 ${pw} ${ph}`, classe: 'imp-apercu-page', role: 'img', 'aria-label': `Page ${i + 1}` },
        el('svg:rect', { x: 0, y: 0, width: pw, height: ph, fill: '#fff', stroke: '#9aa7b8', 'stroke-width': 0.6 }),
        el('svg:rect', { x: o.marge, y: o.marge, width: pw - 2 * o.marge, height: ph - 2 * o.marge, fill: 'none', stroke: '#c9d3e0', 'stroke-width': 0.4, 'stroke-dasharray': '2 2' }),
        ...p.etiquettes.map((e) => el('svg:rect', { x: o.marge + e.x, y: o.marge + e.y, width: e.w, height: e.h, rx: 1, fill: '#dbe7f8', stroke: '#1d4f9f', 'stroke-width': 0.5 }, el('svg:title', { texte: `${e.c.nom} (${e.r.largeur}×${e.r.hauteur} mm)` }))))),
      pages.length > 6 ? el('p', { classe: 'aide-question', texte: `… et ${pages.length - 6} autres pages.` }) : null);
    };

    const ligne = (c, majGroupe) => {
      const champ = idChamp();
      const r = reglageEtiquette(c);
      const coche = el('input', { type: 'checkbox', id: champ, checked: nb.has(c.id), surchange: (e) => {
        if (e.target.checked) nb.set(c.id, Math.max(1, Number(qte.value) || 1)); else nb.delete(c.id);
        qte.disabled = !e.target.checked; majGroupe(); majApercu();
      } });
      const qte = el('input', { type: 'number', min: '1', max: '50', inputmode: 'numeric', classe: 'inv-court imp-qte', valeur: nb.get(c.id) || 1, disabled: !nb.has(c.id), 'aria-label': `Exemplaires : ${c.nom}`,
        surchange: (e) => { const n = Math.max(1, Math.min(50, Math.round(Number(e.target.value)) || 1)); e.target.value = n; if (nb.has(c.id)) nb.set(c.id, n); majApercu(); } });
      const ch = cheminEtiquette(c);
      return { coche, qte, noeud: el('li', { classe: 'imp-choix' }, coche,
        el('label', { for: champ }, el('span', { texte: c.nom }), ch !== c.nom ? el('small', { texte: ` ${ch}` }) : null),
        el('span', { classe: 'imp-format', texte: `${r.largeur}×${r.hauteur}` }), el('span', { 'aria-hidden': 'true', texte: '×' }), qte) };
    };
    const blocs = groupes.map((g) => {
      const champ = idChamp();
      const tout = el('input', { type: 'checkbox', id: champ });
      const lignes = [];
      const majGroupe = () => {
        const n = lignes.filter((l) => l.coche.checked).length;
        tout.checked = n === lignes.length; tout.indeterminate = n > 0 && n < lignes.length;
      };
      g.liste.forEach((c) => lignes.push(ligne(c, majGroupe)));
      tout.addEventListener('change', () => {
        lignes.forEach((l, i) => { l.coche.checked = tout.checked; l.qte.disabled = !tout.checked; if (tout.checked) nb.set(g.liste[i].id, Math.max(1, Number(l.qte.value) || 1)); else nb.delete(g.liste[i].id); });
        majApercu();
      });
      majGroupe();
      return el('details', { classe: 'imp-groupe', open: g.ouvert || groupes.length === 1 ? '' : null },
        el('summary', {}, tout, el('label', { for: champ, texte: `${g.nom} (${g.liste.length})` })),
        el('ul', {}, ...lignes.map((l) => l.noeud)));
    });

    const reglage = (libelle, cle, attrs) => {
      const champ = idChamp();
      return el('div', { classe: 'champ imp-reglage' }, el('label', { for: champ, texte: libelle }),
        el('input', { id: champ, type: 'number', inputmode: 'decimal', classe: 'inv-court', valeur: opt[cle], ...attrs,
          surchange: (e) => { opt[cle] = Number(e.target.value) || 0; ecrireJson(CLE_IMPRESSION, opt); majApercu(); } }));
    };
    const champCoupe = idChamp();
    const orientation = el('select', { 'aria-label': 'Orientation de la page', surchange: (e) => { opt.orientation = e.target.value; ecrireJson(CLE_IMPRESSION, opt); majApercu(); } },
      el('option', { value: 'portrait', texte: 'A4 portrait' }), el('option', { value: 'paysage', texte: 'A4 paysage' }));
    orientation.value = opt.orientation;

    const lancer = () => {
      const o = options();
      const pages = rangerEtiquettes(selection(), o);
      if (!pages.length) return;
      const [pw, ph] = A4[o.orientation];
      const regle = el('style', { id: 'imp-page-a4', texte: `@page { size: A4 ${o.orientation === 'paysage' ? 'landscape' : 'portrait'}; margin: 0; }` });
      document.head.append(regle);
      window.addEventListener('afterprint', () => regle.remove(), { once: true });
      fermer();
      lancerImpression(pages.map((p) => el('div', { classe: 'imp-page', style: `width:${pw}mm;height:${ph}mm` },
        ...p.etiquettes.map((e) => el('div', {
          classe: `imp-etiquette${o.coupe ? ' imp-coupe' : ''}`,
          style: `left:${o.marge + e.x}mm;top:${o.marge + e.y}mm;width:${e.w}mm;height:${e.h}mm;--demi-espace:${Math.min(o.espace / 2, 1.5)}mm`,
        }, etiquetteSvg(e.c, e.r))))), 'imp-etiquettes');
    };

    fond.append(el('div', { classe: 'fenetre imp-fenetre', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titre },
      el('div', { classe: 'fenetre-entete' }, el('h2', { id: titre, texte: 'Imprimer des étiquettes QR' }),
        el('button', { type: 'button', classe: 'fenetre-fermer', 'aria-label': 'Fermer', texte: '✕', surclick: fermer })),
      el('div', { classe: 'fenetre-corps' },
        tous.length ? el('div', { classe: 'imp-groupes' }, ...blocs) : el('p', { classe: 'consigne', texte: 'Aucun inventaire pour l\'instant.' }),
        el('h3', { texte: 'Mise en page' }),
        el('div', { classe: 'imp-reglages' }, orientation,
          reglage('Marges (mm)', 'marge', { min: '0', max: '30', step: '0.5' }),
          reglage('Espacement (mm)', 'espace', { min: '0', max: '20', step: '0.5' }),
          el('label', { for: champCoupe, classe: 'imp-reglage-coupe' },
            el('input', { type: 'checkbox', id: champCoupe, checked: opt.coupe, surchange: (e) => { opt.coupe = e.target.checked; ecrireJson(CLE_IMPRESSION, opt); } }), ' Traits de coupe')),
        resume, apercu,
        el('p', { classe: 'aide-question', texte: 'Les étiquettes sont imprimées à leur taille réelle et rangées au mieux sur la page. Dans la fenêtre d\'impression : échelle 100 % (ou « Taille réelle ») et marges « Aucune ».' }),
        bouton)));
    fond.addEventListener('keydown', (e) => { if (e.key === 'Escape') fermer(); });
    document.body.append(fond);
    document.body.classList.add('fenetre-ouverte');
    majApercu();
    fond.querySelector('.fenetre-fermer').focus();
  }

  // ---------- Export Word (listing éditable, modèle institutionnel du CH d'Avignon) ----------
  function chargerScript(src) {
    return new Promise((ok, ko) => {
      const nom = src.split('?')[0];
      if ([...document.scripts].some((x) => (x.getAttribute('src') || '').split('?')[0] === nom)) { ok(); return; }
      const x = document.createElement('script');
      x.src = src; x.onload = () => ok(); x.onerror = () => ko(new Error(`chargement impossible : ${nom}`));
      document.head.append(x);
    });
  }
  /** Libellé d'une ligne du listing (même rédaction que la liste papier). */
  function libelleListing(a) {
    if (a.separateur) return { texte: a.nom };
    if (estControle(a)) return { texte: `${nomArticle(a)}${texteAttente(a) ? ` (${texteAttente(a)})` : ''} : ${a.controle === 'oui' ? 'Oui / Non' : '……………'}` };
    return { texte: `${nomArticle(a)}${a.quantite ? ` × ${estMinimum(a) ? '≥ ' : ''}${a.quantite}` : ''}${estFacultatif(a) ? ' (facultatif)' : ''}${a.commentaire ? ` — ${a.commentaire}` : ''}` };
  }
  /**
   * Listing Word d'un contenant et de tout ce qu'il contient : en-tête et styles du modèle institutionnel,
   * une page par sous-inventaire de niveau 1, pochettes en lignes de tableau (lib/listing-word.js).
   */
  async function exporterWord(c, bouton) {
    const libelle = bouton ? bouton.textContent : '';
    if (bouton) { bouton.disabled = true; bouton.textContent = 'Génération du Word…'; }
    try {
      await Promise.all([chargerScript('lib/jszip.min.js?v=1'), chargerScript('lib/listing-word.js?v=1')]);
      const reponse = await fetch('modeles/modele-documents-divers-portrait.dotx?v=1');
      if (!reponse.ok) throw new Error('modèle introuvable');
      const octets = await ListingWord.generer({
        JSZip: window.JSZip, modele: await reponse.arrayBuffer(),
        contenants: structure.contenants, racineId: c.id,
        enfantsDe: enfants,
        articlesDe: (x) => x.articles.filter((a) => !estReperePhoto(a)),
        libelleArticle: libelleListing,
        titre: `Inventaire ${c.nom}`, reference: `INV-${c.nom}`.replace(/\s+/g, '-'),
      });
      const url = URL.createObjectURL(new Blob([octets], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
      const lien = el('a', { href: url, download: `Inventaire ${c.nom}`.replace(/[\\/:*?"<>|]+/g, '-') + '.docx' });
      document.body.append(lien); lien.click(); lien.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      avis = `Export Word impossible (${e.message}). Hors ligne ? Ouvrez une fois cette page avec du réseau pour mettre le modèle en cache.`;
      rendre({ garderPosition: true });
    } finally {
      if (bouton) { bouton.disabled = false; bouton.textContent = libelle; }
    }
  }

  /** Liste papier d'un contenant et de tout ce qu'il contient. */
  function imprimerListe(c) {
    const profondeur = chemin(c.id).length;
    const blocs = descendants(c.id).map((x) => {
      const niveau = chemin(x.id).length - profondeur;
      return el('section', { classe: 'imp-niveau', style: `margin-left:${niveau * 1.2}em` },
        el(niveau ? 'h2' : 'h1', { texte: `${x.nom}${x.scellable ? ' (scellable)' : ''}` }),
        aCocher(x).length ? el('ul', {}, ...x.articles.filter((a) => !estReperePhoto(a)).map((a) => (a.separateur ? el('li', { classe: 'imp-separation', texte: a.nom }) : el('li', {},
          el('span', { classe: 'imp-case', 'aria-hidden': 'true' }),
          el('span', { classe: 'imp-nom', texte: estControle(a) ? `${nomArticle(a)}${texteAttente(a) ? ` (${texteAttente(a)})` : ''} : ${a.controle === 'oui' ? 'Oui / Non' : '……………'}` : `${nomArticle(a)}${a.quantite ? ` × ${estMinimum(a) ? '≥ ' : ''}${a.quantite}` : ''}${estFacultatif(a) ? ' (facultatif)' : ''}${a.commentaire ? ` — ${a.commentaire}` : ''}` }),
          suiviPeremption(a) ? el('span', { classe: 'imp-date', texte: `Pér. ${afficherDate(datePeremption(x.id, a.id)) || '……/………'}` }) : null)))) : null);
    });
    lancerImpression([
      el('header', { classe: 'imp-entete' }, qrSvg(adresse(c.id)),
        el('div', {}, el('p', { texte: cheminNoms(c.id) }),
          el('p', { texte: `SMUR Avignon · inventaire imprimé le ${new Date().toLocaleDateString('fr-FR')}` }),
          el('p', { texte: 'Date : ……………………   Nom : ……………………………………' }))),
      ...blocs], 'imp-liste');
  }

  // ---------- Scanner (QR code par la caméra, puce NFC) ----------

  function scanner(choix = { qr: true, nfc: true }, surTrouve = aller, surAutre = null) {
    // Ordinateur : pas de caméra, la scannette tape le code dans un champ.
    const scannette = choix.qr && Scannette.ordinateur();
    const qr = !scannette && choix.qr && 'BarcodeDetector' in window;
    const nfc = !scannette && choix.nfc && 'NDEFReader' in window;
    const video = el('video', { playsinline: '', muted: '', autoplay: '' });
    video.muted = true;
    const lecture = el('p', { classe: 'lecture', role: 'status', texte: scannette ? '' : (qr ? 'Ouverture de la caméra…' : 'Approchez la puce NFC du dos du téléphone.') });
    const annuler = el('button', { type: 'button', classe: 'camera-bouton secondaire', texte: 'Annuler' });
    let champScannette = null;
    const ecran = el('div', { classe: `camera${scannette ? ' camera-scannette' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Scanner un inventaire' },
      scannette ? (champScannette = Scannette.champ((t) => trouve(t))) : el('div', { classe: `camera-vue${qr ? '' : ' inv-nfc-seul'}` }, qr ? video : el('div', { classe: 'inv-attente-nfc', 'aria-hidden': 'true' }, logoNfc()), qr ? el('div', { classe: 'viseur viseur-qr', 'aria-hidden': 'true' }) : null,
        el('p', { classe: 'consigne-camera consigne-qr', texte: [qr ? 'Visez le QR code de l\'inventaire' : '', nfc ? 'approchez sa puce NFC' : ''].filter(Boolean).join(' ou ') })),
      lecture, nfc ? el('div', { classe: 'cible-nfc-lien-zone' }, CibleNfc.lien()) : null, el('div', { classe: 'camera-actions' }, annuler));
    document.body.append(ecran);
    document.body.classList.add('camera-ouverte');
    let flux = null;
    let minuterie = null;
    let fini = false;
    const arretNfc = new AbortController();
    const cacherCible = nfc ? CibleNfc.montrer() : () => {};
    const fermer = () => {
      if (fini) return;
      fini = true;
      clearInterval(minuterie);
      arretNfc.abort();
      cacherCible();
      if (flux) flux.getTracks().forEach((t) => t.stop());
      ecran.remove();
      document.body.classList.remove('camera-ouverte');
    };
    const trouve = (texte) => {
      if (!fini) Scannette.vibrer();
      const m = /#inv=([a-z0-9]{6,16})$/.exec(String(texte || '').trim());
      if (!m) {
        // Autre code (étiquette biomed, puce d'appareil) : la vue appelante peut le reconnaître.
        const suite = surAutre ? surAutre(texte) : null;
        if (suite) { fermer(); suite(); return; }
        lecture.textContent = surAutre ? 'Ce code n\'est ni celui d\'un inventaire ni celui d\'un appareil connu.' : 'Ce code n\'est pas celui d\'un inventaire.';
        return;
      }
      fermer();
      surTrouve(m[1]);
    };
    annuler.addEventListener('click', fermer);
    ecran.addEventListener('keydown', (e) => { if (e.key === 'Escape') fermer(); });
    if (champScannette) Scannette.focusChamp(ecran); else annuler.focus();

    if (qr) {
      // Avec reconnaissance d'appareil : aussi les codes-barres des étiquettes biomed.
      const detecteur = new BarcodeDetector({ formats: surAutre ? ['qr_code', 'code_128', 'code_39', 'ean_13', 'data_matrix'] : ['qr_code'] });
      navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false }).then((f) => {
        if (fini) { f.getTracks().forEach((t) => t.stop()); return; }
        flux = f;
        video.srcObject = f;
        lecture.textContent = 'Recherche du QR code…';
        let occupe = false;
        minuterie = setInterval(async () => {
          if (occupe || video.readyState < 2) return;
          occupe = true;
          try {
            const codes = await detecteur.detect(video);
            if (codes.length && !fini) trouve(codes[0].rawValue);
          } catch (e) { /* image pas encore prête */ } finally { occupe = false; }
        }, 300);
      }).catch(() => { lecture.textContent = `Caméra inaccessible : autorisez la caméra pour cette application${nfc ? ', ou approchez la puce NFC' : ''}.`; });
    }
    if (nfc) {
      const lecteur = new NDEFReader();
      lecteur.addEventListener('reading', (e) => {
        if (CibleNfc.enReglage()) return; // puce passée pour repérer l'antenne
        const lienPuce = [...e.message.records].find((r) => r.recordType === 'url' || r.recordType === 'absolute-url');
        const lien = lienPuce ? new TextDecoder().decode(lienPuce.data) : '';
        // Puce d'appareil sans lien d'inventaire : on passe aussi son texte (« Biomed … », « S/N … »).
        const textes = [...e.message.records].filter((r) => r.recordType === 'text').map((r) => { try { return new TextDecoder(r.encoding || 'utf-8').decode(r.data); } catch (err) { return ''; } });
        trouve(/#inv=/.test(lien) || !surAutre ? lien : [lien, ...textes].filter(Boolean).join(' '));
      });
      lecteur.scan({ signal: arretNfc.signal }).catch(() => { /* NFC refusé ou éteint : le QR code reste possible */ });
    }
  }

  // ---------- Interface avec app.js ----------
  function initialiser(app) {
    App = app;
    zone = document.getElementById('zone-inventaires');
    const garde = lireJson(CLE_STRUCTURE, null);
    if (garde && garde.contenants) {
      structure = { contenants: {}, catalogue: {}, reglages: { alerteJours: Number(garde.reglages && garde.reglages.alerteJours) || 30 } };
      Object.values(garde.contenants).forEach((c) => { if (c && ID.test(c.id)) structure.contenants[c.id] = normaliser(c); });
      Object.values(garde.catalogue || {}).forEach((f) => { if (f && ID.test(f.id)) structure.catalogue[f.id] = normaliserFiche(f); });
    }
    const etatGarde = lireJson(CLE_ETAT, null);
    if (etatGarde && etatGarde.verifs && etatGarde.peremptions) etat = { dernierOui: {}, ...etatGarde };
    brouillons = lireJson(CLE_BROUILLONS, brouillons);
    if (!brouillons.liste) brouillons = { jour: '', liste: {}, pointes: {} };
    const modifsGardees = lireJson(CLE_MODIFS, null);
    if (modifsGardees && modifsGardees.ids) modifs = { fiches: {}, reglages: false, ...modifsGardees };
    window.addEventListener('online', synchroniser);
    // Check-list ambulancier enregistrée ou reçue du serveur : gommettes « oxygène » à jour (vertes une fois faite).
    let empreinteAmb = empreinteAmbulancier();
    document.addEventListener('parc-maj', () => {
      const n = empreinteAmbulancier();
      if (n === empreinteAmb) return;
      empreinteAmb = n;
      if (!edition && !document.body.classList.contains('fenetre-ouverte')) rendre({ garderPosition: true });
    });
    // Les liens internes passent par aller() (voir la pile ci-dessus).
    // Champs de péremption : le « / » s'ajoute tout seul après les deux chiffres du mois (ou du jour).
    zone.addEventListener('input', (e) => {
      const t = e.target;
      if (!t.classList || !t.classList.contains('inv-date') || (e.inputType || '').startsWith('delete')) return;
      let n = t.value.replace(/[^\d/]/g, '').replace(/^(\d{2})(\d)/, '$1/$2');
      if (/^\d{2}$/.test(n)) n += '/';
      // Jour/mois/année : après « JJ/ », deux chiffres de 01 à 12 sont un mois (une année commence par 20) → second « / ».
      n = n.replace(/^(\d{2}\/)(0[1-9]|1[0-2])(\d)$/, '$1$2/$3');
      if (/^\d{2}\/(0[1-9]|1[0-2])$/.test(n)) n += '/';
      if (n !== t.value) t.value = n;
    });
    zone.addEventListener('click', (e) => {
      const a = e.target.closest('a[href^="#inv"]');
      if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;
      e.preventDefault();
      const m = /^#inv=([a-z0-9]{6,16})$/.exec(a.getAttribute('href'));
      const cible = m && contenant(m[1]);
      // Check-list : ouvrir un contenant mobile depuis son contenant demande d'abord lequel est réellement là.
      // … sauf s'il a déjà été pointé aujourd'hui (l'icône « changer » permet de corriger).
      if (cible && !gestion && !enConsultation(cible) && cible.emplacement && cible.parent === idCourant() && !occupantDuJour(cible)) {
        identification = `emp:${cible.id}`;
        rendre();
        return;
      }
      if (cible && !gestion && !enConsultation(cible) && cible.categorie === 'mobile' && !cible.emplacement && cible.parent && cible.parent === idCourant() && !mobilePointe(cible)) {
        identification = cible.id;
        rendre();
        return;
      }
      aller(a.getAttribute('href') === '#inv-base' ? BASE : (a.getAttribute('href') === '#inv-tableau' ? TABLEAU : (m ? m[1] : '')));
    });
  }

  /** Affiche la vue (premier niveau, ou le contenant du lien « #inv=… »). */
  function afficher({ gestion: enGestion = false } = {}) {
    if (!zone) return;
    const dejaOuverte = !zone.hidden;
    zone.hidden = false;
    gestion = enGestion && estAdmin();
    document.body.classList.toggle('vue-inv-checklist', !gestion); // barre QR / NFC du bas
    edition = gestion;
    if (!dejaOuverte) { dernierAffiche = null; pile = []; }
    rendre();
    if (!dejaOuverte) synchroniser();
  }
  function masquer() {
    if (zone) zone.hidden = true;
    document.body.classList.remove('vue-inv-checklist', 'inv-avec-valider', 'inv-dans-modele');
  }
  /** Après un envoi de la file d'attente (app.js) : met à jour la ligne d'état. */
  function surEnvoi() {
    const ligne = zone && !zone.hidden && zone.querySelector('.inv-synchro');
    if (ligne) majLigneSynchro(ligne);
  }

  /** Barre du bas (téléphone) : scan depuis n'importe quel écran, ouvre l'inventaire trouvé. */
  function scanRapide(type, surAutre = null) {
    const dispo = type === 'nfc' ? 'NDEFReader' in window : (Scannette.ordinateur() || ('BarcodeDetector' in window && navigator.mediaDevices));
    if (!dispo) { alerteBreve(type === 'nfc' ? 'NFC non disponible : Chrome sur Android requis, NFC activé.' : 'Lecture de QR code non disponible sur ce navigateur.'); return; }
    // Étiquette lue sur place : on est là, l'inventaire s'ouvre pour être vérifié.
    scanner({ qr: type === 'qr', nfc: type === 'nfc' }, (id) => {
      fixerContexte(contexte.primaire, false);
      if (zone && !zone.hidden && !gestion && identificationEnCours()) { identificationEnCours()(id); return; }
      const place = placeIci(contenant(id));
      if (place) { confirmerIdentification(place.y, id, place.dans); return; }
      ouvrirScanne(id);
    }, surAutre);
  }
  /**
   * Contenant scanné par l'action rapide : si l'on se trouve dans un contenant primaire, il s'ouvre pour en faire
   * l'inventaire (comme une étiquette lue sur place), même s'il est enregistré ailleurs ou si l'on consultait.
   */
  function ouvrirScanne(id) {
    const x = contenant(id);
    const ici = contenant(contexte.primaire);
    if (!gestion && x && ici && ici.categorie === 'primaire' && !ici.supprime) {
      fixerContexte(ici.id, false);
      if (x.categorie !== 'primaire') scannesIci.set(x.id, ici.id);
    }
    if (location.hash === lien(id)) rendre(); else location.hash = lien(id);
  }
  /** Écran « Quel … se trouve ici ? » affiché : la fonction qui confirme l'identification, sinon null. */
  function identificationEnCours() {
    const id = idCourant();
    const empId = identification.startsWith('emp:') ? identification.slice(4) : '';
    if (empId && contenant(empId) && contenant(empId).parent === id) {
      const occ = enfants(empId)[0];
      return (x) => confirmerIdentification(occ || null, x, occ ? '' : empId);
    }
    if (identification === `dans:${id}`) return (x) => confirmerIdentification(null, x, id);
    if (identification && contenant(identification) && contenant(identification).parent === id) return (x) => confirmerIdentification(contenant(identification), x);
    return null;
  }
  /**
   * Contenant mobile scanné depuis le contenant affiché (dans le contenant primaire où l'on est), alors qu'il est
   * enregistré ailleurs : s'il a ici une seule place possible (emplacement de son modèle, ou mobile du même modèle),
   * c'est là qu'il se trouve. Retourne { y, dans } pour confirmerIdentification, sinon null.
   */
  function placeIci(x) {
    const cour = contenant(idCourant());
    const ici = contenant(contexte.primaire);
    if (!x || !cour || !ici || gestion || x.categorie !== 'mobile' || dansUnModele(x.id) || x.parent === cour.id) return null;
    if (!primaireDe(cour.id) || primaireDe(cour.id).id !== ici.id || chemin(cour.id).some((z) => z.id === x.id)) return null;
    const pos = enfants(cour.id).filter((f) => !f.supprime && f.id !== x.id && f.id !== x.parent
      && ((f.emplacement && modelesEmplacement(f).includes(x.source)) || (f.categorie === 'mobile' && !f.emplacement && x.source && f.source === x.source)));
    if (pos.length !== 1) return null;
    const f = pos[0];
    if (f.emplacement) { const occ = enfants(f.id)[0]; return occ ? { y: occ, dans: '' } : { y: null, dans: f.id }; }
    return { y: f, dans: '' };
  }
  function alerteBreve(texte) {
    const p = el('p', { classe: 'barre-scan-avis', role: 'status', texte });
    document.body.append(p);
    setTimeout(() => p.remove(), 3500);
  }

  /** Pour la check-list ambulancier : photo d'un véhicule (vignette de son contenant primaire) gardée sur l'appareil. */
  const photoVehicule = (id) => { const p = primaireDuVehicule(id); return p ? p.vignette || '' : ''; };
  return { initialiser, afficher, masquer, synchroniser, surEnvoi, analyserDate, scanRapide, ouvrirScanne, obtenirPhoto, enMemoire: (id) => Photos.enMemoire(id), photoVehicule,
    stocks: () => stocks(), vehiculesArmables: () => vehiculesArmables(), peremptionsVehicule: (id) => peremptionsVehicule(id),
    // Étiquettes QR personnalisables hors inventaires (références de prêt…).
    etiquette: {
      svg: (o, reglage) => { const c = objetEtiquette(o, reglage); return etiquetteSvg(c, reglageEtiquette(c)); },
      controles: (reglage, regler) => controlesEtiquette(reglageEtiquette({ etiquette: normEtiquette(reglage || {}) }), regler),
      normaliser: (reglage) => normEtiquette(reglage || {}),
      apercuTailleReelle: (o, reglage) => apercuTailleReelle(objetEtiquette(o, reglage)),
      imprimer: (objets, reglage) => imprimerEtiquettesObjets(objets, reglage),
    } };
})();
