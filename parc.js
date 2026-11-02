/*
 * Tableau de bord du parc, sur ordinateur (menu « Véhicules », écran large).
 *  - à gauche : les cases véhicules empilées (mêmes couleurs et pictogrammes que la check-list) ;
 *  - au centre, par défaut : le tableau de tous les éléments des check-lists du jour, un véhicule
 *    disponible par colonne (comme le Sheet « Check-list journalière véhicules SMUR ») ;
 *  - au clic sur un véhicule : sa fiche en pavés, sans défilement (check-lists, kilométrage, pleins,
 *    garage, carrosserie, nettoyages) ;
 *  - au clic sur un pavé : l'historique détaillé correspondant (action « historiquePlage » du backend).
 */
const Parc = (() => {
  const CLE_HISTO = 'avismur_histo_vehicules';
  const NB = 5;
  let racine;
  let colonne;
  let centre;
  let appeler;
  let choisi = null; // véhicule dont on voit la fiche ; null = tableau d'ensemble
  let panneau = null; // pavé ouvert dans la fiche ; null = pavés
  let histo = null; // historique court du véhicule choisi (pavés) : { id, entrees, date, etat }
  let jetonHisto = 0;
  const memo = new Map(); // historiques détaillés déjà chargés (véhicule|type|période)
  const etatPanneau = {}; // jour affiché, mode du kilométrage… (gardés en changeant de pavé)

  // ---------- Utilitaires ----------
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

  const date = (iso) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
  const jour = (iso) => new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' });
  const jourISO = (d) => new Date(d).toLocaleDateString('fr-CA'); // AAAA-MM-JJ, heure locale
  const debutJour = (j) => new Date(`${j}T00:00:00`);
  const finJour = (j) => new Date(`${j}T23:59:59.999`);
  const decalerJour = (j, n) => { const d = debutJour(j); d.setDate(d.getDate() + n); return jourISO(d); };
  const km = (n) => `${Number(n).toLocaleString('fr-FR')} km`;
  const ilYa = (iso) => {
    const j = Math.floor((debutJour(jourISO(new Date())) - debutJour(jourISO(iso))) / 86400000);
    return j <= 0 ? 'aujourd\'hui' : (j === 1 ? 'hier' : `il y a ${j} jours`);
  };
  const normaliser = (t) => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const vehiculesActifs = () => VEHICULES.filter((v) => !v.inactif);
  const nomDe = (v) => v.nom || v.id;
  const typeDe = (v) => (v.type !== undefined ? v.type : (v.modele === 'F00' ? 'UMH' : v.modele));
  const texte = (t, classe = 'aide-question') => el('p', { classe, texte: t });

  // ---------- Historique court (pavés), gardé sur l'appareil pour le hors ligne ----------
  function lireHistoriques() {
    try { return JSON.parse(localStorage.getItem(CLE_HISTO)) || {}; } catch (e) { return {}; }
  }

  function memoriserHistorique(id, entrees) {
    const compte = {};
    const garde = entrees.filter((e) => {
      compte[e.type] = (compte[e.type] || 0) + 1;
      return compte[e.type] <= NB;
    });
    const tous = lireHistoriques();
    tous[id] = { date: new Date().toISOString(), entrees: garde };
    try { localStorage.setItem(CLE_HISTO, JSON.stringify(tous)); } catch (e) { /* mémoire pleine */ }
  }

  async function chargerHistorique(id) {
    jetonHisto += 1;
    const jeton = jetonHisto;
    const enMemoire = lireHistoriques()[id];
    histo = { id, entrees: enMemoire ? enMemoire.entrees : null, date: enMemoire ? enMemoire.date : null, etat: 'chargement' };
    if (!panneau) rendreCentre();
    try {
      const rep = await appeler('historiqueVehicule', { vehicule: id });
      if (jeton !== jetonHisto) return;
      if (rep.ok && Array.isArray(rep.historique)) {
        histo = { id, entrees: rep.historique, date: new Date().toISOString(), etat: 'ok' };
        memoriserHistorique(id, rep.historique);
      } else histo.etat = 'erreur';
    } catch (e) {
      if (jeton !== jetonHisto) return;
      histo.etat = 'hors-ligne';
    }
    if (!panneau) rendreCentre();
  }

  /** Historique détaillé d'un type entre deux dates (gardé en mémoire le temps de la session). */
  async function plage(type, depuis, jusqua, cle) {
    const vehicule = choisi;
    const k = `${vehicule}|${type}|${cle || `${depuis.toISOString()}|${jusqua.toISOString()}`}`;
    if (memo.has(k)) return memo.get(k);
    let rep;
    try {
      rep = await appeler('historiquePlage', { vehicule, type, depuis: depuis.toISOString(), jusqua: jusqua.toISOString() });
    } catch (e) {
      throw new Error('Historique indisponible hors ligne. Il sera consultable au retour du réseau.');
    }
    if (!rep.ok) {
      throw new Error(rep.erreur === 'Action inconnue'
        ? 'Le serveur n\'est pas encore à jour : copiez Historique.gs (dépôt AVISMUR-backend) dans l\'Apps Script et redéployez.'
        : (rep.erreur || 'Erreur du serveur.'));
    }
    memo.set(k, rep.historique);
    return rep.historique;
  }

  // ---------- Sélection et navigation ----------
  function selectionner(id) {
    if (choisi === id && !panneau) { // second clic sur le véhicule choisi : retour au tableau d'ensemble
      retourEnsemble();
      return;
    }
    if (choisi !== id) {
      memo.clear();
      Object.keys(etatPanneau).forEach((k) => delete etatPanneau[k]);
    }
    choisi = id;
    panneau = null;
    rendreColonne();
    window.scrollTo({ top: 0 });
    chargerHistorique(id);
    centre.focus({ preventScroll: true });
  }

  function retourEnsemble() {
    choisi = null;
    panneau = null;
    histo = null;
    jetonHisto += 1;
    rendre();
  }

  function ouvrirPanneau(cle) {
    panneau = cle;
    window.scrollTo({ top: 0 });
    rendreCentre();
    centre.focus({ preventScroll: true });
  }

  function retourFiche() {
    panneau = null;
    rendreCentre();
  }

  /** Donne au bloc marqué data-hauteur toute la hauteur visible, sans faire défiler la page. */
  function ajusterHauteur() {
    if (!racine || racine.hidden) return;
    const menu = document.getElementById('menu');
    const basMenu = menu && !menu.hidden ? menu.offsetHeight : 0;
    colonne.style.maxHeight = `${Math.max(300, window.innerHeight - basMenu - 24)}px`;
    const cible = centre.querySelector('[data-hauteur]');
    if (!cible) return;
    const haut = cible.getBoundingClientRect().top + window.scrollY;
    cible.style.height = `${Math.max(360, window.innerHeight - basMenu - haut - 16)}px`;
  }

  // ---------- Colonne de gauche ----------
  function rendreColonne() {
    colonne.innerHTML = '';
    vehiculesActifs().forEach((v) => colonne.append(Ambulancier.creerCarte(v, {
      compacte: true, choisi: choisi === v.id, surClic: () => selectionner(v.id),
    })));
  }

  // ---------- Tableau d'ensemble ----------
  function clesIgnorees() {
    const ignorees = new Set();
    Object.values(MODELES).forEach((m) => m.questions.forEach((q) => {
      if (q.type === 'cache' || q.basculeF00) ignorees.add(normaliser(q.libelle));
    }));
    return ignorees;
  }

  function lignesTableau(vehicules) {
    const ignorees = clesIgnorees();
    const vus = new Set();
    const entrees = [];
    vehicules.forEach((v) => {
      const statut = Ambulancier.infosVehicule(v.id).statut;
      Object.keys((statut && statut.reponses) || {}).forEach((cle) => {
        const id = normaliser(cle);
        if (vus.has(id) || ignorees.has(id) || cle.startsWith('Position (')) return;
        vus.add(id);
        const m = /^(.*?)\s*\[(.*)\]$/.exec(cle);
        entrees.push({ id, section: m ? (m[1] || 'Équipement') : '', libelle: m ? m[2] : cle });
      });
    });
    const placees = new Set();
    const lignes = [];
    entrees.forEach((e) => {
      if (!e.section) { lignes.push(e); return; }
      if (placees.has(e.section)) return;
      placees.add(e.section);
      entrees.filter((x) => x.section === e.section).forEach((x) => lignes.push(x));
    });
    return lignes;
  }

  function cellule(libelle, valeur) {
    if (valeur === undefined) return { texte: '—', classe: 'na', titre: 'Non concerné' };
    if (valeur === '' || valeur === null) return { texte: '', classe: 'vide' };
    if (valeur === 'OK' || valeur === 'Fait') return { texte: '✓', classe: 'ok', titre: valeur };
    if (valeur === 'Manquant') return { texte: '✗', classe: 'mauvais', titre: 'Manquant' };
    if (typeof valeur === 'number') {
      if (/kilom/i.test(libelle)) return { texte: Number(valeur).toLocaleString('fr-FR'), classe: '', titre: km(valeur) };
      return { texte: `${valeur}/10`, classe: valeur <= SEUILS_ANOMALIE.obus ? 'mauvais' : '', titre: `${valeur * 20} bars` };
    }
    const t = String(valeur);
    if (/^\d+\/8$/.test(t)) return { texte: t, classe: parseInt(t, 10) <= SEUILS_ANOMALIE.carburant ? 'mauvais' : '', titre: `Carburant ${t}` };
    if (/non concern/i.test(t)) return { texte: '—', classe: 'na', titre: t };
    if (/ad-?blue/i.test(libelle)) return { texte: 'À compléter', classe: 'attention', titre: t };
    return { texte: t.length > 24 ? `${t.slice(0, 22)}…` : t, classe: /remarque/i.test(libelle) ? 'attention' : '', titre: t };
  }

  function enteteVehicule(v, etatV) {
    let position = [];
    if (Ambulancier.estDZ(etatV.position)) position = [Ambulancier.helico(), 'DZ'];
    else if (etatV.position && etatV.position.position) position = [etatV.position.position];
    return el('th', { scope: 'col' }, el('button', {
      type: 'button', classe: `parc-th-bouton ${etatV.classe}`, surclick: () => selectionner(v.id),
      title: `${nomDe(v)} : ${etatV.texte}. Afficher la fiche.`,
    }, el('strong', { texte: nomDe(v) }), el('small', { texte: typeDe(v) || ' ' }),
    el('span', { classe: 'parc-th-position' }, ...position)));
  }

  function rendreTableau() {
    // Les véhicules indisponibles n'ont pas de check-list : ils ne figurent pas dans le tableau.
    const infos = vehiculesActifs()
      .map((v) => ({ v, info: Ambulancier.infosVehicule(v.id), etatV: Ambulancier.etatVehicule(v) }))
      .filter((x) => x.etatV.classe !== 'indispo');
    centre.innerHTML = '';
    if (!infos.length) {
      centre.append(texte('Aucun véhicule disponible.', ''));
      return;
    }
    const vehicules = infos.map((x) => x.v);
    const classeColonne = (x) => (x.info.statut ? '' : ' col-afaire');
    const lignes = lignesTableau(vehicules);
    const colonnes = vehicules.length + 1;

    const corps = el('tbody');
    const ligne = (libelle, cellules, classe = '') => el('tr', { classe },
      el('th', { classe: 'parc-libelle', scope: 'row', texte: libelle }), ...cellules);
    const section = (titre) => el('tr', { classe: 'parc-section' }, el('th', { colspan: String(colonnes), scope: 'colgroup', texte: titre }));

    corps.append(ligne('Anomalies du jour', infos.map((x) => {
      const liste = x.info.statut ? x.info.statut.anomalies : null;
      if (!liste) return el('td', { classe: `vide${classeColonne(x)}` });
      return liste.length
        ? el('td', { classe: `attention${classeColonne(x)}`, title: liste.join('\n'), texte: String(liste.length) })
        : el('td', { classe: `ok${classeColonne(x)}`, texte: '✓', title: 'Aucune anomalie' });
    }), 'parc-synthese'));

    let rubrique = null;
    lignes.forEach((l) => {
      if (l.section !== rubrique) {
        rubrique = l.section;
        corps.append(section(l.section || 'Général'));
      }
      corps.append(ligne(l.libelle, infos.map((x) => {
        const reponses = x.info.statut && x.info.statut.reponses;
        if (!reponses) return el('td', { classe: `vide${classeColonne(x)}` });
        const cle = Object.keys(reponses).find((k) => normaliser(k) === l.id);
        const c = cellule(l.libelle, cle === undefined ? undefined : reponses[cle]);
        return el('td', { classe: `${c.classe}${classeColonne(x)}`, title: c.titre, texte: c.texte });
      })));
    });
    if (!lignes.length) {
      corps.append(el('tr', {}, el('td', { colspan: String(colonnes), classe: 'parc-vide', texte: 'Aucune check-list faite aujourd\'hui pour l\'instant.' })));
    }

    corps.append(section('Suivi'));
    const suivi = (libelle, f) => corps.append(ligne(libelle, infos.map((x) => {
      const c = f(x);
      return el('td', { classe: `${c.classe || ''}${classeColonne(x)}`.trim(), texte: c.texte, title: c.titre });
    })));
    suivi('Dernier kilométrage', (x) => (x.info.releve ? { texte: Number(x.info.releve.km).toLocaleString('fr-FR'), titre: `Relevé du ${date(x.info.releve.date)}` } : { texte: '—', classe: 'na' }));
    suivi('Dernier plein', (x) => (x.v.sansPlein ? { texte: '—', classe: 'na' } : { texte: x.info.dernierPlein ? jour(x.info.dernierPlein.date) : 'jamais', titre: x.info.dernierPlein ? `${date(x.info.dernierPlein.date)} · ${x.info.dernierPlein.agent}` : '' }));
    suivi('Dernier garage', (x) => (x.v.sansGarage ? { texte: '—', classe: 'na' } : { texte: x.info.dernierGarage ? jour(x.info.dernierGarage.date) : 'jamais', titre: x.info.dernierGarage ? `${date(x.info.dernierGarage.date)} · ${x.info.dernierGarage.motif || ''}` : '' }));
    suivi('Nettoyage intérieur', (x) => (x.v.sansNettoyage ? { texte: '—', classe: 'na' } : { texte: x.info.dernierNettoyageInterieur ? jour(x.info.dernierNettoyageInterieur.date) : 'jamais' }));
    suivi('Nettoyage extérieur', (x) => (x.v.sansNettoyage ? { texte: '—', classe: 'na' } : { texte: x.info.dernierNettoyageExterieur ? jour(x.info.dernierNettoyageExterieur.date) : 'jamais' }));
    suivi('Défauts de carrosserie connus', (x) => (x.v.sansExterieur ? { texte: '—', classe: 'na' } : { texte: String(x.info.defauts.length), classe: x.info.defauts.length ? 'attention' : '' }));

    // Colonnes de même largeur : tableau à disposition fixe, colonne des libellés plus large.
    const table = el('table', { classe: 'parc-tableau', style: `min-width:calc(13rem + ${vehicules.length} * 6.2rem)` },
      el('colgroup', {}, el('col', { classe: 'parc-col-libelle' }), ...vehicules.map(() => el('col'))),
      el('thead', {}, el('tr', {}, el('th', { classe: 'parc-libelle', scope: 'col', texte: 'Check-list du jour' }), ...infos.map((x) => enteteVehicule(x.v, x.etatV)))),
      corps);
    const masques = vehiculesActifs().length - infos.length;
    centre.append(
      el('div', { classe: 'parc-tableau-zone', tabindex: '0', role: 'region', 'aria-label': 'Tableau des check-lists du jour', 'data-hauteur': '' }, table),
      texte(`Cliquez sur un véhicule (à gauche ou en tête de colonne) pour voir sa fiche.${masques ? ` Véhicules indisponibles non affichés : ${masques}.` : ''}`, 'aide-question parc-note'));
  }

  // ---------- Fiche : en-tête ----------
  function entete(v, etatV, info, sousTitre) {
    const resumeEtat = [etatV.texte, etatV.classe !== 'indispo' && etatV.position && etatV.position.position ? `position du jour : ${etatV.position.position}` : ''].filter(Boolean).join(' · ');
    return el('div', { classe: 'parc-entete' },
      el('div', { classe: 'parc-entete-titre' },
        el('h2', { classe: 'parc-titre' }, nomDe(v), el('small', { texte: sousTitre || typeDe(v) })),
        el('span', { classe: `parc-etat ${etatV.classe}`, texte: resumeEtat })),
      el('div', { classe: 'parc-boutons' },
        panneau ? el('button', { type: 'button', classe: 'cfg-bouton', texte: `← Fiche ${nomDe(v)}`, surclick: retourFiche }) : null,
        el('button', { type: 'button', classe: 'cfg-bouton', texte: '← Vue d\'ensemble', surclick: retourEnsemble }),
        el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Actions…', 'aria-haspopup': 'dialog', surclick: () => Actions.ouvrir(v, info, etatV) })));
  }

  function avecRecent(liste, candidat) {
    if (candidat && (!liste.length || new Date(candidat.date) - new Date(liste[0].date) > 60000)) return [candidat, ...liste];
    return liste;
  }

  // ---------- Fiche : pavés ----------
  function tuile(cle, icone, titre, ...contenu) {
    return el('button', { type: 'button', classe: `tuile tuile-${cle}`, surclick: () => ouvrirPanneau(cle) },
      el('span', { classe: 'tuile-titre' }, el('span', { 'aria-hidden': 'true', texte: icone }), el('strong', { texte: titre })),
      el('span', { classe: 'tuile-corps' }, ...contenu),
      el('span', { classe: 'tuile-lien', texte: 'Historique →' }));
  }
  const grand = (t, classe = '') => el('span', { classe: `tuile-grand ${classe}`.trim(), texte: t });
  const petit = (t, classe = '') => el('span', { classe: `tuile-petit ${classe}`.trim(), texte: t });

  function rendreFiche() {
    const v = vehiculesActifs().find((x) => x.id === choisi);
    if (!v) { retourEnsemble(); return; }
    const info = Ambulancier.infosVehicule(v.id);
    const etatV = Ambulancier.etatVehicule(v);
    const entrees = (histo && histo.entrees) || [];
    const verifs = avecRecent(entrees.filter((e) => e.type === 'checklist'), info.derniereCL).slice(0, NB);
    const pleins = avecRecent(entrees.filter((e) => e.type === 'plein'),
      info.dernierPlein ? { date: info.dernierPlein.date, agent: info.dernierPlein.agent, detail: info.dernierPlein } : null);
    const garages = avecRecent(entrees.filter((e) => e.type === 'garage'),
      info.dernierGarage ? { date: info.dernierGarage.date, agent: info.dernierGarage.agent, detail: info.dernierGarage } : null);

    // Check-lists : les 5 dernières en pastilles
    const derniere = verifs[0];
    const tVerifs = tuile('checklist', '📋', 'Check-lists',
      derniere ? grand(info.statut ? 'Faite aujourd\'hui' : ilYa(derniere.date), info.statut ? '' : 'attenue') : grand('Aucune', 'attenue'),
      derniere ? petit(`${date(derniere.date)} · ${derniere.agent || ''}`) : null,
      el('span', { classe: 'tuile-pastilles' }, ...verifs.map((cl) => el('span', {
        classe: `tuile-pastille ${(cl.anomalies || []).length ? 'anomalie' : 'fait'}`,
        title: `${date(cl.date)} · ${(cl.anomalies || []).length} anomalie(s)`, texte: jour(cl.date).slice(0, 5),
      }))),
      derniere && (derniere.anomalies || []).length ? petit(`${derniere.anomalies.length} anomalie(s) : ${derniere.anomalies.slice(0, 2).join(' ; ')}${derniere.anomalies.length > 2 ? '…' : ''}`, 'alerte') : null);

    // Kilométrage : dernier relevé et moyenne récente
    const pointsKm = verifs.concat(pleins).map((e) => ({ date: e.date, km: Number((e.reponses && e.reponses.Kilométrage) || (e.detail && e.detail.km)) }))
      .filter((p) => p.km > 0).sort((a, b) => (a.date < b.date ? -1 : 1));
    let moyenne = null;
    if (pointsKm.length > 1) {
      const a = pointsKm[0];
      const b = pointsKm[pointsKm.length - 1];
      const jours = Math.max(1, (new Date(b.date) - new Date(a.date)) / 86400000);
      if (b.km > a.km) moyenne = Math.round((b.km - a.km) / jours);
    }
    const releve = info.releve || pointsKm[pointsKm.length - 1] || null;
    const tKm = tuile('km', '⏱', 'Kilométrage',
      releve ? grand(km(releve.km)) : grand('Inconnu', 'attenue'),
      releve ? petit(`relevé ${ilYa(releve.date)}`) : null,
      moyenne !== null ? petit(`≈ ${moyenne.toLocaleString('fr-FR')} km par jour récemment`) : null);

    // Pleins : jauge actuelle et dernier plein
    const carb = Ambulancier.carburantActuel(info);
    const bas = carb && carb.valeur <= SEUILS_ANOMALIE.plein;
    const tPleins = v.sansPlein ? null : tuile('plein', '⛽', 'Pleins',
      carb ? el('span', { classe: 'tuile-jauge' }, Ambulancier.cadran(carb.valeur, bas), grand(`${carb.valeur}/8`, bas ? 'alerte' : '')) : grand('Jauge inconnue', 'attenue'),
      pleins[0] ? petit(`Dernier plein ${ilYa(pleins[0].date)} (${jour(pleins[0].date)})`) : petit('Aucun plein enregistré'),
      pleins[0] && pleins[0].detail && pleins[0].detail.km ? petit(`à ${km(pleins[0].detail.km)}`) : null);

    // Garage
    const tGarage = v.sansGarage ? null : tuile('garage', '🔧', 'Garage',
      garages[0] ? grand(ilYa(garages[0].date)) : grand('Aucun passage', 'attenue'),
      garages[0] ? petit(`${jour(garages[0].date)} · ${(garages[0].detail && garages[0].detail.motif) || ''}`) : null,
      garages[1] ? petit(`Précédent : ${jour(garages[1].date)} · ${(garages[1].detail && garages[1].detail.motif) || ''}`) : null);

    // Carrosserie : côtés gauche et droit en miniature
    const tCarrosserie = v.sansExterieur ? null : tuile('carrosserie', '🚐', 'Carrosserie',
      el('span', { classe: 'tuile-faces' }, ...['gauche', 'droite'].map((face) => {
        const schema = el('span', { classe: 'schema schema-cote parc-schema' }, Actions.silhouette(face, v));
        info.defauts.filter((d) => d.face === face).forEach((d, i) => schema.append(el('span', {
          classe: 'repere connu', style: `left:${d.x * 100}%;top:${d.y * 100}%`, texte: String(i + 1),
        })));
        return schema;
      })),
      petit(info.defauts.length ? `${info.defauts.length} défaut(s) connu(s)` : 'Aucun défaut connu', info.defauts.length ? 'alerte' : ''),
      info.derniereVerifExterieure ? petit(`Vérifiée ${ilYa(info.derniereVerifExterieure.date)}`) : petit('Jamais vérifiée'));

    // Nettoyages
    const ligneNettoyage = (libelle, n) => el('span', { classe: 'tuile-ligne' }, el('strong', { texte: libelle }),
      el('span', { classe: n ? '' : 'attenue', texte: n ? `${ilYa(n.date)} (${jour(n.date)})` : 'jamais' }));
    const tNettoyage = v.sansNettoyage ? null : tuile('nettoyage', '🧽', 'Nettoyages',
      ligneNettoyage('Intérieur', info.dernierNettoyageInterieur),
      ligneNettoyage('Extérieur', info.dernierNettoyageExterieur));

    centre.innerHTML = '';
    centre.append(entete(v, etatV, info));
    const avis = avisHistorique();
    if (avis) centre.append(el('p', { classe: 'avis-parc', role: 'status', texte: avis }));
    centre.append(el('div', { classe: 'parc-tuiles', 'data-hauteur': '' }, tVerifs, tKm, tPleins, tGarage, tCarrosserie, tNettoyage));
  }

  function avisHistorique() {
    if (!histo) return null;
    if (histo.etat === 'hors-ligne' || histo.etat === 'erreur') {
      return histo.entrees ? `Hors ligne : données de l'appareil du ${date(histo.date)}.` : 'Hors ligne : seuls les derniers éléments connus de cet appareil sont affichés.';
    }
    return null;
  }

  // ---------- Panneaux d'historique ----------
  const TITRES = {
    checklist: 'Historique des check-lists', km: 'Historique des kilomètres', plein: 'Historique des pleins',
    garage: 'Historique des entretiens au garage', carrosserie: 'Carrosserie', nettoyage: 'Historique des nettoyages',
  };

  function rendrePanneau() {
    const v = vehiculesActifs().find((x) => x.id === choisi);
    if (!v) { retourEnsemble(); return; }
    const info = Ambulancier.infosVehicule(v.id);
    const etatV = Ambulancier.etatVehicule(v);
    const corps = el('div', { classe: 'parc-panneau-corps', 'data-hauteur': '' });
    centre.innerHTML = '';
    centre.append(entete(v, etatV, info, TITRES[panneau]), corps);
    if (panneau === 'checklist') panneauChecklists(corps);
    else if (panneau === 'km') panneauKm(corps);
    else if (panneau === 'carrosserie') panneauCarrosserie(v, info, corps);
    else panneauListe(corps, panneau);
  }

  /** Affiche « Chargement… », puis le résultat de `charger()` ou son erreur, si la zone est toujours affichée. */
  async function remplir(zone, charger, afficher) {
    zone.replaceChildren(texte('Chargement…'));
    try {
      const donnees = await charger();
      if (document.contains(zone)) zone.replaceChildren(...[].concat(afficher(donnees)));
    } catch (e) {
      if (document.contains(zone)) zone.replaceChildren(texte(e.message, 'avis-parc'));
    }
  }

  function champDate(libelle, valeur, surChange) {
    const idChamp = `pd${Math.random().toString(36).slice(2, 8)}`;
    return el('span', { classe: 'parc-champ-date' }, el('label', { for: idChamp, texte: libelle }),
      el('input', { type: 'date', id: idChamp, valeur, max: jourISO(new Date()), surchange: (e) => surChange(e.target.value) }));
  }

  // Check-lists : jour par jour, ou recherche entre deux dates
  function listeVerifs(liste, ouvrirPremiere) {
    const ul = el('ul', { classe: 'parc-verifs' });
    liste.forEach((cl, i) => {
      const r = cl.reponses || {};
      const anomalies = cl.anomalies || [];
      const details = el('div', { classe: 'reponses' });
      Object.entries(r).forEach(([cle, valeur]) => {
        if (valeur === '' || valeur === null || cle.startsWith('Position (')) return;
        details.append(el('div', { classe: `reponse${valeur === 'Manquant' ? ' manquant' : ''}` }, el('dt', { texte: cle }),
          el('dd', { texte: typeof valeur === 'number' && /obus|bouteille/i.test(cle) ? `${valeur}/10` : String(valeur) })));
      });
      ul.append(el('li', {}, el('details', { open: ouvrirPremiere && i === 0 },
        el('summary', {},
          el('span', { classe: `pastille-etat ${anomalies.length ? 'anomalie' : 'fait'}`, 'aria-hidden': 'true' }),
          el('strong', { texte: date(cl.date) }), el('span', { texte: cl.agent || '' }),
          el('span', { classe: 'parc-resume', texte: [r.Kilométrage ? km(r.Kilométrage) : '', r.Carburant ? `carburant ${r.Carburant}` : ''].filter(Boolean).join(' · ') }),
          el('span', { classe: anomalies.length ? 'parc-badge attention' : 'parc-badge ok', texte: anomalies.length ? `${anomalies.length} anomalie(s)` : 'sans anomalie' })),
        anomalies.length ? el('div', { classe: 'note-parc anomalie' }, el('ul', {}, ...anomalies.map((a) => el('li', { texte: a })))) : null,
        el('dl', { classe: 'reponses' }, ...details.children))));
    });
    return ul;
  }

  function panneauChecklists(corps) {
    const aujourdhui = jourISO(new Date());
    etatPanneau.jour = etatPanneau.jour || aujourdhui;
    const zone = el('div', { classe: 'parc-resultats' });

    async function montrerJour(j) {
      if (!j) return;
      etatPanneau.jour = j;
      etatPanneau.recherche = null;
      choix.querySelector('input').value = j;
      const mois = j.slice(0, 7);
      const debut = debutJour(`${mois}-01`);
      const fin = new Date(debut.getFullYear(), debut.getMonth() + 1, 1);
      fin.setMilliseconds(-1);
      remplir(zone, () => plage('checklist', debut, fin, mois), (entrees) => {
        const duJour = entrees.filter((e) => jourISO(e.date) === j);
        // Jours du mois qui ont une check-list : accès direct.
        const jours = [...new Set(entrees.map((e) => jourISO(e.date)))].sort();
        return [
          el('h3', { texte: debutJour(j).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) }),
          duJour.length ? listeVerifs(duJour, true) : texte('Aucune check-list ce jour-là.'),
          el('div', { classe: 'parc-jours' }, el('span', { classe: 'aide-question', texte: `Check-lists en ${debut.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })} :` }),
            ...(jours.length ? jours.map((x) => {
              const anomalie = entrees.some((e) => jourISO(e.date) === x && (e.anomalies || []).length);
              return el('button', { type: 'button', classe: `parc-jour ${anomalie ? 'anomalie' : 'fait'}${x === j ? ' actif' : ''}`, texte: x.slice(8), title: x.split('-').reverse().join('/'), surclick: () => montrerJour(x) });
            }) : [texte('aucune.')])),
        ];
      });
    }

    function rechercher() {
      const { du, au } = etatPanneau;
      if (!du || !au || du > au) {
        zone.replaceChildren(texte('Choisissez une date de début et une date de fin.', 'avis-parc'));
        return;
      }
      etatPanneau.recherche = true;
      remplir(zone, () => plage('checklist', debutJour(du), finJour(au)), (entrees) => [
        el('h3', { texte: `Du ${du.split('-').reverse().join('/')} au ${au.split('-').reverse().join('/')} : ${entrees.length} check-list(s)` }),
        entrees.length ? listeVerifs(entrees, false) : texte('Aucune check-list sur cette période.'),
      ]);
    }

    const choix = champDate('Jour', etatPanneau.jour, montrerJour);
    etatPanneau.du = etatPanneau.du || decalerJour(aujourdhui, -30);
    etatPanneau.au = etatPanneau.au || aujourdhui;
    corps.append(
      el('div', { classe: 'parc-barre' },
        el('div', { classe: 'parc-groupe' },
          el('button', { type: 'button', classe: 'cfg-mini', texte: '‹ Jour précédent', surclick: () => montrerJour(decalerJour(etatPanneau.jour, -1)) }),
          choix,
          el('button', { type: 'button', classe: 'cfg-mini', texte: 'Jour suivant ›', surclick: () => { if (etatPanneau.jour < aujourdhui) montrerJour(decalerJour(etatPanneau.jour, 1)); } }),
          el('button', { type: 'button', classe: 'cfg-mini', texte: 'Aujourd\'hui', surclick: () => montrerJour(aujourdhui) })),
        el('div', { classe: 'parc-groupe' },
          champDate('Du', etatPanneau.du, (x) => { etatPanneau.du = x; }),
          champDate('au', etatPanneau.au, (x) => { etatPanneau.au = x; }),
          el('button', { type: 'button', classe: 'cfg-mini', texte: 'Rechercher', surclick: rechercher }))),
      zone);
    if (etatPanneau.recherche) rechercher();
    else montrerJour(etatPanneau.jour);
  }

  // Kilomètres : par jour, par mois, par année
  function agreger(points, cle) {
    const periodes = new Map();
    points.forEach((p) => {
      const k = cle(new Date(p.date));
      const x = periodes.get(k);
      if (!x) periodes.set(k, { cle: k, max: p.km, min: p.km });
      else { x.max = Math.max(x.max, p.km); x.min = Math.min(x.min, p.km); }
    });
    const liste = [...periodes.values()];
    liste.forEach((x, i) => { x.parcourus = i ? Math.max(0, x.max - liste[i - 1].max) : x.max - x.min; });
    return liste.reverse();
  }

  function panneauKm(corps) {
    etatPanneau.modeKm = etatPanneau.modeKm || 'jour';
    const zone = el('div', { classe: 'parc-resultats' });
    const MODES = {
      jour: { libelle: 'Par jour', cle: (d) => jourISO(d), nom: (k) => debutJour(k).toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }), max: 90 },
      mois: { libelle: 'Par mois', cle: (d) => jourISO(d).slice(0, 7), nom: (k) => debutJour(`${k}-01`).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }), max: 120 },
      annee: { libelle: 'Par année', cle: (d) => String(d.getFullYear()), nom: (k) => k, max: 50 },
    };
    const onglets = el('div', { classe: 'puces faces', role: 'tablist' });

    function afficher() {
      onglets.replaceChildren(...Object.entries(MODES).map(([m, def]) => el('button', {
        type: 'button', role: 'tab', classe: `face${m === etatPanneau.modeKm ? ' active' : ''}`, 'aria-selected': String(m === etatPanneau.modeKm),
        texte: def.libelle, surclick: () => { etatPanneau.modeKm = m; afficher(); },
      })));
      const mode = MODES[etatPanneau.modeKm];
      remplir(zone, () => plage('km', new Date(2000, 0, 1), new Date(), 'tout'), (brut) => {
        const points = brut.map((p) => ({ date: p.date, km: Number(p.km) })).filter((p) => p.km > 0).sort((a, b) => (a.date < b.date ? -1 : 1));
        if (!points.length) return texte('Aucun kilométrage enregistré pour ce véhicule.');
        const periodes = agreger(points, mode.cle).slice(0, mode.max);
        const plusGrand = Math.max(1, ...periodes.map((p) => p.parcourus));
        const dernier = points[points.length - 1];
        const il30 = points.filter((p) => new Date(p.date) >= new Date(Date.now() - 30 * 86400000));
        const sur30 = il30.length ? dernier.km - Math.min(...il30.map((p) => p.km)) : 0;
        return [
          el('p', { classe: 'parc-synthese-km' }, el('strong', { texte: km(dernier.km) }), ` au ${date(dernier.date)} · ${km(sur30)} sur les 30 derniers jours`),
          el('table', { classe: 'parc-km' },
            el('thead', {}, el('tr', {}, el('th', { scope: 'col', texte: 'Période' }), el('th', { scope: 'col', texte: 'Compteur' }), el('th', { scope: 'col', texte: 'Parcourus' }))),
            el('tbody', {}, ...periodes.map((p) => el('tr', {},
              el('th', { scope: 'row', texte: mode.nom(p.cle) }),
              el('td', { texte: p.max.toLocaleString('fr-FR') }),
              el('td', {}, el('span', { classe: 'parc-barre-km', style: `--part:${p.parcourus / plusGrand}` }),
                el('span', { texte: p.parcourus.toLocaleString('fr-FR') })))))),
          periodes.length >= mode.max ? texte(`Seules les ${mode.max} dernières périodes sont affichées.`) : null,
        ].filter(Boolean);
      });
    }
    corps.append(el('div', { classe: 'parc-barre' }, onglets), zone);
    afficher();
  }

  // Pleins, garage, nettoyages, vérifications extérieures : liste entre deux dates
  function resumeEvenement(type, d) {
    if (type === 'plein') return [d.km ? km(d.km) : '', d.carburant !== undefined && d.carburant !== '' ? `carburant ${d.carburant}/8` : '', d.adblue ? 'AdBlue complété' : '', d.commentaire].filter(Boolean).join(' · ');
    if (type === 'garage') return [d.motif, d.commentaire].filter(Boolean).join(' · ');
    if (type === 'nettoyage') return [d.interieur && d.exterieur ? 'Intérieur et extérieur' : (d.interieur ? 'Intérieur' : 'Extérieur'), d.commentaire].filter(Boolean).join(' · ');
    if (type === 'exterieur') return [`${(d.defauts || []).length} nouveau(x) défaut(s)`, (d.repares || []).length ? `${d.repares.length} réparé(s)` : '', d.commentaire].filter(Boolean).join(' · ');
    return '';
  }
  const ICONES = { plein: '⛽', garage: '🔧', nettoyage: '🧽', exterieur: '🚐' };

  function panneauListe(corps, type, conteneur = corps) {
    const cleEtat = `liste-${type}`;
    const aujourdhui = jourISO(new Date());
    const e = etatPanneau[cleEtat] || (etatPanneau[cleEtat] = { du: decalerJour(aujourdhui, -365), au: aujourdhui, zone: 'tout' });
    const zone = el('div', { classe: 'parc-resultats' });

    function charger() {
      if (!e.du || !e.au || e.du > e.au) {
        zone.replaceChildren(texte('Choisissez une date de début et une date de fin.', 'avis-parc'));
        return;
      }
      remplir(zone, () => plage(type, debutJour(e.du), finJour(e.au)), (entrees) => {
        const liste = type === 'nettoyage' && e.zone !== 'tout' ? entrees.filter((x) => x.detail && x.detail[e.zone]) : entrees;
        if (!liste.length) return texte('Aucun enregistrement sur cette période.');
        return [texte(`${liste.length} enregistrement(s).`),
          el('ul', { classe: 'historique' }, ...liste.map((x) => {
            const d = x.detail || {};
            const photo = el('div', { classe: 'photo-defaut' });
            return el('li', { classe: 'entree' },
              el('span', { classe: 'entree-titre' }, el('strong', { texte: `${ICONES[type] || ''} ${date(x.date)}` }), el('span', { texte: x.agent || '' })),
              el('span', { classe: 'entree-resume', texte: resumeEvenement(type, d) }),
              type === 'plein' && d.photo ? el('button', { type: 'button', classe: 'lien', texte: 'Voir le ticket', surclick: () => Actions.afficherPhotoServeur(photo, d.photo) }) : null,
              photo);
          }))];
      });
    }

    conteneur.append(el('div', { classe: 'parc-barre' },
      el('div', { classe: 'parc-groupe' },
        champDate('Du', e.du, (x) => { e.du = x; charger(); }),
        champDate('au', e.au, (x) => { e.au = x; charger(); }),
        type === 'nettoyage' ? el('select', { 'aria-label': 'Type de nettoyage', surchange: (ev) => { e.zone = ev.target.value; charger(); } },
          ...[['tout', 'Intérieur et extérieur'], ['interieur', 'Intérieur seulement'], ['exterieur', 'Extérieur seulement']]
            .map(([val, lib]) => el('option', { value: val, selected: val === e.zone, texte: lib }))) : null)), zone);
    charger();
  }

  // Carrosserie : cartographie des défauts connus + vérifications extérieures passées
  function panneauCarrosserie(v, info, corps) {
    const grille = el('div', { classe: 'parc-faces' });
    Object.entries(Actions.FACES).forEach(([face, libelle]) => {
      const defauts = info.defauts.filter((d) => d.face === face);
      const schema = el('div', { classe: `schema schema-${face === 'gauche' || face === 'droite' ? 'cote' : 'face'} parc-schema` }, Actions.silhouette(face, v));
      defauts.forEach((d, i) => schema.append(el('span', {
        classe: 'repere connu', style: `left:${d.x * 100}%;top:${d.y * 100}%`, title: d.commentaire || 'Sans description', texte: String(i + 1),
      })));
      const liste = el('ol', { classe: 'parc-defauts' });
      defauts.forEach((d) => {
        const photo = el('div', { classe: 'photo-defaut' });
        const item = el('li', {}, el('span', { texte: `${d.commentaire || 'Sans description'} — ${jour(d.date)}${d.agent ? `, ${d.agent}` : ''}` }));
        if (d.photoLocale) photo.append(el('img', { classe: 'photo-apercu', alt: 'Photo du défaut', src: d.photoLocale }));
        else if (d.photo) item.append(' ', el('button', { type: 'button', classe: 'lien', texte: 'Voir la photo', surclick: () => Actions.afficherPhotoServeur(photo, d.photo) }));
        item.append(photo);
        liste.append(item);
      });
      grille.append(el('figure', { classe: 'parc-face' }, el('figcaption', { texte: defauts.length ? `${libelle} (${defauts.length})` : libelle }), schema,
        defauts.length ? liste : texte('Rien à signaler.')));
    });
    corps.append(el('h3', { texte: 'Défauts connus (non réparés)' }), grille, el('h3', { texte: 'Vérifications extérieures' }));
    panneauListe(corps, 'exterieur');
  }

  // ---------- Affichage ----------
  function rendreCentre() {
    if (!racine || racine.hidden) return;
    if (!choisi) rendreTableau();
    else if (panneau) rendrePanneau();
    else rendreFiche();
    ajusterHauteur();
  }

  function rendre() {
    if (!racine || racine.hidden) return;
    rendreColonne();
    // Un historique ouvert n'est pas redessiné (il garderait sa position et ses filtres).
    if (!panneau) rendreCentre();
    else ajusterHauteur();
  }

  function afficher() {
    racine.hidden = false;
    rendreColonne();
    rendreCentre();
    if (choisi) chargerHistorique(choisi);
  }

  function masquer() {
    if (racine) racine.hidden = true;
  }

  function initialiser(options) {
    appeler = options.appeler;
    racine = document.getElementById('vue-parc');
    colonne = document.getElementById('parc-liste');
    centre = document.getElementById('parc-centre');
    document.addEventListener('parc-maj', rendre);
    window.addEventListener('resize', ajusterHauteur);
  }

  return { initialiser, afficher, masquer };
})();
