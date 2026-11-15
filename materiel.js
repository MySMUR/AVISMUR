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
 */
const Materiel = (() => {
  const CLE_CACHE = 'avismur_materiel';
  const ACTIONS = ['enregistrerMateriel', 'enregistrerModeles', 'ajouterIntervention', 'supprimerIntervention'];
  const TYPES_DEFAUT = ['Scope', 'PSE', 'Défibrillateur', 'Scope/défibrillateur', 'Respirateur', 'Aspirateur de mucosités', 'Attelle'];
  const STATUTS_DEFAUT = ['En service', 'En maintenance', 'En panne', 'Prêté', 'Réformé'];
  const INTERVENTIONS_DEFAUT = ['Révision', 'Intervention', 'Réparation', 'Panne signalée', 'Contrôle', 'Mise à jour logicielle', 'Note', 'Autre'];
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
  const typesIntervention = () => (donnees && donnees.typesIntervention) || INTERVENTIONS_DEFAUT;
  const nomAppareil = (f) => `${f.type || 'Matériel'}${f.numInterne ? ` n° ${f.numInterne}` : ''}`;

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
            prochaineRevision: d.prochaineRevision, saisiPar: e.agent || '', attente: true, idFile: e.id,
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
      } else if (e.action === 'supprimerIntervention') {
        interventions = interventions.filter((i) => i.id !== d.intervention);
      }
    });
    const fichesResolues = [...parId.values()].map((f) => resoudre(f, modeles));
    return { fiches: fichesResolues, modeles: [...modeles.values()], interventions, attente, modelesAttente };
  }
  /** Appareil rattaché à une fiche type : type, modèle, périodicité (et photo par défaut) viennent de la fiche type. */
  function resoudre(f, modeles) {
    const m = f.modeleType && modeles.get(f.modeleType);
    const r = { ...f, modeleType: f.modeleType || '' };
    r.plans = plansDe(r);
    if (m) {
      const dates = new Map(r.plans.map((p) => [p.id, p.prochaine]));
      COMMUNS.forEach((k) => { r[k] = m[k]; });
      r.plans = plansDe(m).map((p) => ({ id: p.id, libelle: p.libelle, periodicite: p.periodicite, prochaine: dates.get(p.id) || '' }));
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
  const resumePlans = (plans) => (plans || []).map((p) => `${p.libelle}${p.periodicite ? ` (${p.periodicite} mois)` : ''}`).join(', ');
  /** Changements des plans pour la main courante (comme le serveur). */
  function decrirePlans(avant, apres) {
    const lignes = [];
    const parId = new Map((avant || []).map((p) => [p.id, p]));
    const perio = (p) => (p.periodicite ? `tous les ${p.periodicite} mois` : 'sans périodicité');
    (apres || []).forEach((p) => {
      const a = parId.get(p.id);
      parId.delete(p.id);
      if (!a) { lignes.push(`Maintenance ajoutée : ${p.libelle} (${perio(p)}${p.prochaine ? `, prochaine le ${dateFr(p.prochaine)}` : ''})`); return; }
      if (a.libelle !== p.libelle) lignes.push(`Maintenance « ${a.libelle} » renommée « ${p.libelle} »`);
      if (String(a.periodicite) !== String(p.periodicite)) lignes.push(`Maintenance « ${p.libelle} » : ${perio(a)} → ${perio(p)}`);
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
  }

  function enfiler(action, charge) {
    const agent = '';
    const ok = outils.mettreEnFile({ action, donnees: charge, agent });
    rendre();
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
    const ajout = el('button', { type: 'button', classe: 'cfg-mini', texte: '+ Ajouter une maintenance', surclick: () => { plans.push({ id: idPlan(), libelle: '', periodicite: 12, prochaine: '' }); rendrePlans(); liste.querySelector('.mat-plan:last-child input')?.focus(); } });
    function rendrePlans() {
      ajout.hidden = bloque || !actif;
      liste.replaceChildren(...(plans.length ? plans.map((p, n) => el('div', { classe: 'mat-plan mat-grille' },
        champ('Maintenance', el('input', { valeur: p.libelle, placeholder: 'ex. Révision annuelle, Contrôle électrique…', disabled: bloque || !actif, surinput: (ev) => { p.libelle = ev.target.value; } })),
        champ('Périodicité (mois)', el('input', { type: 'number', min: '1', max: '120', valeur: p.periodicite, disabled: bloque || !actif, surinput: (ev) => { p.periodicite = Number(ev.target.value) || ''; } })),
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
          plans = plansModele.map((p) => ({ id: p.id, libelle: p.libelle, periodicite: p.periodicite, prochaine: dates.get(p.id) || '' }));
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
      if (filtre.statut === 'actifs' && (f.archive || f.statut === 'Réformé')) return false;
      if (filtre.statut === 'archives' && !f.archive && f.statut !== 'Réformé') return false;
      if (filtre.statut && !['actifs', 'archives', 'tous'].includes(filtre.statut) && f.statut !== filtre.statut) return false;
      if (filtre.type && f.type !== filtre.type) return false;
      if (filtre.alerte === 'retard' && !etatRevision(f).retard) return false;
      if (filtre.alerte === 'bientot' && !etatRevision(f).bientot) return false;
      if (filtre.alerte === 'traceur' && !f.traceur) return false;
      if (t) {
        const botte = normaliser([f.type, f.modele, f.numInterne, f.numBiomed, f.numSerie, f.nomTraceur, f.remarques, f.versionLogiciel].join(' '));
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
    const { fiches: toutes, attente } = etat();
    const actives = toutes.filter((f) => !f.archive && f.statut !== 'Réformé');
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
      el('div', { classe: 'mat-boutons' },
        'NDEFReader' in window ? el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Lire une puce NFC', surclick: lireNfc }) : null,
        el('button', { type: 'button', classe: 'cfg-bouton', texte: `Matériels types (${modeles().filter((m) => !m.archive).length})`, surclick: ouvrirModeles }),
        estAdmin() ? el('button', { type: 'button', classe: 'principal mat-nouveau', texte: '+ Nouveau matériel', surclick: () => ouvrirFiche(null, true) }) : null));

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
      [['actifs', 'En service, panne, maintenance'], ['tous', 'Tout le matériel'], ...statuts().map((s) => [s, s]), ['archives', 'Réformés et archivés']]
        .map(([v, t]) => el('option', { value: v, texte: t, selected: filtre.statut === v })));
    const filtres = el('div', { classe: 'mat-filtres' },
      el('label', { for: idRecherche, classe: 'invisible', texte: 'Rechercher' }), recherche, choixType, choixStatut,
      el('button', { type: 'button', classe: `cfg-bouton${filtre.alerte === 'traceur' ? ' inv-actif' : ''}`, texte: 'Avec traceur', 'aria-pressed': String(filtre.alerte === 'traceur'), surclick: bascule('alerte', 'traceur') }));

    const barreSelection = estAdmin() && selection.size ? el('div', { classe: 'mat-selection', role: 'region', 'aria-label': 'Sélection' },
      el('span', { texte: `${selection.size} appareil${selection.size > 1 ? 's' : ''} sélectionné${selection.size > 1 ? 's' : ''}` }),
      el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Modifier la sélection', surclick: () => ouvrirModifGroupee([...selection]) }),
      el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Ajouter une intervention', surclick: () => ouvrirIntervention([...selection]) }),
      el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Tout désélectionner', surclick: () => { selection.clear(); rendre(); } })) : null;

    const liste = el('div', { classe: 'mat-liste', id: 'mat-liste' });
    const avis = [];
    if (erreur) avis.push(el('p', { classe: 'message erreur', texte: erreur }));
    if (!donnees && chargementEnCours) avis.push(el('p', { classe: 'message', texte: 'Chargement du matériel…' }));
    if (attente.size) avis.push(el('p', { classe: 'message mat-attente-avis', texte: `${attente.size} appareil(s) modifié(s) sur cet appareil, en attente d'envoi au serveur.` }));

    zone.replaceChildren(entete, compteurs, filtres, ...avis, barreSelection, liste);
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
    const groupes = new Map();
    visibles.forEach((f) => { if (!groupes.has(f.type)) groupes.set(f.type, []); groupes.get(f.type).push(f); });
    const blocs = [];
    groupes.forEach((membres, type) => {
      const tousCoches = membres.every((f) => selection.has(f.id));
      blocs.push(el('section', { classe: 'mat-groupe' },
        el('h2', { classe: 'mat-groupe-titre' },
          estAdmin() ? el('input', {
            type: 'checkbox', coche: tousCoches, 'aria-label': `Sélectionner tous les ${type}`,
            surchange: (e) => { membres.forEach((f) => (e.target.checked ? selection.add(f.id) : selection.delete(f.id))); rendre(); },
          }) : null,
          el('span', { texte: type }), el('small', { texte: String(membres.length) })),
        el('ul', { classe: 'mat-lignes' }, membres.map((f) => ligne(f, interventions, attente)))));
    });
    liste.replaceChildren(...blocs);
  }

  function ligne(f, interventions, attente) {
    const rev = etatRevision(f);
    const derniere = interventions.filter((i) => i.materiel === f.id).sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
    return el('li', { classe: `mat-ligne${selection.has(f.id) ? ' choisie' : ''}` },
      estAdmin() ? el('input', {
        type: 'checkbox', classe: 'mat-case', coche: selection.has(f.id), 'aria-label': `Sélectionner ${nomAppareil(f)}`,
        surchange: (e) => { if (e.target.checked) selection.add(f.id); else selection.delete(f.id); rendre(); },
      }) : null,
      el('button', { type: 'button', classe: 'mat-ouvrir', surclick: () => ouvrirFiche(f.id) },
        el('span', { classe: 'mat-num', texte: f.numInterne || '?' }),
        aPhoto(f) ? vignette(f, 'mat-vignette') : null,
        el('span', { classe: 'mat-corps' },
          el('span', { classe: 'mat-nom' }, el('strong', { texte: nomAppareil(f) }), f.modele ? el('span', { texte: ` · ${f.modele}` }) : null,
            f.traceur ? el('span', { classe: 'mat-traceur', title: `Traceur GeoTraceSMUR${f.nomTraceur ? ` : ${f.nomTraceur}` : ''}`, texte: '📡' }) : null),
          el('span', { classe: 'mat-ids', texte: [f.numBiomed && `Biomed ${f.numBiomed}`, f.numSerie && `S/N ${f.numSerie}`].filter(Boolean).join(' · ') || 'N° biomed et série non renseignés' }),
          derniere ? el('span', { classe: 'mat-derniere', texte: `Dernière intervention : ${derniere.type.toLowerCase()} le ${dateFr(derniere.date)}` }) : null),
        el('span', { classe: 'mat-etats' },
          f.statut !== 'En service' ? el('span', { classe: `mat-pastille statut-${normaliser(f.statut).replace(/\W+/g, '-')}`, texte: f.statut }) : null,
          el('span', { classe: `mat-pastille rev-${rev.classe}`, texte: rev.texte }),
          attente.has(f.id) ? el('span', { classe: 'mat-pastille attente', texte: 'En attente d\'envoi' }) : null)));
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
        ligneInfo('Matériel type', f.modeleType ? nomModele(modeleDe(f.modeleType)) : 'Non (matériel unique)'),
        ligneInfo('Type', f.type), ligneInfo('Modèle', f.modele), ligneInfo('N° interne SMUR', f.numInterne),
        ligneInfo('N° biomed', f.biomed ? f.numBiomed : 'Sans n° biomed'), ligneInfo('N° de série', f.numSerie), ligneInfo('Statut', f.statut),
        f.maintenance ? (f.plans.length ? f.plans.flatMap((p) => ligneInfo(p.libelle, `${p.prochaine ? `prochaine le ${dateFr(p.prochaine)}` : 'échéance non renseignée'}${p.periodicite ? ` · tous les ${p.periodicite} mois` : ''}`)) : ligneInfo('Maintenance préventive', 'Aucune maintenance définie'))
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
        el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Dupliquer', title: 'Nouvel appareil du même type et du même modèle', surclick: () => { d.close(); ouvrirEdition(null, f); } })) : null,
      el('h3', { texte: 'Main courante de l\'appareil' }),
      el('p', { classe: 'aide-question', texte: 'Création et modifications de la fiche (consignées automatiquement), révisions, interventions, réparations et notes.' }),
      historique.length ? el('ol', { classe: 'mat-historique' }, historique.map((i) => el('li', { classe: i.attente ? 'attente' : '' },
        el('p', { classe: 'mat-histo-tete' }, el('strong', { texte: i.type }), i.maintenance ? el('span', { texte: ` · ${i.maintenance}` }) : null, el('span', { texte: ` · ${dateFr(i.date)}` }),
          i.intervenant ? el('span', { texte: ` · ${i.intervenant}` }) : null, i.attente ? el('span', { classe: 'mat-pastille attente', texte: 'En attente d\'envoi' }) : null),
        i.description ? el('p', { classe: 'mat-histo-texte', texte: i.description, style: 'white-space: pre-line' }) : null,
        i.prochaineRevision ? el('p', { classe: 'mat-histo-note', texte: `Prochaine échéance${i.maintenance ? ` (${i.maintenance})` : ''} fixée au ${dateFr(i.prochaineRevision)}` }) : null,
        el('p', { classe: 'mat-histo-note', texte: i.saisiPar ? `Saisi par ${i.saisiPar}` : '' }),
        estAdmin() && !JOURNAL.includes(i.type) ? el('button', {
          type: 'button', classe: 'cfg-mini danger', texte: 'Retirer',
          surclick: () => {
            if (!window.confirm('Retirer cette entrée de l\'historique ?')) return;
            if (i.attente) outils.retirerDeFile(i.idFile);
            else enfiler('supprimerIntervention', { intervention: i.id });
            d.close();
            ouvrirFiche(f.id);
          },
        }) : null))) : el('p', { classe: 'mat-vide', texte: 'Aucune entrée pour le moment.' }));
    d = fenetre(`${nomAppareil(f)}${f.modele ? ` · ${f.modele}` : ''}`, contenu, { large: true });
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
      const autres = fiches().filter((x) => x.id !== fiche.id && !x.archive && (x.type === (f ? f.type : fiche.type) || (fiche.modele && x.modele === fiche.modele)));
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
    const vus = new Map();
    for (const x of final.values()) {
      if (x.archive) continue;
      const cles = [];
      if (x.numInterne) cles.push([`i|${normaliser(x.type)}|${normaliser(x.numInterne)}`, `${x.type} n° ${x.numInterne} existe déjà.`]);
      if (x.numSerie) cles.push([`s|${normaliser(x.numSerie)}`, `Le n° de série ${x.numSerie} est déjà attribué.`]);
      if (x.numBiomed) cles.push([`b|${normaliser(x.numBiomed)}`, `Le n° biomed ${x.numBiomed} est déjà attribué.`]);
      for (const [cle, texte] of cles) {
        if (vus.has(cle) && vus.get(cle) !== x.id) return texte;
        vus.set(cle, x.id);
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
          el('span', { texte: `${nomAppareil(x)}${x.modele ? ` · ${x.modele}` : ''}` })))),
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
  function ouvrirIntervention(ids) {
    const toutes = fiches().filter((x) => !x.archive);
    const cibles = new Set(ids);
    const e = {
      date: el('input', { type: 'date', valeur: aujourdhui(), max: aujourdhui(), required: true }),
      type: selectListe(typesIntervention(), 'Révision'),
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
      e.plan.replaceChildren(el('option', { value: '', texte: '— Aucune —' }), ...communs.map((p) => el('option', { value: p.id, texte: `${p.libelle}${p.periodicite ? ` (${p.periodicite} mois)` : ''}` })));
      if (communs.some((p) => p.id === avant)) e.plan.value = avant;
      else if (communs.length === 1 && ['Révision', 'Contrôle', 'Intervention'].includes(e.type.value)) e.plan.value = communs[0].id;
      blocPlan.hidden = !communs.length;
    }
    /** Prochaine échéance proposée = date + périodicité de la maintenance choisie. */
    function proposerProchaine() {
      const choisis = toutes.filter((x) => cibles.has(x.id));
      const plan = e.plan.value && (choisis[0].plans || []).find((p) => p.id === e.plan.value);
      if (plan && plan.periodicite && e.date.value) {
        e.prochaine.value = ajouterMois(e.date.value, plan.periodicite);
        aide.textContent = `Proposée d'après la périodicité de « ${plan.libelle} » (${plan.periodicite} mois). Laissez vide pour ne pas changer l'échéance.`;
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
    el('optgroup', { label: 'Un appareil' }, toutes.slice().sort(tri).map((x) => el('option', { value: x.id, texte: `${nomAppareil(x)}${x.modele ? ` · ${x.modele}` : ''}` }))));
    rendreCibles();
    majPlans();
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


  // ---------- Lecture d'un QR code / code-barres (caméra) ----------
  const scanDisponible = () => 'BarcodeDetector' in window && Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
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
  async function scannerCode(surLu) {
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
          if (r.length && r[0].rawValue) { const v = valeurCode(r[0].rawValue); fermer(); if (v) surLu(v); return; }
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
    const uniques = toutes.filter((x) => !x.modeleType && !x.archive).length;
    const contenu = el('div', { classe: 'mat-modeles' },
      el('p', { classe: 'aide-question', texte: 'Un matériel type « Type > modèle » regroupe des appareils identiques : n° biomed ou non, maintenance préventive et périodicité, logiciel suivi, photo. Le modifier met à jour tous les appareils rattachés. Les numéros, la révision prévue, le statut et le traceur restent propres à chaque appareil.' }),
      estAdmin() ? el('div', { classe: 'mat-boutons' }, el('button', { type: 'button', classe: 'principal', texte: '+ Nouveau matériel type', surclick: () => { d.close(); ouvrirModele(null); } })) : null,
      tries.length ? el('ul', { classe: 'mat-lignes' }, tries.map((m) => {
        const nb = toutes.filter((x) => x.modeleType === m.id && !x.archive).length;
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
      plans: depuis ? (depuis.plans || []).map((p) => ({ id: p.id, libelle: p.libelle, periodicite: p.periodicite })) : [{ id: 'rev', libelle: 'Révision', periodicite: 12 }], photo: (depuis && depuis.photo) || '', photoDonnees: (depuis && depuis.photoDonnees) || '',
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
        el('span', { texte: `${nomAppareil(x)}${x.modele ? ` · ${x.modele}` : ''}${x.modeleType && x.modeleType !== base.id ? ` (rattaché à ${nomModele(modeleDe(x.modeleType))})` : ''}` }))) : [el('p', { classe: 'mat-vide', texte: 'Aucun appareil de ce type.' })]));
    }
    let voirTous = false;
    e.type.select.addEventListener('change', rendreCases);

    let d;
    const lire = () => ({
      ...base, type: e.type.valeur(), modele: e.modele.value.trim(), plans: e.plans.valeur().map(({ id, libelle, periodicite }) => ({ id, libelle, periodicite })),
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
    return ['SMUR Avignon', [a('type'), a('numInterne'), a('modele')].filter(Boolean).join(' '), a('numBiomed'), a('numSerie')]
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
      el('div', { classe: 'mat-boutons' }, bouton), sortie);
    fenetre(`Puce NFC · ${nomAppareil(f)}`, contenu, { large: true });
  }

  /** Lit une puce : lien « #mat=… », sinon n° de série / biomed trouvé dans le texte ou n° de série de la puce. */
  async function lireNfc() {
    const sortie = el('p', { classe: 'message', role: 'status', texte: 'Approchez la puce du dos du téléphone…' });
    const arret = new AbortController();
    const d = fenetre('Lire une puce NFC', el('div', {}, sortie));
    d.addEventListener('close', () => arret.abort());
    try {
      const lecteur = new NDEFReader();
      lecteur.addEventListener('reading', ({ message, serialNumber }) => {
        const textes = [serialNumber || ''];
        message.records.forEach((r) => { try { textes.push(new TextDecoder(r.encoding || 'utf-8').decode(r.data)); } catch (e) { /* ignoré */ } });
        const tout = textes.join('\n');
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

  // ---------- Interface publique ----------
  return {
    demarrer(o) {
      outils = o;
      zone = document.getElementById('zone-materiel');
      donnees = lireCache();
    },
    afficher() {
      if (!zone) return;
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
      charger(); // même masqué : les modifications envoyées doivent rejoindre le cache local
    },
    actions: ACTIONS,
    /**
     * Appareil correspondant à un code lu (puce NFC, QR code, code-barres de l'étiquette biomed) :
     * lien « #mat=… », n° biomed ou n° de série (exact, ou « Biomed … » / « S/N … » dans le texte d'une puce).
     * Sert aux inventaires : le champ reçoit alors le n° interne SMUR. Renvoie null si rien ne correspond.
     */
    identifier(code) {
      const t = String(code || '').trim();
      if (!t) return null;
      const liste = fiches().sort((a, b) => Number(Boolean(a.archive)) - Number(Boolean(b.archive)));
      const lien = t.match(/#mat=([a-z0-9]{6,20})/);
      if (lien) return liste.find((f) => f.id === lien[1]) || null;
      const n = normaliser(t);
      return liste.find((f) => (f.numBiomed && normaliser(f.numBiomed) === n) || (f.numSerie && normaliser(f.numSerie) === n))
        || liste.find((f) => (f.numBiomed && n.includes(normaliser(`Biomed ${f.numBiomed}`))) || (f.numSerie && n.includes(normaliser(`S/N ${f.numSerie}`))))
        || null;
    },
    /** Met à jour la liste gardée sur l'appareil, sans rien afficher (pour reconnaître les appareils scannés). */
    actualiser() { charger(); },
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
