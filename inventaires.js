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
  const VERSION_SERVEUR = 14;
  let versionServeur = null;
  const PHOTO_MAX = 1500000; // caractères base64 acceptés par le serveur

  let App = null; // fonctions de app.js (appeler, mettreEnFile, role, agent, fileAttente)
  let zone = null;
  let structure = { contenants: {}, catalogue: {}, reglages: { alerteJours: 30 } };
  let etat = { verifs: {}, peremptions: {} };
  let brouillons = { jour: '', liste: {} };
  let modifs = { ids: {}, fiches: {}, reglages: false }; // contenants et fiches modifiés sur l'appareil, pas encore envoyés
  let rattacher = ''; // article sans fiche que l'on rattache à la base des articles
  let rechercheAjout = ''; // recherche en cours dans « Ajouter un article »
  let creation = null; // fiche en cours de création ({ denomination, … }) depuis « Ajouter un article »
  let ajoutSousOuvert = false; // formulaire « Ajouter un sous-inventaire » déplié (mode Modifier)
  let baseOuverte = ''; // fiche dépliée dans la base des articles ('nouvelle' : création)
  let baseFiltre = { texte: '', categorie: '', archives: false };
  const brouillonsBase = new Map(); // tableau de la base (ordinateur) : fiches modifiées, pas encore enregistrées
  let edition = false;
  let gestion = false;
  // Identification d'un contenant mobile (check-list) : '<id>' (mobile prévu à cette place),
  // 'dans:<id>' (« un contenant mobile se trouve ici »), 'emp:<id>' (emplacement attendant un type de contenant).
  let identification = '';
  let typeChoisi = ''; // emplacement à plusieurs inventaires types : modèle choisi sur photo
  let placement = ''; // sous-inventaire dont on place le point sur la photo
  let avis = ''; // message affiché une fois en haut de la vue
  let confirmer = ''; // action en attente d'une deuxième pression (valider avec manquants, supprimer)
  let recherche = '';
  let rechercheOuverte = false; // loupe de la page des inventaires dépliée
  /*
   * Contenant primaire dans lequel se trouve l'agent (véhicule, réserve), toujours affiché en haut d'un inventaire.
   * Il se déduit du contenant ouvert (ou de l'étiquette scannée sur place). Une recherche par le nom ne dit pas
   * où l'on est : sans contenant primaire choisi, l'inventaire trouvé s'ouvre en consultation seule (rien à cocher).
   */
  const CLE_CONTEXTE = 'avismur_inv_contexte';
  let contexte = (() => {
    try { const x = JSON.parse(sessionStorage.getItem(CLE_CONTEXTE)); if (x && typeof x === 'object') return { primaire: String(x.primaire || ''), consultation: x.consultation === true }; } catch (e) { /* stockage indisponible */ }
    return { primaire: '', consultation: false };
  })();
  function fixerContexte(primaire, consultation) {
    contexte = { primaire: primaire || '', consultation: Boolean(consultation) };
    try { sessionStorage.setItem(CLE_CONTEXTE, JSON.stringify(contexte)); } catch (e) { /* stockage indisponible */ }
  }
  let dernierAffiche = null;
  let pile = []; // inventaires ouverts à la suite : remonter d'un niveau revient en arrière dans l'historique du téléphone
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
      vues: Array.isArray(c.vues) ? c.vues.map((v) => ({ id: v.id, nom: v.nom || '', photo: v.photo || '', points: Array.isArray(v.points) ? v.points : [] })) : [],
      nomVue: c.nomVue || '',
      scellable: c.scellable === true, // contenant fermé par un scellé (plomb) une fois vérifié
      categorie: CATEGORIES_CONTENANT[c.categorie] ? c.categorie : '', // primaire, immobile ou mobile
      // Étiquette QR : largeur × hauteur imprimées (mm) et logo central (puce NFC au dos, croix SMUR ou aucun).
      ...(c.etiquette ? { etiquette: (() => {
        const mm = (v, d) => Math.min(150, Math.max(15, Math.round(Number(v) || d)));
        const largeur = mm(c.etiquette.largeur || c.etiquette.taille, 40);
        return { largeur, hauteur: mm(c.etiquette.hauteur || c.etiquette.taille, largeur),
          logo: ['nfc', 'smur'].includes(c.etiquette.logo) ? c.etiquette.logo : '' };
      })() } : {}),
      ...(c.modele ? { modele: true } : {}),
      ...(c.desaffecte ? { desaffecte: c.desaffecte } : {}), // mobile dont la place a été prise : à retrouver
      // Emplacement : attend un exemplaire d'un inventaire type (ex. un « Ampoulier A » dans chaque sac) ;
      // l'exemplaire identifié en check-list y est rangé (enfant de l'emplacement).
      // Plusieurs inventaires types possibles (ex. scopes de marques différentes, Tempus à pochettes variables) :
      // `modeles` les liste tous ; `modele` (le premier) reste pour les versions précédentes.
      ...(c.emplacement && c.emplacement.modele ? { emplacement: (() => {
        const modeles = [...new Set([c.emplacement.modele, ...(Array.isArray(c.emplacement.modeles) ? c.emplacement.modeles : [])].filter((x) => ID.test(String(x))))];
        return modeles.length > 1 ? { modele: modeles[0], modeles } : { modele: modeles[0] };
      })() } : {}),
      ...(c.source ? { source: c.source } : {}), // exemplaire : contenant du modèle dont il est la copie
      ...(c.base ? { base: c.base } : {}), // exemplaire : état du modèle lors de la dernière répercussion
      ...(c.supprime ? { supprime: true } : {}),
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
  /** Toutes les vues : la principale (clé '') puis les supplémentaires. */
  function vuesDe(c) {
    return [{ cle: '', nom: c.nomVue || 'Vue 1', photo: c.photo, points: c.points },
      ...c.vues.map((v, i) => ({ cle: v.id, nom: v.nom || `Vue ${i + 2}`, photo: v.photo, points: v.points }))];
  }
  /** Écrit dans une vue (principale : champs du contenant). */
  function majVue(c, cle, champs) {
    if (!cle) {
      if ('photo' in champs) c.photo = champs.photo;
      if ('points' in champs) c.points = champs.points;
      if ('nom' in champs) c.nomVue = champs.nom;
    } else {
      const v = c.vues.find((x) => x.id === cle);
      if (v) Object.assign(v, champs);
    }
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
  const photosDe = (c) => [c.photo, ...c.vues.map((v) => v.photo)].filter(Boolean);

  // ---------- Base des articles (catalogue) ----------
  const CATEGORIES = ['Médicament', 'DM', 'Magasin', 'Kit', 'Biomédical', 'Autre'];
  /** Texte comparable : minuscules, sans accents, espaces simples. */
  const cle = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  function normaliserFiche(f) {
    return {
      id: f.id, denomination: String(f.denomination || ''), categorie: CATEGORIES.includes(f.categorie) ? f.categorie : '',
      horsStock: f.horsStock === true, refInterne: String(f.refInterne || ''), refFournisseur: String(f.refFournisseur || ''),
      consommable: f.consommable === true, perissable: f.perissable === true, archive: f.archive === true,
      photo: String(f.photo || ''),
    };
  }
  /** Fiche de la base d'un article d'inventaire (null pour un article ancien, saisi sans la base). */
  const fiche = (a) => (a && a.ref && structure.catalogue[a.ref]) || null;
  const nomArticle = (a) => (fiche(a) ? fiche(a).denomination : a.nom);
  /** Péremption suivie : d'après la fiche (« périssable »), sinon d'après l'article lui-même. */
  const suiviPeremption = (a) => (fiche(a) ? fiche(a).perissable : a.peremption === true);
  function resumeFiche(f) {
    return [f.categorie || 'Sans catégorie', f.refInterne ? `réf. ${f.refInterne}` : '', f.horsStock ? 'dotation hors stock' : '',
      f.consommable ? '' : 'non consommable', f.perissable ? 'périssable' : '', f.archive ? 'archivé' : ''].filter(Boolean).join(' · ');
  }
  /** Fiches dont la dénomination ou une référence contient tous les mots cherchés. */
  function chercherFiches(texte, { archives = false, categorie = '' } = {}) {
    const mots = cle(texte).split(' ').filter(Boolean);
    return Object.values(structure.catalogue)
      .filter((f) => (archives || !f.archive) && (!categorie || f.categorie === categorie))
      .filter((f) => { const t = cle(`${f.denomination} ${f.refInterne} ${f.refFournisseur}`); return mots.every((m) => t.includes(m)); })
      .sort((x, y) => {
        // Les dénominations qui commencent par la recherche d'abord.
        const dx = cle(x.denomination).startsWith(mots[0] || '') ? 0 : 1;
        const dy = cle(y.denomination).startsWith(mots[0] || '') ? 0 : 1;
        return dx - dy || x.denomination.localeCompare(y.denomination, 'fr');
      });
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
  // ---------- Contrôles : valeur à relever au lieu d'une case ----------
  const CONTROLES = {
    scan: { nom: 'À scanner / renseigner', aide: 'n° de série, matériel biomédical', defaut: 'Numéro de série' },
    temperature: { nom: 'Température', aide: '°C, avec plage', defaut: 'Température', unite: '°C' },
    batterie: { nom: 'Niveau de batterie', aide: '% ou 0 à 4', defaut: 'Batterie' },
    oui: { nom: 'Oui / Non', aide: 'branchement secteur, appairage, test', defaut: 'Test effectué' },
    valeur: { nom: 'Mesure', aide: 'nombre avec unité (bar, L…)', defaut: 'Pression' },
  };
  const estControle = (a) => Boolean(a && CONTROLES[a.controle]);
  /** Article facultatif (ex. détecteur de CO présent sur certains sacs) : son absence ne rend pas l'inventaire non conforme. */
  const estFacultatif = (a) => Boolean(a && a.facultatif === true);
  const seuilBatterie = (a) => (a.seuil !== undefined ? a.seuil : (a.echelle === '4' ? 2 : 50));
  /** Évalue une valeur relevée : { ok, rempli }. */
  function evaluer(a, v) {
    const t = String(v === undefined || v === null ? '' : v).trim();
    if (!t) return { ok: false, rempli: false };
    if (a.controle === 'scan') return { ok: !a.attendu || t.toLowerCase() === String(a.attendu).trim().toLowerCase(), rempli: true };
    if (a.controle === 'oui') return { ok: t === 'Oui', rempli: true };
    const n = Number(t.replace(',', '.'));
    if (!Number.isFinite(n)) return { ok: false, rempli: true };
    if (a.controle === 'batterie') return { ok: n >= seuilBatterie(a), rempli: true };
    return { ok: (a.min === undefined || n >= a.min) && (a.max === undefined || n <= a.max), rempli: true };
  }
  /** Valeur affichée (avec unité). */
  function texteValeur(a, v) {
    if (v === '' || v === undefined) return 'non renseigné';
    if (a.controle === 'temperature') return `${v} °C`;
    if (a.controle === 'batterie') return a.echelle === '4' ? `${v}/4` : `${v} %`;
    if (a.controle === 'valeur' && a.unite) return `${v} ${a.unite}`;
    return String(v);
  }
  /** Plage attendue, en clair. */
  function texteAttente(a) {
    if (a.controle === 'scan') return a.attendu ? `attendu : ${a.attendu}` : '';
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
    return Object.values(structure.contenants)
      .filter((c) => !c.supprime && (c.parent || '') === (idParent || ''))
      .sort((a, b) => a.ordre - b.ordre || a.nom.localeCompare(b.nom, 'fr'));
  }
  /** Du premier niveau jusqu'au contenant. */
  function chemin(id) {
    const suite = [];
    const vus = new Set();
    for (let c = contenant(id); c && !vus.has(c.id); c = contenant(c.parent)) { vus.add(c.id); suite.unshift(c); }
    return suite;
  }
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
  const dansUnMobile = (c) => Boolean(c) && chemin(c.id).some((x) => x.categorie === 'mobile');
  // Consultation seule (inventaire impossible) : demandée (recherche par le nom) ; contenant mobile ouvert sans avoir
  // dit où l'on est, ou enregistré dans un autre contenant primaire que celui où l'on est ; aucun contenant primaire connu.
  const enConsultation = (c) => {
    if (contexte.consultation) return true;
    if (!c) return false;
    const ici = contenant(contexte.primaire);
    const structurel = primaireDe(c.id);
    if (!ici) return dansUnMobile(c) || !structurel;
    return dansUnMobile(c) && (!structurel || structurel.id !== ici.id);
  };
  /**
   * Niveau du dessus, pour la flèche retour et l'arborescence : en check-list, un emplacement
   * (« ici, un exemplaire de tel inventaire type ») s'efface derrière le contenant qui l'occupe.
   */
  function parentVisible(c) {
    const vus = new Set();
    let p = contenant(c.parent);
    while (p && p.emplacement && !gestion && !vus.has(p.id)) { vus.add(p.id); p = contenant(p.parent); }
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

  /** État d'un contenant et de tout ce qu'il contient. */
  function bilan(id) {
    const b = { total: 0, faits: 0, manquants: 0, perimes: 0, proches: 0, sansDate: 0 };
    descendants(id).forEach((c) => {
      if (dansUnModele(c.id)) return; // un inventaire type ne se vérifie pas
      if (c.emplacement && !occupantDuJour(c)) { b.total += 1; b.vides = (b.vides || 0) + 1; }
      if (aCocher(c).length) {
        b.total += 1;
        const v = verifDuJour(c.id);
        if (v) { b.faits += 1; b.manquants += v.manquants.length; }
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
    b.anomalie = b.manquants > 0 || b.perimes > 0;
    b.classe = b.total === 0 ? 'vide' : (b.complet ? `fait${b.anomalie ? ' anomalie' : ''}` : (b.faits ? 'encours' : 'afaire'));
    b.texte = b.total === 0 ? 'Rien à cocher' : (b.complet ? 'Vérifié aujourd\'hui' : (b.faits ? `${b.faits} sur ${b.total} vérifiés` : 'À vérifier'));
    return b;
  }

  function marquer(id) {
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

  /** Photo réduite à 1280 px et compressée (JPEG) : légère pour l'envoi et le stockage. */
  function reduirePhoto(fichier, cote = 1280) {
    return new Promise((ok, ko) => {
      const url = URL.createObjectURL(fichier);
      const img = new Image();
      img.onload = () => {
        const ratio = Math.min(1, cote / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * ratio);
        c.height = Math.round(img.height * ratio);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        let donnees = c.toDataURL('image/jpeg', 0.72);
        if (donnees.length > PHOTO_MAX) donnees = c.toDataURL('image/jpeg', 0.5);
        if (donnees.length > PHOTO_MAX) ko(new Error('photo trop lourde'));
        else ok(donnees);
      };
      img.onerror = () => { URL.revokeObjectURL(url); ko(new Error('image illisible')); };
      img.src = url;
    });
  }

  /**
   * Recadrage d'une photo (fichier ou data URL) : rotation par quart de tour, cadre déplaçable
   * et redimensionnable aux coins. Résout { donnees, transformer } ou null si annulé ;
   * `transformer(x, y)` reporte un point (0..1 sur l'ancienne photo) sur la nouvelle, ou null s'il en sort.
   */
  function recadrerImage(source, cote = 1280) {
    return new Promise((ok, ko) => {
      const img = new Image();
      const url = typeof source === 'string' ? source : URL.createObjectURL(source);
      const liberer = () => { if (typeof source !== 'string') URL.revokeObjectURL(url); };
      img.onerror = () => { liberer(); ko(new Error('image illisible')); };
      img.onload = () => {
        liberer();
        if (!img.width || !img.height) { ko(new Error('image illisible')); return; }
        // Travail sur une copie limitée à 2400 px : fluide sur smartphone, largement assez pour 1280 px en sortie.
        const echelle = Math.min(1, 2400 / Math.max(img.width, img.height));
        const lw = Math.round(img.width * echelle);
        const lh = Math.round(img.height * echelle);
        let quarts = 0;
        let r = { x: 0, y: 0, w: 1, h: 1 };
        const toile = el('canvas', { classe: 'inv-recadrage-toile' });
        const dessiner = () => {
          const tourne = quarts % 2 === 1;
          toile.width = tourne ? lh : lw;
          toile.height = tourne ? lw : lh;
          const ctx = toile.getContext('2d');
          ctx.save();
          ctx.translate(toile.width / 2, toile.height / 2);
          ctx.rotate((quarts * Math.PI) / 2);
          ctx.drawImage(img, -lw / 2, -lh / 2, lw, lh);
          ctx.restore();
        };
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
        const fermer = (resultat) => { fond.remove(); document.removeEventListener('keydown', clavier); ok(resultat); };
        const clavier = (e) => { if (e.key === 'Escape') fermer(null); };
        const valider = () => {
          const sx = Math.round(r.x * toile.width);
          const sy = Math.round(r.y * toile.height);
          const sw = Math.max(1, Math.round(r.w * toile.width));
          const sh = Math.max(1, Math.round(r.h * toile.height));
          const ratio = Math.min(1, cote / Math.max(sw, sh));
          const sortie = document.createElement('canvas');
          sortie.width = Math.round(sw * ratio);
          sortie.height = Math.round(sh * ratio);
          const ctx = sortie.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, sortie.width, sortie.height);
          ctx.drawImage(toile, sx, sy, sw, sh, 0, 0, sortie.width, sortie.height);
          let donnees = '';
          for (const qualite of [0.72, 0.6, 0.5]) {
            donnees = sortie.toDataURL('image/jpeg', qualite);
            if (donnees.length <= PHOTO_MAX) break;
          }
          if (donnees.length > PHOTO_MAX) { fond.remove(); document.removeEventListener('keydown', clavier); ko(new Error('photo trop lourde')); return; }
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
          fermer({ donnees, transformer });
        };
        const titre = idChamp();
        const fond = el('div', { classe: 'inv-recadrage', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titre },
          el('div', { classe: 'inv-recadrage-tete' },
            el('h2', { id: titre, texte: 'Recadrer la photo' }),
            el('button', { type: 'button', classe: 'cfg-mini', 'aria-label': 'Tourner d\'un quart de tour', title: 'Tourner', texte: '↻', surclick: () => { quarts = (quarts + 1) % 4; r = { x: 0, y: 0, w: 1, h: 1 }; dessiner(); placer(); } }),
            el('button', { type: 'button', classe: 'cfg-mini', title: 'Toute la photo', texte: 'Tout', surclick: () => { r = { x: 0, y: 0, w: 1, h: 1 }; placer(); } })),
          el('div', { classe: 'inv-recadrage-zone' }, scene),
          el('p', { classe: 'aide-question', texte: 'Faites glisser le cadre ou ses coins.' }),
          el('div', { classe: 'inv-recadrage-actions' },
            el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Annuler', surclick: () => fermer(null) }),
            el('button', { type: 'button', classe: 'cfg-bouton inv-actif', texte: 'Valider', surclick: valider })));
        dessiner();
        placer();
        document.addEventListener('keydown', clavier);
        document.body.append(fond);
      };
      img.src = url;
    });
  }

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
          x.vues.forEach((v) => { if (v.photo === locale) { v.photo = distante; change = true; } });
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
    const contenants = {};
    rep.contenants.forEach((c) => {
      if (!c || !ID.test(c.id)) return;
      const recu = normaliser(c);
      const local = structure.contenants[c.id];
      // Inventaire identique à celui de l'appareil (cas courant : on vient de l'envoyer) : on garde l'objet
      // de l'appareil, auquel l'écran affiché est relié. Le remplacer ferait partir les ajouts suivants
      // dans une copie qui n'est plus enregistrée.
      if (local && identiques(local, recu)) contenants[c.id] = local;
      else { contenants[c.id] = recu; if (local) changeDistant = true; }
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
    etat = { verifs, peremptions };
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
    else if (pile.length > 1 && pile[pile.length - 2] === (id || '')) history.back();
    else location.hash = lien(id);
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
        if (dv !== undefined && (v || a.controle === 'scan')) valeurs[a.id] = dv;
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

  function valider(c) {
    if (enConsultation(c)) { messageVue('Consultation seule : indiquez d\'abord le contenant primaire où vous êtes.', 'erreur'); return; }
    const b = brouillon(c);
    if (aCocher(c).some((a) => b.invalides[a.id])) {
      messageVue('Une date de péremption n\'est pas reconnue : corrigez-la (ex. 03/2027 ou 15/03/2027).', 'erreur');
      return;
    }
    const articles = aCocher(c).map((a) => {
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
    });
    // Manquant : non coché, ou coché avec une quantité inférieure à celle attendue (jamais pour un article facultatif).
    const incomplet = (a) => !a.facultatif && (!a.ok || (a.attendu !== undefined && ecartQuantite(a.attendu, a.quantite, a.min)));
    const manquants = articles.filter(incomplet);
    if (manquants.length && confirmer !== `valider-${c.id}`) {
      confirmer = `valider-${c.id}`;
      const libelle = (a) => (a.controle ? `${a.nom} (${a.libelle})` : (a.ok ? `${a.nom} (${texteQuantite(a.quantite, a.attendu, a.min)})` : a.nom));
      messageVue(`Sera noté manquant ou en anomalie : ${manquants.map(libelle).join(' ; ')}. Corrigez ou appuyez de nouveau pour valider quand même.`, 'erreur');
      zone.querySelector('.inv-valider').textContent = 'Valider quand même';
      return;
    }
    const ok = App.mettreEnFile({
      action: 'verifierInventaire', contenant: c.id,
      detail: { chemin: chemin(c.id).map((x) => x.nom).join(' > '), articles: articles.map(({ libelle, ...x }) => x), remarque: b.remarque.trim() },
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
    delete brouillons.liste[c.id];
    sauverEtat();
    sauverBrouillons();
    confirmer = '';
    avis = `« ${c.nom} » vérifié${manquants.length ? ` : ${pluriel(manquants.length, 'manquant')}` : ''}.`;
    // S'il reste des sous-inventaires à vérifier, on reste ici ; sinon on remonte au contenant parent
    // (l'emplacement s'efface derrière son occupant : on remonte au niveau visible du dessus).
    const reste = enfants(c.id).some((f) => { const bf = bilan(f.id); return bf.total && !bf.complet; });
    const dessus = etagesAuDessus(c)[0];
    if (reste) rendre();
    else aller(dessus ? dessus.id : '');
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

  function badges(b) {
    const liste = [];
    if (b.manquants) liste.push(el('span', { classe: 'inv-badge alerte', texte: pluriel(b.manquants, 'manquant') }));
    if (b.perimes) liste.push(el('span', { classe: 'inv-badge alerte', texte: pluriel(b.perimes, 'périmé') }));
    if (b.proches) liste.push(el('span', { classe: 'inv-badge proche', texte: `${b.proches} bientôt périmé${b.proches > 1 ? 's' : ''}` }));
    if (b.sansDate) liste.push(el('span', { classe: 'inv-badge', texte: `${pluriel(b.sansDate, 'date')} à saisir` }));
    if (b.vides) liste.push(el('span', { classe: 'inv-badge proche', texte: `${pluriel(b.vides, 'emplacement')} à identifier` }));
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
  function carte(c, numero) {
    const b = bilan(c.id);
    const repere = el('span', { classe: `inv-repere ${b.classe}`, 'aria-hidden': 'true', texte: numero ? String(numero) : '' });
    if (!numero && c.photo) {
      const vignette = (donnees) => { if (donnees) repere.append(el('img', { src: donnees, alt: '' })); };
      if (Photos.enMemoire(c.photo)) vignette(Photos.enMemoire(c.photo));
      else obtenirPhoto(c.photo).then(vignette);
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
          c.modele ? el('span', { classe: 'inv-tag-scellable inv-tag-modele', texte: `Type · ${pluriel(exemplairesDe(c.id).length, 'exemplaire')}` }) : null,
          c.emplacement ? el('span', { classe: 'inv-tag-scellable inv-tag-emplacement', texte: 'Emplacement' }) : null),
        c.emplacement ? el('span', { classe: `inv-carte-occupant${occupant ? '' : ' vide'}`, texte: occupant ? `↳ ${occupant.nom}` : '↳ à identifier (QR, NFC ou liste)' }) : null,
        el('span', { classe: 'inv-carte-etat' }, b.complet ? '✓ ' : '', b.texte,
          sous ? ` · ${pluriel(sous, 'sous-inventaire')}` : ''),
        el('span', { classe: 'inv-badges' }, ...badges(b))),
      el('span', { classe: 'inv-chevron', 'aria-hidden': 'true', texte: '›' }));
  }

  /**
   * La modification des inventaires se fait dans l'administration (menu > Administration >
   * Gestion des inventaires). On reste dans ce mode en naviguant ; pour réaliser un inventaire,
   * on repasse par le menu (Inventaires).
   */
  function boutonEdition() { return null; }
  function bandeauGestion() {
    if (!gestion) return null;
    const ancien = versionServeur !== null && versionServeur < VERSION_SERVEUR
      ? el('p', { classe: 'message erreur inv-serveur-ancien', role: 'alert' },
        el('strong', { texte: 'Serveur pas à jour : certaines modifications ne seront pas enregistrées' }),
        ' (catégorie des contenants, vues, inventaires types…). Recopiez Inventaires.gs, Catalogue.gs, Code.gs et Installation.gs du dépôt AVISMUR-backend dans Apps Script, puis Déployer › Gérer les déploiements › nouvelle version.')
      : null;
    return el('div', {}, ancien, el('p', { classe: 'inv-bandeau-gestion' }, el('strong', { texte: 'Administration · Gestion des inventaires' }),
      ' — les modifications sont enregistrées au fur et à mesure. Pour réaliser un inventaire : menu › Inventaires.'));
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
        // Avec une photo, on enchaîne : toucher l'endroit où se trouve ce sous-inventaire.
        if (parent && vueCourante(parent).photo) { placement = c.id; rendre({ garderPosition: true }); zone.querySelector('.inv-photo').scrollIntoView({ block: 'center', behavior: 'smooth' }); }
        else rendre({ garderPosition: true, focus: '.inv-ajout input' });
      },
    }, el('label', { for: champ, texte: parent ? 'Ajouter un sous-inventaire' : 'Ajouter un inventaire' }),
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
   * et se pose là où on relâche. Un appui court garde le comportement habituel.
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
        majVue(c, vc.cle, { points: vc.points.filter((q) => q.cible !== cible).concat({ cible, ...position(e) }) });
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
  /** Bande du contenant primaire : où l'on est (ou « consultation seule » après une recherche par le nom). */
  function bandeauPrimaire(c) {
    if (gestion) return null;
    const structurel = c ? primaireDe(c.id) : null;
    const ici = contenant(contexte.primaire);
    if (enConsultation(c) && ici && structurel && structurel.id !== ici.id && !contexte.consultation) {
      // Contenant mobile enregistré ailleurs : on reste où l'on est ; il se vérifie une fois identifié à sa place ici.
      return el('div', { classe: 'inv-bande-primaire consultation', role: 'status' }, picto('lieu'),
        el('span', { classe: 'inv-bande-texte' }, 'Vous êtes dans ', el('strong', { texte: ici.nom }), ` · enregistré dans ${structurel.nom}`));
    }
    if (enConsultation(c)) {
      // Sans contenant primaire connu : l'agent dit dans lequel il se trouve pour pouvoir vérifier.
      const choix = structurel ? null : (() => {
        const primaires = Object.values(structure.contenants).filter((x) => !x.supprime && x.categorie === 'primaire' && !dansUnModele(x.id))
          .sort((x, y) => x.nom.localeCompare(y.nom, 'fr'));
        if (!primaires.length) return null;
        return el('select', { classe: 'inv-bande-action', 'aria-label': 'Je suis dans…', surchange: (e) => { if (e.target.value) { fixerContexte(e.target.value, false); rendre({ garderPosition: true }); } } },
          el('option', { value: '', texte: 'Je suis dans…' }), ...primaires.map((x) => el('option', { value: x.id, texte: x.nom })));
      })();
      return el('div', { classe: 'inv-bande-primaire consultation', role: 'status' }, picto('consultation'),
        el('span', { classe: 'inv-bande-texte' }, el('strong', { texte: 'Consultation seule' }), structurel ? ` · ${structurel.nom}` : ''),
        structurel ? el('button', { type: 'button', classe: 'inv-bande-action', texte: `Je suis dans ${structurel.nom}`, surclick: () => { fixerContexte(structurel.id, false); rendre({ garderPosition: true }); } }) : choix);
    }
    const p = contenant(contexte.primaire) || structurel;
    return el('div', { classe: `inv-bande-primaire${p ? '' : ' aucun'}`, role: 'status' }, picto('lieu'),
      el('span', { classe: 'inv-bande-texte' }, p ? 'Vous vérifiez actuellement ' : '', el('strong', { texte: p ? p.nom : 'Aucun contenant primaire' })));
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
    const noeuds = [
      bandeauGestion(),
      el('div', { classe: 'inv-entete inv-entete-racine' }, el('h1', { tabindex: '-1', texte: gestion ? 'Gestion des inventaires' : 'Inventaires' }),
        el('span', { classe: 'inv-entete-outils' }, ...(gestion ? [] : boutonsScanIcones().map((b) => { b.classList.add('inv-scan-ecran-large'); return b; })), loupe)),
      panneau,
      ligneSynchro(), ligneAvis(),
    ];
    noeuds.push(encadreARetrouver());
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
      noeuds.push(el('details', { classe: 'inv-alertes', open: perimes > 0 },
        el('summary', {}, 'Péremptions : ', [perimes ? pluriel(perimes, 'périmé') : '', alertes.length - perimes ? `${alertes.length - perimes} à moins de ${structure.reglages.alerteJours} jours` : ''].filter(Boolean).join(', ')),
        el('ul', {}, ...alertes.map((x) => el('li', { classe: x.p.niveau },
          el('a', { href: lien(x.c.id) }, el('strong', { texte: nomArticle(x.a) }), ` — ${chemin(x.c.id).map((y) => y.nom).join(' › ')}`),
          el('span', { texte: `${afficherDate(x.date)} · ${x.p.texte}` }))))));
    }

    // Page des inventaires : seulement les contenants primaires (véhicules, réserve).
    const primaires = tous.filter((c) => c.categorie === 'primaire' && !dansUnModele(c.id))
      .sort((x, y) => x.ordre - y.ordre || x.nom.localeCompare(y.nom, 'fr'));
    noeuds.push(el('h2', { classe: 'inv-titre-modeles', texte: 'Contenants primaires' }));
    noeuds.push(primaires.length
      ? el('ul', { classe: 'inv-liste' }, ...primaires.map((c) => el('li', {}, carte(c))))
      : el('p', { classe: 'aide-question', texte: estAdmin() ? (gestion ? 'Aucun contenant primaire : ouvrez un inventaire et choisissez la catégorie « Primaire ».' : 'Aucun contenant primaire : menu > Administration > Gestion des inventaires.') : 'Aucun contenant primaire pour l\'instant : utilisez la loupe ci-dessus.' }));
    // Administrateurs : inventaires de premier niveau pas encore classés.
    const aClasser = racines.filter((c) => !c.modele && !c.categorie);
    if (aClasser.length && gestion) {
      noeuds.push(el('h2', { classe: 'inv-titre-modeles', texte: 'À classer' }),
        el('p', { classe: 'aide-question', texte: 'Sans catégorie : visibles des administrateurs seulement. Ouvrez-les (Administration > Gestion des inventaires) et choisissez Primaire, Immobile ou Mobile.' }),
        el('ul', { classe: 'inv-liste' }, ...aClasser.map((c) => el('li', {}, carte(c)))));
    }
    // Inventaires types : visibles des administrateurs seulement.
    const modeles = racines.filter((c) => c.modele);
    if (modeles.length && gestion) {
      noeuds.push(el('h2', { classe: 'inv-titre-modeles', texte: 'Inventaires types' }),
        el('p', { classe: 'aide-question', texte: 'Ils servent de structure à leurs exemplaires et ne se vérifient pas.' }),
        el('ul', { classe: 'inv-liste' }, ...modeles.map((c) => el('li', {}, carte(c)))));
    }

    if (gestion) noeuds.push(blocReinitialisationDev());

    if (edition) {
      const champ = idChamp();
      noeuds.push(formulaireAjout(null),
        el('div', { classe: 'cfg-section' },
          el('h2', { texte: 'Réglages' }),
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
            })),
          tous.length ? el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Imprimer toutes les étiquettes QR', surclick: () => imprimerEtiquettes(tous) }) : null));
    }
    return noeuds;
  }

  // ----- Développement : réinitialiser les inventaires du jour pour rejouer des tests -----
  function blocReinitialisationDev() {
    const enAttente = confirmer === 'reinit-jour';
    return el('div', { classe: 'cfg-section inv-dev' },
      el('h2', { texte: 'Développement' }),
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
  function blocPhoto(c, fils) {
    const vues = vuesDe(c);
    const vc = vueCourante(c);
    const avecPhoto = vues.some((v) => v.photo);
    if (!avecPhoto && !edition) return null;
    const bloc = el('div', { classe: 'inv-bloc-photo' });
    // Onglets des vues (plusieurs angles d'une pièce, d'une cellule sanitaire…)
    const plusieurs = vues.length > 1;
    const peutAjouter = edition; // tout contenant peut avoir plusieurs vues (angles, tiroir fermé/ouvert…)
    if (plusieurs || peutAjouter) {
      const onglets = el('div', { classe: 'inv-onglets-vues', role: 'tablist', 'aria-label': 'Vues' },
        ...vues.map((v) => {
          const nb = v.points.filter((p) => fils.some((f) => f.id === p.cible)).length;
          return el('button', { type: 'button', role: 'tab', classe: 'inv-onglet-vue', 'aria-selected': String(v.cle === vc.cle),
            surclick: () => { vueActive.set(c.id, v.cle); rendre({ garderPosition: true }); } },
          v.nom, nb ? el('small', { texte: ` · ${nb}` }) : null);
        }),
        peutAjouter ? el('button', { type: 'button', classe: 'inv-onglet-vue inv-onglet-ajout', 'aria-label': 'Ajouter une vue', title: 'Ajouter une vue (autre angle)', texte: '＋ Vue', surclick: () => {
          const v = { id: nouvelId(), nom: `Vue ${c.vues.length + 2}`, photo: '', points: [] };
          c.vues.push(v);
          vueActive.set(c.id, v.id);
          marquer(c.id);
          rendre({ garderPosition: true });
        } }) : null);
      bloc.append(onglets);
    }
    if (vc.photo) {
      const img = el('img', { alt: `Photo : ${c.nom}${plusieurs ? ` — ${vc.nom}` : ''}` });
      const attente = el('p', { classe: 'inv-photo-attente', texte: 'Chargement de la photo…' });
      const cadre = el('div', { classe: `inv-photo${placement ? ' placement' : ''}` }, img, attente);
      const montrer = (donnees) => {
        if (donnees) { img.src = donnees; attente.remove(); } else { attente.textContent = 'Photo pas encore disponible hors ligne : passez par la liste ci-dessous.'; cadre.classList.add('sans-image'); }
      };
      if (Photos.enMemoire(vc.photo)) montrer(Photos.enMemoire(vc.photo));
      else obtenirPhoto(vc.photo).then(montrer);
      img.draggable = false; // pas de « glisser l'image » du navigateur pendant le placement
      if (placement) {
        // Aperçu de la gommette qui suit la souris : on voit où elle sera posée, même sur une photo sombre.
        const rang = fils.findIndex((f) => f.id === placement);
        const apercu = el('span', { classe: 'inv-point inv-apercu', 'aria-hidden': 'true', texte: rang === -1 ? '' : String(rang + 1), hidden: true });
        cadre.append(apercu);
        cadre.addEventListener('pointermove', (e) => {
          if (e.pointerType !== 'mouse') return;
          const r = img.getBoundingClientRect();
          apercu.hidden = false;
          apercu.style.left = `${((e.clientX - r.left) / r.width) * 100}%`;
          apercu.style.top = `${((e.clientY - r.top) / r.height) * 100}%`;
        });
        cadre.addEventListener('pointerleave', () => { apercu.hidden = true; });
      }
      img.addEventListener('click', (e) => {
        if (!placement) return;
        const r = img.getBoundingClientRect();
        const borne = (v) => Math.min(1, Math.max(0, v));
        majVue(c, vc.cle, { points: vc.points.filter((p) => p.cible !== placement)
          .concat({ cible: placement, x: borne((e.clientX - r.left) / r.width), y: borne((e.clientY - r.top) / r.height) }) });
        placement = '';
        marquer(c.id);
        rendre({ garderPosition: true });
      });
      vc.points.forEach((p) => {
        const rang = fils.findIndex((f) => f.id === p.cible);
        if (rang === -1) return;
        const b = bilan(fils[rang].id);
        // Validé par le scellé (« Oui, il est scellé ») : cadenas à la place du ✓, couleur du dernier inventaire.
        const scelle = !edition && b.complet && sousScelle(fils[rang]);
        const commun = {
          classe: `inv-point ${b.classe}${scelle ? ' scelle' : ''}${placement === p.cible ? ' deplace' : ''}`, style: `left:${p.x * 100}%;top:${p.y * 100}%`,
          'aria-label': `${fils[rang].nom} : ${b.texte}`, title: fils[rang].nom,
        };
        const pastille = edition
          ? el('button', { type: 'button', ...commun, texte: String(rang + 1), surclick: () => { placement = placement === p.cible ? '' : p.cible; rendre({ garderPosition: true }); } })
          : el('a', { href: lien(p.cible), ...commun, texte: scelle ? '' : (b.complet ? '✓' : String(rang + 1)) });
        if (scelle) pastille.append(logoCadenas());
        if (edition) glisserPastille(pastille, img, c, vc, p.cible);
        cadre.append(pastille);
      });
      if (placement && contenant(placement)) {
        bloc.append(el('p', { classe: 'inv-consigne-placement', role: 'status' },
          `Touchez la photo${plusieurs ? ` « ${vc.nom} »` : ''} à l'endroit de « ${contenant(placement).nom} ». `,
          el('button', { type: 'button', classe: 'lien', texte: 'Plus tard', surclick: () => { placement = ''; rendre({ garderPosition: true }); } })));
      }
      bloc.append(cadre);
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
          }
          majVue(c, vc.cle, champs);
          marquer(c.id);
          rendre({ garderPosition: true });
          if (perdus) messageVue(`${perdus} point${perdus > 1 ? 's' : ''} hors du cadre retiré${perdus > 1 ? 's' : ''} : replacez ${perdus > 1 ? 'les sous-inventaires concernés' : 'le sous-inventaire concerné'}.`, 'erreur');
        } catch (err) {
          messageVue('Photo illisible ou trop lourde : réessayez.', 'erreur');
        }
      };
      const recevoir = (e) => {
        const fichier = e.target.files[0];
        e.target.value = '';
        if (fichier) appliquerRecadrage(fichier, false);
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
        el('label', { for: prendre, classe: 'bouton-photo', texte: vc.photo ? '📷 Reprendre la photo' : '📷 Prendre la photo' }),
        el('input', { type: 'file', id: prendre, accept: 'image/*', capture: 'environment', classe: 'invisible', surchange: recevoir }),
        el('label', { for: choisir, classe: 'bouton-photo', texte: 'Choisir une image' }),
        el('input', { type: 'file', id: choisir, accept: 'image/*', classe: 'invisible', surchange: recevoir }),
        vc.photo ? el('button', { type: 'button', classe: 'bouton-photo', texte: '✂ Recadrer', surclick: recadrerActuelle }) : null,
        vc.photo && !vc.cle ? el('button', { type: 'button', classe: 'lien danger', texte: 'Retirer la photo', surclick: () => { majVue(c, '', { photo: '', points: [] }); marquer(c.id); rendre({ garderPosition: true }); } }) : null,
        vc.cle ? el('button', { type: 'button', classe: 'lien danger', texte: confirmer === `vue-${vc.cle}` ? 'Confirmer : supprimer cette vue' : 'Supprimer cette vue', surclick: () => {
          if (confirmer !== `vue-${vc.cle}`) { confirmer = `vue-${vc.cle}`; rendre({ garderPosition: true }); return; }
          confirmer = '';
          c.vues = c.vues.filter((v) => v.id !== vc.cle);
          vueActive.delete(c.id);
          marquer(c.id);
          rendre({ garderPosition: true });
        } }) : null));
      if (!avecPhoto) bloc.append(el('p', { classe: 'aide-question', texte: `La photo sert de plan : chaque sous-inventaire y est repéré par un point numéroté. « ＋ Vue » ajoute d\'autres photos (autres angles, faces, compartiments).` }));
    }
    return bloc;
  }

  function blocEnfants(c, fils) {
    if (!fils.length && !edition) return null;
    const liste = el('ul', { classe: 'inv-liste' });
    fils.forEach((f, i) => {
      const li = el('li', { 'data-cle': f.id }, carte(f, i + 1));
      if (edition) {
        const vc = vueCourante(c);
        const point = vc.points.some((p) => p.cible === f.id);
        const ailleurs = vuesDe(c).filter((v) => v.cle !== vc.cle && v.points.some((p) => p.cible === f.id)).map((v) => v.nom);
        li.classList.add('inv-ligne-triable');
        li.prepend(poignee(f.nom));
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
        li.append(reglages);
        li.append(el('div', { classe: 'cfg-ligne inv-outils' },
          vc.photo ? el('button', {
            type: 'button', classe: `cfg-mini${placement === f.id ? ' inv-actif' : ''}`, texte: point ? 'Déplacer le point' : `Placer sur ${vuesDe(c).length > 1 ? `« ${vc.nom} »` : 'la photo'}`,
            surclick: () => { placement = f.id; rendre({ garderPosition: true }); zone.querySelector('.inv-photo').scrollIntoView({ block: 'center', behavior: 'smooth' }); },
          }) : null,
          point ? el('button', { type: 'button', classe: 'cfg-mini', texte: 'Retirer le point', surclick: () => { majVue(c, vc.cle, { points: vc.points.filter((p) => p.cible !== f.id) }); marquer(c.id); rendre({ garderPosition: true }); } }) : null,
          ailleurs.length ? el('small', { classe: 'aide-question', texte: `aussi sur : ${ailleurs.join(', ')}` }) : null));
      }
      liste.append(li);
    });
    if (!edition) return el('section', { classe: 'inv-section' }, el('h2', { texte: 'Sous-inventaires' }), liste);
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
    const choixType = el('select', { id: idType }, el('option', { value: '', texte: types.length ? 'Choisir l\'inventaire type attendu…' : 'Aucun inventaire type' }),
      ...types.map((t) => el('option', { value: t.id, texte: t.nom })));
    const ajoutEmplacement = el('div', { classe: 'inv-ajout inv-ajout-emplacement', hidden: !ajoutSousOuvert },
      el('label', { for: idType, texte: 'Ou ajouter un emplacement pour un contenant mobile' }),
      el('p', { classe: 'aide-question', texte: 'En check-list, l\'agent identifiera l\'exemplaire présent (QR, NFC ou liste) ; seuls les exemplaires de ce type seront acceptés.' }),
      el('div', { classe: 'cfg-ligne' }, choixType, el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Ajouter', disabled: !types.length, surclick: () => {
        const type = contenant(choixType.value);
        if (!type) return;
        const fratrie = enfants(c.id);
        const emp = normaliser({ id: nouvelId(), parent: c.id, nom: type.nom, categorie: 'mobile', emplacement: { modele: type.id }, ordre: fratrie.length ? fratrie[fratrie.length - 1].ordre + 1 : 0 });
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
  function ligneControle(a, b, modifie) {
    const li = el('li', { classe: `inv-article inv-controle inv-controle-${a.controle}` });
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
    } else if (a.controle === 'scan') {
      const entree = el('input', { id: champ, classe: 'inv-valeur inv-valeur-texte', autocomplete: 'off', maxlength: '120', placeholder: 'Scanner ou saisir', valeur: val(), surinput: (e) => poser(e.target.value.trim()) });
      const remplir = (t) => { entree.value = t; poser(t); };
      const boutonQr = el('button', { type: 'button', classe: 'cfg-mini inv-bouton-lecture', 'aria-label': `Scanner le QR code ou code-barres : ${nomArticle(a)}`, title: 'QR code / code-barres', surclick: () => lireCode(remplir, { qr: true, nfc: false }) }, logoQr());
      const boutonNfc = el('button', { type: 'button', classe: 'cfg-mini inv-bouton-lecture', 'aria-label': `Lire la puce NFC : ${nomArticle(a)}`, title: 'Puce NFC', surclick: () => lireCode(remplir, { qr: false, nfc: true }) }, logoNfc());
      saisie = el('span', { classe: 'inv-valeur-zone' }, entree, boutonQr, boutonNfc);
    } else {
      const unite = a.controle === 'temperature' ? '°C' : (a.controle === 'batterie' ? '%' : (a.unite || ''));
      const entree = el('input', { id: champ, type: 'text', inputmode: 'decimal', classe: 'inv-valeur', autocomplete: 'off', maxlength: '8', valeur: val(), surfocus: (e) => e.target.select(),
        surinput: (e) => poser(e.target.value.trim().replace(',', '.')) });
      saisie = el('span', { classe: 'inv-valeur-zone' }, entree, unite ? el('span', { classe: 'inv-qte-attendue', texte: unite }) : null);
    }
    ligne.append(saisie);
    li.append(ligne, noteCommentaire(a));
    etat_();
    return li;
  }
  /** Lit une valeur : QR code / code-barres (caméra) et/ou puce NFC (texte, lien ou n° de série de la puce). */
  async function lireCode(surLu, choix = { qr: true, nfc: true }) {
    const qr = choix.qr && 'BarcodeDetector' in window && navigator.mediaDevices;
    const nfc = choix.nfc && 'NDEFReader' in window;
    if (!qr && !nfc) { messageVue(choix.nfc && !choix.qr ? 'NFC non disponible sur cet appareil (Chrome sur Android requis) : saisissez la valeur.' : 'Lecture de code non disponible sur cet appareil : saisissez la valeur.', 'erreur'); return; }
    const video = el('video', { playsinline: '', muted: '', autoplay: '' });
    video.muted = true;
    const lecture = el('p', { classe: 'lecture', role: 'status', texte: qr ? 'Ouverture de la caméra…' : 'Approchez la puce NFC du dos du téléphone.' });
    let flux = null;
    let fini = false;
    const arretNfc = new AbortController();
    const fermer = () => {
      if (fini) return;
      fini = true;
      arretNfc.abort();
      if (flux) flux.getTracks().forEach((t) => t.stop());
      ecran.remove();
      document.body.classList.remove('camera-ouverte');
    };
    // Appareil du suivi du matériel (puce MySMUR, étiquette biomed, n° de série) : on inscrit son n° interne SMUR.
    const lu = (t, tout) => {
      const brut = String(t || '').trim();
      if (!brut || fini) return;
      const appareil = typeof Materiel !== 'undefined' ? Materiel.identifier(tout || brut) || Materiel.identifier(brut) : null;
      const v = (appareil && appareil.numInterne ? appareil.numInterne : brut).slice(0, 120);
      fermer();
      surLu(v);
      if (appareil && appareil.numInterne) messageVue(`${appareil.type} n° ${appareil.numInterne}${appareil.modele ? ` (${appareil.modele})` : ''} reconnu.`);
    };
    const ecran = el('div', { classe: 'camera', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Lire un code' },
      el('div', { classe: `camera-vue${qr ? '' : ' inv-nfc-seul'}` }, qr ? video : el('div', { classe: 'inv-attente-nfc', 'aria-hidden': 'true' }, logoNfc()),
        qr ? el('div', { classe: 'viseur viseur-qr', 'aria-hidden': 'true' }) : null,
        el('p', { classe: 'consigne-camera consigne-qr', texte: [qr ? 'Visez le QR code ou le code-barres' : '', nfc ? 'approchez la puce NFC' : ''].filter(Boolean).join(' ou ') })),
      lecture, el('div', { classe: 'camera-actions' }, el('button', { type: 'button', classe: 'camera-bouton secondaire', texte: 'Annuler', surclick: fermer })));
    document.body.append(ecran);
    document.body.classList.add('camera-ouverte');
    if (nfc) {
      const lecteur = new NDEFReader();
      lecteur.addEventListener('reading', (e) => {
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
      maj();
    };
    c.articles.forEach((a) => {
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
      if (estControle(a)) { liste.append(ligneControle(a, b, modifie)); return; }
      const champCase = idChamp();
      const coche = el('input', { type: 'checkbox', id: champCase, 'data-article': a.id, checked: Boolean(b.coches[a.id]), surchange: (e) => { b.coches[a.id] = e.target.checked; modifie(); } });
      const li = el('li', { classe: 'inv-article' });
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
      ? el('p', { classe: 'note-parc anomalie', texte: `Dernière vérification le ${new Date(v.date).toLocaleDateString('fr-FR')} par ${v.agent} : ${[v.manquants.length ? `manquant : ${v.manquants.map((m) => m.nom).join(', ')}` : '', v.remarque].filter(Boolean).join(' — ')}` })
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

  /** Fenêtre d'un article de la base : photo en grand et informations (vérification). */
  function voirFiche(f) {
    const fond = el('div', { classe: 'fenetre-fond', surclick: (e) => { if (e.target === fond) fermer(); } });
    const retour = document.activeElement;
    const fermer = () => { fond.remove(); document.body.classList.remove('fenetre-ouverte'); if (retour) retour.focus(); };
    const img = el('img', { classe: 'inv-fiche-grande', alt: f.denomination });
    obtenirPhoto(f.photo).then((d) => { if (d) img.src = d; });
    const lignes = [['Catégorie', f.categorie], ['Réf. interne', f.refInterne], ['Réf. fournisseur', f.refFournisseur],
      ['Consommable', f.consommable ? 'Oui' : 'Non'], ['Périssable', f.perissable ? 'Oui' : 'Non'], ['Dotation hors stock', f.horsStock ? 'Oui' : 'Non']];
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
      const trouves = tous.filter((c) => !c.emplacement && mots.every((m) => cle(c.nom).includes(m)))
        .sort((a, b) => (dansPrimaire(b) - dansPrimaire(a)) || a.nom.localeCompare(b.nom, 'fr'));
      trouves.slice(0, 12).forEach((c) => {
        const verifiable = gestion || dansPrimaire(c);
        const parents = etagesAuDessus(c).reverse().map((x) => x.nom).join(' › ');
        const ligne = carte(c);
        if (parents) ligne.querySelector('.inv-carte-etat').prepend(`${parents} · `);
        if (!verifiable) ligne.querySelector('strong').append(el('span', { classe: 'inv-tag-scellable inv-tag-consultation', texte: 'Consultation' }));
        // Avant la navigation (écouteur de la zone) : on note où l'on est et ce que l'on peut faire.
        ligne.addEventListener('click', () => { if (!gestion) fixerContexte(verifiable ? recherchePrimaire : '', !verifiable); });
        resultats.append(el('li', {}, ligne));
      });
      if (trouves.length > 12) resultats.append(el('li', { classe: 'aide-question', texte: `${trouves.length - 12} autre(s) : précisez la recherche.` }));
      if (!trouves.length) resultats.append(el('li', { classe: 'aide-question', texte: 'Aucun inventaire à ce nom.' }));
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
    panneau.append(choix,
      el('label', { for: champ, classe: 'invisible', texte: 'Nom de l\'inventaire' }),
      el('input', { id: champ, type: 'search', classe: 'inv-recherche-champ', valeur: recherche, autocomplete: 'off', placeholder: 'F25, sac rouge, ampoulier…', surinput: (e) => { recherche = e.target.value; filtrer(); } }),
      resultats);
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
    const versY = y ? y.parent : dans;
    const p = contenant(versY);
    if (!versY || !p) return;
    // L'ancien contenant de x garde sa gommette : place libre pour le prochain mobile rangé là.
    if (y) {
      traduireCibles(p, (cible) => (cible === y.id ? x.id : cible));
      x.ordre = y.ordre;
      y.parent = '';
      y.desaffecte = { depuis: date, de: versY, deNom: chemin(versY).map((c) => c.nom).join(' › '), par: App.agent() };
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
  }
  /** Contenants mobiles désaffectés (à retrouver), du plus ancien au plus récent. */
  const aRetrouver = () => Object.values(structure.contenants)
    .filter((c) => !c.supprime && c.desaffecte && !c.parent && !dansUnModele(c.id))
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
          el('button', { type: 'button', classe: 'lien inv-publier-mur', texte: 'Publier une alerte sur le mur', surclick: () => publierARetrouver(c) }));
      })));
  }
  /** Le contenant `x`, identifié par l'agent, est celui qui se trouve à la place de `y`. */
  function confirmerIdentification(y, idX, dans = '') {
    const x = contenant(idX);
    if (!x) { messageVue('Inventaire inconnu : vérifiez l\'étiquette ou la saisie.', 'erreur'); return; }
    if (y && x.id === y.id) { noterPointage(y.parent, y.id); identification = ''; aller(y.id); return; }
    if (!y && x.parent === dans) { noterPointage(dans, x.id); identification = ''; aller(x.id); return; }
    if (x.categorie !== 'mobile' || dansUnModele(x.id)) { messageVue(`« ${x.nom} » n'est pas un contenant mobile : choisissez celui qui se trouve réellement ici.`, 'erreur'); return; }
    const vers = y ? y.parent : dans;
    const emp = contenant(vers) && contenant(vers).emplacement ? contenant(vers) : null;
    if (emp && !modelesEmplacement(emp).includes(x.source)) {
      const noms = modelesEmplacement(emp).map((m) => (contenant(m) || {}).nom).filter(Boolean);
      messageVue(`Cet emplacement attend un exemplaire de ${noms.length ? noms.map((n) => `« ${n} »`).join(' ou ') : 'l\'inventaire type prévu'} : « ${x.nom} » n'en est pas un.`, 'erreur');
      return;
    }
    if (chemin(vers).some((c) => c.id === x.id)) { messageVue('Un contenant ne peut pas être rangé dans lui-même.', 'erreur'); return; }
    const parent = contenant(vers);
    const ancien = contenant(x.parent);
    const retrouve = Boolean(x.desaffecte);
    const date = new Date().toISOString();
    const ok = App.mettreEnFile({ action: 'deplacerContenant', contenant: x.id, ...(y ? { place: y.id } : { dans }), vers, date });
    if (!ok) { messageVue('Non enregistré : la mémoire de l\'appareil est pleine.', 'erreur'); return; }
    affecterLocal(x, y, date, dans);
    noterPointage(vers, x.id);
    identification = '';
    avis = `« ${x.nom} » est maintenant dans « ${parent ? parent.nom : '?'} »${ancien ? ` (il était dans « ${ancien.nom} »)` : (retrouve ? ' : il est retrouvé' : '')}.`
      + (y ? ` « ${y.nom} » est désaffecté : à retrouver, il est signalé sur la page des inventaires.` : '');
    aller(x.id);
  }
  /** Emplacement à plusieurs inventaires types : une photo par modèle, l'agent touche celui qu'il a sous les yeux. */
  function choixTypeEnPhotos(types) {
    return el('section', { classe: 'inv-choix-types', 'aria-label': 'Modèle présent' },
      el('p', { classe: 'inv-libelle-recherche', texte: '1. Touchez le modèle présent :' }),
      el('div', { classe: 'inv-types-grille', role: 'radiogroup' }, ...types.map((t) => {
        const image = el('span', { classe: 'inv-type-photo', 'aria-hidden': 'true' });
        if (t.photo) {
          const mettre = (d) => { if (d) image.append(el('img', { src: d, alt: '' })); };
          if (Photos.enMemoire(t.photo)) mettre(Photos.enMemoire(t.photo)); else obtenirPhoto(t.photo).then(mettre);
        } else image.textContent = 'Pas de photo';
        const n = exemplairesDe(t.id).length;
        return el('button', { type: 'button', role: 'radio', 'aria-checked': String(typeChoisi === t.id), classe: `inv-type${typeChoisi === t.id ? ' choisi' : ''}`,
          surclick: () => { typeChoisi = typeChoisi === t.id ? '' : t.id; rendre({ garderPosition: true }); } },
          image, el('strong', { texte: t.nom }), el('small', { texte: pluriel(n, 'exemplaire') }));
      })),
      el('p', { classe: 'aide-question', texte: typeChoisi ? '2. Identifiez maintenant l\'exemplaire : QR code, NFC ou liste.' : 'Vous pouvez aussi scanner directement l\'étiquette : le modèle sera reconnu.' }));
  }
  /** Écran « Quel … se trouve ici ? » : QR code, NFC ou saisie, avant l'inventaire d'un contenant mobile. */
  function vueIdentification(y, dans = '') {
    const lieu = contenant(y ? y.parent : dans);
    // Pour un emplacement, l'écran s'affiche depuis le contenant de l'emplacement (le sac).
    const parent = lieu && lieu.emplacement ? contenant(lieu.parent) : lieu;
    const choisir = (id) => confirmerIdentification(y, id, dans);
    const champ = idChamp();
    const resultats = el('ul', { classe: 'inv-liste inv-resultats-recherche' });
    // Emplacement : seuls les exemplaires de l'inventaire type attendu sont proposés.
    const emp = (() => { const p = contenant(y ? y.parent : dans); return p && p.emplacement ? p : null; })();
    // Plusieurs inventaires types acceptés : l'agent choisit d'abord, sur photo, le modèle présent.
    const typesAcceptes = emp ? modelesEmplacement(emp).map(contenant).filter(Boolean) : [];
    if (typeChoisi && !typesAcceptes.some((t) => t.id === typeChoisi)) typeChoisi = '';
    const plusieurs = typesAcceptes.length > 1;
    const typeAttendu = plusieurs ? (typeChoisi ? contenant(typeChoisi) : null) : (typesAcceptes[0] || null);
    const filtreTypes = typeAttendu ? [typeAttendu.id] : typesAcceptes.map((t) => t.id);
    const mobiles = Object.values(structure.contenants).filter((c) => !c.supprime && c.categorie === 'mobile' && !dansUnModele(c.id)
      && (!emp || filtreTypes.includes(c.source)));
    // Même type d'abord : exemplaires du même contenant d'inventaire type, puis noms proches.
    const memeType = (c) => (emp ? true : y ? (y.source && c.source === y.source) || cle(c.nom).replace(/\d+|n°/g, '').trim() === cle(y.nom).replace(/\d+|n°/g, '').trim() : Boolean(c.desaffecte));
    const filtrer = (texte) => {
      resultats.innerHTML = '';
      const mots = cle(texte).split(' ').filter(Boolean);
      const trouves = mobiles.filter((c) => mots.every((m) => cle(c.nom).includes(m)))
        .sort((a, b) => (memeType(b) - memeType(a)) || (Boolean(b.desaffecte) - Boolean(a.desaffecte)) || a.nom.localeCompare(b.nom, 'fr'));
      if (!mots.length && !trouves.some(memeType)) return;
      (mots.length ? trouves : trouves.filter(memeType)).slice(0, 12).forEach((c) => {
        const ou = contenant(c.parent);
        resultats.append(el('li', {}, el('button', { type: 'button', classe: 'inv-resultat', surclick: () => choisir(c.id) },
          el('strong', { texte: c.nom }), el('small', { classe: c.desaffecte ? 'inv-desaffecte' : '', texte: ou ? `actuellement dans ${chemin(ou.id).map((z) => z.nom).join(' › ')}` : (c.desaffecte ? 'désaffecté : à retrouver' : 'hors contenant') }))));
      });
    };
    const saisie = el('input', { id: champ, type: 'search', autocomplete: 'off', placeholder: y ? `ex. ${y.nom.replace(/\s*n°\s*\d+$/i, '')}` : 'ex. ampoulier, sacoche', surinput: (e) => filtrer(e.target.value) });
    filtrer('');
    const qr = 'BarcodeDetector' in window;
    const nfc = 'NDEFReader' in window;
    return [
      parent ? barreContenant(parent, { h1: false, libelleRetour: parent.nom, retour: () => { identification = ''; rendre(); } }) : null,
      el('h1', { tabindex: '-1', texte: typeAttendu ? `Quel « ${typeAttendu.nom} » se trouve ici ?` : (plusieurs ? `Quel « ${emp.nom} » se trouve ici ?` : (y ? `Quel « ${y.nom.replace(/\s*n°\s*\d+$/i, '')} » se trouve ici ?` : 'Quel contenant mobile se trouve ici ?')) }),
      plusieurs ? choixTypeEnPhotos(typesAcceptes) : null,
      el('p', { classe: 'consigne' }, `Avant de vérifier son contenu et ses péremptions, identifiez le contenant réellement présent dans « ${parent ? parent.nom : ''} » : scannez son QR code, lisez sa puce NFC ou choisissez-le dans la liste.`),
      el('section', { classe: 'inv-encadre-recherche' },
        el('div', { classe: 'inv-boutons-scan' },
          el('button', { type: 'button', classe: 'inv-bouton-scan', disabled: !qr, surclick: () => scanner({ qr: true, nfc: false }, choisir) }, logoQr(), el('span', { texte: 'Scanner son QR code' })),
          el('button', { type: 'button', classe: 'inv-bouton-scan', disabled: !nfc, surclick: () => scanner({ qr: false, nfc: true }, choisir) }, logoNfc(), el('span', { texte: 'Lire sa puce NFC' }))),
        el('label', { for: champ, classe: 'inv-libelle-recherche inv-libelle-identif', texte: 'Ou choisissez-le :' }), saisie, resultats),
      el('p', { classe: 'message inv-message', role: 'alert', hidden: true }),
      el('p', { classe: 'aide-question', texte: y ? `Identifié ici la dernière fois : « ${y.nom} » — à pointer de nouveau chaque jour. Si c'en est un autre, il prend sa place et « ${y.nom} » est désaffecté jusqu'à ce qu'on le retrouve ailleurs.` : `Le contenant choisi sera rangé dans « ${parent ? parent.nom : ''} ». S'il était désaffecté, il est retrouvé.` }),
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
      if (!gestion && x.emplacement) {
        const occ = occupantDuJour(x);
        if (!occ) return el('li', {}, el('span', { classe: 'inv-arbre-lien inv-arbre-vide' }, el('span', { classe: 'inv-arbre-nom', texte: `${x.nom} · à identifier` })));
        x = occ;
      }
      const fils = enfants(x.id);
      const b = dansUnModele(x.id) ? null : bilan(x.id);
      const actuel = x.id === c.id;
      const lienNoeud = el('a', { href: lien(x.id), classe: `inv-arbre-lien${actuel ? ' actuel' : ''}`, 'aria-current': actuel ? 'page' : null },
        b && b.total ? el('span', { classe: `inv-arbre-etat ${b.classe}`, title: b.texte, 'aria-label': b.texte }) : null,
        el('span', { classe: 'inv-arbre-nom', texte: x.nom }),
        x.emplacement ? el('small', { texte: fils[0] ? ` ↳ ${fils[0].nom}` : ' ↳ à identifier' }) : null,
        aCocher(x).length ? el('small', { classe: 'inv-arbre-nb', texte: ` ${aCocher(x).length}` }) : null);
      if (!fils.length || x.emplacement) return el('li', {}, lienNoeud);
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
   *     dont la fiche est de catégorie « Biomédical » ; un contenant qui attend un tel article dans sa propre
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
  const articleBiomed = (a) => Boolean(fiche(a)) && fiche(a).categorie === 'Biomédical';
  /** Contenant d'un appareil biomédical (ex. un scope et ses pochettes) : sa liste attend un article « Biomédical ». */
  // Un contrôle « scan » (n° d'appareil scanné : puce MySMUR, étiquette biomed, n° de série) désigne aussi un appareil biomédical.
  const appareilScanne = (a) => !a.separateur && a.controle === 'scan';
  const contenantBiomed = (c) => aCocher(c).some((a) => articleBiomed(a) || appareilScanne(a));
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
        if (a.controle === 'scan') {
          if (val) detail.appareils.push({ nom: `${nomArticle(a).replace(/\s*(n°|no|num(éro)?)\.?\s*$/i, '')} n° ${val}`, ou: ici, ok: e.ok });
          return;
        }
        detail.controles.push({ nom: nomArticle(a), ou: ici, texte: texteValeur(a, val), ok: e.ok, rempli: e.rempli });
        if (e.rempli && !e.ok && !estFacultatif(a)) controleKo = true;
        if (a.controle === 'batterie' && e.rempli) {
          const niveau = Number(String(val).replace(',', '.')) / (a.echelle === '4' ? 4 : 100);
          if (!batterie || niveau < batterie.niveau) batterie = { niveau, ok: e.ok, texte: texteValeur(a, val) };
        }
        if (estBranchement(a) && e.rempli) branchement = { ok: e.ok && (!branchement || branchement.ok) };
      });
    });
    detail.peremptions.sort((x, y) => x.jours - y.jours);
    const anomalie = detail.manquants.length > 0 || b.perimes > 0 || controleKo;
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
    return { b, classe, pictos, detail, biomed: contenantBiomed(c) };
  }
  /** Pop-up d'une tuile : le détail, et l'accès à l'inventaire. */
  /** Qui a validé l'inventaire et à quelle heure : en tout petit, grisé, seulement dans les détails. */
  const mentionValidation = (v) => (v ? el('p', { classe: 'inv-mention-validation',
    texte: `Validé${v.scelle ? ' (scellé)' : ''} à ${heure(v.date)}${v.agent ? ` par ${v.agent}` : ''}` }) : null);
  function detailTableau(c, place = '') {
    const r = resumeTableau(c);
    const v = aCocher(c).length ? verifDuJour(c.id) : null;
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
      el('p', { classe: 'fenetre-resume', texte: [...etagesAuDessus(c).reverse().map((x) => x.nom), place && cle(place) !== cle(c.nom) ? `emplacement « ${place} »` : ''].filter(Boolean).join(' › ') }),
      el('p', { classe: `inv-tb-statut ${r.classe}` }, el('span', { classe: 'inv-tb-pictos' }, ...r.pictos),
        el('strong', { texte: sousScelle(c) ? 'Scellé : non ouvert aujourd\'hui' : r.b.texte }),
        sous ? ` · ${pluriel(sous, 'sous-inventaire')}` : ''),
      mentionValidation(v),
      rubrique('Manquants', r.detail.manquants.map((x) => el('li', { classe: 'rouge' }, x.nom, ou(x)))),
      rubrique('Péremptions', r.detail.peremptions.map((x) => el('li', { classe: x.pe.niveau === 'perime' ? 'rouge' : 'orange' }, `${x.nom} : ${afficherDate(x.date)} (${x.pe.texte})`, ou(x)))),
      rubrique('Appareils', r.detail.appareils.map((x) => el('li', { classe: x.ok ? '' : 'rouge' }, el('strong', { texte: x.nom }), ou(x)))),
      rubrique('Contrôles', r.detail.controles.map((x) => el('li', { classe: x.rempli && !x.ok ? 'rouge' : '' }, `${x.nom} : ${x.texte}`, ou(x)))),
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
  function tuileTableau(c, niveau = 0, vus = new Set(), place = '') {
    if (vus.has(c.id)) return null;
    vus.add(c.id);
    if (c.emplacement) {
      const occupant = gestion ? enfants(c.id)[0] : occupantDuJour(c);
      if (occupant) return tuileTableau(occupant, niveau, vus, c.nom);
      return el('div', { classe: 'inv-tb-tuile avide' },
        el('button', { type: 'button', classe: 'inv-tb-tete', 'aria-haspopup': 'dialog', surclick: () => aller(c.id) },
          el('span', { classe: 'inv-tb-nom', texte: c.nom }),
          el('span', { classe: 'inv-tb-pictos' }, picto('identifier', 'À identifier', 'orange'))));
    }
    const r = resumeTableau(c);
    const fils = enfants(c.id).map((f) => tuileTableau(f, niveau + 1, vus)).filter(Boolean);
    return el('div', { classe: `inv-tb-tuile ${r.classe}${fils.length ? ' parent' : ''}${niveau === 0 ? ' inv-tb-primaire' : ''}` },
      el('button', { type: 'button', classe: 'inv-tb-tete', 'aria-haspopup': 'dialog', title: place && cle(place) !== cle(c.nom) ? `Emplacement : ${place}` : null, surclick: () => detailTableau(c, place) },
        el('span', { classe: `inv-tb-nom${r.biomed ? ' inv-tb-biomed' : ''}`, texte: c.nom }),
        el('span', { classe: 'inv-tb-pictos' }, ...r.pictos)),
      fils.length ? el('div', { classe: 'inv-tb-grille' }, ...fils) : null);
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
        return [onglets, el('div', { classe: 'inv-tb', role: 'tabpanel' }, tuileTableau(actuel))];
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
        const donnees = await reduirePhoto(fichier, 900);
        const id = `local-${nouvelId()}`;
        await Photos.ecrire(id, donnees);
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
        // Un médicament est périssable par défaut, tant qu'on n'a pas choisi soi-même.
        if (!perissableTouche.valeur) { f.perissable = cat === 'Médicament'; casePerissable.querySelector('input').checked = f.perissable; }
      } }), el('label', { for: i, texte: cat }));
    });
    const valider = () => {
      f.denomination = f.denomination.trim().replace(/\s+/g, ' ');
      f.refInterne = f.refInterne.trim();
      f.refFournisseur = f.refFournisseur.trim();
      const probleme = !f.denomination ? 'Indiquez la dénomination.' : (!f.categorie ? 'Choisissez la catégorie (Médicament, DM, Magasin, Kit, Biomédical ou Autre).' : '');
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
        caseFiche('horsStock', 'Dotation hors stock', 'ne fait pas partie du stock de la pharmacie')),
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
  function champCommentaire(c, a) {
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
    if (a.controle === 'scan') reglages.push(el('label', { classe: 'inv-qte-libelle' }, 'Attendu ', el('input', { classe: 'inv-attendu', maxlength: '60', placeholder: 'facultatif', valeur: a.attendu || '', 'aria-label': `Valeur attendue (${a.nom})`, surchange: (e) => { const t = e.target.value.trim(); if (t) a.attendu = t; else delete a.attendu; marquer(c.id); } })));
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
          qte), caseFacultatif(c, a), ...fleches)));
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
      creation = creation || { id: nouvelId(), denomination: rechercheAjout.trim(), categorie: '', horsStock: false, refInterne: '', refFournisseur: '', consommable: true, perissable: false, archive: false };
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
      trouvees.slice(0, 8).forEach((f) => {
        const deja = dansLaListe.has(f.id);
        resultats.append(el('li', {}, el('button', { type: 'button', classe: 'inv-resultat', surclick: () => ajouterFiche(f), ...garderFocus },
          el('strong', { texte: f.denomination }),
          el('small', { texte: `${resumeFiche(f)}${deja ? ' · déjà dans cet inventaire' : ''}` }))));
      });
      if (trouvees.length > 8) resultats.append(el('li', { classe: 'aide-question', texte: `${trouvees.length - 8} autre(s) : précisez la recherche.` }));
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
        rechercheAjout = e.target.value; creation = null; zoneCreation.innerHTML = ''; afficherResultats();
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

  const icone = (...formes) => el('svg:svg', { viewBox: '0 0 24 24', width: '20', height: '20', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
    ...formes.map((d) => el('svg:path', { d })));
  const iconeAppareil = () => icone('M3 8h3.5l2-3h7l2 3H21v11H3z', 'M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z');
  const iconeImage = () => icone('M3 4h18v16H3z', 'M3 16l5-5 4 4 3-3 6 6', 'M15.5 9.5a1.5 1.5 0 1 0 0-.01');
  const iconeArchive = () => icone('M3 4h18v4H3z', 'M5 8v12h14V8', 'M10 12h4');
  const iconeReactiver = () => icone('M4 12a8 8 0 1 0 2.5-5.8', 'M4 4v4h4');

  /**
   * Base des articles sur ordinateur : tableau éditable. Les modifications de plusieurs lignes
   * sont gardées en brouillon (brouillonsBase) et enregistrées ensemble.
   */
  function tableauBase(fiches, usages, rafraichir) {
    const valeur = (f) => brouillonsBase.get(f.id) || f;
    const modifier = (f, champ, v) => {
      const d = { ...valeur(f), [champ]: v };
      const origine = structure.catalogue[f.id];
      const pareil = ['denomination', 'categorie', 'refInterne', 'refFournisseur', 'consommable', 'perissable', 'horsStock', 'archive', 'photo']
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
      const cat = el('select', { 'aria-label': `Catégorie : ${f0.denomination}`, surchange: (e) => { modifier(f0, 'categorie', e.target.value); } },
        el('option', { value: '', texte: '—' }), ...CATEGORIES.map((c) => el('option', { value: c, texte: c })));
      cat.value = f.categorie;
      // Vignette de la photo (rafraîchie quand on en ajoute une).
      const vignette = el('img', { classe: 'inv-tb-base-vignette', alt: '', hidden: true });
      const montrer = (id) => {
        vignette.hidden = !id;
        if (id) obtenirPhoto(id).then((d) => { if (d) { vignette.src = d; vignette.hidden = false; } });
      };
      montrer(f.photo);
      const recevoir = async (e) => {
        const fichier = e.target.files[0];
        e.target.value = '';
        if (!fichier) return;
        try {
          const donnees = await reduirePhoto(fichier, 900);
          const id = `local-${nouvelId()}`;
          await Photos.ecrire(id, donnees);
          modifier(f0, 'photo', id);
          montrer(id);
        } catch (err) { erreur.textContent = `Photo illisible ou trop lourde pour « ${f0.denomination} » : réessayez.`; erreur.hidden = false; }
      };
      const idPrendre = idChamp();
      const idChoisir = idChamp();
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
        el('td', { classe: 'inv-tb-base-nom' }, vignette, el('input', {
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
        el('td', { classe: 'inv-tb-base-outils' },
          el('label', { for: idPrendre, classe: 'cfg-mini inv-tb-base-icone', title: 'Prendre une photo', 'aria-label': `Prendre une photo : ${f0.denomination}` }, iconeAppareil()),
          el('input', { type: 'file', id: idPrendre, accept: 'image/*', capture: 'environment', classe: 'invisible', surchange: recevoir }),
          el('label', { for: idChoisir, classe: 'cfg-mini inv-tb-base-icone', title: 'Choisir une photo', 'aria-label': `Choisir une photo : ${f0.denomination}` }, iconeImage()),
          el('input', { type: 'file', id: idChoisir, accept: 'image/*', classe: 'invisible', surchange: recevoir }),
          archive));
      corps.append(tr);
    });
    const tete = el('thead', {}, el('tr', {}, ...['Dénomination', 'Catégorie', 'Réf. interne', 'Réf. fournisseur', 'Consommable', 'Périssable', 'Hors stock', '']
      .map((t) => el('th', { scope: 'col', texte: t }))));
    const bloc = el('div', { classe: 'inv-tb-base' }, barre(), compteur, erreur,
      el('div', { classe: 'inv-tb-base-defile' }, el('table', { classe: 'inv-tb-base-table' }, tete, corps)), barre());
    majCompte();
    return bloc;
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
    const fermer = () => { baseOuverte = ''; remplir(); };
    const detail = (f) => {
      const ou = usages[f.id] || [];
      const lieux = ou.length
        ? el('p', { classe: 'inv-usages' }, `Dans ${pluriel(ou.length, 'inventaire')} : `,
          ...ou.flatMap((c, i) => [i ? ', ' : '', el('a', { href: lien(c.id), texte: chemin(c.id).map((x) => x.nom).join(' › ') })]))
        : el('p', { classe: 'inv-usages', texte: 'Utilisé dans aucun inventaire.' });
      if (!admin) {
        return el('div', { classe: 'inv-fiche-detail' },
          el('dl', { classe: 'reponses' }, ...[['Catégorie', f.categorie], ['Réf. interne', f.refInterne], ['Réf. fournisseur', f.refFournisseur],
            ['Dotation hors stock', f.horsStock ? 'Oui' : 'Non'], ['Consommable', f.consommable ? 'Oui' : 'Non'], ['Périssable', f.perissable ? 'Oui' : 'Non']]
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
          actions: [archiver],
        }),
        lieux, ou.length && !f.archive ? el('p', { classe: 'aide-question', texte: 'Pour l\'archiver, retirez-le d\'abord de ces inventaires.' }) : null);
    };
    function remplir() {
      liste.innerHTML = '';
      const trouvees = chercherFiches(baseFiltre.texte, { archives: baseFiltre.archives, categorie: baseFiltre.categorie });
      const max = enTableau ? 300 : 60;
      const affichees = trouvees.slice(0, max);
      compte.textContent = trouvees.length ? `${pluriel(trouvees.length, 'article')}${trouvees.length > max ? ` — ${max} premiers affichés, précisez la recherche` : ''}` : 'Aucun article ne correspond.';
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
          el('button', { type: 'button', classe: 'inv-resultat', 'aria-expanded': String(ouvert), surclick: () => { baseOuverte = ouvert ? '' : f.id; remplir(); } },
            el('strong', { texte: f.denomination }),
            el('small', { texte: `${resumeFiche(f)}${nb ? ` · ${pluriel(nb, 'inventaire')}` : ''}` })));
        if (ouvert) li.append(detail(f));
        liste.append(li);
      });
    }
    const champ = idChamp();
    const filtres = el('div', { classe: 'puces inv-filtres', role: 'radiogroup', 'aria-label': 'Catégorie' });
    ['', ...CATEGORIES].forEach((cat) => {
      const i = idChamp();
      filtres.append(el('input', { type: 'radio', name: 'inv-filtre-cat', id: i, checked: baseFiltre.categorie === cat, surchange: () => { baseFiltre.categorie = cat; remplir(); } }),
        el('label', { for: i, texte: cat || 'Toutes' }));
    });
    const caseArchives = idChamp();
    remplir();
    if (baseOuverte === 'nouvelle') {
      nouvelle.append(formulaireFiche({ id: nouvelId(), denomination: baseFiltre.texte.trim(), categorie: baseFiltre.categorie, horsStock: false, refInterne: '', refFournisseur: '', consommable: true, perissable: baseFiltre.categorie === 'Médicament', archive: false }, {
        titre: 'Nouvel article',
        surEnregistrer: (f) => { enregistrerFiche(f); baseOuverte = ''; avis = `« ${f.denomination} » ajouté à la base.`; rendre({ garderPosition: true }); },
        surAnnuler: () => { baseOuverte = ''; rendre({ garderPosition: true }); },
        utiliser: (f) => { baseOuverte = f.id; baseFiltre.texte = f.denomination; rendre({ garderPosition: true }); },
      }));
    }
    return [
      barreHaut({ titre: 'Inventaires', h1: false, bande: false, retour: () => aller('') }),
      el('div', { classe: 'inv-entete' }, el('h1', { tabindex: '-1', texte: 'Base des articles' }),
        admin && baseOuverte !== 'nouvelle' ? el('button', { type: 'button', classe: 'cfg-bouton', texte: '＋ Nouvel article', surclick: () => { baseOuverte = 'nouvelle'; rendre({ garderPosition: true, focus: '.inv-fiche input' }); } }) : null),
      ligneSynchro(), ligneAvis(),
      el('p', { classe: 'consigne', texte: 'Chaque article des inventaires est décrit ici une seule fois. Une modification de fiche s\'applique à tous les inventaires qui l\'utilisent.' }),
      nouvelle,
      el('div', { classe: 'champ' }, el('label', { for: champ, texte: 'Rechercher (nom ou référence)' }),
        el('input', { id: champ, type: 'search', autocomplete: 'off', valeur: baseFiltre.texte, surinput: (e) => { baseFiltre.texte = e.target.value; remplir(); } })),
      filtres,
      el('label', { classe: 'cfg-case', for: caseArchives }, el('input', { type: 'checkbox', id: caseArchives, checked: baseFiltre.archives, surchange: (e) => { baseFiltre.archives = e.target.checked; remplir(); } }), 'Afficher les articles archivés'),
      compte, liste, tableau,
      el('div', { classe: 'inv-pied' }, el('a', { classe: 'lien', href: lien(''), texte: '← Tous les inventaires' })),
    ];
  }

  /** QR code, lien, puce NFC, copie et suppression (administrateurs). */
  function blocAcces(c) {
    const url = adresse(c.id);
    const etatNfc = el('p', { classe: 'message', role: 'status' });
    const nfc = 'NDEFReader' in window
      ? el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Écrire sur une puce NFC', surclick: () => ecrireNfc(url, etatNfc) })
      : el('p', { classe: 'aide-question', texte: 'Puce NFC : l\'écriture depuis l\'appli demande Chrome sur Android. Sinon, enregistrez ce lien sur la puce avec une appli NFC (type « URL »).' });
    // Étiquette : aperçu et réglages (taille imprimée, logo central), propres à ce contenant.
    const apercu = el('div', { classe: 'inv-etiquette-apercu' }, etiquetteSvg(c));
    const regler = (champ, valeur) => {
      c.etiquette = normaliser({ etiquette: { ...reglageEtiquette(c), [champ]: valeur } }).etiquette;
      marquer(c.id);
      apercu.replaceChildren(etiquetteSvg(c));
    };
    const r0 = reglageEtiquette(c);
    const champMm = (champ, libelle) => el('label', {}, el('span', { texte: libelle }),
      el('input', { type: 'number', min: 15, max: 150, step: 1, valeur: r0[champ], inputmode: 'numeric', surchange: (e) => regler(champ, e.target.value) }));
    const formats = [[40, 40], [30, 30], [60, 30], [50, 25], [70, 35], [25, 50]];
    const reglages = el('div', { classe: 'inv-etiquette-reglages' },
      champMm('largeur', 'Largeur (mm)'), champMm('hauteur', 'Hauteur (mm)'),
      el('label', {}, el('span', { texte: 'Logo' }),
        el('select', { surchange: (e) => regler('logo', e.target.value) },
          ...[['', 'Aucun'], ['nfc', 'Pictogramme NFC sur le côté (puce au dos)'], ['smur', 'Croix SMUR au centre']].map(([v, t]) => el('option', { value: v, selected: r0.logo === v, texte: t })))),
      el('div', { classe: 'inv-etiquette-formats' }, el('span', { texte: 'Formats courants :' }),
        ...formats.map(([l, h]) => el('button', { type: 'button', classe: 'cfg-mini', texte: `${l}×${h}`, surclick: () => {
          c.etiquette = normaliser({ etiquette: { ...reglageEtiquette(c), largeur: l, hauteur: h } }).etiquette;
          marquer(c.id); rendre({ garderPosition: true });
        } }))),
      el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Aperçu taille réelle', surclick: () => apercuTailleReelle(c) }),
      c.modele ? el('p', { classe: 'aide-question', texte: 'Format répercuté sur les exemplaires avec les autres modifications de l\'inventaire type.' }) : null);
    const supprimer = el('button', {
      type: 'button', classe: 'cfg-bouton danger', texte: 'Supprimer cet inventaire',
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
    return el('section', { classe: 'cfg-section' }, el('h2', { texte: 'Accès rapide' }),
      el('p', { classe: 'aide-question', texte: 'Ce QR code et la puce NFC ouvrent directement cet inventaire. Ils restent valables si l\'inventaire est renommé.' }),
      el('div', { classe: 'inv-acces' }, apercu,
        el('div', { classe: 'inv-acces-actions' },
          el('p', { classe: 'inv-url', texte: url }),
          reglages,
          el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Imprimer l\'étiquette QR', surclick: () => imprimerEtiquettes([c]) }),
          nfc, etatNfc)),
      el('h2', { texte: 'Autres actions' }),
      el('div', { classe: 'cfg-actions' },
        el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Dupliquer (avec son contenu)', surclick: () => dupliquer(c) }),
        supprimer));
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
  const sigArticle = (a) => (a.separateur ? { separateur: true, nom: a.nom }
    : a.controle ? { controle: a.controle, nom: a.nom, min: a.min, max: a.max, unite: a.unite, echelle: a.echelle, seuil: a.seuil, attendu: a.attendu, facultatif: a.facultatif === true || undefined, commentaire: a.commentaire || undefined }
      : { ref: a.ref || '', nom: a.ref ? '' : a.nom, quantite: String(a.quantite || ''), quantiteMin: a.quantiteMin === true || undefined, facultatif: a.facultatif === true || undefined, commentaire: a.commentaire || undefined });
  /** Instantané d'un contenant du modèle : ce que ses exemplaires doivent reproduire. */
  function instantane(m) {
    return {
      nom: m.nom, ordre: m.ordre, photo: m.photo, scellable: m.scellable, categorie: m.categorie, etiquette: m.etiquette,
      points: m.points.map((p) => ({ cible: p.cible, x: p.x, y: p.y })),
      nomVue: m.nomVue,
      vues: m.vues.map((v) => ({ id: v.id, nom: v.nom, photo: v.photo, points: v.points.map((p) => ({ cible: p.cible, x: p.x, y: p.y })) })),
      articles: m.articles.map((a) => ({ id: a.id, ...sigArticle(a), ...(a.ref ? { refNom: a.nom } : {}) })),
      enfants: enfants(m.id).map((x) => x.id),
    };
  }
  /** Le même instantané, vu depuis un contenant d'exemplaire (identifiants traduits vers ceux du modèle). */
  function vueExemplaire(e) {
    const versModele = (id) => (contenant(id) || {}).source || id;
    return {
      nom: e.nom, ordre: e.ordre, photo: e.photo, scellable: e.scellable, categorie: e.categorie, etiquette: e.etiquette,
      points: e.points.map((p) => ({ cible: versModele(p.cible), x: p.x, y: p.y })),
      nomVue: e.nomVue,
      vues: e.vues.map((v) => ({ id: v.id, nom: v.nom, photo: v.photo, points: v.points.map((p) => ({ cible: versModele(p.cible), x: p.x, y: p.y })) })),
      articles: e.articles.map((a) => ({ id: a.id, ...sigArticle(a) })),
      enfants: enfants(e.id).filter((x) => !(contenant(x.source) || {}).modele).map((x) => x.source).filter(Boolean),
    };
  }
  const sansNoms = (articles) => (articles || []).map(({ refNom, ...a }) => a);
  const CHAMPS_LIBELLES = { nom: 'nom', ordre: 'place', photo: 'photo', nomVue: 'nom de la vue', vues: 'vues', scellable: 'scellable', categorie: 'catégorie', etiquette: 'format d\'étiquette', points: 'points sur la photo', articles: 'articles', enfants: 'sous-inventaires' };
  /** Champs d'un contenant d'exemplaire modifiés localement depuis la dernière répercussion. */
  function personnalisations(e) {
    if (!e.base) return [];
    const v = vueExemplaire(e);
    const racine = !contenant(e.parent) || !contenant(e.parent).source;
    return Object.keys(CHAMPS_LIBELLES).filter((k) => !(racine && (k === 'nom' || k === 'ordre')))
      .filter((k) => !(k === 'etiquette' && !v.etiquette))
      .filter((k) => !egal(k === 'articles' ? v.articles : v[k], k === 'articles' ? sansNoms(e.base.articles) : e.base[k]));
  }
  const estPersonnalise = (e) => personnalisations(e).length > 0;
  const toutPersonnalise = (e) => estPersonnalise(e) || enfants(e.id).some(toutPersonnalise);

  /** Copie d'un contenant du modèle (et de tout ce qu'il contient) dans un exemplaire. */
  function copierDepuisModele(m, parent, ordre) {
    const copie = normaliser({ ...copieProfonde(m), id: nouvelId(), parent, ordre, source: m.id, base: instantane(m) });
    delete copie.modele;
    structure.contenants[copie.id] = copie;
    const fils = enfants(m.id).map((f) => copierDepuisModele(f, copie.id, f.ordre));
    traduireCibles(copie, (cible) => (fils.find((x) => x.source === cible) || {}).id);
    marquer(copie.id);
    return copie;
  }

  /** Fusion des articles : modèle (nouveau), base (ancien modèle), exemplaire. Renvoie [articles, nb conservés]. */
  function fusionnerArticles(e, base, m, forcer) {
    const parId = (l) => Object.fromEntries((l || []).map((a) => [a.id, a]));
    const I = parId(e.articles); const B = parId(base); const M = parId(m.articles);
    let conserves = 0;
    const idsI = e.articles.map((a) => a.id);
    const ordreInchange = egal(idsI, (base || []).map((a) => a.id));
    const ordre = forcer || ordreInchange
      ? [...m.articles.map((a) => a.id), ...idsI.filter((id) => !M[id])]
      : [...idsI, ...m.articles.map((a) => a.id).filter((id) => !I[id] && !B[id])];
    if (!forcer && !ordreInchange) conserves += 1;
    const resultat = [];
    ordre.forEach((id) => {
      const i = I[id]; const b = B[id]; const mm = M[id];
      const depuisModele = () => { const a = copieProfonde(mm); return a; };
      if (i && mm) {
        if (forcer || (b && egal(sigArticle(i), sigArticle(b)))) {
          const a = mm.controle || i.controle ? depuisModele() : { ...i, ...depuisModele() };
          if (!mm.facultatif) delete a.facultatif; // redevenu obligatoire dans le modèle
          if (!mm.quantiteMin) delete a.quantiteMin; // redevenue exacte dans le modèle
          if (!mm.commentaire) delete a.commentaire; // commentaire retiré du modèle
          resultat.push(a);
        }
        else { resultat.push(i); if (!egal(sigArticle(i), sigArticle(mm))) conserves += 1; }
      } else if (i && !mm) {
        if (b && (forcer || egal(sigArticle(i), sigArticle(b)))) return; // retiré du modèle
        if (forcer && !b) return; // ajouté localement : « Revenir au modèle » le retire
        resultat.push(i);
        if (b) conserves += 1;
      } else if (!i && mm) {
        if (!b || forcer) resultat.push(depuisModele()); // nouveau dans le modèle
        else conserves += 1; // retiré localement : on respecte ce choix
      }
    });
    return [resultat, conserves];
  }

  /**
   * Répercute le contenant `m` du modèle sur le contenant `e` de l'exemplaire, et récursivement.
   * `forcer` : « Revenir au modèle » (ce contenant seulement : ses sous-inventaires gardent leurs personnalisations).
   * Renvoie { modifies, conserves }.
   */
  function repercuter(e, m, forcer = false, racine = false) {
    const bilanR = { modifies: 0, conserves: 0 };
    const base = e.base || instantane(m); // exemplaire ancien sans base : tout est considéré comme non modifié
    const v = vueExemplaire(e);
    const nm = instantane(m);
    const avant = canonique(e);
    ['nom', 'ordre', 'photo', 'nomVue', 'scellable', 'categorie', 'etiquette'].forEach((k) => {
      if (racine && (k === 'nom' || k === 'ordre')) return; // le sac garde son nom et sa place
      // Étiquette : un exemplaire sans format propre suit toujours le modèle (formats effacés par un ancien serveur).
      const suit = k === 'etiquette' && !v.etiquette;
      if (forcer || suit || egal(v[k], base[k])) e[k] = copieProfonde(m[k]);
      else if (!egal(v[k], nm[k])) bilanR.conserves += 1;
    });
    // Sous-inventaires
    enfants(m.id).forEach((mf) => {
      const ef = enfants(e.id).find((x) => x.source === mf.id);
      if (ef) {
        const r = repercuter(ef, mf);
        bilanR.modifies += r.modifies; bilanR.conserves += r.conserves;
      } else if (forcer || !base.enfants.includes(mf.id)) {
        copierDepuisModele(mf, e.id, mf.ordre);
        bilanR.modifies += 1;
      } else bilanR.conserves += 1; // retiré de ce sac : on respecte ce choix
    });
    enfants(e.id).forEach((ef) => {
      if (!ef.source || nm.enfants.includes(ef.source)) return;
      if (base.enfants.includes(ef.source) && (forcer || !toutPersonnalise(ef))) {
        descendants(ef.id).forEach((x) => { x.supprime = true; marquer(x.id); });
        retirerCible(e, ef.id);
        bilanR.modifies += 1;
      } else if (base.enfants.includes(ef.source)) bilanR.conserves += 1;
    });
    // Points : traduits vers les sous-inventaires de cet exemplaire
    const versExemplaire = (cible) => (enfants(e.id).find((x) => x.source === cible) || {}).id;
    if (forcer || egal(vueExemplaire(e).points, base.points)) {
      e.points = m.points.map((p) => { const id = versExemplaire(p.cible); return id ? { ...p, cible: id } : null; }).filter(Boolean);
    } else if (!egal(vueExemplaire(e).points, nm.points)) bilanR.conserves += 1;
    // Vues supplémentaires : comme les points, l'ensemble suit le modèle tant que le sac ne les a pas modifiées.
    if (forcer || egal(vueExemplaire(e).vues, base.vues || [])) {
      e.vues = m.vues.map((v) => ({ ...copieProfonde(v), points: v.points.map((p) => { const id = versExemplaire(p.cible); return id ? { ...p, cible: id } : null; }).filter(Boolean) }));
    } else if (!egal(vueExemplaire(e).vues, nm.vues)) bilanR.conserves += 1;
    // Articles
    const [articles, conserves] = fusionnerArticles(e, sansNoms(base.articles), m, forcer);
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

  /** Bloc affiché en tête d'un inventaire type (racine ou sous-inventaire). */
  function blocModele(c) {
    const m = racineModele(c.id);
    if (!m) return null;
    const exemplaires = exemplairesDe(m.id);
    if (!edition) {
      return el('p', { classe: 'note-parc inv-note-modele' }, el('strong', { texte: 'Inventaire type. ' }),
        `Il ne se vérifie pas : il sert de structure à ${pluriel(exemplaires.length, 'exemplaire')}. Modifiez-le puis répercutez les changements.`);
    }
    const resultat = el('p', { classe: 'message', role: 'status' });
    const liste = el('div', { classe: 'inv-exemplaires' });
    exemplaires.forEach((e) => {
      const i = idChamp();
      liste.append(el('label', { classe: 'cfg-case', for: i }, el('input', { type: 'checkbox', id: i, checked: true, value: e.id }),
        el('span', {}, el('a', { href: lien(e.id), texte: e.nom }), toutPersonnalise(e) ? el('small', { texte: ' · personnalisé' }) : null)));
    });
    const boutonRepercuter = el('button', { type: 'button', classe: 'cfg-bouton inv-actif', texte: `Répercuter sur les exemplaires cochés`, surclick: () => {
      const choisis = [...liste.querySelectorAll('input:checked')].map((x) => contenant(x.value)).filter(Boolean);
      if (!choisis.length) { resultat.textContent = 'Cochez au moins un exemplaire.'; return; }
      let modifies = 0; let conserves = 0;
      choisis.forEach((e) => { const r = repercuter(e, m, false, true); modifies += r.modifies; conserves += r.conserves; });
      avis = `${pluriel(choisis.length, 'exemplaire')} mis à jour (${pluriel(modifies, 'contenant')} modifié${modifies > 1 ? 's' : ''})`
        + `${conserves ? ` ; ${pluriel(conserves, 'personnalisation')} propre${conserves > 1 ? 's' : ''} à un sac conservée${conserves > 1 ? 's' : ''}` : ''}.`;
      rendre({ garderPosition: true });
    } });
    // Création d'exemplaires
    const champNb = idChamp();
    const nb = el('input', { id: champNb, type: 'number', min: '1', max: '30', valeur: '1', inputmode: 'numeric', classe: 'inv-court' });
    const creer = el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Créer', surclick: () => {
      const n = Math.min(30, Math.max(1, Math.round(Number(nb.value)) || 1));
      const depart = exemplaires.length;
      const crees = creerExemplaires(m, Array.from({ length: n }, (x, k) => `${m.nom} n°${depart + k + 1}`));
      avis = `${pluriel(crees.length, 'exemplaire')} créé${crees.length > 1 ? 's' : ''} : renommez-les si besoin, puis imprimez leurs étiquettes QR.`;
      rendre({ garderPosition: true });
    } });
    return el('section', { classe: 'cfg-section inv-bloc-modele' },
      el('h2', { texte: 'Inventaire type' }),
      c.id !== m.id ? el('p', { classe: 'aide-question' }, 'Ce sous-inventaire fait partie de l\'inventaire type ', el('a', { href: lien(m.id), texte: m.nom }), '.') : null,
      el('p', { classe: 'aide-question', texte: 'Les modifications du type ne partent pas toutes seules : appuyez sur « Répercuter ». Ce qu\'un sac a de propre (article ajouté, quantité changée, photo…) est conservé.' }),
      exemplaires.length ? liste : el('p', { texte: 'Aucun exemplaire pour l\'instant.' }),
      exemplaires.length ? el('div', { classe: 'cfg-actions' }, boutonRepercuter) : null,
      resultat,
      c.id === m.id ? el('div', { classe: 'cfg-ligne inv-creer-exemplaires' }, el('label', { for: champNb, texte: 'Créer des exemplaires :' }), nb, creer) : null);
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
      el('ul', { classe: 'inv-liste-modele' }, ...c.articles.map((a) => (a.separateur
        ? el('li', { classe: 'inv-separation', texte: a.nom })
        : el('li', {}, nomArticle(a), a.quantite ? el('span', { classe: 'inv-qte-attendue', texte: ` × ${a.quantite}` }) : null)))));
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
      else if (aCocher(d).length && !etat.verifs[d.id]) obstacles.push(`${d.nom} (jamais vérifié)`);
    });
    return obstacles;
  }
  function validerScelle(c) {
    const maintenant = new Date().toISOString();
    let n = 0;
    for (const d of descendants(c.id)) {
      if (!aCocher(d).length || verifDuJour(d.id)) continue;
      const derniere = etat.verifs[d.id];
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
      const remarque = `Scellé : validé sur la base de l'inventaire du ${new Date(derniere.date).toLocaleDateString('fr-FR')} (${derniere.agent}).`;
      const ok = App.mettreEnFile({ action: 'verifierInventaire', contenant: d.id, detail: { chemin: chemin(d.id).map((x) => x.nom).join(' > '), articles, remarque, scelle: true } });
      if (!ok) { avis = 'Non enregistré : la mémoire de l\'appareil est pleine.'; rendre(); return; }
      etat.verifs[d.id] = { date: maintenant, agent: App.agent(), manquants: derniere.manquants, remarque, scelle: true, valeurs: derniere.valeurs || {} };
      n += 1;
    }
    sauverEtat();
    avis = `« ${c.nom} » scellé : ${pluriel(n, 'inventaire')} validé${n > 1 ? 's' : ''} sur la base du dernier réalisé.`;
    aller(c.parent && !gestion ? c.parent : c.id);
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

  /** Administration d'un emplacement : inventaires types acceptés (un ou plusieurs). */
  function blocTypesEmplacement(c) {
    const acceptes = modelesEmplacement(c);
    const autres = Object.values(structure.contenants).filter((x) => !x.supprime && x.modele && !acceptes.includes(x.id))
      .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
    const idSel = idChamp();
    const sel = el('select', { id: idSel }, el('option', { value: '', texte: autres.length ? 'Choisir un autre inventaire type…' : 'Aucun autre inventaire type' }),
      ...autres.map((t) => el('option', { value: t.id, texte: t.nom })));
    const fixer = (liste) => {
      c.emplacement = liste.length > 1 ? { modele: liste[0], modeles: liste } : { modele: liste[0] };
      marquer(c.id);
      rendre({ garderPosition: true });
    };
    return el('section', { classe: 'note-parc inv-note-emplacement inv-types-emplacement' },
      el('strong', { texte: 'Emplacement — inventaires types acceptés' }),
      el('p', { classe: 'aide-question', texte: 'Avec plusieurs modèles (ex. scopes de marques différentes, ou un même scope avec des pochettes différentes), l\'agent choisit en check-list le modèle présent d\'après sa photo : mettez une photo sur chaque inventaire type.' }),
      el('ul', {}, ...acceptes.map((m) => {
        const t = contenant(m);
        return el('li', {}, t ? el('a', { href: lien(t.id), texte: t.nom }) : '(supprimé)', t && !t.photo ? el('small', { classe: 'inv-desaffecte', texte: ' sans photo' }) : null,
          acceptes.length > 1 ? el('button', { type: 'button', classe: 'cfg-mini danger', 'aria-label': `Retirer ${t ? t.nom : 'ce modèle'}`, texte: '✕',
            surclick: () => {
              const occ = enfants(c.id)[0];
              if (occ && occ.source === m) { messageVue(`« ${occ.nom} » occupe l'emplacement : ce modèle ne peut pas être retiré.`, 'erreur'); return; }
              fixer(acceptes.filter((x) => x !== m));
            } }) : null);
      })),
      el('div', { classe: 'cfg-ligne' }, sel, el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Accepter aussi', disabled: !autres.length,
        surclick: () => { if (sel.value) fixer([...acceptes, sel.value]); } })));
  }

  function vueContenant(c) {
    const fils = enfants(c.id);
    const b = bilan(c.id);
    const v = verifDuJour(c.id);
    // Le nom est dans la barre du haut ; en administration, il se modifie juste en dessous.
    const titre = edition
      ? el('div', { classe: 'champ inv-champ-nom' }, el('label', { for: 'inv-nom', texte: 'Nom' }),
        el('input', { id: 'inv-nom', maxlength: '80', valeur: c.nom, surchange: (e) => { const t = e.target.value.trim(); if (t) { c.nom = t; marquer(c.id); } else e.target.value = c.nom; } }))
      : null;
    // Ouvert depuis une recherche par le nom, sans dire où l'on est : consultation seule.
    const consultation = !edition && enConsultation(c);
    // Check-list d'un contenant scellable pas encore vérifié aujourd'hui : on demande d'abord s'il est scellé.
    const questionScelle = !edition && !consultation && !dansUnModele(c.id) && c.scellable && !b.complet && !reponsesScelle.has(c.id);
    const caseScellable = idChamp();
    const caseModele = idChamp();
    const groupeCategorie = idChamp();
    const choixCategorie = edition ? el('div', { classe: 'champ inv-choix-categorie' },
      el('span', { classe: 'inv-libelle', id: groupeCategorie, texte: 'Catégorie du contenant' }),
      el('div', { classe: 'puces', role: 'radiogroup', 'aria-labelledby': groupeCategorie },
        ...Object.entries(CATEGORIES_CONTENANT).flatMap(([cle, v]) => {
          const i = idChamp();
          return [el('input', { type: 'radio', name: groupeCategorie, id: i, checked: c.categorie === cle, surchange: () => { c.categorie = cle; marquer(c.id); rendre({ garderPosition: true }); } }),
            el('label', { for: i, title: v.aide, texte: v.nom })];
        })),
      el('p', { classe: 'aide-question', texte: c.categorie ? `${CATEGORIES_CONTENANT[c.categorie].nom} : ${CATEGORIES_CONTENANT[c.categorie].aide}.${c.categorie === 'primaire' ? ' Affiché sur la page des inventaires.' : ' S\'ouvre par recherche, QR code ou NFC, ou depuis son contenant.'}` : 'Seuls les contenants primaires sont affichés sur la page des inventaires.' })) : null;
    const modele = dansUnModele(c.id);
    const verification = c.emplacement || questionScelle || edition || modele ? null
      : (consultation ? blocConsultation(c) : blocVerification(c));
    return [
      barreContenant(c, { h1: !edition }),
      bandeauGestion(),
      titre ? el('div', { classe: 'inv-entete' }, titre, boutonEdition()) : null,
      choixCategorie,
      edition ? el('label', { classe: 'cfg-case inv-case-fiche', for: caseScellable },
        el('input', { type: 'checkbox', id: caseScellable, checked: c.scellable, surchange: (e) => { c.scellable = e.target.checked; marquer(c.id); } }),
        el('span', {}, 'Contenant scellable', el('small', { texte: 'fermé par un scellé (plomb) une fois vérifié' }))) : null,
      edition && !c.parent && !racineExemplaire(c.id) ? el('label', { classe: 'cfg-case inv-case-fiche', for: caseModele },
        el('input', { type: 'checkbox', id: caseModele, checked: c.modele === true, surchange: (e) => {
          if (e.target.checked) c.modele = true; else delete c.modele;
          marquer(c.id);
          rendre({ garderPosition: true });
        } }),
        el('span', {}, 'Inventaire type', el('small', { texte: 'sert de structure à des exemplaires identiques (ex. les sacs d\'intervention) ; il ne se vérifie pas' }))) : null,
      ligneSynchro(), ligneAvis(),
      blocModele(c), blocExemplaire(c),
      c.emplacement && edition ? blocTypesEmplacement(c) : null,
      c.emplacement && !edition ? (() => {
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
        el('button', { type: 'button', classe: 'lien', texte: 'Publier une alerte sur le mur', surclick: () => publierARetrouver(c) })) : null,
      ...(questionScelle ? [blocQuestionScelle(c)] : []),
      edition || modele ? null : el('p', { classe: `inv-statut ${b.classe}` },
        el('strong', { texte: `${b.complet ? '✓ ' : ''}${b.texte}` }),
        el('span', { classe: 'inv-badges' }, ...badges(b))),
      questionScelle ? null : blocPhoto(c, fils),
      questionScelle ? null : blocEnfants(c, fils),
      c.emplacement || questionScelle ? null : (edition ? blocArticles(c) : (modele ? blocContenuModele(c) : null)),
      ...(verification ? [].concat(verification) : []),
      !edition && !aCocher(c).length && !fils.length ? el('p', { classe: 'consigne', texte: estAdmin() ? 'Inventaire vide : menu > Administration > Gestion des inventaires pour ajouter une photo, des sous-inventaires ou des articles.' : 'Cet inventaire est vide pour l\'instant.' }) : null,
      !edition && (!aCocher(c).length || consultation) ? el('p', { classe: 'message inv-message', role: 'alert', hidden: true }) : null,
      edition ? el('p', { classe: 'message inv-message', role: 'alert', hidden: true }) : null,
      edition ? blocAcces(c) : null,
      // La liste papier reste possible depuis l'administration.
      edition ? el('div', { classe: 'inv-pied' }, el('button', { type: 'button', classe: 'lien', texte: 'Imprimer la liste', surclick: () => imprimerListe(c) })) : null,
    ];
  }

  /** Consultation seule (recherche par le nom sans contenant primaire) : le contenu, sans case à cocher. */
  /** Péremption mise à jour hors inventaire (consultation d'un contenant mobile) : locale tout de suite, envoyée au retour du réseau. */
  function enregistrerPeremption(c, a, iso) {
    const maj = new Date().toISOString();
    const ok = App.mettreEnFile({ action: 'majPeremption', contenant: c.id, article: a.id,
      detail: { chemin: chemin(c.id).map((x) => x.nom).join(' > '), nom: nomArticle(a), peremption: iso } });
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
      el('ul', { classe: 'inv-liste-modele' }, ...c.articles.map((a) => {
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
          li.append(el('div', { classe: 'inv-peremption' }, el('span', { texte: 'Pér. ' }), champ, echeance), noteCommentaire(a));
          return li;
        }
        return el('li', { classe: pe ? pe.niveau : '' }, nomArticle(a),
          a.quantite ? el('span', { classe: 'inv-qte-attendue', texte: ` × ${a.quantite}` }) : null,
          date ? el('small', { classe: 'inv-consultation-date', texte: ` · pér. ${afficherDate(date)}${pe.texte ? ` (${pe.texte})` : ''}` }) : null,
          noteCommentaire(a));
      })));
  }

  function rendre({ garderPosition = false, focus = '' } = {}) {
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
    // Contenant primaire où l'on est : celui du contenant ouvert. La page des inventaires remet à zéro la consultation.
    if (!gestion) {
      if (!id) fixerContexte(contexte.primaire, false);
      // Seul un contenant fixe (pièce, véhicule, tiroir…) dit où l'on est ; un contenant mobile peut être ailleurs.
      else if (c && !contexte.consultation && !dansUnMobile(c)) { const p = primaireDe(c.id); if (p) fixerContexte(p.id, false); }
    }
    const nouveau = dernierAffiche !== id;
    dernierAffiche = id;
    if (nouveau) {
      identification = '';
      typeChoisi = '';
      placement = '';
      confirmer = '';
      if (pile.length > 1 && pile[pile.length - 2] === id) pile.pop();
      else pile.push(id);
      rattacher = '';
      rechercheAjout = '';
      creation = null;
      ajoutSousOuvert = false;
    }
    if (identifierEmplacement) identification = identifierEmplacement;
    if (aIdentifier) { identification = aIdentifier; aIdentifier = ''; }
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
    // Une fois : l'appui long sur la flèche permet de remonter de plusieurs étages.
    if (nouveau && c && !gestion && etagesAuDessus(c).length > 1) {
      let vue = true;
      try { vue = localStorage.getItem(CLE_ASTUCE) === '1'; if (!vue) localStorage.setItem(CLE_ASTUCE, '1'); } catch (e) { /* stockage indisponible */ }
      if (!vue) alerteBreve('Astuce : maintenez la flèche ← pour remonter de plusieurs étages d\'un coup.');
    }
    if (focus && zone.querySelector(focus)) zone.querySelector(focus).focus();
    else if (nouveau && !garderPosition) {
      const titre = zone.querySelector('h1, #inv-nom');
      zone.scrollIntoView({ block: 'start' });
      if (titre) titre.focus({ preventScroll: true });
    }
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
  function ajusterTexte(texte, largeur, hauteur, maxPolice, maxLignes, gras = true) {
    const ratio = gras ? 0.6 : 0.52; // largeur moyenne d'un caractère / taille de police
    const mots = String(texte || '').split(/\s+/).filter(Boolean);
    if (!mots.length) return { lignes: [], police: 0 };
    // Meilleure police pour chaque nombre de lignes ; on ne coupe en plus de lignes que si le gain est net
    // (évite « Ampoulier / A »).
    const meilleur = {};
    for (let police = maxPolice; police >= 1; police -= 0.1) {
      const parLigne = Math.max(1, Math.floor(largeur / (police * ratio)));
      const lignes = [];
      mots.forEach((m) => {
        const der = lignes[lignes.length - 1];
        if (der !== undefined && (`${der} ${m}`).length <= parLigne) lignes[lignes.length - 1] = `${der} ${m}`;
        else lignes.push(m);
      });
      if (lignes.length <= maxLignes && lignes.every((l) => l.length <= parLigne) && lignes.length * police * 1.15 <= hauteur
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
    const k = COULEURS_ETIQUETTE;
    const W = reglage.largeur, H = reglage.hauteur, petit = Math.min(W, H);
    const q = qrcode(0, 'H');
    q.addData(adresse(c.id));
    q.make();
    const n = q.getModuleCount();
    const primaire = c.categorie === 'immobile' ? chemin(c.id)[0] : null;
    const nom = c.nom || '';
    const sous = primaire && primaire.id !== c.id ? primaire.nom : '';
    const ratio = W / H;
    const mode = ratio > 1.3 ? 'paysage' : (ratio < 0.77 ? 'portrait' : 'carre');

    const ep = Math.min(1.4, Math.max(0.5, petit * 0.025)); // épaisseur du cadre
    const marge = ep * 1.6; // du bord au cadre intérieur
    const coin = Math.min(7, petit * 0.18);
    const enfants = [
      el('svg:rect', { width: W, height: H, fill: '#fff' }),
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
      const x0 = ecart + S + ep * 2.5, l = W - x0 - ecart;
      const hTrace = Math.min(H * 0.22, l / 4.6);
      zoneTrace = { x: x0, y: H - ecart - hTrace, l, h: hTrace };
      const hTexte = zoneTrace.y - ecart - ep;
      zoneNom = { x: x0, y: ecart + ep * 0.5, l, h: hTexte * (sous ? 0.66 : 1), lignes: 3, centre: true };
      if (sous) zoneSous = { x: x0, y: zoneNom.y + zoneNom.h, l, h: hTexte * 0.34, lignes: 2, centre: true };
    } else if (mode === 'portrait') {
      const S = W - 2 * ecart;
      qr = { x: ecart, y: ecart, s: S };
      const y0 = ecart + S + ep * 0.5, l = W - 2 * ecart;
      const hTrace = Math.min((H - y0) * 0.28, l / 4.6);
      zoneTrace = { x: ecart, y: H - ecart - hTrace, l, h: hTrace };
      const hTexte = zoneTrace.y - y0 - ep * 0.5;
      zoneNom = { x: ecart, y: y0, l, h: hTexte * (sous ? 0.62 : 1), lignes: 3, centre: true };
      if (sous) zoneSous = { x: ecart, y: y0 + zoneNom.h, l, h: hTexte * 0.38, lignes: 2, centre: true };
    } else {
      const bande = petit * 0.15;
      const S = Math.min(W - 2 * ecart, H - 2 * (marge + bande));
      qr = { x: (W - S) / 2, y: (H - S) / 2, s: S };
      // Bandeaux entre le cadre et la zone calme : texte en haut, primaire ou tracé en bas.
      const hb = qr.y - ecart;
      zoneNom = { x: coin * 0.5 + ep, y: ecart, l: W - 2 * (coin * 0.5 + ep), h: hb, lignes: 1, centre: true };
      const yBas = qr.y + S + 0.3;
      if (sous) zoneSous = { x: coin * 0.5 + ep, y: yBas, l: W - 2 * (coin * 0.5 + ep), h: hb, lignes: 1, centre: true };
      else zoneTrace = { x: coin * 0.6 + ep, y: yBas + hb * 0.2, l: W - 2 * (coin * 0.6 + ep), h: hb * 0.72 };
    }

    // Puce NFC collée au dos : pictogramme bien visible, accolé au QR code (jamais dessus).
    let badge = null;
    if (reglage.logo === 'nfc') {
      if (mode === 'paysage') { // au pied de la colonne de texte, contre le QR ; le tracé part après
        const b = Math.min(8, zoneTrace.l * 0.3, Math.max(zoneTrace.h * 1.1, 3.5));
        badge = { x: zoneTrace.x, y: qr.y + qr.s - b - 0.4, b };
        zoneTrace.x += b + ep; zoneTrace.l -= b + ep;
      } else if (mode === 'portrait') { // juste sous le QR, centré ; le nom descend d'autant
        const b = Math.min(8, W * 0.28, Math.max(3.5, zoneNom.h * 0.35));
        badge = { x: (W - b) / 2, y: qr.y + qr.s + ep * 0.4, b };
        const decale = b + ep * 0.8;
        zoneNom.y += decale; zoneNom.h -= decale * (zoneSous ? 0.62 : 1);
        if (zoneSous) { zoneSous.y += decale * 0.62; zoneSous.h -= decale * 0.38; }
      } else {
        const cote = (W - qr.s) / 2 - ecart; // place libre à droite du QR
        // (le filet orange de la zone calme est à 0,4 mm du QR : le pictogramme reste à l'extérieur)
        const hb = qr.y - ecart;
        if (cote - 0.4 - ep * 0.9 >= 3) { // à droite du QR, calé sur son bas
          const b = Math.min(8, cote - 0.4 - ep * 0.9);
          badge = { x: qr.x + qr.s + 0.4 + ep * 0.6, y: qr.y + qr.s - b, b };
        } else { // sous le QR, calé sur son bord droit
          const z = zoneSous || zoneTrace;
          const b = Math.min(8, hb * 0.92);
          badge = { x: qr.x + qr.s - b, y: qr.y + qr.s + (hb - b) / 2, b };
          z.l = badge.x - ep - z.x;
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
      el('svg:g', { transform: `translate(${qr.x + o} ${qr.y + o}) scale(${mod})` }, el('svg:path', { d: trace, fill: k.encre })));
    if (L) {
      const p = (L + 1) * mod, x = qr.x + o + (l0 - 0.5) * mod, y = qr.y + o + (l0 - 0.5) * mod;
      enfants.push(el('svg:rect', { x, y, width: p, height: p, rx: p * 0.12, fill: '#fff', stroke: k.bleu, 'stroke-width': mod * 0.35 }),
        el('svg:svg', { x: x + p * 0.12, y: y + p * 0.12, width: p * 0.76, height: p * 0.76, viewBox: '0 0 24 24' }, ...LOGOS_ETIQUETTE[reglage.logo](k)));
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
    if (zoneTrace) {
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
        el('svg:path', { d: LOGO_NFC.d, fill: k.bleu, 'fill-rule': 'evenodd' })));
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

  /** Étiquettes carrées, chacune à la taille réglée pour son contenant. */
  function imprimerEtiquettes(liste) {
    lancerImpression(liste.map((c) => {
      const r = reglageEtiquette(c);
      return el('div', { classe: 'imp-etiquette', style: `width:${r.largeur}mm;height:${r.hauteur}mm` }, etiquetteSvg(c, r));
    }), 'imp-etiquettes');
  }

  /** Liste papier d'un contenant et de tout ce qu'il contient. */
  function imprimerListe(c) {
    const profondeur = chemin(c.id).length;
    const blocs = descendants(c.id).map((x) => {
      const niveau = chemin(x.id).length - profondeur;
      return el('section', { classe: 'imp-niveau', style: `margin-left:${niveau * 1.2}em` },
        el(niveau ? 'h2' : 'h1', { texte: `${x.nom}${x.scellable ? ' (scellable)' : ''}` }),
        x.articles.length ? el('ul', {}, ...x.articles.map((a) => (a.separateur ? el('li', { classe: 'imp-separation', texte: a.nom }) : el('li', {},
          el('span', { classe: 'imp-case', 'aria-hidden': 'true' }),
          el('span', { classe: 'imp-nom', texte: estControle(a) ? `${nomArticle(a)}${texteAttente(a) ? ` (${texteAttente(a)})` : ''} : ${a.controle === 'oui' ? 'Oui / Non' : '……………'}` : `${nomArticle(a)}${a.quantite ? ` × ${estMinimum(a) ? '≥ ' : ''}${a.quantite}` : ''}${estFacultatif(a) ? ' (facultatif)' : ''}${a.commentaire ? ` — ${a.commentaire}` : ''}` }),
          suiviPeremption(a) ? el('span', { classe: 'imp-date', texte: `Pér. ${afficherDate(datePeremption(x.id, a.id)) || '……/………'}` }) : null)))) : null);
    });
    lancerImpression([
      el('header', { classe: 'imp-entete' }, qrSvg(adresse(c.id)),
        el('div', {}, el('p', { texte: chemin(c.id).map((x) => x.nom).join(' › ') }),
          el('p', { texte: `SMUR Avignon · inventaire imprimé le ${new Date().toLocaleDateString('fr-FR')}` }),
          el('p', { texte: 'Date : ……………………   Nom : ……………………………………' }))),
      ...blocs], 'imp-liste');
  }

  // ---------- Scanner (QR code par la caméra, puce NFC) ----------

  function scanner(choix = { qr: true, nfc: true }, surTrouve = aller) {
    const qr = choix.qr && 'BarcodeDetector' in window;
    const nfc = choix.nfc && 'NDEFReader' in window;
    const video = el('video', { playsinline: '', muted: '', autoplay: '' });
    video.muted = true;
    const lecture = el('p', { classe: 'lecture', role: 'status', texte: qr ? 'Ouverture de la caméra…' : 'Approchez la puce NFC du dos du téléphone.' });
    const annuler = el('button', { type: 'button', classe: 'camera-bouton secondaire', texte: 'Annuler' });
    const ecran = el('div', { classe: 'camera', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Scanner un inventaire' },
      el('div', { classe: `camera-vue${qr ? '' : ' inv-nfc-seul'}` }, qr ? video : el('div', { classe: 'inv-attente-nfc', 'aria-hidden': 'true' }, logoNfc()), qr ? el('div', { classe: 'viseur viseur-qr', 'aria-hidden': 'true' }) : null,
        el('p', { classe: 'consigne-camera consigne-qr', texte: [qr ? 'Visez le QR code de l\'inventaire' : '', nfc ? 'approchez sa puce NFC' : ''].filter(Boolean).join(' ou ') })),
      lecture, el('div', { classe: 'camera-actions' }, annuler));
    document.body.append(ecran);
    document.body.classList.add('camera-ouverte');
    let flux = null;
    let minuterie = null;
    let fini = false;
    const arretNfc = new AbortController();
    const fermer = () => {
      if (fini) return;
      fini = true;
      clearInterval(minuterie);
      arretNfc.abort();
      if (flux) flux.getTracks().forEach((t) => t.stop());
      ecran.remove();
      document.body.classList.remove('camera-ouverte');
    };
    const trouve = (texte) => {
      const m = /#inv=([a-z0-9]{6,16})$/.exec(String(texte || ''));
      if (!m) { lecture.textContent = 'Ce code n\'est pas celui d\'un inventaire.'; return; }
      fermer();
      surTrouve(m[1]);
    };
    annuler.addEventListener('click', fermer);
    ecran.addEventListener('keydown', (e) => { if (e.key === 'Escape') fermer(); });
    annuler.focus();

    if (qr) {
      const detecteur = new BarcodeDetector({ formats: ['qr_code'] });
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
        const lienPuce = [...e.message.records].find((r) => r.recordType === 'url' || r.recordType === 'absolute-url');
        trouve(lienPuce ? new TextDecoder().decode(lienPuce.data) : '');
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
    if (etatGarde && etatGarde.verifs && etatGarde.peremptions) etat = etatGarde;
    brouillons = lireJson(CLE_BROUILLONS, brouillons);
    if (!brouillons.liste) brouillons = { jour: '', liste: {}, pointes: {} };
    const modifsGardees = lireJson(CLE_MODIFS, null);
    if (modifsGardees && modifsGardees.ids) modifs = { fiches: {}, reglages: false, ...modifsGardees };
    window.addEventListener('online', synchroniser);
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
      if (cible && !gestion && !enConsultation(cible) && cible.categorie === 'mobile' && cible.parent && cible.parent === idCourant() && !mobilePointe(cible)) {
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
    document.body.classList.remove('vue-inv-checklist', 'inv-avec-valider');
  }
  /** Après un envoi de la file d'attente (app.js) : met à jour la ligne d'état. */
  function surEnvoi() {
    const ligne = zone && !zone.hidden && zone.querySelector('.inv-synchro');
    if (ligne) majLigneSynchro(ligne);
  }

  /** Barre du bas (téléphone) : scan depuis n'importe quel écran, ouvre l'inventaire trouvé. */
  function scanRapide(type) {
    const dispo = type === 'nfc' ? 'NDEFReader' in window : ('BarcodeDetector' in window && navigator.mediaDevices);
    if (!dispo) { alerteBreve(type === 'nfc' ? 'NFC non disponible : Chrome sur Android requis, NFC activé.' : 'Lecture de QR code non disponible sur ce navigateur.'); return; }
    // Étiquette lue sur place : on est là, l'inventaire s'ouvre pour être vérifié.
    scanner({ qr: type === 'qr', nfc: type === 'nfc' }, (id) => {
      fixerContexte(contexte.primaire, false);
      if (zone && !zone.hidden && !gestion && identificationEnCours()) { identificationEnCours()(id); return; }
      const place = placeIci(contenant(id));
      if (place) { confirmerIdentification(place.y, id, place.dans); return; }
      location.hash = lien(id);
    });
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

  return { initialiser, afficher, masquer, synchroniser, surEnvoi, analyserDate, scanRapide };
})();
