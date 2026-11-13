/**
 * Écran « Gestion des utilisateurs » (administrateurs) : agents de DB_SMUR, état de leur compte, actions.
 * Ajout et modification des agents directement dans DB_SMUR ; la suppression se fait dans le Sheet.
 * Nécessite le réseau (comme la gestion des véhicules) : rien n'est mis en file d'attente.
 */
const Utilisateurs = (() => {
  let zone;
  let appelerServeur;
  let agents = [];
  let fonctions = [];
  let catalogueDroits = []; // droits d'administration : { code, libelle, detail } (Droits.gs)
  let mesDroits = [];
  let moi = ''; // CRI de l'administrateur connecté
  let aDroit = () => false;
  let brouillonDroits = null;
  let ifias = []; // IFIA déjà utilisés (suggestions)
  let stageEdite = null; // { identifiant, ligne (0 : ajout), debut, fin, ifia } // { cri, codes: Set } : droits en cours de modification // fonctions reconnues par le serveur : { code, libelle, onglet }
  let edition = null; // fiche en cours de saisie : { ancienCri, nom, cri, code, telephone } (ancienCri vide : ajout)
  let filtre = '';
  let filtreRole = '';
  let ouvert = ''; // CRI de l'agent dont la fiche est dépliée
  let aConfirmer = ''; // « operation:cri » en attente du second appui
  let messageCourant = { texte: '', classe: '' };

  const ROLES = {
    admin: 'Administrateur', ambulancier: 'Ambulancier', iade: 'IADE', 'etudiant-iade': 'Étudiant IADE', medecin: 'Médecin',
    interne: 'Interne', cadre: 'Cadre', chef: 'Chef d\'unité', '': 'Fonction non gérée',
  };
  const sansAccent = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

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

  function message(texte, classe = '') {
    messageCourant = { texte, classe };
    const p = zone.querySelector('.usr-message');
    if (p) { p.textContent = texte; p.className = `message usr-message ${classe}`.trim(); }
  }

  // ---------- Liste ----------

  function visibles() {
    const f = sansAccent(filtre);
    // Étudiants : par défaut, seulement ceux en stage aujourd'hui. Les autres apparaissent avec les filtres
    // « à venir », « passés », « tous les étudiants », en recherchant leur nom, ou si leur fiche est ouverte.
    const PERIODES_FILTRE = { 'etudiants-a-venir': 'a-venir', 'etudiants-passes': 'terminee' };
    const garder = (a) => {
      if (filtreRole.startsWith('etudiants-')) return a.etudiant && (!PERIODES_FILTRE[filtreRole] || a.periode === PERIODES_FILTRE[filtreRole]);
      if (a.etudiant && a.periode !== 'en-cours' && !f && ouvert !== a.cri) return false;
      if (filtreRole === 'inactif') return !a.compteActif;
      if (filtreRole === 'droits') return a.role === 'admin' || a.droits.length > 0;
      return !filtreRole || a.role === filtreRole;
    };
    return agents.filter((a) => {
      if (!garder(a)) return false;
      return !f || sansAccent(a.nom).includes(f) || a.cri.includes(f) || sansAccent(a.fonction).includes(f);
    });
  }

  function pastille(texte, classe) {
    return el('span', { classe: `usr-pastille ${classe}`, texte });
  }

  const dateFr = (iso) => (iso ? iso.split('-').reverse().join('/') : '?');
  const PERIODES = { 'a-venir': 'Stage à venir', terminee: 'Stage terminé', inconnue: 'Dates manquantes' };

  function etatCompte(a) {
    if (!a.role) return pastille('Non autorisé', 'usr-gris');
    if (a.etudiant && a.periode !== 'en-cours') return pastille(PERIODES[a.periode] || a.periode, a.periode === 'terminee' ? 'usr-gris' : 'usr-orange');
    return a.compteActif ? pastille('Compte actif', 'usr-vert') : pastille('Jamais connecté', 'usr-orange');
  }

  function rendreAgent(a) {
    const deplie = ouvert === a.cri;
    const entete = el('button', {
      type: 'button', classe: 'usr-entete', 'aria-expanded': String(deplie),
      surclick: () => { ouvert = deplie ? '' : a.cri; aConfirmer = ''; edition = null; brouillonDroits = null; stageEdite = null; rendre(); },
    },
    el('span', { classe: 'usr-nom', texte: a.nom }),
    el('span', {
      classe: 'usr-role',
      texte: a.etudiant ? `Étudiant IADE · stage du ${dateFr(a.debut)} au ${dateFr(a.fin)}`
        : (a.role === 'admin' ? `${a.fonction || ROLES[a.role]} · administrateur principal`
          : `${a.fonction || ROLES[a.role]}${a.droits.length ? ` · droits : ${a.droits.length}` : ''}`),
    }),
    etatCompte(a));
    const corps = deplie ? (edition && edition.ancienCri === a.cri ? rendreFormulaire() : rendreFiche(a)) : null;
    return el('li', { classe: `usr-agent${deplie ? ' ouvert' : ''}` }, entete, corps);
  }

  function ligneInfo(libelle, valeur) {
    return el('div', { classe: 'usr-info' }, el('dt', { texte: libelle }), el('dd', { texte: valeur }));
  }

  function rendreFiche(a) {
    const infos = el('dl', { classe: 'usr-infos' },
      a.etudiant ? ligneInfo('Identifiant de connexion', a.identifiant) : ligneInfo('Code CRI', a.cri),

      ligneInfo(a.etudiant ? 'Fonction' : 'Fonction (DB_SMUR)', a.etudiant ? 'Étudiant IADE (DB_EIADE)' : `${a.fonction || '—'} · onglet ${a.onglet}`),
      ligneInfo('Rôle dans l\'appli', ROLES[a.role] || a.role),
      ligneInfo('Mot de passe', a.compteActif ? 'Créé' : 'Pas encore créé'),
      ligneInfo('Téléphone', a.telephone ? a.numero : (a.numero ? `${a.numero} (invalide)` : 'Absent : pas de SMS possible')),
      ligneInfo('Appareils « rester connecté »', String(a.appareils)),
      a.etudiant ? null : ligneInfo('Droits d\'administration', a.role === 'admin' ? 'Tous (administrateur principal)'
        : (a.droits.length ? a.droits.map(libelleDroit).join(', ') : 'Aucun')));

    const gerable = aDroit(a.etudiant ? 'ETUDIANTS' : 'UTILISATEURS');
    const actions = el('div', { classe: 'usr-actions' });
    if (gerable) {
      actions.append(el('button', {
        type: 'button', classe: 'cfg-bouton', texte: 'Modifier la fiche',
        surclick: () => {
          edition = {
            ancienCri: a.cri, nom: a.nom, cri: a.etudiant ? '' : a.cri, code: a.code, telephone: a.numero,
            nomSeul: a.nomSeul || '', prenom: a.prenom || '', identifiant: a.identifiant || '',
          };
          aConfirmer = ''; stageEdite = null; rendre();
        },
      }));
    }
    if (gerable && a.compteActif) {
      actions.append(boutonAction(a, 'reinitialiserMdp', 'Réinitialiser le mot de passe',
        'Appuyez de nouveau : le mot de passe sera effacé et l\'agent déconnecté partout. Il en recréera un via le SMS.'));
    }
    if (gerable && (a.appareils > 0 || a.compteActif)) {
      actions.append(boutonAction(a, 'deconnecterAppareils', 'Déconnecter tous ses appareils',
        'Appuyez de nouveau pour déconnecter cet agent de tous ses appareils.'));
    }
    if (gerable && a.cri !== moi) {
      actions.append(boutonAction(a, 'supprimerAgent', a.etudiant ? 'Supprimer l\'étudiant' : 'Supprimer l\'agent', a.etudiant
        ? 'Appuyez de nouveau : l\'étudiant, tous ses stages (DB_EIADE) et son compte seront supprimés.'
        : 'Appuyez de nouveau : l\'agent sera retiré de DB_SMUR et déconnecté. Son historique est conservé.'));
    }
    // Administrateur principal (propriété ADMINS) : seul un administrateur principal en nomme un autre.
    if (a.role && !a.etudiant && estPrincipal() && a.cri !== moi) {
      actions.append(a.role === 'admin'
        ? boutonAction(a, 'retirerAdmin', 'Retirer « administrateur principal »', 'Appuyez de nouveau : il gardera seulement ses droits délégués.')
        : boutonAction(a, 'nommerAdmin', 'Nommer administrateur principal', 'Appuyez de nouveau : cet agent aura tous les droits, sans restriction.'));
    }

    const notes = [];
    if (!a.role) notes.push('Fonction non reconnue : cet agent ne peut pas se connecter. « Modifier la fiche » pour lui attribuer une fonction.');
    if (a.etudiant && a.periode === 'a-venir') notes.push(`Connexion possible à partir du ${dateFr(a.debut)} : identifiant « ${a.identifiant} », puis « Recevoir un code par SMS ».`);
    if (a.etudiant && a.periode === 'terminee') notes.push('Stage terminé : l\'étudiant ne peut plus se connecter. Pour un nouveau stage ou une prolongation, utilisez les stages ci-dessous.');
    if (!a.telephone) notes.push('Sans numéro de portable valide, l\'agent ne peut ni créer ni réinitialiser son mot de passe.');
    return el('div', { classe: 'usr-fiche' }, infos,
      ...notes.map((t) => el('p', { classe: 'note-parc', texte: t })), a.etudiant ? rendreStages(a, gerable) : null, actions, rendreDroits(a));
  }

  // ---------- Stages des étudiants (DB_EIADE) ----------

  function champIfia(id, objet) {
    const liste = `${id}-liste`;
    return el('div', { classe: 'champ cfg-champ' },
      el('label', { for: id, texte: 'IFIA (institut de formation)' }),
      el('input', { id, list: liste, valeur: objet.ifia || '', autocomplete: 'off', surinput: (ev) => { objet.ifia = ev.target.value; } }),
      el('datalist', { id: liste }, ...ifias.map((v) => el('option', { value: v }))));
  }

  function champsDates(prefixe, objet) {
    const champ = (cle, libelle) => el('div', { classe: 'champ cfg-champ' },
      el('label', { for: `${prefixe}-${cle}`, texte: libelle }),
      el('input', { id: `${prefixe}-${cle}`, type: 'date', valeur: objet[cle] || '', surinput: (ev) => { objet[cle] = ev.target.value; } }));
    return el('div', { classe: 'usr-dates' }, champ('debut', 'Début de stage'), champ('fin', 'Fin de stage'));
  }

  function rendreStages(a, gerable) {
    const j = new Date().toISOString().slice(0, 10);
    const bloc = el('div', { classe: 'usr-stages' }, el('h3', { texte: 'Stages' }));
    const liste = el('ul', { classe: 'usr-liste-stages' });
    a.stages.forEach((st) => {
      if (stageEdite && stageEdite.identifiant === a.cri && stageEdite.ligne === st.ligne) { liste.append(el('li', {}, formulaireStage(a))); return; }
      const etat = st.fin < j ? 'terminé' : (st.debut > j ? 'à venir' : 'en cours');
      const cle = `supprimerStage:${a.cri}:${st.ligne}`;
      liste.append(el('li', { classe: `usr-stage usr-stage-${{ terminé: 'termine', 'à venir': 'a-venir', 'en cours': 'en-cours' }[etat]}` },
        el('span', { texte: `Du ${dateFr(st.debut)} au ${dateFr(st.fin)}${st.ifia ? ` · ${st.ifia}` : ''} · ${etat}` }),
        gerable ? el('span', { classe: 'usr-stage-boutons' },
          el('button', { type: 'button', classe: 'cfg-mini', texte: 'Modifier', surclick: () => { stageEdite = { identifiant: a.cri, ...st }; edition = null; rendre(); } }),
          a.stages.length > 1 ? el('button', {
            type: 'button', classe: `cfg-mini danger${aConfirmer === cle ? ' usr-confirmer' : ''}`, texte: aConfirmer === cle ? 'Confirmer' : 'Supprimer',
            surclick: () => {
              if (aConfirmer !== cle) { aConfirmer = cle; rendre(); message('Appuyez sur « Confirmer » pour supprimer ce stage.', 'erreur'); return; }
              aConfirmer = '';
              envoyerStage(a, { operation: 'supprimer', ligne: st.ligne });
            },
          }) : null) : null));
    });
    bloc.append(liste);
    if (gerable) {
      if (stageEdite && stageEdite.identifiant === a.cri && !stageEdite.ligne) bloc.append(formulaireStage(a));
      else {
        bloc.append(el('button', {
          type: 'button', classe: 'cfg-bouton', texte: '+ Ajouter un stage',
          surclick: () => {
            const dernier = a.stages[a.stages.length - 1];
            stageEdite = { identifiant: a.cri, ligne: 0, debut: '', fin: '', ifia: dernier ? dernier.ifia : '' };
            edition = null; rendre();
          },
        }));
      }
    }
    return bloc;
  }

  function formulaireStage(a) {
    const st = stageEdite;
    return el('form', {
      classe: 'usr-formulaire usr-form-stage', novalidate: true,
      sursubmit: (ev) => {
        ev.preventDefault();
        if (!st.debut || !st.fin) { message('Indiquez les dates de début et de fin.', 'erreur'); return; }
        if (st.fin < st.debut) { message('La fin du stage est avant son début.', 'erreur'); return; }
        if (!String(st.ifia || '').trim()) { message('Indiquez l\'IFIA.', 'erreur'); return; }
        envoyerStage(a, { operation: st.ligne ? 'modifier' : 'ajouter', ligne: st.ligne, debut: st.debut, fin: st.fin, ifia: st.ifia });
      },
    },
    champsDates('usr-s', st), champIfia('usr-s-ifia', st),
    el('div', { classe: 'usr-actions' },
      el('button', { type: 'submit', classe: 'cfg-bouton', texte: st.ligne ? 'Enregistrer le stage' : 'Ajouter le stage' }),
      el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Annuler', surclick: () => { stageEdite = null; message(''); rendre(); } })));
  }

  async function envoyerStage(a, charge) {
    message('Enregistrement dans DB_EIADE…');
    try {
      const rep = await appelerServeur('stageEtudiant', { identifiant: a.cri, ...charge });
      if (!rep.ok) { message(rep.erreur || 'Refusé par le serveur.', 'erreur'); rendre(); return; }
      stageEdite = null;
      await charger(rep.message);
    } catch (err) {
      message('Le serveur ne répond pas : stage non enregistré. Réessayez avec du réseau.', 'erreur');
    }
  }

  // ---------- Droits d'administration (GRANT) ----------

  let estPrincipalApp = () => false;
  const estPrincipal = () => estPrincipalApp();
  const libelleDroit = (code) => (catalogueDroits.find((d) => d.code === code) || { libelle: code }).libelle;

  function rendreDroits(a) {
    if (a.etudiant || !a.role || !aDroit('GRANT')) return null;
    const bloc = el('fieldset', { classe: 'usr-droits' }, el('legend', { texte: 'Droits d\'administration' }));
    if (a.role === 'admin') {
      bloc.append(el('p', { classe: 'aide-question', texte: 'Administrateur principal (propriété ADMINS) : tous les droits, non modifiables ici.' }));
      return bloc;
    }
    if (a.cri === moi) {
      bloc.append(el('p', { classe: 'aide-question', texte: 'Vous ne pouvez pas modifier vos propres droits.' }));
      return bloc;
    }
    if (!brouillonDroits || brouillonDroits.cri !== a.cri) brouillonDroits = { cri: a.cri, codes: new Set(a.droits) };
    const b = brouillonDroits;
    bloc.append(el('p', { classe: 'aide-question', texte: 'Vous ne pouvez attribuer ou retirer que les droits que vous possédez vous-même.' }));
    catalogueDroits.forEach((d) => {
      const possede = mesDroits.includes(d.code);
      const id = `usr-droit-${d.code}`;
      bloc.append(el('label', { classe: `cfg-case usr-droit${possede ? '' : ' usr-indispo'}`, for: id },
        el('input', {
          type: 'checkbox', id, checked: b.codes.has(d.code), disabled: !possede,
          surchange: (e) => { if (e.target.checked) b.codes.add(d.code); else b.codes.delete(d.code); },
        }),
        el('span', {}, el('strong', { texte: d.code === 'GRANT' ? `${d.libelle} (GRANT)` : d.libelle }), el('small', { texte: d.detail }))));
    });
    bloc.append(el('div', { classe: 'usr-actions' },
      el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Enregistrer les droits', surclick: () => enregistrerDroits(a) })));
    return bloc;
  }

  async function enregistrerDroits(a) {
    message('Enregistrement des droits…');
    try {
      const rep = await appelerServeur('enregistrerDroits', { cri: a.cri, droits: [...brouillonDroits.codes] });
      if (!rep.ok) { message(rep.erreur || 'Refusé par le serveur.', 'erreur'); return; }
      brouillonDroits = null;
      await charger(`${rep.message} Il sera reconnecté automatiquement avec ses nouveaux droits.`);
    } catch (err) {
      message('Le serveur ne répond pas : droits non enregistrés. Réessayez avec du réseau.', 'erreur');
    }
  }

  // ---------- Ajout / modification ----------

  /** Aperçu de l'identifiant généré (même nom et prénom = même étudiant). */
  const morceau = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[\s'’.]+/g, '').replace(/[^a-z-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');

  function rendreFormulaire() {
    const e = edition;
    const ajout = !e.ancienCri;
    const etudiant = e.code === 'ETUDIANT IADE';
    const champTexte = (id, libelle, cle, attrs = {}, surSaisie) => el('div', { classe: 'champ cfg-champ' },
      el('label', { for: id, texte: libelle }),
      el('input', { id, valeur: e[cle] || '', surinput: (ev) => { e[cle] = ev.target.value; if (surSaisie) surSaisie(); }, ...attrs }));
    // Un étudiant (sans CRI) et un agent (avec CRI) sont des comptes distincts : pas de passage de l'un à l'autre.
    const autorisee = (f) => aDroit(f.code === 'ETUDIANT IADE' ? 'ETUDIANTS' : 'UTILISATEURS');
    const proposees = (ajout ? fonctions : fonctions.filter((f) => (f.code === 'ETUDIANT IADE') === etudiant)).filter(autorisee);
    const choix = el('select', {
      id: 'usr-f-fonction', disabled: !ajout && etudiant,
      surchange: (ev) => {
        const avant = e.code === 'ETUDIANT IADE';
        e.code = ev.target.value;
        if (avant !== (e.code === 'ETUDIANT IADE')) rendre(); else majAvis();
      },
    },
    el('option', { value: '', texte: 'Choisir…', selected: !e.code }),
    ...proposees.map((f) => el('option', { value: f.code, texte: f.libelle, selected: f.code === e.code })));
    const avis = el('p', { classe: 'note-parc', hidden: true });
    const apercu = el('p', { classe: 'aide-question usr-apercu' });
    const agentActuel = agents.find((a) => a.cri === e.ancienCri);
    function majAvis() {
      const f = fonctions.find((x) => x.code === e.code);
      const texte = [];
      if (f && agentActuel && agentActuel.onglet !== f.onglet) texte.push(`La ligne de l'agent sera déplacée de l'onglet ${agentActuel.onglet} vers ${f.onglet} (les autres colonnes sont reprises si elles existent dans ${f.onglet}).`);
      if (f && ajout) texte.push(`Ajout dans l'onglet ${f.onglet} de DB_SMUR.`);
      avis.textContent = texte.join(' ');
      avis.hidden = !texte.length;
      if (etudiant) {
        apercu.textContent = ajout
          ? (morceau(e.nomSeul) && morceau(e.prenom) ? `Identifiant : ${morceau(e.nomSeul)}-${morceau(e.prenom)}` : 'Identifiant : nom-prenom, généré à l\'enregistrement')
          : `Identifiant : ${morceau(e.nomSeul) && morceau(e.prenom) ? `${morceau(e.nomSeul)}-${morceau(e.prenom)}` : e.identifiant}`;
      }
    }

    const champs = etudiant ? [
      champTexte('usr-f-nomseul', 'Nom', 'nomSeul', { autocomplete: 'off', maxlength: 40 }, majAvis),
      champTexte('usr-f-prenom', 'Prénom', 'prenom', { autocomplete: 'off', maxlength: 40 }, majAvis),
      apercu,
      champTexte('usr-f-tel', 'Téléphone portable (nécessaire pour le code de première connexion par SMS)', 'telephone', { type: 'tel', inputmode: 'tel', autocomplete: 'off', placeholder: '06 12 34 56 78' }),
      ajout ? champsDates('usr-f', e) : null,
      ajout ? champIfia('usr-f-ifia', e) : null,
      el('p', { classe: 'aide-question', texte: ajout
        ? 'Le stage est enregistré dans DB_EIADE. En dehors de ses stages, l\'étudiant ne peut pas se connecter (contrôlé aussi hors ligne). Droits d\'un IADE, sans les stupéfiants.'
        : 'Changer le nom ou le prénom renomme tous ses stages dans DB_EIADE et change son identifiant (il devra se reconnecter).' }),
    ] : [
      champTexte('usr-f-nom', 'Nom et prénom', 'nom', { autocomplete: 'off', placeholder: 'NOM Prénom', maxlength: 80 }),
      champTexte('usr-f-cri', 'Code CRI (6 chiffres)', 'cri', { inputmode: 'numeric', maxlength: 6, autocomplete: 'off' }),
      champTexte('usr-f-tel', 'Téléphone portable (pour le SMS de connexion)', 'telephone', { type: 'tel', inputmode: 'tel', autocomplete: 'off', placeholder: '06 12 34 56 78' }),
      el('p', { classe: 'aide-question', texte: 'Changer le code CRI ou la fonction déconnecte l\'agent de ses sessions en cours.' }),
    ];
    majAvis();
    return el('form', {
      classe: 'usr-fiche usr-formulaire', novalidate: true,
      sursubmit: (ev) => { ev.preventDefault(); enregistrerFiche(); },
    },
    el('h2', { texte: ajout ? 'Nouveau compte' : 'Modifier la fiche' }),
    el('div', { classe: 'champ cfg-champ' }, el('label', { for: 'usr-f-fonction', texte: 'Fonction' }), choix),
    ...champs,
    avis,
    el('div', { classe: 'usr-actions' },
      el('button', { type: 'submit', classe: 'principal usr-enregistrer', texte: ajout ? 'Créer le compte' : 'Enregistrer' }),
      el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Annuler', surclick: () => { edition = null; message(''); rendre(); } })));
  }

  async function enregistrerFiche() {
    const e = edition;
    const etudiant = e.code === 'ETUDIANT IADE';
    const cri = String(e.cri || '').replace(/\s/g, '');
    let charge;
    if (!e.code) { message('Choisissez une fonction.', 'erreur'); return; }
    if (etudiant) {
      if (!morceau(e.nomSeul) || !morceau(e.prenom)) { message('Indiquez le nom et le prénom.', 'erreur'); return; }
      if (!e.ancienCri) {
        if (!e.debut || !e.fin) { message('Indiquez les dates de début et de fin de stage.', 'erreur'); return; }
        if (e.fin < e.debut) { message('La fin du stage est avant son début.', 'erreur'); return; }
        if (!String(e.ifia || '').trim()) { message('Indiquez l\'IFIA.', 'erreur'); return; }
      }
      charge = { ancienCri: e.ancienCri, code: e.code, nomSeul: e.nomSeul, prenom: e.prenom, telephone: e.telephone, debut: e.debut, fin: e.fin, ifia: e.ifia };
    } else {
      if (!String(e.nom || '').trim()) { message('Indiquez le nom et le prénom.', 'erreur'); return; }
      if (!/^\d{6}$/.test(cri)) { message('Le code CRI comporte 6 chiffres.', 'erreur'); return; }
      charge = { ancienCri: e.ancienCri, nom: e.nom, cri, code: e.code, telephone: e.telephone };
    }
    message('Enregistrement dans DB_SMUR…');
    try {
      const rep = await appelerServeur('enregistrerAgent', { agent: charge });
      if (!rep.ok) { message(rep.erreur || 'Refusé par le serveur.', 'erreur'); return; }
      ouvert = etudiant ? (rep.identifiant || e.ancienCri) : cri;
      if (rep.identifiant) filtre = '';
      edition = null;
      await charger(rep.message);
    } catch (err) {
      message('Le serveur ne répond pas : fiche non enregistrée. Réessayez avec du réseau.', 'erreur');
    }
  }

  function boutonAction(a, operation, texte, avertissement) {
    const cle = `${operation}:${a.cri}`;
    const enAttente = aConfirmer === cle;
    const danger = operation !== 'nommerAdmin';
    return el('button', {
      type: 'button', classe: `cfg-bouton${danger ? ' danger' : ''}${enAttente ? ' usr-confirmer' : ''}`,
      texte: enAttente ? `Confirmer : ${texte.toLowerCase()}` : texte,
      surclick: () => {
        if (!enAttente) { aConfirmer = cle; rendre(); message(avertissement, 'erreur'); return; }
        aConfirmer = '';
        executer(a, operation);
      },
    });
  }

  async function executer(a, operation) {
    const charge = { cri: a.cri, operation };
    if (operation === 'nommerAdmin' || operation === 'retirerAdmin') {
      charge.operation = 'definirAdmin';
      charge.admin = operation === 'nommerAdmin';
    }
    message('Envoi…');
    try {
      const rep = await appelerServeur('actionUtilisateur', charge);
      if (!rep.ok) { message(rep.erreur || 'Refusé par le serveur.', 'erreur'); rendre(); return; }
      await charger(rep.message);
    } catch (err) {
      message('Le serveur ne répond pas : action non effectuée. Réessayez avec du réseau.', 'erreur');
      rendre();
    }
  }

  function rendre() {
    const defilement = window.scrollY;
    const liste = visibles();
    const actifs = agents.filter((a) => a.compteActif).length;
    const recherche = el('input', {
      type: 'search', id: 'usr-recherche', valeur: filtre, placeholder: 'Nom, CRI, identifiant ou fonction', autocomplete: 'off',
      surinput: (e) => { filtre = e.target.value; rendreListe(); },
    });
    const choixRole = el('select', { id: 'usr-filtre', surchange: (e) => { filtreRole = e.target.value; rendreListe(); } },
      ...[['', 'Tous'], ['ambulancier', 'Ambulanciers'], ['iade', 'IADE'], ['etudiant-iade', 'Étudiants en stage'], ['etudiants-a-venir', 'Étudiants à venir'], ['etudiants-passes', 'Étudiants passés'], ['etudiants-tous', 'Tous les étudiants'], ['medecin', 'Médecins'], ['interne', 'Internes'], ['cadre', 'Cadres'], ['chef', 'Chefs d\'unité'],
        ['admin', 'Administrateurs principaux'], ['droits', 'Avec des droits d\'administration'], ['inactif', 'Jamais connectés']]
        .map(([v, t]) => el('option', { value: v, texte: t, selected: v === filtreRole })));

    zone.innerHTML = '';
    zone.append(
      el('h1', { texte: 'Gestion des utilisateurs' }),
      el('p', { classe: 'consigne', texte: `${agents.filter((a) => !a.etudiant).length} agents et ${agents.filter((a) => a.etudiant).length} étudiants IADE, ${actifs} avec un mot de passe créé.` }),
      el('p', { classe: 'note-parc', texte: 'Agents : DB_SMUR (onglets PERSONNEL et Encadrement). Étudiants IADE et leurs stages : DB_EIADE. Tout se modifie ici, y compris la suppression.' }),
      el('div', { classe: 'usr-outils' },
        el('div', { classe: 'champ usr-champ' }, el('label', { for: 'usr-recherche', texte: 'Rechercher' }), recherche),
        el('div', { classe: 'champ usr-champ' }, el('label', { for: 'usr-filtre', texte: 'Afficher' }), choixRole),
        el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Actualiser', surclick: () => charger() }),
        el('button', {
          type: 'button', classe: 'cfg-bouton usr-ajouter', texte: '+ Nouveau compte', disabled: !fonctions.length,
          hidden: !aDroit('UTILISATEURS') && !aDroit('ETUDIANTS'),
          surclick: () => {
            edition = { ancienCri: '', nom: '', cri: '', code: '', telephone: '', nomSeul: '', prenom: '', debut: '', fin: '', ifia: '' };
            stageEdite = null;
            ouvert = ''; aConfirmer = ''; message(''); rendre();
          },
        })),
      el('p', { classe: `message usr-message ${messageCourant.classe}`.trim(), role: 'status', texte: messageCourant.texte }),
      edition && !edition.ancienCri ? el('div', { classe: 'usr-agent ouvert' }, rendreFormulaire()) : null,
      el('ul', { classe: 'usr-liste' }, ...liste.map(rendreAgent)),
      liste.length ? null : el('p', { classe: 'consigne usr-vide', texte: agents.length ? 'Aucun agent ne correspond.' : '' }));
    window.scrollTo(0, defilement);
  }

  /** Re-rendu de la liste seule, pour ne pas perdre le focus pendant la saisie de la recherche. */
  function rendreListe() {
    const ul = zone.querySelector('.usr-liste');
    if (!ul) return;
    const liste = visibles();
    ul.replaceChildren(...liste.map(rendreAgent));
    const vide = zone.querySelector('.usr-vide');
    if (vide) vide.remove();
    if (!liste.length) ul.after(el('p', { classe: 'consigne usr-vide', texte: 'Aucun agent ne correspond.' }));
  }

  async function charger(texteSucces) {
    message('Chargement des agents…');
    try {
      const rep = await appelerServeur('lireUtilisateurs');
      if (!rep.ok) { message(rep.erreur || 'Refusé par le serveur.', 'erreur'); rendre(); return; }
      agents = (rep.agents || []).map((a) => ({ ...a, droits: a.droits || [] }));
      fonctions = rep.fonctions || [];
      catalogueDroits = rep.droits || [];
      mesDroits = rep.mesDroits || [];
      moi = rep.moi || '';
      ifias = rep.ifias || [];
      message(texteSucces || '', texteSucces ? 'succes' : '');
    } catch (err) {
      message('Le serveur ne répond pas. La gestion des utilisateurs nécessite le réseau.', 'erreur');
    }
    rendre();
  }

  function ouvrir() {
    zone.hidden = false;
    aConfirmer = '';
    edition = null;
    rendre();
    charger();
  }

  function masquer() {
    zone.hidden = true;
  }

  function initialiser(options) {
    zone = document.getElementById('zone-utilisateurs');
    appelerServeur = options.appeler;
    aDroit = options.aDroit || aDroit;
    estPrincipalApp = options.estPrincipal || (() => false);
  }

  return { initialiser, ouvrir, masquer };
})();
