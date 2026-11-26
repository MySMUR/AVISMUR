/*
 * Lecteur de codes branché sur l'ordinateur (« scannette ») : il tape le contenu du QR code / code-barres
 * comme un clavier, puis Entrée. Sur ordinateur, les écrans de lecture affichent ce champ à la place de la caméra.
 */
const Scannette = (() => {
  /** Ordinateur (souris, pas d'écran tactile principal) : pas de caméra arrière pour viser une étiquette. */
  const ordinateur = () => window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  /**
   * Champ de saisie prêt à recevoir la scannette. surLu(texte) est appelé à Entrée (ou au bouton Valider).
   * Renvoie l'élément ; appeler .focus() sur son champ une fois affiché (fait par focusChamp).
   */
  function champ(surLu, consigne = 'Scannez l\'étiquette avec le lecteur (ou tapez le code), puis Entrée.') {
    const entree = document.createElement('input');
    entree.type = 'text';
    entree.className = 'scannette-champ';
    entree.autocomplete = 'off';
    entree.spellcheck = false;
    entree.setAttribute('aria-label', 'Code scanné');
    entree.placeholder = 'En attente du lecteur…';
    const valider = document.createElement('button');
    valider.type = 'button';
    valider.className = 'principal scannette-valider';
    valider.textContent = 'Valider';
    const envoyer = () => {
      const t = entree.value.trim();
      if (!t) { entree.focus(); return; }
      entree.value = '';
      surLu(t);
      entree.focus();
    };
    entree.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); envoyer(); } });
    valider.addEventListener('click', envoyer);
    const bloc = document.createElement('div');
    bloc.className = 'scannette';
    const p = document.createElement('p');
    p.className = 'scannette-consigne';
    p.textContent = consigne;
    const ligne = document.createElement('div');
    ligne.className = 'scannette-ligne';
    ligne.append(entree, valider);
    bloc.append(p, ligne);
    return bloc;
  }
  const focusChamp = (racine) => setTimeout(() => { const c = racine.querySelector('.scannette-champ'); if (c) c.focus(); }, 50);

  /** Vibration douce à chaque lecture d'un QR code, d'un code-barres ou d'une puce NFC (sans effet si le téléphone ne vibre pas). */
  const vibrer = () => { try { if (navigator.vibrate) navigator.vibrate(30); } catch (e) { /* rien */ } };

  return { ordinateur, champ, focusChamp, vibrer };
})();
