/**
 * Annuaire du personnel (menu > Annuaire du personnel ; backend : Annuaire.gs).
 * Agents du SMUR (DB_SMUR) et étudiants IADE en stage. Le numéro n'apparaît que si son titulaire
 * l'a accepté dans « Mon profil » (case « Visible des autres utilisateurs »).
 * Toucher un numéro : appeler ou envoyer un SMS.
 *
 * Hors ligne : dernière liste reçue, gardée sur l'appareil (effacée à la déconnexion).
 */
const Annuaire = (() => {
  let zone;
  let App = {};
  let donnees = null; // { agents, groupes, le }
  let erreur = '';
  let chargementEnCours = false;
  let recherche = '';
  let groupe = '';
  let avecNumero = false;
  const CLE = 'avismur_annuaire';

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
  const sansAccent = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const telFr = (t) => String(t || '').replace(/^\+33/, '0').replace(/(\d{2})(?=\d)/g, '$1 ');
  const initiales = (nom) => String(nom || '').split(/[\s-]+/).filter(Boolean).slice(0, 2).map((m) => m[0]).join('').toUpperCase();

  const ICONE_TEL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/></svg>';
  const ICONE_SMS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  const avecIcone = (html, texte) => { const s = el('span'); s.innerHTML = html; return [s.firstChild, el('span', { texte })]; };

  function lireCache() {
    try {
      const c = JSON.parse(localStorage.getItem(CLE));
      return c && c.identifiant === App.identifiant() ? c.donnees : null;
    } catch (e) { return null; }
  }
  function ecrireCache() {
    try { localStorage.setItem(CLE, JSON.stringify({ identifiant: App.identifiant(), donnees })); } catch (e) { /* stockage plein */ }
  }

  async function charger() {
    chargementEnCours = true;
    erreur = '';
    rendre();
    try {
      const rep = await App.appeler('lireAnnuaire');
      if (rep.ok) { donnees = rep; ecrireCache(); } else {
        erreur = /Action inconnue/.test(rep.erreur || '') ? 'Le serveur n\'est pas encore à jour (fichier Annuaire.gs à ajouter dans Apps Script).' : (rep.erreur || 'Refusé par le serveur.');
      }
    } catch (err) {
      erreur = donnees
        ? `Hors ligne : annuaire du ${new Date(donnees.le).toLocaleDateString('fr-FR')}, gardé sur cet appareil.`
        : (err.serveur ? err.message : 'Pas de réseau : l\'annuaire s\'affichera une fois connecté.');
    }
    chargementEnCours = false;
    rendre();
  }

  function visibles() {
    const f = sansAccent(recherche);
    const chiffres = recherche.replace(/\D/g, '');
    return donnees.agents.filter((a) => (!groupe || a.groupe === groupe)
      && (!avecNumero || a.telephone)
      && (!f || sansAccent(a.nom).includes(f) || sansAccent(a.fonction).includes(f)
        || (chiffres.length >= 3 && telFr(a.telephone).replace(/\D/g, '').includes(chiffres))));
  }

  function fiche(a) {
    const actions = a.telephone
      ? el('div', { classe: 'ann-actions' },
        el('a', { classe: 'ann-bouton', href: `tel:${a.telephone}`, 'aria-label': `Appeler ${a.nom}, ${telFr(a.telephone)}` }, avecIcone(ICONE_TEL, telFr(a.telephone))),
        el('a', { classe: 'ann-bouton ann-sms', href: `sms:${a.telephone}`, 'aria-label': `SMS à ${a.nom}` }, avecIcone(ICONE_SMS, 'SMS')))
      : el('p', { classe: 'ann-non-partage', texte: 'Numéro non partagé' });
    return el('li', { classe: `ann-agent${a.moi ? ' ann-moi' : ''}` },
      el('div', { classe: 'ann-avatar', 'aria-hidden': 'true', texte: initiales(a.nom) }),
      el('div', { classe: 'ann-identite' },
        el('p', { classe: 'ann-nom' }, a.nom, a.moi ? el('span', { classe: 'usr-pastille usr-gris', texte: 'Vous' }) : null),
        el('p', { classe: 'ann-fonction', texte: a.fonction || '—' })),
      actions);
  }

  function rendre() {
    if (!zone || zone.hidden) return;
    const focus = document.activeElement && document.activeElement.id === 'ann-recherche';
    const position = focus ? document.activeElement.selectionStart : 0;
    zone.innerHTML = '';
    zone.append(el('h1', { texte: 'Annuaire du personnel' }));
    if (erreur) zone.append(el('p', { classe: `message ${donnees ? '' : 'erreur'}`.trim(), role: 'status', texte: erreur }));
    if (!donnees) {
      zone.append(chargementEnCours ? el('p', { classe: 'consigne', texte: 'Chargement de l\'annuaire…' })
        : el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Réessayer', surclick: charger }));
      return;
    }

    const moi = donnees.agents.find((a) => a.moi);
    if (moi && !moi.telephone) {
      zone.append(el('p', { classe: 'ann-rappel' },
        'Votre numéro n\'est pas visible des autres. ',
        el('button', { type: 'button', classe: 'lien', texte: 'Le partager depuis Mon profil', surclick: () => App.ouvrirVue('profil') })));
    }

    const groupesPresents = donnees.groupes.filter((g) => donnees.agents.some((a) => a.groupe === g.code));
    zone.append(el('div', { classe: 'ann-outils' },
      el('div', { classe: 'champ ann-champ' },
        el('label', { for: 'ann-recherche', texte: 'Rechercher' }),
        el('input', {
          id: 'ann-recherche', type: 'search', valeur: recherche, placeholder: 'Nom, fonction ou numéro', autocomplete: 'off',
          surinput: (e) => { recherche = e.target.value; rendre(); },
        })),
      el('label', { classe: 'case-rester ann-case' },
        el('input', { type: 'checkbox', checked: avecNumero, surchange: (e) => { avecNumero = e.target.checked; rendre(); } }),
        el('span', { texte: 'Seulement avec numéro' }))));
    zone.append(el('div', { classe: 'ann-filtres', role: 'group', 'aria-label': 'Filtrer par métier' },
      [{ code: '', libelle: 'Tous' }].concat(groupesPresents).map((g) => el('button', {
        type: 'button', classe: `ann-filtre${groupe === g.code ? ' actif' : ''}`, 'aria-pressed': String(groupe === g.code), texte: g.libelle,
        surclick: () => { groupe = g.code; rendre(); },
      }))));

    const liste = visibles();
    zone.append(el('p', { classe: 'ann-compte', role: 'status', texte: liste.length > 1 ? `${liste.length} personnes` : (liste.length ? '1 personne' : 'Aucune personne ne correspond.') }));
    zone.append(el('ul', { classe: 'ann-liste' }, liste.map(fiche)));
    zone.append(el('p', { classe: 'pro-aide', texte: 'Seuls les numéros que leurs titulaires ont choisi de partager sont affichés. Ces numéros sont réservés à l\'usage professionnel.' }));

    if (focus) {
      const champ = zone.querySelector('#ann-recherche');
      champ.focus();
      champ.setSelectionRange(position, position);
    }
  }

  return {
    initialiser(options) {
      App = options;
      zone = document.getElementById('zone-annuaire');
    },
    ouvrir() {
      zone.hidden = false;
      donnees = donnees || lireCache();
      rendre();
      charger();
    },
    masquer() {
      if (zone) zone.hidden = true;
    },
    /** Déconnexion : l'annuaire (numéros) ne reste pas sur l'appareil. */
    oublier() {
      donnees = null;
      recherche = '';
      groupe = '';
      try { localStorage.removeItem(CLE); } catch (e) { /* rien */ }
    },
  };
})();
