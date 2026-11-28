/*
 * Check-list ambulancier : vérification quotidienne des véhicules.
 * Reprise des Google Forms « Check-list Ambulancier VML », « UMH » et « HELICO » (F00).
 *
 * Pour modifier la check-list, il suffit d'éditer ce fichier (puis d'incrémenter les ?v=
 * dans index.html et CACHE dans sw.js).
 *
 * Le libellé d'une question sert aussi de nom de colonne pour la copie vers l'ancien Sheet
 * « Check-list journalière véhicules SMUR ». La comparaison ignore majuscules, accents et
 * espaces : « Boîte à gants [Boîte à ampoules] » correspond à « Boîte à gants [BOITE A AMPOULES] ».
 * Quand l'en-tête du Sheet est différent (faute de frappe…), on le précise avec `colonne`.
 *
 * Véhicules : `sansGarage`, `sansPlein`, `sansExterieur`, `sansNettoyage` (true) retirent le passage
 * au garage, le plein, la vérification extérieure et le nettoyage (case et menu d'actions).
 * `sansKm` (true) : pas de kilométrage (couveuse, chariot ménage…) : ni question, ni relevé, ni tuile.
 * `picto: 'nourrisson'` : pictogramme dessiné (couveuse) ; `icone` : emoji libre ; `vignette` : photo de la case.
 *
 * Types de questions :
 *   niveau      : obus / bouteille, curseur de 0 à 10 (10 = plein, 200 bars)
 *   carburant   : jauge, curseur de 0 à 8 (enregistré « 6/8 »)
 *   kilometrage : affiche le dernier relevé du véhicule et refuse un kilométrage inférieur
 *   groupe      : liste d'éléments à cocher « OK » (non coché = manquant)
 *   fait        : case « Fait »
 *   choix       : une réponse parmi `options`
 *   texte       : remarques libres
 *   cache       : pas affichée ; valeur selon le véhicule (`valeurs`, sinon `defaut`)
 *
 * Restrictions par véhicule :
 *   seulementPour: ['F26']  la question n'existe que pour ces véhicules
 *   exclusPour: ['F28']     la question n'est pas posée pour ces véhicules ;
 *                           `sinon` donne alors la réponse enregistrée
 * `affiche` : texte montré à l'écran à la place du libellé (le libellé reste le nom de colonne).
 * `si: { question, valeur }` n'affiche la question que si une autre a cette réponse.
 */

// Une check-list est « avec anomalies » (case orange) si un élément est manquant, si l'AdBlue
// est à compléter, s'il y a une remarque, ou si un niveau est à ce seuil ou en dessous.
const SEUILS_ANOMALIE = {
  obus: 3, // sur 10 (3 = 60 bars)
  carburant: 2, // sur 8 (un quart)
  plein: 5, // sur 8 : à ce niveau ou en dessous, pompe rouge sur la case du véhicule (plein à faire)
};

// ---------- Affichage des réponses : jauges et rubriques (fiche check-list et tableau du parc) ----------
/** Rubrique des réponses sans crochets : obus et bouteilles = « Fluides médicaux », le reste = « Général ». */
const RUBRIQUE_FLUIDES = 'Fluides médicaux';
const rubriqueSansCrochets = (libelle) => (/obus|bouteille/i.test(libelle) ? RUBRIQUE_FLUIDES : 'Général');

/** Niveau « jaugeable » d'une réponse : obus/bouteille (n/10) ou carburant (n/8) ; null sinon. */
function niveauJauge(libelle, valeur) {
  let n = null; let max = null;
  if (typeof valeur === 'number' && /obus|bouteille/i.test(libelle)) { n = valeur; max = 10; }
  else if (typeof valeur === 'string' && /^\d+\/8$/.test(valeur.trim())) { n = parseInt(valeur, 10); max = 8; }
  if (n === null || Number.isNaN(n)) return null;
  const seuilBas = max === 10 ? SEUILS_ANOMALIE.obus : SEUILS_ANOMALIE.carburant;
  const seuilMoyen = max === 10 ? 6 : SEUILS_ANOMALIE.plein;
  return {
    n, max, niveau: n <= seuilBas ? 'bas' : (n <= seuilMoyen ? 'moyen' : 'haut'),
    titre: max === 10 ? `${n}/10 · ${n * 20} bars` : `Carburant ${n}/8`,
  };
}

