/**
 * Fluides médicaux (menu > Véhicules > Fluides médicaux ; backend : Fluides.gs).
 * Chaque jeudi : inventaire des obus (O² 1 m³, O² 3 m³, air 1 m³) par emplacement, total comparé à la dotation,
 * quantité à commander proposée (dotation − total ; l'air se commande par 2 au moins), bon de commande
 * imprimable ; « Commande envoyée » envoie le bon par mail à la pharmacie (serveur) et clôt le rappel du jeudi.
 *
 * Hors ligne : paramétrage et derniers inventaires gardés sur l'appareil, saisie gardée en brouillon,
 * enregistrement envoyé par la file d'attente.
 */
const Fluides = (() => {
  let zone;
  let App = {};
  let donnees = null; // réponse de lireFluides
  let saisie = null; // { jour, comptes: {emplacement: {type: n}}, commande: {type: n}, commandeModifiee: {type: bool}, signataire }
  let erreur = '';
  let message = { texte: '', classe: '' };
  const CLE = 'avismur_fluides';
  const CLE_BROUILLON = 'avismur_fluides_brouillon';

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
  const lire = (cle) => { try { return JSON.parse(localStorage.getItem(cle)); } catch (e) { return null; } };
  const ecrire = (cle, v) => { try { localStorage.setItem(cle, JSON.stringify(v)); } catch (e) { /* stockage plein */ } };
  const jourIso = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' }); // aaaa-mm-jj
  const dateFr = (iso) => (iso ? iso.split('-').reverse().join('/') : '');

  /** Départ : brouillon du jour, sinon les comptes du dernier inventaire (les véhicules changent peu d'une semaine à l'autre). */
  function initialiserSaisie() {
    const b = lire(CLE_BROUILLON);
    if (b && b.jour === jourIso()) { saisie = b; return; }
    const dernier = (donnees.historique || [])[0];
    saisie = { jour: jourIso(), comptes: {}, commande: {}, commandeModifiee: {}, signataire: App.agent() };
    donnees.emplacements.forEach((e) => {
      saisie.comptes[e.id] = {};
      e.types.forEach((t) => { saisie.comptes[e.id][t] = dernier && dernier.comptes[e.id] ? Number(dernier.comptes[e.id][t]) || 0 : 0; });
    });
  }
  const garder = () => ecrire(CLE_BROUILLON, saisie);

  function total(type) {
    return donnees.emplacements.reduce((s, e) => s + (e.types.includes(type) ? Number(saisie.comptes[e.id][type]) || 0 : 0), 0);
  }
  /** Quantité proposée : ce qui manque à la dotation ; sous le minimum de commande (air : 2), rien. */
  function proposee(t) {
    const manque = Math.max(0, t.dotation - total(t.id));
    return t.minimum && manque < t.minimum ? 0 : manque;
  }
  const quantite = (t) => (saisie.commandeModifiee[t.id] ? Number(saisie.commande[t.id]) || 0 : proposee(t));

  async function charger() {
    erreur = '';
    try {
      const rep = await App.appeler('lireFluides');
      if (!rep.ok) { erreur = rep.erreur || 'Lecture impossible'; rendre(); return; }
      donnees = rep;
      ecrire(CLE, rep);
      if (!saisie) initialiserSaisie();
    } catch (e) {
      erreur = donnees ? 'Hors ligne : derniers inventaires connus.' : 'Hors ligne et aucune donnée gardée sur cet appareil.';
    }
    rendre();
  }

  function compteur(valeur, surChange, libelle) {
    const champ = el('input', { type: 'number', inputmode: 'numeric', min: '0', max: '99', valeur: String(valeur), 'aria-label': libelle, classe: 'flu-champ',
      surchange: (e) => surChange(Math.max(0, Math.min(99, Math.floor(Number(e.target.value)) || 0))) });
    return el('div', { classe: 'flu-compteur' },
      el('button', { type: 'button', classe: 'flu-pas', 'aria-label': `${libelle} : moins un`, texte: '−', surclick: () => surChange(Math.max(0, valeur - 1)) }),
      champ,
      el('button', { type: 'button', classe: 'flu-pas', 'aria-label': `${libelle} : plus un`, texte: '+', surclick: () => surChange(Math.min(99, valeur + 1)) }));
  }

  function enregistrer(envoyee) {
    const commande = {};
    donnees.types.forEach((t) => {
      let q = quantite(t);
      if (q && t.minimum && q < t.minimum) q = t.minimum;
      commande[t.id] = q;
    });
    const ok = App.mettreEnFile({
      action: 'enregistrerFluides',
      donnees: { jour: saisie.jour, comptes: saisie.comptes, commande, envoyee, signataire: saisie.signataire },
      agent: App.agent(),
    });
    if (!ok) return;
    saisie.envoyee = saisie.envoyee || envoyee;
    saisie.enregistre = true;
    garder();
    message = { texte: envoyee ? 'Commande envoyée : le bon de commande part par mail à la pharmacie (dès que le réseau le permet) et le rappel du jeudi est clos.' : 'Inventaire enregistré.', classe: 'succes' };
    rendre();
  }

  function texteCommande() {
    const lignes = donnees.types.filter((t) => quantite(t) > 0)
      .map((t) => `- ${t.libelle} (réf. ${t.reference || '—'}, code ${t.code}) : ${quantite(t)}`);
    return [
      'Bonjour,', '',
      `Commande hebdomadaire des fluides médicaux du SMUR (U.F. ${donnees.commande.uf}) du ${dateFr(saisie.jour)} :`,
      ...(lignes.length ? lignes : ['- Aucun fluide à commander cette semaine.']), '',
      saisie.signataire,
    ].join('\n');
  }

  /** Bon de commande imprimable (même présentation que la fiche papier). */
  function imprimer() {
    const page = el('div', { id: 'flu-impression' },
      el('h1', { texte: 'INVENTAIRE HEBDOMADAIRE DES FLUIDES MÉDICAUX' }),
      el('table', {},
        el('thead', {}, el('tr', {}, el('th'), donnees.types.map((t) => el('th', { texte: t.libelle })))),
        el('tbody', {},
          donnees.emplacements.map((e) => el('tr', {}, el('th', { texte: e.libelle }),
            donnees.types.map((t) => el('td', { texte: e.types.includes(t.id) ? String(saisie.comptes[e.id][t.id]) : '' })))),
          el('tr', { classe: 'flu-imp-total' }, el('th', { texte: 'TOTAL (véhicules + stock)' }),
            donnees.types.map((t) => el('td', { texte: `${total(t.id)}/${t.dotation}` }))))),
      el('h2', { texte: `BON DE COMMANDE : ${donnees.commande.mail} ${donnees.commande.poste}` }),
      el('table', {},
        el('thead', {}, el('tr', {}, ['RÉFÉRENCE PRODUIT', 'CODE PRODUIT', 'DÉSIGNATION', 'QUANTITÉ'].map((x) => el('th', { texte: x })))),
        el('tbody', {}, donnees.types.map((t) => el('tr', {},
          el('td', { texte: t.reference }), el('td', { texte: t.code }), el('td', { texte: t.libelle }), el('td', { texte: String(quantite(t)) }))))),
      el('p', { texte: `U.F : ${donnees.commande.uf}     DATE : ${dateFr(saisie.jour)}     SIGNATURE : ${saisie.signataire}` }));
    document.body.append(page);
    document.body.classList.add('impression-fluides');
    const fin = () => { document.body.classList.remove('impression-fluides'); page.remove(); window.removeEventListener('afterprint', fin); };
    window.addEventListener('afterprint', fin);
    window.print();
    setTimeout(() => { if (document.body.contains(page) && !matchMedia('print').matches) fin(); }, 60000);
  }

  function rendre() {
    if (!zone || zone.hidden) return;
    zone.innerHTML = '';
    zone.append(el('h1', { texte: 'Fluides médicaux' }),
      el('p', { classe: 'consigne', texte: 'Inventaire hebdomadaire des obus et commande à la pharmacie, chaque jeudi' }));
    if (message.texte) zone.append(el('p', { classe: `message ${message.classe}`, role: 'status', texte: message.texte }));
    if (erreur) zone.append(el('p', { classe: `message ${donnees ? 'info' : 'erreur'}`, role: 'status', texte: erreur }));
    if (!donnees) { if (!erreur) zone.append(el('p', { classe: 'message', texte: 'Chargement…' })); return; }
    if (!saisie) initialiserSaisie();

    const dernier = (donnees.historique || []).find((h) => h.envoyee);
    if (dernier) zone.append(el('p', { classe: 'reg-dernier', texte: `Dernière commande envoyée : ${dateFr(dernier.jour)}${dernier.par ? ` (${dernier.par})` : ''}` }));
    if (App.fileAttente().some((e) => e.action === 'enregistrerFluides')) zone.append(el('p', { classe: 'reg-dernier', texte: 'Un inventaire attend le réseau pour partir.' }));

    // Inventaire : une carte par emplacement.
    const bloc = el('section', { classe: 'reg-bloc' }, el('h2', { texte: `Inventaire du ${dateFr(saisie.jour)}` }));
    donnees.emplacements.forEach((e) => {
      const vignette = e.vehicule && App.vignette ? App.vignette(e.vehicule, 'flu-vignette') : null;
      bloc.append(el('div', { classe: `flu-ligne${e.stock ? ' flu-stock' : ''}` },
        el('div', { classe: 'flu-nom' }, vignette, el('strong', { texte: e.libelle })),
        el('div', { classe: 'flu-comptes' }, e.types.map((tid) => {
          const t = donnees.types.find((x) => x.id === tid);
          const v = Number(saisie.comptes[e.id][tid]) || 0;
          return el('div', { classe: 'flu-type' }, el('span', { texte: t.libelle }),
            compteur(v, (n) => { saisie.comptes[e.id][tid] = n; garder(); rendre(); }, `${e.libelle}, ${t.libelle}`));
        }))));
    });
    zone.append(bloc);

    // Totaux et commande.
    const blocCmd = el('section', { classe: 'reg-bloc' }, el('h2', { texte: 'Bon de commande' }));
    donnees.types.forEach((t) => {
      const tot = total(t.id);
      const q = quantite(t);
      const manque = Math.max(0, t.dotation - tot);
      const note = t.minimum && manque > 0 && manque < t.minimum && !saisie.commandeModifiee[t.id]
        ? `Il en manque ${manque} : commande par ${t.minimum} minimum, rien de proposé.` : (t.minimum ? `Par ${t.minimum} minimum.` : '');
      blocCmd.append(el('div', { classe: 'flu-ligne' },
        el('div', { classe: 'flu-nom' }, el('strong', { texte: t.libelle }),
          el('span', { classe: `flu-total${tot < t.dotation ? ' manque' : ''}`, texte: `${tot}/${t.dotation}` })),
        el('div', { classe: 'flu-type' }, el('span', { texte: 'À commander' }),
          compteur(q, (n) => {
            if (n && t.minimum && n < t.minimum) n = q < n ? t.minimum : 0; // 0 ↔ minimum, jamais en dessous
            saisie.commande[t.id] = n; saisie.commandeModifiee[t.id] = true; garder(); rendre();
          }, `${t.libelle} à commander`)),
        note ? el('p', { classe: 'flu-note', texte: note }) : null));
    });
    const sig = el('input', { type: 'text', classe: 'flu-signataire', valeur: saisie.signataire, maxlength: '80', 'aria-label': 'Signataire',
      surchange: (e) => { saisie.signataire = e.target.value; garder(); } });
    blocCmd.append(el('label', { classe: 'flu-sig' }, el('span', { texte: 'Signature' }), sig),
      el('p', { classe: 'flu-note', texte: `U.F. ${donnees.commande.uf} · ${donnees.commande.mail} · poste ${donnees.commande.poste}` }));
    zone.append(blocCmd);

    zone.append(el('div', { classe: 'flu-actions' },
      el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Imprimer / PDF', surclick: imprimer }),
      el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Enregistrer l\'inventaire', surclick: () => enregistrer(false) }),
      el('button', { type: 'button', classe: 'cfg-bouton flu-envoyee', texte: saisie.envoyee ? 'Commande envoyée ✓' : 'Commande envoyée',
        surclick: () => { if (confirm(`Envoyer le bon de commande à ${donnees.commande.mail} ?`)) enregistrer(true); } })));

    // Historique.
    if ((donnees.historique || []).length) {
      zone.append(el('section', { classe: 'reg-bloc' }, el('h2', { texte: 'Précédents inventaires' }),
        el('ul', { classe: 'flu-historique' }, donnees.historique.map((h) => el('li', {},
          el('strong', { texte: dateFr(h.jour) }), ' · ',
          donnees.types.map((t) => {
            const tot = donnees.emplacements.reduce((s, e) => s + (Number((h.comptes[e.id] || {})[t.id]) || 0), 0);
            return `${t.libelle} ${tot}/${t.dotation} (cmd ${Number(h.commande[t.id]) || 0})`;
          }).join(' · '),
          h.envoyee ? ' · envoyée' : '', h.par ? ` · ${h.par}` : '')))));
    }
  }

  return {
    initialiser(fonctions) {
      App = fonctions;
      zone = document.getElementById('zone-fluides');
    },
    ouvrir() {
      zone.hidden = false;
      message = { texte: '', classe: '' };
      if (!donnees) donnees = lire(CLE);
      if (saisie && saisie.jour !== jourIso()) saisie = null;
      rendre();
      charger();
    },
    masquer() { if (zone) zone.hidden = true; },
    /** Synchronisation entre appareils (synchro.js) : relit l'inventaire affiché ; la saisie en cours est gardée. */
    actualiser() { return zone && !zone.hidden ? charger() : null; },
  };
})();
