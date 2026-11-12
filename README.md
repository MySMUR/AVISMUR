# AVISMUR — front (PWA)

Check-lists du SMUR d'Avignon, servies par GitHub Pages. Fonctionne hors ligne : les check-lists sont gardées sur l'appareil puis envoyées au retour du réseau.

- `checklists.js` : véhicules et questions de la check-list ambulancier. **C'est ce fichier qu'on modifie** pour ajouter un véhicule ou un élément à vérifier.
- `ambulancier.js` : écran de la check-list ambulancier (brouillon gardé sur l'appareil jusqu'à l'envoi).
- `parc.js` : tableau de bord du parc (ordinateur, écran ≥ 1100 px) : menu Véhicules > Check-list ambulancier → cases empilées à gauche, tableau de tous les éléments des check-lists du jour au centre ; tableau limité aux véhicules disponibles ; clic sur un véhicule → fiche en pavés sans défilement (check-lists, kilométrage, pleins, garage, carrosserie, nettoyages) ; clic sur un pavé → historique détaillé (check-lists jour par jour ou entre deux dates, kilomètres par jour/mois/année, pleins, garage, nettoyages), action `historiquePlage` du backend (Historique.gs).
- `inventaires.js` : inventaires emboîtés des IADE (voir plus bas). `lib/qrcode.js` : génération des QR codes (bibliothèque « qrcode-generator », licence MIT), utilisable hors ligne.
- `infos.js` : page d'accueil, mur d'informations et rappels, notifications push (voir plus bas).
- `app.js` : connexion, file d'attente hors ligne, envoi.
- `sw.js` : service worker (hors ligne, réception et clic des notifications push).
- `config.js` : URL de l'Apps Script (dépôt `AVISMUR-backend`).

À chaque mise à jour : incrémenter les `?v=` dans `index.html` et `CACHE` dans `sw.js` (mêmes valeurs dans la liste `FICHIERS`).

## Navigation

Bandeau du haut, une fois connecté : nom prénom et fonction de l'agent, et le **menu burger** en haut à droite. La fonction vient du champ `fonction` renvoyé par le serveur (colonne « Fonction » de DB_SMUR) ; tant que le backend ne l'envoie pas, elle est déduite du rôle (Ambulancier, IADE, Encadrement, Administrateur). De même, `nom` et `prenom` sont utilisés s'ils sont renvoyés, sinon l'`identifiant`.

Menu (tiroir à droite, `<dialog id="menu">` dans `index.html`) : les titres de rubrique restent visibles et se déplient en accordéon (une seule rubrique ouverte à la fois ; à l'ouverture du menu, celle de la page en cours) :

- **Accueil** : mur d'informations et rappels (page d'arrivée après la connexion). La check-list du jour reste accessible par Véhicules > Check-list ambulancier, Inventaires > Check-list, ou les liens en bas du mur.
- **Véhicules** (ambulanciers, encadrement, admins) : Check-list ambulancier (tableau de bord du parc sur ordinateur), Commande d'oxygène *(à venir)*, Carburant, Carrosserie, Suivi mécanique. Carburant, Carrosserie et Suivi mécanique affichent les cases des véhicules ; toucher un véhicule ouvre directement l'écran du plein, de la vérification extérieure ou du passage au garage (`Ambulancier.choisirMode()`, `Actions.ouvrirAction()`).
- **Inventaires** (IADE, encadrement, admins) : Check-list (inventaires emboîtés), Suivi matériel, Stupéfiants, Stérilisation *(à venir)*.
- **Administration** (admins) : Configuration (véhicules et questions des check-lists), Base des articles, Types d'informations (mur d'accueil).
- **Se déconnecter**, en bas du menu.

Chaque lien porte un `data-vue` ; la vue est ouverte par `ouvrirVue()` dans `app.js`. Une sous-rubrique pas encore développée porte la classe `a-venir` et `aria-disabled="true"` (étiquette « À venir ») : pour l'activer, lui donner un `data-vue` et gérer la vue dans `ouvrirVue()`.

