/*
 * Suivi du matériel biomédical (menu Inventaires > Suivi matériel ; Administration > Base du matériel).
 *
 * Base des appareils : type, modèle, n° interne SMUR, n° biomed, n° de série, révision prévue,
 * historique des révisions / interventions / réparations, traceur GeoTraceSMUR.
 * Lecture pour tous ; création, modification et interventions pour les administrateurs.
 * « Répercuter » : après la modification d'une fiche, les mêmes changements peuvent être appliqués
 * à d'autres appareils (même type ou même modèle pré-cochés) ; une sélection multiple permet aussi
 * de modifier plusieurs appareils ou de leur ajouter la même intervention en une fois.
 *
 * Hors ligne : la dernière liste reçue est gardée sur l'appareil ; les modifications passent par la
 * file d'attente commune (app.js) et s'affichent tout de suite, marquées « en attente d'envoi ».
 * Backend : Materiel.gs (onglets Materiel et MaterielInterventions).
 */
const Materiel = (() => {
  const CLE_CACHE = 'avismur_materiel';
  const ACTIONS = ['enregistrerMateriel', 'ajouterIntervention', 'supprimerIntervention'];
  const TYPES_DEFAUT = ['Scope', 'PSE', 'Défibrillateur', 'Scope/défibrillateur', 'Respirateur', 'Aspirateur de mucosités', 'Attelle'];
  const STATUTS_DEFAUT = ['En service', 'En maintenance', 'En panne', 'Prêté', 'Réformé'];
  const INTERVENTIONS_DEFAUT = ['Révision', 'Intervention', 'Réparation', 'Panne signalée', 'Contrôle', 'Autre'];
  // Champs communs à plusieurs appareils, que l'on peut répercuter (jamais les numéros propres à chacun).
  const REPERCUTABLES = {
    type: 'Type', modele: 'Modèle', revision: 'Révision prévue', periodicite: 'Périodicité (mois)',
    statut: 'Statut', traceur: 'Traceur GeoTraceSMUR', remarques: 'Remarques',
  };
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
    n.append(...enfants.flat().filter((e) => e !== null && e !== undefined && e !== false));
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
    const autres = fiches().map((f) => f.type).filter((t) => t && !base.includes(t));
    return [...base, ...new Set(autres)];
  };
  const statuts = () => (donnees && donnees.statuts) || STATUTS_DEFAUT;
  const typesIntervention = () => (donnees && donnees.typesIntervention) || INTERVENTIONS_DEFAUT;
  const nomAppareil = (f) => `${f.type || 'Matériel'}${f.numInterne ? ` n° ${f.numInterne}` : ''}`;

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
    let interventions = ((donnees && donnees.interventions) || []).map((i) => ({ ...i }));
    const attente = new Set();
    enAttente().forEach((e) => {
      const d = e.donnees || {};
      if (e.action === 'enregistrerMateriel') {
        (d.fiches || []).forEach((f) => { parId.set(f.id, { ...parId.get(f.id), ...f }); attente.add(f.id); });
      } else if (e.action === 'ajouterIntervention') {
        (d.materiels || []).forEach((id, n) => {
          interventions.push({
            id: `${e.id}-${n}`, materiel: id, date: d.date, type: d.type, description: d.description, intervenant: d.intervenant,
            prochaineRevision: d.prochaineRevision, saisiPar: e.agent || '', attente: true, idFile: e.id,
          });
          if (d.prochaineRevision && parId.has(id)) parId.get(id).revision = d.prochaineRevision;
          attente.add(id);
        });
      } else if (e.action === 'supprimerIntervention') {
        interventions = interventions.filter((i) => i.id !== d.intervention);
      }
    });
    return { fiches: [...parId.values()], interventions, attente };
  }
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
  function etatRevision(f) {
    if (f.statut === 'Réformé' || f.archive) return { classe: 'neutre', texte: f.archive ? 'Archivé' : 'Réformé' };
    if (!f.revision) return { classe: 'neutre', texte: 'Révision non renseignée' };
    const jours = Math.round((new Date(f.revision) - new Date(aujourdhui())) / 86400000);
    if (jours < 0) return { classe: 'retard', texte: `Révision dépassée (${dateFr(f.revision)})`, retard: true };
    if (jours <= ALERTE_JOURS) return { classe: 'bientot', texte: `Révision le ${dateFr(f.revision)} (J-${jours})`, bientot: true };
    return { classe: 'ok', texte: `Révision le ${dateFr(f.revision)}` };
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
        const botte = normaliser([f.type, f.modele, f.numInterne, f.numBiomed, f.numSerie, f.nomTraceur, f.remarques].join(' '));
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
        estAdmin() ? el('button', { type: 'button', classe: 'principal mat-nouveau', texte: '+ Nouveau matériel', surclick: () => ouvrirFiche(null, true) }) : null));

    const compteurs = el('div', { classe: 'mat-compteurs' },
      compteurBouton(actives.length, 'appareils en service', 'total', () => { filtre = { texte: '', type: '', statut: 'actifs', alerte: '' }; rendre(); }, !filtre.alerte && !filtre.type && !filtre.texte),
      compteurBouton(nbRetard, 'révisions dépassées', 'retard', bascule('alerte', 'retard'), filtre.alerte === 'retard'),
      compteurBouton(nbBientot, `révisions sous ${ALERTE_JOURS} j`, 'bientot', bascule('alerte', 'bientot'), filtre.alerte === 'bientot'),
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
      el('dl', { classe: 'mat-infos' },
        ligneInfo('Type', f.type), ligneInfo('Modèle', f.modele), ligneInfo('N° interne SMUR', f.numInterne),
        ligneInfo('N° biomed', f.numBiomed), ligneInfo('N° de série', f.numSerie), ligneInfo('Statut', f.statut),
        ligneInfo('Révision prévue', f.revision ? dateFr(f.revision) : ''), ligneInfo('Périodicité', f.periodicite ? `${f.periodicite} mois` : ''),
        ligneInfo('Traceur GeoTraceSMUR', f.traceur ? `Oui${f.nomTraceur ? ` (${f.nomTraceur})` : ''}` : 'Non'),
        f.remarques ? ligneInfo('Remarques', f.remarques) : null),
      el('p', { classe: `mat-pastille rev-${rev.classe} mat-rev-fiche`, texte: rev.texte }),
      estAdmin() ? el('div', { classe: 'mat-boutons' },
        el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Modifier la fiche', surclick: () => { d.close(); ouvrirEdition(f); } }),
        el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Ajouter une intervention', surclick: () => { d.close(); ouvrirIntervention([f.id]); } }),
        el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Encoder une puce NFC', surclick: () => { d.close(); ouvrirNfc(f); } }),
        el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Dupliquer', title: 'Nouvel appareil du même type et du même modèle', surclick: () => { d.close(); ouvrirEdition(null, f); } })) : null,
      el('h3', { texte: 'Historique des révisions, interventions et réparations' }),
      historique.length ? el('ol', { classe: 'mat-historique' }, historique.map((i) => el('li', { classe: i.attente ? 'attente' : '' },
        el('p', { classe: 'mat-histo-tete' }, el('strong', { texte: i.type }), el('span', { texte: ` · ${dateFr(i.date)}` }),
          i.intervenant ? el('span', { texte: ` · ${i.intervenant}` }) : null, i.attente ? el('span', { classe: 'mat-pastille attente', texte: 'En attente d\'envoi' }) : null),
        i.description ? el('p', { texte: i.description }) : null,
        i.prochaineRevision ? el('p', { classe: 'mat-histo-note', texte: `Prochaine révision fixée au ${dateFr(i.prochaineRevision)}` }) : null,
        el('p', { classe: 'mat-histo-note', texte: i.saisiPar ? `Saisi par ${i.saisiPar}` : '' }),
        estAdmin() ? el('button', {
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
      numInterne: '', numBiomed: '', numSerie: '', revision: (modele && modele.revision) || '', periodicite: (modele && modele.periodicite) || 12,
      statut: 'En service', traceur: false, nomTraceur: '', remarques: '', archive: false,
    };
    const listeModeles = el('datalist', { id: nouvelId() }, [...new Set(fiches().map((x) => x.modele).filter(Boolean))].map((m) => el('option', { value: m })));
    const e = {
      type: champType(base.type),
      modele: el('input', { valeur: base.modele, list: listeModeles.id, placeholder: 'ex. Corpuls3, Hamilton T1, Alaris GH…' }),
      numInterne: el('input', { valeur: base.numInterne, inputmode: 'numeric', placeholder: '1, 2, 3…' }),
      numBiomed: el('input', { valeur: base.numBiomed }),
      numSerie: el('input', { valeur: base.numSerie }),
      revision: el('input', { type: 'date', valeur: base.revision }),
      periodicite: el('input', { type: 'number', min: '1', max: '120', valeur: base.periodicite }),
      statut: selectListe(statuts(), base.statut),
      traceur: el('input', { type: 'checkbox', coche: base.traceur }),
      nomTraceur: el('input', { valeur: base.nomTraceur, placeholder: 'Nom du traceur dans GeoTraceSMUR' }),
      remarques: el('textarea', { rows: '3', valeur: base.remarques }),
    };
    const blocTraceur = champ('Nom du traceur', e.nomTraceur);
    const majTraceur = () => { blocTraceur.hidden = !e.traceur.checked; };
    e.traceur.addEventListener('change', majTraceur);
    majTraceur();
    const message = el('p', { classe: 'message erreur', role: 'alert' });
    let d;

    const lire = () => ({
      ...base,
      type: e.type.valeur(), modele: e.modele.value.trim(), numInterne: e.numInterne.value.trim(), numBiomed: e.numBiomed.value.trim(),
      numSerie: e.numSerie.value.trim(), revision: e.revision.value, periodicite: Number(e.periodicite.value) || '',
      statut: e.statut.value, traceur: e.traceur.checked, nomTraceur: e.traceur.checked ? e.nomTraceur.value.trim() : '', remarques: e.remarques.value.trim(),
    });

    function enregistrer(fiche) {
      const conflit = verifierDoublons([fiche]);
      if (conflit) { message.textContent = conflit; return; }
      if (!fiche.type) { message.textContent = 'Le type est obligatoire.'; return; }
      const changes = f ? Object.keys(REPERCUTABLES).filter((k) => String(f[k] ?? '') !== String(fiche[k] ?? '')) : [];
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
    el('div', { classe: 'mat-grille' },
      champ('Type de matériel', e.type.select),
      e.type.bloc,
      champ('Modèle', e.modele),
      champ('N° interne SMUR', e.numInterne),
      champ('N° biomed', e.numBiomed),
      champ('N° de série', e.numSerie),
      champ('Statut', e.statut),
      champ('Révision prévue', e.revision),
      champ('Périodicité des révisions (mois)', e.periodicite)),
    el('label', { classe: 'mat-case-libelle' }, e.traceur, el('span', { texte: 'Muni d\'un traceur GeoTraceSMUR' })),
    blocTraceur,
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
  }

  /** Même contrôle que le serveur, pour prévenir tout de suite (y compris hors ligne). */
  function verifierDoublons(nouvelles) {
    const final = new Map(fiches().map((x) => [x.id, x]));
    nouvelles.forEach((x) => final.set(x.id, x));
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
    const valeur = (k, x) => (k === 'traceur' ? (x[k] ? 'Oui' : 'Non') : (k === 'revision' ? dateFr(x[k]) : String(x[k] || '—')));
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
              champsCoches.forEach((k) => { copie[k] = fiche[k]; if (k === 'traceur' && !fiche.traceur) copie.nomTraceur = ''; });
              return copie;
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
      type: champType(commun('type')),
      modele: el('input', { valeur: commun('modele') }),
      revision: el('input', { type: 'date', valeur: commun('revision') }),
      periodicite: el('input', { type: 'number', min: '1', max: '120', valeur: commun('periodicite') }),
      statut: selectListe(statuts(), commun('statut') || 'En service'),
      traceur: el('input', { type: 'checkbox', coche: Boolean(commun('traceur')) }),
      remarques: el('textarea', { rows: '2', valeur: commun('remarques') }),
    };
    const actifs = new Set();
    let d;
    const contenu = el('div', { classe: 'mat-groupee' },
      el('p', { texte: `${cibles.length} appareil(s) : ${cibles.sort(tri).map(nomAppareil).join(', ')}.` }),
      el('p', { classe: 'aide-question', texte: 'Cochez les champs à modifier : seuls ceux-là seront appliqués à tous les appareils sélectionnés. Les numéros (interne, biomed, série) restent propres à chaque appareil.' }),
      Object.keys(REPERCUTABLES).map((k) => {
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
                copie[k] = k === 'type' ? ent.valeur() : k === 'traceur' ? ent.checked : (k === 'periodicite' ? (Number(ent.value) || '') : ent.value.trim());
                if (k === 'traceur' && !ent.checked) copie.nomTraceur = '';
              });
              return copie;
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
    };
    const aide = el('p', { classe: 'aide-question' });
    /** Révision : prochaine date proposée = date + périodicité (si tous les appareils ont la même). */
    function proposerProchaine() {
      const choisis = toutes.filter((x) => cibles.has(x.id));
      const perio = choisis.length && choisis.every((x) => x.periodicite && x.periodicite === choisis[0].periodicite) ? choisis[0].periodicite : '';
      if (e.type.value === 'Révision' && perio && e.date.value) {
        e.prochaine.value = ajouterMois(e.date.value, perio);
        aide.textContent = `Proposée d'après la périodicité (${perio} mois). Laissez vide pour ne pas changer la révision prévue.`;
      } else aide.textContent = 'Si renseignée, remplace la « révision prévue » des appareils concernés.';
    }
    e.type.addEventListener('change', proposerProchaine);
    e.date.addEventListener('change', proposerProchaine);
    const message = el('p', { classe: 'message erreur', role: 'alert' });
    const listeCibles = el('div', { classe: 'mat-cibles' });
    function rendreCibles() {
      const choisis = toutes.filter((x) => cibles.has(x.id)).sort(tri);
      listeCibles.replaceChildren(...choisis.map((x) => el('span', { classe: 'mat-puce' }, nomAppareil(x),
        cibles.size > 1 ? el('button', { type: 'button', 'aria-label': `Retirer ${nomAppareil(x)}`, texte: '✕', surclick: () => { cibles.delete(x.id); rendreCibles(); proposerProchaine(); } }) : null)));
    }
    const ajout = el('select', {
      'aria-label': 'Ajouter un appareil',
      surchange: (ev) => {
        const v = ev.target.value;
        ev.target.value = '';
        if (v.startsWith('modele:')) toutes.filter((x) => x.modele === v.slice(7)).forEach((x) => cibles.add(x.id));
        else if (v.startsWith('type:')) toutes.filter((x) => x.type === v.slice(5)).forEach((x) => cibles.add(x.id));
        else if (v) cibles.add(v);
        rendreCibles();
        proposerProchaine();
      },
    },
    el('option', { value: '', texte: '+ Répercuter sur d\'autres appareils…' }),
    el('optgroup', { label: 'Tout un modèle' }, [...new Set(toutes.map((x) => x.modele).filter(Boolean))].map((m) => el('option', { value: `modele:${m}`, texte: `Tous les ${m}` }))),
    el('optgroup', { label: 'Tout un type' }, [...new Set(toutes.map((x) => x.type))].map((t) => el('option', { value: `type:${t}`, texte: `Tous les ${t}` }))),
    el('optgroup', { label: 'Un appareil' }, toutes.slice().sort(tri).map((x) => el('option', { value: x.id, texte: `${nomAppareil(x)}${x.modele ? ` · ${x.modele}` : ''}` }))));
    rendreCibles();
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
          intervenant: e.intervenant.value.trim(), prochaineRevision: e.prochaine.value,
        });
      },
    },
    el('fieldset', { classe: 'mat-cadre' }, el('legend', { texte: 'Appareils concernés' }), listeCibles, ajout),
    el('div', { classe: 'mat-grille' }, champ('Date', e.date), champ('Type', e.type)),
    champ('Description', e.description),
    el('div', { classe: 'mat-grille' }, champ('Intervenant', e.intervenant), champ('Prochaine révision', e.prochaine)),
    aide, message,
    el('div', { classe: 'mat-boutons' }, el('button', { type: 'submit', classe: 'principal', texte: 'Enregistrer l\'intervention' })));
    d = fenetre('Révision, intervention ou réparation', contenu, { large: true });
  }


  // ---------- Puce NFC ----------
  // Champs invariables d'un appareil (jamais la révision, le statut ou les remarques, qui changent).
  const INVARIABLES = { type: 'Type', modele: 'Modèle', numInterne: 'N° interne SMUR', numBiomed: 'N° biomed', numSerie: 'N° de série' };
  /** Lien ouvrant la fiche de l'appareil dans l'appli (même principe que « #inv=… » des inventaires). */
  const adresse = (id) => `${location.origin}${location.pathname.replace(/index\.html$/, '')}#mat=${id}`;
  function texteFiche(f, champs) {
    return ['SMUR Avignon', ...champs.filter((k) => f[k]).map((k) => `${INVARIABLES[k]} : ${f[k]}`)].join('\n');
  }

  /**
   * Écrit sur une puce NFC (Chrome sur Android) :
   *  1. un lien qui ouvre la fiche de l'appareil dans MySMUR ;
   *  2. un texte avec les informations invariables, lisible par n'importe quel téléphone, même sans l'appli.
   * Verrouillage facultatif (définitif) pour que personne ne réécrive la puce.
   */
  function ouvrirNfc(f) {
    const disponible = 'NDEFReader' in window;
    const champs = new Set(Object.keys(INVARIABLES).filter((k) => f[k]));
    let avecLien = true;
    let verrouiller = false;
    const apercu = el('pre', { classe: 'mat-apercu' });
    const majApercu = () => { apercu.textContent = `${avecLien ? `${adresse(f.id)}\n\n` : ''}${texteFiche(f, [...champs])}`; };
    majApercu();
    const sortie = el('p', { classe: 'message', role: 'status' });
    const bouton = el('button', { type: 'button', classe: 'principal', texte: 'Écrire sur la puce', disabled: !disponible });
    bouton.addEventListener('click', async () => {
      if (!champs.size && !avecLien) { sortie.textContent = 'Choisissez au moins une information.'; sortie.className = 'message erreur'; return; }
      if (verrouiller && !window.confirm('Le verrouillage est définitif : la puce ne pourra plus jamais être modifiée. Continuer ?')) return;
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
        await nfc.write({ records }, { signal: delai.signal });
        if (verrouiller && nfc.makeReadOnly) await nfc.makeReadOnly({ signal: delai.signal });
        sortie.textContent = `Puce encodée pour ${nomAppareil(f)}${verrouiller ? ' et verrouillée' : ''}.`;
        sortie.className = 'message succes';
      } catch (e) {
        sortie.textContent = e.name === 'AbortError' ? 'Aucune puce détectée. Réessayez en la gardant contre le téléphone.'
          : (e.name === 'NotAllowedError' ? 'Autorisez le NFC pour cette application et vérifiez qu\'il est activé sur le téléphone.'
            : 'Écriture impossible : puce verrouillée, trop petite ou non compatible (NTAG213 ou plus recommandée).');
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
      el('p', { classe: 'aide-question', texte: 'Aperçu du contenu :' }), apercu,
      el('label', { classe: 'mat-case-libelle' },
        el('input', { type: 'checkbox', surchange: (ev) => { verrouiller = ev.target.checked; } }),
        el('span', { texte: 'Verrouiller la puce après écriture (définitif)' })),
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
          || liste.find((x) => (x.numSerie && tout.includes(`N° de série : ${x.numSerie}`)) || (x.numBiomed && tout.includes(`N° biomed : ${x.numBiomed}`)));
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
