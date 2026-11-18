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
  // Une ligne par véhicule (indicatif, modèle, ordre) ; le détail se déplie au besoin.
  const vehiculesOuverts = new Set();
  const ACTIONS_VEHICULE = [['sansGarage', 'Garage', 'passage au garage'], ['sansPlein', 'Plein', 'plein de carburant'], ['sansExterieur', 'Extérieur', 'vérification extérieure'], ['sansNettoyage', 'Nettoyage', 'nettoyage']];
  function rendreVehicules() {
    const table = el('div', { classe: 'cfg-vehicules' });
    brouillon.vehicules.forEach((v, i) => {
      const ouvert = vehiculesOuverts.has(v);
      const modele = el('select', { 'aria-label': `Modèle de ${v.id}`, surchange: (e) => { v.modele = e.target.value; rendre(); } },
        ...Object.keys(brouillon.modeles).map((m) => el('option', { value: m, texte: brouillon.modeles[m].titre || m, selected: m === v.modele })));
      const idActif = id();
      const sans = ACTIONS_VEHICULE.filter(([cle]) => v[cle]).map(([, t]) => t);
      const resume = el('div', { classe: 'cfg-veh-resume' },
        el('span', { classe: 'cfg-veh-icone', 'aria-hidden': 'true', texte: v.icone || '🚑' }),
        el('button', { type: 'button', classe: 'cfg-veh-nom', 'aria-expanded': String(ouvert),
          surclick: () => { if (ouvert) vehiculesOuverts.delete(v); else vehiculesOuverts.add(v); rendre(); } },
          el('strong', { texte: v.id || 'Nouveau véhicule' }),
          el('small', { texte: [v.nom, brouillon.modeles[v.modele] ? brouillon.modeles[v.modele].titre || v.modele : v.modele, v.inactif ? 'désactivé' : '', sans.length ? `sans ${sans.join(', ').toLowerCase()}` : ''].filter(Boolean).join(' · ') }),
          el('span', { classe: 'cfg-veh-chevron', 'aria-hidden': 'true', texte: ouvert ? '▴' : '▾' })),
        bouton('↑', () => deplacer(brouillon.vehicules, i, -1), 'cfg-mini'),
        bouton('↓', () => deplacer(brouillon.vehicules, i, 1), 'cfg-mini'));
      const detail = ouvert ? el('div', { classe: 'cfg-veh-detail' },
        el('div', { classe: 'cfg-veh-champs' },
          el('label', {}, el('span', { texte: 'Indicatif' }), el('input', { classe: 'cfg-indicatif', valeur: v.id, placeholder: 'F27',
            surinput: (e) => { v.id = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12); e.target.value = v.id; } })),
          el('label', {}, el('span', { texte: 'Check-list' }), modele),
          el('label', {}, el('span', { texte: 'Nom affiché (facultatif)' }), el('input', { valeur: v.nom || '', placeholder: 'ex. Couveuse',
            surinput: (e) => { if (e.target.value) v.nom = e.target.value; else delete v.nom; } })),
          el('label', {}, el('span', { texte: 'Icône' }), el('input', { classe: 'cfg-icone', valeur: v.icone || '', placeholder: '🚑',
            surinput: (e) => { if (e.target.value) v.icone = e.target.value; else delete v.icone; } }))),
        el('div', { classe: 'cfg-veh-cases' },
          el('label', { classe: 'cfg-actif', for: idActif, title: 'Décocher pour ne plus afficher ce véhicule (sa configuration est gardée)' },
            el('input', { type: 'checkbox', id: idActif, checked: !v.inactif,
              surchange: (e) => { if (e.target.checked) delete v.inactif; else v.inactif = true; rendre(); } }),
            el('span', { texte: 'Actif' })),
          ...ACTIONS_VEHICULE.map(([cle, texte, aide]) => el('label', { classe: 'cfg-actif', title: `Décocher si ce véhicule n'a pas de ${aide} (ex. couveuse)` },
            el('input', { type: 'checkbox', checked: !v[cle], surchange: (e) => { if (e.target.checked) delete v[cle]; else v[cle] = true; rendre(); } }),
            el('span', { texte })))),
        el('div', { classe: 'cfg-zone-danger' }, bouton('Supprimer ce véhicule', () => { brouillon.vehicules.splice(i, 1); rendre(); }, 'cfg-mini danger'))) : null;
      table.append(el('div', { classe: `cfg-veh${v.inactif ? ' cfg-inactif' : ''}${ouvert ? ' ouvert' : ''}` }, resume, detail));
    });
    return el('section', { classe: 'cfg-section' },
      el('p', { classe: 'aide-question', texte: 'L\'ordre est celui des cases dans l\'appli. Touchez un véhicule pour le modifier : indicatif, check-list, nom, icône, actions proposées (garage, plein…). Décoché « Actif », il n\'apparaît plus, sans perdre sa configuration.' }),
      table,
      bouton('+ Ajouter un véhicule', () => {
        const v = { id: '', modele: Object.keys(brouillon.modeles)[0] };
        brouillon.vehicules.push(v);
        vehiculesOuverts.add(v);
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
      : `Check-list « ${m.titre || v.modele} », propre à ce véhicule : modifiable dans l'onglet « Check-lists ».` }));

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
        onglet = 'checklists';
        rendre();
      })));
    }
    return section;
  }

  // ---------- Questions d'un modèle ----------
  // Une ligne par question (numéro, libellé, type) ; ses champs se déplient au toucher.
  const questionsOuvertes = new Set();
  function rendreQuestion(q, i, questions) {
    const ouvert = questionsOuvertes.has(q);
    const carte = el('div', { classe: `cfg-question cfg-question-repliable${ouvert ? ' ouvert' : ''}` });
    const nom = q.type === 'groupe' ? q.titre : q.libelle;
    const restreinte = q.seulementPour || q.exclusPour;
    const entete = el('div', { classe: 'cfg-question-entete' },
      el('button', { type: 'button', classe: 'cfg-question-titre', 'aria-expanded': String(ouvert),
        surclick: () => { if (ouvert) questionsOuvertes.delete(q); else questionsOuvertes.add(q); rendre(); } },
        el('strong', { classe: 'cfg-num', texte: `${i + 1}.` }),
        el('span', { classe: 'cfg-question-nom' }, el('span', { texte: nom || '(sans libellé)' }),
          el('small', { texte: [TYPES[q.type] || 'Question automatique', q.type === 'groupe' ? `${q.items.length} élément${q.items.length > 1 ? 's' : ''}` : '', q.requis ? 'obligatoire' : '', restreinte ? 'certains véhicules' : ''].filter(Boolean).join(' · ') })),
        el('span', { classe: 'cfg-veh-chevron', 'aria-hidden': 'true', texte: ouvert ? '▴' : '▾' })),
      bouton('↑', () => deplacer(questions, i, -1), 'cfg-mini'),
      bouton('↓', () => deplacer(questions, i, 1), 'cfg-mini'));
    carte.append(entete);
    if (!ouvert) return carte;

    if (!TYPES[q.type] || q.basculeF00) {
      carte.append(el('p', { classe: 'aide-question', texte: q.basculeF00
        ? `« ${q.libelle} » : question de l'appli (UMH en DZ), non modifiable ici.`
        : `« ${q.libelle} » : réponse automatique selon le véhicule, non modifiable ici.` }),
      el('div', { classe: 'cfg-zone-danger' }, bouton('Supprimer cette question', () => { questions.splice(i, 1); rendre(); }, 'cfg-mini danger')));
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
    carte.append(details,
      el('div', { classe: 'cfg-zone-danger' }, bouton('Supprimer cette question', () => { questions.splice(i, 1); rendre(); }, 'cfg-mini danger')));
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
      el('p', { classe: 'note-parc', texte: 'Le libellé d\'une question sert aussi de nom de colonne dans l\'ancien Sheet « Check-list journalière ». Le renommer coupe la copie de cette réponse vers l\'onglet du jour.' }),
      el('div', { classe: 'champ' }, el('label', { for: 'cfg-modele', texte: 'Modèle de check-list' }), choix),
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
        const q = t === 'groupe' ? { type: t, titre: 'Nouvelle rubrique', items: [] } : { type: t, libelle: TYPES[t] };
        m.questions.push(q);
        questionsOuvertes.add(q);
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

  // Onglets : Véhicules / Par véhicule / Check-lists. Barre d'enregistrement collée en bas de l'écran.
  const ONGLETS = [['vehicules', 'Véhicules'], ['parvehicule', 'Par véhicule'], ['checklists', 'Check-lists']];
  let onglet = 'vehicules';
  let reference = ''; // configuration en vigueur (JSON), pour savoir s'il y a des modifications
  const modifie = () => Boolean(brouillon) && JSON.stringify(brouillon) !== reference;
  function majBarre() {
    const barre = zone && zone.querySelector('.barre-enregistrer');
    if (!barre) return;
    const m = modifie();
    barre.classList.toggle('modifiee', m);
    barre.querySelector('.barre-enregistrer-etat').textContent = m ? 'Modifications non enregistrées' : 'Aucune modification';
    barre.querySelectorAll('button').forEach((b) => { b.disabled = !m; });
  }

  function rendre() {
    const defilement = window.scrollY;
    zone.innerHTML = '';
    const contenu = onglet === 'parvehicule' ? rendreParVehicule() : (onglet === 'checklists' ? rendreModele() : rendreVehicules());
    zone.append(
      el('h1', { texte: 'Gestion des véhicules' }),
      el('p', { classe: 'consigne', texte: 'Véhicules et questions de la check-list ambulancier. Les modifications s\'appliquent à tous les appareils une fois enregistrées.' }),
      el('div', { classe: 'onglets-page', role: 'tablist', 'aria-label': 'Sections de la configuration' },
        ...ONGLETS.map(([cle, nom]) => el('button', { type: 'button', role: 'tab', classe: 'onglet-page', 'aria-selected': String(onglet === cle), texte: nom,
          surclick: () => { if (onglet !== cle) { onglet = cle; rendre(); window.scrollTo(0, 0); } } }))),
      contenu,
      el('p', { classe: 'message cfg-message', role: 'status' }),
      el('details', { classe: 'cfg-avance' }, el('summary', { texte: 'Avancé' }),
        el('p', { classe: 'aide-question', texte: 'Revenir à la configuration livrée avec l\'appli (checklists.js). La configuration actuelle reste dans l\'historique de l\'onglet Configuration du Sheet.' }),
        bouton('Revenir à la configuration d\'origine', reinitialiser, 'cfg-bouton danger')),
      el('div', { classe: 'barre-enregistrer' },
        el('span', { classe: 'barre-enregistrer-etat', role: 'status' }),
        bouton('Annuler', () => { ouvrir(); message('Modifications annulées.'); }, 'cfg-bouton'),
        bouton('Enregistrer', enregistrer, 'principal')));
    majBarre();
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
      reference = JSON.stringify(brouillon);
      majBarre();
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
    // Éléments de rubrique en objets (comme le fait l'onglet « Par véhicule ») : sinon ce changement
    // de forme passerait pour une modification à enregistrer.
    Object.values(brouillon.modeles).forEach((m) => (m.questions || []).forEach((q) => {
      if (q.type === 'groupe' && Array.isArray(q.items)) q.items = q.items.map((it) => (typeof it === 'string' ? { libelle: it } : it));
    }));
    reference = JSON.stringify(brouillon);
    confirmation = false;
    rendre();
  }

  function initialiser(options) {
    zone = document.getElementById('zone-config');
    // Toute saisie met à jour la barre d'enregistrement (modifications en attente ou non).
    zone.addEventListener('input', () => majBarre());
    zone.addEventListener('change', () => setTimeout(majBarre));
    appelerServeur = options.appeler;
    surEnregistrement = options.surEnregistrement;
  }

  return { initialiser, ouvrir };
})();