/** Jauge horizontale (barre + valeur) ; `compacte` pour une cellule de tableau. */
function elementJauge(j, compacte = false) {
  const barre = document.createElement('span');
  barre.className = 'jauge-barre';
  const rempli = document.createElement('span');
  rempli.className = 'jauge-rempli';
  rempli.style.width = `${Math.max(0, Math.min(1, j.n / j.max)) * 100}%`;
  barre.append(rempli);
  const valeur = document.createElement('span');
  valeur.className = 'jauge-valeur';
  valeur.textContent = `${j.n}/${j.max}`;
  const racine = document.createElement('span');
  racine.className = `jauge jauge-${j.niveau}${compacte ? ' jauge-compacte' : ''}`;
  racine.setAttribute('role', 'meter');
  racine.setAttribute('aria-valuemin', '0');
  racine.setAttribute('aria-valuemax', String(j.max));
  racine.setAttribute('aria-valuenow', String(j.n));
  racine.setAttribute('aria-valuetext', j.titre);
  racine.title = j.titre;
  racine.append(barre, valeur);
  return racine;
}

/**
 * Réponses d'une check-list classées par rubrique : « Poste de conduite [Triangle] » → rubrique
 * « Poste de conduite », ligne « Triangle ». Sans crochets (kilométrage, carburant, obus…) : « Général », en tête.
 */
function rendreReponses(reponses) {
  const groupes = new Map([['Général', []]]);
  Object.entries(reponses || {}).forEach(([cle, valeur]) => {
    if (valeur === '' || valeur === null || valeur === undefined || cle.startsWith('Position (')) return;
    const m = /^(.*?)\s*\[(.*)\]\s*$/.exec(cle);
    const rubrique = m && m[1] ? m[1] : rubriqueSansCrochets(cle);
    if (!groupes.has(rubrique)) groupes.set(rubrique, []);
    groupes.get(rubrique).push({ libelle: m && m[1] ? m[2] : cle, valeur });
  });
  const racine = document.createElement('div');
  racine.className = 'reponses-rubriques';
  groupes.forEach((lignes, rubrique) => {
    if (!lignes.length) return;
    const section = document.createElement('section');
    section.className = 'reponses-rubrique';
    const titre = document.createElement('h4');
    titre.textContent = rubrique;
    const liste = document.createElement('dl');
    liste.className = 'reponses';
    lignes.forEach(({ libelle, valeur }) => {
      const ligne = document.createElement('div');
      ligne.className = `reponse${valeur === 'Manquant' ? ' manquant' : ''}`;
      const dt = document.createElement('dt');
      dt.textContent = libelle;
      const dd = document.createElement('dd');
      const j = niveauJauge(libelle, valeur);
      if (j) dd.append(elementJauge(j)); else dd.textContent = String(valeur);
      ligne.append(dt, dd);
      liste.append(ligne);
    });
    section.append(titre, liste);
    racine.append(section);
  });
  return racine;
}

// Valeurs aberrantes : on avertit l'utilisateur, qui confirme s'il est sûr de lui (jamais de blocage définitif).
const PLAUSIBLE = {
  kmMax: 500000, // au-delà : compteur mal lu ou faute de frappe
  kmMarge: 1000, // km autorisés d'un relevé à l'autre, en plus de…
  kmParJour: 600, // …ce nombre de km par jour écoulé
};

