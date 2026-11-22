/**
 * Désarmement d'un véhicule (backend : Desarmement.gs).
 *
 * Quand un véhicule est désarmé, on demande ce qu'est devenu le contenu de ses tiroirs et placards (contenants
 * immobiles ; sacs et matériel ne sont pas concernés), pour que les péremptions suivent :
 *   - resté dans les tiroirs et placards du véhicule ;
 *   - rangé en caisses dans les locaux du SMUR (répertoire virtuel « Caisses Fxx » créé dans les inventaires) ;
 *   - a servi à armer un autre véhicule (péremptions transférées, ce véhicule passe armé) ;
 *   - je ne sais pas (fiche du matin) : la question est posée aux IADE sur la page des inventaires.
 * Au réarmement, si des caisses existent, on demande si le contenu en vient (péremptions rapatriées).
 *
 * Qui : ambulancier ou IADE. Où : fiche régulation (regulation.js), menu d'un véhicule (actions.js),
 * page des inventaires (inventaires.js). Hors ligne : l'action part dans la file d'attente.
 */
const Desarmement = (() => {
  let App = {};
  const CLE_ARMEMENT = 'avismur_armement';
  const CLE_DESARMEMENTS = 'avismur_desarmements';

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
  const lire = (cle) => { try { return JSON.parse(localStorage.getItem(cle)) || {}; } catch (e) { return {}; } };
  const ecrire = (cle, v) => { try { localStorage.setItem(cle, JSON.stringify(v)); } catch (e) { /* stockage plein */ } };

  // Fiche régulation du jour pas encore envoyée (brouillon) : ce qu'elle dit de l'armement compte déjà.
  const CLE_BROUILLON = 'avismur_fiche_regulation_brouillon';
  const brouillon = () => {
    const b = lire(CLE_BROUILLON);
    return b && b.jour === new Date().toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' }) && b.saisie && b.saisie.vehicules ? b.saisie.vehicules : {};
  };
  const armement = () => {
    const a = lire(CLE_ARMEMENT);
    Object.entries(brouillon()).forEach(([id, s]) => { if (s && s.armement) a[id] = s.armement; });
    return a;
  };
  const desarmements = () => {
    const d = lire(CLE_DESARMEMENTS);
    Object.entries(brouillon()).forEach(([id, s]) => {
      if (!s || s.armement !== 'DÉSARMÉ' || (d[id] && d[id].statut === 'traite')) return;
      const c = s.contenu;
      d[id] = c && c.destination && c.destination !== 'inconnu'
        ? { ...(d[id] || {}), statut: 'traite', destination: c.destination, cible: c.cible }
        : { ...(d[id] || {}), statut: 'attente' };
    });
    return d;
  };
  const estDesarme = (id) => armement()[id] === 'DÉSARMÉ';

  /** Fenêtre modale : `remplir(corps, valider)` construit le contenu ; résout la valeur passée à valider, ou null. */
  function fenetre(titre, remplir) {
    return new Promise((resoudre) => {
      const d = el('dialog', { classe: 'mat-dialogue dsm-dialogue', 'aria-label': titre });
      let resultat = null;
      const valider = (valeur) => { resultat = valeur; d.close(); };
      const corps = el('div', { classe: 'mat-dialogue-corps' });
      d.append(el('div', { classe: 'mat-dialogue-entete' }, el('h2', { texte: titre }),
        el('button', { type: 'button', classe: 'tiroir-fermer', 'aria-label': 'Annuler', texte: '✕', surclick: () => d.close() })), corps);
      remplir(corps, valider);
      d.addEventListener('close', () => { d.remove(); resoudre(resultat); });
      document.body.append(d);
      d.showModal();
    });
  }

  const LIBELLES = {
    vehicule: 'Resté dans les tiroirs et placards du véhicule',
    stock: 'Rangé en caisses dans les locaux du SMUR',
    autre: 'A servi à armer un autre véhicule',
    inconnu: 'Je ne sais pas',
  };

  // Pictogrammes des choix : véhicule de profil, nez à gauche, coffre à droite.
  const NS = 'http://www.w3.org/2000/svg';
  function svg(vb, contenu, classe) {
    const n = document.createElementNS(NS, 'svg');
    n.setAttribute('viewBox', vb);
    n.setAttribute('class', classe);
    n.setAttribute('aria-hidden', 'true');
    n.innerHTML = contenu;
    return n;
  }
  function vehiculeSvg(ouvert, miroir) {
    const corps = ouvert
      // Coffre ouvert : caisse évidée à l'arrière, hayon relevé.
      ? '<path d="M40 22H4v-8l7-8h29" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>'
        + '<path d="M4 22v-8l7-8h26v16z" fill="currentColor" opacity=".18"/>'
        + '<path d="M40 6l7-6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>'
        + '<path d="M40 7v15" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2 2"/>'
      : '<path d="M4 22v-8l7-8h29v16z" fill="currentColor" opacity=".18"/>'
        + '<path d="M4 22v-8l7-8h29v16z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>'
        + '<path d="M36 8v12" stroke="currentColor" stroke-width="1.2"/>';
    const reste = '<path d="M12 8.5 8 13.5h9v-5z" fill="currentColor"/>'
      + '<circle cx="13" cy="23" r="3.5" fill="#fff" stroke="currentColor" stroke-width="2"/>'
      + '<circle cx="33" cy="23" r="3.5" fill="#fff" stroke="currentColor" stroke-width="2"/>';
    const g = miroir ? `<g transform="translate(48 0) scale(-1 1)">${corps}${reste}</g>` : corps + reste;
    return svg('-1 -2 50 30', g, 'dsm-picto-vl');
  }
  const flecheSvg = () => svg('0 0 24 16', '<path d="M2 8h17m-5-5 5 5-5 5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>', 'dsm-picto-fleche');
  const interditSvg = () => svg('0 0 24 24', '<circle cx="12" cy="12" r="9" fill="none" stroke="#c0392b" stroke-width="2.6"/><path d="M5.6 18.4 18.4 5.6" stroke="#c0392b" stroke-width="2.6"/>', 'dsm-picto-signe');
  const caisseSvg = () => svg('0 0 28 24', '<rect x="2" y="5" width="24" height="17" rx="1.5" fill="currentColor" opacity=".18" stroke="currentColor" stroke-width="2"/>'
    + '<path d="M2 11h24M9 5v4m10-4v4M10 15h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>', 'dsm-picto-signe');
  const inconnuSvg = () => svg('0 0 24 24', '<text x="12" y="20" text-anchor="middle" font-size="22" font-weight="700" fill="currentColor" font-family="sans-serif">?</text>', 'dsm-picto-signe');
  const PICTOS = {
    vehicule: () => [vehiculeSvg(false), interditSvg()],
    stock: () => [vehiculeSvg(true), flecheSvg(), caisseSvg()],
    autre: () => [vehiculeSvg(true), flecheSvg(), vehiculeSvg(true, true)],
    inconnu: () => [vehiculeSvg(true), flecheSvg(), inconnuSvg()],
  };

  /** Texte court du devenir du contenu (entrée de DESARMEMENTS). */
  function resume(e) {
    if (!e) return '';
    if (e.statut === 'attente') return 'Contenu des tiroirs et placards : à localiser';
    if (e.destination === 'vehicule') return 'Contenu resté dans le véhicule';
    if (e.destination === 'stock') return 'Contenu rangé en caisses au SMUR';
    if (e.destination === 'autre') return `Contenu passé dans ${e.cible}`;
    return '';
  }

  /**
   * Que devient le contenu des tiroirs et placards de `vehicule` ?
   * vehicules : [{ id, nom }] candidats pour « un autre véhicule » ; inconnu : proposer « Je ne sais pas ».
   * Résout { destination, cible } ou null (annulé).
   */
  function choisir({ vehicule, vehicules = [], inconnu = true, titre }) {
    const autres = vehicules.filter((v) => v.id !== vehicule);
    return fenetre(titre || `${vehicule} désarmé`, (corps, valider) => {
      let choix = '';
      const nom = `dsm-${Date.now()}`;
      const liste = el('select', { classe: 'dsm-cible', 'aria-label': 'Véhicule armé avec ce contenu', hidden: true },
        el('option', { valeur: '', texte: '— véhicule —' }),
        // Véhicules désarmés en premier : ce sont eux qu'on arme d'habitude.
        [...autres].sort((a, b) => Number(estDesarme(b.id)) - Number(estDesarme(a.id)))
          .map((v) => el('option', { valeur: v.id, texte: `${v.nom || v.id}${estDesarme(v.id) ? ' (désarmé)' : ''}` })));
      const ok = el('button', { type: 'button', classe: 'principal', texte: 'Valider', disabled: true });
      const majOk = () => { ok.disabled = !choix || (choix === 'autre' && !liste.value); };
      liste.addEventListener('change', majOk);
      corps.append(
        el('p', { texte: 'Où se trouve le contenu de ses tiroirs et placards ? Les péremptions suivront le contenu. Les sacs et le matériel ne sont pas concernés.' }),
        el('div', { classe: 'dsm-choix', role: 'radiogroup' },
          ['vehicule', 'stock', 'autre', ...(inconnu ? ['inconnu'] : [])].filter((c) => c !== 'autre' || autres.length).map((c) => el('label', { classe: 'dsm-option' },
            el('input', { type: 'radio', name: nom, valeur: c, surchange: () => { choix = c; liste.hidden = c !== 'autre'; majOk(); } }),
            el('span', { classe: 'dsm-picto' }, PICTOS[c]()),
            el('span', { classe: 'dsm-libelle', texte: LIBELLES[c] })))),
        liste,
        el('div', { classe: 'mat-boutons' }, ok));
      ok.addEventListener('click', () => valider({ destination: choix, cible: choix === 'autre' ? liste.value : '' }));
    });
  }

  /** Réarmement : le contenu vient-il de caisses ? Résout l'identifiant des caisses, '' (non) ou null (annulé). */
  function choisirStock({ vehicule, stocks }) {
    const tries = [...stocks].sort((a, b) => Number(b.vehicule === vehicule) - Number(a.vehicule === vehicule));
    return fenetre(`${vehicule} armé`, (corps, valider) => {
      corps.append(el('p', { texte: 'D\'où vient le contenu des tiroirs et placards ? Les péremptions des caisses seront remises dans le véhicule.' }),
        el('div', { classe: 'dsm-choix' },
          tries.map((s) => el('button', { type: 'button', classe: 'cfg-bouton dsm-option', texte: s.nom, surclick: () => valider(s.id) })),
          el('button', { type: 'button', classe: 'cfg-bouton dsm-option', texte: 'D\'ailleurs (pas de ces caisses)', surclick: () => valider('') })));
    });
  }

  /** Note tout de suite sur l'appareil (hors ligne compris) ce qui part au serveur. */
  function noterLocal(vehicule, arme, contenu) {
    const a = lire(CLE_ARMEMENT);
    const d = lire(CLE_DESARMEMENTS);
    a[vehicule] = arme ? 'ARMÉ' : 'DÉSARMÉ';
    if (arme) delete d[vehicule];
    else {
      const e = { ...(d[vehicule] || {}), depuis: (d[vehicule] || {}).depuis || new Date().toISOString(), par: App.agent ? App.agent() : '' };
      if (!contenu || contenu.destination === 'inconnu') e.statut = 'attente';
      else {
        Object.assign(e, { statut: 'traite', destination: contenu.destination, cible: contenu.cible || undefined });
        if (contenu.destination === 'autre' && contenu.cible) { a[contenu.cible] = 'ARMÉ'; delete d[contenu.cible]; }
      }
      d[vehicule] = e;
    }
    ecrire(CLE_ARMEMENT, a);
    ecrire(CLE_DESARMEMENTS, d);
  }

  /**
   * Dans la journée : désarmer (avec la question) ou réarmer un véhicule. Résout true si enregistré.
   */
  async function basculer(vehicule, versArme) {
    const donnees = { vehicule, arme: versArme };
    if (!versArme) {
      const r = await choisir({ vehicule, vehicules: App.vehicules ? App.vehicules() : [], inconnu: true });
      if (!r) return false;
      Object.assign(donnees, r);
    } else {
      const stocks = App.stocks ? App.stocks() : [];
      if (stocks.length) {
        const r = await choisirStock({ vehicule, stocks });
        if (r === null) return false;
        donnees.depuis = r;
      }
    }
    if (!App.mettreEnFile({ action: 'changerArmement', donnees })) return false;
    noterLocal(vehicule, versArme, versArme ? null : donnees);
    if (App.surChangement) App.surChangement();
    return true;
  }

  /**
   * Toucher un véhicule désarmé : où a été mis le contenu des tiroirs et placards. Non renseigné : la question
   * est posée (résout true si une réponse est enregistrée).
   */
  async function info(vehicule) {
    const e = desarmements()[vehicule];
    if (!e || e.statut === 'attente') return repondre(vehicule);
    const date = e.depuis ? new Date(e.depuis).toLocaleDateString('fr-FR') : '';
    await fenetre(`${vehicule} désarmé`, (corps, valider) => {
      corps.append(
        el('p', {}, el('strong', { texte: resume(e) })),
        el('p', { classe: 'aide-question', texte: [date && `Désarmé le ${date}`, e.par && `par ${e.par}`].filter(Boolean).join(' ') + (e.traitePar && e.traitePar !== e.par ? ` · contenu renseigné par ${e.traitePar}` : '') }),
        el('p', { classe: 'aide-question', texte: 'Pas d\'inventaire tant que le véhicule est désarmé. Pour le réarmer : fiche régulation ou menu du véhicule.' }),
        el('div', { classe: 'mat-boutons' }, el('button', { type: 'button', classe: 'principal', texte: 'Fermer', surclick: () => valider(true) })));
    });
    return false;
  }

  /** Réponse à la question en attente (l'ambulancier ne savait pas). */
  async function repondre(vehicule) {
    const r = await choisir({ vehicule, vehicules: App.vehicules ? App.vehicules() : [], inconnu: false, titre: `Contenu de ${vehicule} désarmé` });
    if (!r) return false;
    if (!App.mettreEnFile({ action: 'contenuDesarme', donnees: { vehicule, ...r } })) return false;
    noterLocal(vehicule, false, r);
    if (App.surChangement) App.surChangement();
    return true;
  }

  return {
    initialiser(app) { App = app; },
    /** Réponse du serveur (lireInventaires, derniersReleves) : armement et désarmements gardés sur l'appareil. */
    majServeur(armementServeur, desarmementsServeur) {
      // Un changement pas encore envoyé reste tel que sur l'appareil jusqu'à son envoi.
      const enAttente = App.fileAttente ? App.fileAttente().some((x) => ['changerArmement', 'contenuDesarme', 'envoyerFicheRegulation'].includes(x.action)) : false;
      if (enAttente) return;
      if (armementServeur && typeof armementServeur === 'object') ecrire(CLE_ARMEMENT, armementServeur);
      if (desarmementsServeur && typeof desarmementsServeur === 'object') ecrire(CLE_DESARMEMENTS, desarmementsServeur);
    },
    armement, desarmements, estDesarme, resume, info, choisir, choisirStock, basculer, repondre, LIBELLES,
    /** Véhicules désarmés dont le contenu reste à localiser. */
    enAttente: () => Object.entries(desarmements()).filter(([id, e]) => e && e.statut === 'attente' && estDesarme(id)).map(([id, e]) => ({ id, ...e })),
  };
})();
