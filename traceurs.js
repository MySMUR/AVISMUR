/*
 * Choix d'un traceur GeoTraceSMUR dans une fiche (appareil du suivi du matériel, contenant mobile).
 *
 * La liste vient de GeoTrace (onglet « Répartition des traceurs ») par le serveur (action « traceursGeoTrace ») :
 * le nom choisi est exactement celui de l'onglet du traceur, ce qui garantit la liaison. Un traceur déjà
 * attribué à un autre objet est grisé (« déjà sur … »). Sans réseau, la dernière liste reçue est réutilisée ;
 * sans liste du tout, on retombe sur une saisie libre.
 *
 * Traceurs.champ({ appeler, valeur, proprietaire: { genre: 'contenant'|'materiel', id }, surchange(nom) })
 *   → élément à insérer dans le formulaire.
 */
const Traceurs = (() => {
  const CLE_CACHE = 'avismur-traceurs';
  let enCours = null; // une seule requête à la fois, partagée entre les champs

  const cle = (v) => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

  function lireCache() {
    try { return JSON.parse(localStorage.getItem(CLE_CACHE)); } catch (e) { return null; }
  }

  /** { traceurs, date, horsLigne?, erreur? } — `forcer` relance la requête même si une liste est déjà là. */
  function charger(appeler, forcer = false) {
    if (enCours && !forcer) return enCours;
    enCours = (async () => {
      try {
        const rep = await appeler('traceursGeoTrace');
        if (rep && rep.ok && Array.isArray(rep.traceurs)) {
          const d = { traceurs: rep.traceurs, date: new Date().toISOString() };
          try { localStorage.setItem(CLE_CACHE, JSON.stringify(d)); } catch (e) { /* mémoire pleine */ }
          return d;
        }
        const ancien = lireCache();
        return ancien ? { ...ancien, erreur: (rep && rep.erreur) || 'liste indisponible' } : { traceurs: null, erreur: (rep && rep.erreur) || 'liste indisponible' };
      } catch (e) {
        const ancien = lireCache();
        return ancien ? { ...ancien, horsLigne: true } : { traceurs: null, erreur: 'pas de réseau' };
      }
    })();
    // La liste reste valable quelques minutes (le serveur garde aussi la sienne 10 min).
    setTimeout(() => { enCours = null; }, 5 * 60 * 1000);
    return enCours;
  }

  function creer(balise, attributs = {}, ...enfants) {
    const n = document.createElement(balise);
    Object.entries(attributs).forEach(([k, v]) => {
      if (v === null || v === undefined || v === false) return;
      if (k === 'texte') n.textContent = v;
      else if (k === 'classe') n.className = v;
      else n.setAttribute(k, v === true ? '' : v);
    });
    enfants.flat().forEach((e) => { if (e !== null && e !== undefined && e !== false) n.append(e); });
    return n;
  }

  function champ({ appeler, valeur = '', proprietaire = {}, surchange = () => {} }) {
    let courant = String(valeur || '');
    const boite = creer('div', { classe: 'traceur-choix' });
    const note = creer('small', { classe: 'traceur-note' });
    const actualiser = creer('button', { type: 'button', classe: 'cfg-mini', title: 'Recharger la liste de GeoTraceSMUR', texte: '↻' });

    const changer = (nom) => { courant = nom; surchange(nom); };
    const autreQueMoi = (u) => !(u.genre === proprietaire.genre && String(u.id) === String(proprietaire.id));

    function saisieLibre(message) {
      const entree = creer('input', { maxlength: '60', placeholder: 'Nom du traceur dans GeoTraceSMUR' });
      entree.value = courant;
      entree.addEventListener('change', () => changer(entree.value.trim()));
      note.textContent = `${message} : saisissez le nom exact de l'onglet du traceur.`;
      boite.replaceChildren(creer('div', { classe: 'traceur-ligne' }, entree, actualiser), note);
    }

    function liste(d) {
      const select = creer('select', { 'aria-label': 'Traceur GeoTraceSMUR' });
      select.append(creer('option', { value: '', texte: '— Choisir le traceur —' }));
      let trouve = false;
      const parFichier = new Map();
      d.traceurs.forEach((t) => {
        const f = t.fichier || 'Autres';
        if (!parFichier.has(f)) parFichier.set(f, []);
        parFichier.get(f).push(t);
      });
      const groupes = parFichier.size > 1;
      parFichier.forEach((traceurs, fichier) => {
        const parent = groupes ? creer('optgroup', { label: fichier }) : select;
        traceurs.forEach((t) => {
          const autres = (t.utilisePar || []).filter(autreQueMoi);
          const choisi = cle(t.nom) === cle(courant) && courant !== '';
          if (choisi) trouve = true;
          const o = creer('option', { value: t.nom, texte: autres.length ? `${t.nom} — déjà sur ${autres.map((u) => u.nom).join(', ')}` : t.nom });
          if (autres.length && !choisi) o.disabled = true; // un tag n'est collé que sur un seul objet
          if (choisi) o.selected = true;
          parent.append(o);
        });
        if (groupes) select.append(parent);
      });
      if (courant && !trouve) {
        // Nom saisi avant la liste, ou traceur retiré de GeoTrace : on le garde visible, signalé.
        const o = creer('option', { value: courant, texte: `${courant} (absent de GeoTraceSMUR)` });
        o.selected = true;
        select.insertBefore(o, select.options[1] || null);
      }
      select.addEventListener('change', () => changer(select.value));
      const age = d.date ? new Date(d.date).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '';
      note.textContent = d.horsLigne ? `Hors ligne : liste du ${age}.`
        : (d.erreur ? `Liste du ${age} (${d.erreur}).` : (courant && !trouve ? 'Ce nom ne correspond à aucun traceur de GeoTraceSMUR : choisissez-en un dans la liste.' : ''));
      boite.replaceChildren(creer('div', { classe: 'traceur-ligne' }, select, actualiser), note);
    }

    async function remplir(forcer) {
      actualiser.disabled = true;
      const d = await charger(appeler, forcer);
      actualiser.disabled = false;
      if (d.traceurs && d.traceurs.length) liste(d);
      else saisieLibre(d.traceurs ? 'Aucun traceur dans GeoTraceSMUR' : `Liste GeoTraceSMUR indisponible (${d.erreur})`);
    }

    actualiser.addEventListener('click', () => remplir(true));
    // Affichage immédiat de la dernière liste connue, puis mise à jour.
    const ancien = lireCache();
    if (ancien && ancien.traceurs && ancien.traceurs.length) liste(ancien);
    else boite.replaceChildren(creer('small', { classe: 'traceur-note', texte: 'Chargement des traceurs de GeoTraceSMUR…' }));
    remplir(false);
    return boite;
  }

  return { champ, charger };
})();
