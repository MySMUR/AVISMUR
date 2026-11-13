/*
 * Écran « Gestion des véhicules » (administrateurs) : véhicules et questions de chaque modèle
 * de check-list. On travaille sur un brouillon ; « Enregistrer » l'envoie au serveur,
 * qui le partage avec tous les appareils.
 */
const ConfigAdmin = (() => {
  const TYPES = {
    groupe: 'Liste d\'éléments à cocher',
    niveau: 'Niveau d\'obus / bouteille (0 à 10)',
    carburant: 'Jauge de carburant (0 à 8)',
    kilometrage: 'Kilométrage',
    choix: 'Choix parmi des réponses',
    fait: 'Case « Fait »',
    texte: 'Texte libre (remarques)',
  };

  let brouillon = null;
  let modeleOuvert = null;
  let zone;
  let appelerServeur;
  let surEnregistrement;

  const copie = (o) => JSON.parse(JSON.stringify(o));
  const liste = (texte) => String(texte || '').split(/[,;\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
  const lignes = (texte) => String(texte || '').split('\n').map((x) => x.trim()).filter(Boolean);

  function el(balise, attributs = {}, ...enfants) {
    const n = document.createElement(balise);
    Object.entries(attributs).forEach(([k, v]) => {
      if (v === undefined || v === null || v === false) return;
      if (k === 'texte') n.textContent = v;
      else if (k === 'classe') n.className = v;
      else if (k === 'valeur') n.value = v;
      else if (k.startsWith('sur')) n.addEventListener(k.slice(3), v);
      else n.setAttribute(k, v === true ? '' : v);
    });
    n.append(...enfants.filter((e) => e !== null && e !== undefined));
    return n;
  }

  let compteur = 0;
  const id = () => `cfg${(compteur += 1)}`;

  /** Champ avec étiquette. `surModif` reçoit la nouvelle valeur. */
  function champ(libelle, valeur, surModif, options = {}) {
    const i = id();
    const entree = options.multiligne
      ? el('textarea', { id: i, rows: options.lignes || 4, valeur, surinput: (e) => surModif(e.target.value) })
      : el('input', { id: i, valeur, placeholder: options.exemple, surinput: (e) => surModif(e.target.value) });
    return el('div', { classe: 'champ cfg-champ' }, el('label', { for: i, texte: libelle }),
      options.aide ? el('p', { classe: 'aide-question', texte: options.aide }) : null, entree);
  }

  function bouton(texte, action, classe = 'cfg-bouton') {
    return el('button', { type: 'button', classe, texte, surclick: action });
  }

  function deplacer(tableau, i, sens) {
    const j = i + sens;
    if (j < 0 || j >= tableau.length) return;
    [tableau[i], tableau[j]] = [tableau[j], tableau[i]];
    rendre();
  }

  // ---------- Véhicules ----------
  function rendreVehicules() {
    const table = el('div', { classe: 'cfg-vehicules' });
    brouillon.vehicules.forEach((v, i) => {
      const modele = el('select', { 'aria-label': `Modèle de ${v.id}`, surchange: (e) => { v.modele = e.target.value; } },
        ...Object.keys(brouillon.modeles).map((m) => el('option', { value: m, texte: brouillon.modeles[m].titre || m, selected: m === v.modele })));
      const idActif = id();
      table.append(el('div', { classe: `cfg-ligne${v.inactif ? ' cfg-inactif' : ''}` },
        el('label', { classe: 'cfg-actif', for: idActif, title: 'Décocher pour ne plus afficher ce véhicule' },
          el('input', { type: 'checkbox', id: idActif, checked: !v.inactif,
            surchange: (e) => { if (e.target.checked) delete v.inactif; else v.inactif = true; rendre(); } }),
          el('span', { texte: 'Actif' })),
        ...[['sansGarage', 'Garage', 'passage au garage'], ['sansPlein', 'Plein', 'plein de carburant'], ['sansExterieur', 'Extérieur', 'vérification extérieure'], ['sansNettoyage', 'Nettoyage', 'nettoyage']]
          .map(([cle, texte, aide]) => el('label', { classe: 'cfg-actif', title: `Décocher si ce véhicule n'a pas de ${aide} (ex. couveuse)` },
            el('input', { type: 'checkbox', checked: !v[cle], surchange: (e) => { if (e.target.checked) delete v[cle]; else v[cle] = true; } }),
            el('span', { texte }))),
        el('input', { classe: 'cfg-indicatif', valeur: v.id, 'aria-label': 'Indicatif', placeholder: 'F27',
          surinput: (e) => { v.id = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12); e.target.value = v.id; } }),
        modele,
        el('input', { valeur: v.nom || '', 'aria-label': 'Nom affiché', placeholder: 'Nom affiché (facultatif)',
          surinput: (e) => { if (e.target.value) v.nom = e.target.value; else delete v.nom; } }),
        el('input', { classe: 'cfg-icone', valeur: v.icone || '', 'aria-label': 'Icône', placeholder: '🚑',
          surinput: (e) => { if (e.target.value) v.icone = e.target.value; else delete v.icone; } }),
        bouton('↑', () => deplacer(brouillon.vehicules, i, -1), 'cfg-mini'),
        bouton('↓', () => deplacer(brouillon.vehicules, i, 1), 'cfg-mini'),
        bouton('Supprimer', () => { brouillon.vehicules.splice(i, 1); rendre(); }, 'cfg-mini danger')));
    });
    return el('section', { classe: 'cfg-section' },
      el('h2', { texte: 'Véhicules' }),
      el('p', { classe: 'aide-question', texte: 'Indicatif, modèle de check-list, nom affiché et icône (facultatifs). L\'ordre est celui des cases dans l\'appli. Un véhicule décoché (« Actif ») n\'apparaît plus, sans perdre sa configuration. « Garage », « Plein », « Extérieur » décochés : ces actions ne sont pas proposées pour ce véhicule.' }),
      table,
      bouton('+ Ajouter un véhicule', () => {
        brouillon.vehicules.push({ id: '', modele: Object.keys(brouillon.modeles)[0] });
        rendre();
        const champs = zone.querySelectorAll('.cfg-indicatif');
        champs[champs.length - 1].focus();
      }));
  }

  // ---------- Questions véhicule par véhicule ----------
  let vehiculeOuvert = null;

  /** La question (ou l'élément) est-elle posée pour ce véhicule ? */
  const posee = (q, idV) => (!q.seulementPour || q.seulementPour.includes(idV)) && !(q.exclusPour || []).includes(idV);

  /** Pose ou retire la question (ou l'élément) pour ce véhicule, sans toucher aux autres. */
  function basculer(q, idV, oui) {
    if (oui) {
      if (q.exclusPour) { q.exclusPour = q.exclusPour.filter((x) => x !== idV); if (!q.exclusPour.length) delete q.exclusPour; }
      if (q.seulementPour && !q.seulementPour.includes(idV)) q.seulementPour.push(idV);
    } else if (q.seulementPour) {
      q.seulementPour = q.seulementPour.filter((x) => x !== idV);
      if (!q.seulementPour.length) q.exclusPour = [...new Set([...(q.exclusPour || []), idV])];
      if (!q.seulementPour.length) delete q.seulementPour;
    } else {
      q.exclusPour = [...new Set([...(q.exclusPour || []), idV])];
    }
  }

  function caseQuestion(objet, idV, texte, classe = '') {
    const i = id();
    return el('label', { classe: `cfg-case ${classe}`.trim(), for: i },
      el('input', { type: 'checkbox', id: i, checked: posee(objet, idV), surchange: (e) => basculer(objet, idV, e.target.checked) }),
      el('span', { texte }));
  }

  function rendreParVehicule() {
    const vehicules = brouillon.vehicules.filter((v) => v.id);
    if (!vehicules.some((v) => v.id === vehiculeOuvert)) vehiculeOuvert = vehicules.length ? vehicules[0].id : null;
    const section = el('section', { classe: 'cfg-section' },
      el('h2', { texte: 'Par véhicule' }),
      el('p', { classe: 'aide-question', texte: 'Cochez les questions et les éléments vérifiés sur ce véhicule. Décocher ne change rien pour les autres véhicules du même modèle.' }));
    if (!vehiculeOuvert) return section;
    const v = brouillon.vehicules.find((x) => x.id === vehiculeOuvert);
    const m = brouillon.modeles[v.modele];
    section.append(el('div', { classe: 'champ' },
      el('label', { for: 'cfg-vehicule', texte: 'Véhicule' }),
      el('select', { id: 'cfg-vehicule', surchange: (e) => { vehiculeOuvert = e.target.value; rendre(); } },
        ...vehicules.map((x) => el('option', { value: x.id, texte: `${x.nom || x.id} — ${brouillon.modeles[x.modele] ? brouillon.modeles[x.modele].titre || x.modele : x.modele}${x.inactif ? ' (désactivé)' : ''}`, selected: x.id === vehiculeOuvert })))));
    if (!m) return section;

    const partages = brouillon.vehicules.filter((x) => x.modele === v.modele).map((x) => x.id);
    section.append(el('p', { classe: 'aide-question', texte: partages.length > 1
      ? `Check-list « ${m.titre || v.modele} », partagée avec ${partages.filter((x) => x !== v.id).join(', ')}. Pour modifier les libellés ou ajouter des questions à ce seul véhicule, créez-lui sa propre check-list.`
      : `Check-list « ${m.titre || v.modele} », propre à ce véhicule : modifiable dans « Check-lists » ci-dessous.` }));

    m.questions.forEach((q) => {
      if (!TYPES[q.type] || q.basculeF00) return;
      const bloc = el('div', { classe: 'cfg-question' }, caseQuestion(q, v.id, q.type === 'groupe' ? q.titre : q.libelle, 'cfg-titre-case'));
      if (q.type === 'groupe') {
        const sous = el('div', { classe: 'cfg-elements' });
        q.items.forEach((it, k) => {
          if (typeof it === 'string') q.items[k] = { libelle: it }; // objet pour pouvoir le restreindre
          sous.append(caseQuestion(q.items[k], v.id, q.items[k].libelle));
        });
        bloc.append(sous);
      }
      section.append(bloc);
    });

    if (partages.length > 1) {
      section.append(el('div', { classe: 'cfg-ligne' }, bouton(`Créer une check-list propre à ${v.id}`, () => {
        let nom = `${v.id}`.replace(/[^A-Z0-9_]/g, '');
        while (brouillon.modeles[nom]) nom += '_';
        const copieModele = copie(m);
        copieModele.titre = m.titre || v.modele;
        // Modèle d'origine : la copie vers l'ancien Sheet continue dans le bon onglet (VML, UMH…).
        copieModele.base = m.base || v.modele;
        // La copie ne garde que ce qui concerne ce véhicule.
        copieModele.questions = copieModele.questions.filter((q) => posee(q, v.id) || q.sinon !== undefined || q.type === 'cache');
        brouillon.modeles[nom] = copieModele;
        v.modele = nom;
        modeleOuvert = nom;
        rendre();
      })));
    }
    return section;
  }

  // ---------- Questions d'un modèle ----------
  function rendreQuestion(q, i, questions) {
    const carte = el('div', { classe: 'cfg-question' });
    const entete = el('div', { classe: 'cfg-ligne' },
      el('strong', { classe: 'cfg-num', texte: `${i + 1}.` }),
      el('span', { classe: 'cfg-type', texte: TYPES[q.type] || 'Question automatique' }),
      bouton('↑', () => deplacer(questions, i, -1), 'cfg-mini'),
      bouton('↓', () => deplacer(questions, i, 1), 'cfg-mini'),
      bouton('Supprimer', () => { questions.splice(i, 1); rendre(); }, 'cfg-mini danger'));
    carte.append(entete);

    if (!TYPES[q.type] || q.basculeF00) {
      carte.append(el('p', { classe: 'aide-question', texte: q.basculeF00
        ? `« ${q.libelle} » : question de l'appli (UMH en DZ), non modifiable ici.`
        : `« ${q.libelle} » : réponse automatique selon le véhicule, non modifiable ici.` }));
      return carte;
    }

    if (q.type === 'groupe') {
      carte.append(champ('Titre de la rubrique', q.titre, (v) => { q.titre = v; }));
      const texte = q.items.map((it) => (typeof it === 'string' ? it : it.libelle)).join('\n');
      carte.append(champ('Éléments à cocher (un par ligne)', texte, (v) => {
        const anciens = {};
        q.items.forEach((it) => { if (typeof it !== 'string') anciens[it.libelle] = it; });
        q.items = lignes(v).map((l) => anciens[l] || l); // garde la colonne d'origine des éléments inchangés
      }, { multiligne: true, lignes: Math.max(4, q.items.length + 1) }));
    } else {
      carte.append(champ('Libellé', q.libelle, (v) => { q.libelle = v; }));
    }
    if (q.type === 'choix') {
      carte.append(champ('Réponses possibles (une par ligne)', (q.options || []).join('\n'), (v) => { q.options = lignes(v); },
        { multiligne: true, lignes: 3 }));
    }
    if (['choix', 'kilometrage', 'carburant', 'texte'].includes(q.type)) {
      const i2 = id();
      carte.append(el('label', { classe: 'cfg-case', for: i2 },
        el('input', { type: 'checkbox', id: i2, checked: Boolean(q.requis), surchange: (e) => { if (e.target.checked) q.requis = true; else delete q.requis; } }),
        el('span', { texte: 'Réponse obligatoire' })));
    }
    // Restrictions par véhicule
    const details = el('details', { classe: 'cfg-details', open: Boolean(q.seulementPour || q.exclusPour) },
      el('summary', { texte: 'Véhicules concernés' }),
      champ('Seulement pour (indicatifs)', (q.seulementPour || []).join(', '), (v) => {
        const l = liste(v); if (l.length) q.seulementPour = l; else delete q.seulementPour;
      }, { exemple: 'F26', aide: 'Vide : tous les véhicules du modèle.' }),
      champ('Sauf pour (indicatifs)', (q.exclusPour || []).join(', '), (v) => {
        const l = liste(v); if (l.length) q.exclusPour = l; else delete q.exclusPour;
      }, { exemple: 'F28, F23' }),
      champ('Réponse enregistrée pour les véhicules exclus', q.sinon || '', (v) => {
        if (v) q.sinon = v; else delete q.sinon;
      }, { exemple: 'Véhicule non concerné' }));
    carte.append(details);
    return carte;
  }

  function rendreModele() {
    const noms = Object.keys(brouillon.modeles);
    if (!brouillon.modeles[modeleOuvert]) modeleOuvert = noms[0];
    const m = brouillon.modeles[modeleOuvert];
    const choix = el('select', { id: 'cfg-modele', surchange: (e) => { modeleOuvert = e.target.value; rendre(); } },
      ...noms.map((n) => el('option', { value: n, texte: `${brouillon.modeles[n].titre || n} (${n})`, selected: n === modeleOuvert })));

    const nouveau = el('div', { classe: 'cfg-ligne cfg-nouveau', hidden: true });
    const nomNouveau = el('input', { placeholder: 'Nom du modèle (ex. VSAV)', 'aria-label': 'Nom du nouveau modèle' });
    nouveau.append(nomNouveau, bouton('Créer', () => {
      const nom = nomNouveau.value.toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 20);
      if (!nom || brouillon.modeles[nom]) { nomNouveau.focus(); return; }
      brouillon.modeles[nom] = { titre: nom, questions: [{ type: 'kilometrage', libelle: 'Kilométrage', requis: true }, { type: 'texte', libelle: 'Remarques' }] };
      modeleOuvert = nom;
      rendre();
    }));

    const utilise = brouillon.vehicules.some((v) => v.modele === modeleOuvert);
    const section = el('section', { classe: 'cfg-section' },
      el('h2', { texte: 'Check-lists' }),
      el('div', { classe: 'champ' }, el('label', { for: 'cfg-modele', texte: 'Modèle' }), choix),
      el('div', { classe: 'cfg-ligne' },
        bouton('+ Nouveau modèle', () => { nouveau.hidden = false; nomNouveau.focus(); }),
        utilise ? null : bouton('Supprimer ce modèle', () => { delete brouillon.modeles[modeleOuvert]; modeleOuvert = null; rendre(); }, 'cfg-bouton danger')),
      nouveau,
      champ('Titre affiché', m.titre || '', (v) => { m.titre = v; }));

    const typeAjout = el('select', { 'aria-label': 'Type de la nouvelle question' },
      ...Object.entries(TYPES).map(([t, l]) => el('option', { value: t, texte: l })));
    section.append(...m.questions.map((q, i) => rendreQuestion(q, i, m.questions)),
      el('div', { classe: 'cfg-ligne cfg-ajout' }, typeAjout, bouton('+ Ajouter la question', () => {
        const t = typeAjout.value;
        m.questions.push(t === 'groupe' ? { type: t, titre: 'Nouvelle rubrique', items: [] } : { type: t, libelle: TYPES[t] });
        rendre();
      })));
    return section;
  }

  // ---------- Écran ----------
  const message = (texte, classe = '') => {
    const p = zone.querySelector('.cfg-message');
    p.textContent = texte;
    p.className = `message cfg-message ${classe}`.trim();
  };

  function rendre() {
    const defilement = window.scrollY;
    zone.innerHTML = '';
    zone.append(
      el('h1', { texte: 'Gestion des véhicules' }),
      el('p', { classe: 'consigne', texte: 'Véhicules et questions de la check-list ambulancier. Les modifications s\'appliquent à tous les appareils après « Enregistrer ».' }),
      el('p', { classe: 'note-parc', texte: 'Le libellé d\'une question sert aussi de nom de colonne dans l\'ancien Sheet « Check-list journalière ». Le renommer coupe la copie de cette réponse vers l\'onglet du jour.' }),
      rendreVehicules(),
      rendreParVehicule(),
      rendreModele(),
      el('div', { classe: 'cfg-actions' },
        bouton('Enregistrer la configuration', enregistrer, 'principal'),
        bouton('Annuler les modifications', () => { ouvrir(); message('Modifications annulées.'); }),
        bouton('Revenir à la configuration d\'origine', reinitialiser, 'cfg-bouton danger')),
      el('p', { classe: 'message cfg-message', role: 'status' }));
    window.scrollTo(0, defilement);
  }

  /** Contrôle rapide avant l'envoi (le serveur vérifie aussi). */
  function verifier() {
    const vus = new Set();
    for (const v of brouillon.vehicules) {
      if (!v.id) return 'Un véhicule n\'a pas d\'indicatif.';
      if (vus.has(v.id)) return `Le véhicule ${v.id} apparaît deux fois.`;
      vus.add(v.id);
    }
    for (const [nom, m] of Object.entries(brouillon.modeles)) {
      for (const q of m.questions) {
        if (q.type === 'groupe' ? !q.titre : !q.libelle) return `Modèle ${nom} : une question n'a pas de libellé.`;
        if (q.type === 'choix' && !(q.options || []).length) return `Modèle ${nom} : « ${q.libelle} » n'a pas de réponses possibles.`;
      }
    }
    return null;
  }

  async function enregistrer() {
    const erreur = verifier();
    if (erreur) { message(erreur, 'erreur'); return; }
    message('Enregistrement…');
    try {
      const rep = await appelerServeur('enregistrerConfig', { configuration: brouillon });
      if (!rep.ok) { message(rep.erreur || 'Refusé par le serveur.', 'erreur'); return; }
      surEnregistrement(copie(brouillon));
      message('Configuration enregistrée. Elle s\'applique à tous les appareils.', 'succes');
    } catch (err) {
      message('Le serveur ne répond pas : configuration non enregistrée. Réessayez avec du réseau.', 'erreur');
    }
  }

  let confirmation = false;
  async function reinitialiser() {
    if (!confirmation) {
      confirmation = true;
      message('Appuyez de nouveau pour revenir à la configuration d\'origine (checklists.js). La configuration actuelle reste dans l\'historique de l\'onglet Configuration.', 'erreur');
      return;
    }
    confirmation = false;
    try {
      const rep = await appelerServeur('reinitialiserConfig');
      if (!rep.ok) { message(rep.erreur || 'Refusé par le serveur.', 'erreur'); return; }
      surEnregistrement(null);
      ouvrir();
      message('Configuration d\'origine rétablie.', 'succes');
    } catch (err) {
      message('Le serveur ne répond pas.', 'erreur');
    }
  }

  /** Ouvre l'éditeur sur la configuration en vigueur. */
  function ouvrir() {
    brouillon = copie({ vehicules: VEHICULES, modeles: MODELES });
    confirmation = false;
    rendre();
  }

  function initialiser(options) {
    zone = document.getElementById('zone-config');
    appelerServeur = options.appeler;
    surEnregistrement = options.surEnregistrement;
  }

  return { initialiser, ouvrir };
})();
