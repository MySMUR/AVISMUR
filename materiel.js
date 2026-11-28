/*
 * Suivi du matériel biomédical (menu Inventaires > Suivi matériel ; Administration > Gestion des catalogues > Base du matériel).
 *
 * Base des appareils : type, modèle, n° interne SMUR, n° biomed, n° de série, révision prévue,
 * historique des révisions / interventions / réparations, traceur GeoTraceSMUR.
 * Lecture pour tous ; création, modification et interventions pour les administrateurs.
 * « Répercuter » : après la modification d'une fiche, les mêmes changements peuvent être appliqués
 * à d'autres appareils (même type ou même modèle pré-cochés) ; une sélection multiple permet aussi
 * de modifier plusieurs appareils ou de leur ajouter la même intervention en une fois.
 *
 * Matériels types : des appareils identiques (même type, modèle, périodicité, photo) sont rattachés à une
 * fiche type ; la modifier met à jour tous les appareils rattachés. Un appareil non rattaché est un matériel unique.
 * Les numéros, la révision prévue, le statut, le traceur et les remarques restent propres à chaque appareil.
 *
 * Maintenance préventive : un appareil peut avoir plusieurs plans (révision annuelle, contrôle électrique,
 * changement de batterie…), chacun avec sa périodicité et sa prochaine échéance. Pour un matériel type,
 * les plans (libellé, périodicité) sont communs ; les échéances restent propres à chaque appareil.
 *
 * Hors ligne : la dernière liste reçue est gardée sur l'appareil ; les modifications passent par la
 * file d'attente commune (app.js) et s'affichent tout de suite, marquées « en attente d'envoi ».
 * Backend : Materiel.gs (onglets Materiel et MaterielInterventions).
 *
 * Onglet « Matériel de prêt » (vue materiel-prets) : pool de 12 références qui accueillent chacune un matériel
 * prêté au SMUR ; backend MaterielPrets.gs.
 */