/** Texte d'avertissement si un kilométrage est invraisemblable ('' sinon). `precedent` : { km, date } du dernier relevé. */
function kmSuspect(valeur, precedent) {
  const n = Number(valeur);
  if (!(n > 0)) return '';
  const fr = (x) => Number(x).toLocaleString('fr-FR');
  if (n > PLAUSIBLE.kmMax) return `${fr(n)} km paraît trop élevé : vérifiez le compteur.`;
  if (precedent && precedent.km > 0 && n > precedent.km) {
    const jours = Math.max(1, Math.ceil((Date.now() - new Date(precedent.date)) / 86400000));
    const ecart = n - precedent.km;
    if (ecart > PLAUSIBLE.kmMarge + PLAUSIBLE.kmParJour * jours) {
      return `+${fr(ecart)} km depuis le dernier relevé (${jours} jour${jours > 1 ? 's' : ''}) : vérifiez le compteur.`;
    }
  }
  return '';
}

let VEHICULES = [
  { id: 'F21', modele: 'VML' },
  { id: 'F22', modele: 'VML' },
  { id: 'F28', modele: 'VML' },
  { id: 'F23', modele: 'UMH' },
  { id: 'F24', modele: 'UMH' },
  { id: 'F25', modele: 'UMH' },
  { id: 'F26', modele: 'UMH' },
  { id: 'F00', modele: 'F00', libelle: 'F00 · ambulance HELICO' },
  { id: 'COUVEUSE', modele: 'COUVEUSE', nom: 'Couveuse', type: '', picto: 'nourrisson', sansGarage: true, sansPlein: true, sansExterieur: true, sansNettoyage: true, sansKm: true },
];

/** Véhicule sans compteur : `sansKm`, ou couveuse / chariot ménage reconnus d'après leur pictogramme ou leur nom. */
function sansKilometrage(v) {
  return Boolean(v && (v.sansKm || v.picto === 'nourrisson' || /chariot|m[ée]nage|couveuse/i.test(`${v.nom || ''} ${v.id || ''}`)));
}

const ADBLUE = {
  type: 'choix',
  libelle: 'Ad-Blue',
  options: ['OK', 'Niveau à compléter'],
  requis: true,
  exclusPour: ['F28', 'F23', 'F24'],
  sinon: 'Véhicule non concerné par l\'AdBlue',
};
const FIN = [
  { type: 'fait', libelle: 'Entretien quotidien' },
  { type: 'kilometrage', libelle: 'Kilométrage', requis: true },
  { type: 'carburant', libelle: 'Carburant', requis: true },
  ADBLUE,
  { type: 'texte', libelle: 'Remarques' },
];

const BOITE_A_GANTS = {
  type: 'groupe',
  titre: 'Boîte à gants',
  items: ['Boîte à ampoules', 'Documents véhicule', 'Constat amiable'],
};

