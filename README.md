# AVISMUR — front (PWA)

Check-lists du SMUR d'Avignon, servies par GitHub Pages. Fonctionne hors ligne : les check-lists sont gardées sur l'appareil puis envoyées au retour du réseau.

- `checklists.js` : véhicules et questions de la check-list ambulancier. **C'est ce fichier qu'on modifie** pour ajouter un véhicule ou un élément à vérifier.
- `ambulancier.js` : écran de la check-list ambulancier (brouillon gardé sur l'appareil jusqu'à l'envoi).
- `parc.js` : tableau de bord du parc (ordinateur, écran ≥ 1100 px) : menu « Véhicules » → cases empilées à gauche, tableau de tous les éléments des check-lists du jour au centre ; tableau limité aux véhicules disponibles ; clic sur un véhicule → fiche en pavés sans défilement (check-lists, kilométrage, pleins, garage, carrosserie, nettoyages) ; clic sur un pavé → historique détaillé (check-lists jour par jour ou entre deux dates, kilomètres par jour/mois/année, pleins, garage, nettoyages), action `historiquePlage` du backend (Historique.gs).
- `inventaires.js` : inventaires emboîtés des IADE (voir plus bas). `lib/qrcode.js` : génération des QR codes (bibliothèque « qrcode-generator », licence MIT), utilisable hors ligne.
- `app.js` : connexion, file d'attente hors ligne, envoi.
- `config.js` : URL de l'Apps Script (dépôt `AVISMUR-backend`).

À chaque mise à jour : incrémenter les `?v=` dans `index.html` et `CACHE` dans `sw.js` (mêmes valeurs dans la liste `FICHIERS`).

## Navigation

Menu principal (barre basse, une fois connecté) : **Aujourd'hui** (check-list du jour ; pour l'IADE, ses inventaires), **Véhicules** (ambulanciers et encadrement ; tableau de bord du parc sur ordinateur), **Inventaires** (encadrement et administrateurs), **Plus** (configuration pour les admins, déconnexion). Les entrées ne sont ajoutées que pour les fonctionnalités réellement disponibles. Chaque vue est gérée par `ouvrirVue()` dans `app.js`.

Règle pour toute nouvelle fonctionnalité :
1. Lui créer une entrée : dans la barre basse si elle est utilisée tous les jours, sinon dans « Plus ».
2. Ajouter au moins un lien depuis une fonctionnalité connexe, pour qu'on puisse y arriver sans passer par le menu.
3. Prévoir le retour : la vue doit permettre de revenir à « Aujourd'hui » ou à la vue d'origine.
4. Masquer l'entrée selon le rôle (l'IADE n'a pas de véhicule, la configuration est réservée aux admins).

Liens connexes à prévoir (fonctionnalités non encore développées) :

| Fonctionnalité | Liens depuis / vers |
|---|---|
| Fiche véhicule (tiroirs, sacs, carrosserie) | Véhicules ↔ Check-list du véhicule ; Matériel |
| Matériel et sacs (inventaire, péremptions, à récupérer) | Fiche véhicule ; Aujourd'hui (alerte de péremption) ; GeoTraceSMUR (localisation) |
| Carburant (plein, AdBlue, ticket) | Fiche véhicule ; compteur kilométrique de la check-list |
| Stupéfiants | Matériel ; Plus (accès restreint et journalisé) |
| Maintenance | Fiche véhicule ; Matériel ; Aujourd'hui (échéances) |
| Pilotage (cadre, chef d'unité) | Plus ; historiques par véhicule et par agent |

## Inventaires emboîtés (IADE)

Un inventaire est un arbre de contenants : sac > sacoche > pochette, intercalaire, tiroir… Chaque contenant a :

- une **photo** qui sert de plan, avec un **point numéroté** par sous-inventaire (toucher le point ouvre le sous-inventaire ; il passe au vert avec un ✓ une fois vérifié) ;
- une **liste d'articles à cocher**, une ligne par article, avec « Tout cocher » et la **quantité** dans un champ numérique, préremplie avec la quantité attendue (une quantité inférieure est notée manquante, ex. « Seringue (4/6) ») ;
- des **dates de péremption**, masquées par défaut : le bouton « Péremptions » les affiche, et un repère (⏳ bientôt, ! périmé, ? date à saisir) signale les articles concernés même quand elles sont masquées. Saisie au clavier numérique : `0327` → 03/2027, `15032027` → 15/03/2027 ;
- un **lien direct** `…/AVISMUR/#inv=<id>`, porté par son **QR code** et sa **puce NFC**. L'id ne change jamais : l'étiquette reste valable si le contenant est renommé.

**Vérifier** : ouvrir l'inventaire (liste, point sur la photo, QR code, puce NFC ou recherche), cocher, « Valider cet inventaire ». Chaque niveau se valide séparément ; l'état du jour remonte aux niveaux supérieurs (« 2 sur 3 vérifiés »). Un article non coché est noté manquant et rappelé le lendemain. Les péremptions dépassées ou proches (délai réglable, 30 jours par défaut) sont listées sur la page d'accueil des inventaires.

**Créer et modifier** (administrateurs) : bouton « Modifier ». Ajouter un inventaire, prendre sa photo, ajouter un sous-inventaire puis toucher la photo à son emplacement, saisir les articles (un par ligne, quantité après « x »), cocher « Péremption » pour les articles suivis. « Dupliquer » copie un inventaire avec tout son contenu (sacs identiques). « Imprimer l'étiquette QR » et « Écrire sur une puce NFC » (Chrome sur Android) se trouvent en bas de chaque inventaire en mode modification ; « Imprimer la liste » donne la liste papier d'un contenant et de ses sous-contenants.

**Hors ligne** : la structure et le dernier état connu sont gardés sur l'appareil (`localStorage`), les photos dans IndexedDB (téléchargées à la première ouverture en ligne). Une vérification validée hors ligne part par la file d'attente au retour du réseau ; les modifications d'un administrateur aussi.

Backend : `Inventaires.gs` (dépôt `AVISMUR-backend`). Tant qu'il n'est pas installé, l'appli l'indique et garde les modifications sur l'appareil.
