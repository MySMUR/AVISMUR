/**
 * Écran « Gestion des utilisateurs » (administrateurs) : agents de DB_SMUR, état de leur compte, actions.
 * Ajout et modification des agents directement dans DB_SMUR ; la suppression se fait dans le Sheet.
 * Nécessite le réseau (comme la gestion des véhicules) : rien n'est mis en file d'attente.
 */
const Utilisateurs = (() => {
  let zone;
  let appelerServeur;
  let agents = [];
  let fonctions = []; // fonctions reconnues par le serveur : { code, libelle, onglet }
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
    return agents.filter((a) => {
      if (filtreRole === 'inactif' ? a.compteActif : (filtreRole && a.role !== filtreRole)) return false;
      return !f || sansAccent(a.nom).includes(f) || a.cri.includes(f) || sansAccent(a.fonction).includes(f);
    });
  }

  function pastille(texte, classe) {
    return el('span', { classe: `usr-pastille ${classe}`, texte });
  }

  function etatCompte(a) {
    if (!a.role) return pastille('Non autorisé', 'usr-gris');
    return a.compteActif ? pastille('Compte actif', 'usr-vert') : pastille('Jamais connecté', 'usr-orange');
  }

  function rendreAgent(a) {
    const deplie = ouvert === a.cri;
    const entete = el('button', {
      type: 'button', classe: 'usr-entete', 'aria-expanded': String(deplie),
      surclick: () => { ouvert = deplie ? '' : a.cri; aConfirmer = ''; edition = null; rendre(); },
    },
    el('span', { classe: 'usr-nom', texte: a.nom }),
    el('span', { classe: 'usr-role', texte: a.admin ? `${a.fonction || ROLES[a.role]} · admin` : (a.fonction || ROLES[a.role]) }),
    etatCompte(a));
    const corps = deplie ? (edition && edition.ancienCri === a.cri ? rendreFormulaire() : rendreFiche(a)) : null;
    return el('li', { classe: `usr-agent${deplie ? ' ouvert' : ''}` }, entete, corps);
  }

  function ligneInfo(libelle, valeur) {
    return el('div', { classe: 'usr-info' }, el('dt', { texte: libelle }), el('dd', { texte: valeur }));
  }

  function rendreFiche(a) {
    const infos = el('dl', { classe: 'usr-infos' },
      ligneInfo('Code CRI', a.cri),
      ligneInfo('Fonction (DB_SMUR)', `${a.fonction || '—'} · onglet ${a.onglet}`),
      ligneInfo('Rôle dans l\'appli', ROLES[a.role] || a.role),
      ligneInfo('Mot de passe', a.compteActif ? 'Créé' : 'Pas encore créé'),
      ligneInfo('Téléphone', a.telephone ? a.numero : (a.numero ? `${a.numero} (invalide)` : 'Absent : pas de SMS possible')),
      ligneInfo('Appareils « rester connecté »', String(a.appareils)));

    const actions = el('div', { classe: 'usr-actions' },
      el('button', {
        type: 'button', classe: 'cfg-bouton', texte: 'Modifier la fiche',
        surclick: () => { edition = { ancienCri: a.cri, nom: a.nom, cri: a.cri, code: a.code, telephone: a.numero }; aConfirmer = ''; rendre(); },
      }));
    if (a.compteActif) {
      actions.append(boutonAction(a, 'reinitialiserMdp', 'Réinitialiser le mot de passe',
        'Appuyez de nouveau : le mot de passe sera effacé et l\'agent déconnecté partout. Il en recréera un via le SMS.'));
    }
    if (a.appareils > 0 || a.compteActif) {
      actions.append(boutonAction(a, 'deconnecterAppareils', 'Déconnecter tous ses appareils',
        'Appuyez de nouveau pour déconnecter cet agent de tous ses appareils.'));
    }
    if (a.role) {
      actions.append(a.admin
        ? boutonAction(a, 'retirerAdmin', 'Retirer les droits d\'administrateur', 'Appuyez de nouveau pour retirer les droits d\'administrateur.')
        : boutonAction(a, 'nommerAdmin', 'Nommer administrateur', 'Appuyez de nouveau : cet agent aura accès à toute l\'administration.'));
    }

    const notes = [];
    if (!a.role) notes.push('Fonction non reconnue : cet agent ne peut pas se connecter. « Modifier la fiche » pour lui attribuer une fonction.');
    if (!a.telephone) notes.push('Sans numéro de portable valide, l\'agent ne peut ni créer ni réinitialiser son mot de passe.');
    return el('div', { classe: 'usr-fiche' }, infos,
      ...notes.map((t) => el('p', { classe: 'note-parc', texte: t })), actions);
  }

  // ---------- Ajout / modification ----------

  function rendreFormulaire() {
    const e = edition;
    const ajout = !e.ancienCri;
    const champTexte = (id, libelle, cle, attrs = {}) => el('div', { classe: 'champ cfg-champ' },
      el('label', { for: id, texte: libelle }),
      el('input', { id, valeur: e[cle] || '', surinput: (ev) => { e[cle] = ev.target.value; }, ...attrs }));
    const choix = el('select', { id: 'usr-f-fonction', surchange: (ev) => { e.code = ev.target.value; majAvis(); } },
      el('option', { value: '', texte: 'Choisir…', selected: !e.code }),
      ...fonctions.map((f) => el('option', { value: f.code, texte: f.libelle, selected: f.code === e.code })));
    const avis = el('p', { classe: 'note-parc', hidden: true });
    const agentActuel = agents.find((a) => a.cri === e.ancienCri);
    function majAvis() {
      const f = fonctions.find((x) => x.code === e.code);
      const texte = [];
      if (f && agentActuel && agentActuel.onglet !== f.onglet) texte.push(`La ligne de l'agent sera déplacée de l'onglet ${agentActuel.onglet} vers ${f.onglet} (les autres colonnes sont reprises si elles existent dans ${f.onglet}).`);
      if (f && ajout) texte.push(`Ajout dans l'onglet ${f.onglet} de DB_SMUR.`);
      avis.textContent = texte.join(' ');
      avis.hidden = !texte.length;
    }
    majAvis();
    return el('form', {
      classe: 'usr-fiche usr-formulaire', novalidate: true,
      sursubmit: (ev) => { ev.preventDefault(); enregistrerFiche(); },
    },
    el('h2', { texte: ajout ? 'Nouvel agent' : 'Modifier la fiche' }),
    champTexte('usr-f-nom', 'Nom et prénom', 'nom', { autocomplete: 'off', placeholder: 'NOM Prénom', maxlength: 80 }),
    el('div', { classe: 'champ cfg-champ' }, el('label', { for: 'usr-f-fonction', texte: 'Fonction' }), choix),
    champTexte('usr-f-cri', 'Code CRI (6 chiffres)', 'cri', { inputmode: 'numeric', maxlength: 6, autocomplete: 'off' }),
    champTexte('usr-f-tel', 'Téléphone portable (pour le SMS de connexion)', 'telephone', { type: 'tel', inputmode: 'tel', autocomplete: 'off', placeholder: '06 12 34 56 78' }),
    avis,
    el('p', { classe: 'aide-question', texte: 'Changer le code CRI ou la fonction déconnecte l\'agent de ses sessions en cours.' }),
    el('div', { classe: 'usr-actions' },
      el('button', { type: 'submit', classe: 'principal usr-enregistrer', texte: ajout ? 'Ajouter l\'agent' : 'Enregistrer' }),
      el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Annuler', surclick: () => { edition = null; message(''); rendre(); } })));
  }

  async function enregistrerFiche() {
    const e = edition;
    if (!e.nom.trim()) { message('Indiquez le nom et le prénom.', 'erreur'); return; }
    if (!e.code) { message('Choisissez une fonction.', 'erreur'); return; }
    if (!/^\d{6}$/.test(String(e.cri).replace(/\s/g, ''))) { message('Le code CRI comporte 6 chiffres.', 'erreur'); return; }
    message('Enregistrement dans DB_SMUR…');
    try {
      const rep = await appelerServeur('enregistrerAgent', {
        agent: { ancienCri: e.ancienCri, nom: e.nom, cri: String(e.cri).replace(/\s/g, ''), code: e.code, telephone: e.telephone },
      });
      if (!rep.ok) { message(rep.erreur || 'Refusé par le serveur.', 'erreur'); return; }
      ouvert = String(e.cri).replace(/\s/g, '');
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
      type: 'search', id: 'usr-recherche', valeur: filtre, placeholder: 'Nom, CRI ou fonction', autocomplete: 'off',
      surinput: (e) => { filtre = e.target.value; rendreListe(); },
    });
    const choixRole = el('select', { id: 'usr-filtre', surchange: (e) => { filtreRole = e.target.value; rendreListe(); } },
      ...[['', 'Tous'], ['ambulancier', 'Ambulanciers'], ['iade', 'IADE'], ['etudiant-iade', 'Étudiants IADE'], ['medecin', 'Médecins'], ['interne', 'Internes'], ['cadre', 'Cadres'], ['chef', 'Chefs d\'unité'],
        ['admin', 'Administrateurs'], ['inactif', 'Jamais connectés']]
        .map(([v, t]) => el('option', { value: v, texte: t, selected: v === filtreRole })));

    zone.innerHTML = '';
    zone.append(
      el('h1', { texte: 'Gestion des utilisateurs' }),
      el('p', { classe: 'consigne', texte: `${agents.length} agents dans DB_SMUR, dont ${actifs} avec un compte actif.` }),
      el('p', { classe: 'note-parc', texte: 'Les fiches sont enregistrées dans DB_SMUR (onglets PERSONNEL et Encadrement). Pour retirer un agent, supprimez sa ligne dans le Sheet.' }),
      el('div', { classe: 'usr-outils' },
        el('div', { classe: 'champ usr-champ' }, el('label', { for: 'usr-recherche', texte: 'Rechercher' }), recherche),
        el('div', { classe: 'champ usr-champ' }, el('label', { for: 'usr-filtre', texte: 'Afficher' }), choixRole),
        el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Actualiser', surclick: () => charger() }),
        el('button', {
          type: 'button', classe: 'cfg-bouton usr-ajouter', texte: '+ Ajouter un agent', disabled: !fonctions.length,
          surclick: () => { edition = { ancienCri: '', nom: '', cri: '', code: '', telephone: '' }; ouvert = ''; aConfirmer = ''; message(''); rendre(); },
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
      agents = rep.agents || [];
      fonctions = rep.fonctions || [];
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
  }

  return { initialiser, ouvrir, masquer };
})();