let MODELES = {
  VML: {
    titre: 'VML',
    questions: [
      { type: 'niveau', libelle: 'Obus 5 Litres n°1' },
      { type: 'niveau', libelle: 'Obus 5 Litres n°2' },
      {
        type: 'groupe',
        titre: 'Poste de conduite',
        items: [
          'Carte essence', 'GPS', 'Pass zone piétonne Avignon + clés', 'Pass zone piétonne Villeneuve',
          { libelle: 'Clé autoroute', colonne: 'Poste de conduite [CLE AUTORAOUTE]' },
          'Télépéage', 'Feux - gyro - deux tons', 'Lampe torche', 'Extincteur', '5 gilets de sécurité',
          'Triangle', 'Kit roue de secours',
        ],
      },
      BOITE_A_GANTS,
      {
        type: 'groupe',
        titre: 'Hygiène',
        items: ['Gants à usage unique', 'Gants de toilette', 'Détergent / désinfectant', 'Lingettes désinfectantes', 'Solution hydro-alcoolique'],
      },
      ...FIN,
    ],
  },

  UMH: {
    titre: 'UMH',
    questions: [
      {
        type: 'choix',
        libelle: 'Cette UMH fait-elle office de F00 aujourd\'hui (transferts DZ) ?',
        options: ['NON', 'OUI'],
        requis: true,
        // OUI : on remplit la check-list F00 avec cette UMH.
        // Question posée seulement si l'état du parc du jour n'est pas disponible :
        // sinon l'appli sait elle-même quelle UMH est en DZ.
        basculeF00: true,
      },
      { type: 'niveau', libelle: 'Obus 5 Litres n°1' },
      { type: 'niveau', libelle: 'Obus 5 Litres n°2' },
      { type: 'niveau', libelle: 'Obus 15 Litres' },
      // Seule F26 a une deuxième B15.
      { type: 'niveau', libelle: 'Obus 15 Litres (supplémentaire)', seulementPour: ['F26'] },
      { type: 'cache', libelle: 'Y-a-t-il un deuxième obus 15 Litres dans l\'UMH?', valeurs: { F26: 'OUI' }, defaut: 'NON' },
      {
        type: 'groupe',
        titre: 'Poste de conduite',
        items: [
          'Carte essence', 'GPS', 'Badge CHU Nord', 'Badge CHU Timone', 'Pass zone piétonne Avignon + clés',
          'Pass zone piétonne Villeneuve', 'Clé autoroute', 'Télépéage', 'Feux - gyro - deux tons', 'Lampe torche',
          'Extincteur', '5 gilets de sécurité', 'Triangle', 'Bombe anti-crevaison', 'Kit roue de secours',
        ],
      },
      BOITE_A_GANTS,
      {
        type: 'groupe',
        titre: 'Hygiène',
        items: ['Gants à usage unique', 'Gants de toilette', 'Détergent / désinfectant', 'Solution hydro-alcoolique', 'Lingettes désinfectantes'],
      },
      {
        type: 'groupe',
        titre: 'Cellule',
        items: ['Pied à perfusion', 'Tuyau et coquille', 'Portoir', 'Chaise de transport', 'Tablette', 'Draps / couverture bactériostatique'],
      },
      ...FIN,
    ],
  },

  // Couveuse : vérifiée à part. Ses bouteilles sont reportées dans la ligne F00 du jour
  // de l'ancien Sheet (libellés = noms de colonnes, ne pas les modifier).
  COUVEUSE: {
    titre: 'Couveuse',
    questions: [
      { type: 'niveau', libelle: 'Bouteille oxygène' },
      { type: 'niveau', libelle: 'Bouteille air' },
      { type: 'texte', libelle: 'Remarques' },
    ],
  },

  F00: {
    titre: 'F00 · ambulance HELICO',
    questions: [
      { type: 'niveau', libelle: 'Obus 5 Litres n°1' },
      { type: 'niveau', libelle: 'Obus 5 Litres n°2' },
      { type: 'niveau', libelle: 'Obus 15 Litres' },
      {
        type: 'groupe',
        titre: 'Équipement',
        items: [
          { libelle: 'Carte essence', colonne: 'Poste de conduite [CARTE ESSENCE]' },
          { libelle: 'Draps / couverture bactériostatique', colonne: '[DRAPS / COUVERTURE BACTERIOSTATIQUE]' },
        ],
      },
      ...FIN,
    ],
  },
};

/*
 * Configuration modifiée par un administrateur (écran « Configuration » de l'appli).
 * Elle est enregistrée sur le serveur et gardée sur l'appareil pour le hors ligne ;
 * elle remplace les véhicules et les questions ci-dessus. Sans elle, ce fichier s'applique.
 */
const CLE_CONFIG = 'avismur_config';
const CONFIG_DEFAUT = JSON.parse(JSON.stringify({ vehicules: VEHICULES, modeles: MODELES }));

function appliquerConfig(config) {
  const valide = config && Array.isArray(config.vehicules) && config.modeles && typeof config.modeles === 'object';
  const source = valide ? config : CONFIG_DEFAUT;
  VEHICULES = JSON.parse(JSON.stringify(source.vehicules));
  MODELES = JSON.parse(JSON.stringify(source.modeles));
}

try {
  appliquerConfig(JSON.parse(localStorage.getItem(CLE_CONFIG)));
} catch (e) {
  appliquerConfig(null);
}