Règle pour toute nouvelle fonctionnalité :
1. Lui créer une entrée dans la bonne rubrique du menu (ou une nouvelle rubrique `<section class="rubrique">`).
2. Ajouter au moins un lien depuis une fonctionnalité connexe, pour qu'on puisse y arriver sans passer par le menu.
3. Prévoir le retour : la vue doit permettre de revenir à « Aujourd'hui » ou à la vue d'origine.
4. Masquer l'entrée selon le rôle (l'IADE n'a pas de véhicule, la configuration est réservée aux admins).

Liens connexes à prévoir (fonctionnalités non encore développées) :

| Fonctionnalité | Liens depuis / vers |
|---|---|
| Fiche véhicule (tiroirs, sacs, carrosserie) | Véhicules ↔ Check-list du véhicule ; Matériel |
| Matériel et sacs (inventaire, péremptions, à récupérer) | Fiche véhicule ; Aujourd'hui (alerte de péremption) ; GeoTraceSMUR (localisation) |
| Carburant (plein, AdBlue, ticket) | Fiche véhicule ; compteur kilométrique de la check-list |
| Stupéfiants | Matériel ; Inventaires > Stupéfiants (accès restreint et journalisé) |
| Maintenance | Fiche véhicule ; Matériel ; Aujourd'hui (échéances) |
| Pilotage (cadre, chef d'unité) | Menu (rubrique à créer) ; historiques par véhicule et par agent |

## Mur d'informations (page d'accueil)

Chaque agent peut publier une information, une alerte ou un rappel (bouton « Nouvelle information ») :

- **Type** : Consigne, Véhicule, Panne, Accident, Matériel à rendre, Matériel à récupérer, Information… Liste gérée par les administrateurs (menu Administration > Types d'informations : nom, pictogramme, ordre, importance proposée par défaut, archivage). Un type déjà utilisé n'est jamais supprimé, il est archivé.
- **Importance**, avec un code couleur : **urgente** (rouge, en tête du mur, notification qui reste affichée), **importante** (orange), **normale** (bleu). Proposée selon le type, modifiable.
- **Période** : début (aujourd'hui par défaut), fin facultative (sans fin, l'information reste jusqu'à ce que quelqu'un y mette fin). Raccourcis « Aujourd'hui seulement », « Une semaine », « Sans date de fin ».
- **Destinataires** : Ambulanciers, IADE, Encadrement (tous cochés par défaut).

Classement : **Urgent**, puis **En cours** (importantes d'abord, puis celles dont c'est le dernier jour, puis les plus récentes), **À venir** (par date de début), **Terminées cette semaine** (repliées). Filtres : « Pour moi » (selon le métier de l'agent ; « Tout le service » par défaut pour l'encadrement) et par type.

**Mettre fin** : tout le monde peut mettre fin à une information jugée obsolète (« Plus d'actualité », avec confirmation) ; le nom de la personne est noté.

**Hors ligne** : le dernier mur reçu est gardé sur l'appareil ; une publication ou une fin passe par la file d'attente (« En attente d'envoi » sur la carte). Une publication pas encore envoyée peut être annulée.

### Notifications push

Chaque publication est notifiée aux appareils des destinataires (pas à l'auteur). Un rappel dont la période commence plus tard est notifié le jour du début, vers 7 h. Toucher la notification ouvre l'appli sur l'information (lien `…/#info=<id>`).

- L'agent active les notifications une fois par appareil (encart « Recevez les alertes sur cet appareil » en haut du mur). L'appareil se réabonne ensuite seul à chaque ouverture ; la déconnexion le désabonne.
- **Android** (Chrome) et ordinateur : fonctionne dans le navigateur ou l'appli installée.
- **iPhone** (iOS 16.4 ou plus) : uniquement avec l'appli installée sur l'écran d'accueil (Partager > Sur l'écran d'accueil) ; l'encart l'explique.
- Notifications bloquées : l'encart indique de les autoriser dans les réglages du navigateur.

Standard Web Push, sans Firebase ni serveur supplémentaire : l'envoi est fait par l'Apps Script (Push.gs).

## Inventaires emboîtés (IADE)

Un inventaire est un arbre de contenants : sac > sacoche > pochette, intercalaire, tiroir… Chaque contenant a :

- une **photo** qui sert de plan, avec un **point numéroté** par sous-inventaire (toucher le point ouvre le sous-inventaire ; il passe au vert avec un ✓ une fois vérifié) ;
- une **liste d'articles à cocher**, une ligne par article, avec « Tout cocher » et la **quantité** dans un champ numérique, préremplie avec la quantité attendue (une quantité inférieure est notée manquante, ex. « Seringue (4/6) ») ;
- des **séparations** pour regrouper la liste (ex. « Seringues », « Cathéters ») : bouton « Ajouter une séparation », ou ligne commençant par `#` dans la saisie des articles. Chaque groupe a son bouton « Cocher » ;
- des **dates de péremption**, masquées par défaut : le bouton « Péremptions » les affiche, et un repère (⏳ bientôt, ! périmé, ? date à saisir) signale les articles concernés même quand elles sont masquées. Saisie au clavier numérique : `0327` → 03/2027, `15032027` → 15/03/2027 ;
- une case **« Contenant scellable »** (Gestion des inventaires) pour les contenants fermés par un scellé (plomb) une fois vérifiés ; ils portent l'étiquette « Scellable » ;
- un **lien direct** `…/AVISMUR/#inv=<id>`, porté par son **QR code** et sa **puce NFC**. L'id ne change jamais : l'étiquette reste valable si le contenant est renommé.

**Vérifier** : ouvrir l'inventaire (liste, point sur la photo, QR code, puce NFC ou recherche), cocher, « Valider cet inventaire ». Chaque niveau se valide séparément ; l'état du jour remonte aux niveaux supérieurs (« 2 sur 3 vérifiés »). Un article non coché est noté manquant et rappelé le lendemain. Les péremptions dépassées ou proches (délai réglable, 30 jours par défaut) sont listées sur la page d'accueil des inventaires.

**Base des articles** : chaque article est décrit une seule fois (dénomination, catégorie Médicament / DM / Magasin / Kit / Biomédical / Autre, réf. interne, réf. fournisseur, consommable, périssable, dotation hors stock). En ajoutant un article à un inventaire, on le cherche dans la base par son nom ou sa référence ; s'il n'y est pas, « Créer … dans la base » ouvre sa fiche, puis l'ajoute. La péremption est suivie pour les articles « périssables ». Page « Base des articles » (lien en haut des inventaires) : recherche, filtre par catégorie, modification des fiches, inventaires où chaque article est utilisé, archivage. Lecture seule pour les agents, modification par les administrateurs. Un article ajouté avant la base apparaît « Pas dans la base des articles » avec un bouton « Rattacher ».

**Créer et modifier** (administrateurs) : menu > Administration > **Gestion des inventaires**. Les inventaires s'y ouvrent directement en modification, et on reste dans ce mode en naviguant (y compris après un rechargement de la page) ; pour réaliser un inventaire, on repasse par le menu › Inventaires. La check-list (menu > Inventaires) n'a plus de bouton « Modifier ». Ajouter un inventaire, prendre sa photo, ajouter un sous-inventaire puis toucher la photo à son emplacement, ajouter les articles depuis la base et indiquer la quantité attendue. Pour réorganiser, attraper la poignée ⠿ d'un article, d'une séparation ou d'un sous-inventaire et la glisser (souris ou doigt ; au clavier : flèches haut et bas sur la poignée). « Dupliquer » copie un inventaire avec tout son contenu (sacs identiques). « Imprimer l'étiquette QR » et « Écrire sur une puce NFC » (Chrome sur Android) se trouvent en bas de chaque inventaire en mode modification ; « Imprimer la liste » donne la liste papier d'un contenant et de ses sous-contenants.

**Hors ligne** : la structure et le dernier état connu sont gardés sur l'appareil (`localStorage`), les photos dans IndexedDB (téléchargées à la première ouverture en ligne). Une vérification validée hors ligne part par la file d'attente au retour du réseau ; les modifications d'un administrateur aussi.

Backend : `Inventaires.gs` (dépôt `AVISMUR-backend`). Tant qu'il n'est pas installé, l'appli l'indique et garde les modifications sur l'appareil.

### Inventaires types (sacs identiques)

Case **« Inventaire type »** (mode Modifier, sur un inventaire de premier niveau) : l'inventaire devient le modèle d'une série de contenants identiques, par exemple les 7 sacs d'intervention. Il ne se vérifie pas et n'est visible que des administrateurs (section « Inventaires types »).

- **Créer des exemplaires** : en bas du bloc « Inventaire type », nombre puis « Créer ». Chaque exemplaire est une copie complète (photos, points, sous-inventaires, articles), avec son propre nom, son QR code et ses vérifications.
- **Répercuter** : après avoir modifié le type (ou un de ses sous-inventaires), « Répercuter sur les exemplaires cochés ». Rien ne part tout seul.
- **Personnaliser un sac** : on modifie l'exemplaire directement (quantité, article ajouté ou retiré, photo…). Cela ne touche pas les autres sacs, et la répercussion conserve ces personnalisations : un champ modifié dans le sac garde sa valeur ; ce qui n'a pas été modifié suit le type. En gestion des inventaires, un exemplaire indique ce qui est personnalisé, avec « Revenir au modèle ».

Données : un contenant d'exemplaire porte `source` (le contenant du type qu'il copie) et `base` (l'état du type lors de la dernière répercussion), dans la colonne « données » de l'onglet `Inventaires`.

**Photos des articles** : chaque fiche de la base peut avoir une photo (fiche > Photo). Dans la liste à cocher, une vignette apparaît devant l'article ; la toucher affiche la photo en grand et les informations de la fiche.

### Catégories de contenants et accès

En gestion des inventaires, chaque contenant a une **catégorie** : **Primaire** (véhicule, réserve), **Immobile** (tiroir, placard : ne change pas de place) ou **Mobile** (sac, sacoche, ampoulier : peut changer de véhicule). La page des inventaires ne montre que les **contenants primaires** ; les inventaires de premier niveau sans catégorie apparaissent aux administrateurs dans « À classer ».

Tous les autres s'atteignent par l'encadré **« Trouver un inventaire »** en tête de page : saisie du nom (sur le nom du contenant seulement : « sac rouge » trouve les sacs rouges, pas leurs sous-inventaires), **Scanner un QR code** (caméra, Chrome sur Android) ou **Lire une puce NFC** (Chrome sur Android). Sur les autres appareils, l'appareil photo du téléphone lit le QR code et ouvre directement l'inventaire.

### Plusieurs vues d'un contenant primaire

Un contenant **primaire** (pièce, cellule sanitaire…) peut avoir plusieurs photos, sous plusieurs angles. En gestion des inventaires, « **＋ Vue** » ajoute une vue ; chaque vue a un nom (ex. « Côté gauche »), sa photo et ses propres gommettes. Un sous-inventaire peut être placé sur plusieurs vues (« aussi sur : … »). En check-list, les vues s'affichent en onglets au-dessus de la photo, avec le nombre de gommettes de chacune.

### Contenant mobile dans un autre (ex. ampoulier dans un sac)

En check-list, ouvrir un contenant **mobile** depuis son contenant (gommette ou liste) affiche d'abord « **Quel … se trouve ici ?** » : l'agent identifie celui qui est réellement là (QR code, puce NFC ou liste ; ceux du même type sont proposés d'emblée). Puis l'inventaire continue sur ce contenant, avec ses propres articles et péremptions.

- **Ce n'est pas celui prévu** : le contenant identifié prend la place (gommette comprise) et quitte son ancien contenant, où sa gommette reste comme **place libre**. Celui qui était prévu est **désaffecté** : il n'est plus rangé nulle part.
- **À retrouver** : tant qu'un contenant est désaffecté (perte possible), un encadré rouge « contenant mobile à retrouver » s'affiche en tête de la page des inventaires, avec où il était, depuis quand et qui l'a constaté.
- **Prévenir l'équipe** : « Publier une alerte sur le mur » (dans l'encadré ou sur la page du contenant) ouvre le formulaire du mur d'accueil pré-rempli (type « Matériel à récupérer », importance « Importante », titre et détails) ; l'agent ajoute son commentaire libre avant de publier.
- **Le retrouver** : dans la check-list du contenant où il se trouve, « **＋ Un contenant mobile se trouve ici** », puis l'identifier (les désaffectés sont proposés d'emblée). Il y est rangé et reprend la place libre (gommette).

Fonctionne hors ligne (file d'attente) ; chaque mouvement est noté dans l'onglet `Mouvements`. En gestion des inventaires, pas d'identification : on modifie la structure.

### Emplacements (ex. un « Ampoulier A » attendu dans chaque sac)

En gestion des inventaires, dans un contenant (souvent un inventaire type de sac) : « + » puis « **Ou ajouter un emplacement pour un contenant mobile** » et choisir l'inventaire type attendu (ex. Ampoulier A). L'emplacement apparaît comme un sous-inventaire (étiquette « Emplacement »), avec sa gommette ; il est recopié dans les exemplaires du sac.

En check-list, l'emplacement affiche l'exemplaire qui l'occupe (« ↳ Ampoulier A n°3 ») ou « à identifier » (compté dans l'avancement du sac). Le toucher demande « Quel « Ampoulier A » se trouve ici ? » : seuls les exemplaires de ce type sont proposés et acceptés (QR code, NFC ou liste). L'exemplaire identifié est rangé dans l'emplacement et son inventaire s'ouvre. Si un autre exemplaire occupait l'emplacement, il est désaffecté (à retrouver), comme pour tout contenant mobile.

### Arborescence (ordinateur)

Sur grand écran (à partir de 1100 px de large), la page d'un inventaire affiche à droite l'arborescence de l'inventaire type ou du contenant primaire dans lequel on travaille : le contenant affiché est en surbrillance, les branches sur son chemin sont dépliées, un clic ouvre un contenant (en gestion comme en check-list). En check-list, une pastille indique l'état (vert : vérifié, orange : à vérifier) ; le nombre à droite est celui des articles à cocher. Masquée sur téléphone et tablette.

### Contenant scellable : « Ce contenant est-il scellé ? »

En check-list, un contenant **scellable** pas encore vérifié aujourd'hui demande d'abord s'il est scellé :
- **Oui, il est scellé** : son inventaire et celui de tout ce qu'il contient sont validés sur la base du dernier réalisé (mêmes articles présents ou manquants, mêmes dates de péremption connues), avec la remarque « Scellé : validé sur la base de l'inventaire du … ». Impossible si un des contenants n'a jamais été vérifié ou si un emplacement est vide : il faut alors faire l'inventaire complet.
- **Non, il est ouvert** : l'inventaire se fait normalement.

### Contrôles dans les inventaires

En gestion, « Ajouter un contrôle » insère une ligne qui se relève au lieu de se cocher :

- **À scanner / renseigner** : n° de série (matériel biomédical…), scanné (QR / code-barres), lu sur une puce NFC (texte, lien ou à défaut n° de série de la puce) ou saisi ; valeur attendue facultative. Le dernier n° relevé est pré-rempli.
- **Température** : en °C, plage min/max (2 à 8 °C par défaut).
- **Niveau de batterie** : en % ou de 0 à 4, avec un seuil (50 % ou 2/4 par défaut).
- **Oui / Non** : branchement secteur, appairage réussi, test effectué…
- **Mesure** : nombre avec unité (bar, L…) et plage.

Hors plage, « Non », valeur différente de l'attendue ou non renseigné : la ligne passe en rouge et est notée en anomalie (avec sa valeur) à la validation. « Tout cocher » ne touche que les cases. Les valeurs sont enregistrées dans InventairesVerifs et reprises par un scellé.

### Barre QR code / NFC (téléphone)

Sur téléphone (écran ≤ 760 px), une fois connecté, deux boutons restent fixés en bas de l'écran dans les inventaires (check-list uniquement, pas en gestion) : **QR code** et **NFC**. Ils ouvrent directement l'inventaire scanné. La barre est masquée sur ordinateur et pendant qu'une caméra ou une fenêtre est ouverte.
