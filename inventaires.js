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
  const VERSION_SERVEUR = 9;
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
  let edition = false;
  let gestion = false;
  // Identification d'un contenant mobile (check-list) : '<id>' (mobile prévu à cette place),
  // 'dans:<id>' (« un contenant mobile se trouve ici »), 'emp:<id>' (emplacement attendant un type de contenant).
  let identification = '';
  let placement = ''; // sous-inventaire dont on place le point sur la photo
  let avis = ''; // message affiché une fois en haut de la vue
  let confirmer = ''; // action en attente d'une deuxième pression (valider avec manquants, supprimer)
  let recherche = '';
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
  const estAdmin = () => App && App.role() === 'admin';
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
      // Vues supplémentaires (contenants primaires : une pièce, une cellule sanitaire vue sous plusieurs angles).
      // La photo principale (`photo`, `points`, nom `nomVue`) est la vue 1.
      vues: Array.isArray(c.vues) ? c.vues.map((v) => ({ id: v.id, nom: v.nom || '', photo: v.photo || '', points: Array.isArray(v.points) ? v.points : [] })) : [],
      nomVue: c.nomVue || '',
      scellable: c.scellable === true, // contenant fermé par un scellé (plomb) une fois vérifié
      categorie: CATEGORIES_CONTENANT[c.categorie] ? c.categorie : '', // primaire, immobile ou mobile
      ...(c.modele ? { modele: true } : {}),
      ...(c.desaffecte ? { desaffecte: c.desaffecte } : {}), // mobile dont la place a été prise : à retrouver
      // Emplacement : attend un exemplaire d'un inventaire type (ex. un « Ampoulier A » dans chaque sac) ;
      // l'exemplaire identifié en check-list y est rangé (enfant de l'emplacement).
      ...(c.emplacement && c.emplacement.modele ? { emplacement: { modele: c.emplacement.modele } } : {}), // inventaire type : sert de structure à ses exemplaires
      ...(c.source ? { source: c.source } : {}), // exemplaire : contenant du modèle dont il est la copie
      ...(c.base ? { base: c.base } : {}), // exemplaire : état du modèle lors de la dernière répercussion
      ...(c.supprime ? { supprime: true } : {}),
    };
  }
  // ---------- Catégories de contenants ----------
  /** Seuls les contenants primaires sont listés à l'accueil ; les autres s'ouvrent par recherche, QR code ou NFC. */
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
  const datePeremption = (idContenant, idArticle) => (etat.peremptions[`${idContenant}/${idArticle}`] || {}).date || '';
  const verifDuJour = (id) => {
    const v = etat.verifs[id];
    return v && jour(new Date(v.date)) === jour() ? v : null;
  };

  /** État d'un contenant et de tout ce qu'il contient. */
  function bilan(id) {
    const b = { total: 0, faits: 0, manquants: 0, perimes: 0, proches: 0, sansDate: 0 };
    descendants(id).forEach((c) => {
      if (dansUnModele(c.id)) return; // un inventaire type ne se vérifie pas
      if (c.emplacement && !enfants(c.id).length) { b.total += 1; b.vides = (b.vides || 0) + 1; }
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
    b.classe = b.total === 0 ? 'vide' : (b.complet ? 'fait' : (b.faits ? 'encours' : 'afaire'));
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
    Object.entries(etat.verifs).forEach(([id, v]) => {
      if (verifs[id] ? v.date > verifs[id].date : new Date(v.date).getTime() > recent) verifs[id] = v;
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
  function idCourant() {
    if (location.hash === '#inv-base') return BASE;
    const m = /^#inv=([a-z0-9]{6,16})$/.exec(location.hash);
    return m ? m[1] : '';
  }
  const lien = (id) => (id === BASE ? '#inv-base' : (id ? `#inv=${id}` : '#inv'));
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
    if (brouillons.jour !== jour()) brouillons = { jour: jour(), liste: {} };
    if (!brouillons.liste[c.id]) {
      const v = verifDuJour(c.id);
      const coches = {};
      if (v) {
        const manquants = new Set(v.manquants.map((m) => m.id));
        aCocher(c).forEach((a) => { if (!manquants.has(a.id)) coches[a.id] = true; });
      }
      brouillons.liste[c.id] = { coches, quantites: {}, dates: {}, invalides: {}, remarque: v ? v.remarque : '' };
    }
    const b = brouillons.liste[c.id];
    if (!b.quantites) b.quantites = {};
    return b;
  }
  /** Quantité attendue (nombre) d'un article, ou null s'il n'en a pas. */
  const attendue = (a) => (/^\d+$/.test(String(a.quantite || '').trim()) ? Number(a.quantite) : null);
  /** Quantité trouvée : par défaut, la quantité attendue. */
  const trouvee = (a, b) => (b.quantites[a.id] !== undefined ? b.quantites[a.id] : attendue(a));
  const dateCourante = (c, a, b) => (b.dates[a.id] !== undefined ? b.dates[a.id] : datePeremption(c.id, a.id));

  function valider(c) {
    const b = brouillon(c);
    if (aCocher(c).some((a) => b.invalides[a.id])) {
      messageVue('Une date de péremption n\'est pas reconnue : corrigez-la (ex. 03/2027 ou 15/03/2027).', 'erreur');
      return;
    }
    const articles = aCocher(c).map((a) => {
      const att = attendue(a);
      const qte = trouvee(a, b);
      return {
        id: a.id, nom: nomArticle(a), ok: Boolean(b.coches[a.id]),
        ...(att !== null ? { attendu: att, quantite: qte === null || qte === '' ? 0 : Number(qte) } : {}),
        ...(suiviPeremption(a) ? { peremption: dateCourante(c, a, b) } : {}),
      };
    });
    // Manquant : non coché, ou coché avec une quantité inférieure à celle attendue.
    const incomplet = (a) => !a.ok || (a.attendu !== undefined && a.quantite < a.attendu);
    const manquants = articles.filter(incomplet);
    if (manquants.length && confirmer !== `valider-${c.id}`) {
      confirmer = `valider-${c.id}`;
      const libelle = (a) => (a.ok ? `${a.nom} (${a.quantite}/${a.attendu})` : a.nom);
      messageVue(`Sera noté manquant : ${manquants.map(libelle).join(' ; ')}. Corrigez ou appuyez de nouveau pour valider quand même.`, 'erreur');
      zone.querySelector('.inv-valider').textContent = 'Valider quand même';
      return;
    }
    const ok = App.mettreEnFile({
      action: 'verifierInventaire', contenant: c.id,
      detail: { chemin: chemin(c.id).map((x) => x.nom).join(' > '), articles, remarque: b.remarque.trim() },
    });
    if (!ok) {
      messageVue('Non enregistré : la mémoire de l\'appareil est pleine.', 'erreur');
      return;
    }
    // Affiché tout de suite, sans attendre la réponse du serveur.
    const maintenant = new Date().toISOString();
    etat.verifs[c.id] = { date: maintenant, agent: App.agent(), manquants: manquants.map((a) => ({ id: a.id, nom: a.ok ? `${a.nom} (${a.quantite}/${a.attendu})` : a.nom })), remarque: b.remarque.trim() };
    articles.filter((a) => a.peremption !== undefined).forEach((a) => { etat.peremptions[`${c.id}/${a.id}`] = { date: a.peremption, maj: maintenant }; });
    delete brouillons.liste[c.id];
    sauverEtat();
    sauverBrouillons();
    confirmer = '';
    avis = `« ${c.nom} » vérifié${manquants.length ? ` : ${pluriel(manquants.length, 'manquant')}` : ''}.`;
    // S'il reste des sous-inventaires à vérifier, on reste ici ; sinon on remonte d'un niveau.
    const reste = enfants(c.id).some((f) => { const bf = bilan(f.id); return bf.total && !bf.complet; });
    if (reste) rendre();
    else aller(c.parent);
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
  function carte(c, numero) {
    const b = bilan(c.id);
    const repere = el('span', { classe: `inv-repere ${b.classe}`, 'aria-hidden': 'true', texte: numero ? String(numero) : '' });
    if (!numero && c.photo) {
      const vignette = (donnees) => { if (donnees) repere.append(el('img', { src: donnees, alt: '' })); };
      if (Photos.enMemoire(c.photo)) vignette(Photos.enMemoire(c.photo));
      else obtenirPhoto(c.photo).then(vignette);
    }
    const sous = c.emplacement ? 0 : enfants(c.id).length;
    const occupant = c.emplacement ? enfants(c.id)[0] : null;
    return el('a', { classe: `inv-carte ${b.classe}`, href: lien(c.id) }, repere,
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

  // ----- Premier niveau -----
  function vueRacine() {
    const racines = enfants('');
    const tous = Object.values(structure.contenants).filter((c) => !c.supprime && (gestion || !dansUnModele(c.id)));
    const noeuds = [
      bandeauGestion(),
      el('div', { classe: 'inv-entete' }, el('h1', { tabindex: '-1', texte: gestion ? 'Gestion des inventaires' : 'Inventaires' }), boutonEdition()),
      ligneSynchro(), ligneAvis(),
    ];
    const nbFiches = Object.values(structure.catalogue).filter((f) => !f.archive).length;
    if (nbFiches || estAdmin()) {
      noeuds.push(el('a', { classe: 'lien inv-lien-base', href: lien(BASE), texte: `Base des articles (${nbFiches})` }));
    }
    noeuds.push(encadreARetrouver());
    noeuds.push(encadreRecherche(tous));
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
      : el('p', { classe: 'aide-question', texte: estAdmin() ? (gestion ? 'Aucun contenant primaire : ouvrez un inventaire et choisissez la catégorie « Primaire ».' : 'Aucun contenant primaire : menu > Administration > Gestion des inventaires.') : 'Aucun contenant primaire pour l\'instant : utilisez la recherche ci-dessus.' }));
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

  // ----- Un contenant -----
  function blocPhoto(c, fils) {
    const vues = vuesDe(c);
    const vc = vueCourante(c);
    const avecPhoto = vues.some((v) => v.photo);
    if (!avecPhoto && !edition) return null;
    const bloc = el('div', { classe: 'inv-bloc-photo' });
    // Onglets des vues (plusieurs angles d'une pièce, d'une cellule sanitaire…)
    const plusieurs = vues.length > 1;
    const peutAjouter = edition && c.categorie === 'primaire';
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
        const commun = {
          classe: `inv-point ${b.classe}${placement === p.cible ? ' deplace' : ''}`, style: `left:${p.x * 100}%;top:${p.y * 100}%`,
          'aria-label': `${fils[rang].nom} : ${b.texte}`, title: fils[rang].nom,
        };
        cadre.append(edition
          ? el('button', { type: 'button', ...commun, texte: String(rang + 1), surclick: () => { placement = placement === p.cible ? '' : p.cible; rendre({ garderPosition: true }); } })
          : el('a', { href: lien(p.cible), ...commun, texte: b.complet ? '✓' : String(rang + 1) }));
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
      const recevoir = async (e) => {
        const fichier = e.target.files[0];
        if (!fichier) return;
        try {
          const donnees = await reduirePhoto(fichier);
          const id = `local-${nouvelId()}`;
          await Photos.ecrire(id, donnees);
          if (vc.photo.startsWith('local-')) await Photos.supprimer(vc.photo);
          majVue(c, vc.cle, { photo: id });
          marquer(c.id);
          rendre({ garderPosition: true });
        } catch (err) {
          messageVue('Photo illisible ou trop lourde : réessayez.', 'erreur');
        }
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
        vc.photo && !vc.cle ? el('button', { type: 'button', classe: 'lien danger', texte: 'Retirer la photo', surclick: () => { majVue(c, '', { photo: '', points: [] }); marquer(c.id); rendre({ garderPosition: true }); } }) : null,
        vc.cle ? el('button', { type: 'button', classe: 'lien danger', texte: confirmer === `vue-${vc.cle}` ? 'Confirmer : supprimer cette vue' : 'Supprimer cette vue', surclick: () => {
          if (confirmer !== `vue-${vc.cle}`) { confirmer = `vue-${vc.cle}`; rendre({ garderPosition: true }); return; }
          confirmer = '';
          c.vues = c.vues.filter((v) => v.id !== vc.cle);
          vueActive.delete(c.id);
          marquer(c.id);
          rendre({ garderPosition: true });
        } }) : null));
      if (!avecPhoto) bloc.append(el('p', { classe: 'aide-question', texte: `La photo sert de plan : chaque sous-inventaire y est repéré par un point numéroté.${c.categorie === 'primaire' ? ' « ＋ Vue » ajoute d\'autres photos (autres angles).' : ''}` }));
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
    const maj = () => {
      const n = articles.filter((a) => b.coches[a.id]).length;
      compte.textContent = `${n}/${articles.length}`;
      toutCocher.textContent = n === articles.length ? 'Tout décocher' : 'Tout cocher';
      groupes.forEach((g) => { g.bouton.textContent = g.membres.every((a) => b.coches[a.id]) ? 'Décocher' : 'Cocher'; });
    };
    // Séparations : un intertitre par groupe, avec « Cocher » pour tout le groupe.
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
        while (i < c.articles.length && !c.articles[i].separateur) g.membres.push(c.articles[i++]);
        g.bouton = el('button', { type: 'button', classe: 'lien inv-cocher-groupe', 'aria-label': `Cocher le groupe ${a.nom}`, surclick: () => {
          const tout = !g.membres.every((x) => b.coches[x.id]);
          g.membres.forEach((x) => { b.coches[x.id] = tout; const box = liste.querySelector(`input[data-article="${x.id}"]`); if (box) box.checked = tout; });
          modifie();
        } });
        if (g.membres.length) groupes.push(g);
        liste.append(el('li', { classe: 'inv-separation' }, el('span', { texte: a.nom }), g.membres.length ? g.bouton : null));
        return;
      }
      const champCase = idChamp();
      const coche = el('input', { type: 'checkbox', id: champCase, 'data-article': a.id, checked: Boolean(b.coches[a.id]), surchange: (e) => { b.coches[a.id] = e.target.checked; modifie(); } });
      const li = el('li', { classe: 'inv-article' });
      const ligne = el('div', { classe: 'inv-ligne' }, coche, el('label', { for: champCase, classe: 'inv-nom', texte: nomArticle(a) }));
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
          'aria-label': `Quantité de ${nomArticle(a)} (attendu ${att})`, valeur: String(trouvee(a, b)),
          surfocus: (e) => e.target.select(),
          surinput: (e) => {
            const v = e.target.value === '' ? '' : Math.max(0, Math.round(Number(e.target.value)));
            b.quantites[a.id] = v;
            champQte.classList.toggle('insuffisant', v !== '' && v < att);
            modifie();
          },
        });
        champQte.classList.toggle('insuffisant', Number(trouvee(a, b)) < att);
        ligne.append(el('span', { classe: 'inv-qte-zone' }, champQte, el('span', { classe: 'inv-qte-attendue', 'aria-hidden': 'true', texte: `/${att}` })));
      } else if (a.quantite) {
        ligne.append(el('span', { classe: 'inv-qte-attendue', texte: a.quantite }));
      }
      li.append(ligne);
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
      const tout = !articles.every((a) => b.coches[a.id]);
      articles.forEach((a) => { b.coches[a.id] = tout; });
      liste.querySelectorAll('input[type="checkbox"]').forEach((x) => { x.checked = tout; });
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
    return el('section', { classe: 'inv-section' },
      el('div', { classe: 'inv-liste-entete' },
        el('h2', {}, 'Contenu ', compte),
        el('div', { classe: 'inv-liste-actions' }, basculer, toutCocher)),
      veille, liste,
      el('details', { classe: 'inv-remarque', open: Boolean(b.remarque) },
        el('summary', { texte: 'Ajouter une remarque' }),
        el('textarea', { id: champRemarque, rows: '2', maxlength: '500', 'aria-label': 'Remarque', valeur: b.remarque, surinput: (e) => { b.remarque = e.target.value; sauverBrouillons(); } })),
      el('p', { classe: 'message inv-message', role: 'alert', hidden: true }),
      el('button', { type: 'button', classe: 'principal inv-valider', texte: 'Valider cet inventaire', surclick: () => valider(c) }));
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
   * Encadré en tête de la page des inventaires : on atteint n'importe quel inventaire (primaire, immobile
   * ou mobile, à n'importe quel niveau) par son nom, par son QR code ou par sa puce NFC.
   */
  function encadreRecherche(tous) {
    const resultats = el('ul', { classe: 'inv-liste inv-resultats-recherche' });
    const champ = idChamp();
    const filtrer = () => {
      resultats.innerHTML = '';
      const mots = cle(recherche).split(' ').filter(Boolean);
      if (!mots.length || cle(recherche).length < 2) return;
      const trouves = tous.filter((c) => { const t = cle(`${c.nom} ${chemin(c.id).slice(0, -1).map((x) => x.nom).join(' ')}`); return mots.every((m) => t.includes(m)); });
      trouves.slice(0, 12).forEach((c) => {
        const parents = chemin(c.id).slice(0, -1).map((x) => x.nom).join(' › ');
        const ligne = carte(c);
        if (parents) ligne.querySelector('.inv-carte-etat').prepend(`${parents} · `);
        resultats.append(el('li', {}, ligne));
      });
      if (trouves.length > 12) resultats.append(el('li', { classe: 'aide-question', texte: `${trouves.length - 12} autre(s) : précisez la recherche.` }));
      if (!trouves.length) resultats.append(el('li', { classe: 'aide-question', texte: 'Aucun inventaire à ce nom.' }));
    };
    const qr = 'BarcodeDetector' in window;
    const nfc = 'NDEFReader' in window;
    const boutons = el('div', { classe: 'inv-boutons-scan' },
      el('button', { type: 'button', classe: 'inv-bouton-scan', disabled: !qr, surclick: () => scanner({ qr: true, nfc: false }) }, logoQr(), el('span', { texte: 'Scanner un QR code' })),
      el('button', { type: 'button', classe: 'inv-bouton-scan', disabled: !nfc, surclick: () => scanner({ qr: false, nfc: true }) }, logoNfc(), el('span', { texte: 'Lire une puce NFC' })));
    const aide = !qr || !nfc ? el('p', { classe: 'aide-question inv-aide-scan', texte: !qr && !nfc
      ? 'Sur cet appareil, scannez le QR code avec l\'appareil photo du téléphone : il ouvre directement l\'inventaire. La lecture NFC demande Chrome sur Android.'
      : (!nfc ? 'Lecture NFC : Chrome sur Android seulement.' : 'QR code : vous pouvez aussi le scanner avec l\'appareil photo du téléphone.') }) : null;
    const encadre = el('section', { classe: 'inv-encadre-recherche', 'aria-labelledby': `${champ}-titre` },
      el('div', { classe: 'inv-encadre-titre' },
        el('h2', { id: `${champ}-titre`, texte: 'Trouver un inventaire' }),
        el('span', { classe: 'inv-logos', 'aria-hidden': 'true' }, logoQr(), logoNfc())),
      el('label', { for: champ, classe: 'inv-libelle-recherche', texte: 'Nom (véhicule, sac, sacoche, tiroir…)' }),
      el('input', { id: champ, type: 'search', valeur: recherche, autocomplete: 'off', placeholder: 'ex. F25, sac rouge, ampoulier', surinput: (e) => { recherche = e.target.value; filtrer(); } }),
      boutons, aide, resultats);
    filtrer();
    return encadre;
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
    if (y && x.id === y.id) { identification = ''; aller(y.id); return; }
    if (!y && x.parent === dans) { identification = ''; aller(x.id); return; }
    if (x.categorie !== 'mobile' || dansUnModele(x.id)) { messageVue(`« ${x.nom} » n'est pas un contenant mobile : choisissez celui qui se trouve réellement ici.`, 'erreur'); return; }
    const vers = y ? y.parent : dans;
    const emp = contenant(vers) && contenant(vers).emplacement ? contenant(vers) : null;
    if (emp && x.source !== emp.emplacement.modele) {
      const type = contenant(emp.emplacement.modele);
      messageVue(`Cet emplacement attend un exemplaire de « ${type ? type.nom : 'l\'inventaire type prévu'} » : « ${x.nom} » n'en est pas un.`, 'erreur');
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
    identification = '';
    avis = `« ${x.nom} » est maintenant dans « ${parent ? parent.nom : '?'} »${ancien ? ` (il était dans « ${ancien.nom} »)` : (retrouve ? ' : il est retrouvé' : '')}.`
      + (y ? ` « ${y.nom} » est désaffecté : à retrouver, il est signalé sur la page des inventaires.` : '');
    aller(x.id);
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
    const typeAttendu = emp ? contenant(emp.emplacement.modele) : null;
    const mobiles = Object.values(structure.contenants).filter((c) => !c.supprime && c.categorie === 'mobile' && !dansUnModele(c.id)
      && (!emp || c.source === emp.emplacement.modele));
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
    const saisie = el('input', { id: champ, type: 'search', autocomplete: 'off', placeholder: y ? `ex. ${y.nom}` : 'ex. ampoulier, sacoche', surinput: (e) => filtrer(e.target.value) });
    filtrer('');
    const qr = 'BarcodeDetector' in window;
    const nfc = 'NDEFReader' in window;
    return [
      el('nav', { classe: 'inv-fil', 'aria-label': 'Emplacement' }, el('a', { href: lien(''), texte: 'Inventaires' }),
        ...chemin(parent ? parent.id : '').flatMap((p) => [el('span', { 'aria-hidden': 'true', texte: ' › ' }), el('a', { href: lien(p.id), texte: p.nom })])),
      el('h1', { tabindex: '-1', texte: typeAttendu ? `Quel « ${typeAttendu.nom} » se trouve ici ?` : (y ? `Quel « ${y.nom.replace(/\s*n°\s*\d+$/i, '')} » se trouve ici ?` : 'Quel contenant mobile se trouve ici ?') }),
      el('p', { classe: 'consigne' }, `Avant de vérifier son contenu et ses péremptions, identifiez le contenant réellement présent dans « ${parent ? parent.nom : ''} » : scannez son QR code, lisez sa puce NFC ou choisissez-le dans la liste.`),
      el('section', { classe: 'inv-encadre-recherche' },
        el('div', { classe: 'inv-boutons-scan' },
          el('button', { type: 'button', classe: 'inv-bouton-scan', disabled: !qr, surclick: () => scanner({ qr: true, nfc: false }, choisir) }, logoQr(), el('span', { texte: 'Scanner son QR code' })),
          el('button', { type: 'button', classe: 'inv-bouton-scan', disabled: !nfc, surclick: () => scanner({ qr: false, nfc: true }, choisir) }, logoNfc(), el('span', { texte: 'Lire sa puce NFC' }))),
        el('label', { for: champ, classe: 'inv-libelle-recherche inv-libelle-identif', texte: 'Ou choisissez-le :' }), saisie, resultats),
      el('p', { classe: 'message inv-message', role: 'alert', hidden: true }),
      el('p', { classe: 'aide-question', texte: y ? `Prévu ici : « ${y.nom} ». Si c'en est un autre, il prend sa place et « ${y.nom} » est désaffecté jusqu'à ce qu'on le retrouve ailleurs.` : `Le contenant choisi sera rangé dans « ${parent ? parent.nom : ''} ». S'il était désaffecté, il est retrouvé.` }),
      el('div', { classe: 'inv-pied' }, el('button', { type: 'button', classe: 'lien', texte: `← Retour à ${parent ? parent.nom : 'l\'inventaire'}`, surclick: () => { identification = ''; rendre(); } })),
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
    const racine = racineModele(c.id) || ch.find((x) => x.categorie === 'primaire') || ch[0];
    if (!racine) return null;
    const ouverts = new Set(ch.map((x) => x.id));
    const noeud = (x, profondeur) => {
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
      el('h2', { texte: racine.modele ? 'Inventaire type' : 'Arborescence' }),
      el('ul', { classe: 'inv-arbre-racine' }, noeud(racine, 0)),
      el('p', { classe: 'aide-question inv-arbre-legende', texte: 'Le nombre indique les articles à cocher.' }));
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
              } }))),
        el('div', { classe: 'cfg-ligne inv-edition-outils' }, el('label', { classe: 'inv-qte-libelle' }, 'Qté ', qte), ...fleches)));
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

    return el('section', { classe: 'inv-section' }, el('h2', { texte: 'Articles à cocher' }),
      c.articles.length ? null : el('p', { classe: 'aide-question', texte: 'Aucun article : ce niveau sert seulement à ouvrir ses sous-inventaires.' }),
      liste,
      el('div', { classe: 'champ inv-recherche-article' },
        el('label', { for: champ, texte: cible ? `Rattacher « ${cible.nom} » à un article de la base` : 'Ajouter un article' }),
        recherche, resultats, zoneCreation,
        cible ? null : el('div', { classe: 'cfg-actions inv-boutons-ajout' },
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
  function vueBase() {
    const admin = estAdmin();
    const usages = utilisations();
    const liste = el('ul', { classe: 'inv-base-liste' });
    const compte = el('p', { classe: 'aide-question', role: 'status' });
    const nouvelle = el('div');
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
            enregistrerFiche(g);
            // La copie du nom dans les inventaires suit la fiche (historique des vérifications plus lisible).
            Object.values(structure.contenants).forEach((c) => {
              let change = false;
              c.articles.forEach((a) => { if (a.ref === g.id && (a.nom !== g.denomination || a.peremption !== g.perissable)) { a.nom = g.denomination; a.peremption = g.perissable; change = true; } });
              if (change) marquer(c.id);
            });
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
      const affichees = trouvees.slice(0, 60);
      compte.textContent = trouvees.length ? `${pluriel(trouvees.length, 'article')}${trouvees.length > 60 ? ' — 60 premiers affichés, précisez la recherche' : ''}` : 'Aucun article ne correspond.';
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
      el('nav', { classe: 'inv-fil', 'aria-label': 'Emplacement' }, el('a', { href: lien(''), texte: 'Inventaires' })),
      el('div', { classe: 'inv-entete' }, el('h1', { tabindex: '-1', texte: 'Base des articles' }),
        admin && baseOuverte !== 'nouvelle' ? el('button', { type: 'button', classe: 'cfg-bouton', texte: '＋ Nouvel article', surclick: () => { baseOuverte = 'nouvelle'; rendre({ garderPosition: true, focus: '.inv-fiche input' }); } }) : null),
      ligneSynchro(), ligneAvis(),
      el('p', { classe: 'consigne', texte: 'Chaque article des inventaires est décrit ici une seule fois. Une modification de fiche s\'applique à tous les inventaires qui l\'utilisent.' }),
      nouvelle,
      el('div', { classe: 'champ' }, el('label', { for: champ, texte: 'Rechercher (nom ou référence)' }),
        el('input', { id: champ, type: 'search', autocomplete: 'off', valeur: baseFiltre.texte, surinput: (e) => { baseFiltre.texte = e.target.value; remplir(); } })),
      filtres,
      el('label', { classe: 'cfg-case', for: caseArchives }, el('input', { type: 'checkbox', id: caseArchives, checked: baseFiltre.archives, surchange: (e) => { baseFiltre.archives = e.target.checked; remplir(); } }), 'Afficher les articles archivés'),
      compte, liste,
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
      el('div', { classe: 'inv-acces' }, qrSvg(url),
        el('div', { classe: 'inv-acces-actions' },
          el('p', { classe: 'inv-url', texte: url }),
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
  const sigArticle = (a) => (a.separateur ? { separateur: true, nom: a.nom } : { ref: a.ref || '', nom: a.ref ? '' : a.nom, quantite: String(a.quantite || '') });
  /** Instantané d'un contenant du modèle : ce que ses exemplaires doivent reproduire. */
  function instantane(m) {
    return {
      nom: m.nom, ordre: m.ordre, photo: m.photo, scellable: m.scellable, categorie: m.categorie,
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
      nom: e.nom, ordre: e.ordre, photo: e.photo, scellable: e.scellable, categorie: e.categorie,
      points: e.points.map((p) => ({ cible: versModele(p.cible), x: p.x, y: p.y })),
      nomVue: e.nomVue,
      vues: e.vues.map((v) => ({ id: v.id, nom: v.nom, photo: v.photo, points: v.points.map((p) => ({ cible: versModele(p.cible), x: p.x, y: p.y })) })),
      articles: e.articles.map((a) => ({ id: a.id, ...sigArticle(a) })),
      enfants: enfants(e.id).filter((x) => !(contenant(x.source) || {}).modele).map((x) => x.source).filter(Boolean),
    };
  }
  const sansNoms = (articles) => (articles || []).map(({ refNom, ...a }) => a);
  const CHAMPS_LIBELLES = { nom: 'nom', ordre: 'place', photo: 'photo', nomVue: 'nom de la vue', vues: 'vues', scellable: 'scellable', categorie: 'catégorie', points: 'points sur la photo', articles: 'articles', enfants: 'sous-inventaires' };
  /** Champs d'un contenant d'exemplaire modifiés localement depuis la dernière répercussion. */
  function personnalisations(e) {
    if (!e.base) return [];
    const v = vueExemplaire(e);
    const racine = !contenant(e.parent) || !contenant(e.parent).source;
    return Object.keys(CHAMPS_LIBELLES).filter((k) => !(racine && (k === 'nom' || k === 'ordre')))
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
        if (forcer || (b && egal(sigArticle(i), sigArticle(b)))) resultat.push({ ...i, ...depuisModele() });
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
    ['nom', 'ordre', 'photo', 'nomVue', 'scellable', 'categorie'].forEach((k) => {
      if (racine && (k === 'nom' || k === 'ordre')) return; // le sac garde son nom et sa place
      if (forcer || egal(v[k], base[k])) e[k] = copieProfonde(m[k]);
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

  function vueContenant(c) {
    const fils = enfants(c.id);
    const b = bilan(c.id);
    const parents = chemin(c.id).slice(0, -1);
    const v = verifDuJour(c.id);
    const titre = edition
      ? el('div', { classe: 'champ inv-champ-nom' }, el('label', { for: 'inv-nom', texte: 'Nom' }),
        el('input', { id: 'inv-nom', maxlength: '80', valeur: c.nom, surchange: (e) => { const t = e.target.value.trim(); if (t) { c.nom = t; marquer(c.id); } else e.target.value = c.nom; } }))
      : el('h1', { tabindex: '-1' }, c.nom, c.scellable ? el('span', { classe: 'inv-tag-scellable', texte: 'Scellable' }) : null);
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
    return [
      el('nav', { classe: 'inv-fil', 'aria-label': 'Emplacement' },
        el('a', { href: lien(''), texte: 'Inventaires' }),
        ...parents.flatMap((p) => [el('span', { 'aria-hidden': 'true', texte: ' › ' }), el('a', { href: lien(p.id), texte: p.nom })])),
      bandeauGestion(),
      el('div', { classe: 'inv-entete' }, titre, boutonEdition()),
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
      c.emplacement ? (() => {
        const type = contenant(c.emplacement.modele);
        const occ = enfants(c.id)[0];
        return el('p', { classe: 'note-parc inv-note-emplacement' }, el('strong', { texte: 'Emplacement. ' }),
          'Attend un exemplaire de l\'inventaire type ', type ? el('a', { href: lien(type.id), texte: type.nom }) : '(supprimé)', '. ',
          occ ? `Actuellement : « ${occ.nom} ».` : 'Vide pour l\'instant : l\'exemplaire sera identifié en check-list.');
      })() : null,
      c.desaffecte && !c.parent ? el('p', { classe: 'note-parc anomalie' }, el('strong', { texte: 'Désaffecté — à retrouver. ' }),
        `Était dans ${c.desaffecte.deNom || '?'}. Pour le réaffecter, identifiez-le depuis le contenant où il se trouve (« Un contenant mobile se trouve ici »). `,
        el('button', { type: 'button', classe: 'lien', texte: 'Publier une alerte sur le mur', surclick: () => publierARetrouver(c) })) : null,
      edition || modele ? null : el('p', { classe: `inv-statut ${b.classe}` },
        el('strong', { texte: `${b.complet ? '✓ ' : ''}${b.texte}` }),
        v ? ` — cet inventaire à ${heure(v.date)} par ${v.agent}` : '',
        el('span', { classe: 'inv-badges' }, ...badges(b))),
      blocPhoto(c, fils),
      blocEnfants(c, fils),
      !edition && !modele ? el('button', { type: 'button', classe: 'lien inv-mobile-ici', texte: '＋ Un contenant mobile se trouve ici', surclick: () => { identification = `dans:${c.id}`; rendre(); } }) : null,
      c.emplacement ? null : (edition ? blocArticles(c) : (modele ? blocContenuModele(c) : blocVerification(c))),
      !edition && !aCocher(c).length && !fils.length ? el('p', { classe: 'consigne', texte: estAdmin() ? 'Inventaire vide : menu > Administration > Gestion des inventaires pour ajouter une photo, des sous-inventaires ou des articles.' : 'Cet inventaire est vide pour l\'instant.' }) : null,
      !edition && !aCocher(c).length ? el('p', { classe: 'message inv-message', role: 'alert', hidden: true }) : null,
      edition ? el('p', { classe: 'message inv-message', role: 'alert', hidden: true }) : null,
      edition ? blocAcces(c) : null,
      el('div', { classe: 'inv-pied' },
        el('a', { classe: 'lien', href: lien(c.parent), texte: parents.length ? `← Retour à ${parents[parents.length - 1].nom}` : '← Tous les inventaires' }),
        edition ? null : el('button', { type: 'button', classe: 'lien', texte: 'Imprimer la liste', surclick: () => imprimerListe(c) })),
    ];
  }

  function rendre({ garderPosition = false, focus = '' } = {}) {
    if (!zone || zone.hidden) return;
    const id = idCourant();
    const c = contenant(id);
    const nouveau = dernierAffiche !== id;
    dernierAffiche = id;
    if (nouveau) {
      identification = '';
      placement = '';
      confirmer = '';
      if (pile.length > 1 && pile[pile.length - 2] === id) pile.pop();
      else pile.push(id);
      rattacher = '';
      rechercheAjout = '';
      creation = null;
      ajoutSousOuvert = false;
    }
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
    } else if (id && !c) {
      zone.append(el('h1', { tabindex: '-1', texte: 'Inventaire introuvable' }), ligneSynchro(),
        el('p', { classe: 'consigne', texte: synchro.enCours ? 'Chargement des inventaires…' : 'Cet inventaire n\'existe pas ou a été supprimé. Si vous venez de scanner une étiquette, elle n\'est plus à jour.' }),
        el('a', { classe: 'lien', href: lien(''), texte: '← Tous les inventaires' }));
    } else {
      const contenu = (c ? vueContenant(c) : vueRacine()).filter(Boolean);
      const arbre = c ? blocArborescence(c) : null;
      if (arbre) zone.append(el('div', { classe: 'inv-mise-en-page' }, el('div', { classe: 'inv-corps' }, ...contenu), arbre));
      else zone.append(...contenu);
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

  function imprimerEtiquettes(liste) {
    lancerImpression(liste.map((c) => el('div', { classe: 'imp-etiquette' }, qrSvg(adresse(c.id)),
      el('div', {}, el('strong', { texte: c.nom }),
        el('span', { texte: chemin(c.id).slice(0, -1).map((x) => x.nom).join(' › ') }),
        el('small', { texte: `SMUR Avignon · ${c.id}` })))), 'imp-etiquettes');
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
          el('span', { classe: 'imp-nom', texte: `${nomArticle(a)}${a.quantite ? ` × ${a.quantite}` : ''}` }),
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
    if (!brouillons.liste) brouillons = { jour: '', liste: {} };
    const modifsGardees = lireJson(CLE_MODIFS, null);
    if (modifsGardees && modifsGardees.ids) modifs = { fiches: {}, reglages: false, ...modifsGardees };
    window.addEventListener('online', synchroniser);
    // Les liens internes passent par aller() (voir la pile ci-dessus).
    zone.addEventListener('click', (e) => {
      const a = e.target.closest('a[href^="#inv"]');
      if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;
      e.preventDefault();
      const m = /^#inv=([a-z0-9]{6,16})$/.exec(a.getAttribute('href'));
      const cible = m && contenant(m[1]);
      // Check-list : ouvrir un contenant mobile depuis son contenant demande d'abord lequel est réellement là.
      if (cible && !gestion && cible.emplacement && cible.parent === idCourant()) {
        identification = `emp:${cible.id}`;
        rendre();
        return;
      }
      if (cible && !gestion && cible.categorie === 'mobile' && cible.parent && cible.parent === idCourant()) {
        identification = cible.id;
        rendre();
        return;
      }
      aller(a.getAttribute('href') === '#inv-base' ? BASE : (m ? m[1] : ''));
    });
  }

  /** Affiche la vue (premier niveau, ou le contenant du lien « #inv=… »). */
  function afficher({ gestion: enGestion = false } = {}) {
    if (!zone) return;
    const dejaOuverte = !zone.hidden;
    zone.hidden = false;
    gestion = enGestion && estAdmin();
    edition = gestion;
    if (!dejaOuverte) { dernierAffiche = null; pile = []; }
    rendre();
    if (!dejaOuverte) synchroniser();
  }
  function masquer() {
    if (zone) zone.hidden = true;
  }
  /** Après un envoi de la file d'attente (app.js) : met à jour la ligne d'état. */
  function surEnvoi() {
    const ligne = zone && !zone.hidden && zone.querySelector('.inv-synchro');
    if (ligne) majLigneSynchro(ligne);
  }

  return { initialiser, afficher, masquer, synchroniser, surEnvoi, analyserDate };
})();
