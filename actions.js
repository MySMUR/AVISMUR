/*
 * Menu d'actions d'un véhicule (en touchant sa case) et écrans associés :
 * check-list, dernière check-list, plein, passage au garage, nettoyage, vérification extérieure,
 * historique. Les enregistrements passent par la file d'attente (hors ligne possible).
 */
const Actions = (() => {
  let fond = null; // fenêtre ouverte
  let retourFocus = null;

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
    n.append(...enfants.filter((e) => e !== null && e !== undefined && e !== false));
    return n;
  }
  let compteur = 0;
  const id = () => `act${(compteur += 1)}`;
  const date = (iso) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });

  // ---------- Fenêtre ----------
  function fermer() {
    if (!fond) return;
    fond.remove();
    fond = null;
    document.body.classList.remove('fenetre-ouverte');
    if (retourFocus && document.contains(retourFocus)) retourFocus.focus();
  }

  /** Ouvre (ou remplace) le contenu de la fenêtre. */
  function fenetre(titre, ...contenu) {
    if (!fond) {
      retourFocus = document.activeElement;
      fond = el('div', { classe: 'fenetre-fond', surclick: (e) => { if (e.target === fond) fermer(); } });
      fond.addEventListener('keydown', (e) => { if (e.key === 'Escape') fermer(); });
      document.body.append(fond);
      document.body.classList.add('fenetre-ouverte');
    }
    const idTitre = id();
    const panneau = el('div', { classe: 'fenetre', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': idTitre },
      el('div', { classe: 'fenetre-entete' }, el('h2', { id: idTitre, texte: titre }),
        el('button', { type: 'button', classe: 'fenetre-fermer', 'aria-label': 'Fermer', texte: '✕', surclick: fermer })),
      el('div', { classe: 'fenetre-corps' }, ...contenu));
    fond.innerHTML = '';
    fond.append(panneau);
    const premier = panneau.querySelector('.fenetre-corps button, .fenetre-corps input, .fenetre-corps textarea');
    (premier || panneau.querySelector('.fenetre-fermer')).focus();
    return panneau;
  }

  const message = (panneau, texte, classe = '') => {
    let p = panneau.querySelector('.fenetre-message');
    if (!p) { p = el('p', { classe: 'message fenetre-message', role: 'status' }); panneau.querySelector('.fenetre-corps').append(p); }
    p.textContent = texte;
    p.className = `message fenetre-message ${classe}`.trim();
  };

  function boutonRetour(v, info, etatV) {
    return el('button', { type: 'button', classe: 'lien', texte: '← Retour aux actions', surclick: () => ouvrir(v, info, etatV) });
  }

  // ---------- Menu ----------
  function ouvrir(v, info, etatV) {
    const nom = v.nom || v.id;
    const action = (icone, texte, detail, faire, principal) => el('button', {
      type: 'button', classe: `action${principal ? ' action-principale' : ''}`, surclick: faire,
    }, el('span', { classe: 'action-icone', 'aria-hidden': 'true', texte: icone }),
    el('span', { classe: 'action-texte' }, el('strong', { texte }), detail ? el('small', { texte: detail }) : null));

    const cl = info.statut;
    fenetre(nom,
      el('p', { classe: 'fenetre-resume', texte: etatV.classe === 'indispo' ? 'Non disponible d\'après l\'état du parc du jour.' : (etatV.position && etatV.position.position ? `Position du jour : ${etatV.position.position}` : '') }),
      el('div', { classe: 'actions' },
        action('📋', cl ? 'Reprendre la check-list du jour' : 'Faire la check-list du jour',
          cl ? `Faite à ${new Date(cl.date).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} par ${cl.agent}` : 'Vérification du matin',
          () => { fermer(); App.ouvrirChecklist(v.id); }, true),
        action('👁️', 'Voir la dernière check-list', info.derniereCL ? `${date(info.derniereCL.date)} · ${info.derniereCL.agent}` : 'Aucune check-list enregistrée',
          () => voirCheckList(v, info, etatV, info.derniereCL)),
        v.sansPlein ? null : action('⛽', 'Signaler un plein', info.dernierPlein ? `Dernier : ${date(info.dernierPlein.date)}` : 'Carburant, AdBlue, ticket', () => plein(v, info, etatV)),
        v.sansExterieur ? null : action('🚐', 'Vérification extérieure', info.defauts.length ? `${info.defauts.length} défaut(s) connu(s)` : 'Carrosserie : rayures, impacts', () => exterieur(v, info, etatV)),
        v.sansGarage ? null : action('🔧', 'Passage au garage', info.dernierGarage ? `Dernier : ${date(info.dernierGarage.date)}` : 'Entretien, réparation, contrôle', () => garage(v, info, etatV)),
        v.sansNettoyage ? null : action('🧽', 'Nettoyage', resumeNettoyage(info), () => nettoyage(v, info, etatV)),
        action('🕘', 'Historique du véhicule', 'Check-lists, pleins, garage, carrosserie', () => historique(v, info, etatV)),
        actionArmement(v, action)));
  }

  /** VML et UMH : désarmer (que devient le contenu des tiroirs et placards ?) ou réarmer (desarmement.js). */
  function actionArmement(v, action) {
    if (typeof Desarmement === 'undefined' || !/^(VML|UMH)$/i.test(String(v.modele || ''))) return null;
    const desarme = Desarmement.estDesarme(v.id);
    const e = Desarmement.desarmements()[v.id];
    return action(desarme ? '🧰' : '📦', desarme ? 'Réarmer le véhicule' : 'Désarmer le véhicule',
      desarme ? (Desarmement.resume(e) || 'Véhicule désarmé') : 'Le contenu des tiroirs et placards est retiré',
      async () => {
        fermer();
        await Desarmement.basculer(v.id, desarme);
      });
  }

  /** Check-list ambulancier : toucher une tuile propose de faire (ou reprendre) la check-list du jour. */
  function proposerChecklist(v, info, etatV) {
    const cl = info.statut;
    const heureCL = cl ? new Date(cl.date).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '';
    fenetre(v.nom || v.id,
      el('p', { classe: 'fenetre-resume', texte: cl
        ? `Check-list faite à ${heureCL} par ${cl.agent}${cl.anomalies.length ? ` (${cl.anomalies.length} anomalie${cl.anomalies.length > 1 ? 's' : ''})` : ''}.`
        : (etatV.position && etatV.position.position ? `Position du jour : ${etatV.position.position}` : 'Check-list du jour à faire.') }),
      el('div', { classe: 'actions' },
        el('button', { type: 'button', classe: 'action action-principale', surclick: () => { fermer(); App.ouvrirChecklist(v.id); } },
          el('span', { classe: 'action-icone', 'aria-hidden': 'true', texte: '📋' }),
          el('span', { classe: 'action-texte' }, el('strong', { texte: cl ? 'Reprendre la check-list' : 'Faire la check-list' }),
            el('small', { texte: cl ? 'Corriger : la nouvelle remplace la précédente' : 'Vérification du matin' })))),
      el('button', { type: 'button', classe: 'lien', texte: 'Autres actions sur le véhicule ›', surclick: () => ouvrir(v, info, etatV) }));
  }

  // ---------- Dernière check-list (lecture) ----------
  function voirCheckList(v, info, etatV, cl) {
    if (!cl) {
      fenetre(`${v.nom || v.id} · dernière check-list`, el('p', { texte: 'Aucune check-list enregistrée pour ce véhicule.' }), boutonRetour(v, info, etatV));
      return;
    }
    const liste = el('dl', { classe: 'reponses' });
    Object.entries(cl.reponses || {}).forEach(([cle, valeur]) => {
      if (valeur === '' || valeur === null || cle.startsWith('Position (')) return;
      const manquant = valeur === 'Manquant';
      liste.append(el('div', { classe: `reponse${manquant ? ' manquant' : ''}` }, el('dt', { texte: cle }),
        el('dd', { texte: typeof valeur === 'number' && /obus|bouteille/i.test(cle) ? `${valeur}/10` : String(valeur) })));
    });
    const anomalies = cl.anomalies && cl.anomalies.length
      ? el('div', { classe: 'note-parc anomalie' }, el('p', { texte: 'Anomalies :' }), el('ul', {}, ...cl.anomalies.map((a) => el('li', { texte: a }))))
      : el('p', { classe: 'note-parc fait', texte: 'Aucune anomalie.' });
    fenetre(`${v.nom || v.id} · check-list du ${date(cl.date)}`,
      el('p', { classe: 'fenetre-resume', texte: `Par ${cl.agent}` }), anomalies, liste, boutonRetour(v, info, etatV));
  }

  // ---------- Photos ----------
  /** Photo recadrée (outil commun), réduite à 1280 px et compressée (JPEG) ; null si annulé. */
  const lirePhoto = (source) => Recadrage.photo(source, { cote: 1280, qualites: [0.7] });

  /** Bouton « Prendre une photo » + aperçu. `surPhoto(dataUrl | '')`. */
  function champPhoto(libelle, surPhoto, initiale = '') {
    const i = id();
    const apercu = el('img', { classe: 'photo-apercu', alt: 'Photo jointe', hidden: !initiale, src: initiale || undefined });
    const retirer = el('button', { type: 'button', classe: 'lien', texte: 'Retirer la photo', hidden: !initiale });
    const recadrer = el('button', { type: 'button', classe: 'lien', texte: '✂ Recadrer', hidden: !initiale });
    const entree = el('input', { type: 'file', id: i, accept: 'image/*', capture: 'environment', classe: 'invisible' });
    entree.addEventListener('change', async () => {
      const fichier = entree.files[0];
      entree.value = '';
      if (fichier) appliquer(fichier);
    });
    async function appliquer(source) {
      try {
        const photo = await lirePhoto(source);
        if (!photo) return;
        apercu.src = photo; apercu.hidden = false; retirer.hidden = false; recadrer.hidden = false;
        surPhoto(photo);
      } catch (e) { /* image illisible : on ignore */ }
    }
    recadrer.addEventListener('click', () => { if (apercu.src) appliquer(apercu.src); });
    retirer.addEventListener('click', () => { apercu.hidden = true; retirer.hidden = true; recadrer.hidden = true; apercu.removeAttribute('src'); surPhoto(''); });
    return el('div', { classe: 'champ-photo' },
      el('label', { for: i, classe: 'bouton-photo', texte: `📷 ${libelle}` }), entree, apercu, recadrer, retirer);
  }

  const photosEnMemoire = {}; // photos déjà chargées : affichage immédiat la fois suivante
  async function afficherPhotoServeur(conteneur, idPhoto) {
    const poser = (src) => { conteneur.textContent = ''; conteneur.append(el('img', { classe: 'photo-apercu', alt: 'Photo du défaut', src })); };
    if (/^data:|^blob:|^https?:/.test(idPhoto)) { poser(idPhoto); return; }
    if (photosEnMemoire[idPhoto]) { poser(photosEnMemoire[idPhoto]); return; }
    conteneur.textContent = 'Chargement de la photo…';
    try {
      const rep = await App.appeler('photo', { id: idPhoto });
      conteneur.textContent = '';
      if (rep.ok) { photosEnMemoire[idPhoto] = rep.photo; poser(rep.photo); }
      else conteneur.textContent = 'Photo indisponible.';
    } catch (e) {
      conteneur.textContent = 'Photo indisponible hors ligne.';
    }
  }

  function puces(nom, options, valeur, surChoix) {
    const groupe = el('div', { classe: 'puces' });
    options.forEach((o) => {
      const i = id();
      const radio = el('input', { type: 'radio', name: nom, id: i, value: String(o), checked: String(o) === String(valeur) });
      radio.addEventListener('change', () => surChoix(o));
      groupe.append(radio, el('label', { for: i, texte: String(o) }));
    });
    return groupe;
  }

  // ---------- Plein ----------
  /** Carburant : liste des pleins du véhicule, avec « Ajouter un plein » en haut. */
  async function pleins(v, info, etatV) {
    const titre = `${v.nom || v.id} · carburant`;
    const ajouter = () => el('button', { type: 'button', classe: 'principal', texte: '＋ Ajouter un plein',
      surclick: () => plein(v, info, etatV, () => pleins(v, info, etatV)) });
    const panneau = fenetre(titre, ajouter(), el('p', { classe: 'aide-question', texte: 'Chargement des pleins…' }));
    let entrees = null;
    try {
      const rep = await App.appeler('historiqueVehicule', { vehicule: v.id });
      if (rep.ok) entrees = (rep.historique || []).filter((e) => e.type === 'plein');
    } catch (e) { /* hors ligne : on montre le dernier plein connu */ }
    if (!fond || !document.contains(panneau)) return; // fenêtre fermée ou autre écran entre-temps
    if (!entrees) {
      const d = info.dernierPlein;
      fenetre(titre, ajouter(), el('p', { classe: 'message erreur', texte: 'Liste des pleins indisponible hors ligne.' }),
        d ? el('p', { classe: 'aide-question', texte: `Dernier plein connu : ${date(d.date)}${d.agent ? ` · ${d.agent}` : ''}` }) : null);
      return;
    }
    const liste = el('ul', { classe: 'historique' });
    entrees.forEach((e) => liste.append(el('li', { classe: 'entree plein' },
      el('span', { classe: 'entree-titre' }, el('strong', { texte: date(e.date) }), el('span', { texte: e.agent || '' })),
      el('span', { classe: 'entree-resume', texte: resume(e) }))));
    fenetre(titre, ajouter(), entrees.length ? liste : el('p', { texte: 'Aucun plein enregistré pour ce véhicule.' }));
  }

  function plein(v, info, etatV, retour = null) {
    const saisie = { km: '', carburant: 8, adblue: false, commentaire: '', photo: '' };
    const precedent = info.releve ? info.releve.km : null;
    const idKm = id();
    const km = el('input', { id: idKm, inputmode: 'numeric', classe: 'saisie-km', autocomplete: 'off',
      surinput: (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 7); saisie.km = e.target.value; } });
    const ligneKm = el('div', { classe: 'ligne-km' }, km);
    if (Compteur.disponible()) {
      ligneKm.append(el('button', { type: 'button', classe: 'bouton-photo', texte: '📷 Lire le compteur', surclick: async () => {
        const lu = await Compteur.lire({ precedent });
        if (lu) { km.value = String(lu); saisie.km = km.value; }
      } }));
    }
    const idCom = id();
    const panneau = fenetre(`${v.nom || v.id} · plein`,
      el('div', { classe: 'champ' }, el('label', { for: idKm, texte: 'Kilométrage au moment du plein' }),
        precedent ? el('p', { classe: 'aide-question', texte: `Dernier relevé : ${precedent.toLocaleString('fr-FR')} km` }) : null, ligneKm),
      el('p', { classe: 'aide-question', texte: 'Après le plein, la jauge du véhicule passe à 8/8.' }),
      el('label', { classe: 'cfg-case' }, el('input', { type: 'checkbox', surchange: (e) => { saisie.adblue = e.target.checked; } }),
        el('span', { texte: 'AdBlue complété aussi' })),
      champPhoto('Photo du ticket', (p) => { saisie.photo = p; }),
      el('div', { classe: 'champ' }, el('label', { for: idCom, texte: 'Commentaire' }),
        el('textarea', { id: idCom, rows: 2, surinput: (e) => { saisie.commentaire = e.target.value; } })),
      el('button', { type: 'button', classe: 'principal', texte: 'Enregistrer le plein', surclick: () => {
        if (saisie.km && precedent && Number(saisie.km) < precedent) {
          message(panneau, `Kilométrage inférieur au dernier relevé (${precedent.toLocaleString('fr-FR')} km).`, 'erreur');
          return;
        }
        if (App.envoyerEvenement('plein', v.id, { ...saisie, km: saisie.km ? Number(saisie.km) : '' })) {
          fermer();
        }
      } }),
      retour ? el('button', { type: 'button', classe: 'lien', texte: '← Retour aux pleins', surclick: retour }) : boutonRetour(v, info, etatV));
  }

  // ---------- Garage ----------
  function garage(v, info, etatV) {
    // Plusieurs motifs possibles (ex. carrosserie et pneus) : enregistrés « Carrosserie, Pneus ».
    const motifs = new Set();
    const saisie = { motif: '', motifs: [], commentaire: '' };
    const idCom = id();
    const panneauGarage = fenetre(`${v.nom || v.id} · passage au garage`,
      info.dernierGarage ? el('p', { classe: 'aide-question', texte: `Dernier passage : ${date(info.dernierGarage.date)}${info.dernierGarage.motif ? ` (${info.dernierGarage.motif})` : ''}` }) : null,
      el('fieldset', { classe: 'question' }, el('legend', { texte: 'Motifs (plusieurs possibles)' }),
        el('div', { classe: 'puces motifs' }, ...['Entretien', 'Réparation', 'Contrôle technique', 'Pneus', 'Carrosserie', 'Autre'].flatMap((o) => {
          const i = id();
          return [el('input', { type: 'checkbox', id: i, value: o, surchange: (e) => { if (e.target.checked) motifs.add(o); else motifs.delete(o); } }),
            el('label', { for: i, texte: o })];
        }))),
      el('div', { classe: 'champ' }, el('label', { for: idCom, texte: 'Commentaire' }),
        el('textarea', { id: idCom, rows: 3, surinput: (e) => { saisie.commentaire = e.target.value; } })),
      el('button', { type: 'button', classe: 'principal', texte: 'Enregistrer le passage au garage', surclick: () => {
        const ordre = ['Entretien', 'Réparation', 'Contrôle technique', 'Pneus', 'Carrosserie', 'Autre'];
        saisie.motifs = ordre.filter((o) => motifs.has(o));
        if (!saisie.motifs.length) { message(panneauGarage, 'Choisissez au moins un motif.', 'erreur'); return; }
        saisie.motif = saisie.motifs.join(', ');
        if (App.envoyerEvenement('garage', v.id, saisie)) fermer();
      } }),
      boutonRetour(v, info, etatV));
  }

  // ---------- Nettoyage ----------
  function resumeNettoyage(info) {
    const i = info.dernierNettoyageInterieur;
    const e = info.dernierNettoyageExterieur;
    if (!i && !e) return 'Intérieur, extérieur';
    return [i ? `intérieur ${date(i.date)}` : '', e ? `extérieur ${date(e.date)}` : ''].filter(Boolean).join(' · ');
  }

  function nettoyage(v, info, etatV) {
    const saisie = { interieur: true, exterieur: false, commentaire: '' };
    const idCom = id();
    const panneau = fenetre(`${v.nom || v.id} · nettoyage`,
      el('p', { classe: 'aide-question', texte: `Derniers : ${resumeNettoyage(info)}` }),
      el('fieldset', { classe: 'question' }, el('legend', { texte: 'Nettoyage fait' }),
        el('label', { classe: 'cfg-case' }, el('input', { type: 'checkbox', checked: true, surchange: (e) => { saisie.interieur = e.target.checked; } }), el('span', { texte: 'Intérieur (cellule, poste de conduite)' })),
        el('label', { classe: 'cfg-case' }, el('input', { type: 'checkbox', surchange: (e) => { saisie.exterieur = e.target.checked; } }), el('span', { texte: 'Extérieur (lavage)' }))),
      el('div', { classe: 'champ' }, el('label', { for: idCom, texte: 'Commentaire' }),
        el('textarea', { id: idCom, rows: 2, surinput: (e) => { saisie.commentaire = e.target.value; } })),
      el('button', { type: 'button', classe: 'principal', texte: 'Enregistrer le nettoyage', surclick: () => {
        if (!saisie.interieur && !saisie.exterieur) {
          message(panneau, 'Cochez intérieur, extérieur ou les deux.', 'erreur');
          return;
        }
        if (App.envoyerEvenement('nettoyage', v.id, saisie)) fermer();
      } }),
      boutonRetour(v, info, etatV));
  }

  // ---------- Vérification extérieure ----------
  const FACES = { gauche: 'Côté gauche', droite: 'Côté droit', avant: 'Avant', arriere: 'Arrière' };

  // Calques par véhicule : fichier dans img/vues/, « * » remplacé par la face (gauche, droite, avant, arriere).
  // Les proportions des fichiers correspondent aux cadres .schema-cote (2:1) et .schema-face (6:5).
  const CALQUES = {
    F21: 'jumpy_*.svg', F22: 'jumpy_*.svg', // Citroën Jumpy, dessiné d'après photos
    F25: 'jaune_*.jpg', F26: 'jaune_*.jpg', // véhicule jaune
  };

  /** Silhouette du véhicule, vue de la face demandée (repère 0..1 pour les défauts). */
  function silhouette(face, v) {
    const calque = v && CALQUES[v.id];
    if (calque) return el('img', { src: `img/vues/${calque.replace('*', face)}`, alt: '', classe: 'silhouette calque', draggable: 'false' });
    const s = el('svg:svg', { viewBox: face === 'gauche' || face === 'droite' ? '0 0 200 100' : '0 0 120 100', classe: 'silhouette', 'aria-hidden': 'true' });
    const trait = (d, classe = '') => s.append(el('svg:path', { d, classe }));
    if (face === 'gauche' || face === 'droite') {
      const g = el('svg:g', face === 'droite' ? { transform: 'translate(200 0) scale(-1 1)' } : {});
      s.append(g);
      const t = (d, classe = '') => g.append(el('svg:path', { d, classe }));
      t('M8 78 V22 Q8 12 18 12 H138 L163 40 Q190 44 192 58 V78 Z', 'carrosserie');
      t('M142 18 L160 40 H142 Z', 'vitre');
      t('M20 22 H70 V40 H20 Z M80 22 H130 V40 H80 Z', 'vitre');
      t('M12 50 H188', 'bande');
      g.append(el('svg:circle', { cx: 45, cy: 80, r: 12, class: 'roue' }), el('svg:circle', { cx: 158, cy: 80, r: 12, class: 'roue' }));
    } else if (face === 'avant') {
      trait('M14 82 V30 Q14 12 32 10 H88 Q106 12 106 30 V82 Z', 'carrosserie');
      trait('M22 18 H98 L102 42 H18 Z', 'vitre');
      trait('M20 58 H38 V66 H20 Z M82 58 H100 V66 H82 Z', 'phare');
      trait('M44 56 H76 V70 H44 Z', 'bande');
      trait('M40 6 H80 V10 H40 Z', 'gyro');
      s.append(el('svg:rect', { x: 18, y: 82, width: 16, height: 12, rx: 3, class: 'roue' }), el('svg:rect', { x: 86, y: 82, width: 16, height: 12, rx: 3, class: 'roue' }));
    } else {
      trait('M12 84 V14 Q12 8 18 8 H102 Q108 8 108 14 V84 Z', 'carrosserie');
      trait('M60 8 V84', 'joint');
      trait('M20 16 H54 V36 H20 Z M66 16 H100 V36 H66 Z', 'vitre');
      trait('M14 50 H106', 'bande');
      trait('M14 70 H24 V80 H14 Z M96 70 H106 V80 H96 Z', 'phare');
      s.append(el('svg:rect', { x: 18, y: 84, width: 16, height: 10, rx: 3, class: 'roue' }), el('svg:rect', { x: 86, y: 84, width: 16, height: 10, rx: 3, class: 'roue' }));
    }
    return s;
  }

  /**
   * Carrosserie : schéma du véhicule face par face (flèches ‹ ›) avec les défauts en cours ; toucher un point
   * ouvre son détail (tout ambulancier peut le déclarer réparé) ; toucher le schéma ailleurs signale un défaut.
   * Sous le schéma : défauts en cours puis défauts passés (plus pâles), du plus récent au plus ancien.
   */
  const ORDRE_FACES = Object.keys(FACES);
  const recent = (a, b) => new Date(b.date || 0) - new Date(a.date || 0);
  function exterieur(v, info, etatV, face = 'gauche', passes = null) {
    info = (typeof Ambulancier !== 'undefined' && Ambulancier.infosVehicule ? Ambulancier.infosVehicule(v.id) : info) || info;
    const titre = `${v.nom || v.id} · carrosserie`;
    const enCours = [...info.defauts].sort((x, y) => -recent(x, y)); // plus ancien d'abord → numéros stables
    const numero = (d) => enCours.indexOf(d) + 1;
    const revenir = () => exterieur(v, info, etatV, face, passes);

    const zone = el('div', { classe: `schema schema-${face === 'gauche' || face === 'droite' ? 'cote' : 'face'}` }, silhouette(face, v));
    enCours.filter((d) => d.face === face).forEach((d) => zone.append(el('button', {
      type: 'button', classe: 'repere connu', style: `left:${d.x * 100}%;top:${d.y * 100}%`,
      'aria-label': `Défaut ${numero(d)}${d.commentaire ? ` : ${d.commentaire}` : ''}`, texte: String(numero(d)),
      surclick: (e) => { e.stopPropagation(); detailDefaut(v, d, false, revenir); } })));
    zone.addEventListener('click', (e) => {
      const r = zone.getBoundingClientRect();
      nouveauDefaut(v, { id: `${v.id}-${Date.now()}`, face, x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, commentaire: '', photo: '' }, revenir);
    });

    const i = ORDRE_FACES.indexOf(face);
    const vers = (pas) => ORDRE_FACES[(i + pas + ORDRE_FACES.length) % ORDRE_FACES.length];
    const nbFace = enCours.filter((d) => d.face === face).length;
    const navigation = el('div', { classe: 'faces-nav' },
      el('button', { type: 'button', classe: 'faces-fleche', 'aria-label': `Vue précédente : ${FACES[vers(-1)]}`, texte: '‹', surclick: () => exterieur(v, info, etatV, vers(-1), passes) }),
      el('strong', { classe: 'faces-nom', 'aria-live': 'polite', texte: nbFace ? `${FACES[face]} (${nbFace})` : FACES[face] }),
      el('button', { type: 'button', classe: 'faces-fleche', 'aria-label': `Vue suivante : ${FACES[vers(1)]}`, texte: '›', surclick: () => exterieur(v, info, etatV, vers(1), passes) }));

    const ligne = (d, passe) => el('li', {}, el('button', { type: 'button', classe: `defaut-ligne${passe ? ' passe' : ''}`, surclick: () => detailDefaut(v, d, passe, revenir) },
      el('span', { classe: `repere ${passe ? 'repare' : 'connu'}`, texte: passe ? '✓' : String(numero(d)) }),
      el('span', { classe: 'defaut-ligne-texte' }, el('strong', { texte: d.commentaire || 'Sans description' }),
        el('small', { texte: `${FACES[d.face] || ''} · ${date(d.date)}${d.agent ? ` · ${d.agent}` : ''}${passe && d.repareLe ? ` · réparé le ${date(d.repareLe)}` : ''}` }))));
    const listeEnCours = enCours.length
      ? el('ul', { classe: 'defauts-liste' }, ...[...enCours].sort(recent).map((d) => ligne(d, false)))
      : el('p', { classe: 'aide-question', texte: 'Aucun défaut en cours.' });
    const blocPasses = el('div', {});
    if (passes === null) blocPasses.append(el('p', { classe: 'aide-question', texte: 'Chargement des défauts passés…' }));
    else if (passes === false) blocPasses.append(el('p', { classe: 'aide-question', texte: 'Défauts passés indisponibles hors ligne.' }));
    else if (passes.length) blocPasses.append(el('ul', { classe: 'defauts-liste' }, ...passes.map((d) => ligne(d, true))));
    else blocPasses.append(el('p', { classe: 'aide-question', texte: 'Aucun défaut passé.' }));

    const panneau = fenetre(titre,
      el('p', { classe: 'aide-question', texte: 'Touchez un point pour voir le défaut, ou le schéma ailleurs pour en signaler un nouveau.' }),
      navigation, zone,
      el('h3', { classe: 'defauts-titre', texte: `Défauts en cours (${enCours.length})` }), listeEnCours,
      el('h3', { classe: 'defauts-titre passe', texte: 'Défauts passés' }), blocPasses);

    if (passes === null) {
      App.appeler('historiqueVehicule', { vehicule: v.id }).then((rep) => {
        if (!rep.ok) throw new Error();
        const tous = {};
        const repares = {};
        (rep.historique || []).filter((e) => e.type === 'exterieur').forEach((e) => {
          const d = e.detail || {};
          (d.defauts || []).forEach((x) => { tous[x.id] = { ...x, date: e.date, agent: e.agent }; });
          (d.repares || []).forEach((idR) => { repares[idR] = { repareLe: e.date, reparePar: e.agent }; });
        });
        const liste = Object.values(tous).filter((d) => repares[d.id] && !info.defauts.some((x) => x.id === d.id))
          .map((d) => ({ ...d, ...repares[d.id] })).sort(recent);
        return liste;
      }).catch(() => false).then((liste) => {
        if (fond && document.contains(panneau)) exterieur(v, info, etatV, face, liste);
      });
    }
  }

  /** Détail d'un défaut ; s'il est en cours, n'importe quel ambulancier peut le déclarer réparé. */
  function detailDefaut(v, d, passe, revenir) {
    const photo = el('div', { classe: 'photo-defaut' });
    const panneau = fenetre(`${v.nom || v.id} · défaut`,
      el('p', {}, el('strong', { texte: d.commentaire || 'Sans description' })),
      el('p', { classe: 'aide-question', texte: `${FACES[d.face] || ''} · signalé le ${date(d.date)}${d.agent ? ` par ${d.agent}` : ''}` }),
      passe ? el('p', { classe: 'aide-question', texte: `Réparé le ${date(d.repareLe)}${d.reparePar ? ` (signalé par ${d.reparePar})` : ''}` }) : null,
      photo,
      passe ? null : el('button', { type: 'button', classe: 'principal', texte: '✓ Signaler comme réparé', surclick: () => {
        if (App.envoyerEvenement('exterieur', v.id, { defauts: [], repares: [d.id], commentaire: '' })) revenir();
        else message(panneau, 'Enregistrement impossible.', 'erreur');
      } }),
      el('button', { type: 'button', classe: 'lien', texte: '← Retour au schéma', surclick: revenir }));
    if (d.photoLocale) photo.append(el('img', { classe: 'photo-apercu', alt: 'Photo du défaut', src: d.photoLocale }));
    else if (d.photo) afficherPhotoServeur(photo, d.photo);
    else photo.append(el('p', { classe: 'aide-question', texte: 'Pas de photo pour ce défaut.' }));
  }

  /** Signalement d'un nouveau défaut à l'endroit touché. */
  function nouveauDefaut(v, d, revenir) {
    const idC = id();
    fenetre(`${v.nom || v.id} · nouveau défaut (${FACES[d.face]})`,
      el('div', { classe: 'champ' }, el('label', { for: idC, texte: 'Description' }),
        el('input', { id: idC, placeholder: 'Rayure, impact, bosse…', surinput: (e) => { d.commentaire = e.target.value; } })),
      champPhoto('Photo du défaut', (p) => { d.photo = p; }, d.photo),
      el('button', { type: 'button', classe: 'principal', texte: 'Enregistrer le défaut', surclick: () => {
        if (App.envoyerEvenement('exterieur', v.id, { defauts: [d], repares: [], commentaire: '' })) revenir();
      } }),
      el('button', { type: 'button', classe: 'lien', texte: 'Annuler', surclick: revenir }));
  }


  // ---------- Historique ----------
  const TYPES = { checklist: '📋 Check-list', plein: '⛽ Plein', garage: '🔧 Garage', nettoyage: '🧽 Nettoyage', exterieur: '🚐 Vérification extérieure' };

  function resume(e) {
    if (e.type === 'checklist') {
      const r = e.reponses || {};
      const morceaux = [];
      if (r.Kilométrage) morceaux.push(`${Number(r.Kilométrage).toLocaleString('fr-FR')} km`);
      if (r.Carburant) morceaux.push(`carburant ${r.Carburant}`);
      morceaux.push(e.anomalies && e.anomalies.length ? `${e.anomalies.length} anomalie(s)` : 'sans anomalie');
      return morceaux.join(' · ');
    }
    const d = e.detail || {};
    if (e.type === 'plein') return [d.km ? `${Number(d.km).toLocaleString('fr-FR')} km` : '', `carburant ${d.carburant}/8`, d.adblue ? 'AdBlue' : '', d.commentaire].filter(Boolean).join(' · ');
    if (e.type === 'garage') return [d.motif, d.commentaire].filter(Boolean).join(' · ');
    if (e.type === 'nettoyage') return [d.interieur && d.exterieur ? 'intérieur et extérieur' : (d.interieur ? 'intérieur' : 'extérieur'), d.commentaire].filter(Boolean).join(' · ');
    if (e.type === 'exterieur') return [`${(d.defauts || []).length} nouveau(x) défaut(s)`, (d.repares || []).length ? `${d.repares.length} réparé(s)` : '', d.commentaire].filter(Boolean).join(' · ');
    return '';
  }

  async function historique(v, info, etatV) {
    const panneau = fenetre(`${v.nom || v.id} · historique`, el('p', { classe: 'aide-question', texte: 'Chargement de l\'historique…' }), boutonRetour(v, info, etatV));
    let rep;
    try {
      rep = await App.appeler('historiqueVehicule', { vehicule: v.id });
    } catch (e) {
      message(panneau, 'Historique indisponible hors ligne.', 'erreur');
      return;
    }
    if (!fond || !document.contains(panneau)) return; // fenêtre fermée entre-temps
    const entrees = rep.ok ? rep.historique : [];
    const liste = el('ul', { classe: 'historique' });
    entrees.forEach((e) => {
      const ligne = el('li', { classe: `entree ${e.type}${e.anomalies && e.anomalies.length ? ' anomalie' : ''}` },
        el('span', { classe: 'entree-titre' }, el('strong', { texte: TYPES[e.type] || e.type }), el('span', { texte: `${date(e.date)} · ${e.agent}` })),
        el('span', { classe: 'entree-resume', texte: resume(e) }));
      if (e.type === 'checklist') {
        ligne.append(el('button', { type: 'button', classe: 'lien', texte: 'Voir le détail', surclick: () => voirCheckList(v, info, etatV, e) }));
      }
      liste.append(ligne);
    });
    fenetre(`${v.nom || v.id} · historique`,
      entrees.length ? liste : el('p', { texte: 'Aucun enregistrement pour ce véhicule.' }),
      boutonRetour(v, info, etatV));
  }

  // silhouette, FACES et afficherPhotoServeur sont aussi utilisés par le tableau de bord du parc (parc.js).
  /** Ouvre directement un écran d'action (menu Véhicules > Carburant, Carrosserie, Suivi mécanique). */
  function ouvrirAction(type, v, info, etatV) {
    const ecrans = { plein: pleins, exterieur, garage };
    if (ecrans[type]) ecrans[type](v, info, etatV);
    else ouvrir(v, info, etatV);
  }

  return { ouvrir, ouvrirAction, proposerChecklist, fermer, silhouette, FACES, afficherPhotoServeur };
})();