const Materiel = (() => {
  const CLE_CACHE = 'avismur_materiel';
  const ACTIONS = ['enregistrerMateriel', 'enregistrerModeles', 'ajouterIntervention', 'supprimerIntervention', 'supprimerMateriel', 'enregistrerPret', 'rendrePret', 'signalerMateriel', 'avancerSuiviBiomed', 'enregistrerEtiquettePret', 'realiserMaintenance', 'definirSituationMateriel', 'enregistrerStatutsMateriel'];
  const TYPES_DEFAUT = ['Scope', 'PSE', 'Défibrillateur', 'Scope/défibrillateur', 'Respirateur', 'Aspirateur de mucosités', 'Attelle', 'Appareil glycémie'];
  const STATUTS_DEFAUT = ['En service', 'En panne', 'En réparation', 'En maintenance', 'Prêté', 'Réformé'];
  const COULEURS_STATUT = { 'En service': '#1b7f4c', 'En panne': '#c0392b', 'En réparation': '#d9822b', 'En maintenance': '#b7791f', 'Prêté': '#6b46c1', 'Réformé': '#6b7280' };
  const LIEUX_DEFAUT = ['Hôpital', 'Maison mère'];
  const A_RECUPERER_DEFAUT = ['Au biomédical', 'Oublié dans un service'];
  const INTERVENTIONS_DEFAUT = ['Révision', 'Intervention', 'Réparation', 'Panne signalée', 'Casse', 'Problème', 'Contrôle', 'Mise à jour logicielle', 'Envoi en maintenance', 'Note', 'Réforme', 'Remise en service', 'Autre'];
  // Entrées écrites automatiquement dans la main courante : jamais retirées.
  const JOURNAL = ['Création', 'Modification'];
  // Champs communs à plusieurs appareils, que l'on peut répercuter (jamais les numéros propres à chacun).
  const REPERCUTABLES = {
    modeleType: 'Matériel type', type: 'Type', modele: 'Modèle', biomed: 'Suivi biomed', maintenance: 'Maintenance préventive',
    plans: 'Maintenances', logiciel: 'Logiciel', versionLogiciel: 'Version logiciel',
    statut: 'Statut', traceur: 'Traceur GeoTraceSMUR', remarques: 'Remarques', photo: 'Photo',
  };
  const BOOLEENS = ['traceur', 'biomed', 'maintenance', 'logiciel', 'archive'];
  // Libellés de la main courante (mêmes que le serveur).
  const LIBELLES = {
    modeleType: 'Matériel type', type: 'Type', modele: 'Modèle', numInterne: 'N° interne', biomed: 'Suivi biomed', numBiomed: 'N° biomed',
    numSerie: 'N° de série', maintenance: 'Maintenance préventive',
    logiciel: 'Logiciel', versionLogiciel: 'Version logiciel', statut: 'Statut', traceur: 'Traceur', nomTraceur: 'Nom du traceur',
    remarques: 'Remarques', photo: 'Photo', archive: 'Archivé',
  };
  // Champs communs repris de la fiche type quand l'appareil y est rattaché.
  const COMMUNS = ['type', 'modele', 'biomed', 'maintenance', 'logiciel', 'plans'];
  const ALERTE_JOURS = 30; // révision « à prévoir » dans les 30 jours

  let zone;
  let outils = {}; // { appeler, mettreEnFile, lireFile, retirerDeFile, estAdmin }
  let donnees = null; // dernière réponse du serveur
  let chargementEnCours = false;
  let filtre = { texte: '', type: '', statut: 'actifs', alerte: '' };
  let onglet = 'appareils'; // « appareils » (base du matériel) ou « prets » (matériel de prêt)
  let filtresOuverts = false; // panneau « Filtres » déplié (type, statut, traceur)
  const selection = new Set();
  let erreur = '';

  // ---------- Utilitaires ----------
  function el(balise, attributs = {}, ...enfants) {
    const n = document.createElement(balise);
    Object.entries(attributs).forEach(([k, v]) => {
      if (v === undefined || v === null || v === false) return;
      if (k === 'texte') n.textContent = v;
      else if (k === 'classe') n.className = v;
      else if (k === 'valeur') n.value = v;
      else if (k === 'coche') n.checked = Boolean(v);
      else if (k.startsWith('sur')) n.addEventListener(k.slice(3), v);
      else n.setAttribute(k, v === true ? '' : v);
    });
    n.append(...enfants.flat(Infinity).filter((e) => e !== null && e !== undefined && e !== false));
    return n;
  }
  let compteur = 0;
  const nouvelId = () => `mat${(compteur += 1)}`;
  function idFiche() {
    const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
    let id = '';
    for (let i = 0; i < 10; i++) id += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    return id;
  }
  const aujourdhui = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const dateFr = (iso) => (iso ? iso.split('-').reverse().join('/') : '—');
  /** Échéance suivante d'un plan : + N mois ou + N semaines. */
  function ajouterPeriode(iso, p, ancre) {
    if (p.cycle) return prochaineCycle(iso, p.cycle, ancre);
    if (p.unite !== 'semaine') return ajouterMois(iso, p.periodicite);
    const [a, m, j] = iso.split('-').map(Number);
    const d = new Date(a, m - 1, j + 7 * Number(p.periodicite));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  // ---------- Cycles fixes (calendrier) ----------
  // cycle : { mode: 'semaine', jour: 1-7, pas }            → tous les lundis, un lundi sur deux…
  //         { mode: 'rang', jour: 1-7, rang: 1-5, pas }    → le premier lundi du mois (rang 5 = dernier), tous les `pas` mois
  //         { mode: 'jourMois', jour: 1-31, pas }          → le 15 de chaque mois (jour 31 : dernier jour des mois courts)
  const JOURS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
  const RANGS = { 1: 'premier', 2: 'deuxième', 3: 'troisième', 4: 'quatrième', 5: 'dernier' };
  const isoDe = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const jourSemaine = (d) => ((d.getDay() + 6) % 7) + 1; // 1 = lundi … 7 = dimanche
  function texteCycle(c) {
    if (!c) return '';
    const pas = Number(c.pas) || 1;
    if (c.mode === 'semaine') return pas === 1 ? `tous les ${JOURS[c.jour - 1]}s` : `le ${JOURS[c.jour - 1]}, toutes les ${pas} semaines`;
    const mois = pas === 1 ? 'du mois' : `, tous les ${pas} mois`;
    if (c.mode === 'rang') return `le ${RANGS[c.rang]} ${JOURS[c.jour - 1]} ${mois}`;
    return pas === 1 ? `le ${c.jour === 1 ? '1er' : c.jour} de chaque mois` : `le ${c.jour === 1 ? '1er' : c.jour}, tous les ${pas} mois`;
  }
  /** Date du cycle dans un mois donné. */
  function occurrenceMois(c, annee, mois) {
    const dernier = new Date(annee, mois + 1, 0).getDate();
    if (c.mode === 'jourMois') return new Date(annee, mois, Math.min(c.jour, dernier));
    const premier = new Date(annee, mois, 1);
    const decalage = (c.jour - jourSemaine(premier) + 7) % 7;
    let jour = 1 + decalage + 7 * (c.rang === 5 ? 4 : c.rang - 1);
    if (c.rang === 5) { while (jour > dernier) jour -= 7; } else if (jour > dernier) return null; // pas de 5ᵉ occurrence ce mois-ci
    return new Date(annee, mois, jour);
  }
  /** Première date du cycle strictement après `apres` ; `ancre` (échéance en cours) fixe la phase des cycles « toutes les N semaines / N mois ». */
  function prochaineCycle(apres, c, ancre) {
    if (!c || !apres) return '';
    const [a, m, j] = apres.split('-').map(Number);
    const ref = new Date(a, m - 1, j);
    const pas = Math.max(1, Number(c.pas) || 1);
    if (c.mode === 'semaine') {
      let d;
      const depart = ancre && /^\d{4}-\d{2}-\d{2}$/.test(ancre) ? new Date(...ancre.split('-').map((v, n) => (n === 1 ? Number(v) - 1 : Number(v)))) : null;
      if (depart && jourSemaine(depart) === c.jour) { d = depart; while (d <= ref) d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7 * pas); }
      else { d = new Date(a, m - 1, j + 1); while (jourSemaine(d) !== c.jour) d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1); }
      return isoDe(d);
    }
    const base = ancre && /^\d{4}-\d{2}-\d{2}$/.test(ancre) ? ancre.split('-').map(Number) : [a, m, j];
    for (let k = 0; k < 600; k++) {
      const t = new Date(base[0], base[1] - 1 + k * pas, 1);
      const d = occurrenceMois(c, t.getFullYear(), t.getMonth());
      if (d && d > ref) return isoDe(d);
    }
    return '';
  }

  /** « tous les 12 mois », « toutes les semaines », « toutes les 2 semaines », ou le cycle fixe (« le premier lundi du mois »). */
  function textePeriode(p) {
    if (p.cycle) return texteCycle(p.cycle);
    if (!p.periodicite) return '';
    if (p.unite === 'semaine') return Number(p.periodicite) === 1 ? 'toutes les semaines' : `toutes les ${p.periodicite} semaines`;
    return `tous les ${p.periodicite} mois`;
  }
  const courtePeriode = (p) => (p.cycle ? texteCycle(p.cycle) : p.periodicite ? (p.unite === 'semaine' ? (Number(p.periodicite) === 1 ? 'hebdomadaire' : `${p.periodicite} sem.`) : `${p.periodicite} mois`) : '');
  function ajouterMois(iso, mois) {
    const [a, m, j] = iso.split('-').map(Number);
    const d = new Date(a, m - 1 + Number(mois), j);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  const normaliser = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const estAdmin = () => Boolean(outils.estAdmin && outils.estAdmin());
  const types = () => {
    const base = (donnees && donnees.types) || TYPES_DEFAUT;
    const autres = [...fiches(), ...modeles()].map((f) => f.type).filter((t) => t && !base.includes(t));
    return [...base, ...new Set(autres)];
  };
  const statuts = () => (donnees && donnees.statuts) || STATUTS_DEFAUT;
  const statutsDetail = () => (donnees && donnees.statutsDetail) || statuts().map((nom) => ({ nom, couleur: COULEURS_STATUT[nom] || '#6b7280', verrouille: nom in COULEURS_STATUT }));
  const couleurStatut = (nom) => (statutsDetail().find((s) => s.nom === nom) || {}).couleur || COULEURS_STATUT[nom] || '#6b7280';
  const lieux = () => (donnees && donnees.situation && donnees.situation.lieux) || LIEUX_DEFAUT;
  const aRecuperer = () => (donnees && donnees.situation && donnees.situation.aRecuperer) || A_RECUPERER_DEFAUT;
  /** Pastille de statut en clair, colorée selon la liste administrable. */
  const pastilleStatut = (nom) => el('span', { classe: `mat-pastille statut-${normaliser(nom || 'En service').replace(/\W+/g, '-')}`, texte: nom || 'En service', style: `background:${couleurStatut(nom || 'En service')}22;color:${couleurStatut(nom || 'En service')}` });
  /** Présence, prêt à un tiers et matériel à récupérer, en pastilles. */
  function pastillesSituation(f) {
    const p = (texte, classe) => el('span', { classe: `mat-pastille ${classe}`, texte });
    return [
      f.presence === 'Parti' ? p(`Parti · ${f.lieu || '?'}`, 'situation-parti') : p('Dans les locaux', 'situation-locaux'),
      f.pretA ? p(`Prêté à ${f.pretA}`, 'situation-pret') : null,
      f.aRecuperer ? p(f.aRecuperer === 'Au biomédical' ? 'À récupérer · biomédical' : `À récupérer · ${f.aRecupererPrecision || 'service ?'}`, 'situation-recup') : null,
    ].filter(Boolean);
  }
  /** Même effet que le serveur (definirSituationMateriel), pour l'affichage immédiat hors ligne. Renvoie les lignes de main courante. */
  function appliquerSituation(f, d) {
    const notes = [];
    if ('statut' in d && d.statut && d.statut !== f.statut) { notes.push(`Statut : ${f.statut} → ${d.statut}`); f.statut = d.statut; }
    if ('presence' in d) {
      const pres = d.presence === 'Parti' ? 'Parti' : 'Dans les locaux';
      const lieu = pres === 'Parti' ? d.lieu || '' : '';
      if (pres !== (f.presence || 'Dans les locaux') || lieu !== (f.lieu || '')) { f.presence = pres; f.lieu = lieu; notes.push(pres === 'Parti' ? `Parti à : ${lieu}` : 'Revenu dans les locaux'); }
    }
    if ('pretA' in d && (d.pretA || '') !== (f.pretA || '')) {
      notes.push(d.pretA ? `Prêté à : ${d.pretA}` : `Prêt terminé (rendu par ${f.pretA})`);
      f.pretA = d.pretA || ''; f.pretLe = d.pretA ? aujourdhui() : '';
    }
    if ('aRecuperer' in d && ((d.aRecuperer || '') !== (f.aRecuperer || '') || (d.precision || '') !== (f.aRecupererPrecision || ''))) {
      notes.push(d.aRecuperer ? `À récupérer : ${d.aRecuperer.toLowerCase()}${d.precision ? ` (${d.precision})` : ''}` : 'Récupéré');
      f.aRecupererDepuis = d.aRecuperer ? (f.aRecuperer === d.aRecuperer ? f.aRecupererDepuis : aujourdhui()) : '';
      f.aRecuperer = d.aRecuperer || ''; f.aRecupererPrecision = d.aRecuperer ? d.precision || '' : '';
    }
    return notes;
  }
  const typesIntervention = () => ((donnees && donnees.typesIntervention) || INTERVENTIONS_DEFAUT).filter((t) => !['Évènement', 'Réforme', 'Remise en service'].includes(t));
  /** Appareil utilisable : ni archivé ni réformé. Un appareil réformé disparaît de tous les listings. */
  const enService = (f) => !f.archive && f.statut !== 'Réformé';
  const MOTIFS_REFORME = ['Hors d\'usage / irréparable', 'Réparation trop coûteuse', 'Obsolète / fin de support fabricant', 'Remplacé par un nouvel appareil', 'Perdu ou volé', 'Autre'];
  /** « Scope Corpuls3 n° 2 » : type, modèle puis n° interne SMUR. */
  const nomAppareil = (f) => [f.type || 'Matériel', f.modele, f.numInterne && `n° ${f.numInterne}`].filter(Boolean).join(' ');

  // ---------- Photos ----------
  // Gardées sur l'appareil (IndexedDB) pour l'affichage hors ligne ; téléchargées une fois depuis le serveur.
  const PHOTO_MAX = 1500000; // caractères base64 acceptés par le serveur
  const base = (() => {
    let ouverture = null;
    return () => {
      if (!ouverture) {
        ouverture = new Promise((ok, ko) => {
          const r = indexedDB.open('avismur-materiel', 1);
          r.onupgradeneeded = () => r.result.createObjectStore('photos');
          r.onsuccess = () => ok(r.result);
          r.onerror = () => ko(r.error);
        });
      }
      return ouverture;
    };
  })();
  async function photoLocale(cle, valeur) {
    try {
      const db = await base();
      return await new Promise((ok) => {
        const t = db.transaction('photos', valeur === undefined ? 'readonly' : 'readwrite').objectStore('photos');
        const r = valeur === undefined ? t.get(cle) : t.put(valeur, cle);
        r.onsuccess = () => ok(valeur === undefined ? r.result || '' : valeur);
        r.onerror = () => ok('');
      });
    } catch (e) { return ''; }
  }
  const telechargements = new Map();
  /** Image d'un appareil : photo en attente d'envoi, sinon copie locale, sinon téléchargée. */
  async function imageDe(f) {
    if (f.photoDonnees) return f.photoDonnees;
    if (!f.photo) return f.photoModele || f.photoModeleDonnees ? imageDe({ photo: f.photoModele, photoDonnees: f.photoModeleDonnees }) : '';
    const locale = await photoLocale(f.photo);
    if (locale) return locale;
    if (!telechargements.has(f.photo)) {
      telechargements.set(f.photo, (async () => {
        try {
          const rep = await outils.appeler('photo', { id: f.photo });
          if (!rep.ok || !rep.photo) return '';
          await photoLocale(f.photo, rep.photo);
          return rep.photo;
        } catch (e) { return ''; } finally { telechargements.delete(f.photo); }
      })());
    }
    return telechargements.get(f.photo);
  }
  /** Photo propre à l'appareil, sinon celle de sa fiche type. */
  const aPhoto = (f) => Boolean(f.photo || f.photoDonnees || f.photoModele || f.photoModeleDonnees);
  /** <img> rempli dès que la photo est disponible (vide et masqué sinon). */
  function vignette(f, classe) {
    const img = el('img', { classe, alt: `Photo : ${nomAppareil(f)}`, hidden: true, loading: 'lazy' });
    imageDe(f).then((src) => { if (src) { img.src = src; img.hidden = false; } });
    return img;
  }
  /** Photo recadrée (outil commun), réduite à 1024 px et compressée (JPEG) ; null si annulée. */
  const reduirePhoto = (source, cote = 1024) => Recadrage.photo(source, { cote, max: PHOTO_MAX, qualites: [0.7, 0.55, 0.45] });

  // ---------- Données : cache + modifications en attente ----------
  function lireCache() {
    try { return JSON.parse(localStorage.getItem(CLE_CACHE)); } catch (e) { return null; }
  }
  function ecrireCache(d) {
    try { localStorage.setItem(CLE_CACHE, JSON.stringify(d)); } catch (e) { /* mémoire pleine : tant pis pour le cache */ }
  }
  const enAttente = () => (outils.lireFile ? outils.lireFile() : []).filter((e) => ACTIONS.includes(e.action));

  /** État affiché = données du serveur + modifications pas encore envoyées, dans l'ordre de saisie. */
  function etat() {
    const parId = new Map(((donnees && donnees.materiel) || []).map((f) => [f.id, { ...f }]));
    const modeles = new Map(((donnees && donnees.modeles) || []).map((m) => [m.id, { ...m }]));
    let interventions = ((donnees && donnees.interventions) || []).map((i) => ({ ...i }));
    const attente = new Set();
    const modelesAttente = new Set();
    enAttente().forEach((e) => {
      const d = e.donnees || {};
      if (e.action === 'enregistrerMateriel') {
        (d.fiches || []).forEach((f) => {
          const avant = parId.get(f.id);
          const description = avant ? decrire(resoudre(avant, modeles), resoudre({ ...avant, ...f }, modeles), modeles) : 'Fiche créée';
          if (description) {
            interventions.push({
              id: `${e.id}-${f.id}`, materiel: f.id, date: (e.date || new Date().toISOString()).slice(0, 10),
              type: avant ? 'Modification' : 'Création', description, attente: true, auto: true,
            });
          }
          parId.set(f.id, { ...avant, ...f });
          attente.add(f.id);
        });
      } else if (e.action === 'enregistrerModeles') {
        (d.modeles || []).forEach((m) => { modeles.set(m.id, { ...modeles.get(m.id), ...m }); modelesAttente.add(m.id); });
        const premier = (d.modeles || [])[0];
        (d.rattacher || []).forEach((id) => { if (premier && parId.has(id)) { parId.get(id).modeleType = premier.id; attente.add(id); } });
        (d.detacher || []).forEach((id) => { if (parId.has(id)) { parId.get(id).modeleType = ''; attente.add(id); } });
      } else if (e.action === 'ajouterIntervention') {
        (d.materiels || []).forEach((id, n) => {
          interventions.push({
            id: `${e.id}-${n}`, materiel: id, date: d.date, type: d.type, description: d.description, intervenant: d.intervenant,
            prochaineRevision: d.prochaineRevision, evenement: d.evenement || '', saisiPar: e.agent || '', attente: true, idFile: e.id,
          });
          if (d.prochaineRevision && parId.has(id)) {
            const f = resoudre(parId.get(id), modeles);
            const plan = d.maintenance ? f.plans.find((p) => p.id === d.maintenance) : (f.plans.length === 1 ? f.plans[0] : null);
            const plans = f.plans.map((p) => ({ ...p }));
            if (plan) plans.find((p) => p.id === plan.id).prochaine = d.prochaineRevision;
            else if (!plans.length) plans.push({ id: 'rev', libelle: 'Révision', periodicite: '', prochaine: d.prochaineRevision });
            parId.get(id).plans = plans;
            interventions[interventions.length - 1].maintenance = plan ? plan.libelle : '';
          }
          attente.add(id);
        });
      } else if (e.action === 'realiserMaintenance') {
        // Maintenance à cycle fixe faite par un agent : main courante, prochaine échéance et statut affichés tout de suite, même hors ligne.
        (d.controles || []).forEach((c, n) => {
          const f0 = parId.get(c.materiel);
          interventions.push({
            id: `${e.id}-${n}`, materiel: c.materiel, date: d.date, type: 'Contrôle', maintenance: d.libelle || '', prochaineRevision: c.prochaine,
            description: texteControle(c, d.observation), saisiPar: e.agent || '', attente: true, idFile: e.id,
          });
          if (!f0) return;
          const f = resoudre(f0, modeles);
          const plans = f.plans.map((p) => ({ ...p }));
          const plan = plans.find((p) => p.id === c.plan);
          if (plan && c.prochaine) plan.prochaine = c.prochaine;
          f0.plans = plans;
          if (!c.conforme && c.signaler !== false && (f0.statut === 'En service' || f0.statut === 'Prêté')) f0.statut = 'En panne';
          attente.add(c.materiel);
        });
      } else if (e.action === 'definirSituationMateriel') {
        // Statut, présence, prêt, à récupérer : affichés tout de suite, même hors ligne.
        const f = parId.get(d.materiel);
        if (f) {
          const notes = appliquerSituation(f, d);
          if (notes.length) {
            interventions.push({ id: `${e.id}-0`, materiel: d.materiel, date: d.date || aujourdhui(), type: 'Situation', description: notes.join('\n'), saisiPar: e.agent || '', attente: true, idFile: e.id });
            attente.add(f.id);
          }
        }
      } else if (e.action === 'signalerMateriel') {
        // Action rapide (scan) : entrée de main courante et statut affichés tout de suite, même hors ligne.
        const f = parId.get(d.materiel);
        interventions.push({
          id: `${e.id}-0`, materiel: d.materiel, date: d.date, type: d.type, description: d.description,
          intervenant: d.destination || '', photoDonnees: d.photoDonnees || '', saisiPar: e.agent || '', attente: true, idFile: e.id,
        });
        if (f && d.statut === 'En maintenance' && f.statut !== 'Réformé' && !f.archive) f.statut = 'En maintenance';
        if (f && d.statut === 'En panne' && (f.statut === 'En service' || f.statut === 'Prêté')) f.statut = 'En panne';
        if (f) attente.add(f.id);
      } else if (e.action === 'avancerSuiviBiomed') {
        // Bouton d'une information de panne (mur) : étape consignée et statut changés tout de suite, même hors ligne.
        const f = parId.get(d.materiel);
        if (f) {
          const envoi = d.etape === 'envoye';
          const nouveau = envoi ? 'En maintenance' : (f.pret ? 'Prêté' : 'En service');
          const change = envoi ? (f.statut !== 'Réformé' && !f.archive && f.statut !== 'En maintenance')
            : (f.statut === 'En maintenance' || f.statut === 'En panne');
          interventions.push({
            id: `${e.id}-0`, materiel: d.materiel, date: aujourdhui(), type: envoi ? 'Envoi en maintenance' : 'Remise en service',
            description: [envoi ? 'Envoyé au service biomédical.' : 'Récupéré du service biomédical.',
              !envoi && d.observation ? `Observation : ${d.observation}` : '', change ? `Statut : ${f.statut} → ${nouveau}` : ''].filter(Boolean).join('\n'),
            intervenant: 'Service biomédical', saisiPar: e.agent || '', attente: true, idFile: e.id,
          });
          if (change) f.statut = nouveau;
          attente.add(f.id);
        }
      } else if (e.action === 'enregistrerPret' && d.pret) {
        // Matériel de prêt : sa fiche apparaît (ou se met à jour) dans le suivi du matériel, même hors ligne.
        const p = d.pret;
        const cle = (v) => normaliser(v).replace(/[^A-Z0-9]/g, '');
        const f = [...parId.values()].find((x) => x.idPret === p.id)
          || [...parId.values()].find((x) => x.proprietaire && x.statut !== 'Réformé' && ((p.numBiomed && cle(x.numBiomed) === cle(p.numBiomed)) || (p.numSerie && cle(x.numSerie) === cle(p.numSerie))));
        const champs = { type: p.type, modele: p.modele, numBiomed: p.numBiomed, numSerie: p.numSerie, biomed: p.biomed !== false, pret: p.reference, proprietaire: p.proprietaire, idPret: p.id, archive: false };
        if (f) parId.set(f.id, { ...f, ...champs });
        if (f && p.amenerBiomed && f.idPret !== p.id) parId.get(f.id).statut = 'En maintenance';
        else if (!f) parId.set(`pret-${p.id}`, { id: `pret-${p.id}`, statut: p.amenerBiomed ? 'En maintenance' : 'En service', maintenance: true, plans: [], provisoire: true, ...champs });
        attente.add(f ? f.id : `pret-${p.id}`);
      } else if (e.action === 'rendrePret') {
        const f = [...parId.values()].find((x) => x.idPret === d.id);
        if (f) { parId.set(f.id, { ...f, pret: '', archive: true }); attente.add(f.id); }
      } else if (e.action === 'supprimerIntervention') {
        interventions = interventions.filter((i) => i.id !== d.intervention);
      } else if (e.action === 'supprimerMateriel') {
        // Appareil supprimé : disparaît tout de suite de la liste, même hors ligne.
        const ids = new Set(d.materiels || []);
        ids.forEach((id) => { parId.delete(id); attente.delete(id); });
        interventions = interventions.filter((i) => !ids.has(i.materiel));
      }
    });
    const fichesResolues = [...parId.values()].map((f) => resoudre(f, modeles));
    return { fiches: fichesResolues, modeles: [...modeles.values()], interventions, attente, modelesAttente };
  }
  /** Texte de main courante d'un contrôle de maintenance (mêmes mots que le serveur). */
  const texteControle = (c, commune) => c.details || [c.conforme ? 'Maintenance faite : conforme.' : 'Maintenance faite : anomalie constatée.', c.conforme ? '' : c.observation, commune || ''].filter(Boolean).join('\n');
  /** Appareil rattaché à une fiche type : type, modèle, périodicité (et photo par défaut) viennent de la fiche type. */
  function resoudre(f, modeles) {
    const m = f.modeleType && modeles.get(f.modeleType);
    const r = { ...f, modeleType: f.modeleType || '' };
    r.plans = plansDe(r);
    if (m) {
      const dates = new Map(r.plans.map((p) => [p.id, p.prochaine]));
      COMMUNS.forEach((k) => { r[k] = m[k]; });
      r.plans = plansDe(m).map((p) => ({ id: p.id, libelle: p.libelle, periodicite: p.periodicite, unite: p.unite || 'mois', cycle: p.cycle, prochaine: dates.get(p.id) || '' }));
      r.evenements = (m.evenements || []).map((v) => ({ ...v }));
      r.photoModele = m.photo || '';
      r.photoModeleDonnees = m.photoDonnees || '';
    }
    return options(r);
  }
  /** Valeurs par défaut (biomed et maintenance oui, logiciel non) et effacement des champs sans objet. */
  function options(f) {
    f.biomed = f.biomed !== false;
    f.maintenance = f.maintenance !== false;
    f.logiciel = f.logiciel === true;
    if (!f.biomed) f.numBiomed = '';
    if (!f.maintenance) f.plans = [];
    if (!f.logiciel) f.versionLogiciel = '';
    // Échéance la plus proche (tri, recherche) ; l'état d'alerte regarde chaque plan.
    const dates = (f.plans || []).filter((p) => p.prochaine).sort((a, b) => a.prochaine.localeCompare(b.prochaine));
    f.revision = dates.length ? dates[0].prochaine : '';
    return f;
  }
  /** Plans d'une fiche ; ancienne fiche (révision / périodicité uniques) : un plan « Révision ». */
  function plansDe(f) {
    if (Array.isArray(f.plans)) return f.plans.map((p) => ({ ...p }));
    if (!f.revision && !f.periodicite) return [];
    return [{ id: 'rev', libelle: 'Révision', periodicite: f.periodicite || '', prochaine: f.revision || '' }];
  }
  const idPlan = () => idFiche().slice(0, 8);
  const resumePlans = (plans) => (plans || []).map((p) => `${p.libelle}${p.periodicite ? ` (${courtePeriode(p)})` : ''}`).join(', ');
  /** Changements des plans pour la main courante (comme le serveur). */
  function decrirePlans(avant, apres) {
    const lignes = [];
    const parId = new Map((avant || []).map((p) => [p.id, p]));
    const perio = (p) => textePeriode(p) || 'sans périodicité';
    (apres || []).forEach((p) => {
      const a = parId.get(p.id);
      parId.delete(p.id);
      if (!a) { lignes.push(`Maintenance ajoutée : ${p.libelle} (${perio(p)}${p.prochaine ? `, prochaine le ${dateFr(p.prochaine)}` : ''})`); return; }
      if (a.libelle !== p.libelle) lignes.push(`Maintenance « ${a.libelle} » renommée « ${p.libelle} »`);
      if (perio(a) !== perio(p)) lignes.push(`Maintenance « ${p.libelle} » : ${perio(a)} → ${perio(p)}`);
      if (String(a.prochaine || '') !== String(p.prochaine || '')) lignes.push(`Maintenance « ${p.libelle} » : prochaine échéance ${a.prochaine ? dateFr(a.prochaine) : '—'} → ${p.prochaine ? dateFr(p.prochaine) : '—'}`);
    });
    parId.forEach((p) => lignes.push(`Maintenance retirée : ${p.libelle}`));
    return lignes;
  }
  /** Changements entre deux états d'une fiche, pour la main courante (comme le serveur). */
  function decrire(a, n, modelesMap) {
    const val = (k, v) => {
      if (k === 'modeleType') return v ? nomModele(modelesMap.get(v)) : 'aucun (matériel unique)';
      if (BOOLEENS.includes(k)) return v ? 'oui' : 'non';
      if (k === 'revision' && v) return dateFr(v);
      return v === '' || v === undefined || v === null ? '—' : String(v);
    };
    return [...decrirePlans(a.plans, n.plans), ...Object.keys(LIBELLES).map((k) => {
      if (k === 'photo') return `${a.photo || ''}|${a.photoDonnees || ''}` !== `${n.photo || ''}|${n.photoDonnees || ''}` ? 'Photo modifiée' : '';
      const va = BOOLEENS.includes(k) ? Boolean(a[k]) : String(a[k] ?? '');
      const vn = BOOLEENS.includes(k) ? Boolean(n[k]) : String(n[k] ?? '');
      return va === vn ? '' : `${LIBELLES[k]} : ${val(k, a[k])} → ${val(k, n[k])}`;
    })].filter(Boolean).join('\n');
  }
  const modeles = () => etat().modeles;
  const modeleDe = (id) => modeles().find((m) => m.id === id) || null;
  const nomModele = (m) => (m ? `${m.type} > ${m.modele}` : 'Matériel unique');
  const fiches = () => etat().fiches;

  let chargementPromesse = null;
  function charger() {
    if (!chargementPromesse) chargementPromesse = chargerServeur().finally(() => { chargementPromesse = null; });
    return chargementPromesse;
  }
  async function chargerServeur() {
    if (!outils.appeler) return;
    chargementEnCours = true;
    try {
      const rep = await outils.appeler('lireMateriel');
      if (rep.ok) {
        donnees = rep;
        ecrireCache(rep);
        erreur = '';
      } else erreur = rep.erreur || 'Lecture du matériel refusée.';
    } catch (e) {
      erreur = donnees ? '' : 'Hors ligne : pas encore de liste du matériel sur cet appareil.';
    } finally {
      chargementEnCours = false;
    }
    if (zone && !zone.hidden) rendre();
    document.dispatchEvent(new CustomEvent('avismur-materiel')); // l'accueil relit les rappels de maintenance
  }

  /**
   * Rappels de l'accueil : maintenances à cycle fixe (« premier lundi du mois »…) à faire aujourd'hui ou en retard,
   * regroupées par maintenance et par modèle. Calculé sur la liste gardée sur l'appareil (fonctionne hors ligne).
   */
  function rappelsMaintenance() {
    const jour = aujourdhui();
    const groupes = new Map();
    // Seuls les appareils présents dans les locaux sont concernés : « En service » (ni en panne, ni en maintenance, ni prêté)
    // et, si le cycle indique des lieux, dernier contenant pointé dans l'un d'eux.
    const present = (f, c) => {
      if (f.statut !== 'En service') return false;
      const lieux = String(c.lieux || '').split(',').map((l) => normaliser(l.trim())).filter(Boolean);
      return !lieux.length || lieux.some((l) => normaliser(f.emplacement || '').includes(l));
    };
    fiches().filter((f) => enService(f) && !f.provisoire && f.maintenance !== false).forEach((f) => {
      (f.plans || []).filter((p) => p.cycle && p.prochaine && p.prochaine <= jour && present(f, p.cycle)).forEach((p) => {
        const cle = `${p.id}|${f.type}|${f.modele}`;
        if (!groupes.has(cle)) groupes.set(cle, { cle, planId: p.id, libelle: p.libelle, cycle: texteCycle(p.cycle), appareil: [f.type, f.modele].filter(Boolean).join(' ') || 'Matériel', ids: [], numeros: [], depuis: p.prochaine });
        const g = groupes.get(cle);
        g.ids.push(f.id);
        g.numeros.push(f.numInterne || '?');
        if (p.prochaine < g.depuis) g.depuis = p.prochaine;
      });
    });
    // Contrôle semestriel des appareils à glycémie : rappel dès l'échéance (ou s'il n'a jamais été fait), jusqu'à ce qu'il soit enregistré.
    const { interventions } = etat();
    fiches().filter((f) => enService(f) && !f.provisoire && f.statut === 'En service' && estGlycemie(f)).forEach((f) => {
      const e = echeanceGlycemie(f, interventions);
      if (!e.retard) return;
      const cle = `glycemie|${f.type}|${f.modele}`;
      if (!groupes.has(cle)) groupes.set(cle, { cle, glycemie: true, planId: '', libelle: LIBELLE_GLYCEMIE, cycle: `tous les ${MOIS_GLYCEMIE} mois`, appareil: [f.type, f.modele].filter(Boolean).join(' ') || 'Appareil glycémie', ids: [], numeros: [], depuis: e.prochaine || jour });
      const g = groupes.get(cle);
      g.ids.push(f.id);
      g.numeros.push(f.numInterne || '?');
      if ((e.prochaine || jour) < g.depuis) g.depuis = e.prochaine || jour;
    });
    return [...groupes.values()].map((g) => ({ ...g, retard: g.depuis < jour }))
      .sort((a, b) => a.depuis.localeCompare(b.depuis) || a.appareil.localeCompare(b.appareil, 'fr'));
  }

  /** Suppression définitive (administrateurs), après confirmation. Renvoie vrai si confirmée. */
  function supprimerAppareils(liste) {
    if (!liste.length) return false;
    const noms = liste.slice(0, 8).map((f) => `• ${nomAppareil(f)}`).join('\n') + (liste.length > 8 ? `\n… et ${liste.length - 8} autre(s)` : '');
    const question = `Supprimer définitivement ${liste.length > 1 ? `ces ${liste.length} appareils` : 'cet appareil'} ?\n\n${noms}\n\n`
      + 'La fiche et sa main courante disparaîtront de l\'application. Pour garder l\'historique d\'un appareil réformé, utilisez plutôt « Archiver ».';
    if (!window.confirm(question)) return false;
    liste.forEach((f) => { selection.delete(f.id); deplies.delete(f.id); });
    enfiler('supprimerMateriel', { materiels: liste.map((f) => f.id) });
    return true;
  }

  function enfiler(action, charge) {
    const agent = '';
    const ok = outils.mettreEnFile({ action, donnees: charge, agent });
    rendre();
    document.dispatchEvent(new CustomEvent('avismur-materiel'));
    return ok;
  }

  // ---------- Révision : état ----------
  function etatPlan(p) {
    if (!p.prochaine) return { classe: 'neutre', texte: `${p.libelle} : échéance non renseignée`, rang: 1 };
    const jours = Math.round((new Date(p.prochaine) - new Date(aujourdhui())) / 86400000);
    if (jours < 0) return { classe: 'retard', texte: `${p.libelle} dépassée (${dateFr(p.prochaine)})`, retard: true, rang: 3 };
    if (jours <= ALERTE_JOURS) return { classe: 'bientot', texte: `${p.libelle} le ${dateFr(p.prochaine)} (J-${jours})`, bientot: true, rang: 2 };
    return { classe: 'ok', texte: `${p.libelle} le ${dateFr(p.prochaine)}`, rang: 0 };
  }
  /** État le plus urgent parmi les plans de maintenance de l'appareil. */
  function etatRevision(f) {
    if (f.statut === 'Réformé' || f.archive) return { classe: 'neutre', texte: f.archive ? 'Archivé' : 'Réformé' };
    if (f.maintenance === false) return { classe: 'neutre', texte: 'Sans maintenance préventive' };
    const plans = f.plans || [];
    if (!plans.length) return { classe: 'neutre', texte: 'Aucune maintenance définie' };
    const etats = plans.map(etatPlan);
    const pire = etats.reduce((a, b) => (b.rang > a.rang || (b.rang === a.rang && b.rang !== 1 && plans[etats.indexOf(b)].prochaine < plans[etats.indexOf(a)].prochaine) ? b : a));
    const autres = etats.filter((x) => x.retard || x.bientot).length - (pire.retard || pire.bientot ? 1 : 0);
    return { ...pire, texte: `${pire.texte}${autres > 0 ? ` (+${autres})` : ''}` };
  }

  /**
   * Éditeur de plans de maintenance. `avecDate` : échéance par plan (appareil) ; `verrouille` : libellés et
   * périodicités imposés par le matériel type (seules les échéances se modifient).
   */
  function editeurPlans(depart, { avecDate = true, verrouille = false, actif = true } = {}) {
    let plans = (depart || []).map((p) => ({ ...p }));
    let bloque = verrouille;
    const liste = el('div', { classe: 'mat-plans' });
    const ajout = el('button', { type: 'button', classe: 'cfg-mini', texte: '+ Ajouter une maintenance', surclick: () => { plans.push({ id: idPlan(), libelle: '', periodicite: 12, unite: 'mois', prochaine: '' }); rendrePlans(); liste.querySelector('.mat-plan:last-child input')?.focus(); } });
    /** Cycle choisi : l'échéance vide ou passée est proposée d'après le calendrier. */
    function majCycle(p) {
      if (avecDate && p.cycle && (!p.prochaine || p.prochaine < aujourdhui())) p.prochaine = prochaineCycle(aujourdhui(), p.cycle, '');
    }
    function champsPeriodicite(p) {
      const off = bloque || !actif;
      const choix = (libelle, options, courant, appliquer) => el('select', {
        'aria-label': libelle, disabled: off,
        surchange: (ev) => { appliquer(ev.target.value); majCycle(p); rendrePlans(); },
      }, options.map(([v, t]) => el('option', { value: String(v), texte: t, selected: String(v) === String(courant) })));
      const nombre = (libelle, valeur, min, max, appliquer) => el('input', {
        type: 'number', min: String(min), max: String(max), valeur, 'aria-label': libelle, disabled: off,
        surchange: (ev) => { appliquer(Math.min(max, Math.max(min, Number(ev.target.value) || min))); majCycle(p); rendrePlans(); },
      });
      const unite = el('select', {
        'aria-label': 'Unité', disabled: off,
        surchange: (ev) => {
          const v = ev.target.value;
          if (v === 'cycle') { p.cycle = { mode: 'rang', jour: 1, rang: 1, pas: 1 }; p.periodicite = ''; majCycle(p); } else { delete p.cycle; p.unite = v; p.periodicite = p.periodicite || (v === 'semaine' ? 1 : 12); }
          rendrePlans();
        },
      },
      el('option', { value: 'mois', texte: 'mois', selected: !p.cycle && p.unite !== 'semaine' }),
      el('option', { value: 'semaine', texte: 'semaine(s)', selected: !p.cycle && p.unite === 'semaine' }),
      el('option', { value: 'cycle', texte: 'cycle fixe (calendrier)', selected: Boolean(p.cycle) }));
      if (!p.cycle) {
        return el('div', { classe: 'mat-periode' },
          el('input', { type: 'number', min: '1', max: p.unite === 'semaine' ? '260' : '120', valeur: p.periodicite, 'aria-label': 'Nombre', disabled: off, surinput: (ev) => { p.periodicite = Number(ev.target.value) || ''; } }),
          unite);
      }
      const c = p.cycle;
      const jours = JOURS.map((t, n) => [n + 1, t]);
      const type = choix('Type de cycle', [['semaine', 'Un jour de la semaine'], ['rang', 'Un jour de semaine du mois'], ['jourMois', 'Un jour fixe du mois']], c.mode, (v) => {
        c.mode = v; c.jour = 1; c.pas = 1; if (v === 'rang') c.rang = 1; else delete c.rang;
      });
      const detail = c.mode === 'semaine'
        ? [choix('Jour', jours, c.jour, (v) => { c.jour = Number(v); }), el('span', { texte: 'toutes les' }), nombre('Nombre de semaines', c.pas, 1, 52, (v) => { c.pas = v; }), el('span', { texte: 'sem.' })]
        : c.mode === 'rang'
          ? [choix('Rang', Object.entries(RANGS), c.rang, (v) => { c.rang = Number(v); }), choix('Jour', jours, c.jour, (v) => { c.jour = Number(v); }), el('span', { texte: 'tous les' }), nombre('Nombre de mois', c.pas, 1, 12, (v) => { c.pas = v; }), el('span', { texte: 'mois' })]
          : [el('span', { texte: 'le' }), nombre('Jour du mois', c.jour, 1, 31, (v) => { c.jour = v; }), el('span', { texte: 'tous les' }), nombre('Nombre de mois', c.pas, 1, 12, (v) => { c.pas = v; }), el('span', { texte: 'mois' })];
      const lieux = el('input', {
        type: 'text', maxlength: '120', valeur: c.lieux || '', placeholder: 'Lieux concernés, ex. Réserve, Pharmacie (vide : tous les appareils en service)', 'aria-label': 'Lieux concernés',
        classe: 'mat-cycle-lieux', disabled: off, surchange: (ev) => { c.lieux = ev.target.value.trim(); },
      });
      return el('div', { classe: 'mat-periode mat-cycle' }, unite, type, ...detail, lieux,
        el('small', { classe: 'mat-cycle-texte', texte: `${texteCycle(c).replace(/^./, (x) => x.toUpperCase())}. L'échéance se recale sur le calendrier à chaque maintenance faite${c.mode !== 'jourMois' && c.pas > 1 ? ' ; la prochaine échéance saisie donne la phase du cycle' : ''}.` }));
    }
    function rendrePlans() {
      ajout.hidden = bloque || !actif;
      liste.replaceChildren(...(plans.length ? plans.map((p, n) => el('div', { classe: 'mat-plan mat-grille' },
        champ('Maintenance', el('input', { valeur: p.libelle, placeholder: 'ex. Révision annuelle, Contrôle électrique…', disabled: bloque || !actif, surinput: (ev) => { p.libelle = ev.target.value; } })),
        champ('Périodicité', champsPeriodicite(p)),
        avecDate ? champ('Prochaine échéance', el('input', { type: 'date', valeur: p.prochaine || '', disabled: !actif, surinput: (ev) => { p.prochaine = ev.target.value; } })) : null,
        bloque || !actif ? null : el('button', { type: 'button', classe: 'cfg-mini danger', texte: 'Retirer', 'aria-label': `Retirer la maintenance ${p.libelle}`, surclick: () => { plans.splice(n, 1); rendrePlans(); } })))
        : [el('p', { classe: 'mat-vide', texte: bloque ? 'Le matériel type ne définit aucune maintenance.' : 'Aucune maintenance : ajoutez-en une (révision, contrôle, changement de pièce…).' })]));
    }
    rendrePlans();
    return {
      bloc: el('div', {}, liste, el('div', { classe: 'mat-boutons' }, ajout)),
      valeur: () => plans.map((p) => ({ ...p, libelle: String(p.libelle || '').trim() })).filter((p) => p.libelle),
      /** Plans imposés par un matériel type (échéances conservées par identifiant), ou retour à des plans libres. */
      imposer(plansModele) {
        if (plansModele) {
          const dates = new Map(plans.map((p) => [p.id, p.prochaine]));
          plans = plansModele.map((p) => ({ id: p.id, libelle: p.libelle, periodicite: p.periodicite, unite: p.unite || 'mois', cycle: p.cycle, prochaine: dates.get(p.id) || '' }));
          bloque = true;
        } else bloque = false;
        rendrePlans();
      },
    };
  }

  // ---------- Liste ----------
  function filtrees(liste) {
    const t = normaliser(filtre.texte);
    return liste.filter((f) => {
      if (filtre.statut !== 'archives' && !enService(f)) return false;
      if (filtre.statut === 'archives' && !f.archive && f.statut !== 'Réformé') return false;
      if (filtre.statut === 'prets' && !f.pret) return false;
      if (filtre.statut === 'parti' && f.presence !== 'Parti') return false;
      if (filtre.statut === 'pretes' && !f.pretA) return false;
      if (filtre.statut === 'recuperer' && !f.aRecuperer) return false;
      if (filtre.statut && !['actifs', 'archives', 'tous', 'prets', 'parti', 'pretes', 'recuperer'].includes(filtre.statut) && f.statut !== filtre.statut) return false;
      if (filtre.type && f.type !== filtre.type) return false;
      if (filtre.alerte === 'retard' && !etatRevision(f).retard) return false;
      if (filtre.alerte === 'bientot' && !etatRevision(f).bientot) return false;
      if (filtre.alerte === 'traceur' && !f.traceur) return false;
      if (t) {
        const botte = normaliser([f.type, f.modele, f.numInterne, f.numBiomed, f.numSerie, f.nomTraceur, f.remarques, f.versionLogiciel, f.emplacement, f.pret, f.proprietaire, f.pret && 'pret', ...(f.autresCodes || [])].join(' '));
        if (!t.split(/\s+/).every((mot) => botte.includes(mot))) return false;
      }
      return true;
    });
  }

  function tri(a, b) {
    const ta = types().indexOf(a.type);
    const tb = types().indexOf(b.type);
    if (ta !== tb) return ta - tb;
    const na = Number(a.numInterne);
    const nb = Number(b.numInterne);
    if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
    return String(a.numInterne).localeCompare(String(b.numInterne), 'fr', { numeric: true });
  }

  function rendre() {
    if (!zone) return;
    if (onglet === 'prets') { rendrePrets(); return; }
    if (onglet === 'monnal') { rendreMonnal(); return; }
    if (onglet === 'glycemie') { rendreGlycemie(); return; }
    const { fiches: toutes, attente } = etat();
    const actives = toutes.filter(enService);
    const nbRetard = actives.filter((f) => etatRevision(f).retard).length;
    const nbBientot = actives.filter((f) => etatRevision(f).bientot).length;
    const nbPanne = actives.filter((f) => f.statut === 'En panne' || f.statut === 'En maintenance').length;
    // Sélection : on oublie les appareils qui n'existent plus.
    [...selection].forEach((id) => { if (!toutes.some((f) => f.id === id)) selection.delete(id); });

    const compteurBouton = (nombre, libelle, classe, action, actif) => el('button', {
      type: 'button', classe: `mat-compteur ${classe}${actif ? ' actif' : ''}`, 'aria-pressed': String(Boolean(actif)), surclick: action,
    }, el('strong', { texte: String(nombre) }), el('span', { texte: libelle }));

    const bascule = (cle, valeur) => () => { filtre = { ...filtre, [cle]: filtre[cle] === valeur ? '' : valeur }; rendre(); };

    const entete = el('div', { classe: 'mat-entete' },
      el('h1', { texte: 'Suivi du matériel' }),
      estAdmin() ? el('button', { type: 'button', classe: 'principal mat-nouveau', texte: '+ Nouveau', title: 'Nouveau matériel', surclick: () => ouvrirFiche(null, true) }) : null,
      el('div', { classe: 'mat-boutons mat-boutons-secondaires' },
        estAdmin() ? el('button', { type: 'button', classe: 'cfg-mini', texte: 'Statuts', surclick: ouvrirStatuts }) : null,
        estAdmin() ? el('button', { type: 'button', classe: 'cfg-mini', texte: 'Associer des codes', title: 'Rattacher un code-barres ou un QR code supplémentaire à un appareil', surclick: ouvrirAssocierCodes }) : null,
        el('button', { type: 'button', classe: 'cfg-mini', texte: `Matériels types (${modeles().filter((m) => !m.archive).length})`, surclick: ouvrirModeles }),
        'NDEFReader' in window ? el('button', { type: 'button', classe: 'cfg-mini', texte: 'Lire une puce NFC', surclick: lireNfc }) : null));

    const compteurs = el('div', { classe: 'mat-compteurs' },
      compteurBouton(actives.length, 'appareils en service', 'total', () => { filtre = { texte: '', type: '', statut: 'actifs', alerte: '' }; rendre(); }, !filtre.alerte && !filtre.type && !filtre.texte),
      compteurBouton(nbRetard, 'maintenances dépassées', 'retard', bascule('alerte', 'retard'), filtre.alerte === 'retard'),
      compteurBouton(nbBientot, `maintenances sous ${ALERTE_JOURS} j`, 'bientot', bascule('alerte', 'bientot'), filtre.alerte === 'bientot'),
      compteurBouton(nbPanne, 'en panne / maintenance', 'panne', () => { filtre = { ...filtre, statut: filtre.statut === 'En panne' ? 'actifs' : 'En panne', alerte: '' }; rendre(); }, filtre.statut === 'En panne'));

    const idRecherche = nouvelId();
    const recherche = el('input', {
      id: idRecherche, type: 'search', valeur: filtre.texte, placeholder: 'N° interne, biomed, série, modèle…',
      surinput: (e) => { filtre.texte = e.target.value; rendreListe(); },
    });
    const choixType = el('select', { 'aria-label': 'Type de matériel', surchange: (e) => { filtre.type = e.target.value; rendre(); } },
      el('option', { value: '', texte: 'Tous les types' }),
      types().map((t) => el('option', { value: t, texte: t, selected: filtre.type === t })));
    const choixStatut = el('select', { 'aria-label': 'Statut', surchange: (e) => { filtre.statut = e.target.value; rendre(); } },
      [['actifs', 'Tous les statuts actifs'], ['tous', 'Tout le matériel (hors réformés)'], ...statuts().filter((s) => s !== 'Réformé').map((s) => [s, s]), ['prets', 'Matériel de prêt (emprunté)'], ['parti', 'Hors des locaux'], ['pretes', 'Prêtés à un tiers'], ['recuperer', 'À récupérer'], ['archives', 'Réformés et archivés']]
        .map(([v, t]) => el('option', { value: v, texte: t, selected: filtre.statut === v })));
    // Recherche toujours visible ; type, statut et traceur repliés derrière « Filtres » (nombre de filtres actifs).
    const nbFiltres = [filtre.type, filtre.statut && filtre.statut !== 'actifs', filtre.alerte === 'traceur'].filter(Boolean).length;
    const panneauFiltres = el('div', { classe: 'mat-filtres-panneau', id: 'mat-filtres-panneau', hidden: !filtresOuverts },
      choixType, choixStatut,
      el('button', { type: 'button', classe: `cfg-bouton${filtre.alerte === 'traceur' ? ' inv-actif' : ''}`, texte: 'Avec traceur', 'aria-pressed': String(filtre.alerte === 'traceur'), surclick: bascule('alerte', 'traceur') }),
      nbFiltres ? el('button', { type: 'button', classe: 'lien', texte: 'Effacer les filtres', surclick: () => { filtre = { ...filtre, type: '', statut: 'actifs', alerte: filtre.alerte === 'traceur' ? '' : filtre.alerte }; rendre(); } }) : null);
    const filtres = el('div', { classe: 'mat-filtres' },
      el('label', { for: idRecherche, classe: 'invisible', texte: 'Rechercher' }), recherche,
      el('button', { type: 'button', classe: `cfg-bouton mat-bouton-filtres${filtresOuverts || nbFiltres ? ' inv-actif' : ''}`, 'aria-expanded': String(filtresOuverts), 'aria-controls': 'mat-filtres-panneau',
        texte: nbFiltres ? `Filtres (${nbFiltres})` : 'Filtres', surclick: () => { filtresOuverts = !filtresOuverts; rendre(); } }));

    const barreSelection = estAdmin() && selection.size ? el('div', { classe: 'mat-selection', role: 'region', 'aria-label': 'Sélection' },
      el('span', { texte: `${selection.size} appareil${selection.size > 1 ? 's' : ''} sélectionné${selection.size > 1 ? 's' : ''}` }),
      el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Modifier la sélection', surclick: () => ouvrirModifGroupee([...selection]) }),
      el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Ajouter une intervention', surclick: () => ouvrirIntervention([...selection]) }),
      el('button', { type: 'button', classe: 'cfg-bouton danger', texte: 'Supprimer la sélection', surclick: () => supprimerAppareils(toutes.filter((f) => selection.has(f.id))) }),
      el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Tout désélectionner', surclick: () => { selection.clear(); rendre(); } })) : null;

    const liste = el('div', { classe: 'mat-liste', id: 'mat-liste' });
    const avis = [];
    if (erreur) avis.push(el('p', { classe: 'message erreur', texte: erreur }));
    if (!donnees && chargementEnCours) avis.push(el('p', { classe: 'message', texte: 'Chargement du matériel…' }));
    if (attente.size) avis.push(el('p', { classe: 'message mat-attente-avis', texte: `${attente.size} appareil(s) modifié(s) sur cet appareil, en attente d'envoi au serveur.` }));

    zone.replaceChildren(...[ongletsMateriel(), entete, compteurs, filtres, panneauFiltres, ...avis, barreSelection, liste].filter(Boolean));
    rendreListe();
  }

  /** Seule la liste est redessinée pendant la frappe (la recherche garde le focus). */
  function rendreListe() {
    const liste = zone && zone.querySelector('#mat-liste');
    if (!liste) return;
    const { fiches: toutes, interventions, attente } = etat();
    const visibles = filtrees(toutes).sort(tri);
    if (!visibles.length) {
      liste.replaceChildren(el('p', { classe: 'mat-vide', texte: toutes.length ? 'Aucun appareil ne correspond.' : (estAdmin() ? 'Aucun matériel enregistré. Commencez par « + Nouveau matériel ».' : 'Aucun matériel enregistré pour le moment.') }));
      return;
    }
    // Un groupe par matériel type (« Type > modèle », avec sa photo en tête) ; les matériels uniques par type.
    const groupes = new Map();
    visibles.forEach((f) => {
      const cle = f.modeleType ? `t:${f.modeleType}` : `u:${f.type}`;
      if (!groupes.has(cle)) groupes.set(cle, { modele: f.modeleType ? modeleDe(f.modeleType) : null, type: f.type, membres: [] });
      groupes.get(cle).membres.push(f);
    });
    const ordre = [...groupes.values()].sort((a, b) => (types().indexOf(a.type) - types().indexOf(b.type))
      || (Number(!a.modele) - Number(!b.modele)) || String(a.modele ? a.modele.modele : '').localeCompare(String(b.modele ? b.modele.modele : ''), 'fr'));
    const blocs = [];
    ordre.forEach(({ modele, type, membres }) => {
      const nom = modele ? nomModele(modele) : (groupes.has(`u:${type}`) && [...groupes.keys()].some((k) => k.startsWith('t:') && groupes.get(k).type === type) ? `${type} (matériels uniques)` : type);
      const tousCoches = membres.every((f) => selection.has(f.id));
      blocs.push(el('section', { classe: 'mat-groupe' },
        el('h2', { classe: 'mat-groupe-titre' },
          estAdmin() ? el('input', {
            type: 'checkbox', coche: tousCoches, 'aria-label': `Sélectionner tous les ${nom}`,
            surchange: (e) => { membres.forEach((f) => (e.target.checked ? selection.add(f.id) : selection.delete(f.id))); rendre(); },
          }) : null,
          modele && (modele.photo || modele.photoDonnees) ? vignette({ ...modele, type: nom, numInterne: '' }, 'mat-vignette mat-vignette-type') : null,
          modele ? el('button', { type: 'button', classe: 'lien mat-groupe-nom', texte: nom, title: 'Ouvrir le matériel type', surclick: () => ouvrirModele(modele) }) : el('span', { texte: nom }),
          el('small', { texte: String(membres.length) })),
        el('ul', { classe: 'mat-lignes' }, membres.map((f) => ligne(f, interventions, attente)))));
    });
    liste.replaceChildren(...blocs);
  }

  // Appareils dont le détail est déplié dans la liste.
  const deplies = new Set();
  const ICONES = {
    acquitter: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/><path d="M16 19l2 2 4-4"/></svg>',
    statut: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h12l-3-3M17 17H5l3 3"/></svg>',
    note: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v12H8l-4 4z"/><path d="M12 7v4M12 13.5v.5"/></svg>',
    situation: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.2 7-11a7 7 0 0 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>',
    deplier: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
  };
  function icone(nom, libelle, action, attributs = {}) {
    const b = el('button', { type: 'button', classe: `mat-icone mat-icone-${nom}`, 'aria-label': libelle, title: libelle, surclick: (e) => { e.stopPropagation(); action(e); }, ...attributs });
    b.innerHTML = ICONES[nom];
    return b;
  }
  /** « F21 › Sac rouge · vu le 15/11/2026 » */
  const texteEmplacement = (f) => (f.emplacement ? `${f.emplacement}${f.vuLe ? ` · vu le ${dateFr(f.vuLe.slice(0, 10))}` : ''}` : '');
  /** Maintenance à acquitter en priorité : la plus urgente (dépassée, puis la plus proche). */
  function planPrioritaire(f) {
    const plans = (f.plans || []).slice();
    if (!plans.length) return null;
    return plans.sort((a, b) => (etatPlan(b).rang - etatPlan(a).rang) || String(a.prochaine || '9999').localeCompare(String(b.prochaine || '9999')))[0];
  }

  function ligne(f, interventions, attente) {
    const rev = etatRevision(f);
    const historique = interventions.filter((i) => i.materiel === f.id).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const derniere = historique[0];
    const ouvert = deplies.has(f.id);
    const admin = estAdmin();
    const actif = !f.archive && f.statut !== 'Réformé' && !f.provisoire;
    const actions = el('span', { classe: 'mat-actions' },
      admin && actif && f.maintenance !== false && (f.plans || []).length
        ? icone('acquitter', `Acquitter une maintenance : ${nomAppareil(f)}`, () => { const p = planPrioritaire(f); ouvrirIntervention([f.id], { type: 'Révision', plan: p && p.id }); }) : null,
      actif ? icone('situation', `Situation (présence, prêt, à récupérer) : ${nomAppareil(f)}`, () => ouvrirSituation(f)) : null,
      admin && actif && !f.provisoire ? icone('statut', `Changer le statut : ${nomAppareil(f)}`, () => ouvrirStatut(f)) : null,
      admin && actif ? icone('note', `Évènement ou note (casse, panne, problème) : ${nomAppareil(f)}`, () => ouvrirSignalement(f)) : null,
      icone('deplier', ouvert ? 'Replier le détail' : 'Déplier le détail', () => {
        if (deplies.has(f.id)) deplies.delete(f.id); else deplies.add(f.id);
        rendreListe();
      }, { 'aria-expanded': String(ouvert), classe: `mat-icone mat-icone-deplier${ouvert ? ' ouvert' : ''}` }));
    return el('li', { classe: `mat-ligne${f.pret ? ' pret' : ''}${selection.has(f.id) ? ' choisie' : ''}${ouvert ? ' depliee' : ''}` },
      admin && !f.provisoire ? el('input', {
        type: 'checkbox', classe: 'mat-case', coche: selection.has(f.id), 'aria-label': `Sélectionner ${nomAppareil(f)}`,
        surchange: (e) => { if (e.target.checked) selection.add(f.id); else selection.delete(f.id); rendre(); },
      }) : null,
      el('button', { type: 'button', classe: 'mat-ouvrir', surclick: () => (f.provisoire ? (etatPrets().ouverts.get(f.pret) && ouvrirDetailPret(etatPrets().ouverts.get(f.pret))) : ouvrirFiche(f.id)) },
        el('span', { classe: 'mat-num', texte: f.pret ? f.pret.replace(/^PR[ÊE]T\s*0?/i, 'P') : (f.numInterne || '?'), title: f.pret ? `Matériel de prêt ${f.pret}` : undefined }),
        // Photo propre à l'appareil, sinon celle de son matériel type (répercutée sur tous les appareils liés).
        aPhoto(f) ? vignette(f, 'mat-vignette') : null,
        el('span', { classe: 'mat-corps' },
          el('span', { classe: 'mat-nom' }, el('strong', { texte: nomAppareil(f) }),
            f.traceur ? el('span', { classe: 'mat-traceur', title: `Traceur GeoTraceSMUR${f.nomTraceur ? ` : ${f.nomTraceur}` : ''}`, texte: '📡' }) : null),
          f.pret ? el('span', { classe: 'mat-pret-info', texte: `Prêt ${f.pret} · ${f.proprietaire || 'propriétaire non renseigné'}` }) : null,
          // Une seule ligne condensée : n° biomed (ou série), dernier emplacement connu si l'appareil est dans les locaux.
          el('span', { classe: 'mat-ids', texte: [f.numBiomed ? `Biomed ${f.numBiomed}` : (f.numSerie ? `S/N ${f.numSerie}` : 'N° non renseigné'),
            f.emplacement && f.presence !== 'Parti' ? `📍 ${f.emplacement}${f.vuLe ? ` (${dateFr(f.vuLe.slice(0, 10)).slice(0, 5)})` : ''}` : null].filter(Boolean).join(' · '), title: texteEmplacement(f) || undefined })),
        el('span', { classe: 'mat-etats' },
          pastilleStatut(f.statut),
          ...pastillesSituation(f),
          el('span', { classe: `mat-pastille rev-${rev.classe}`, texte: rev.texte }),
          attente.has(f.id) ? el('span', { classe: 'mat-pastille attente', texte: 'En attente d\'envoi' }) : null)),
      actions,
      ouvert ? detailLigne(f, historique) : null);
  }

  const derniere0 = (h) => (h[0] ? `${(h[0].type === 'Évènement' && h[0].evenement ? h[0].evenement : h[0].type).toLowerCase()} le ${dateFr(h[0].date)}` : '');
  /** Détail déplié sous la ligne : maintenances, évènements, emplacement, numéros, dernières entrées. */
  function detailLigne(f, historique) {
    const info = (t, v) => (v ? [el('dt', { texte: t }), el('dd', { texte: v })] : null);
    const plans = f.maintenance === false ? [] : (f.plans || []);
    return el('div', { classe: 'mat-detail' },
      el('dl', { classe: 'mat-infos' },
        f.pret ? info('Matériel de prêt', `${f.pret} · ${f.proprietaire || '—'}`) : null,
        info('Matériel type', f.modeleType ? nomModele(modeleDe(f.modeleType)) : 'Matériel unique'),
        info('Dernier emplacement', texteEmplacement(f) || 'Jamais pointé dans un inventaire'),
        info('Statut', f.statut),
        info('Présence', f.presence === 'Parti' ? `Parti · ${f.lieu || '?'}` : 'Dans les locaux'),
        f.pretA ? info('Prêté à', `${f.pretA}${f.pretLe ? ` depuis le ${dateFr(f.pretLe)}` : ''}`) : null,
        f.aRecuperer ? info('À récupérer', `${f.aRecuperer}${f.aRecupererPrecision ? ` (${f.aRecupererPrecision})` : ''}${f.aRecupererDepuis ? ` depuis le ${dateFr(f.aRecupererDepuis)}` : ''}`) : null,
        derniere0(historique) ? info('Dernière entrée', derniere0(historique)) : null,
        info('N° biomed', f.biomed ? (f.numBiomed || '—') : 'Sans n° biomed'),
        info('N° de série', f.numSerie),
        f.logiciel ? info('Version logiciel', f.versionLogiciel || '—') : null,
        f.traceur ? info('Traceur', f.nomTraceur || 'Oui') : null,
        f.maintenance === false ? info('Maintenance préventive', 'Non') : null,
        plans.flatMap((p) => info(p.libelle, `${etatPlan(p).texte.slice(p.libelle.length).replace(/^ : | /, '')}${p.periodicite ? ` · ${textePeriode(p)}` : ''}`)),
        (f.evenements || []).flatMap((v) => {
          const dernier = historique.find((i) => i.type === 'Évènement' && normaliser(i.evenement) === normaliser(v.libelle));
          return info(v.libelle, dernier ? `dernier le ${dateFr(dernier.date)}` : 'jamais enregistré');
        }),
        f.remarques ? info('Remarques', f.remarques) : null),
      historique.length ? el('div', {},
        el('p', { classe: 'mat-libelle', texte: 'Dernières entrées de la main courante' }),
        el('ul', { classe: 'mat-detail-histo' }, historique.slice(0, 3).map((i) => el('li', {},
          el('strong', { texte: i.type === 'Évènement' && i.evenement ? i.evenement : i.type }),
          ` · ${dateFr(i.date)}${i.maintenance ? ` · ${i.maintenance}` : ''}${i.description ? ` — ${i.description.split('\n')[0].slice(0, 120)}` : ''}`)))) : null,
      f.provisoire ? el('p', { classe: 'aide-question', texte: 'Fiche créée à l\'envoi du prêt au serveur : maintenances et signalements possibles ensuite.' })
        : el('div', { classe: 'mat-boutons' }, el('button', { type: 'button', classe: 'cfg-mini', texte: 'Ouvrir la fiche complète', surclick: () => ouvrirFiche(f.id) })));
  }

  /** Icône « évènement ou note » : évènements ponctuels du matériel type, ou note casse / panne / problème. */
  function ouvrirSignalement(f) {
    const evts = f.evenements || [];
    let d;
    const contenu = el('div', { classe: 'mat-signalement' },
      evts.length ? el('fieldset', { classe: 'mat-cadre' }, el('legend', { texte: 'Évènement ponctuel' }),
        el('div', { classe: 'mat-boutons' }, evts.map((v) => el('button', { type: 'button', classe: 'cfg-bouton', texte: v.libelle, surclick: () => { d.close(); ouvrirEvenement(f, v, false); } })))) : null,
      el('fieldset', { classe: 'mat-cadre' }, el('legend', { texte: 'Signaler' }),
        el('div', { classe: 'mat-boutons' }, ['Casse', 'Panne', 'Problème', 'Note'].map((n) => el('button', { type: 'button', classe: 'cfg-bouton', texte: n, surclick: () => { d.close(); ouvrirNote(f, n); } })))));
    d = fenetre(nomAppareil(f), contenu);
  }

  /** Note datée dans la main courante ; casse / panne peuvent passer l'appareil « En panne ». */
  function ouvrirNote(f, nature) {
    const TYPES = { Casse: 'Casse', Panne: 'Panne signalée', Problème: 'Problème', Note: 'Note' };
    const date = el('input', { type: 'date', valeur: aujourdhui(), max: aujourdhui() });
    const texte = el('textarea', { rows: '3', placeholder: nature === 'Note' ? 'Votre note' : 'Que s\'est-il passé ? Ce qui ne fonctionne pas…' });
    const enPanne = el('input', { type: 'checkbox', coche: (nature === 'Casse' || nature === 'Panne') && f.statut === 'En service' });
    const dejaMaintenance = f.statut === 'En maintenance';
    const biomed = el('input', { type: 'checkbox', coche: !dejaMaintenance, disabled: dejaMaintenance });
    const message = el('p', { classe: 'message erreur', role: 'alert' });
    let d;
    const contenu = el('form', {
      classe: 'mat-form', novalidate: true,
      sursubmit: (ev) => {
        ev.preventDefault();
        if (!texte.value.trim()) { message.textContent = 'Décrivez en quelques mots.'; return; }
        d.close();
        if (nature !== 'Note') {
          // Problème : même parcours que l'action rapide — à amener au biomédical (suivi par boutons), puis proposition de publier une information.
          const description = texte.value.trim();
          const aAmener = biomed.checked && !dejaMaintenance;
          const ok = enfiler('signalerMateriel', {
            materiel: f.id, date: date.value || aujourdhui(), type: TYPES[nature], description: aAmener ? `${description}\nÀ amener au service biomédical.` : description,
            statut: aAmener || enPanne.checked ? 'En panne' : '', destination: '', photoDonnees: '',
          });
          if (ok) proposerPublicationProbleme(f, nature === 'Panne' ? 'Panne' : nature, description, aAmener, '');
          return;
        }
        enfiler('ajouterIntervention', { materiels: [f.id], date: date.value || aujourdhui(), type: TYPES[nature], description: texte.value.trim(), intervenant: '', prochaineRevision: '' });
        if (enPanne.checked && f.statut !== 'En panne') enfiler('enregistrerMateriel', { fiches: [{ ...f, statut: 'En panne' }] });
      },
    },
    champ('Date', date), champ(nature === 'Note' ? 'Note' : 'Description', texte),
    nature === 'Note' ? null : el('label', { classe: 'mat-case-libelle' }, enPanne, el('span', { texte: 'Passer l\'appareil « En panne »' })),
    nature === 'Note' ? null : el('label', { classe: 'mat-case-libelle' }, biomed,
      el('span', { texte: dejaMaintenance ? 'Appareil déjà en maintenance' : 'À amener au service biomédical (suivi par boutons dans l\'information)' })),
    message, el('div', { classe: 'mat-boutons' }, el('button', { type: 'submit', classe: 'principal', texte: 'Enregistrer' })));
    d = fenetre(`${nature} · ${nomAppareil(f)}`, contenu);
  }

  // ---------- Action rapide : appareil scanné (n° biomed, n° de série, puce) ----------
  /** Fenêtre ouverte depuis la barre du bas : identité, statut, dernier contenant, et trois actions pour tous. */
  /** Maintenance attendue sur un appareil scanné : contrôle hebdomadaire d'un Monnal, ou maintenance à cycle fixe échue. */
  function maintenanceAttendue(f, interventions) {
    if (estMonnal(f)) {
      const derniere = interventions.filter((i) => i.materiel === f.id && String(i.description || '').startsWith(LIBELLE_MONNAL))
        .map((i) => i.date).sort().pop();
      const faite = derniere && derniere >= lundiDeLaSemaine();
      return { titre: LIBELLE_MONNAL, detail: faite ? `Déjà faite le ${dateFr(derniere)}` : 'À faire cette semaine', urgente: !faite, lancer: () => ouvrirMonnal(f) };
    }
    if (estGlycemie(f)) {
      const echeance = echeanceGlycemie(f, interventions);
      if (!echeance.retard && !echeance.bientot) return null;
      return { titre: LIBELLE_GLYCEMIE, detail: echeance.texte, urgente: echeance.retard, lancer: () => ouvrirGlycemie(f) };
    }
    const plan = (f.plans || []).find((p) => p.cycle && p.prochaine && p.prochaine <= aujourdhui());
    if (!plan || f.statut !== 'En service' || f.maintenance === false) return null;
    return {
      titre: `Maintenance : ${plan.libelle}`, detail: plan.prochaine < aujourdhui() ? `En retard, prévue le ${dateFr(plan.prochaine)}` : 'À faire aujourd\'hui', urgente: true,
      lancer: () => ouvrirControle({ ids: [f.id], planId: plan.id, libelle: plan.libelle, appareil: [f.type, f.modele].filter(Boolean).join(' ') }),
    };
  }

  function ouvrirRapide(id) {
    const { fiches: toutes, attente, interventions } = etat();
    const f = toutes.find((x) => x.id === id);
    if (!f) return;
    const actif = !f.archive && f.statut !== 'Réformé';
    const enMaintenance = f.statut === 'En maintenance';
    const pretEnCours = f.pret ? etatPrets().ouverts.get(f.pret) || null : null;
    const attendue = actif && !f.provisoire && peutControler() ? maintenanceAttendue(f, interventions) : null;
    const action = (icone, titre, detail, faire, desactive) => el('button', { type: 'button', classe: 'mat-rapide-action', disabled: desactive, surclick: faire },
      el('span', { classe: 'mat-rapide-icone', 'aria-hidden': 'true', texte: icone }),
      el('span', {}, el('strong', { texte: titre }), detail ? el('small', { texte: detail }) : null));
    let d;
    const contenu = el('div', { classe: 'mat-rapide' },
      el('div', { classe: 'mat-rapide-tete' },
        aPhoto(f) ? vignette(f, 'mat-rapide-photo') : null,
        el('div', {},
          el('p', { classe: 'mat-rapide-ids', texte: [f.numBiomed && `Biomed ${f.numBiomed}`, f.numSerie && `S/N ${f.numSerie}`].filter(Boolean).join(' · ') || 'Sans n° biomed ni n° de série' }),
          el('p', {}, f.archive ? el('span', { classe: 'mat-pastille rev-neutre', texte: 'Archivé' }) : pastilleStatut(f.statut), ...pastillesSituation(f),
            attente.has(f.id) ? el('span', { classe: 'mat-pastille attente', texte: 'En attente d\'envoi' }) : null))),
      el('p', { classe: 'mat-rapide-lieu' }, el('span', { 'aria-hidden': 'true', texte: '📍 ' }),
        el('strong', { texte: 'Dernier contenant : ' }), texteEmplacement(f) || 'jamais pointé dans un inventaire'),
      el('div', { classe: 'mat-rapide-actions' },
        attendue ? action('✅', attendue.titre, attendue.detail, () => { d.close(); attendue.lancer(); }) : null,
        action('⚠️', 'Signaler un problème', 'Panne, casse, dysfonctionnement…', () => { d.close(); rapideSignaler(f); }, !actif),
        action('🔧', 'Envoyer en maintenance', enMaintenance ? 'Déjà en maintenance' : 'Biomédical, fournisseur…', () => { d.close(); rapideMaintenance(f); }, !actif || enMaintenance),
        estAdmin() && !f.provisoire ? action('🔁', 'Changer le statut', 'En service, maintenance, panne…', () => { d.close(); ouvrirStatut(f); }, !actif) : null,
        action('🕘', 'Consulter l\'historique', 'Main courante de l\'appareil', () => { d.close(); rapideHistorique(f.id); }),
        pretEnCours ? action('🤝', 'Détail du prêt', `${pretEnCours.reference} · ${pretEnCours.proprietaire || 'propriétaire non renseigné'}`, () => { d.close(); ouvrirDetailPret(pretEnCours); }) : null,
        f.provisoire ? null : action('📋', 'Fiche complète', 'Caractéristiques, maintenance, main courante', () => { d.close(); ouvrirFiche(f.id); })));
    d = fenetre(nomAppareil(f), contenu);
  }

  function boutonRetourRapide(d, f) {
    return el('button', { type: 'button', classe: 'lien', texte: '← Retour', surclick: () => { d.close(); ouvrirRapide(f.id); } });
  }

  function rapideSignaler(f) {
    const NATURES = [['Panne', 'Panne signalée'], ['Casse', 'Casse'], ['Dysfonctionnement', 'Problème']];
    let nature = '';
    const choix = el('div', { classe: 'mat-boutons', role: 'radiogroup', 'aria-label': 'Type de problème' });
    const majChoix = () => choix.querySelectorAll('button').forEach((b) => { const oui = b.dataset.v === nature; b.classList.toggle('choisi', oui); b.setAttribute('aria-checked', String(oui)); });
    NATURES.forEach(([t, v]) => choix.append(el('button', { type: 'button', classe: 'cfg-bouton', role: 'radio', 'aria-checked': 'false', 'data-v': v, texte: t, surclick: () => { nature = v; majChoix(); } })));
    const texte = el('textarea', { rows: '4', placeholder: 'Ce qui ne fonctionne pas, dans quelles circonstances…' });
    const dejaMaintenance = f.statut === 'En maintenance';
    const biomed = el('input', { type: 'checkbox', coche: !dejaMaintenance, disabled: dejaMaintenance });
    const message = el('p', { classe: 'message erreur', role: 'alert' });

    // Photo facultative (prise sur place ou choisie dans la galerie), recadrable.
    let photo = '';
    const apercu = el('img', { classe: 'mat-photo', alt: 'Photo du problème', hidden: true });
    const boutonRetirer = el('button', { type: 'button', classe: 'cfg-bouton danger', texte: 'Retirer', hidden: true, surclick: () => { photo = ''; majPhoto(); } });
    const boutonRecadrer = el('button', { type: 'button', classe: 'cfg-bouton', texte: '✂ Recadrer', hidden: true, surclick: () => { if (photo) prendrePhoto(photo); } });
    const majPhoto = () => { apercu.hidden = !photo; if (photo) apercu.src = photo; boutonRetirer.hidden = !photo; boutonRecadrer.hidden = !photo; };
    const prendrePhoto = async (source) => {
      try { const x = await reduirePhoto(source); if (x) { photo = x; message.textContent = ''; } } catch (err) { message.textContent = 'Photo illisible ou trop lourde.'; }
      majPhoto();
    };
    const fichierPhoto = el('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
    fichierPhoto.addEventListener('change', () => { const x = fichierPhoto.files[0]; fichierPhoto.value = ''; if (x) prendrePhoto(x); });

    let d;
    const contenu = el('form', {
      classe: 'mat-form', novalidate: true,
      sursubmit: (ev) => {
        ev.preventDefault();
        if (!nature) { message.textContent = 'Choisissez le type de problème.'; return; }
        if (!texte.value.trim()) { message.textContent = 'Décrivez le problème en quelques mots.'; texte.focus(); return; }
        const aAmener = biomed.checked && !dejaMaintenance;
        const description = texte.value.trim();
        // « À amener au biomédical » : l'appareil passe « En panne » ; il ne sera « En maintenance » qu'à l'envoi (bouton de l'information).
        const ok = enfiler('signalerMateriel', {
          materiel: f.id, date: aujourdhui(), type: nature, description: aAmener ? `${description}\nÀ amener au service biomédical.` : description,
          statut: aAmener ? 'En panne' : '', destination: '', photoDonnees: photo,
        });
        if (!ok) { message.textContent = 'Impossible d\'enregistrer sur cet appareil (mémoire pleine ?).'; return; }
        d.close();
        proposerPublicationProbleme(f, NATURES.find(([, v]) => v === nature)[0], description, aAmener, photo);
      },
    },
    el('p', { classe: 'mat-libelle', texte: 'Type de problème' }), choix,
    champ('Description', texte),
    el('div', { classe: 'mat-photo-bloc' }, el('p', { classe: 'mat-libelle', texte: 'Photo (facultatif)' }), apercu,
      el('div', { classe: 'mat-boutons' },
        el('button', { type: 'button', classe: 'cfg-bouton', texte: '📷 Prendre ou choisir une photo', surclick: () => fichierPhoto.click() }), boutonRecadrer, boutonRetirer, fichierPhoto)),
    el('label', { classe: 'mat-case-libelle' }, biomed,
      el('span', { texte: dejaMaintenance ? 'Appareil déjà en maintenance' : 'À amener au service biomédical (suivi par boutons dans l\'information)' })),
    message,
    el('div', { classe: 'mat-boutons' }, boutonRetourRapide({ close: () => d.close() }, f), el('button', { type: 'submit', classe: 'principal', texte: 'Signaler' })));
    d = fenetre(`Signaler un problème · ${nomAppareil(f)}`, contenu);
  }

  /** Après un signalement : proposer de publier une information sur le mur (formulaire pré-rempli, photo jointe). */
  function proposerPublicationProbleme(f, nature, description, aAmener, photo) {
    const nom = nomAppareil(f);
    const titre = `${nom} : ${nature.toLowerCase()}${aAmener ? ' — à amener au biomed' : ''}`;
    if (typeof Infos === 'undefined' || !Infos.publier) { ouvrirRapide(f.id); return; }
    let d;
    const contenu = el('div', {},
      el('p', { texte: 'Problème enregistré dans la main courante de l\'appareil.' }),
      el('p', { texte: `Souhaitez-vous publier une information sur le mur pour prévenir l'équipe ?` }),
      el('div', { classe: 'mat-boutons' },
        el('button', {
          type: 'button', classe: 'principal', texte: 'Publier une information',
          surclick: () => {
            d.close();
            const lieu = texteEmplacement(f);
            Infos.publier({
              types: ['panne', 'information'], importance: 'importante', titre,
              texte: [description, lieu ? `Dernier contenant : ${lieu}` : '', aAmener ? 'À amener au service biomédical.' : ''].filter(Boolean).join('\n'),
              materiel: f.id, suivi: aAmener, // boutons « Envoyé au biomédical » puis « Récupéré » dans l'information
              pieces: photo ? [{ type: 'photo', nom: `${nom}.jpg`.slice(0, 80), donnees: photo }] : [],
            });
          },
        }),
        el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Non merci', surclick: () => d.close() })));
    d = fenetre('Publier une information ?', contenu);
  }

  function rapideMaintenance(f) {
    const motif = selectListe(['Panne / réparation', 'Maintenance préventive (révision)', 'Contrôle', 'Mise à jour logicielle', 'Autre'], 'Panne / réparation');
    const destination = selectListe(['Service biomédical', 'Fournisseur / constructeur', 'Autre'], 'Service biomédical');
    const texte = el('textarea', { rows: '3', placeholder: 'Précisions (n° de bon, interlocuteur, matériel de remplacement…)' });
    let d;
    const contenu = el('form', {
      classe: 'mat-form', novalidate: true,
      sursubmit: (ev) => {
        ev.preventDefault();
        d.close();
        enfiler('signalerMateriel', {
          materiel: f.id, date: aujourdhui(), type: 'Envoi en maintenance', statut: 'En maintenance', destination: destination.value,
          description: [`Motif : ${motif.value}`, texte.value.trim()].filter(Boolean).join('\n'),
        });
        ouvrirRapide(f.id);
      },
    },
    champ('Motif', motif), champ('Envoyé à', destination), champ('Précisions (facultatif)', texte),
    el('p', { classe: 'aide-question', texte: `L'appareil passera « En maintenance » ; c'est consigné dans sa main courante.` }),
    el('div', { classe: 'mat-boutons' }, boutonRetourRapide({ close: () => d.close() }, f), el('button', { type: 'submit', classe: 'principal', texte: 'Envoyer en maintenance' })));
    d = fenetre(`Envoyer en maintenance · ${nomAppareil(f)}`, contenu);
  }

  /** Photo jointe à une entrée de main courante (signalement). */
  function photoEntree(i) {
    const img = el('img', { classe: 'mat-histo-photo', alt: 'Photo jointe', loading: 'lazy' });
    if (i.photoDonnees) img.src = i.photoDonnees;
    else imageDe({ photo: i.photo }).then((src) => { if (src) img.src = src; else img.remove(); });
    return img;
  }

  const peutControler = () => Boolean(outils.peutControler ? outils.peutControler() : estAdmin());

  /** Formulaire d'une maintenance à cycle fixe : un choix « conforme / anomalie » par appareil concerné. */
  function ouvrirControle(g) {
    const toutes = fiches();
    const lignes = g.ids.map((id) => toutes.find((x) => x.id === id)).filter(Boolean).map((f) => {
      let conforme = true;
      const obs = el('input', { type: 'text', maxlength: '300', placeholder: 'Anomalie constatée (obligatoire)', 'aria-label': `Anomalie : ${nomAppareil(f)}` });
      const zoneObs = el('div', {}, obs);
      zoneObs.hidden = true;
      const choix = (valeur, libelle) => {
        const r = el('input', { type: 'radio', surchange: () => { conforme = valeur; zoneObs.hidden = valeur; if (!valeur) obs.focus(); } });
        r.name = `ctl-${f.id}`; r.checked = valeur;
        return el('label', { classe: 'mat-case-libelle' }, r, el('span', { texte: libelle }));
      };
      return { f, obs, etat: () => conforme,
        element: el('li', { classe: 'mat-controle' }, el('strong', { texte: nomAppareil(f) }), el('div', { classe: 'mat-boutons' }, choix(true, 'Conforme'), choix(false, 'Anomalie')), zoneObs) };
    });
    if (!lignes.length) return;
    const date = el('input', { type: 'date', valeur: aujourdhui(), max: aujourdhui(), required: true });
    const commune = el('textarea', { rows: '2', maxlength: '300', placeholder: 'Observation générale (facultatif)' });
    const message = el('p', { classe: 'message erreur', role: 'alert' });
    let d;
    const contenu = el('form', {
      classe: 'mat-form', novalidate: true,
      sursubmit: (ev) => {
        ev.preventDefault();
        if (!date.value) { message.textContent = 'La date est obligatoire.'; return; }
        const controles = [];
        for (const l of lignes) {
          const conforme = l.etat();
          const o = l.obs.value.trim();
          if (!conforme && !o) { message.textContent = `Précisez l'anomalie : ${nomAppareil(l.f)}.`; l.obs.focus(); return; }
          const plan = (l.f.plans || []).find((p) => p.id === g.planId);
          if (!plan) continue;
          // Maintenance faite : prochaine date du cycle après aujourd'hui (ou après l'échéance si faite en avance) ; les occurrences manquées ne s'additionnent pas.
          const ref = plan.prochaine && plan.prochaine > date.value ? plan.prochaine : date.value;
          controles.push({ materiel: l.f.id, plan: g.planId, conforme, observation: conforme ? '' : o, prochaine: ajouterPeriode(ref, plan, plan.prochaine) });
        }
        if (!controles.length) { d.close(); return; }
        d.close();
        enfiler('realiserMaintenance', { date: date.value, libelle: g.libelle, observation: commune.value.trim(), controles });
      },
    },
    el('p', { classe: 'aide-question', texte: `${g.libelle} · ${g.appareil}. Cochez chaque appareil contrôlé ; une anomalie passe l'appareil « En panne » et le signale dans sa main courante.` }),
    champ('Date de la maintenance', date),
    el('ul', { classe: 'mat-controles' }, lignes.map((l) => l.element)),
    champ('Observation', commune),
    message,
    el('div', { classe: 'mat-boutons' }, el('button', { type: 'submit', classe: 'principal', texte: 'Enregistrer la maintenance' })));
    d = fenetre(`Maintenance · ${g.libelle}`, contenu);
  }


  // ---------- Maintenance hebdomadaire des respirateurs Monnal ----------
  const LIBELLE_MONNAL = 'Maintenance hebdomadaire Monnal';
  const motifMonnal = /monnal|t60/;
  const estMonnal = (f) => motifMonnal.test(normaliser(f.modele || ''));
  /** Le 1er lundi du mois : valve expiratoire et capteur de débit en plus. */
  const premierLundi = (iso) => { const [a, m, j] = iso.split('-').map(Number); return new Date(a, m - 1, j).getDay() === 1 && j <= 7; };
  /** Le 1er lundi d'avril : filtre d'admission d'air en plus. */
  const premierLundiAvril = (iso) => premierLundi(iso) && Number(iso.split('-')[1]) === 4;
  const lundiDeLaSemaine = () => { const [a, m, j] = aujourdhui().split('-').map(Number); const d = new Date(a, m - 1, j); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return isoDe(d); };
  const nombreFr = (v) => String(v).replace('.', ',');

  function rendreMonnal() {
    const { fiches: toutes, interventions, attente } = etat();
    const appareils = toutes.filter((f) => enService(f) && !f.provisoire && estMonnal(f))
      .sort((a, b) => String(a.numInterne).localeCompare(String(b.numInterne), 'fr', { numeric: true }));
    const lundi = lundiDeLaSemaine();
    const entete = el('div', { classe: 'mat-entete' }, el('h1', { texte: 'Maintenance Monnal' }));
    const aide = el('p', { classe: 'aide-question', texte: 'Contrôle hebdomadaire des respirateurs Monnal : autotest, alarmes, filtre HEPA, FiO². Le 1er lundi du mois, s\'ajoutent la valve expiratoire et le capteur de débit ; le 1er lundi d\'avril, le filtre d\'admission d\'air. Une anomalie propose de signaler le problème et d\'envoyer le respirateur au biomédical.' });
    const lignes = appareils.map((f) => {
      const faites = interventions.filter((i) => i.materiel === f.id && String(i.description || '').startsWith(LIBELLE_MONNAL))
        .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.saisiLe || '').localeCompare(String(a.saisiLe || '')));
      const derniere = faites[0];
      const aJour = derniere && derniere.date >= lundi;
      const anomalie = derniere && /Résultat : anomalie/.test(derniere.description || '');
      return el('li', { classe: 'mat-ligne' },
        el('span', { classe: 'mat-corps' },
          el('span', { classe: 'mat-nom' }, el('strong', { texte: nomAppareil(f) })),
          el('span', { classe: 'mat-derniere', texte: derniere ? `Dernière maintenance le ${dateFr(derniere.date)}${anomalie ? ' (anomalie)' : ''}` : 'Aucune maintenance enregistrée' }),
          f.emplacement ? el('span', { classe: 'mat-emplacement', texte: `📍 ${texteEmplacement(f)}` }) : null),
        el('span', { classe: 'mat-etats' },
          f.statut !== 'En service' ? el('span', { classe: `mat-pastille statut-${normaliser(f.statut).replace(/\W+/g, '-')}`, texte: f.statut }) : null,
          el('span', { classe: `mat-pastille rev-${aJour ? 'ok' : 'retard'}`, texte: aJour ? 'Faite cette semaine' : 'À faire' }),
          attente.has(f.id) ? el('span', { classe: 'mat-pastille attente', texte: 'En attente d\'envoi' }) : null),
        peutControler() ? el('button', { type: 'button', classe: 'cfg-mini', texte: 'Faire la maintenance', surclick: () => ouvrirMonnal(f) }) : null);
    });
    const boutonHisto = el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Historique des maintenances (5 ans) · PDF', surclick: ouvrirHistoriqueMonnal });
    zone.replaceChildren(ongletsMateriel(), entete, aide, el('div', { classe: 'cfg-actions' }, boutonHisto),
      lignes.length ? el('ul', { classe: 'mat-lignes' }, lignes)
        : el('p', { classe: 'mat-vide', texte: 'Aucun respirateur Monnal en service dans la base du matériel (modèle contenant « Monnal » ou « T60 », par exemple « Monnal T60 »).' }));
  }

  /** Plusieurs respirateurs à contrôler (rappel de l'accueil) : un bouton par appareil. */
  function ouvrirChoixMonnal(ids, glycemie = false) {
    const liste = fiches().filter((f) => ids.includes(f.id));
    const ouvrir = glycemie ? ouvrirGlycemie : ouvrirMonnal;
    if (liste.length === 1) { ouvrir(liste[0]); return; }
    let d;
    d = fenetre(glycemie ? LIBELLE_GLYCEMIE : LIBELLE_MONNAL, el('div', { classe: 'mat-form' },
      el('p', { classe: 'aide-question', texte: glycemie ? 'Choisissez l\'appareil contrôlé.' : 'Choisissez le respirateur contrôlé.' }),
      el('div', { classe: 'mat-boutons' }, liste.map((f) => el('button', { type: 'button', classe: 'cfg-bouton', texte: nomAppareil(f), surclick: () => { d.close(); ouvrir(f); } })))));
  }

  /** Formulaire de la maintenance hebdomadaire d'un Monnal (champs du 1er lundi du mois / d'avril selon la date). */
  function ouvrirMonnal(f) {
    const ouiNon = (libelle, aide) => {
      let valeur = null;
      const radio = (v, t) => {
        const r = el('input', { type: 'radio', surchange: () => { valeur = v; } });
        r.name = `mn-${libelle}`;
        return el('label', { classe: 'mat-case-libelle' }, r, el('span', { texte: t }));
      };
      return { valeur: () => valeur, libelle, element: el('fieldset', { classe: 'mat-cadre' }, el('legend', { texte: libelle }), aide ? el('small', { texte: aide }) : null, el('div', { classe: 'mat-boutons' }, radio(true, 'Oui'), radio(false, 'Non'))) };
    };
    const mesure = (libelle, defaut) => {
      const champSaisie = el('input', { type: 'number', inputmode: 'decimal', step: 'any', min: '0', max: '110', required: true, valeur: String(defaut), 'aria-label': libelle });
      return { libelle, champ: champSaisie, element: champ(libelle, el('div', { classe: 'mat-periode' }, champSaisie, el('span', { texte: '%' }))) };
    };
    const date = el('input', { type: 'date', valeur: aujourdhui(), max: aujourdhui(), required: true });
    const autotest = ouiNon('Autotest réussi');
    const pression = ouiNon('Alarme pression haute', 'Oui : l\'alarme s\'est déclenchée comme attendu.');
    const debranchement = ouiNon('Alarme débranchement patient', 'Oui : l\'alarme s\'est déclenchée comme attendu.');
    const hepa = ouiNon('Changement de filtre HEPA');
    const fio100 = mesure('FiO² 100 % : valeur mesurée', 100);
    const fio21 = mesure('FiO² 21 % : valeur mesurée', 21);
    const valve = ouiNon('Changement de la valve expiratoire');
    const capteur = ouiNon('Changement du capteur de débit');
    const admission = ouiNon('Changement du filtre d\'admission d\'air');
    const blocMois = el('div', { classe: 'mat-cadre-groupe' }, el('p', { classe: 'mat-libelle', texte: '1er lundi du mois' }), valve.element, capteur.element);
    const blocAvril = el('div', { classe: 'mat-cadre-groupe' }, el('p', { classe: 'mat-libelle', texte: '1er lundi d\'avril' }), admission.element);
    const autre = el('input', { type: 'checkbox' });
    const commentaires = el('textarea', { rows: '3', maxlength: '300', placeholder: 'Commentaires (facultatif ; obligatoire si autre anomalie)' });
    const message = el('p', { classe: 'message erreur', role: 'alert' });
    const majBlocs = () => {
      blocMois.hidden = !(date.value && premierLundi(date.value));
      blocAvril.hidden = !(date.value && premierLundiAvril(date.value));
    };
    date.addEventListener('input', majBlocs);
    majBlocs();

    let d;
    const contenu = el('form', {
      classe: 'mat-form', novalidate: true,
      sursubmit: (ev) => {
        ev.preventDefault();
        if (!date.value) { message.textContent = 'La date est obligatoire.'; return; }
        const aRepondre = [autotest, pression, debranchement, hepa, ...(blocMois.hidden ? [] : [valve, capteur]), ...(blocAvril.hidden ? [] : [admission])];
        const manquant = aRepondre.find((q) => q.valeur() === null);
        if (manquant) { message.textContent = `Répondez à : ${manquant.libelle}.`; return; }
        const valeurs = [fio100, fio21].map((m) => ({ m, v: parseFloat(String(m.champ.value).replace(',', '.')) }));
        const invalide = valeurs.find(({ v }) => !Number.isFinite(v) || v < 0 || v > 110);
        if (invalide) { message.textContent = `Saisissez la valeur mesurée : ${invalide.m.libelle.replace(' : valeur mesurée', '')}.`; invalide.m.champ.focus(); return; }
        const remarque = commentaires.value.trim();
        const defauts = [
          !autotest.valeur() && 'autotest non réussi', !pression.valeur() && 'alarme pression haute non déclenchée',
          !debranchement.valeur() && 'alarme débranchement patient non déclenchée', autre.checked && 'autre anomalie constatée',
        ].filter(Boolean);
        if (autre.checked && !remarque) { message.textContent = 'Décrivez l\'autre anomalie dans les commentaires.'; commentaires.focus(); return; }
        const anomalie = defauts.length > 0;
        const oui = (q) => (q.valeur() ? 'oui' : 'non');
        const details = [
          LIBELLE_MONNAL, `Résultat : ${anomalie ? 'anomalie' : 'conforme'}`,
          `Autotest réussi : ${oui(autotest)}`, `Alarme pression haute : ${oui(pression)}`, `Alarme débranchement patient : ${oui(debranchement)}`,
          `Changement de filtre HEPA : ${oui(hepa)}`, `FiO² 100 % : ${nombreFr(valeurs[0].v)} %`, `FiO² 21 % : ${nombreFr(valeurs[1].v)} %`,
          ...(blocMois.hidden ? [] : [`Changement valve expiratoire : ${oui(valve)}`, `Changement capteur de débit : ${oui(capteur)}`]),
          ...(blocAvril.hidden ? [] : [`Changement filtre d'admission d'air : ${oui(admission)}`]),
          remarque ? `Commentaires : ${remarque}` : '',
        ].filter(Boolean).join('\n');
        // Cycle fixe de l'appareil (ex. tous les lundis) : la prochaine échéance avance ; sinon la maintenance est seulement consignée.
        const plan = (f.plans || []).find((p) => p.cycle);
        const ref = plan && plan.prochaine && plan.prochaine > date.value ? plan.prochaine : date.value;
        const resume = defauts.join(', ');
        d.close();
        enfiler('realiserMaintenance', {
          date: date.value, libelle: LIBELLE_MONNAL, observation: '',
          controles: [{ materiel: f.id, plan: plan ? plan.id : '', conforme: !anomalie, observation: resume, prochaine: plan ? ajouterPeriode(ref, plan, plan.prochaine) : '', details, signaler: false }],
        });
        if (anomalie) proposerSignalementMonnal(f, resume, remarque);
      },
    },
    el('p', { classe: 'aide-question', texte: nomAppareil(f) }),
    champ('Date de la maintenance', date),
    autotest.element, pression.element, debranchement.element, hepa.element, fio100.element, fio21.element, blocMois, blocAvril,
    el('label', { classe: 'mat-case-libelle' }, autre, el('span', { texte: 'Autre anomalie constatée (FiO² hors tolérance, aspect, bruit…)' })),
    champ('Commentaires', commentaires),
    message,
    el('div', { classe: 'mat-boutons' }, el('button', { type: 'submit', classe: 'principal', texte: 'Enregistrer la maintenance' })));
    d = fenetre(`${LIBELLE_MONNAL} · ${nomAppareil(f)}`, contenu, { large: true });
  }

  /** Anomalie à la maintenance : proposer de signaler le problème et d'envoyer le respirateur au biomédical. */
  function proposerSignalementMonnal(f, resume, remarque, contexte = 'de la maintenance hebdomadaire', objet = 'le respirateur') {
    const description = `Anomalie constatée lors ${contexte} : ${resume}.${remarque ? `\n${remarque}` : ''}`;
    const dejaMaintenance = f.statut === 'En maintenance';
    const lancer = (aAmener) => {
      enfiler('signalerMateriel', {
        materiel: f.id, date: aujourdhui(), type: 'Problème', description: aAmener ? `${description}\nÀ amener au service biomédical.` : description,
        statut: aAmener ? 'En panne' : '', destination: '', photoDonnees: '',
      });
      proposerPublicationProbleme(f, 'Dysfonctionnement', description, aAmener, '');
    };
    let d;
    d = fenetre('Anomalie constatée', el('div', { classe: 'mat-form' },
      el('p', { texte: `${nomAppareil(f)} : ${resume}.` }),
      el('p', { texte: `Le contrôle est enregistré. Souhaitez-vous signaler le problème et envoyer ${objet} au service biomédical ?` }),
      el('div', { classe: 'mat-boutons' },
        dejaMaintenance ? null : el('button', { type: 'button', classe: 'principal', texte: 'Signaler et envoyer au biomédical', surclick: () => { d.close(); lancer(true); } }),
        el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Signaler seulement', surclick: () => { d.close(); lancer(false); } }),
        el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Plus tard', surclick: () => d.close() }))));
  }

  // ---------- Contrôle semestriel des appareils à glycémie ----------
  const LIBELLE_GLYCEMIE = 'Contrôle appareil glycémie';
  const MOIS_GLYCEMIE = 6;
  const estGlycemie = (f) => /glyc|glucom|glucot|hemogluc|dextro/.test(normaliser(`${f.type || ''} ${f.modele || ''}`));
  const controlesGlycemie = (interventions, id) => interventions
    .filter((i) => (id === undefined || i.materiel === id) && String(i.description || '').startsWith(LIBELLE_GLYCEMIE))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.saisiLe || '').localeCompare(String(a.saisiLe || '')));
  /** Échéance du prochain contrôle : 6 mois après le dernier (« bientôt » dans les 30 jours). */
  function echeanceGlycemie(f, interventions) {
    const derniere = controlesGlycemie(interventions, f.id)[0];
    if (!derniere) return { derniere: null, prochaine: '', retard: true, bientot: false, texte: 'Aucun contrôle enregistré' };
    const prochaine = ajouterMois(derniere.date, MOIS_GLYCEMIE);
    const jours = Math.round((new Date(prochaine) - new Date(aujourdhui())) / 86400000);
    const retard = jours < 0;
    const bientot = !retard && jours <= 30;
    return { derniere, prochaine, retard, bientot, texte: retard ? `En retard, prévu le ${dateFr(prochaine)}` : `Prochain contrôle le ${dateFr(prochaine)}` };
  }
  /** Lots et péremptions du dernier contrôle (tous appareils confondus), pour ne pas les ressaisir à chaque fois. */
  function dernierLotsGlycemie() {
    const { interventions } = etat();
    const texte = (controlesGlycemie(interventions)[0] || {}).description || '';
    const lire = (titre) => {
      const m = texte.match(new RegExp(`${titre} : lot (.*?) · péremption (\\d{2})/(\\d{2})/(\\d{4})`));
      return m ? { lot: m[1] === '—' ? '' : m[1], peremption: `${m[4]}-${m[3]}-${m[2]}` } : { lot: '', peremption: '' };
    };
    const unite = (texte.match(/Contrôle bas : [\d,.]+ (\S+)/) || [])[1] || 'g/L';
    return { bandelettes: lire('Bandelettes'), solutions: lire('Solutions test'), unite };
  }

  // ---------- Historique des contrôles glycémie : tableau par appareil, 5 dernières années, export PDF ----------
  const ANNEES_HISTORIQUE_GLYCEMIE = 5;
  const LIGNES_PAR_PAGE_GLYCEMIE = 14; // lignes de contrôle par page A4 paysage à l'impression
  /** Décompose la description d'un contrôle enregistré en colonnes de tableau. */
  function lireControleGlycemie(i) {
    const t = String(i.description || '');
    const lot = (titre) => { const m = t.match(new RegExp(`${titre} : lot (.*?) · péremption (\\d{2}/\\d{2}/\\d{4}|—)`)); return m ? { lot: m[1], per: m[2] } : { lot: '—', per: '—' }; };
    const val = (titre) => { const m = t.match(new RegExp(`${titre} : ([\\d,.]+(?: \\S+)?)`)); return m ? m[1] : '—'; };
    const resultat = (t.match(/Résultat : (\S+)/) || [])[1] || '—';
    const com = (t.match(/Commentaires : ([\s\S]*)$/) || [])[1] || '';
    const band = lot('Bandelettes'); const sol = lot('Solutions test');
    return { date: i.date, resultat, lotBand: band.lot, perBand: band.per, bas: val('Contrôle bas'), haut: val('Contrôle haut'), lotSol: sol.lot, perSol: sol.per, commentaires: com.trim(), par: i.saisiPar || '' };
  }
  /** Contrôles de chaque appareil à glycémie depuis 5 ans, du plus récent au plus ancien. */
  function historiqueGlycemie() {
    const { fiches: toutes, interventions } = etat();
    const limite = ajouterMois(aujourdhui(), -12 * ANNEES_HISTORIQUE_GLYCEMIE);
    return toutes.filter((f) => !f.provisoire && estGlycemie(f))
      .sort((a, b) => String(a.numInterne).localeCompare(String(b.numInterne), 'fr', { numeric: true }))
      .map((f) => ({ fiche: f, controles: controlesGlycemie(interventions, f.id).filter((i) => String(i.date) >= limite).map(lireControleGlycemie) }));
  }
  const COLONNES_GLYCEMIE = ['Date', 'Résultat', 'Bandelettes (lot)', 'Péremption', 'Contrôle bas', 'Contrôle haut', 'Solution test (lot)', 'Péremption', 'Commentaires'];
  /** Tableau d'historique générique : colonnes, lignes { cellules, anomalie }. */
  function tableauHisto(colonnes, lignes, classe, vide) {
    return el('table', { classe: `glyc-tableau ${classe || ''}` },
      el('thead', {}, el('tr', {}, colonnes.map((c) => el('th', { texte: c })))),
      el('tbody', {}, lignes.length ? lignes.map((l) => el('tr', { classe: l.anomalie ? 'glyc-anomalie' : '' }, l.cellules.map((x) => el('td', { texte: x }))))
        : el('tr', {}, el('td', { colspan: String(colonnes.length), texte: vide }))));
  }
  const ligneGlycemie = (c) => ({ anomalie: c.resultat === 'anomalie', cellules: [dateFr(c.date), c.resultat, c.lotBand, c.perBand, c.bas, c.haut, c.lotSol, c.perSol, c.commentaires] });
  const tableauGlycemie = (controles, classe) => tableauHisto(COLONNES_GLYCEMIE, controles.map(ligneGlycemie), classe, `Aucun contrôle enregistré sur les ${ANNEES_HISTORIQUE_GLYCEMIE} dernières années.`);
  /** Fenêtre d'historique : un tableau par appareil. */
  function fenetreHistorique(titre, introduction, donnees, colonnes, versLigne, vide, imprimer, aucunAppareil) {
    const contenu = el('div', { classe: 'glyc-histo' },
      el('p', { classe: 'aide-question', texte: introduction }),
      el('div', { classe: 'cfg-actions' }, el('button', { type: 'button', classe: 'cfg-bouton inv-actif', texte: 'Exporter en PDF', surclick: imprimer })),
      donnees.length ? donnees.map(({ fiche, controles }) => el('section', { classe: 'glyc-appareil' },
        el('h3', { texte: `${nomAppareil(fiche)} · ${controles.length} ligne${controles.length > 1 ? 's' : ''}` }),
        el('div', { classe: 'glyc-defilement' }, tableauHisto(colonnes, controles.map(versLigne), '', vide))))
        : el('p', { classe: 'mat-vide', texte: aucunAppareil }));
    fenetre(titre, contenu, { large: true });
  }
  /** Export PDF : pages A4 paysage (14 lignes par page, plusieurs pages par appareil si besoin), via l'impression du navigateur. */
  function imprimerHistorique(titreDoc, donnees, colonnes, versLigne, vide) {
    const jour = dateFr(aujourdhui());
    const parPage = LIGNES_PAR_PAGE_GLYCEMIE;
    const pages = donnees.flatMap(({ fiche, controles }) => {
      const n = Math.max(1, Math.ceil(controles.length / parPage));
      return Array.from({ length: n }, (_, k) => ({ fiche, lignes: controles.slice(k * parPage, (k + 1) * parPage), k, n }));
    });
    const page = el('div', { id: 'glyc-impression' }, pages.map(({ fiche, lignes, k, n }) => el('section', { classe: 'glyc-imp-page' },
      el('h1', { texte: titreDoc }),
      el('h2', { texte: nomAppareil(fiche) }),
      el('p', { classe: 'glyc-imp-infos', texte: [fiche.numBiomed && `N° biomed : ${fiche.numBiomed}`, fiche.numSerie && `N° de série : ${fiche.numSerie}`, `${ANNEES_HISTORIQUE_GLYCEMIE} dernières années, édité le ${jour}`, n > 1 && `page ${k + 1}/${n}`].filter(Boolean).join(' · ') }),
      tableauHisto(colonnes, lignes.map(versLigne), 'glyc-imp', vide))));
    document.body.append(page);
    document.body.classList.add('impression-glycemie');
    const fin = () => { document.body.classList.remove('impression-glycemie'); page.remove(); window.removeEventListener('afterprint', fin); };
    window.addEventListener('afterprint', fin);
    window.print();
    setTimeout(() => { if (document.body.contains(page) && !matchMedia('print').matches) fin(); }, 60000);
  }
  function ouvrirHistoriqueGlycemie() {
    const donnees = historiqueGlycemie();
    const vide = `Aucun contrôle enregistré sur les ${ANNEES_HISTORIQUE_GLYCEMIE} dernières années.`;
    fenetreHistorique('Historique des contrôles glycémie', `Contrôles des ${ANNEES_HISTORIQUE_GLYCEMIE} dernières années, un tableau par appareil, un contrôle par ligne.`, donnees, COLONNES_GLYCEMIE, ligneGlycemie, vide,
      () => imprimerHistorique('Contrôle des appareils à glycémie', donnees, COLONNES_GLYCEMIE, ligneGlycemie, vide), 'Aucun appareil à glycémie dans la base du matériel.');
  }

  // ---------- Historique des maintenances hebdomadaires Monnal ----------
  const COLONNES_MONNAL = ['Date', 'Résultat', 'Autotest', 'Alarme pression haute', 'Alarme débranchement', 'Filtre HEPA changé', 'FiO² 100 %', 'FiO² 21 %', 'Valve expiratoire changée', 'Capteur de débit changé', 'Filtre d\'admission d\'air changé', 'Commentaires'];
  /** Décompose la description d'une maintenance Monnal enregistrée en colonnes (« — » = non demandé ce jour-là). */
  function lireMaintenanceMonnal(i) {
    const t = String(i.description || '');
    const texte = (titre) => { const m = t.match(new RegExp(`^${titre} : (.*)$`, 'm')); return m ? m[1].trim() : '—'; };
    const ouiNon = (titre) => { const v = texte(titre); return v === 'oui' ? 'Oui' : v === 'non' ? 'Non' : '—'; };
    return {
      date: i.date, resultat: (t.match(/Résultat : (\S+)/) || [])[1] || '—',
      cellules: [dateFr(i.date), (t.match(/Résultat : (\S+)/) || [])[1] || '—', ouiNon('Autotest réussi'), ouiNon('Alarme pression haute'), ouiNon('Alarme débranchement patient'), ouiNon('Changement de filtre HEPA'),
        texte('FiO² 100 %'), texte('FiO² 21 %'), ouiNon('Changement valve expiratoire'), ouiNon('Changement capteur de débit'), ouiNon('Changement filtre d\'admission d\'air'),
        ((t.match(/Commentaires : ([\s\S]*)$/) || [])[1] || '').trim()],
    };
  }
  const ligneMonnal = (m) => ({ anomalie: m.resultat === 'anomalie', cellules: m.cellules });
  /** Maintenances de chaque Monnal depuis 5 ans, de la plus récente à la plus ancienne. */
  function historiqueMonnal() {
    const { fiches: toutes, interventions } = etat();
    const limite = ajouterMois(aujourdhui(), -12 * ANNEES_HISTORIQUE_GLYCEMIE);
    return toutes.filter((f) => !f.provisoire && estMonnal(f))
      .sort((a, b) => String(a.numInterne).localeCompare(String(b.numInterne), 'fr', { numeric: true }))
      .map((f) => ({ fiche: f, controles: interventions.filter((i) => i.materiel === f.id && String(i.description || '').startsWith(LIBELLE_MONNAL) && String(i.date) >= limite)
        .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.saisiLe || '').localeCompare(String(a.saisiLe || ''))).map(lireMaintenanceMonnal) }));
  }
  function ouvrirHistoriqueMonnal() {
    const donnees = historiqueMonnal();
    const vide = `Aucune maintenance enregistrée sur les ${ANNEES_HISTORIQUE_GLYCEMIE} dernières années.`;
    fenetreHistorique('Historique des maintenances Monnal', `Maintenances hebdomadaires des ${ANNEES_HISTORIQUE_GLYCEMIE} dernières années, un tableau par respirateur, une maintenance par ligne. « — » : non demandé ce jour-là (valve et capteur : 1er lundi du mois ; filtre d'admission d'air : 1er lundi d'avril).`, donnees, COLONNES_MONNAL, ligneMonnal, vide,
      () => imprimerHistorique('Maintenance hebdomadaire des respirateurs Monnal', donnees, COLONNES_MONNAL, ligneMonnal, vide), 'Aucun respirateur Monnal dans la base du matériel.');
  }

  function rendreGlycemie() {
    const { fiches: toutes, interventions, attente } = etat();
    const appareils = toutes.filter((f) => enService(f) && !f.provisoire && estGlycemie(f))
      .sort((a, b) => String(a.numInterne).localeCompare(String(b.numInterne), 'fr', { numeric: true }));
    const entete = el('div', { classe: 'mat-entete' }, el('h1', { texte: LIBELLE_GLYCEMIE }));
    const aide = el('p', { classe: 'aide-question', texte: 'Contrôle tous les 6 mois, par le personnel du SMUR : lot et péremption des bandelettes et des solutions test, valeurs des contrôles bas et haut. Les lots et péremptions du dernier contrôle sont repris automatiquement.' });
    const lignes = appareils.map((f) => {
      const e = echeanceGlycemie(f, interventions);
      const anomalie = e.derniere && /Résultat : anomalie/.test(e.derniere.description || '');
      return el('li', { classe: 'mat-ligne' },
        el('span', { classe: 'mat-corps' },
          el('span', { classe: 'mat-nom' }, el('strong', { texte: nomAppareil(f) })),
          el('span', { classe: 'mat-derniere', texte: e.derniere ? `Dernier contrôle le ${dateFr(e.derniere.date)}${anomalie ? ' (anomalie)' : ''} · ${e.texte}` : e.texte }),
          f.emplacement ? el('span', { classe: 'mat-emplacement', texte: `📍 ${texteEmplacement(f)}` }) : null),
        el('span', { classe: 'mat-etats' },
          f.statut !== 'En service' ? el('span', { classe: `mat-pastille statut-${normaliser(f.statut).replace(/\W+/g, '-')}`, texte: f.statut }) : null,
          el('span', { classe: `mat-pastille rev-${e.retard ? 'retard' : e.bientot ? 'bientot' : 'ok'}`, texte: e.retard ? 'À contrôler' : e.bientot ? 'Bientôt' : 'À jour' }),
          attente.has(f.id) ? el('span', { classe: 'mat-pastille attente', texte: 'En attente d\'envoi' }) : null),
        peutControler() ? el('button', { type: 'button', classe: 'cfg-mini', texte: 'Faire le contrôle', surclick: () => ouvrirGlycemie(f) }) : null);
    });
    const boutonHisto = el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Historique des contrôles (5 ans) · PDF', surclick: ouvrirHistoriqueGlycemie });
    zone.replaceChildren(ongletsMateriel(), entete, aide, el('div', { classe: 'cfg-actions' }, boutonHisto),
      lignes.length ? el('ul', { classe: 'mat-lignes' }, lignes)
        : el('p', { classe: 'mat-vide', texte: 'Aucun appareil à glycémie en service dans la base du matériel : créez-en un dans l\'onglet Appareils (type ou modèle contenant « glycémie » ou « glucomètre », par exemple « Hémoglucomètre »).' }));
  }

  /** Formulaire du contrôle d'un appareil à glycémie ; lots et péremptions repris du dernier contrôle. */
  function ouvrirGlycemie(f) {
    const prec = dernierLotsGlycemie();
    const lot = (valeur, libelle) => el('input', { type: 'text', maxlength: '40', autocomplete: 'off', valeur, 'aria-label': libelle });
    const peremption = (valeur, libelle) => el('input', { type: 'date', valeur, 'aria-label': libelle });
    const date = el('input', { type: 'date', valeur: aujourdhui(), max: aujourdhui(), required: true });
    const lotBandelettes = lot(prec.bandelettes.lot, 'N° de lot des bandelettes');
    const perBandelettes = peremption(prec.bandelettes.peremption, 'Péremption des bandelettes');
    const lotSolutions = lot(prec.solutions.lot, 'N° de lot des solutions test');
    const perSolutions = peremption(prec.solutions.peremption, 'Péremption des solutions test');
    const unite = el('select', { 'aria-label': 'Unité' }, ['g/L', 'mmol/L', 'mg/dL'].map((u) => el('option', { value: u, texte: u, selected: u === prec.unite })));
    const mesure = (libelle) => el('input', { type: 'number', inputmode: 'decimal', step: 'any', min: '0', required: true, 'aria-label': libelle });
    const bas = mesure('Valeur du contrôle bas');
    const haut = mesure('Valeur du contrôle haut');
    const anomalie = el('input', { type: 'checkbox' });
    const commentaires = el('textarea', { rows: '3', maxlength: '300', placeholder: 'Commentaires (facultatif ; obligatoire si anomalie)' });
    const message = el('p', { classe: 'message erreur', role: 'alert' });
    const jolie = (iso) => (iso ? dateFr(iso) : '—');
    let d;
    const contenu = el('form', {
      classe: 'mat-form', novalidate: true,
      sursubmit: (ev) => {
        ev.preventDefault();
        if (!date.value) { message.textContent = 'La date est obligatoire.'; return; }
        const manque = [
          [lotBandelettes, 'le n° de lot des bandelettes'], [perBandelettes, 'la péremption des bandelettes'],
          [lotSolutions, 'le n° de lot des solutions test'], [perSolutions, 'la péremption des solutions test'],
        ].find(([champSaisie]) => !String(champSaisie.value).trim());
        if (manque) { message.textContent = `Renseignez ${manque[1]}.`; manque[0].focus(); return; }
        const valeurs = [bas, haut].map((c) => parseFloat(String(c.value).replace(',', '.')));
        const mauvaise = valeurs.findIndex((v) => !Number.isFinite(v) || v < 0);
        if (mauvaise >= 0) { message.textContent = `Saisissez la valeur du contrôle ${mauvaise === 0 ? 'bas' : 'haut'}.`; [bas, haut][mauvaise].focus(); return; }
        const remarque = commentaires.value.trim();
        if (anomalie.checked && !remarque) { message.textContent = 'Décrivez l\'anomalie dans les commentaires.'; commentaires.focus(); return; }
        const resume = anomalie.checked ? 'valeurs de contrôle hors tolérance ou autre anomalie' : '';
        const details = [
          LIBELLE_GLYCEMIE, `Résultat : ${anomalie.checked ? 'anomalie' : 'conforme'}`,
          `Bandelettes : lot ${lotBandelettes.value.trim()} · péremption ${jolie(perBandelettes.value)}`,
          `Solutions test : lot ${lotSolutions.value.trim()} · péremption ${jolie(perSolutions.value)}`,
          `Contrôle bas : ${nombreFr(valeurs[0])} ${unite.value}`, `Contrôle haut : ${nombreFr(valeurs[1])} ${unite.value}`,
          remarque ? `Commentaires : ${remarque}` : '',
        ].filter(Boolean).join('\n');
        d.close();
        enfiler('realiserMaintenance', {
          date: date.value, libelle: LIBELLE_GLYCEMIE, observation: '',
          controles: [{ materiel: f.id, plan: '', conforme: !anomalie.checked, observation: resume, prochaine: '', details, signaler: false }],
        });
        if (anomalie.checked) proposerSignalementMonnal(f, resume, remarque, 'du contrôle de l\'appareil à glycémie', 'l\'appareil');
      },
    },
    el('p', { classe: 'aide-question', texte: nomAppareil(f) }),
    champ('Date du contrôle', date),
    el('div', { classe: 'mat-cadre-groupe' }, el('p', { classe: 'mat-libelle', texte: 'Bandelettes' }),
      champ('N° de lot', lotBandelettes), champ('Date de péremption', perBandelettes)),
    el('div', { classe: 'mat-cadre-groupe' }, el('p', { classe: 'mat-libelle', texte: 'Solutions test' }),
      champ('N° de lot', lotSolutions), champ('Date de péremption', perSolutions)),
    prec.bandelettes.lot || prec.solutions.lot ? el('p', { classe: 'aide-question', texte: 'Lots et péremptions repris du dernier contrôle : modifiez-les seulement s\'ils ont changé.' }) : null,
    el('div', { classe: 'mat-cadre-groupe' }, el('p', { classe: 'mat-libelle', texte: 'Valeurs mesurées' }),
      champ('Unité', unite), champ('Contrôle bas', bas), champ('Contrôle haut', haut)),
    el('label', { classe: 'mat-case-libelle' }, anomalie, el('span', { texte: 'Anomalie constatée (valeurs hors tolérance, appareil défectueux…)' })),
    champ('Commentaires', commentaires),
    message,
    el('div', { classe: 'mat-boutons' }, el('button', { type: 'submit', classe: 'principal', texte: 'Enregistrer le contrôle' })));
    d = fenetre(`${LIBELLE_GLYCEMIE} · ${nomAppareil(f)}`, contenu, { large: true });
  }

  /** Bouton « Retirer » d'une entrée de main courante : administrateurs du matériel seulement, jamais pour la création / modification de fiche. */
  function boutonRetirerEntree(i, dialogue, rouvrir) {
    if (!estAdmin() || JOURNAL.includes(i.type)) return null;
    return el('button', {
      type: 'button', classe: 'cfg-mini danger', texte: 'Retirer',
      surclick: () => {
        if (!window.confirm('Retirer cette entrée de l\'historique ?')) return;
        if (i.attente) outils.retirerDeFile(i.idFile);
        else enfiler('supprimerIntervention', { intervention: i.id });
        dialogue().close();
        rouvrir();
      },
    });
  }

  /** Changement rapide de statut : un appui sur le nouveau statut, consigné automatiquement dans la main courante (« Statut : X → Y »). */
  function ouvrirStatut(f) {
    const choix = statuts().filter((n) => n !== 'Réformé' && (n !== 'Prêté' || f.pret));
    let d;
    const contenu = el('div', { classe: 'mat-statut' },
      el('p', { classe: 'aide-question', texte: `Statut actuel : ${f.statut || 'En service'}. Le changement est consigné dans la main courante.` }),
      el('div', { classe: 'mat-boutons', role: 'group', 'aria-label': 'Nouveau statut' }, choix.map((n) => {
        const b = el('button', { type: 'button', classe: `cfg-bouton mat-pastille statut-${normaliser(n).replace(/\W+/g, '-')}`, texte: n,
          disabled: n === (f.statut || 'En service'), style: `background:${couleurStatut(n)}22;color:${couleurStatut(n)}`,
          surclick: () => { d.close(); enfiler('definirSituationMateriel', { materiel: f.id, statut: n, date: aujourdhui(), idSaisie: idFiche() }); } });
        return b;
      })),
      estAdmin() ? el('p', {}, el('button', { type: 'button', classe: 'lien', texte: 'Gérer la liste des statuts', surclick: () => { d.close(); ouvrirStatuts(); } })) : null,
      el('p', { classe: 'aide-question', texte: 'Pour retirer l\'appareil des listings, utilisez « Réformer » dans sa fiche.' }));
    d = fenetre(`Statut · ${nomAppareil(f)}`, contenu);
  }

  /** Présence dans les locaux, prêt à un tiers, matériel à récupérer (tout agent connecté). */
  function ouvrirSituation(f) {
    let d;
    const presence = el('select', { 'aria-label': 'Présence' }, ['Dans les locaux', 'Parti'].map((v) => el('option', { value: v, texte: v, selected: (f.presence || 'Dans les locaux') === v })));
    const lieu = el('select', { 'aria-label': 'Lieu' }, lieux().map((v) => el('option', { value: v, texte: v, selected: f.lieu === v })));
    const pretA = el('input', { type: 'text', maxlength: '80', valeur: f.pretA || '', placeholder: 'Nom ou service (vide = pas prêté)' });
    const recup = el('select', { 'aria-label': 'À récupérer' }, [['', 'Rien à récupérer'], ...aRecuperer().map((v) => [v, v])].map(([v, t]) => el('option', { value: v, texte: t, selected: (f.aRecuperer || '') === v })));
    const precision = el('input', { type: 'text', maxlength: '80', valeur: f.aRecupererPrecision || '', placeholder: 'Quel service ?' });
    const message = el('p', { classe: 'message erreur', role: 'alert' });
    const lieuChamp = champ('Parti où ?', lieu); const precisionChamp = champ('Service où il a été oublié', precision);
    const maj = () => { lieuChamp.hidden = presence.value !== 'Parti'; precisionChamp.hidden = recup.value !== 'Oublié dans un service'; };
    presence.addEventListener('change', maj); recup.addEventListener('change', maj); maj();
    const contenu = el('form', { classe: 'mat-form', novalidate: true, sursubmit: (ev) => {
      ev.preventDefault();
      if (recup.value === 'Oublié dans un service' && !precision.value.trim()) { message.textContent = 'Dans quel service l\'appareil a-t-il été oublié ?'; return; }
      d.close();
      enfiler('definirSituationMateriel', { materiel: f.id, presence: presence.value, lieu: presence.value === 'Parti' ? lieu.value : '', pretA: pretA.value.trim(),
        aRecuperer: recup.value, precision: recup.value ? precision.value.trim() : '', date: aujourdhui(), idSaisie: idFiche() });
    } },
    champ('Présence', presence), lieuChamp, champ('Prêté à', pretA), champ('À récupérer', recup), precisionChamp,
    message, el('div', { classe: 'mat-boutons' }, el('button', { type: 'submit', classe: 'principal', texte: 'Enregistrer' })));
    d = fenetre(`Situation · ${nomAppareil(f)}`, contenu);
  }

  /** Administration de la liste des statuts : ajout, renommage, couleur, suppression (les six de base sont verrouillés). */
  function ouvrirStatuts() {
    let d;
    let lignes = statutsDetail().map((x) => ({ ...x }));
    const zone = el('div', { classe: 'mat-statuts-liste' });
    const message = el('p', { classe: 'message erreur', role: 'alert' });
    const dessiner = () => zone.replaceChildren(...lignes.map((x, i) => el('div', { classe: 'mat-statut-ligne' },
      el('input', { type: 'color', valeur: x.couleur, 'aria-label': `Couleur de ${x.nom || 'nouveau statut'}`, surchange: (e) => { x.couleur = e.target.value; } }),
      el('input', { type: 'text', valeur: x.nom, maxlength: '30', readOnly: x.verrouille, 'aria-label': 'Nom du statut', surinput: (e) => { x.nom = e.target.value; } }),
      el('button', { type: 'button', classe: 'cfg-mini', texte: '↑', disabled: i === 0, 'aria-label': 'Monter', surclick: () => { [lignes[i - 1], lignes[i]] = [lignes[i], lignes[i - 1]]; dessiner(); } }),
      x.verrouille ? el('span', { classe: 'aide-question', texte: 'de base' }) : el('button', { type: 'button', classe: 'cfg-mini', texte: 'Retirer', surclick: () => { lignes.splice(i, 1); dessiner(); } }))));
    dessiner();
    const contenu = el('div', { classe: 'mat-form' },
      el('p', { classe: 'aide-question', texte: 'Les statuts de base ne se renomment ni ne se retirent ; leur couleur est modifiable. Un statut encore utilisé par un appareil ne peut pas être retiré.' }),
      zone,
      el('button', { type: 'button', classe: 'cfg-mini', texte: '+ Ajouter un statut', surclick: () => { lignes.push({ nom: '', couleur: '#2563eb', verrouille: false }); dessiner(); } }),
      message,
      el('div', { classe: 'mat-boutons' }, el('button', { type: 'button', classe: 'principal', texte: 'Enregistrer', surclick: () => {
        const utiles = lignes.filter((x) => x.nom.trim()).map((x) => ({ nom: x.nom.trim(), couleur: x.couleur }));
        if (new Set(utiles.map((x) => normaliser(x.nom))).size !== utiles.length) { message.textContent = 'Deux statuts portent le même nom.'; return; }
        const utilises = new Set(fiches().map((f) => normaliser(f.statut)));
        const retire = statutsDetail().find((x) => !utiles.some((u) => normaliser(u.nom) === normaliser(x.nom)) && utilises.has(normaliser(x.nom)));
        if (retire) { message.textContent = `« ${retire.nom} » est encore utilisé : changez d'abord le statut des appareils concernés.`; return; }
        d.close();
        if (donnees) { donnees.statutsDetail = utiles.map((u) => ({ ...u, verrouille: u.nom in COULEURS_STATUT })); donnees.statuts = utiles.map((u) => u.nom); ecrireCache(donnees); }
        enfiler('enregistrerStatutsMateriel', { statuts: utiles });
      } })));
    d = fenetre('Statuts du matériel', contenu);
  }

  /** Main courante de l'appareil depuis l'action rapide (« Retirer » réservé aux administrateurs du matériel). */
  function rapideHistorique(id) {
    const { fiches: toutes, interventions } = etat();
    const f = toutes.find((x) => x.id === id);
    if (!f) return;
    const historique = interventions.filter((i) => i.materiel === f.id)
      .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.saisiLe || '').localeCompare(String(a.saisiLe || '')));
    let d;
    const contenu = el('div', {},
      historique.length ? el('ol', { classe: 'mat-historique' }, historique.map((i) => el('li', { classe: i.attente ? 'attente' : '' },
        el('p', { classe: 'mat-histo-tete' }, el('strong', { texte: i.type === 'Évènement' && i.evenement ? i.evenement : i.type }),
          i.maintenance ? el('span', { texte: ` · ${i.maintenance}` }) : null, el('span', { texte: ` · ${dateFr(i.date)}` }),
          i.intervenant ? el('span', { texte: ` · ${i.intervenant}` }) : null,
          i.attente ? el('span', { classe: 'mat-pastille attente', texte: 'En attente d\'envoi' }) : null),
        i.description ? el('p', { classe: 'mat-histo-texte', texte: i.description, style: 'white-space: pre-line' }) : null,
        i.photo || i.photoDonnees ? photoEntree(i) : null,
        i.saisiPar ? el('p', { classe: 'mat-histo-note', texte: `Saisi par ${i.saisiPar}` }) : null,
        boutonRetirerEntree(i, () => d, () => rapideHistorique(f.id)))))
        : el('p', { classe: 'mat-vide', texte: 'Aucune entrée pour le moment.' }),
      el('div', { classe: 'mat-boutons' }, boutonRetourRapide({ close: () => d.close() }, f),
        el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Fiche complète', surclick: () => { d.close(); ouvrirFiche(f.id); } })));
    d = fenetre(`Historique · ${nomAppareil(f)}`, contenu, { large: true });
  }

  // ---------- Fenêtres ----------
  function fenetre(titre, contenu, { large = false } = {}) {
    const idTitre = nouvelId();
    const d = el('dialog', { classe: `mat-dialogue${large ? ' large' : ''}`, 'aria-labelledby': idTitre });
    const fermer = () => d.close();
    d.append(el('div', { classe: 'mat-dialogue-entete' },
      el('h2', { id: idTitre, texte: titre }),
      el('button', { type: 'button', classe: 'tiroir-fermer', 'aria-label': 'Fermer', surclick: fermer, texte: '✕' })),
    el('div', { classe: 'mat-dialogue-corps' }, contenu));
    d.addEventListener('close', () => d.remove());
    d.addEventListener('click', (e) => { if (e.target === d) fermer(); });
    document.body.append(d);
    d.showModal();
    return d;
  }

  function champ(libelle, entree, aide) {
    if (!entree.id) entree.id = nouvelId();
    return el('div', { classe: 'champ mat-champ' }, el('label', { for: entree.id, texte: libelle }), aide ? el('p', { classe: 'aide-question', texte: aide }) : null, entree);
  }
  function selectListe(valeurs, courant, libre) {
    const options = [...valeurs];
    if (courant && !options.includes(courant)) options.push(courant);
    return el('select', {}, libre ? el('option', { value: '', texte: '—' }) : null, options.map((v) => el('option', { value: v, texte: v, selected: v === courant })));
  }

  /**
   * Type de matériel : liste déroulante de tous les types, plus « Autre (nouveau type)… »
   * qui affiche un champ libre. (Une liste de suggestions se filtrait sur la saisie et masquait des choix.)
   */
  function champType(courant) {
    const AUTRE = '__autre__';
    const select = el('select', {},
      types().map((t) => el('option', { value: t, texte: t, selected: t === courant })),
      el('option', { value: AUTRE, texte: 'Autre (nouveau type)…' }));
    if (!courant) select.value = types()[0];
    const libre = el('input', { placeholder: 'Nom du nouveau type', 'aria-label': 'Nouveau type de matériel' });
    const bloc = el('div', { classe: 'mat-type-libre' }, libre);
    const maj = () => { bloc.hidden = select.value !== AUTRE; if (!bloc.hidden) libre.focus(); };
    select.addEventListener('change', maj);
    bloc.hidden = true;
    return { select, libre, bloc, valeur: () => (select.value === AUTRE ? libre.value.trim() : select.value) };
  }

  /** Fiche d'un appareil : consultation, puis modification (administrateurs). id null = création. */
  function ouvrirFiche(id, edition = false, modele = null) {
    const { fiches: toutes, interventions } = etat();
    const f = id ? toutes.find((x) => x.id === id) : null;
    if (id && !f) return;
    if (edition || !f) { ouvrirEdition(f, modele); return; }

    const rev = etatRevision(f);
    const historique = interventions.filter((i) => i.materiel === f.id).sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.saisiLe).localeCompare(String(a.saisiLe)));
    const ligneInfo = (t, v) => [el('dt', { texte: t }), el('dd', { texte: v || '—' })];
    let d;
    const contenu = el('div', { classe: 'mat-fiche' },
      aPhoto(f) ? vignette(f, 'mat-photo') : null,
      el('dl', { classe: 'mat-infos' },
        f.pret ? ligneInfo('Matériel de prêt', `${f.pret} · propriétaire : ${f.proprietaire || '—'}`) : null,
        ligneInfo('Matériel type', f.modeleType ? nomModele(modeleDe(f.modeleType)) : 'Non (matériel unique)'),
        ligneInfo('Dernier emplacement', texteEmplacement(f) || 'Jamais pointé dans un inventaire'),
        ligneInfo('Type', f.type), ligneInfo('Modèle', f.modele), ligneInfo('N° interne SMUR', f.numInterne),
        ligneInfo('N° biomed', f.biomed ? f.numBiomed : 'Sans n° biomed'), ligneInfo('N° de série', f.numSerie), ligneInfo('Statut', f.statut),
        f.maintenance ? (f.plans.length ? f.plans.flatMap((p) => ligneInfo(p.libelle, `${p.prochaine ? `prochaine le ${dateFr(p.prochaine)}` : 'échéance non renseignée'}${p.periodicite ? ` · ${textePeriode(p)}` : ''}`)) : ligneInfo('Maintenance préventive', 'Aucune maintenance définie'))
          : ligneInfo('Maintenance préventive', 'Non'),
        f.logiciel ? ligneInfo('Version logiciel', f.versionLogiciel) : null,
        ligneInfo('Traceur GeoTraceSMUR', f.traceur ? `Oui${f.nomTraceur ? ` (${f.nomTraceur})` : ''}` : 'Non'),
        f.remarques ? ligneInfo('Remarques', f.remarques) : null),
      el('p', { classe: `mat-pastille rev-${rev.classe} mat-rev-fiche`, texte: rev.texte }),
      estAdmin() ? el('div', { classe: 'mat-boutons' },
        el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Modifier la fiche', surclick: () => { d.close(); ouvrirEdition(f); } }),
        el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Ajouter à la main courante', title: 'Révision, intervention, réparation, mise à jour logicielle, note…', surclick: () => { d.close(); ouvrirIntervention([f.id]); } }),
        el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Encoder une puce NFC', surclick: () => { d.close(); ouvrirNfc(f); } }),
        f.modeleType
          ? el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Ouvrir le matériel type', surclick: () => { d.close(); ouvrirModele(modeleDe(f.modeleType)); } })
          : el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Créer un matériel type', title: 'Fiche type reprenant le type, le modèle, la périodicité et la photo de cet appareil', surclick: () => { d.close(); ouvrirModele(null, f); } }),
        el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Dupliquer', title: 'Nouvel appareil du même type et du même modèle', surclick: () => { d.close(); ouvrirEdition(null, f); } }),
        f.statut === 'Réformé'
          ? el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Remettre en service', surclick: () => { d.close(); ouvrirRemiseEnService(f); } })
          : el('button', { type: 'button', classe: 'cfg-bouton danger', texte: 'Réformer', title: 'Retire définitivement l\'appareil des listings (historique conservé)', surclick: () => { d.close(); ouvrirReforme(f); } })) : null,
      blocEvenements(f, historique, () => d),
      el('h3', { texte: 'Main courante de l\'appareil' }),
      el('p', { classe: 'aide-question', texte: 'Création et modifications de la fiche (consignées automatiquement), révisions, interventions, réparations et notes.' }),
      historique.length ? el('ol', { classe: 'mat-historique' }, historique.map((i) => el('li', { classe: i.attente ? 'attente' : '' },
        el('p', { classe: 'mat-histo-tete' }, el('strong', { texte: i.type === 'Évènement' && i.evenement ? i.evenement : i.type }), i.maintenance ? el('span', { texte: ` · ${i.maintenance}` }) : null, el('span', { texte: ` · ${dateFr(i.date)}` }),
          i.intervenant ? el('span', { texte: ` · ${i.intervenant}` }) : null, i.attente ? el('span', { classe: 'mat-pastille attente', texte: 'En attente d\'envoi' }) : null),
        i.description ? el('p', { classe: 'mat-histo-texte', texte: i.description, style: 'white-space: pre-line' }) : null,
        i.prochaineRevision ? el('p', { classe: 'mat-histo-note', texte: `Prochaine échéance${i.maintenance ? ` (${i.maintenance})` : ''} fixée au ${dateFr(i.prochaineRevision)}` }) : null,
        el('p', { classe: 'mat-histo-note', texte: i.saisiPar ? `Saisi par ${i.saisiPar}` : '' }),
        boutonRetirerEntree(i, () => d, () => ouvrirFiche(f.id))))) : el('p', { classe: 'mat-vide', texte: 'Aucune entrée pour le moment.' }));
    d = fenetre(nomAppareil(f), contenu, { large: true });
  }

  // ---------- Réforme ----------
  /** Réforme d'un appareil : statut « Réformé » + entrée de main courante. Il disparaît des listings, des inventaires et du suivi traceur. */
  function ouvrirReforme(f) {
    const date = el('input', { type: 'date', valeur: aujourdhui(), max: aujourdhui(), required: true });
    const motif = selectListe(MOTIFS_REFORME, MOTIFS_REFORME[0]);
    const texte = el('textarea', { rows: '3', placeholder: 'Précisions : n° de bon de réforme biomed, appareil de remplacement, devenir de l\'appareil…' });
    const message = el('p', { classe: 'message erreur', role: 'alert' });
    let d;
    const contenu = el('form', {
      classe: 'mat-form', novalidate: true,
      sursubmit: (ev) => {
        ev.preventDefault();
        if (!date.value) { message.textContent = 'La date est obligatoire.'; return; }
        if (motif.value === 'Autre' && !texte.value.trim()) { message.textContent = 'Précisez le motif.'; return; }
        d.close();
        enfiler('enregistrerMateriel', { fiches: [{ ...f, statut: 'Réformé' }] });
        enfiler('ajouterIntervention', { materiels: [f.id], date: date.value, type: 'Réforme', description: [`Motif : ${motif.value}`, texte.value.trim()].filter(Boolean).join('\n'), intervenant: '', prochaineRevision: '' });
      },
    },
    el('p', { classe: 'aide-question', texte: `${nomAppareil(f)} n'apparaîtra plus dans la liste du matériel, les inventaires, les interventions groupées ni le suivi des traceurs. Sa fiche et sa main courante restent consultables via le filtre « Réformés et archivés ». Son n° interne, son n° biomed et son n° de série redeviennent disponibles.` }),
    f.traceur ? el('p', { classe: 'aide-question', texte: `Pensez à retirer le traceur${f.nomTraceur ? ` ${f.nomTraceur}` : ''} de l'appareil.` }) : null,
    el('div', { classe: 'mat-grille' }, champ('Date de réforme', date), champ('Motif', motif)),
    champ('Précisions', texte),
    message,
    el('div', { classe: 'mat-boutons' }, el('button', { type: 'submit', classe: 'principal danger', texte: 'Réformer l\'appareil' })));
    d = fenetre(`Réformer ${nomAppareil(f)}`, contenu);
  }

  function ouvrirRemiseEnService(f) {
    const doublon = verifierDoublons([{ ...f, statut: 'En service' }]);
    if (doublon) { window.alert(`Remise en service impossible : ${doublon} Modifiez d'abord les numéros de l'appareil.`); return; }
    if (!window.confirm(`Remettre ${nomAppareil(f)} en service ?`)) return;
    enfiler('enregistrerMateriel', { fiches: [{ ...f, statut: 'En service' }] });
    enfiler('ajouterIntervention', { materiels: [f.id], date: aujourdhui(), type: 'Remise en service', description: 'Annulation de la réforme', intervenant: '', prochaineRevision: '' });
  }

  /** Formulaire de création / modification. `modele` : fiche dont on part pour « Dupliquer ». */
  function ouvrirEdition(f, modele = null) {
    const base = f || {
      id: idFiche(), type: (modele && modele.type) || filtre.type || TYPES_DEFAUT[0], modele: (modele && modele.modele) || '',
      numInterne: '', numBiomed: '', numSerie: '', plans: modele ? (modele.plans || []).map((p) => ({ ...p, prochaine: '' })) : [{ id: 'rev', libelle: 'Révision', periodicite: 12, prochaine: '' }],
      statut: 'En service', traceur: false, nomTraceur: '', remarques: '', archive: false,
      photo: (modele && modele.photo) || '', photoDonnees: (modele && modele.photoDonnees) || '',
      modeleType: (modele && modele.modeleType) || '',
      biomed: modele ? modele.biomed !== false : true, maintenance: modele ? modele.maintenance !== false : true,
      logiciel: Boolean(modele && modele.logiciel), versionLogiciel: (modele && modele.versionLogiciel) || '',
    };
    const message = el('p', { classe: 'message erreur', role: 'alert' });
    const listeModeles = el('datalist', { id: nouvelId() }, [...new Set(fiches().map((x) => x.modele).filter(Boolean))].map((m) => el('option', { value: m })));
    // Matériel type : la fiche type fournit le type, le modèle et la périodicité (champs alors verrouillés).
    const choixModele = el('select', {},
      el('option', { value: '', texte: '— Aucun : matériel unique —' }),
      modeles().filter((m) => !m.archive || m.id === base.modeleType).sort((a, b) => nomModele(a).localeCompare(nomModele(b), 'fr'))
        .map((m) => el('option', { value: m.id, texte: nomModele(m), selected: m.id === base.modeleType })));
    const aideModele = el('p', { classe: 'aide-question' });
    const e = {
      type: champType(base.type),
      modele: el('input', { valeur: base.modele, list: listeModeles.id, placeholder: 'ex. Corpuls3, Hamilton T1, Alaris GH…' }),
      numInterne: el('input', { valeur: base.numInterne, inputmode: 'numeric', placeholder: '1, 2, 3…' }),
      numBiomed: el('input', { valeur: base.numBiomed }),
      numSerie: el('input', { valeur: base.numSerie, placeholder: 'Facultatif' }),
      plans: editeurPlans(base.plans || plansDe(base), { avecDate: true }),
      biomed: el('input', { type: 'checkbox', coche: base.biomed !== false }),
      maintenance: el('input', { type: 'checkbox', coche: base.maintenance !== false }),
      logiciel: el('input', { type: 'checkbox', coche: base.logiciel === true }),
      versionLogiciel: el('input', { valeur: base.versionLogiciel || '', placeholder: 'ex. 2.4.1' }),
      statut: selectListe(statuts(), base.statut),
      traceur: el('input', { type: 'checkbox', coche: base.traceur }),
      remarques: el('textarea', { rows: '3', valeur: base.remarques }),
    };
    // Photo : une nouvelle photo (prise ou choisie) remplace l'ancienne ; « Retirer » la supprime de la fiche.
    let photo = { id: base.photo || '', donnees: base.photoDonnees || '' };
    const apercu = el('img', { classe: 'mat-photo', alt: 'Photo du matériel', hidden: true });
    const afficherApercu = async () => {
      const src = photo.donnees || (photo.id ? await imageDe({ photo: photo.id }) : '');
      apercu.hidden = !src;
      if (src) apercu.src = src;
      boutonRetirer.hidden = !src;
      boutonRecadrer.hidden = !src;
    };
    const fichierPhoto = el('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
    const boutonRetirer = el('button', { type: 'button', classe: 'cfg-bouton danger', texte: 'Retirer la photo', hidden: true, surclick: () => { photo = { id: '', donnees: '' }; afficherApercu(); } });
    const boutonRecadrer = el('button', { type: 'button', classe: 'cfg-bouton', texte: '✂ Recadrer', hidden: true, surclick: async () => {
      if (!apercu.src) return;
      try { const d = await reduirePhoto(apercu.src); if (!d) return; photo = { id: '', donnees: d }; message.textContent = ''; } catch (err) { message.textContent = 'Photo illisible ou trop lourde.'; }
      afficherApercu();
    } });
    fichierPhoto.addEventListener('change', async () => {
      const fichier = fichierPhoto.files[0];
      fichierPhoto.value = '';
      if (!fichier) return;
      try { const d = await reduirePhoto(fichier); if (!d) return; photo = { id: '', donnees: d }; message.textContent = ''; } catch (err) { message.textContent = 'Photo illisible ou trop lourde.'; }
      afficherApercu();
    });
    const blocPhoto = el('div', { classe: 'mat-photo-bloc' }, el('p', { classe: 'mat-libelle', texte: 'Photo du matériel' }), apercu,
      el('div', { classe: 'mat-boutons' },
        el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Prendre ou choisir une photo', surclick: () => fichierPhoto.click() }), boutonRecadrer, boutonRetirer, fichierPhoto));
    // Nom du traceur choisi dans la liste de GeoTraceSMUR (traceurs.js) : liaison exacte avec l'onglet du traceur.
    let nomTraceur = base.nomTraceur || '';
    const choixTraceur = typeof Traceurs !== 'undefined' && outils.appeler
      ? Traceurs.champ({ appeler: outils.appeler, valeur: nomTraceur, proprietaire: { genre: 'materiel', id: base.id }, surchange: (n) => { nomTraceur = n; } })
      : (() => { const i = el('input', { valeur: nomTraceur, placeholder: 'Nom du traceur dans GeoTraceSMUR' }); i.addEventListener('change', () => { nomTraceur = i.value.trim(); }); return i; })();
    const blocTraceur = el('div', { classe: 'champ mat-champ' }, el('span', { classe: 'mat-libelle', texte: 'Traceur GeoTraceSMUR' }), choixTraceur);
    const majModele = () => {
      const m = modeleDe(choixModele.value);
      if (m) {
        if (![...e.type.select.options].some((o) => o.value === m.type)) e.type.select.prepend(el('option', { value: m.type, texte: m.type }));
        e.type.select.value = m.type;
        e.type.bloc.hidden = true;
        e.modele.value = m.modele;
        e.biomed.checked = m.biomed !== false;
        e.maintenance.checked = m.maintenance !== false;
        e.logiciel.checked = m.logiciel === true;
      }
      [e.type.select, e.modele, e.biomed, e.maintenance, e.logiciel].forEach((x) => { x.disabled = Boolean(m); });
      e.plans.imposer(m ? plansDe(m) : null);
      majOptions();
      const nb = m ? fiches().filter((x) => x.modeleType === m.id && x.id !== base.id).length : 0;
      aideModele.textContent = m
        ? `Type, modèle, options (biomed, maintenance, logiciel) et liste des maintenances viennent du matériel type ; les échéances restent propres à l'appareil (partagé avec ${nb} autre${nb > 1 ? 's' : ''} appareil${nb > 1 ? 's' : ''}) : modifiez-les depuis « Matériels types ».${m.photo || m.photoDonnees ? ' Sans photo propre, l\'appareil affiche celle du matériel type.' : ''}`
        : 'Matériel unique : toutes ses caractéristiques lui sont propres.';
    };
    choixModele.addEventListener('change', majModele);
    // Champs affichés selon les options : n° biomed, révision / périodicité, version logiciel.
    const blocBiomed = champ('N° biomed', e.numBiomed);
    // Étiquette biomed : icône QR code dans le champ (QR code ou code-barres lu par la caméra).
    champAvecScan(e.numBiomed, 'Scanner le QR code biomed', (v) => {
      e.numBiomed.value = v;
      e.numBiomed.dispatchEvent(new Event('input'));
      message.textContent = verifierDoublons([{ ...lire(), numBiomed: v }]) || '';
    });
    const blocPlans = el('div', { classe: 'champ mat-champ' }, el('span', { classe: 'mat-libelle', texte: 'Maintenances préventives' }), e.plans.bloc);
    const blocVersion = champ('Version logiciel', e.versionLogiciel);
    function majOptions() {
      blocBiomed.hidden = !e.biomed.checked;
      blocPlans.hidden = !e.maintenance.checked;
      blocVersion.hidden = !e.logiciel.checked;
    }
    [e.biomed, e.maintenance, e.logiciel].forEach((x) => x.addEventListener('change', majOptions));
    const caseOption = (entree, texte) => el('label', { classe: 'mat-case-libelle' }, entree, el('span', { texte }));
    const majTraceur = () => { blocTraceur.hidden = !e.traceur.checked; };
    e.traceur.addEventListener('change', majTraceur);
    majTraceur();
    let d;

    const lire = () => ({
      ...base,
      type: e.type.valeur(), modele: e.modele.value.trim(), numInterne: e.numInterne.value.trim(), numBiomed: e.numBiomed.value.trim(),
      numSerie: e.numSerie.value.trim(), plans: e.plans.valeur(),
      statut: e.statut.value, traceur: e.traceur.checked, nomTraceur: e.traceur.checked ? nomTraceur.trim() : '', remarques: e.remarques.value.trim(),
      photo: photo.donnees ? '' : photo.id, photoDonnees: photo.donnees,
      modeleType: choixModele.value,
      biomed: e.biomed.checked, maintenance: e.maintenance.checked, logiciel: e.logiciel.checked, versionLogiciel: e.versionLogiciel.value.trim(),
    });

    function enregistrer(fiche) {
      options(fiche);
      const conflit = verifierDoublons([fiche]);
      if (conflit) { message.textContent = conflit; return; }
      if (!fiche.type) { message.textContent = 'Le type est obligatoire.'; return; }
      const changes = f ? Object.keys(REPERCUTABLES).filter((k) => !(fiche.modeleType && COMMUNS.includes(k))).filter((k) => (k === 'photo'
        ? `${f.photo || ''}|${f.photoDonnees || ''}` !== `${fiche.photo || ''}|${fiche.photoDonnees || ''}`
        : (BOOLEENS.includes(k) ? Boolean(f[k]) !== Boolean(fiche[k]) : (k === 'plans' ? JSON.stringify(f.plans || []) !== JSON.stringify(fiche.plans || []) : String(f[k] ?? '') !== String(fiche[k] ?? ''))))) : [];
      d.close();
      const autres = fiches().filter((x) => x.id !== fiche.id && enService(x) && (x.type === (f ? f.type : fiche.type) || (fiche.modele && x.modele === fiche.modele)));
      if (changes.length && autres.length) proposerRepercussion(fiche, f, changes, autres);
      else enfiler('enregistrerMateriel', { fiches: [fiche] });
    }

    const contenu = el('form', {
      classe: 'mat-form', novalidate: true,
      sursubmit: (ev) => { ev.preventDefault(); enregistrer(lire()); },
    },
    listeModeles,
    champ('Matériel type', choixModele),
    aideModele,
    el('div', { classe: 'mat-grille' },
      champ('Type de matériel', e.type.select),
      e.type.bloc,
      champ('Modèle', e.modele),
      champ('N° interne SMUR', e.numInterne),
      champ('N° de série (facultatif)', e.numSerie),
      champ('Statut', e.statut)),
    el('fieldset', { classe: 'mat-cadre' }, el('legend', { texte: 'Suivi de l\'appareil' }),
      caseOption(e.biomed, 'Muni d\'un n° biomed'),
      caseOption(e.maintenance, 'Fait l\'objet d\'une maintenance préventive'),
      caseOption(e.logiciel, 'Version logiciel à suivre'),
      el('div', { classe: 'mat-grille' }, blocBiomed, blocVersion),
      blocPlans),
    el('label', { classe: 'mat-case-libelle' }, e.traceur, el('span', { texte: 'Muni d\'un traceur GeoTraceSMUR' })),
    blocTraceur,
    blocPhoto,
    champ('Remarques', e.remarques),
    message,
    el('div', { classe: 'mat-boutons' },
      el('button', { type: 'submit', classe: 'principal', texte: f ? 'Enregistrer' : 'Créer l\'appareil' }),
      f ? el('button', {
        type: 'button', classe: 'cfg-bouton danger', texte: f.archive ? 'Désarchiver' : 'Archiver',
        title: 'Un appareil archivé disparaît des listes mais garde son historique',
        surclick: () => { if (f.archive || window.confirm(`Archiver ${nomAppareil(f)} ?`)) { d.close(); enfiler('enregistrerMateriel', { fiches: [{ ...f, archive: !f.archive }] }); } },
      }) : null,
      f ? el('button', {
        type: 'button', classe: 'cfg-bouton danger', texte: 'Supprimer',
        title: 'Efface l\'appareil et sa main courante de l\'application (erreur de saisie, doublon…)',
        surclick: () => { if (supprimerAppareils([f])) d.close(); },
      }) : null));
    d = fenetre(f ? `Modifier ${nomAppareil(f)}` : 'Nouveau matériel', contenu, { large: true });
    majModele();
    afficherApercu();
  }

  /** Même contrôle que le serveur, pour prévenir tout de suite (y compris hors ligne). */
  function verifierDoublons(nouvelles, modelesModifies = []) {
    const tousModeles = new Map(modeles().map((m) => [m.id, m]));
    modelesModifies.forEach((m) => tousModeles.set(m.id, m));
    const final = new Map(fiches().map((x) => [x.id, x]));
    nouvelles.forEach((x) => final.set(x.id, x));
    [...final.keys()].forEach((id) => final.set(id, resoudre(final.get(id), tousModeles)));
    // Seuls les appareils enregistrés comptent : un doublon déjà présent entre deux autres appareils ne bloque pas.
    const concernes = new Set(nouvelles.map((x) => x.id));
    modelesModifies.forEach((m) => final.forEach((x) => { if (x.modeleType === m.id) concernes.add(x.id); }));
    const vus = new Map();
    for (const x of final.values()) {
      if (!enService(x)) continue; // un réformé libère son n° interne, son n° biomed et son n° de série
      const cles = [];
      if (x.numInterne) cles.push([`i|${normaliser(x.type)}|${normaliser(x.modele)}|${normaliser(x.numInterne)}`, `${nomAppareil(x)} existe déjà.`]);
      if (x.numSerie) cles.push([`s|${normaliser(x.numSerie)}`, `Le n° de série ${x.numSerie} est déjà attribué.`]);
      if (x.numBiomed) cles.push([`b|${normaliser(x.numBiomed)}`, `Le n° biomed ${x.numBiomed} est déjà attribué.`]);
      // Un code (biomed, série ou autre code-barres / QR) ne désigne qu'un seul appareil.
      [x.numBiomed, x.numSerie, ...(x.autresCodes || [])].filter(Boolean).forEach((c) => cles.push([`c|${normaliser(c)}`, `Le code ${c} est déjà attribué à un autre appareil.`]));
      for (const [cle, texte] of cles) {
        const deja = vus.get(cle);
        if (deja && deja !== x.id && (concernes.has(x.id) || concernes.has(deja))) return texte;
        if (!deja || concernes.has(x.id)) vus.set(cle, x.id);
      }
    }
    return '';
  }

  /** Après modification d'une fiche : appliquer les mêmes changements à d'autres appareils ? */
  function proposerRepercussion(fiche, ancienne, changes, autres) {
    const valeur = (k, x) => (k === 'modeleType' ? nomModele(modeleDe(x.modeleType)) : k === 'photo' ? ((x.photo || x.photoDonnees) ? (x.photoDonnees ? 'nouvelle photo' : 'photo') : 'aucune') : BOOLEENS.includes(k) ? (x[k] ? 'Oui' : 'Non') : (k === 'plans' ? (resumePlans(x.plans) || 'aucune') : String(x[k] || '—')));
    const champsCoches = new Set(changes);
    const cibles = new Set(autres.filter((x) => (ancienne.modele && x.modele === ancienne.modele && x.type === ancienne.type)).map((x) => x.id));
    let d;
    const contenu = el('div', { classe: 'mat-repercuter' },
      el('p', { texte: `Vous avez modifié ${nomAppareil(ancienne)}. Appliquer aussi ces changements à d'autres appareils ?` }),
      el('fieldset', { classe: 'mat-cadre' }, el('legend', { texte: 'Changements à répercuter' }),
        changes.map((k) => el('label', { classe: 'mat-case-libelle' },
          el('input', { type: 'checkbox', coche: true, surchange: (ev) => (ev.target.checked ? champsCoches.add(k) : champsCoches.delete(k)) }),
          el('span', {}, el('strong', { texte: REPERCUTABLES[k] }), ` : ${valeur(k, ancienne)} → ${valeur(k, fiche)}`)))),
      el('fieldset', { classe: 'mat-cadre' }, el('legend', { texte: 'Appareils concernés (même modèle pré-cochés)' }),
        el('div', { classe: 'mat-boutons' },
          el('button', { type: 'button', classe: 'cfg-mini', texte: 'Tout cocher', surclick: (ev) => { ev.target.closest('fieldset').querySelectorAll('input[data-id]').forEach((c) => { c.checked = true; cibles.add(c.dataset.id); }); } }),
          el('button', { type: 'button', classe: 'cfg-mini', texte: 'Tout décocher', surclick: (ev) => { ev.target.closest('fieldset').querySelectorAll('input[data-id]').forEach((c) => { c.checked = false; cibles.delete(c.dataset.id); }); } })),
        autres.sort(tri).map((x) => el('label', { classe: 'mat-case-libelle' },
          el('input', { type: 'checkbox', 'data-id': x.id, coche: cibles.has(x.id), surchange: (ev) => (ev.target.checked ? cibles.add(x.id) : cibles.delete(x.id)) }),
          el('span', { texte: nomAppareil(x) })))),
      el('div', { classe: 'mat-boutons' },
        el('button', {
          type: 'button', classe: 'principal', texte: 'Enregistrer et répercuter',
          surclick: () => {
            const lot = [fiche, ...autres.filter((x) => cibles.has(x.id)).map((x) => {
              const copie = { ...x };
              champsCoches.forEach((k) => {
                copie[k] = k === 'plans' ? fiche.plans.map((p) => ({ ...p })) : fiche[k];
                if (k === 'photo') copie.photoDonnees = fiche.photoDonnees;
                if (k === 'traceur' && !fiche.traceur) copie.nomTraceur = '';
              });
              return options(copie);
            })];
            const conflit = verifierDoublons(lot);
            if (conflit) { window.alert(conflit); return; }
            d.close();
            enfiler('enregistrerMateriel', { fiches: lot });
          },
        }),
        el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Seulement cet appareil', surclick: () => { d.close(); enfiler('enregistrerMateriel', { fiches: [fiche] }); } })));
    d = fenetre('Répercuter les modifications', contenu, { large: true });
  }

  /** Modifier plusieurs appareils sélectionnés : seuls les champs cochés sont appliqués. */
  function ouvrirModifGroupee(ids) {
    const cibles = fiches().filter((x) => ids.includes(x.id));
    if (!cibles.length) return;
    const premier = cibles[0];
    const commun = (k) => (cibles.every((x) => String(x[k] ?? '') === String(premier[k] ?? '')) ? premier[k] : '');
    const entrees = {
      modeleType: selectListe([], ''),
      type: champType(commun('type')),
      modele: el('input', { valeur: commun('modele') }),
      statut: selectListe(statuts(), commun('statut') || 'En service'),
      traceur: el('input', { type: 'checkbox', coche: Boolean(commun('traceur')) }),
      biomed: el('input', { type: 'checkbox', coche: commun('biomed') !== false }),
      maintenance: el('input', { type: 'checkbox', coche: commun('maintenance') !== false }),
      logiciel: el('input', { type: 'checkbox', coche: Boolean(commun('logiciel')) }),
      versionLogiciel: el('input', { valeur: commun('versionLogiciel') || '' }),
      remarques: el('textarea', { rows: '2', valeur: commun('remarques') }),
    };
    entrees.modeleType = el('select', {}, el('option', { value: '', texte: '— Aucun : matériel unique —' }),
      modeles().filter((m) => !m.archive).map((m) => el('option', { value: m.id, texte: nomModele(m), selected: m.id === commun('modeleType') })));
    const actifs = new Set();
    let d;
    const contenu = el('div', { classe: 'mat-groupee' },
      el('p', { texte: `${cibles.length} appareil(s) : ${cibles.sort(tri).map(nomAppareil).join(', ')}.` }),
      el('p', { classe: 'aide-question', texte: 'Cochez les champs à modifier : seuls ceux-là seront appliqués à tous les appareils sélectionnés. Les numéros (interne, biomed, série) restent propres à chaque appareil. Pour un appareil rattaché à un matériel type, le type, le modèle et la périodicité viennent du matériel type.' }),
      Object.keys(REPERCUTABLES).filter((k) => k !== 'photo' && k !== 'plans').map((k) => {
        const ch = entrees[k];
        const entree = k === 'type' ? ch.select : ch;
        entree.id = nouvelId();
        const activer = (oui) => { entree.disabled = !oui; if (k === 'type') ch.libre.disabled = !oui; };
        activer(false);
        return el('div', { classe: 'mat-ligne-groupee' },
          el('input', {
            type: 'checkbox', 'aria-label': `Modifier : ${REPERCUTABLES[k]}`,
            surchange: (ev) => { activer(ev.target.checked); if (ev.target.checked) actifs.add(k); else actifs.delete(k); },
          }),
          el('label', { for: entree.id, texte: REPERCUTABLES[k] }), k === 'type' ? el('div', {}, entree, ch.bloc) : entree);
      }),
      el('div', { classe: 'mat-boutons' },
        el('button', {
          type: 'button', classe: 'principal', texte: 'Appliquer',
          surclick: () => {
            if (!actifs.size) { window.alert('Cochez au moins un champ à modifier.'); return; }
            const lot = cibles.map((x) => {
              const copie = { ...x };
              actifs.forEach((k) => {
                const ent = entrees[k];
                copie[k] = k === 'type' ? ent.valeur() : k === 'modeleType' ? ent.value : BOOLEENS.includes(k) ? ent.checked : ent.value.trim();
                if (k === 'traceur' && !ent.checked) copie.nomTraceur = '';
              });
              return options(copie);
            });
            if (lot.some((x) => !x.type)) { window.alert('Le type ne peut pas être vide.'); return; }
            const conflit = verifierDoublons(lot);
            if (conflit) { window.alert(conflit); return; }
            d.close();
            enfiler('enregistrerMateriel', { fiches: lot });
          },
        })));
    d = fenetre('Modifier la sélection', contenu, { large: true });
  }

  /** Révision / intervention / réparation pour un ou plusieurs appareils. */
  /** options : { type, plan } pré-choisis (icône « acquitter une maintenance » de la liste). */
  function ouvrirIntervention(ids, options = {}) {
    const toutes = fiches().filter(enService);
    const cibles = new Set(ids);
    const e = {
      date: el('input', { type: 'date', valeur: aujourdhui(), max: aujourdhui(), required: true }),
      type: selectListe(typesIntervention(), options.type || 'Révision'),
      description: el('textarea', { rows: '3', placeholder: 'Travaux réalisés, pièces changées, panne constatée…' }),
      intervenant: el('input', { placeholder: 'Biomed, fabricant, prestataire…' }),
      prochaine: el('input', { type: 'date' }),
      plan: el('select', {}),
    };
    const aide = el('p', { classe: 'aide-question' });
    /** Maintenances proposées : plans communs à tous les appareils choisis (même identifiant, ex. même matériel type). */
    function majPlans() {
      const choisis = toutes.filter((x) => cibles.has(x.id));
      const avant = e.plan.value;
      const communs = choisis.length ? (choisis[0].plans || []).filter((p) => choisis.every((x) => (x.plans || []).some((q) => q.id === p.id))) : [];
      e.plan.replaceChildren(el('option', { value: '', texte: '— Aucune —' }), ...communs.map((p) => el('option', { value: p.id, texte: `${p.libelle}${p.periodicite ? ` (${courtePeriode(p)})` : ''}` })));
      if (communs.some((p) => p.id === avant)) e.plan.value = avant;
      else if (communs.length === 1 && ['Révision', 'Contrôle', 'Intervention'].includes(e.type.value)) e.plan.value = communs[0].id;
      blocPlan.hidden = !communs.length;
    }
    /** Prochaine échéance proposée = date + périodicité de la maintenance choisie. */
    function proposerProchaine() {
      const choisis = toutes.filter((x) => cibles.has(x.id));
      const plan = e.plan.value && (choisis[0].plans || []).find((p) => p.id === e.plan.value);
      if (plan && (plan.periodicite || plan.cycle) && e.date.value) {
        // Cycle fixe : on avance au-delà de l'échéance en cours si la maintenance est faite en avance.
        const ref = plan.cycle && plan.prochaine && plan.prochaine > e.date.value ? plan.prochaine : e.date.value;
        e.prochaine.value = ajouterPeriode(ref, plan, plan.prochaine);
        aide.textContent = `Proposée d'après la périodicité de « ${plan.libelle} » (${textePeriode(plan)}). Laissez vide pour ne pas changer l'échéance.`;
      } else {
        if (!plan) e.prochaine.value = '';
        aide.textContent = plan ? `Si renseignée, remplace la prochaine échéance de « ${plan.libelle} ».` : 'Choisissez la maintenance réalisée pour mettre à jour sa prochaine échéance.';
      }
      blocProchaine.hidden = !plan && !choisis.every((x) => !(x.plans || []).length && x.maintenance !== false);
    }
    const blocPlan = champ('Maintenance réalisée', e.plan);
    const blocProchaine = champ('Prochaine échéance', e.prochaine);
    e.type.addEventListener('change', () => { majPlans(); proposerProchaine(); });
    e.plan.addEventListener('change', proposerProchaine);
    e.date.addEventListener('change', proposerProchaine);
    const message = el('p', { classe: 'message erreur', role: 'alert' });
    const listeCibles = el('div', { classe: 'mat-cibles' });
    function rendreCibles() {
      const choisis = toutes.filter((x) => cibles.has(x.id)).sort(tri);
      listeCibles.replaceChildren(...choisis.map((x) => el('span', { classe: 'mat-puce' }, nomAppareil(x),
        cibles.size > 1 ? el('button', { type: 'button', 'aria-label': `Retirer ${nomAppareil(x)}`, texte: '✕', surclick: () => { cibles.delete(x.id); rendreCibles(); majPlans(); proposerProchaine(); } }) : null)));
    }
    const ajout = el('select', {
      'aria-label': 'Ajouter un appareil',
      surchange: (ev) => {
        const v = ev.target.value;
        ev.target.value = '';
        if (v.startsWith('mtype:')) toutes.filter((x) => x.modeleType === v.slice(6)).forEach((x) => cibles.add(x.id));
        else if (v.startsWith('modele:')) toutes.filter((x) => x.modele === v.slice(7)).forEach((x) => cibles.add(x.id));
        else if (v.startsWith('type:')) toutes.filter((x) => x.type === v.slice(5)).forEach((x) => cibles.add(x.id));
        else if (v) cibles.add(v);
        rendreCibles();
        majPlans();
        proposerProchaine();
      },
    },
    el('option', { value: '', texte: '+ Répercuter sur d\'autres appareils…' }),
    el('optgroup', { label: 'Tout un matériel type' }, modeles().filter((m) => toutes.some((x) => x.modeleType === m.id)).map((m) => el('option', { value: `mtype:${m.id}`, texte: `Tous les ${nomModele(m)}` }))),
    el('optgroup', { label: 'Tout un modèle' }, [...new Set(toutes.map((x) => x.modele).filter(Boolean))].map((m) => el('option', { value: `modele:${m}`, texte: `Tous les ${m}` }))),
    el('optgroup', { label: 'Tout un type' }, [...new Set(toutes.map((x) => x.type))].map((t) => el('option', { value: `type:${t}`, texte: `Tous les ${t}` }))),
    el('optgroup', { label: 'Un appareil' }, toutes.slice().sort(tri).map((x) => el('option', { value: x.id, texte: nomAppareil(x) }))));
    rendreCibles();
    majPlans();
    if (options.plan && [...e.plan.options].some((o) => o.value === options.plan)) e.plan.value = options.plan;
    proposerProchaine();
    let d;
    const contenu = el('form', {
      classe: 'mat-form', novalidate: true,
      sursubmit: (ev) => {
        ev.preventDefault();
        if (!cibles.size) { message.textContent = 'Choisissez au moins un appareil.'; return; }
        if (!e.date.value) { message.textContent = 'La date est obligatoire.'; return; }
        if (!e.description.value.trim() && e.type.value !== 'Révision') { message.textContent = 'Décrivez l\'intervention.'; return; }
        d.close();
        enfiler('ajouterIntervention', {
          materiels: [...cibles], date: e.date.value, type: e.type.value, description: e.description.value.trim(),
          intervenant: e.intervenant.value.trim(), prochaineRevision: blocProchaine.hidden ? '' : e.prochaine.value, maintenance: blocPlan.hidden ? '' : e.plan.value,
        });
      },
    },
    el('fieldset', { classe: 'mat-cadre' }, el('legend', { texte: 'Appareils concernés' }), listeCibles, ajout),
    el('div', { classe: 'mat-grille' }, champ('Date', e.date), champ('Type', e.type)),
    champ('Description', e.description),
    el('div', { classe: 'mat-grille' }, champ('Intervenant', e.intervenant), blocPlan, blocProchaine),
    aide, message,
    el('div', { classe: 'mat-boutons' }, el('button', { type: 'submit', classe: 'principal', texte: 'Enregistrer l\'intervention' })));
    d = fenetre('Révision, intervention ou réparation', contenu, { large: true });
  }


  // ---------- Évènements ponctuels ----------
  /** Liste éditable des évènements d'un matériel type : [{ id, libelle }]. */
  function editeurEvenements(depart, actif) {
    const liste = depart.map((v) => ({ ...v }));
    const zoneListe = el('div', { classe: 'mat-evenements-edition' });
    const ajout = el('button', { type: 'button', classe: 'cfg-mini', texte: '+ Ajouter un évènement', hidden: !actif, surclick: () => { liste.push({ id: idPlan(), libelle: '' }); rendreListe(); zoneListe.querySelector('div:last-child input')?.focus(); } });
    function rendreListe() {
      zoneListe.replaceChildren(...(liste.length ? liste.map((v, n) => el('div', { classe: 'mat-boutons' },
        el('input', { valeur: v.libelle, placeholder: 'ex. Changement cellule O2', 'aria-label': 'Nom de l\'évènement', disabled: !actif, surinput: (ev) => { v.libelle = ev.target.value; } }),
        actif ? el('button', { type: 'button', classe: 'cfg-mini danger', texte: 'Retirer', surclick: () => { liste.splice(n, 1); rendreListe(); } }) : null))
        : [el('p', { classe: 'mat-vide', texte: 'Aucun évènement.' })]));
    }
    rendreListe();
    return {
      bloc: el('div', {}, zoneListe, el('div', { classe: 'mat-boutons' }, ajout)),
      valeur: () => liste.map((v) => ({ id: v.id, libelle: String(v.libelle || '').trim() })).filter((v) => v.libelle),
    };
  }

  /** Fiche d'un appareil : un bouton par évènement du matériel type, avec la date de la dernière fois. */
  function blocEvenements(f, historique, dialogue) {
    const evts = f.evenements || [];
    if (!evts.length) return null;
    return el('div', { classe: 'mat-evenements' },
      el('h3', { texte: 'Évènements' }),
      el('div', { classe: 'mat-boutons' }, evts.map((v) => {
        const dernier = historique.find((i) => i.type === 'Évènement' && normaliser(i.evenement) === normaliser(v.libelle));
        return el('button', {
          type: 'button', classe: 'cfg-bouton mat-evenement', disabled: !estAdmin(),
          title: estAdmin() ? 'Enregistrer la date de cet évènement' : '',
          surclick: () => { dialogue().close(); ouvrirEvenement(f, v); },
        }, el('strong', { texte: v.libelle }), el('small', { texte: dernier ? ` · dernier le ${dateFr(dernier.date)}` : ' · jamais enregistré' }));
      })));
  }

  /** Date d'un évènement ponctuel (aujourd'hui par défaut, modifiable), avec une remarque facultative. */
  function ouvrirEvenement(f, v, rouvrirFiche = true) {
    const date = el('input', { type: 'date', valeur: aujourdhui(), max: aujourdhui(), required: true });
    const remarque = el('textarea', { rows: '2', placeholder: 'Facultatif : n° de lot, intervenant…' });
    const message = el('p', { classe: 'message erreur', role: 'alert' });
    let d;
    const contenu = el('form', {
      classe: 'mat-form', novalidate: true,
      sursubmit: (ev) => {
        ev.preventDefault();
        if (!date.value) { message.textContent = 'Indiquez la date.'; return; }
        d.close();
        enfiler('ajouterIntervention', { materiels: [f.id], date: date.value, type: 'Évènement', evenement: v.libelle, description: remarque.value.trim(), intervenant: '', prochaineRevision: '' });
        if (rouvrirFiche) ouvrirFiche(f.id);
      },
    }, champ('Date', date), champ('Remarque', remarque), message,
    el('div', { classe: 'mat-boutons' }, el('button', { type: 'submit', classe: 'principal', texte: 'Enregistrer' })));
    d = fenetre(`${v.libelle} · ${nomAppareil(f)}`, contenu);
  }

  // ---------- Utilitaire : associer d'autres codes-barres / QR codes à un appareil ----------
  // Étape 1 : choisir (liste, recherche) ou scanner l'appareil. Étape 2 : scanner chaque code à rattacher.
  function ouvrirAssocierCodes() {
    if (!estAdmin()) return;
    const corps = el('div', { classe: 'mat-form mat-codes' });
    const d = fenetre('Associer des codes', corps, { large: true });

    function etape1(info = '', lancerScan = false) {
      const scanner = () => scannerCode((v) => {
        const f = Materiel.identifier(v);
        if (f) etape2(f.id); else etape1('Aucun appareil ne correspond à ce code. Choisissez-le dans la liste.');
      }, true);
      const sortie = el('div', { classe: 'mat-codes-liste' });
      const recherche = el('input', { type: 'search', placeholder: 'N° interne, biomed, série, modèle…', 'aria-label': 'Rechercher un appareil' });
      const dessiner = () => {
        const q = normaliser(recherche.value);
        const trouves = fiches().filter(enService)
          .filter((f) => !q || normaliser([f.type, f.modele, f.numInterne, f.numBiomed, f.numSerie, f.pret, ...(f.autresCodes || [])].join(' ')).includes(q))
          .sort((a, b) => nomAppareil(a).localeCompare(nomAppareil(b), 'fr')).slice(0, 40);
        sortie.replaceChildren(...(trouves.length ? trouves.map((f) => el('button', {
          type: 'button', classe: 'cfg-bouton mat-codes-choix', surclick: () => etape2(f.id),
          texte: `${nomAppareil(f)}${f.pret ? ` · ${f.pret}` : ''}${f.numBiomed ? ` · Biomed ${f.numBiomed}` : ''}${(f.autresCodes || []).length ? ` · ${f.autresCodes.length} code(s) en plus` : ''}`,
        })) : [el('p', { classe: 'aide-question', texte: 'Aucun appareil.' })]));
      };
      recherche.addEventListener('input', dessiner);
      corps.replaceChildren(
        el('p', { classe: 'aide-question', texte: 'Étape 1 sur 2 : choisissez l\'appareil dans la liste, ou scannez un code déjà connu de cet appareil (n° biomed, puce NFC…).' }),
        info ? el('p', { classe: 'message erreur', texte: info }) : null,
        scanDisponible() ? el('button', { type: 'button', classe: 'principal', texte: 'Scanner l\'appareil', surclick: scanner }) : null,
        recherche, sortie);
      dessiner();
      // Scan ouvert d'emblée (ouverture de l'utilitaire, ou passage à l'appareil suivant) ; la liste reste dessous.
      if (lancerScan && scanDisponible()) scanner();
    }

    function etape2(id, info = '', erreurMsg = false) {
      const f = fiches().find((x) => x.id === id);
      if (!f) { etape1(); return; }
      const codes = f.autresCodes || [];
      const ajouter = (brut) => {
        const v = String(brut || '').trim().slice(0, 100);
        if (!v) return;
        if (codes.some((c) => normaliser(c) === normaliser(v))) { etape2(id, `Le code ${v} est déjà associé à cet appareil.`, true); return; }
        const fiche = { ...f, autresCodes: [...codes, v] };
        if (codes.length >= 10) { etape2(id, 'Dix codes au maximum par appareil.', true); return; }
        const conflit = verifierDoublons([fiche]);
        if (conflit) { etape2(id, conflit, true); return; }
        enfiler('enregistrerMateriel', { fiches: [fiche] });
        etape2(id, `Code ${v} associé.`);
      };
      const retirer = (c) => {
        enfiler('enregistrerMateriel', { fiches: [{ ...f, autresCodes: codes.filter((x) => x !== c) }] });
        etape2(id, `Code ${c} retiré.`);
      };
      const saisie = el('input', { type: 'text', placeholder: 'Saisir ou scanner (douchette) un code', 'aria-label': 'Code à associer', autocomplete: 'off' });
      const valider = () => { const v = saisie.value; saisie.value = ''; ajouter(v); };
      saisie.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); valider(); } });
      corps.replaceChildren(
        el('p', { classe: 'aide-question', texte: 'Étape 2 sur 2 : scannez chaque code-barres ou QR code à rattacher à cet appareil.' }),
        el('h3', { texte: nomAppareil(f) }),
        el('p', { classe: 'mat-rapide-ids', texte: [f.numBiomed && `Biomed ${f.numBiomed}`, f.numSerie && `S/N ${f.numSerie}`].filter(Boolean).join(' · ') || 'Sans n° biomed ni n° de série' }),
        info ? el('p', { classe: erreurMsg ? 'message erreur' : 'message', texte: info }) : null,
        scanDisponible() ? el('button', { type: 'button', classe: 'principal', texte: 'Scanner un code à ajouter', surclick: () => scannerCode(ajouter, true) }) : null,
        el('div', { classe: 'mat-boutons' }, saisie, el('button', { type: 'button', classe: 'cfg-mini', texte: 'Ajouter', surclick: valider })),
        el('h3', { texte: `Codes associés (${codes.length})` }),
        codes.length ? el('ul', { classe: 'mat-codes-ul' }, codes.map((c) => el('li', {}, el('code', { texte: c }),
          el('button', { type: 'button', classe: 'lien', texte: 'Retirer', 'aria-label': `Retirer le code ${c}`, surclick: () => retirer(c) }))))
          : el('p', { classe: 'aide-question', texte: 'Aucun code supplémentaire.' }),
        el('div', { classe: 'mat-boutons' },
          el('button', { type: 'button', classe: 'principal', texte: 'Valider · appareil suivant', surclick: () => etape1(`${nomAppareil(f)} : ${codes.length} code(s) associé(s). Appareil suivant :`, true) }),
          el('button', { type: 'button', classe: 'cfg-mini', texte: 'Fermer', surclick: () => d.close() })));
      saisie.focus();
    }
    etape1('', true);
  }

  // ---------- Lecture d'un QR code / code-barres (caméra) ----------
  const scanDisponible = () => Scannette.ordinateur() || ('BarcodeDetector' in window && Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia));
  /** Valeur utile d'un code lu : « Biomed 12345 » (puce ou étiquette MySMUR) → 12345, sinon le texte lu. */
  function valeurCode(brut) {
    const t = String(brut || '').trim();
    const m = t.match(/biomed\s*:?\s*([A-Za-z0-9._\/-]+)/i);
    return (m ? m[1] : t).slice(0, 40);
  }
  const ICONE_QR = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="8" height="8" rx="1.5"/><rect x="14" y="2" width="8" height="8" rx="1.5"/><rect x="2" y="14" width="8" height="8" rx="1.5"/></g><g fill="currentColor"><rect x="5" y="5" width="2" height="2"/><rect x="17" y="5" width="2" height="2"/><rect x="5" y="17" width="2" height="2"/><rect x="14" y="14" width="3" height="3"/><rect x="19" y="14" width="3" height="3"/><rect x="14" y="19" width="3" height="3"/><rect x="19" y="19" width="3" height="3"/></g></svg>';
  /** Place une icône QR code à droite, dans le champ ; elle ouvre la caméra (masquée si la lecture est impossible). */
  function champAvecScan(entree, libelle, surLu) {
    if (!scanDisponible()) return;
    const bouton = el('button', { type: 'button', classe: 'mat-scan-icone', 'aria-label': libelle, title: libelle, surclick: () => scannerCode(surLu) });
    bouton.innerHTML = ICONE_QR;
    const enveloppe = el('div', { classe: 'mat-champ-scan' });
    entree.replaceWith(enveloppe);
    enveloppe.append(entree, bouton);
  }
  /**
   * Ouvre la caméra arrière et renvoie le premier QR code / code-barres lu.
   * Écran affiché dans un <dialog> modal : il passe au-dessus de la fiche en cours d'édition.
   */
  async function scannerCode(surLu, brut = false) {
    if (Scannette.ordinateur()) {
      // Ordinateur : la scannette tape le code dans un champ (pas de caméra).
      const boite = el('dialog', { classe: 'mat-dialogue scannette-dialogue', 'aria-label': 'Scanner un code' });
      const fermerBoite = () => { if (boite.open) boite.close(); boite.remove(); };
      boite.addEventListener('cancel', fermerBoite);
      boite.append(el('div', { classe: 'fenetre-entete' }, el('h2', { texte: 'Scanner un code' }),
        el('button', { type: 'button', classe: 'fenetre-fermer', 'aria-label': 'Fermer', texte: '✕', surclick: fermerBoite })),
        Scannette.champ((t) => { Scannette.vibrer(); fermerBoite(); const v = brut ? t : valeurCode(t); if (v) surLu(v); }));
      document.body.append(boite);
      boite.showModal();
      Scannette.focusChamp(boite);
      return;
    }
    const video = el('video', { playsinline: '', muted: '', autoplay: '' });
    video.muted = true;
    const lecture = el('p', { classe: 'lecture', role: 'status', texte: 'Ouverture de la caméra…' });
    let flux = null;
    let fini = false;
    const ecran = el('dialog', { classe: 'camera mat-camera', 'aria-label': 'Scanner un code', style: 'margin:0;padding:0;border:0;width:100vw;height:100dvh;max-width:none;max-height:none' },
      el('div', { classe: 'camera-vue' }, video, el('div', { classe: 'viseur viseur-qr', 'aria-hidden': 'true' }),
        el('p', { classe: 'consigne-camera consigne-qr', texte: 'Visez le QR code ou le code-barres de l\'étiquette' })),
      lecture, el('div', { classe: 'camera-actions' }, el('button', { type: 'button', classe: 'camera-bouton secondaire', texte: 'Annuler', surclick: () => fermer() })));
    function fermer() {
      if (fini) return;
      fini = true;
      if (flux) flux.getTracks().forEach((t) => t.stop());
      if (ecran.open) ecran.close();
      ecran.remove();
    }
    ecran.addEventListener('cancel', fermer);
    document.body.append(ecran);
    ecran.showModal();
    try {
      flux = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      if (fini) { flux.getTracks().forEach((t) => t.stop()); return; }
      video.srcObject = flux;
      await video.play();
      lecture.textContent = '';
      const formats = BarcodeDetector.getSupportedFormats ? await BarcodeDetector.getSupportedFormats() : undefined;
      const det = formats && formats.length ? new BarcodeDetector({ formats }) : new BarcodeDetector();
      const boucle = async () => {
        if (fini) return;
        try {
          const r = await det.detect(video);
          if (r.length && r[0].rawValue) { const v = brut ? String(r[0].rawValue).trim() : valeurCode(r[0].rawValue); Scannette.vibrer(); fermer(); if (v) surLu(v); return; }
        } catch (e) { /* image suivante */ }
        setTimeout(boucle, 250);
      };
      boucle();
    } catch (e) {
      lecture.textContent = 'Caméra inaccessible : autorisez la caméra, ou annulez et saisissez le numéro.';
    }
  }

  // ---------- Matériels types ----------
  /** Liste des fiches types, avec le nombre d'appareils rattachés. */
  function ouvrirModeles() {
    const { fiches: toutes, modeles: liste, modelesAttente } = etat();
    let d;
    const tries = liste.slice().sort((a, b) => Number(a.archive) - Number(b.archive) || nomModele(a).localeCompare(nomModele(b), 'fr'));
    const uniques = toutes.filter((x) => !x.modeleType && enService(x)).length;
    const contenu = el('div', { classe: 'mat-modeles' },
      el('p', { classe: 'aide-question', texte: 'Un matériel type « Type > modèle » regroupe des appareils identiques : n° biomed ou non, maintenance préventive et périodicité, logiciel suivi, photo. Le modifier met à jour tous les appareils rattachés. Les numéros, la révision prévue, le statut et le traceur restent propres à chaque appareil.' }),
      estAdmin() ? el('div', { classe: 'mat-boutons' }, el('button', { type: 'button', classe: 'principal', texte: '+ Nouveau matériel type', surclick: () => { d.close(); ouvrirModele(null); } })) : null,
      tries.length ? el('ul', { classe: 'mat-lignes' }, tries.map((m) => {
        const nb = toutes.filter((x) => x.modeleType === m.id && enService(x)).length;
        return el('li', { classe: 'mat-ligne' },
          el('button', { type: 'button', classe: 'mat-ouvrir', surclick: () => { d.close(); ouvrirModele(m); } },
            (m.photo || m.photoDonnees) ? vignette({ ...m, type: m.type }, 'mat-vignette') : null,
            el('span', { classe: 'mat-corps' },
              el('span', { classe: 'mat-nom' }, el('strong', { texte: m.type }), el('span', { texte: ` > ${m.modele}` })),
              el('span', { classe: 'mat-ids', texte: [`${nb} appareil${nb > 1 ? 's' : ''}`, m.maintenance === false ? 'sans maintenance préventive' : resumePlans(plansDe(m)), m.biomed === false ? 'sans n° biomed' : '', m.logiciel ? 'logiciel suivi' : ''].filter(Boolean).join(' · ') })),
            el('span', { classe: 'mat-etats' },
              m.archive ? el('span', { classe: 'mat-pastille rev-neutre', texte: 'Archivé' }) : null,
              modelesAttente.has(m.id) ? el('span', { classe: 'mat-pastille attente', texte: 'En attente d\'envoi' }) : null)));
      })) : el('p', { classe: 'mat-vide', texte: estAdmin() ? 'Aucun matériel type. Créez-en un ici, ou depuis la fiche d\'un appareil (« Créer un matériel type »).' : 'Aucun matériel type pour le moment.' }),
      el('p', { classe: 'aide-question', texte: `${uniques} appareil${uniques > 1 ? 's' : ''} en service sans matériel type (matériels uniques).` }));
    d = fenetre('Matériels types', contenu, { large: true });
  }

  /**
   * Fiche type : consultation / modification (administrateurs) et appareils rattachés.
   * `m` null = création ; `depuis` = appareil dont on reprend les caractéristiques.
   */
  function ouvrirModele(m, depuis = null) {
    const admin = estAdmin();
    const base = m || {
      id: idFiche(), type: (depuis && depuis.type) || filtre.type || TYPES_DEFAUT[0], modele: (depuis && depuis.modele) || '',
      plans: depuis ? (depuis.plans || []).map((p) => ({ id: p.id, libelle: p.libelle, periodicite: p.periodicite, unite: p.unite || 'mois', cycle: p.cycle })) : [{ id: 'rev', libelle: 'Révision', periodicite: 12 }], photo: (depuis && depuis.photo) || '', photoDonnees: (depuis && depuis.photoDonnees) || '',
      remarques: '', archive: false,
      biomed: depuis ? depuis.biomed !== false : true, maintenance: depuis ? depuis.maintenance !== false : true, logiciel: Boolean(depuis && depuis.logiciel),
    };
    const toutes = fiches().filter((x) => !x.archive || x.modeleType === base.id);
    const dejaLies = new Set(toutes.filter((x) => x.modeleType === base.id).map((x) => x.id));
    // Pré-cochés : appareils déjà rattachés ; à la création, les appareils uniques de même type et même modèle.
    const coches = new Set(m ? dejaLies : toutes.filter((x) => !x.modeleType && x.type === base.type && base.modele && normaliser(x.modele) === normaliser(base.modele)).map((x) => x.id));
    if (depuis) coches.add(depuis.id);
    const message = el('p', { classe: 'message erreur', role: 'alert' });
    const e = {
      type: champType(base.type),
      modele: el('input', { valeur: base.modele, placeholder: 'ex. Corpuls3, Hamilton T1, Alaris GH…' }),
      plans: editeurPlans(plansDe(base), { avecDate: false, actif: admin }),
      remarques: el('textarea', { rows: '3', valeur: base.remarques, placeholder: 'Caractéristiques communes, accessoires, notice…' }),
      biomed: el('input', { type: 'checkbox', coche: base.biomed !== false }),
      maintenance: el('input', { type: 'checkbox', coche: base.maintenance !== false }),
      logiciel: el('input', { type: 'checkbox', coche: base.logiciel === true }),
      evenements: editeurEvenements(base.evenements || [], admin),
    };
    const blocPeriodicite = el('div', { classe: 'champ mat-champ' }, el('span', { classe: 'mat-libelle', texte: 'Maintenances préventives (les échéances se renseignent sur chaque appareil)' }), e.plans.bloc);
    const majOptions = () => { blocPeriodicite.hidden = !e.maintenance.checked; };
    e.maintenance.addEventListener('change', majOptions);
    majOptions();
    let photo = { id: base.photo || '', donnees: base.photoDonnees || '' };
    const apercu = el('img', { classe: 'mat-photo', alt: 'Photo du matériel type', hidden: true });
    const boutonRetirer = el('button', { type: 'button', classe: 'cfg-bouton danger', texte: 'Retirer la photo', hidden: true, surclick: () => { photo = { id: '', donnees: '' }; afficherApercu(); } });
    const boutonRecadrer = el('button', { type: 'button', classe: 'cfg-bouton', texte: '✂ Recadrer', hidden: true, surclick: async () => {
      if (!apercu.src) return;
      try { const d = await reduirePhoto(apercu.src); if (!d) return; photo = { id: '', donnees: d }; message.textContent = ''; } catch (err) { message.textContent = 'Photo illisible ou trop lourde.'; }
      afficherApercu();
    } });
    const afficherApercu = async () => {
      const src = photo.donnees || (photo.id ? await imageDe({ photo: photo.id }) : '');
      apercu.hidden = !src;
      if (src) apercu.src = src;
      boutonRetirer.hidden = !src || !admin;
      boutonRecadrer.hidden = !src || !admin;
    };
    const fichierPhoto = el('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
    fichierPhoto.addEventListener('change', async () => {
      const fichier = fichierPhoto.files[0];
      fichierPhoto.value = '';
      if (!fichier) return;
      try { const d = await reduirePhoto(fichier); if (!d) return; photo = { id: '', donnees: d }; message.textContent = ''; } catch (err) { message.textContent = 'Photo illisible ou trop lourde.'; }
      afficherApercu();
    });
    if (!admin) [e.type.select, e.modele, e.remarques, e.biomed, e.maintenance, e.logiciel].forEach((x) => { x.disabled = true; });

    const cases = el('div', { classe: 'mat-cibles-liste' });
    function rendreCases() {
      const type = e.type.valeur();
      // Rattachés + appareils uniques du même type (les autres types restent accessibles via « tous les types »).
      const proposes = toutes.filter((x) => coches.has(x.id) || dejaLies.has(x.id) || (!x.modeleType && (voirTous || x.type === type))).sort(tri);
      cases.replaceChildren(...(proposes.length ? proposes.map((x) => el('label', { classe: 'mat-case-libelle' },
        el('input', { type: 'checkbox', coche: coches.has(x.id), disabled: !admin, surchange: (ev) => { if (ev.target.checked) coches.add(x.id); else coches.delete(x.id); } }),
        el('span', { texte: `${nomAppareil(x)}${x.modeleType && x.modeleType !== base.id ? ` (rattaché à ${nomModele(modeleDe(x.modeleType))})` : ''}` }))) : [el('p', { classe: 'mat-vide', texte: 'Aucun appareil de ce type.' })]));
    }
    let voirTous = false;
    e.type.select.addEventListener('change', rendreCases);

    let d;
    const lire = () => ({
      ...base, type: e.type.valeur(), modele: e.modele.value.trim(), plans: e.plans.valeur().map(({ id, libelle, periodicite, unite, cycle }) => ({ id, libelle, periodicite, unite: unite || 'mois', cycle })),
      evenements: e.evenements.valeur(),
      remarques: e.remarques.value.trim(), photo: photo.donnees ? '' : photo.id, photoDonnees: photo.donnees,
      biomed: e.biomed.checked, maintenance: e.maintenance.checked, logiciel: e.logiciel.checked,
    });
    function envoyer(fiche) {
      if (!fiche.type || !fiche.modele) { message.textContent = 'Le type et le modèle sont obligatoires.'; return; }
      if (!fiche.maintenance) fiche.plans = [];
      // Un matériel type = un couple « Type > modèle ».
      const double = modeles().find((x) => x.id !== fiche.id && !x.archive && normaliser(x.type) === normaliser(fiche.type) && normaliser(x.modele) === normaliser(fiche.modele));
      if (double) { message.textContent = `Le matériel type ${nomModele(double)} existe déjà.`; return; }
      const rattacher = [...coches].filter((id) => !dejaLies.has(id));
      const detacher = [...dejaLies].filter((id) => !coches.has(id));
      const simulation = fiches().filter((x) => rattacher.includes(x.id) || detacher.includes(x.id))
        .map((x) => ({ ...x, modeleType: rattacher.includes(x.id) ? fiche.id : '' }));
      const conflit = verifierDoublons(simulation, [fiche]);
      if (conflit) { message.textContent = conflit; return; }
      d.close();
      enfiler('enregistrerModeles', { modeles: [fiche], rattacher, detacher });
    }
    const contenu = el('form', { classe: 'mat-form', novalidate: true, sursubmit: (ev) => { ev.preventDefault(); if (admin) envoyer(lire()); } },
      el('div', { classe: 'mat-grille' },
        champ('Type de matériel', e.type.select), e.type.bloc,
        champ('Modèle', e.modele)),
      el('fieldset', { classe: 'mat-cadre' }, el('legend', { texte: 'Suivi des appareils de ce type' }),
        el('label', { classe: 'mat-case-libelle' }, e.biomed, el('span', { texte: 'Munis d\'un n° biomed' })),
        el('label', { classe: 'mat-case-libelle' }, e.maintenance, el('span', { texte: 'Maintenance préventive' })),
        el('label', { classe: 'mat-case-libelle' }, e.logiciel, el('span', { texte: 'Version logiciel à suivre (renseignée sur chaque appareil)' })),
        blocPeriodicite),
      el('fieldset', { classe: 'mat-cadre' }, el('legend', { texte: 'Évènements ponctuels' }),
        el('p', { classe: 'aide-question', texte: 'Évènements sans échéance (ex. « Changement cellule O2 ») : sur chaque appareil, un bouton enregistre la date à laquelle il a eu lieu.' }),
        e.evenements.bloc),
      el('div', { classe: 'mat-photo-bloc' }, el('p', { classe: 'mat-libelle', texte: 'Photo (affichée pour les appareils sans photo propre)' }), apercu,
        admin ? el('div', { classe: 'mat-boutons' },
          el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Prendre ou choisir une photo', surclick: () => fichierPhoto.click() }), boutonRecadrer, boutonRetirer, fichierPhoto) : null),
      champ('Remarques communes', e.remarques),
      el('fieldset', { classe: 'mat-cadre' }, el('legend', { texte: 'Appareils rattachés à ce matériel type' }),
        el('p', { classe: 'aide-question', texte: 'Un appareil coché prend le type, le modèle et la périodicité de cette fiche. Décoché, il redevient un matériel unique et garde ses valeurs actuelles.' }),
        admin ? el('div', { classe: 'mat-boutons' },
          el('button', { type: 'button', classe: 'cfg-mini', texte: 'Montrer tous les types', surclick: (ev) => { voirTous = !voirTous; ev.target.textContent = voirTous ? 'Seulement ce type' : 'Montrer tous les types'; rendreCases(); } })) : null,
        cases),
      message,
      admin ? el('div', { classe: 'mat-boutons' },
        el('button', { type: 'submit', classe: 'principal', texte: m ? 'Enregistrer (et mettre à jour les appareils)' : 'Créer le matériel type' }),
        m ? el('button', {
          type: 'button', classe: 'cfg-bouton danger', texte: m.archive ? 'Désarchiver' : 'Archiver',
          title: 'Un matériel type archivé n\'est plus proposé ; les appareils rattachés le gardent',
          surclick: () => { if (m.archive || window.confirm(`Archiver le matériel type ${nomModele(m)} ?`)) { d.close(); enfiler('enregistrerModeles', { modeles: [{ ...m, archive: !m.archive }] }); } },
        }) : null) : null);
    d = fenetre(m ? `Matériel type · ${nomModele(m)}` : 'Nouveau matériel type', contenu, { large: true });
    rendreCases();
    afficherApercu();
  }

  // ---------- Puce NFC ----------
  // Champs invariables d'un appareil (jamais la révision, le statut ou les remarques, qui changent).
  const INVARIABLES = { type: 'Type', modele: 'Modèle', numInterne: 'N° interne SMUR', numBiomed: 'N° biomed', numSerie: 'N° de série' };
  /** Lien ouvrant la fiche de l'appareil dans l'appli (même principe que « #inv=… » des inventaires). */
  const adresse = (id) => `${location.origin}${location.pathname.replace(/index\.html$/, '')}#mat=${id}`;
  // Libellés courts : une NTAG213 ne contient que 144 octets (lien + texte).
  const COURTS = { type: '', modele: '', numInterne: 'n°', numBiomed: 'Biomed ', numSerie: 'S/N ' };
  function texteFiche(f, champs) {
    const a = (k) => (champs.includes(k) && f[k] ? `${COURTS[k]}${f[k]}` : '');
    return ['SMUR Avignon', [a('type'), a('modele'), a('numInterne')].filter(Boolean).join(' '), a('numBiomed'), a('numSerie')]
      .filter(Boolean).join('\n');
  }
  /** Taille approximative du message NDEF (en-têtes compris), à comparer à la capacité de la puce. */
  function tailleNdef(lien, texte) {
    const octets = (t) => new TextEncoder().encode(t).length;
    let n = 0;
    if (lien) n += 5 + octets(lien.replace(/^https:\/\//, ''));
    if (texte) n += 6 + octets(texte);
    return n + 4; // TLV
  }

  /**
   * Écrit sur une puce NFC (Chrome sur Android) :
   *  1. un lien qui ouvre la fiche de l'appareil dans MySMUR ;
   *  2. un texte avec les informations invariables, lisible par n'importe quel téléphone, même sans l'appli.
   * La puce est d'abord effacée (formatée en NDEF vide), puis écrite, sans qu'il faille la retirer.
   */
  function ouvrirNfc(f) {
    const disponible = 'NDEFReader' in window;
    const champs = new Set(Object.keys(INVARIABLES).filter((k) => f[k]));
    let avecLien = true;
    const apercu = el('pre', { classe: 'mat-apercu' });
    const taille = el('p', { classe: 'aide-question' });
    const majApercu = () => {
      const texte = champs.size ? texteFiche(f, [...champs]) : '';
      apercu.textContent = `${avecLien ? `${adresse(f.id)}\n\n` : ''}${texte}`;
      const n = tailleNdef(avecLien ? adresse(f.id) : '', texte);
      taille.textContent = `Taille : environ ${n} octets. ${n <= 137 ? 'Tient sur une NTAG213 (144 octets).' : (n <= 496 ? 'Trop grand pour une NTAG213 : il faut une NTAG215 ou NTAG216, ou décochez des informations.' : 'Trop grand : décochez des informations.')}`;
      taille.className = n <= 137 ? 'aide-question' : 'message erreur';
    };
    majApercu();
    const sortie = el('p', { classe: 'message', role: 'status' });
    const bouton = el('button', { type: 'button', classe: 'principal', texte: 'Écrire sur la puce', disabled: !disponible });
    bouton.addEventListener('click', async () => {
      if (!champs.size && !avecLien) { sortie.textContent = 'Choisissez au moins une information.'; sortie.className = 'message erreur'; return; }
      const records = [];
      if (avecLien) records.push({ recordType: 'url', data: adresse(f.id) });
      if (champs.size) records.push({ recordType: 'text', lang: 'fr', data: texteFiche(f, [...champs]) });
      const delai = new AbortController();
      const minuterie = setTimeout(() => delai.abort(), 30000);
      bouton.disabled = true;
      sortie.className = 'message';
      sortie.textContent = 'Approchez la puce du dos du téléphone…';
      const cacherCible = CibleNfc.montrer();
      try {
        const nfc = new NDEFReader();
        // Une seule écriture : « overwrite » remplace tout l'ancien contenu (formatage NDEF compris si la puce est vierge).
        // Deux écritures de suite échouent souvent : Chrome attend que la puce soit présentée à nouveau.
        await nfc.write({ records }, { signal: delai.signal, overwrite: true });
        sortie.textContent = `Puce effacée puis encodée pour ${nomAppareil(f)}.`;
        sortie.className = 'message succes';
      } catch (e) {
        sortie.textContent = e.name === 'AbortError' ? 'Aucune puce détectée. Réessayez en la gardant contre le téléphone.'
          : (e.name === 'NotAllowedError' ? 'Autorisez le NFC pour cette application et vérifiez qu\'il est activé sur le téléphone.'
            : `Écriture impossible (${e.name}${e.message ? ` : ${e.message}` : ''}). Puce trop petite pour ce contenu (décochez des informations), verrouillée, ou non compatible : seules les puces NTAG (213, 215, 216) sont prises en charge, pas les MIFARE Classic.`);
        sortie.className = 'message erreur';
      } finally {
        clearTimeout(minuterie);
        cacherCible();
        bouton.disabled = false;
      }
    });
    const contenu = el('div', { classe: 'mat-nfc' },
      disponible ? null : el('p', { classe: 'message erreur', texte: 'Écriture NFC impossible sur cet appareil : il faut Chrome sur un téléphone Android avec le NFC activé. Vous pouvez recopier le contenu ci-dessous avec une appli NFC (enregistrements « URL » et « Texte »).' }),
      el('fieldset', { classe: 'mat-cadre' }, el('legend', { texte: 'Informations écrites sur la puce' }),
        el('label', { classe: 'mat-case-libelle' },
          el('input', { type: 'checkbox', coche: true, surchange: (ev) => { avecLien = ev.target.checked; majApercu(); } }),
          el('span', { texte: 'Lien vers la fiche dans MySMUR (ouvre l\'appli en approchant la puce)' })),
        Object.keys(INVARIABLES).map((k) => el('label', { classe: 'mat-case-libelle' },
          el('input', { type: 'checkbox', coche: champs.has(k), disabled: !f[k], surchange: (ev) => { if (ev.target.checked) champs.add(k); else champs.delete(k); majApercu(); } }),
          el('span', { texte: `${INVARIABLES[k]} : ${f[k] || '(non renseigné)'}` })))),
      el('p', { classe: 'aide-question', texte: 'Aperçu du contenu :' }), apercu, taille,
      el('p', { classe: 'aide-question', texte: 'L\'ancien contenu de la puce est effacé. Appuyez sur « Écrire », puis gardez la puce contre le dos du téléphone jusqu\'au message de confirmation (ignorez la notification « Carte NFC détectée » d\'Android).' }),
      el('div', { classe: 'mat-boutons' }, bouton, disponible ? CibleNfc.lien() : null), sortie);
    fenetre(`Puce NFC · ${nomAppareil(f)}`, contenu, { large: true });
  }

  /** Lit une puce : lien « #mat=… », sinon n° de série / biomed trouvé dans le texte ou n° de série de la puce. */
  async function lireNfc() {
    const sortie = el('p', { classe: 'message', role: 'status', texte: 'Approchez la puce du dos du téléphone…' });
    const arret = new AbortController();
    const d = fenetre('Lire une puce NFC', el('div', { classe: 'mat-nfc-lecture' }, sortie, CibleNfc.lien()));
    const cacherCible = CibleNfc.montrer();
    d.addEventListener('close', () => { arret.abort(); cacherCible(); });
    try {
      const lecteur = new NDEFReader();
      lecteur.addEventListener('reading', ({ message, serialNumber }) => {
        if (CibleNfc.enReglage()) return; // puce passée pour repérer l'antenne
        Scannette.vibrer();
        const textes = [serialNumber || ''];
        message.records.forEach((r) => { try { textes.push(new TextDecoder(r.encoding || 'utf-8').decode(r.data)); } catch (e) { /* ignoré */ } });
        const tout = textes.join('\n');
        const lienPret = tout.match(/#pret=([A-Za-z0-9]{3,12})/);
        if (lienPret && refDuCode(lienPret[1])) { d.close(); ouvrirReferencePret(refDuCode(lienPret[1])); return; }
        const lien = tout.match(/#mat=([a-z0-9]{6,20})/);
        const liste = fiches();
        const f = (lien && liste.find((x) => x.id === lien[1]))
          || liste.find((x) => (x.numSerie && tout.includes(`S/N ${x.numSerie}`)) || (x.numBiomed && tout.includes(`Biomed ${x.numBiomed}`)));
        if (f) { d.close(); ouvrirFiche(f.id); return; }
        sortie.textContent = 'Puce lue, mais aucun appareil de la base ne correspond.';
        sortie.className = 'message erreur';
      });
      await lecteur.scan({ signal: arret.signal });
    } catch (e) {
      sortie.textContent = 'NFC refusé ou désactivé sur ce téléphone.';
      sortie.className = 'message erreur';
    }
  }

  // ---------- Matériel de prêt ----------
  // Pool de 12 références (« PRÊT 01 » à « PRÊT 12 ») : chacune accueille un matériel prêté au SMUR,
  // avec ou sans n° biomed. Matériel rendu : la référence redevient disponible, le prêt passe dans l'historique.
  // Backend : MaterielPrets.gs (onglet MaterielPrets). Hors ligne : même file d'attente que le reste du matériel.
  const REFERENCES_DEFAUT = Array.from({ length: 12 }, (_, i) => `PRÊT ${String(i + 1).padStart(2, '0')}`);
  const RAISONS_PRET = ['Remplacement d\'un appareil en réparation', 'Remplacement pendant une révision', 'Essai / démonstration', 'Besoin ponctuel (renfort)', 'Prêt intra-hospitalier', 'Matériel à l\'essai'];
  let rechercheHistorique = '';
  const references = () => (donnees && donnees.referencesPret) || REFERENCES_DEFAUT;
  const peutPreter = () => Boolean(outils.peutPreter ? outils.peutPreter() : estAdmin());
  const nomPret = (p) => [p.type || 'Matériel', p.modele].filter(Boolean).join(' ');
  const joursDepuis = (iso) => Math.round((new Date(aujourdhui()) - new Date(iso)) / 86400000);

  /** Prêts affichés = serveur + saisies pas encore envoyées. */
  function etatPrets() {
    const parId = new Map(((donnees && donnees.prets) || []).map((p) => [p.id, { ...p }]));
    enAttente().forEach((e) => {
      const d = e.donnees || {};
      if (e.action === 'enregistrerPret' && d.pret) {
        parId.set(d.pret.id, { ...parId.get(d.pret.id), ...d.pret, attente: true });
      } else if (e.action === 'rendrePret' && parId.has(d.id)) {
        parId.set(d.id, { ...parId.get(d.id), renduLe: d.date, remarqueRetour: d.remarque || '', renduPar: 'vous', attente: true });
      }
    });
    const tous = [...parId.values()];
    const ouverts = new Map();
    tous.filter((p) => !p.renduLe).forEach((p) => { if (!ouverts.has(p.reference)) ouverts.set(p.reference, p); });
    const clos = tous.filter((p) => p.renduLe).sort((a, b) => String(b.renduLe).localeCompare(String(a.renduLe)));
    return { ouverts, clos };
  }

  /** Onglets du suivi du matériel : Appareils | Matériel de prêt. */
  function ongletsMateriel() {
    const { ouverts } = etatPrets();
    const bouton = (cle, texte) => el('button', {
      type: 'button', role: 'tab', classe: `mat-onglet${onglet === cle ? ' actif' : ''}`, 'aria-selected': String(onglet === cle), texte,
      surclick: () => {
        if (onglet === cle) return;
        if (outils.ouvrirVue) outils.ouvrirVue({ appareils: 'suivi-materiel', prets: 'materiel-prets', monnal: 'materiel-monnal', glycemie: 'materiel-glycemie' }[cle]);
        else { onglet = cle; rendre(); }
      },
    });
    return el('div', { classe: 'mat-onglets', role: 'tablist', 'aria-label': 'Gestion du matériel' },
      bouton('appareils', 'Appareils'),
      bouton('prets', `Matériel de prêt (${ouverts.size}/${references().length})`),
      bouton('monnal', 'Maintenance Monnal'),
      bouton('glycemie', 'Contrôle glycémie'));
  }

  function etatRetour(p) {
    if (!p.retourPrevu) return null;
    const jours = Math.round((new Date(p.retourPrevu) - new Date(aujourdhui())) / 86400000);
    if (jours < 0) return { classe: 'retard', texte: `Retour dépassé (prévu le ${dateFr(p.retourPrevu)})`, retard: true };
    if (jours <= 3) return { classe: 'bientot', texte: `Retour le ${dateFr(p.retourPrevu)}${jours ? ` (J-${jours})` : ' (aujourd\'hui)'}` };
    return { classe: 'ok', texte: `Retour prévu le ${dateFr(p.retourPrevu)}` };
  }

  function rendrePrets() {
    const { ouverts, clos } = etatPrets();
    const refs = references();
    const nbRetard = [...ouverts.values()].filter((p) => (etatRetour(p) || {}).retard).length;
    const nbAttente = [...ouverts.values(), ...clos].filter((p) => p.attente).length;

    const entete = el('div', { classe: 'mat-entete' }, el('h1', { texte: 'Matériel de prêt' }),
      el('button', { type: 'button', classe: 'cfg-mini', texte: 'QR codes et puces NFC', surclick: ouvrirEtiquettesPrets }));
    const aide = el('p', { classe: 'aide-question pret-aide', texte: `${refs.length} références pour le matériel prêté au SMUR. Une fois le matériel rendu, la référence redevient disponible et le prêt reste dans l'historique.` });
    const compteur = (nombre, libelle, classe) => el('div', { classe: `mat-compteur pret-compteur ${classe}` }, el('strong', { texte: String(nombre) }), el('span', { texte: libelle }));
    const compteurs = el('div', { classe: 'mat-compteurs' },
      compteur(ouverts.size, `prêt${ouverts.size > 1 ? 's' : ''} en cours`, 'total'),
      compteur(refs.length - [...ouverts.keys()].filter((r) => refs.includes(r)).length, 'références disponibles', 'libre'),
      compteur(nbRetard, 'retours dépassés', 'retard'));
    const avis = [];
    if (erreur) avis.push(el('p', { classe: 'message erreur', texte: erreur }));
    if (!donnees && chargementEnCours) avis.push(el('p', { classe: 'message', texte: 'Chargement…' }));
    if (nbAttente) avis.push(el('p', { classe: 'message mat-attente-avis', texte: `${nbAttente} prêt(s) modifié(s) sur cet appareil, en attente d'envoi au serveur.` }));

    const grille = el('ul', { classe: 'pret-grille' }, refs.map((ref) => carteReference(ref, ouverts.get(ref))));
    // Prêt en cours sur une référence retirée du pool (Sheet modifié à la main) : affiché quand même.
    const orphelins = [...ouverts.values()].filter((p) => !refs.includes(p.reference));
    orphelins.forEach((p) => grille.append(carteReference(p.reference || '?', p)));

    zone.replaceChildren(...[ongletsMateriel(), entete, aide, compteurs, ...avis, grille, blocHistorique(clos)].filter(Boolean));
  }

  function carteReference(ref, p) {
    if (!p) {
      return el('li', { classe: 'pret-carte libre' },
        el('div', { classe: 'pret-carte-tete' }, el('strong', { classe: 'pret-ref', texte: ref }), el('span', { classe: 'mat-pastille pret-libre', texte: 'Disponible' })),
        el('div', { classe: 'mat-boutons' },
          peutPreter() ? el('button', { type: 'button', classe: 'cfg-bouton pret-affecter', texte: '+ Affecter un prêt', surclick: () => ouvrirPret(ref, null) }) : null,
          boutonQrNfc(ref)));
    }
    const retour = etatRetour(p);
    const jours = p.debut ? joursDepuis(p.debut) : null;
    return el('li', { classe: `pret-carte occupee${retour && retour.retard ? ' retard' : ''}${p.attente ? ' attente' : ''}` },
      el('div', { classe: 'pret-carte-tete' },
        el('strong', { classe: 'pret-ref', texte: ref }),
        el('span', { classe: 'mat-pastille pret-occupe', texte: p.attente ? 'En attente d\'envoi' : 'En prêt' })),
      el('button', { type: 'button', classe: 'pret-ouvrir', surclick: () => ouvrirDetailPret(p) },
        aPhoto(p) ? vignette(p, 'mat-vignette pret-vignette') : null,
        el('span', { classe: 'pret-nom', texte: nomPret(p) }),
        el('span', { classe: 'pret-ids', texte: [p.biomed === false ? 'Sans n° biomed' : (p.numBiomed ? `Biomed ${p.numBiomed}` : 'N° biomed non renseigné'), p.numSerie && `S/N ${p.numSerie}`].filter(Boolean).join(' · ') }),
        el('span', { classe: 'pret-ligne', texte: `Propriétaire : ${p.proprietaire || '—'}` }),
        el('span', { classe: 'pret-ligne', texte: p.debut ? `Depuis le ${dateFr(p.debut)}${jours > 0 ? ` (${jours} j)` : ''}` : '' }),
        p.raison ? el('span', { classe: 'pret-raison', texte: p.raison }) : null,
        retour ? el('span', { classe: `mat-pastille rev-${retour.classe}`, texte: retour.texte }) : null),
      peutPreter() ? el('div', { classe: 'mat-boutons' },
        el('button', { type: 'button', classe: 'cfg-mini', texte: 'Modifier', surclick: () => ouvrirPret(ref, p) }),
        el('button', { type: 'button', classe: 'cfg-mini pret-rendre', texte: 'Matériel rendu', surclick: () => ouvrirRetour(p) }),
        boutonQrNfc(ref)) : el('div', { classe: 'mat-boutons' }, boutonQrNfc(ref)));
  }

  /** Historique des prêts terminés, replié, avec recherche. */
  function blocHistorique(clos) {
    if (!clos.length) return null;
    const liste = el('ul', { classe: 'pret-historique' });
    const remplir = () => {
      const t = normaliser(rechercheHistorique);
      const visibles = clos.filter((p) => !t || t.split(/\s+/).every((mot) => normaliser([p.reference, p.type, p.modele, p.numBiomed, p.numSerie, p.proprietaire, p.raison, p.remarques].join(' ')).includes(mot)));
      liste.replaceChildren(...(visibles.length ? visibles.map((p) => el('li', {},
        el('button', { type: 'button', classe: 'pret-ouvrir', surclick: () => ouvrirDetailPret(p) },
          el('span', { classe: 'pret-nom', texte: `${p.reference} · ${nomPret(p)}` }),
          el('span', { classe: 'pret-ids', texte: `${p.proprietaire || '—'} · du ${dateFr(p.debut)} au ${dateFr(p.renduLe)}${p.attente ? ' · en attente d\'envoi' : ''}` }),
          p.raison ? el('span', { classe: 'pret-raison', texte: p.raison }) : null))) : [el('li', { classe: 'mat-vide', texte: 'Aucun prêt ne correspond.' })]));
    };
    const recherche = el('input', { type: 'search', valeur: rechercheHistorique, placeholder: 'Référence, matériel, propriétaire…', 'aria-label': 'Rechercher dans l\'historique des prêts', surinput: (e) => { rechercheHistorique = e.target.value; remplir(); } });
    remplir();
    return el('details', { classe: 'mat-groupe pret-bloc-historique' },
      el('summary', { classe: 'mat-groupe-titre' }, el('span', { texte: 'Prêts terminés' }), el('small', { texte: String(clos.length) })),
      el('div', { classe: 'mat-filtres' }, recherche), liste);
  }

  function detailPret(p) {
    const ligneDetail = (libelle, valeur) => (valeur ? el('div', { classe: 'pret-detail-ligne' }, el('dt', { texte: libelle }), el('dd', { texte: valeur })) : null);
    return el('dl', { classe: 'pret-detail' },
      ligneDetail('Référence', p.reference),
      ligneDetail('Matériel', nomPret(p)),
      ligneDetail('N° biomed', p.biomed === false ? 'Sans n° biomed' : (p.numBiomed || '—')),
      ligneDetail('N° de série', p.numSerie),
      ligneDetail('Propriétaire', p.proprietaire),
      ligneDetail('Contact', p.contact),
      ligneDetail('Raison du prêt', p.raison),
      ligneDetail('Début du prêt', dateFr(p.debut)),
      ligneDetail('Retour prévu', p.retourPrevu ? dateFr(p.retourPrevu) : ''),
      ligneDetail('Remarques', p.remarques),
      ligneDetail('Saisi par', p.saisiPar),
      ligneDetail('Modifié par', p.modifiePar),
      ligneDetail('Rendu le', p.renduLe ? dateFr(p.renduLe) : ''),
      ligneDetail('Rendu noté par', p.renduPar),
      ligneDetail('Remarque au retour', p.remarqueRetour));
  }

  function ouvrirDetailPret(p) {
    let d;
    const boutons = !p.renduLe && peutPreter() ? el('div', { classe: 'mat-boutons' },
      el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Modifier', surclick: () => { d.close(); ouvrirPret(p.reference, p); } }),
      el('button', { type: 'button', classe: 'principal', texte: 'Matériel rendu', surclick: () => { d.close(); ouvrirRetour(p); } })) : null;
    const fiche = etat().fiches.find((x) => x.idPret === p.id && !x.provisoire);
    const lienFiche = fiche ? el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Maintenance et main courante', surclick: () => { d.close(); ouvrirFiche(fiche.id); } }) : null;
    d = fenetre(`${p.reference} · ${nomPret(p)}`, el('div', { classe: 'mat-form' }, aPhoto(p) ? vignette(p, 'mat-photo') : null, detailPret(p), lienFiche, boutons));
  }

  /** Nouveau prêt sur une référence libre (p null), ou modification d'un prêt en cours. */
  function ouvrirPret(ref, p) {
    const { ouverts, clos } = etatPrets();
    const tous = [...ouverts.values(), ...clos];
    const libres = references().filter((r) => r === ref || !ouverts.has(r));
    const choixRef = el('select', {}, libres.map((r) => el('option', { value: r, texte: r, selected: r === ref })));
    const type = champType(p ? p.type : '');
    const idListeModeles = nouvelId();
    const suggestionsModeles = [...new Set([...nomsModelesConnus(), ...tous.map((x) => x.modele)].filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr'));
    const modele = el('input', { valeur: p ? p.modele : '', list: idListeModeles, placeholder: 'Ex. Monnal T60', autocomplete: 'off' });
    const sansBiomed = el('input', { type: 'checkbox', coche: p ? p.biomed === false : false });
    const numBiomed = el('input', { valeur: p ? p.numBiomed : '', inputmode: 'text', autocomplete: 'off' });
    const numSerie = el('input', { valeur: p ? p.numSerie : '', autocomplete: 'off' });
    const idListeProprio = nouvelId();
    const proprietaire = el('input', { valeur: p ? p.proprietaire : '', list: idListeProprio, placeholder: 'Service, établissement ou fournisseur', autocomplete: 'off' });
    const contact = el('input', { valeur: p ? p.contact : '', placeholder: 'Facultatif : interlocuteur, poste…', autocomplete: 'off' });
    const idListeRaisons = nouvelId();
    const raison = el('input', { valeur: p ? p.raison : '', list: idListeRaisons, placeholder: 'Pourquoi ce prêt ?', autocomplete: 'off' });
    const debut = el('input', { type: 'date', valeur: p ? p.debut : aujourdhui() });
    const retourPrevu = el('input', { type: 'date', valeur: p ? p.retourPrevu : '' });
    const remarques = el('textarea', { rows: '2', placeholder: 'Facultatif : accessoires fournis, état à l\'arrivée…' });
    const amenerBiomed = el('input', { type: 'checkbox' });
    remarques.value = p ? p.remarques || '' : '';
    const message = el('p', { classe: 'message erreur', role: 'alert' });
    const champBiomed = champ('N° biomed', numBiomed);
    const majBiomed = () => { champBiomed.hidden = sansBiomed.checked; };
    sansBiomed.addEventListener('change', majBiomed);
    majBiomed();
    champAvecScan(numBiomed, 'Scanner l\'étiquette biomed', (v) => { numBiomed.value = v; });

    // Photo du matériel prêté : une nouvelle photo remplace l'ancienne ; « Retirer » la supprime.
    let photo = { id: p ? p.photo || '' : '', donnees: p ? p.photoDonnees || '' : '' };
    const apercu = el('img', { classe: 'mat-photo', alt: 'Photo du matériel prêté', hidden: true });
    const afficherApercu = async () => {
      const src = photo.donnees || (photo.id ? await imageDe({ photo: photo.id }) : '');
      apercu.hidden = !src;
      if (src) apercu.src = src;
      boutonRetirer.hidden = !src;
      boutonRecadrer.hidden = !src;
    };
    const prendrePhoto = async (source) => {
      try { const x = await reduirePhoto(source); if (!x) return; photo = { id: '', donnees: x }; message.textContent = ''; } catch (err) { message.textContent = 'Photo illisible ou trop lourde.'; }
      afficherApercu();
    };
    const fichierPhoto = el('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
    fichierPhoto.addEventListener('change', () => { const f = fichierPhoto.files[0]; fichierPhoto.value = ''; if (f) prendrePhoto(f); });
    const boutonRetirer = el('button', { type: 'button', classe: 'cfg-bouton danger', texte: 'Retirer la photo', hidden: true, surclick: () => { photo = { id: '', donnees: '' }; afficherApercu(); } });
    const boutonRecadrer = el('button', { type: 'button', classe: 'cfg-bouton', texte: '✂ Recadrer', hidden: true, surclick: () => { if (apercu.src) prendrePhoto(apercu.src); } });
    const blocPhoto = el('div', { classe: 'mat-photo-bloc' }, el('p', { classe: 'mat-libelle', texte: 'Photo du matériel' }), apercu,
      el('div', { classe: 'mat-boutons' },
        el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Prendre ou choisir une photo', surclick: () => fichierPhoto.click() }), boutonRecadrer, boutonRetirer, fichierPhoto));
    afficherApercu();

    let d;
    const contenu = el('form', {
      classe: 'mat-form', novalidate: true,
      sursubmit: (ev) => {
        ev.preventDefault();
        const t = type.valeur();
        const manque = [!t && 'le type', !proprietaire.value.trim() && 'le propriétaire', !raison.value.trim() && 'la raison du prêt', !debut.value && 'la date de début'].filter(Boolean);
        if (manque.length) { message.textContent = `À renseigner : ${manque.join(', ')}.`; return; }
        if (retourPrevu.value && retourPrevu.value < debut.value) { message.textContent = 'Le retour prévu est avant le début du prêt.'; return; }
        if (etatPrets().ouverts.has(choixRef.value) && (!p || etatPrets().ouverts.get(choixRef.value).id !== p.id)) { message.textContent = `La référence ${choixRef.value} vient d'être occupée : choisissez-en une autre.`; return; }
        d.close();
        const nouveau = !p;
        const aBiomed = nouveau && amenerBiomed.checked;
        const charge = {
          pret: {
            id: p ? p.id : idFiche(), reference: choixRef.value, type: t, modele: modele.value.trim(),
            biomed: !sansBiomed.checked, numBiomed: sansBiomed.checked ? '' : numBiomed.value.trim(), numSerie: numSerie.value.trim(),
            proprietaire: proprietaire.value.trim(), contact: contact.value.trim(), raison: raison.value.trim(),
            debut: debut.value, retourPrevu: retourPrevu.value, remarques: remarques.value.trim(),
            photo: photo.donnees ? '' : photo.id, photoDonnees: photo.donnees,
            amenerBiomed: aBiomed,
          },
        };
        enfiler('enregistrerPret', charge);
        if (nouveau) proposerPublicationPret(charge.pret);
      },
    },
    champ('Référence', choixRef),
    champ('Type de matériel', type.select), type.bloc,
    champ('Modèle', modele),
    el('datalist', { id: idListeModeles }, suggestionsModeles.map((m) => el('option', { value: m }))),
    el('label', { classe: 'mat-case-libelle' }, sansBiomed, el('span', { texte: 'Sans n° biomed' })),
    champBiomed,
    champ('N° de série', numSerie),
    champ('Propriétaire', proprietaire),
    el('datalist', { id: idListeProprio }, [...new Set(tous.map((x) => x.proprietaire).filter(Boolean))].map((v) => el('option', { value: v }))),
    champ('Contact chez le propriétaire', contact),
    champ('Raison du prêt', raison),
    el('datalist', { id: idListeRaisons }, [...new Set([...RAISONS_PRET, ...tous.map((x) => x.raison).filter(Boolean)])].map((v) => el('option', { value: v }))),
    el('div', { classe: 'pret-dates' }, champ('Début du prêt', debut), champ('Retour prévu', retourPrevu)),
    champ('Remarques', remarques),
    blocPhoto,
    p ? null : el('label', { classe: 'mat-case-libelle' }, amenerBiomed, el('span', { texte: 'À amener au biomed (l\'appareil passe « En maintenance »)' })),
    message,
    el('div', { classe: 'mat-boutons' }, el('button', { type: 'submit', classe: 'principal', texte: p ? 'Enregistrer' : 'Affecter le prêt' })));
    d = fenetre(p ? `Modifier le prêt · ${p.reference}` : `Nouveau prêt · ${ref}`, contenu);
  }

  /** Après l'affectation d'un prêt : proposer de publier une information sur le mur (formulaire pré-rempli). */
  function proposerPublicationPret(p) {
    if (typeof Infos === 'undefined' || !Infos.publier) return;
    const nom = nomPret(p);
    let d;
    d = fenetre('Publier une information ?', el('div', {},
      el('p', { texte: `Prêt enregistré sur ${p.reference}.` }),
      el('p', { texte: 'Souhaitez-vous publier une information sur le mur pour prévenir l\'équipe ?' }),
      el('div', { classe: 'mat-boutons' },
        el('button', {
          type: 'button', classe: 'principal', texte: 'Publier une information',
          surclick: () => {
            d.close();
            Infos.publier({
              types: ['information'], importance: 'normale',
              titre: `Matériel de prêt : ${nom} (${p.reference})${p.amenerBiomed ? ' — à amener au biomed' : ''}`,
              texte: [`Prêté par ${p.proprietaire} depuis le ${dateFr(p.debut)}.`, `Raison : ${p.raison}`,
                p.retourPrevu ? `Retour prévu le ${dateFr(p.retourPrevu)}.` : '', p.remarques,
                p.amenerBiomed ? 'Appareil à amener au service biomédical.' : ''].filter(Boolean).join('\n'),
              pieces: p.photoDonnees ? [{ type: 'photo', nom: `${nom}.jpg`.slice(0, 80), donnees: p.photoDonnees }] : [],
            });
          },
        }),
        el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Non merci', surclick: () => d.close() }))));
  }

  /** Matériel rendu : la référence est libérée, le prêt passe dans l'historique. */
  function ouvrirRetour(p) {
    const date = el('input', { type: 'date', valeur: aujourdhui(), min: p.debut || undefined, max: aujourdhui() });
    const remarque = el('textarea', { rows: '2', placeholder: 'Facultatif : rendu à qui, état, accessoires manquants…' });
    const message = el('p', { classe: 'message erreur', role: 'alert' });
    let d;
    const contenu = el('form', {
      classe: 'mat-form', novalidate: true,
      sursubmit: (ev) => {
        ev.preventDefault();
        if (!date.value) { message.textContent = 'Date de retour manquante.'; return; }
        if (p.debut && date.value < p.debut) { message.textContent = 'La date de retour est avant le début du prêt.'; return; }
        d.close();
        enfiler('rendrePret', { id: p.id, date: date.value, remarque: remarque.value.trim() });
      },
    },
    el('p', { texte: `${nomPret(p)} (${p.proprietaire || 'propriétaire non renseigné'}). La référence ${p.reference} redeviendra disponible ; le prêt restera consultable dans l'historique.` }),
    champ('Date de retour', date), champ('Remarque', remarque), message,
    el('div', { classe: 'mat-boutons' }, el('button', { type: 'submit', classe: 'principal', texte: 'Confirmer le retour' })));
    d = fenetre(`Matériel rendu · ${p.reference}`, contenu);
  }
  // ---------- QR code et puce NFC des références de prêt ----------
  // L'étiquette porte la RÉFÉRENCE (« PRÊT 03 »), pas le matériel : elle est fixée sur le matériel prêté pendant le prêt
  // et resservira au prochain. Le lien « #pret=PRET03 » ouvre le prêt en cours (ou l'affectation si la référence est libre).
  const codeRef = (ref) => ref.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const refDuCode = (code) => references().find((r) => codeRef(r) === String(code || '').toUpperCase()) || null;
  const adressePret = (ref) => `${location.origin}${location.pathname.replace(/index\.html$/, '')}#pret=${codeRef(ref)}`;
  const textePuce = (ref) => `SMUR Avignon\nMatériel de prêt ${ref}`;

  const boutonQrNfc = (ref) => el('button', { type: 'button', classe: 'cfg-mini', texte: 'QR / NFC', title: `QR code et puce NFC de ${ref}`, surclick: () => ouvrirQrNfcPret(ref) });

  /** Écrit le lien et le texte de la référence sur une puce NTAG (Chrome Android). */
  async function ecrirePucePret(ref, bouton, sortie) {
    const delai = new AbortController();
    const minuterie = setTimeout(() => delai.abort(), 30000);
    bouton.disabled = true;
    sortie.className = 'message';
    sortie.textContent = 'Approchez la puce du dos du téléphone…';
    const cacherCible = CibleNfc.montrer();
    try {
      await new NDEFReader().write({ records: [{ recordType: 'url', data: adressePret(ref) }, { recordType: 'text', lang: 'fr', data: textePuce(ref) }] }, { signal: delai.signal, overwrite: true });
      sortie.textContent = `Puce effacée puis encodée pour ${ref}.`;
      sortie.className = 'message succes';
    } catch (e) {
      sortie.textContent = e.name === 'AbortError' ? 'Aucune puce détectée. Réessayez en la gardant contre le téléphone.'
        : (e.name === 'NotAllowedError' ? 'Autorisez le NFC pour cette application et vérifiez qu\'il est activé sur le téléphone.'
          : `Écriture impossible (${e.name}). Puce verrouillée ou non compatible : seules les puces NTAG (213, 215, 216) sont prises en charge.`);
      sortie.className = 'message erreur';
    } finally {
      clearTimeout(minuterie);
      cacherCible();
      bouton.disabled = false;
    }
  }

  // Étiquette commune à toutes les références de prêt, personnalisable comme celle des contenants
  // (taille, couleur, négatif, lignes libres, logo). Réglage partagé par tous les appareils (backend,
  // action « enregistrerEtiquettePret ») ; hors ligne, le dernier réglage en attente d'envoi fait foi.
  const CLE_ETIQUETTE_PRET = 'mysmur.materiel.etiquettePret'; // ancien réglage local (repris s'il n'y a rien d'autre)
  const ETIQUETTE_PRET_DEFAUT = { largeur: 40, hauteur: 50, champ1: 'SMUR Avignon', champ2: 'Matériel de prêt' };
  const E = () => Inventaires.etiquette;
  function reglageEtiquettePret() {
    // Ordre : réglage en cours de saisie, puis dernier réglage en attente d'envoi, puis celui du serveur.
    const attente = enAttente().filter((x) => x.action === 'enregistrerEtiquettePret').pop();
    let r = etiquetteAEnvoyer || etiquetteEnvoyee || (attente ? attente.donnees.etiquette : null) || (donnees && donnees.etiquettePret) || null;
    if (!r) { try { r = JSON.parse(localStorage.getItem(CLE_ETIQUETTE_PRET)); } catch (e) { /* rien */ } }
    return E().normaliser({ ...ETIQUETTE_PRET_DEFAUT, ...(r || {}) });
  }
  let minuterieEtiquette = null;
  let etiquetteAEnvoyer = null; // réglage modifié, pas encore mis en file
  let etiquetteEnvoyee = null; // dernier réglage mis en file par cet appareil (jusqu'à la relecture du serveur)
  /** Enregistre le réglage (regroupé : un seul envoi après une rafale de changements). */
  function enregistrerEtiquettePret(r) {
    etiquetteAEnvoyer = r;
    if (donnees) { donnees.etiquettePret = r; ecrireCache(donnees); }
    clearTimeout(minuterieEtiquette);
    minuterieEtiquette = setTimeout(envoyerEtiquettePret, 1500);
  }
  function envoyerEtiquettePret() {
    clearTimeout(minuterieEtiquette);
    if (!etiquetteAEnvoyer) return;
    outils.mettreEnFile({ action: 'enregistrerEtiquettePret', donnees: { etiquette: etiquetteAEnvoyer }, agent: '' });
    etiquetteEnvoyee = etiquetteAEnvoyer;
    etiquetteAEnvoyer = null;
  }
  const objetPret = (ref) => ({ nom: ref, url: adressePret(ref) });

  /** QR code et encodage de la puce d'une référence. */
  function ouvrirQrNfcPret(ref) {
    const nfcDispo = 'NDEFReader' in window;
    const sortie = el('p', { classe: 'message', role: 'status' });
    const bouton = el('button', { type: 'button', classe: 'principal', texte: 'Encoder la puce NFC', disabled: !nfcDispo });
    bouton.addEventListener('click', () => ecrirePucePret(ref, bouton, sortie));
    const apercu = el('div', { classe: 'inv-etiquette-apercu pret-etiquette-apercu' }, E().svg(objetPret(ref), reglageEtiquettePret()));
    const regler = (champ, valeur) => {
      const avant = reglageEtiquettePret();
      const brut = { champ1: avant.champ1 || '', champ2: avant.champ2 || '', [champ]: valeur };
      const r = { ...E().normaliser({ ...avant, ...brut }), champ1: String(brut.champ1).trim().slice(0, 40), champ2: String(brut.champ2).trim().slice(0, 40) };
      enregistrerEtiquettePret(r);
      apercu.replaceChildren(E().svg(objetPret(ref), r));
    };
    const d = fenetre(`QR code et puce NFC · ${ref}`, el('div', { classe: 'mat-nfc pret-qrnfc' },
      apercu,
      el('p', { classe: 'aide-question', texte: `Le QR code et la puce ouvrent ${ref} dans MySMUR : le prêt en cours, ou l'affectation d'un prêt si la référence est libre. Ils restent valables d'un prêt à l'autre.` }),
      el('details', { classe: 'inv-details-reglages', open: true }, el('summary', { texte: 'Format, couleur et texte de l\'étiquette' }),
        E().controles(reglageEtiquettePret(), regler),
        el('p', { classe: 'aide-question', texte: 'Réglage commun à toutes les références de prêt, partagé par tous les appareils.' })),
      el('pre', { classe: 'mat-apercu', texte: `${adressePret(ref)}\n\n${textePuce(ref)}` }),
      nfcDispo ? null : el('p', { classe: 'message erreur', texte: 'Écriture NFC impossible sur cet appareil : il faut Chrome sur un téléphone Android avec le NFC activé. Vous pouvez recopier le contenu ci-dessus avec une appli NFC (enregistrements « URL » et « Texte »).' }),
      el('p', { classe: 'aide-question', texte: 'L\'ancien contenu de la puce est effacé. Appuyez sur « Encoder », puis gardez la puce contre le dos du téléphone jusqu\'au message de confirmation.' }),
      el('div', { classe: 'mat-boutons' }, bouton,
        el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Imprimer l\'étiquette', surclick: () => imprimerEtiquettesPrets([ref]) }),
        el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Aperçu taille réelle', surclick: () => E().apercuTailleReelle(objetPret(ref), reglageEtiquettePret()) }),
        nfcDispo ? CibleNfc.lien() : null),
      sortie), { large: true });
    if (d) d.addEventListener('close', envoyerEtiquettePret);
  }

  /** Toutes les références : impression des étiquettes (cochées) et accès à l'encodage de chaque puce. */
  function ouvrirEtiquettesPrets() {
    const refs = references();
    const cases = new Map(refs.map((r) => [r, el('input', { type: 'checkbox', coche: true })]));
    let d;
    d = fenetre('QR codes et puces NFC des prêts', el('div', { classe: 'mat-form' },
      el('p', { classe: 'aide-question', texte: 'Une étiquette QR et une puce NFC par référence. On les fixe sur le matériel prêté pendant toute la durée du prêt, puis on les récupère au retour pour le prêt suivant.' }),
      el('ul', { classe: 'pret-liste-etiquettes' }, refs.map((r) => el('li', {},
        el('label', { classe: 'mat-case-libelle' }, cases.get(r), el('span', { texte: r })),
        el('button', { type: 'button', classe: 'cfg-mini', texte: 'Puce NFC', surclick: () => { d.close(); ouvrirQrNfcPret(r); } })))),
      el('div', { classe: 'mat-boutons' },
        el('button', { type: 'button', classe: 'principal', texte: 'Imprimer les étiquettes cochées', surclick: () => {
          const choix = refs.filter((r) => cases.get(r).checked);
          if (!choix.length) return;
          d.close();
          imprimerEtiquettesPrets(choix);
        } }))));
  }

  /** Planche A4 des étiquettes de prêt, au format et à la couleur réglés (comme celles des contenants). */
  function imprimerEtiquettesPrets(refs) {
    envoyerEtiquettePret();
    E().imprimer(refs.map(objetPret), reglageEtiquettePret());
  }

  /** Lien « #pret=… » : prêt en cours sur la référence, sinon affectation (ou simple avis). */
  function ouvrirReferencePret(ref) {
    const p = etatPrets().ouverts.get(ref);
    if (p) { ouvrirDetailPret(p); return; }
    if (peutPreter()) { ouvrirPret(ref, null); return; }
    fenetre(ref, el('p', { texte: `${ref} est disponible : aucun matériel en prêt sur cette référence.` }));
  }

  /** Modèles connus dans la base du matériel (suggestions). */
  const nomsModelesConnus = () => [...fiches().map((f) => f.modele), ...modeles().map((m) => m.modele)];

  // ---------- Interface publique ----------
  return {
    /** Lecture d'un QR code / code-barres par la caméra (barre d'actions rapide) : texte brut lu. */
    scanDisponible,
    scanner(surLu) { scannerCode(surLu, true); },
    demarrer(o) {
      outils = o;
      zone = document.getElementById('zone-materiel');
      donnees = lireCache();
    },
    /** Vue « suivi-materiel » (onglet Appareils) ou « materiel-prets » (onglet Matériel de prêt). */
    afficher(choix) {
      if (!zone) return;
      if (choix === 'prets' || choix === 'appareils' || choix === 'monnal' || choix === 'glycemie') onglet = choix;
      zone.hidden = false;
      rendre();
      charger();
    },
    masquer() {
      if (zone) zone.hidden = true;
      document.querySelectorAll('.mat-dialogue').forEach((d) => d.close());
    },
    /** Appelé par app.js quand la file d'attente a été envoyée : relit la base. */
    surEnvoi() {
      etiquetteEnvoyee = null; // le serveur a reçu le réglage : on le relit avec le reste
      charger(); // même masqué : les modifications envoyées doivent rejoindre le cache local
    },
    actions: ACTIONS,
    etatRevision,
    rappelsMaintenance,
    /** Formulaire de maintenance d'un rappel de l'accueil : tous les agents sauf les étudiants. */
    ouvrirControle(groupe) {
      if (!peutControler()) return;
      if (groupe.glycemie) ouvrirChoixMonnal(groupe.ids, true);
      else if (motifMonnal.test(normaliser(groupe.appareil))) ouvrirChoixMonnal(groupe.ids);
      else ouvrirControle(groupe);
    },
    peutControler,
    /**
     * Appareil correspondant à un code lu (puce NFC, QR code, code-barres de l'étiquette biomed) :
     * lien « #mat=… », n° biomed ou n° de série (exact, ou « Biomed … » / « S/N … » dans le texte d'une puce).
     * Sert aux inventaires : le champ reçoit alors le n° interne SMUR. Renvoie null si rien ne correspond.
     */
    identifier(code) {
      const t = String(code || '').trim();
      if (!t) return null;
      const liste = fiches().sort((a, b) => Number(!enService(a)) - Number(!enService(b)));
      const lien = t.match(/#mat=([a-z0-9]{6,20})/);
      if (lien) return liste.find((f) => f.id === lien[1]) || null;
      // Référence de prêt (QR code / puce « #pret=PRET03 », ou « PRÊT 03 » saisi) : le matériel actuellement prêté sous cette référence.
      const lienPret = t.match(/#pret=([A-Za-z0-9]{3,12})/);
      const refPret = lienPret ? refDuCode(lienPret[1]) : references().find((r) => normaliser(r).replace(/\s+/g, '') === normaliser(t).replace(/\s+/g, '')) || null;
      if (lienPret || refPret) return (refPret && liste.find((f) => f.pret === refPret && !f.archive)) || null;
      const n = normaliser(t);
      return liste.find((f) => (f.numBiomed && normaliser(f.numBiomed) === n) || (f.numSerie && normaliser(f.numSerie) === n)
          || (f.autresCodes || []).some((c) => normaliser(c) === n))
        || liste.find((f) => (f.numBiomed && n.includes(normaliser(`Biomed ${f.numBiomed}`))) || (f.numSerie && n.includes(normaliser(`S/N ${f.numSerie}`))))
        || null;
    },
    /** Appareils en service (ni archivés ni réformés), pour le choix « dans la liste » d'un matériel attendu en inventaire. */
    appareils() {
      return fiches().filter(enService)
        .map((f) => ({ id: f.id, type: f.type || '', modele: f.modele || '', numInterne: f.numInterne || '', numSerie: f.numSerie || '', numBiomed: f.numBiomed || '', pret: f.pret || '' }));
    },
    /** Types d'appareils connus (types par défaut + types utilisés dans la base). */
    types() {
      const t = new Set(TYPES_DEFAUT);
      fiches().forEach((f) => { if (f.type) t.add(f.type); });
      return [...t].sort((a, b) => a.localeCompare(b, 'fr'));
    },
    /** Met à jour la liste gardée sur l'appareil, sans rien afficher (pour reconnaître les appareils scannés). */
    actualiser() { return charger(); },
    /** Recharge la liste et renvoie une promesse toujours résolue (hors ligne : on garde le cache existant). */
    recharger() { return charger().catch(() => {}); },
    /** Lien « #pret=<code> » (QR code ou puce d'une référence de prêt). */
    ouvrirPretDuCode(code) {
      const go = () => { const ref = refDuCode(code); if (ref) ouvrirReferencePret(ref); };
      if (donnees && donnees.prets) go(); else charger().then(go);
    },
    /** Référence de prêt scannée (QR code ou puce, « #pret=<code> ») : fiche rapide du matériel prêté, sinon fenêtre de la référence. */
    ouvrirPretRapide(code) {
      const go = () => {
        const ref = refDuCode(code);
        if (!ref) { fenetre('Référence de prêt', el('p', { texte: `Référence « ${code} » inconnue : vérifiez l'étiquette.` })); return; }
        const p = etatPrets().ouverts.get(ref);
        const fiche = p && etat().fiches.find((x) => x.idPret === p.id);
        if (fiche) ouvrirRapide(fiche.id); else ouvrirReferencePret(ref);
      };
      if (donnees && donnees.prets) go(); else charger().then(go);
    },
    /** Action rapide (scan) : fenêtre statut / dernier contenant / signaler / maintenance / historique. */
    ouvrirRapide(id) {
      if (fiches().some((f) => f.id === id)) { ouvrirRapide(id); return; }
      charger().then(() => { if (fiches().some((f) => f.id === id)) ouvrirRapide(id); });
    },
    /** Lien « #mat=<id> » (puce NFC) : ouvre la fiche de l'appareil. */
    ouvrirAppareil(id) {
      if (fiches().some((f) => f.id === id)) { ouvrirFiche(id); return; }
      charger().then(() => { if (fiches().some((f) => f.id === id)) ouvrirFiche(id); });
    },
    oublier() {
      try { localStorage.removeItem(CLE_CACHE); } catch (e) { /* rien */ }
      donnees = null;
    },
  };
})();
