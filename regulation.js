/**
 * Fiche régulation (menu > Véhicules > Fiche régulation ; backend : FicheRegulation.gs).
 * Le matin, l'ambulancier de 6 h signale à la régulation l'état du parc et les personnels présents
 * sur 24 h (bips). La fiche reste le Sheet « Etat du parc automobile ET affectation des bips » :
 * l'appli le remplit puis l'envoie en PDF par mail, comme la case « Cochez la case pour envoyer ».
 *
 * Pré-remplie avec la dernière fiche envoyée. Hors ligne : dernière fiche reçue gardée sur l'appareil
 * (téléchargée à l'avance dès que l'appli est ouverte avec du réseau, voir precharger), et l'envoi part
 * dans la file d'attente (une fiche arrivée un autre jour n'est pas envoyée).
 * Copie datant d'un jour précédent : le personnel est remis à zéro localement, comme le fait le serveur
 * chaque nuit (reinitialiserPersonnelFiche), pour ne jamais proposer les bips de la veille.
 */
const Regulation = (() => {
  let zone;
  let App = {};
  let donnees = null; // réponse de lireFicheRegulation
  let saisie = null; // { vehicules: {id: {disponible, position, commentaire}}, bips: {id: {nom, horaires}} }
  let erreur = '';
  let exigee = false; // ouverte à la place de la check-list, pas encore faite
  const faite = () => lireStockage(CLE_FAITE) === aujourdhui();
  let message = { texte: '', classe: '' };
  let envoiSuivi = false; // une fiche de cette session attend (ou vient de partir) : on suit son sort pour le message
  const CLE = 'avismur_fiche_regulation';
  const CLE_FAITE = 'avismur_fiche_regulation_faite'; // jour (jj/mm/aaaa) de la dernière fiche envoyée ou mise en file
  const CLE_BROUILLON = 'avismur_fiche_regulation_brouillon';

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
    n.append(...enfants.flat().filter((e) => e !== null && e !== undefined && e !== false));
    return n;
  }
  const aujourdhui = () => new Date().toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' });

  function lireStockage(cle) {
    try { return JSON.parse(localStorage.getItem(cle)); } catch (e) { return null; }
  }
  function ecrireStockage(cle, valeur) {
    try { localStorage.setItem(cle, JSON.stringify(valeur)); } catch (e) { /* stockage plein */ }
  }

  /**
   * Copie gardée sur l'appareil, ramenée à « ce matin » si elle date d'un jour précédent : noms des bips effacés
   * et horaires des étudiants vidés, comme la remise à zéro de 4 h côté serveur. Les véhicules ne changent pas.
   * `copieDu` garde la date de la copie d'origine, pour prévenir l'agent.
   */
  function copieDuJour(d) {
    if (!d || !Array.isArray(d.bips) || !Array.isArray(d.vehicules)) return null;
    const jour = String(d.date || '').trim();
    if (!jour || jour === aujourdhui() || d.copieDu) return d;
    d.copieDu = jour;
    d.bips.forEach((b) => {
      b.nom = '';
      if (b.categorie === 'eiade' || b.categorie === 'eade') b.horaires = '';
    });
    return d;
  }
  const copieAncienne = () => !!(donnees && donnees.copieDu && donnees.copieDu !== aujourdhui());

  /** Saisie de départ : brouillon du jour s'il existe, sinon la dernière fiche envoyée. */
  function initialiserSaisie() {
    const brouillon = lireStockage(CLE_BROUILLON);
    if (brouillon && brouillon.jour === aujourdhui()) { saisie = brouillon.saisie; return; }
    saisie = { vehicules: {}, bips: {} };
    donnees.vehicules.forEach((v) => {
      saisie.vehicules[v.id] = { disponible: v.disponible === 'NON' ? 'NON' : 'OUI', position: v.position, armement: v.armement || '', commentaire: v.commentaire };
    });
    donnees.bips.forEach((b) => { saisie.bips[b.id] = { nom: b.nom, horaires: b.horaires }; });
  }
  const garderBrouillon = () => ecrireStockage(CLE_BROUILLON, { jour: aujourdhui(), saisie });

  async function charger() {
    erreur = '';
    try {
      const rep = await App.appeler('lireFicheRegulation');
      if (!rep.ok) { erreur = rep.erreur || 'Lecture impossible'; rendre(); return; }
      const premiere = !donnees;
      donnees = rep;
      ecrireStockage(CLE, rep);
      // L'armement des véhicules se conserve d'un jour à l'autre sur le serveur : l'appareil s'y aligne
      // (un changement pas encore envoyé reste tel quel, voir Desarmement.majServeur).
      if (typeof Desarmement !== 'undefined') Desarmement.majServeur(rep.armement, rep.desarmements);
      if (rep.dernierEnvoi && rep.dernierEnvoi.date === aujourdhui()) ecrireStockage(CLE_FAITE, aujourdhui());
      // Sans brouillon du jour, on repart toujours de la fiche fraîchement lue (commentaires compris) :
      // la copie gardée sur l'appareil peut dater d'avant le dernier envoi.
      const brouillon = lireStockage(CLE_BROUILLON);
      if (premiere || !saisie || !(brouillon && brouillon.jour === aujourdhui())) initialiserSaisie();
      // Fiche du jour déjà envoyée (par un collègue, depuis un autre appareil) : on passe directement à la check-list.
      if (exigee && faite() && zone && !zone.hidden && App.ouvrirVue) { exigee = false; App.ouvrirVue('checklist-ambulancier'); return; }
    } catch (e) {
      erreur = donnees ? 'Hors ligne : dernière fiche connue.' : 'Hors ligne et aucune fiche gardée sur cet appareil : ouvrez l\'appli une fois avec du réseau (Wi-Fi ou 4G) pour la télécharger.';
    }
    rendre();
  }

  function positionsPour(v) {
    const l = donnees.listes || {};
    if (v.type === 'VML') return l.positionsVML || [];
    if (v.type === 'UMH') return l.positionsUMH || [];
    return [];
  }

  /** Interrupteur (case à cocher en rôle « switch ») : libellé, état, action au changement. */
  function interrupteur(libelle, actif, surChange, classe) {
    return el('label', { classe: `reg-inter reg-inter-${classe}` },
      el('input', { type: 'checkbox', role: 'switch', checked: actif, surchange: (e) => surChange(e.target.checked) }),
      el('span', { classe: 'reg-inter-piste', 'aria-hidden': 'true' }),
      el('span', { texte: libelle }));
  }

  /** Change la disponibilité dans la fiche du jour (brouillon), sur l'appareil, puis demande la raison si indisponible. */
  /** Envoi immédiat au Sheet (file d'attente hors ligne) et affichage tout de suite sur l'appareil. */
  function enregistrerDisponibilite(id, valeur) {
    if (!App.mettreEnFile || !App.mettreEnFile({ action: 'changerDisponibilite', donnees: { vehicule: id, disponible: valeur } })) return false;
    if (typeof Ambulancier !== 'undefined' && Ambulancier.noterDisponibilite) Ambulancier.noterDisponibilite(id, valeur);
    return true;
  }
  function appliquerDisponibilite(v, s, valeur) {
    const positions = positionsPour(v);
    s.disponible = valeur;
    if (valeur === 'NON' && positions.includes('HS')) s.position = 'HS';
    if (valeur === 'OUI' && s.position === 'HS') s.position = '';
    if (valeur === 'OUI') delete s.raison;
    garderBrouillon();
    enregistrerDisponibilite(v.id, valeur);
    rendre();
    if (valeur === 'NON') demanderRaison(v, s);
  }

  function ligneVehicule(v) {
    const s = saisie.vehicules[v.id] || (saisie.vehicules[v.id] = { disponible: 'OUI', position: '', commentaire: '' });
    const positions = positionsPour(v);
    const bascule = (valeur) => appliquerDisponibilite(v, s, valeur);
    // Armé : tout le matériel de prise en charge médicale à bord ; désarmé : véhicule vidé.
    // Indépendant de la disponibilité (armé et indisponible : contrôle au garage ; disponible et désarmé : VL en DSM).
    // Armement : état global (desarmement.js), le même partout ; la fiche l'affiche et l'envoie tel quel.
    if (v.type !== 'AUTRE') s.armement = armementActuel(v.id);
    const choixPosition = positions.length ? el('select', {
      classe: 'reg-position', 'aria-label': `Position de ${v.id}`,
      surchange: (e) => { s.position = e.target.value; garderBrouillon(); rendre(); },
    }, el('option', { valeur: '', texte: '— position —' }),
    [...new Set([...positions, s.position].filter(Boolean))].map((p) => el('option', { valeur: p, texte: p, selected: p === s.position }))) : null;
    return el('div', { classe: `reg-vehicule ${s.disponible === 'NON' ? 'indispo' : ''}` },
      App.vignette ? App.vignette(v.id, 'reg-vignette') : null,
      el('div', { classe: 'reg-vehicule-nom' }, el('strong', { classe: 'reg-vehicule-id' }, v.id.length <= 4 ? v.id : v.libelle,
        /^dz$/i.test(String(s.position || '').trim()) && typeof Ambulancier !== 'undefined' && Ambulancier.helico ? Ambulancier.helico() : null),
        v.id.length <= 4 ? el('small', { texte: v.libelle.replace(/^(VML|UMH)\s*F\s*\d+\s*/i, '') }) : null),
      el('div', { classe: 'reg-dispos' },
        interrupteur('Disponible', s.disponible !== 'NON', (on) => bascule(on ? 'OUI' : 'NON'), 'dispo'),
        v.type === 'AUTRE' ? null : interrupteur('Armé', s.armement !== 'DÉSARMÉ', (on) => basculerArmement(v, s, on), 'arme')),
      choixPosition,
      resumeContenu(v, s),
      el('input', {
        type: 'text', classe: 'reg-commentaire', placeholder: 'Commentaire', valeur: s.commentaire || '', maxlength: '200',
        'aria-label': `Commentaire ${v.id}`, surinput: (e) => { s.commentaire = e.target.value; garderBrouillon(); },
      }));
  }

  // ---------- Raison de l'indisponibilité ----------
  // Raisons qui relèvent du suivi mécanique (et motif du passage au garage correspondant).
  const RAISONS_GARAGE = { 'Réparation': 'Réparation', 'Entretien': 'Entretien', 'Contrôle technique': 'Contrôle technique', 'Pneus': 'Pneus', 'Carrosserie': 'Carrosserie' };
  const RAISONS = [...Object.keys(RAISONS_GARAGE), 'Panne (en attente de prise en charge)', 'Désinfection / nettoyage', 'Autre'];

  /**
   * Véhicule passé indisponible : on demande pourquoi. Réparation ou entretien → suivi mécanique
   * (passage au garage pré-rempli). À l'issue, proposition de publier l'information sur le mur.
   */
  function demanderRaison(v, s) {
    if (typeof Actions === 'undefined' || !Actions.dialogue) return;
    const nom = v.id.length <= 4 ? v.id : v.libelle;
    let raison = '';
    let detail = '';
    const msg = el('p', { classe: 'message', role: 'status' });
    const puces = RAISONS.map((r, i) => {
      const idR = `reg-raison-${i}`;
      return [el('input', { type: 'radio', name: 'reg-raison', id: idR, value: r, surchange: () => { raison = r; } }), el('label', { for: idR, texte: r })];
    }).flat();
    const zoneDetail = el('textarea', { rows: '2', maxlength: '200', 'aria-label': 'Précisions', placeholder: 'Précisions (facultatif) : panne constatée, garage, retour prévu…', surinput: (e) => { detail = e.target.value.trim(); } });
    Actions.dialogue(`${nom} indisponible`, [
      el('fieldset', { classe: 'question' }, el('legend', { texte: 'Pour quelle raison ?' }), el('div', { classe: 'puces motifs' }, puces)),
      el('div', { classe: 'champ' }, zoneDetail),
      el('button', {
        type: 'button', classe: 'principal', texte: 'Valider',
        surclick: () => {
          if (!raison) { msg.textContent = 'Choisissez une raison.'; msg.className = 'message erreur'; return; }
          s.raison = raison;
          // La raison part aussi dans le commentaire de la fiche (utile à la régulation), sans écraser un commentaire existant.
          if (!String(s.commentaire || '').trim()) s.commentaire = [raison, detail].filter(Boolean).join(' : ').slice(0, 200);
          garderBrouillon();
          rendre();
          suite(v, nom, raison, detail);
        },
      }),
      el('button', { type: 'button', classe: 'lien', texte: 'Passer', surclick: () => Actions.fermer() }),
      msg,
    ]);
  }

  function suite(v, nom, raison, detail) {
    const vehicule = (typeof VEHICULES !== 'undefined' && VEHICULES.find((x) => x.id === v.id)) || { id: v.id, nom };
    const publier = () => proposerPublication(nom, raison, detail);
    if (RAISONS_GARAGE[raison] && !vehicule.sansGarage && typeof Ambulancier !== 'undefined') {
      // Suivi mécanique : la fenêtre du passage au garage remplace celle-ci ; la publication est proposée à sa fermeture.
      Actions.ouvrirAction('garage', vehicule, Ambulancier.infosVehicule(v.id), Ambulancier.etatVehicule(vehicule),
        { motifs: [RAISONS_GARAGE[raison]], commentaire: detail, apres: publier });
      return;
    }
    Actions.fermer();
    publier();
  }

  function proposerPublication(nom, raison, detail) {
    if (typeof Infos === 'undefined' || !Infos.publier) return;
    const titre = `${nom} indisponible : ${raison.toLowerCase()}`;
    Actions.dialogue('Publier sur le mur ?', [
      el('p', { texte: `Informer l'équipe : « ${titre} » ?` }),
      el('button', {
        type: 'button', classe: 'principal', texte: 'Publier sur le mur',
        surclick: () => {
          Actions.fermer();
          Infos.publier({ types: ['vehicule', 'information'], importance: 'normale', titre, texte: detail });
        },
      }),
      el('button', { type: 'button', classe: 'lien', texte: 'Non merci', surclick: () => Actions.fermer() }),
    ]);
  }

  /** Armement actuel du véhicule : état global (changé par la fiche, les inventaires ou le menu du véhicule). */
  const armementActuel = (id) => {
    const v = donnees.vehicules.find((x) => x.id === id);
    const local = typeof Desarmement !== 'undefined' ? Desarmement.armement()[id] : '';
    return local || (v && v.armement) || 'ARMÉ';
  };
  /**
   * Interrupteur « Armé » de la fiche : même action que partout ailleurs (Desarmement.basculer) — question du
   * contenu, enregistrement immédiat sur l'appareil, envoi au serveur (file d'attente hors ligne).
   */
  async function basculerArmement(v, s, arme) {
    if (typeof Desarmement === 'undefined') { s.armement = arme ? 'ARMÉ' : 'DÉSARMÉ'; garderBrouillon(); rendre(); return; }
    if ((armementActuel(v.id) !== 'DÉSARMÉ') === arme) { rendre(); return; }
    await Desarmement.basculer(v.id, arme, {
      vehicules: donnees.vehicules.filter((x) => x.type !== 'AUTRE').map((x) => ({ id: x.id, nom: x.id })),
    });
    garderBrouillon();
    rendre();
  }
  /** Devenir du contenu choisi pour un véhicule désarmé ce matin. */
  function resumeContenu(v, s) {
    if (s.armement === 'DÉSARMÉ' && typeof Desarmement !== 'undefined') {
      const r = Desarmement.resume(Desarmement.desarmements()[v.id]);
      return r ? el('p', { classe: 'reg-note dsm-note', texte: r }) : null;
    }
    return null;
  }

  function ligneBip(b) {
    const s = saisie.bips[b.id] || (saisie.bips[b.id] = { nom: '', horaires: '' });
    const liste = (donnees.listes || {})[b.categorie] || [];
    return el('div', { classe: 'reg-bip' },
      el('div', { classe: 'reg-bip-affectation' }, el('strong', { texte: b.affectation.replace(/^[\d.\s]+-\s*/, '') }),
        el('small', { texte: (/^([\d.]{14})/.exec(b.affectation) || [])[1] || '' })),
      // Liste déroulante des utilisateurs de l'appli (métier du bip) ; saisie libre si aucune liste (élève ambulancier).
      liste.length ? el('select', {
        classe: 'reg-nom', 'aria-label': `Nom ${b.affectation}`,
        surchange: (e) => { s.nom = e.target.value; garderBrouillon(); },
      }, el('option', { valeur: '', texte: '— personne —' }),
      [...new Set([s.nom, ...liste].filter(Boolean))].map((n) => el('option', { valeur: n, texte: n, selected: n === s.nom })))
        : el('input', {
          type: 'text', classe: 'reg-nom', placeholder: 'Nom', valeur: s.nom || '', autocomplete: 'off',
          'aria-label': `Nom ${b.affectation}`, surinput: (e) => { s.nom = e.target.value; garderBrouillon(); },
        }),
      // Horaires des ambulanciers et des IADE : fixés par le Sheet, non modifiables.
      /^(ade|iade)$/.test(b.categorie) ? el('span', { classe: 'reg-horaires reg-horaires-fixe', texte: b.horaires || '' }) : el('input', {
        type: 'text', classe: 'reg-horaires', placeholder: 'Horaires', valeur: s.horaires || '',
        'aria-label': `Horaires ${b.affectation}`, surinput: (e) => { s.horaires = e.target.value; garderBrouillon(); },
      }),
      el('button', {
        type: 'button', classe: 'reg-vider', 'aria-label': `Vider ${b.affectation}`, texte: '✕',
        surclick: () => { s.nom = ''; if (!/^(ade|iade)$/.test(b.categorie)) s.horaires = ''; garderBrouillon(); rendre(); },
      }),
      b.note ? el('p', { classe: 'reg-note', texte: b.note }) : null);
  }

  /** Nuit : prise de poste entre 17 h et 5 h (« 18h00 -----> 6h00 »). Interne et étudiants : jour. */
  function periodeBip(b) {
    if (!/^(ade|iade)$/.test(b.categorie)) return 'jour';
    const horaires = b.horaires || '';
    const m = /(\d{1,2})\s*h/i.exec(horaires);
    if (!m) return 'jour';
    const h = Number(m[1]);
    return h >= 17 || h < 5 ? 'nuit' : 'jour';
  }

  function envoyer() {
    // Armement : l'état global du moment (déjà envoyé au serveur à chaque changement).
    const vehicules = donnees.vehicules.map((v) => {
      const s = { id: v.id, ...saisie.vehicules[v.id] };
      if (v.type !== 'AUTRE') s.armement = armementActuel(v.id);
      delete s.contenu; delete s.depuisStock; delete s.armePar;
      return s;
    });
    const sansPosition = donnees.vehicules.filter((v) => positionsPour(v).length && !saisie.vehicules[v.id].position).map((v) => v.id);
    if (sansPosition.length) {
      message = { texte: `Position à choisir : ${sansPosition.join(', ')}.`, classe: 'erreur' };
      rendre();
      return;
    }
    const bips = donnees.bips.map((b) => ({ id: b.id, affectation: b.affectation, ...saisie.bips[b.id] }));
    const ok = App.mettreEnFile({ action: 'envoyerFicheRegulation', donnees: { vehicules, bips } });
    if (!ok) return;
    ecrireStockage(CLE_FAITE, aujourdhui());
    // Armement connu tout de suite de l'appareil (inventaires IADE), même hors ligne.
    const arm = lireStockage('avismur_armement') || {};
    vehicules.forEach((v) => { if (v.armement) arm[v.id] = v.armement; });
    ecrireStockage('avismur_armement', arm);
    // La copie locale reflète la fiche envoyée (commentaires, positions…), même hors ligne.
    donnees.vehicules.forEach((v) => Object.assign(v, saisie.vehicules[v.id] || {}));
    donnees.date = aujourdhui(); // la copie locale est celle de la fiche du jour
    delete donnees.copieDu;
    donnees.bips.forEach((b) => { const x = saisie.bips[b.id] || {}; b.nom = x.nom || ''; if (!/^(ade|iade)$/.test(b.categorie)) b.horaires = x.horaires || ''; });
    ecrireStockage(CLE, donnees);
    localStorage.removeItem(CLE_BROUILLON);
    // L'envoi est asynchrone : tant que le serveur n'a pas répondu, on ne dit pas « envoyée » (voir surFile).
    envoiSuivi = !Simulation.actif();
    message = {
      texte: Simulation.actif() ? 'Simulation : fiche « envoyée » sans rien transmettre à la régulation.' : navigator.onLine ? 'Fiche enregistrée sur l\'appareil. Envoi à la régulation en cours…' : 'Hors ligne : la fiche est gardée sur l\'appareil et partira au retour du réseau.',
      classe: 'succes',
    };
    rendre();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function rendre() {
    if (!zone || zone.hidden) return;
    zone.innerHTML = '';
    zone.append(el('h1', { texte: 'Fiche régulation' }),
      el('p', { classe: 'consigne', texte: `État du parc et personnels présents sur 24 h — ${aujourdhui()}` }));
    if (exigee && !faite()) zone.append(el('p', { classe: 'message erreur', role: 'status', texte: 'La fiche régulation du jour n\'a pas encore été envoyée : remplissez-la et envoyez-la, la check-list des véhicules vient ensuite.' }));
    if (Simulation.actif()) zone.append(el('p', { classe: 'message', role: 'note', texte: 'Mode simulation : rien n\'est réellement envoyé à la régulation. Vous pouvez remplir et « envoyer » la fiche librement, elle sera effacée en quittant la simulation.' }));
    if (faite() && App.ouvrirVue) zone.append(el('button', { type: 'button', classe: 'cfg-bouton reg-suite', texte: 'Fiche du jour envoyée : passer à la check-list', surclick: () => App.ouvrirVue('checklist-ambulancier') }));
    if (message.texte) zone.append(el('p', { classe: `message ${message.classe}`, role: 'status', texte: message.texte }));
    if (erreur) zone.append(el('p', { classe: `message ${donnees ? 'info' : 'erreur'}`, role: 'status', texte: erreur }));
    if (!donnees) {
      if (!erreur) zone.append(el('p', { classe: 'message', texte: 'Chargement…' }));
      return;
    }
    const enAttente = App.fileAttente().some((e) => e.action === 'envoyerFicheRegulation');
    if (copieAncienne() && !faite()) zone.append(el('p', { classe: 'message', role: 'status', texte: `Fiche du ${donnees.copieDu} gardée sur l'appareil (réseau indisponible) : le personnel est remis à zéro, vérifiez les véhicules avant d'envoyer.` }));
    const dernier = donnees.dernierEnvoi;
    zone.append(el('p', {
      classe: 'reg-dernier',
      texte: enAttente ? 'Une fiche attend le réseau pour partir.'
        : dernier ? `Dernier envoi : ${dernier.date} à ${dernier.heure}${dernier.agent ? ` (${dernier.agent.replace(/^MySMUR : /, '')})` : ''}` : '',
    }));

    // Véhicules : départs primaires puis secondaires.
    const blocVehicules = el('section', { classe: 'reg-bloc' }, el('h2', { texte: 'Véhicules' }));
    ['primaire', 'secondaire'].forEach((groupe) => {
      const vs = donnees.vehicules.filter((v) => v.groupe === groupe);
      if (vs.length) blocVehicules.append(el('h3', { texte: groupe === 'primaire' ? 'Départs primaires' : 'Départs secondaires' }), el('div', { classe: 'reg-liste' }, vs.map(ligneVehicule)));
    });
    zone.append(blocVehicules);

    // Personnel : ambulanciers, IADE, puis interne et étudiants ; dans chacun, jour puis nuit.
    const blocPersonnel = el('section', { classe: 'reg-bloc' }, el('h2', { texte: 'Personnel et bips' }));
    const famille = (b) => (b.categorie === 'ade' ? 'Ambulanciers' : b.categorie === 'iade' ? 'IADE' : 'Interne et étudiants');
    ['Ambulanciers', 'IADE', 'Interne et étudiants'].forEach((f) => {
      const bs = donnees.bips.filter((b) => famille(b) === f);
      if (!bs.length) return;
      blocPersonnel.append(el('h3', { texte: f }));
      const periodes = [['jour', 'Jour'], ['nuit', 'Nuit']].map(([p, t]) => [p, t, bs.filter((b) => periodeBip(b) === p)]).filter((x) => x[2].length);
      periodes.forEach(([periode, titre, lignes]) => {
        blocPersonnel.append(el('div', { classe: `reg-periode reg-${periode}` },
          periodes.length > 1 ? el('h4', { texte: titre }) : null,
          el('div', { classe: 'reg-liste' }, lignes.map(ligneBip))));
      });
    });
    zone.append(blocPersonnel);
    zone.append(el('div', { classe: 'reg-actions' },
      el('button', { type: 'button', classe: 'principal', texte: 'Envoyer à la régulation', surclick: envoyer }),
      el('button', {
        type: 'button', classe: 'cfg-bouton', texte: 'Reprendre la dernière fiche envoyée',
        surclick: () => { localStorage.removeItem(CLE_BROUILLON); initialiserSaisie(); message = { texte: '', classe: '' }; rendre(); },
      })));
  }

  // Armement changé ailleurs (inventaires, menu du véhicule, serveur) : la fiche affichée suit.
  window.addEventListener('avismur-armement', () => rendre());

  return {
    initialiser(app) {
      App = app;
      zone = document.getElementById('zone-regulation');
    },
    /**
     * Interrupteur « Disponible » d'ailleurs (fiche véhicule du tableau de bord) : modifie la fiche régulation
     * du jour (brouillon) et enregistre tout de suite dans le Sheet. Renvoie false si rien n'a pu être enregistré.
     */
    changerDisponibilite(id, disponible) {
      if (!donnees) donnees = copieDuJour(lireStockage(CLE));
      if (!donnees || !donnees.vehicules) return enregistrerDisponibilite(id, disponible ? 'OUI' : 'NON');
      if (!saisie) initialiserSaisie();
      const v = donnees.vehicules.find((x) => x.id === id);
      if (!v) return false;
      const s = saisie.vehicules[id] || (saisie.vehicules[id] = { disponible: 'OUI', position: v.position || '', commentaire: '' });
      appliquerDisponibilite(v, s, disponible ? 'OUI' : 'NON');
      return true;
    },
    /** La fiche du jour est-elle envoyée (ou partie dans la file d'attente) ? */
    faiteAujourdhui: () => faite(),
    ouvrir(obligatoire) {
      exigee = !!obligatoire;
      zone.hidden = false;
      message = { texte: '', classe: '' };
      if (!donnees) {
        donnees = copieDuJour(lireStockage(CLE));
        if (donnees) initialiserSaisie();
      }
      rendre();
      charger();
    },
    masquer() {
      if (zone) zone.hidden = true;
    },
    /** Après l'envoi de la file d'attente : relit la fiche (dernier envoi). */
    surEnvoi() {
      if (zone && !zone.hidden) charger();
    },
    /**
     * Fin de chaque passage de la file d'attente : dit la vérité sur la fiche du jour (partie, en attente du réseau,
     * ou refusée par le serveur). `bilan` : { refusees: Map(id → motif), horsLigne }.
     */
    surFile(bilan = {}) {
      if (!envoiSuivi) return;
      const attente = App.fileAttente().filter((e) => e.action === 'envoyerFicheRegulation');
      if (!attente.length) {
        envoiSuivi = false;
        message = { texte: 'Fiche envoyée à la régulation (PDF par mail).', classe: 'succes' };
      } else if (bilan.refusees && attente.some((e) => bilan.refusees.has(e.id))) {
        const motif = bilan.refusees.get(attente.find((e) => bilan.refusees.has(e.id)).id);
        message = { texte: `Fiche refusée par le serveur : ${motif}. Elle reste sur l'appareil.`, classe: 'erreur' };
      } else if (bilan.horsLigne || !navigator.onLine) {
        message = { texte: 'Hors ligne : la fiche est gardée sur l\'appareil et partira au retour du réseau.', classe: 'succes' };
      } else return;
      if (zone && !zone.hidden) rendre();
    },
    /**
     * Télécharge la fiche à l'avance (appli ouverte avec du réseau) pour pouvoir la remplir plus tard hors ligne.
     * Sans effet si la copie gardée est déjà celle du jour ; échec silencieux.
     */
    async precharger() {
      const gardee = lireStockage(CLE);
      if (gardee && String(gardee.date || '').trim() === aujourdhui()) return;
      try {
        const rep = await App.appeler('lireFicheRegulation');
        if (!rep || !rep.ok) return;
        ecrireStockage(CLE, rep);
        if (!donnees || !(zone && !zone.hidden)) donnees = null; // relue à l'ouverture, depuis la copie fraîche
      } catch (e) { /* hors ligne : on essaiera au prochain retour du réseau */ }
    },
  };
})();
