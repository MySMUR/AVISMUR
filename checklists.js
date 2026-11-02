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
 * `picto: 'nourrisson'` : pictogramme dessiné (couveuse) ; `icone` : emoji libre.
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

let VEHICULES = [
  { id: 'F21', modele: 'VML' },
  { id: 'F22', modele: 'VML' },
  { id: 'F28', modele: 'VML' },
  { id: 'F23', modele: 'UMH' },
  { id: 'F24', modele: 'UMH' },
  { id: 'F25', modele: 'UMH' },
  { id: 'F26', modele: 'UMH' },
  { id: 'F00', modele: 'F00', libelle: 'F00 · ambulance HELICO' },
  { id: 'COUVEUSE', modele: 'COUVEUSE', nom: 'Couveuse', type: '', picto: 'nourrisson', sansGarage: true, sansPlein: true, sansExterieur: true, sansNettoyage: true },
];

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
