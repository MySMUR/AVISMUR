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
 * Seuls les administrateurs créent et modifient les inventaires (bouton « Modifier »).
 * Backend : Inventaires.gs (dépôt AVISMUR-backend).
 */
const Inventaires = (() => {
  const CLE_STRUCTURE = 'avismur_inv_structure';
  const CLE_ETAT = 'avismur_inv_etat';
  const CLE_BROUILLONS = 'avismur_inv_brouillons';
  const CLE_MODIFS = 'avismur_inv_modifs';
  const ID = /^[a-z0-9]{6,16}$/;
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
      scellable: c.scellable === true, // contenant fermé par un scellé (plomb) une fois vérifié
      ...(c.supprime ? { supprime: true } : {}),
    };
  }
  // ---------- Base des articles (catalogue) ----------
  const CATEGORIES = ['Médicament', 'DM', 'Magasin'];
  /** Texte comparable : minuscules, sans accents, espaces simples. */
  const cle = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  function normaliserFiche(f) {
    return {
      id: f.id, denomination: String(f.denomination || ''), categorie: CATEGORIES.includes(f.categorie) ? f.categorie : '',
      horsStock: f.horsStock === true, refInterne: String(f.refInterne || ''), refFournisseur: String(f.refFournisseur || ''),
      consommable: f.consommable === true, perissable: f.perissable === true, archive: f.archive === true,
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
  function reduirePhoto(fichier) {
    return new Promise((ok, ko) => {
      const url = URL.createObjectURL(fichier);
      const img = new Image();
      img.onload = () => {
        const ratio = Math.min(1, 1280 / Math.max(img.width, img.height));
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
    const fichesEnvoyees = { ...modifs.fiches };
    if (Object.keys(fichesEnvoyees).length) {
      const repFiches = await App.appeler('enregistrerCatalogue', { fiches: Object.keys(fichesEnvoyees).map((id) => structure.catalogue[id]).filter(Boolean) });
      if (!repFiches.ok) throw new RefusServeur(repFiches.erreur || 'base des articles refusée');
      Object.keys(fichesEnvoyees).forEach((id) => { if (modifs.fiches[id] === fichesEnvoyees[id]) delete modifs.fiches[id]; });
      sauverModifs();
    }
    for (const id of Object.keys(modifs.ids)) {
      const c = structure.contenants[id];
      if (!c || !c.photo.startsWith('local-')) continue;
      const locale = c.photo;
      const donnees = await Photos.lire(locale);
      let distante = '';
      if (donnees) {
        const rep = await App.appeler('envoyerPhotoInventaire', { photo: donnees });
        if (!rep.ok) throw new RefusServeur(rep.erreur || 'photo refusée');
        distante = rep.id;
        await Photos.ecrire(distante, donnees);
      }
      // Une copie d'inventaire peut partager la même photo en attente.
      Object.values(structure.contenants).filter((x) => x.photo === locale).forEach((x) => {
        x.photo = distante;
        modifs.ids[x.id] = (modifs.ids[x.id] || 0) + 1;
      });
      await Photos.supprimer(locale);
      sauverStructure();
      sauverModifs();
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
  async function tirer() {
    const rep = await App.appeler('lireInventaires');
    if (!rep.ok) {
      synchro.serveurInconnu = rep.erreur === 'Action inconnue';
      if (!rep.reconnecter) throw new RefusServeur(synchro.serveurInconnu ? 'inventaires pas encore installés sur le serveur' : (rep.erreur || 'refus du serveur'));
      return;
    }
    synchro.serveurInconnu = false;
    const contenants = {};
    rep.contenants.forEach((c) => { if (c && ID.test(c.id)) contenants[c.id] = normaliser(c); });
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
    sauverStructure();
    sauverEtat();
  }

  /** Télécharge les photos manquantes pour le hors ligne, puis oublie celles qui ne servent plus. */
  async function prechargerPhotos() {
    const utiles = new Set(Object.values(structure.contenants).filter((c) => !c.supprime && c.photo).map((c) => c.photo));
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
    if (recu && !saisie && !placement) rendre({ garderPosition: true });
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
    const sous = enfants(c.id).length;
    return el('a', { classe: `inv-carte ${b.classe}`, href: lien(c.id) }, repere,
      el('span', { classe: 'inv-carte-texte' },
        el('strong', {}, c.nom, c.scellable ? el('span', { classe: 'inv-tag-scellable', texte: 'Scellable' }) : null),
        el('span', { classe: 'inv-carte-etat' }, b.complet ? '✓ ' : '', b.texte,
          sous ? ` · ${pluriel(sous, 'sous-inventaire')}` : ''),
        el('span', { classe: 'inv-badges' }, ...badges(b))),
      el('span', { classe: 'inv-chevron', 'aria-hidden': 'true', texte: '›' }));
  }

  function boutonEdition() {
    if (!estAdmin()) return null;
    return el('button', {
      type: 'button', classe: `cfg-bouton${edition ? ' inv-actif' : ''}`, 'aria-pressed': String(edition),
      texte: edition ? 'Terminer les modifications' : 'Modifier',
      surclick: () => { edition = !edition; placement = ''; confirmer = ''; rendre({ garderPosition: true }); },
    });
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
        if (parent && parent.photo) { placement = c.id; rendre({ garderPosition: true }); zone.querySelector('.inv-photo').scrollIntoView({ block: 'center', behavior: 'smooth' }); }
        else rendre({ garderPosition: true, focus: '.inv-ajout input' });
      },
    }, el('label', { for: champ, texte: parent ? 'Ajouter un sous-inventaire' : 'Ajouter un inventaire' }),
    el('div', { classe: 'cfg-ligne' }, saisie, el('button', { type: 'submit', classe: 'cfg-bouton', texte: 'Ajouter' })));
  }

  // ----- Premier niveau -----
  function vueRacine() {
    const racines = enfants('');
    const tous = Object.values(structure.contenants).filter((c) => !c.supprime);
    const noeuds = [
      el('div', { classe: 'inv-entete' }, el('h1', { tabindex: '-1', texte: 'Inventaires' }), boutonEdition()),
      ligneSynchro(), ligneAvis(),
    ];
    const nbFiches = Object.values(structure.catalogue).filter((f) => !f.archive).length;
    if (nbFiches || estAdmin()) {
      noeuds.push(el('a', { classe: 'lien inv-lien-base', href: lien(BASE), texte: `Base des articles (${nbFiches})` }));
    }
    if (!racines.length) {
      noeuds.push(el('p', { classe: 'consigne', texte: estAdmin()
        ? 'Aucun inventaire pour l\'instant. Appuyez sur « Modifier » pour créer le premier (un sac, un tiroir, une armoire…), puis ajoutez-lui une photo, des sous-inventaires et des articles.'
        : 'Aucun inventaire n\'a encore été créé.' }));
    }
    if (scannerDisponible() && racines.length) {
      noeuds.push(el('button', { type: 'button', classe: 'bouton-photo inv-scanner', texte: '📷 Scanner un QR code ou une puce NFC', surclick: scanner }));
    }

    // Recherche par nom, à tous les niveaux.
    if (tous.length > 5) {
      const resultats = el('ul', { classe: 'inv-liste' });
      const champ = idChamp();
      const filtrer = () => {
        resultats.innerHTML = '';
        const mots = recherche.trim().toLowerCase();
        if (mots.length < 2) return;
        const sansAccent = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
        tous.filter((c) => sansAccent(c.nom).includes(sansAccent(mots))).slice(0, 12).forEach((c) => {
          const parents = chemin(c.id).slice(0, -1).map((x) => x.nom).join(' › ');
          const ligne = carte(c);
          if (parents) ligne.querySelector('.inv-carte-etat').prepend(`${parents} · `);
          resultats.append(el('li', {}, ligne));
        });
        if (!resultats.children.length) resultats.append(el('li', { classe: 'aide-question', texte: 'Aucun inventaire à ce nom.' }));
      };
      noeuds.push(el('div', { classe: 'champ inv-recherche' }, el('label', { for: champ, texte: 'Rechercher un inventaire' }),
        el('input', { id: champ, type: 'search', valeur: recherche, autocomplete: 'off', surinput: (e) => { recherche = e.target.value; filtrer(); } })), resultats);
      filtrer();
    }

    // Péremptions : tout ce qui est périmé ou le sera bientôt, avec le chemin pour y aller.
    const alertes = [];
    tous.forEach((c) => aCocher(c).filter(suiviPeremption).forEach((a) => {
      const date = datePeremption(c.id, a.id);
      const p = etatPeremption(date);
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

    noeuds.push(el('ul', { classe: 'inv-liste' }, ...racines.map((c) => el('li', {}, carte(c)))));

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
    if (!c.photo && !edition) return null;
    const bloc = el('div', { classe: 'inv-bloc-photo' });
    if (c.photo) {
      const img = el('img', { alt: `Photo : ${c.nom}` });
      const attente = el('p', { classe: 'inv-photo-attente', texte: 'Chargement de la photo…' });
      const cadre = el('div', { classe: `inv-photo${placement ? ' placement' : ''}` }, img, attente);
      const montrer = (donnees) => {
        if (donnees) { img.src = donnees; attente.remove(); } else { attente.textContent = 'Photo pas encore disponible hors ligne : passez par la liste ci-dessous.'; cadre.classList.add('sans-image'); }
      };
      if (Photos.enMemoire(c.photo)) montrer(Photos.enMemoire(c.photo));
      else obtenirPhoto(c.photo).then(montrer);
      img.addEventListener('click', (e) => {
        if (!placement) return;
        const r = img.getBoundingClientRect();
        const borne = (v) => Math.min(1, Math.max(0, v));
        c.points = c.points.filter((p) => p.cible !== placement)
          .concat({ cible: placement, x: borne((e.clientX - r.left) / r.width), y: borne((e.clientY - r.top) / r.height) });
        placement = '';
        marquer(c.id);
        rendre({ garderPosition: true });
      });
      c.points.forEach((p) => {
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
          `Touchez la photo à l'endroit de « ${contenant(placement).nom} ». `,
          el('button', { type: 'button', classe: 'lien', texte: 'Plus tard', surclick: () => { placement = ''; rendre({ garderPosition: true }); } })));
      }
      bloc.append(cadre);
    }
    if (edition) {
      const prendre = idChamp();
      const choisir = idChamp();
      const recevoir = async (e) => {
        const fichier = e.target.files[0];
        if (!fichier) return;
        try {
          const donnees = await reduirePhoto(fichier);
          const id = `local-${nouvelId()}`;
          await Photos.ecrire(id, donnees);
          if (c.photo.startsWith('local-')) await Photos.supprimer(c.photo);
          c.photo = id;
          marquer(c.id);
          rendre({ garderPosition: true });
        } catch (err) {
          messageVue('Photo illisible ou trop lourde : réessayez.', 'erreur');
        }
      };
      bloc.append(el('div', { classe: 'champ-photo' },
        el('label', { for: prendre, classe: 'bouton-photo', texte: c.photo ? '📷 Reprendre la photo' : '📷 Prendre la photo' }),
        el('input', { type: 'file', id: prendre, accept: 'image/*', capture: 'environment', classe: 'invisible', surchange: recevoir }),
        el('label', { for: choisir, classe: 'bouton-photo', texte: 'Choisir une image' }),
        el('input', { type: 'file', id: choisir, accept: 'image/*', classe: 'invisible', surchange: recevoir }),
        c.photo ? el('button', { type: 'button', classe: 'lien danger', texte: 'Retirer la photo', surclick: () => { c.photo = ''; c.points = []; marquer(c.id); rendre({ garderPosition: true }); } }) : null));
      if (!c.photo) bloc.append(el('p', { classe: 'aide-question', texte: 'La photo sert de plan : chaque sous-inventaire y est repéré par un point numéroté.' }));
    }
    return bloc;
  }

  function blocEnfants(c, fils) {
    if (!fils.length && !edition) return null;
    const liste = el('ul', { classe: 'inv-liste' });
    fils.forEach((f, i) => {
      const li = el('li', {}, carte(f, i + 1));
      if (edition) {
        const point = c.points.some((p) => p.cible === f.id);
        const deplacer = (sens) => {
          const ordre = fils.slice();
          ordre.splice(i + sens, 0, ordre.splice(i, 1)[0]);
          ordre.forEach((x, rang) => { if (x.ordre !== rang) { x.ordre = rang; marquer(x.id); } });
          rendre({ garderPosition: true });
        };
        li.append(el('div', { classe: 'cfg-ligne inv-outils' },
          el('button', { type: 'button', classe: 'cfg-mini', 'aria-label': `Monter ${f.nom}`, texte: '↑', disabled: i === 0, surclick: () => deplacer(-1) }),
          el('button', { type: 'button', classe: 'cfg-mini', 'aria-label': `Descendre ${f.nom}`, texte: '↓', disabled: i === fils.length - 1, surclick: () => deplacer(1) }),
          c.photo ? el('button', {
            type: 'button', classe: `cfg-mini${placement === f.id ? ' inv-actif' : ''}`, texte: point ? 'Déplacer le point' : 'Placer sur la photo',
            surclick: () => { placement = f.id; rendre({ garderPosition: true }); zone.querySelector('.inv-photo').scrollIntoView({ block: 'center', behavior: 'smooth' }); },
          }) : null,
          point ? el('button', { type: 'button', classe: 'cfg-mini', texte: 'Retirer le point', surclick: () => { c.points = c.points.filter((p) => p.cible !== f.id); marquer(c.id); rendre({ garderPosition: true }); } }) : null));
      }
      liste.append(li);
    });
    if (!edition) return el('section', { classe: 'inv-section' }, el('h2', { texte: 'Sous-inventaires' }), liste);
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
    return el('section', { classe: 'inv-section' },
      el('h2', { classe: 'inv-titre-plus' }, el('span', { texte: 'Sous-inventaires' }), plus),
      fils.length ? null : el('p', { classe: 'aide-question', texte: 'Aucun sous-inventaire. Touchez « + » pour en ajouter un (sacoche, pochette, tiroir…).' }),
      liste, formulaire);
  }

  /**
   * Liste à cocher d'un contenant : une ligne par article (case, désignation, quantité modifiable).
   * Les dates de péremption sont masquées ; un repère signale un article périmé ou bientôt périmé,
   * et le bouton « Péremptions » (ou ce repère) affiche les dates.
   */
  let peremptionsVisibles = false;
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
        const repere = el('button', { type: 'button', classe: 'inv-repere-date', surclick: () => { peremptionsVisibles = true; majBascule(); liste.querySelector(`#${champ}`).focus(); } });
        const montrer = () => {
          const p = b.invalides[a.id] ? { niveau: 'perime', texte: 'Date non reconnue' } : etatPeremption(dateCourante(c, a, b));
          echeance.textContent = p.texte;
          li.className = `inv-article ${p.niveau}`;
          // Repère visible même dates masquées : seulement quand il y a quelque chose à voir.
          repere.hidden = p.niveau === 'ok';
          repere.textContent = p.niveau === 'perime' ? '!' : (p.niveau === 'proche' ? '⏳' : '?');
          repere.setAttribute('aria-label', `${nomArticle(a)} : ${p.texte}. Afficher les péremptions`);
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
      const probleme = !f.denomination ? 'Indiquez la dénomination.' : (!f.categorie ? 'Choisissez la catégorie : Médicament, DM ou Magasin.' : '');
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
      const deplacer = (sens) => { c.articles.splice(i + sens, 0, c.articles.splice(i, 1)[0]); marquer(c.id); rendre({ garderPosition: true }); };
      const fleches = [
        el('button', { type: 'button', classe: 'cfg-mini', 'aria-label': `Monter ${nom}`, texte: '↑', disabled: i === 0, surclick: () => deplacer(-1) }),
        el('button', { type: 'button', classe: 'cfg-mini', 'aria-label': `Descendre ${nom}`, texte: '↓', disabled: i === c.articles.length - 1, surclick: () => deplacer(1) }),
        el('button', { type: 'button', classe: 'cfg-mini danger', 'aria-label': `Retirer ${nom} de cet inventaire`, texte: '✕', surclick: () => { c.articles.splice(i, 1); marquer(c.id); rendre({ garderPosition: true }); } })];
      if (a.separateur) {
        liste.append(el('div', { classe: 'cfg-ligne inv-edition-article inv-edition-separation' },
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
      liste.append(el('div', { classe: `inv-edition-article inv-edition-fiche${rattacher === a.id ? ' inv-rattache' : ''}` },
        el('div', { classe: 'inv-edition-nom' },
          el('strong', { texte: nom }),
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
        if (parent) { parent.points = parent.points.filter((p) => p.cible !== c.id); marquer(parent.id); }
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
      copie.points = copie.points.filter((p) => correspondance[p.cible]).map((p) => ({ ...p, cible: correspondance[p.cible] }));
      structure.contenants[copie.id] = copie;
      marquer(copie.id);
    });
    avis = `Copie créée : renommez-la, puis imprimez son étiquette.`;
    aller(copies[0].id);
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
    return [
      el('nav', { classe: 'inv-fil', 'aria-label': 'Emplacement' },
        el('a', { href: lien(''), texte: 'Inventaires' }),
        ...parents.flatMap((p) => [el('span', { 'aria-hidden': 'true', texte: ' › ' }), el('a', { href: lien(p.id), texte: p.nom })])),
      el('div', { classe: 'inv-entete' }, titre, boutonEdition()),
      edition ? el('label', { classe: 'cfg-case inv-case-fiche', for: caseScellable },
        el('input', { type: 'checkbox', id: caseScellable, checked: c.scellable, surchange: (e) => { c.scellable = e.target.checked; marquer(c.id); } }),
        el('span', {}, 'Contenant scellable', el('small', { texte: 'fermé par un scellé (plomb) une fois vérifié' }))) : null,
      ligneSynchro(), ligneAvis(),
      edition ? null : el('p', { classe: `inv-statut ${b.classe}` },
        el('strong', { texte: `${b.complet ? '✓ ' : ''}${b.texte}` }),
        v ? ` — cet inventaire à ${heure(v.date)} par ${v.agent}` : '',
        el('span', { classe: 'inv-badges' }, ...badges(b))),
      blocPhoto(c, fils),
      blocEnfants(c, fils),
      edition ? blocArticles(c) : blocVerification(c),
      !edition && !aCocher(c).length && !fils.length ? el('p', { classe: 'consigne', texte: estAdmin() ? 'Inventaire vide : appuyez sur « Modifier » pour ajouter une photo, des sous-inventaires ou des articles.' : 'Cet inventaire est vide pour l\'instant.' }) : null,
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
    if (id === BASE) {
      zone.append(...vueBase().filter(Boolean));
    } else if (id && !c) {
      zone.append(el('h1', { tabindex: '-1', texte: 'Inventaire introuvable' }), ligneSynchro(),
        el('p', { classe: 'consigne', texte: synchro.enCours ? 'Chargement des inventaires…' : 'Cet inventaire n\'existe pas ou a été supprimé. Si vous venez de scanner une étiquette, elle n\'est plus à jour.' }),
        el('a', { classe: 'lien', href: lien(''), texte: '← Tous les inventaires' }));
    } else {
      zone.append(...(c ? vueContenant(c) : vueRacine()).filter(Boolean));
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
  const scannerDisponible = () => 'BarcodeDetector' in window || 'NDEFReader' in window;

  function scanner() {
    const qr = 'BarcodeDetector' in window;
    const nfc = 'NDEFReader' in window;
    const video = el('video', { playsinline: '', muted: '', autoplay: '' });
    video.muted = true;
    const lecture = el('p', { classe: 'lecture', role: 'status', texte: qr ? 'Ouverture de la caméra…' : 'Approchez la puce NFC du dos du téléphone.' });
    const annuler = el('button', { type: 'button', classe: 'camera-bouton secondaire', texte: 'Annuler' });
    const ecran = el('div', { classe: 'camera', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Scanner un inventaire' },
      el('div', { classe: 'camera-vue' }, video, el('div', { classe: 'viseur viseur-qr', 'aria-hidden': 'true' }),
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
      aller(m[1]);
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
      aller(a.getAttribute('href') === '#inv-base' ? BASE : (m ? m[1] : ''));
    });
  }

  /** Affiche la vue (premier niveau, ou le contenant du lien « #inv=… »). */
  function afficher() {
    if (!zone) return;
    const dejaOuverte = !zone.hidden;
    zone.hidden = false;
    if (!estAdmin()) edition = false;
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
