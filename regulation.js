/**
 * Fiche régulation (menu > Véhicules > Fiche régulation ; backend : FicheRegulation.gs).
 * Le matin, l'ambulancier de 6 h signale à la régulation l'état du parc et les personnels présents
 * sur 24 h (bips). La fiche reste le Sheet « Etat du parc automobile ET affectation des bips » :
 * l'appli le remplit puis l'envoie en PDF par mail, comme la case « Cochez la case pour envoyer ».
 *
 * Pré-remplie avec la dernière fiche envoyée. Hors ligne : dernière fiche reçue gardée sur l'appareil,
 * et l'envoi part dans la file d'attente (une fiche arrivée un autre jour n'est pas envoyée).
 */
const Regulation = (() => {
  let zone;
  let App = {};
  let donnees = null; // réponse de lireFicheRegulation
  let saisie = null; // { vehicules: {id: {disponible, position, commentaire}}, bips: {id: {nom, horaires}} }
  let erreur = '';
  let message = { texte: '', classe: '' };
  const CLE = 'avismur_fiche_regulation';
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
      if (premiere || !saisie) initialiserSaisie();
    } catch (e) {
      erreur = donnees ? 'Hors ligne : dernière fiche connue.' : 'Hors ligne et aucune fiche gardée sur cet appareil.';
    }
    rendre();
  }

  function positionsPour(v) {
    const l = donnees.listes || {};
    if (v.type === 'VML') return l.positionsVML || [];
    if (v.type === 'UMH') return l.positionsUMH || [];
    return [];
  }

  function ligneVehicule(v) {
    const s = saisie.vehicules[v.id] || (saisie.vehicules[v.id] = { disponible: 'OUI', position: '', commentaire: '' });
    const positions = positionsPour(v);
    const bascule = (valeur) => el('button', {
      type: 'button', classe: `reg-dispo ${s.disponible === valeur ? 'actif' : ''} ${valeur === 'NON' ? 'non' : 'oui'}`,
      'aria-pressed': String(s.disponible === valeur), texte: valeur === 'OUI' ? 'Disponible' : 'Indisponible',
      surclick: () => {
        s.disponible = valeur;
        if (valeur === 'NON' && positions.includes('HS')) s.position = 'HS';
        if (valeur === 'OUI' && s.position === 'HS') s.position = '';
        garderBrouillon();
        rendre();
      },
    });
    // Armé : tout le matériel de prise en charge médicale à bord ; désarmé : véhicule vidé.
    // Indépendant de la disponibilité (armé et indisponible : contrôle au garage ; disponible et désarmé : VL en DSM).
    if (v.type !== 'AUTRE' && !s.armement) s.armement = 'ARMÉ';
    const armement = (valeur) => el('button', {
      type: 'button', classe: `reg-dispo ${s.armement === valeur ? 'actif' : ''} ${valeur === 'DÉSARMÉ' ? 'desarme' : 'arme'}`,
      'aria-pressed': String(s.armement === valeur), texte: valeur === 'ARMÉ' ? 'Armé' : 'Désarmé',
      surclick: () => { s.armement = valeur; garderBrouillon(); rendre(); },
    });
    const choixPosition = positions.length ? el('select', {
      classe: 'reg-position', 'aria-label': `Position de ${v.id}`,
      surchange: (e) => { s.position = e.target.value; garderBrouillon(); },
    }, el('option', { valeur: '', texte: '— position —' }),
    [...new Set([...positions, s.position].filter(Boolean))].map((p) => el('option', { valeur: p, texte: p, selected: p === s.position }))) : null;
    return el('div', { classe: `reg-vehicule ${s.disponible === 'NON' ? 'indispo' : ''}` },
      App.vignette ? App.vignette(v.id, 'reg-vignette') : null,
      el('div', { classe: 'reg-vehicule-nom' }, el('strong', { texte: v.id.length <= 4 ? v.id : v.libelle }),
        v.id.length <= 4 ? el('small', { texte: v.libelle.replace(/^(VML|UMH)\s*F\s*\d+\s*/i, '') }) : null),
      el('div', { classe: 'reg-dispos' }, bascule('OUI'), bascule('NON')),
      v.type === 'AUTRE' ? null : el('div', { classe: 'reg-dispos', role: 'group', 'aria-label': `Armement de ${v.id}` }, armement('ARMÉ'), armement('DÉSARMÉ')),
      choixPosition,
      el('input', {
        type: 'text', classe: 'reg-commentaire', placeholder: 'Commentaire', valeur: s.commentaire || '', maxlength: '200',
        'aria-label': `Commentaire ${v.id}`, surinput: (e) => { s.commentaire = e.target.value; garderBrouillon(); },
      }));
  }

  function ligneBip(b) {
    const s = saisie.bips[b.id] || (saisie.bips[b.id] = { nom: '', horaires: '' });
    const liste = (donnees.listes || {})[b.categorie] || [];
    const idListe = `reg-liste-${b.categorie}`;
    return el('div', { classe: 'reg-bip' },
      el('div', { classe: 'reg-bip-affectation' }, el('strong', { texte: b.affectation.replace(/^[\d.\s]+-\s*/, '') }),
        el('small', { texte: (/^([\d.]{14})/.exec(b.affectation) || [])[1] || '' })),
      el('input', {
        type: 'text', classe: 'reg-nom', placeholder: 'Nom', valeur: s.nom || '', list: liste.length ? idListe : null, autocomplete: 'off',
        'aria-label': `Nom ${b.affectation}`, surinput: (e) => { s.nom = e.target.value; garderBrouillon(); },
      }),
      el('input', {
        type: 'text', classe: 'reg-horaires', placeholder: 'Horaires', valeur: s.horaires || '',
        'aria-label': `Horaires ${b.affectation}`, surinput: (e) => { s.horaires = e.target.value; garderBrouillon(); },
      }),
      el('button', {
        type: 'button', classe: 'reg-vider', 'aria-label': `Vider ${b.affectation}`, texte: '✕',
        surclick: () => { s.nom = ''; s.horaires = ''; garderBrouillon(); rendre(); },
      }),
      b.note ? el('p', { classe: 'reg-note', texte: b.note }) : null);
  }

  /** Nuit : prise de poste entre 17 h et 5 h (« 18h00 -----> 6h00 »). Interne et étudiants : jour. */
  function periodeBip(b) {
    if (!/^(ade|iade)$/.test(b.categorie)) return 'jour';
    const horaires = ((saisie.bips[b.id] || {}).horaires || b.horaires || '');
    const m = /(\d{1,2})\s*h/i.exec(horaires);
    if (!m) return 'jour';
    const h = Number(m[1]);
    return h >= 17 || h < 5 ? 'nuit' : 'jour';
  }

  function envoyer() {
    const vehicules = donnees.vehicules.map((v) => ({ id: v.id, ...saisie.vehicules[v.id] }));
    const sansPosition = donnees.vehicules.filter((v) => positionsPour(v).length && !saisie.vehicules[v.id].position).map((v) => v.id);
    if (sansPosition.length) {
      message = { texte: `Position à choisir : ${sansPosition.join(', ')}.`, classe: 'erreur' };
      rendre();
      return;
    }
    const bips = donnees.bips.map((b) => ({ id: b.id, affectation: b.affectation, ...saisie.bips[b.id] }));
    const ok = App.mettreEnFile({ action: 'envoyerFicheRegulation', donnees: { vehicules, bips } });
    if (!ok) return;
    message = {
      texte: navigator.onLine ? 'Fiche envoyée à la régulation (PDF par mail).' : 'Hors ligne : la fiche partira au retour du réseau.',
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
    if (message.texte) zone.append(el('p', { classe: `message ${message.classe}`, role: 'status', texte: message.texte }));
    if (erreur) zone.append(el('p', { classe: `message ${donnees ? 'info' : 'erreur'}`, role: 'status', texte: erreur }));
    if (!donnees) {
      if (!erreur) zone.append(el('p', { classe: 'message', texte: 'Chargement…' }));
      return;
    }
    const enAttente = App.fileAttente().some((e) => e.action === 'envoyerFicheRegulation');
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

    // Personnel : jour puis nuit ; dans chacun, ambulanciers, IADE, puis interne et étudiants.
    const blocPersonnel = el('section', { classe: 'reg-bloc' }, el('h2', { texte: 'Personnel et bips' }));
    const famille = (b) => (b.categorie === 'ade' ? 'Ambulanciers' : b.categorie === 'iade' ? 'IADE' : 'Interne et étudiants');
    [['jour', 'Jour'], ['nuit', 'Nuit']].forEach(([periode, titre]) => {
      const bs = donnees.bips.filter((b) => periodeBip(b) === periode);
      if (!bs.length) return;
      const sous = el('div', { classe: `reg-periode reg-${periode}` }, el('h3', { texte: titre }));
      ['Ambulanciers', 'IADE', 'Interne et étudiants'].forEach((f) => {
        const lignes = bs.filter((b) => famille(b) === f);
        if (lignes.length) sous.append(el('h4', { texte: f }), el('div', { classe: 'reg-liste' }, lignes.map(ligneBip)));
      });
      blocPersonnel.append(sous);
    });
    zone.append(blocPersonnel);
    Object.entries(donnees.listes || {}).forEach(([cat, noms]) => {
      if (!/^positions/.test(cat) && noms.length) zone.append(el('datalist', { id: `reg-liste-${cat}` }, noms.map((n) => el('option', { valeur: n }))));
    });
    zone.append(el('div', { classe: 'reg-actions' },
      el('button', { type: 'button', classe: 'principal', texte: 'Envoyer à la régulation', surclick: envoyer }),
      el('button', {
        type: 'button', classe: 'cfg-bouton', texte: 'Reprendre la dernière fiche envoyée',
        surclick: () => { localStorage.removeItem(CLE_BROUILLON); initialiserSaisie(); message = { texte: '', classe: '' }; rendre(); },
      })));
  }

  return {
    initialiser(app) {
      App = app;
      zone = document.getElementById('zone-regulation');
    },
    ouvrir() {
      zone.hidden = false;
      message = { texte: '', classe: '' };
      if (!donnees) {
        donnees = lireStockage(CLE);
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
  };
})();
