/**
 * Appareil photo de l'application, utilisé pour toutes les prises de vue (fiches d'articles, inventaires,
 * matériel, défauts…), à la place de l'appareil photo du téléphone.
 *
 * Tout champ <input type="file" capture> de l'appli est intercepté : au lieu d'ouvrir l'appareil photo
 * du téléphone, on ouvre celui de l'appli (bouton ✨ Détourer visible dès la prise de vue, lampe, choix
 * d'une image enregistrée). La photo prise est remise dans le champ comme si le téléphone l'avait
 * fournie : le reste du code (recadrage, enregistrement) ne change pas.
 *
 * Si la caméra est inaccessible (refus, navigateur ancien), l'appareil photo du téléphone est ouvert
 * comme avant.
 *
 * Camera.photo({ titre }) → Promise<File|null> : prise de vue directe (null si annulé).
 */
const Camera = (() => {
  function el(balise, attributs = {}, ...enfants) {
    const n = document.createElement(balise);
    Object.entries(attributs).forEach(([cle, v]) => {
      if (v === undefined || v === null || v === false) return;
      if (cle === 'classe') n.className = v;
      else if (cle === 'texte') n.textContent = v;
      else if (cle === 'surclick') n.addEventListener('click', v);
      else n.setAttribute(cle, v === true ? '' : v);
    });
    enfants.flat().filter(Boolean).forEach((e) => n.append(e));
    return n;
  }
  const dispo = () => Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const detourageDispo = () => typeof Detourage !== 'undefined' && typeof Recadrage !== 'undefined' && Recadrage.memoriserDetourage;

  /** Ouvre l'appareil photo de l'appli. Résout un File (JPEG) ou null si annulé ; rejette si pas de caméra. */
  function photo({ titre = 'Prendre une photo' } = {}) {
    return new Promise((ok, ko) => {
      if (!dispo()) { ko(new Error('caméra')); return; }
      let flux = null;
      let fini = false;
      let torche = false;
      const video = el('video', { playsinline: '', muted: '', autoplay: '' });
      video.muted = true;
      const vue = el('div', { classe: 'camera-vue appareil-vue' }, video);
      const declencheur = el('button', { type: 'button', classe: 'inv-rafale-declencheur', 'aria-label': 'Prendre la photo', disabled: true }, el('span'));
      const galerie = el('input', { type: 'file', accept: 'image/*', classe: 'invisible' });
      const boutonGalerie = el('button', { type: 'button', classe: 'inv-vrac-outil', title: 'Choisir une image', 'aria-label': 'Choisir une image enregistrée', texte: '🖼' });
      const boutonDetourage = el('button', { type: 'button', classe: 'inv-vrac-outil', title: 'Détourage automatique (objet posé sur un fond uni)', hidden: !detourageDispo(), texte: '✨' });
      const boutonTorche = el('button', { type: 'button', classe: 'inv-vrac-outil', title: 'Lampe', 'aria-label': 'Allumer la lampe', 'aria-pressed': 'false', hidden: true, texte: '🔦' });
      const fermerBouton = el('button', { type: 'button', classe: 'inv-vrac-outil', 'aria-label': 'Fermer sans photo', texte: '✕' });
      const aide = el('p', { classe: 'lecture', role: 'status' });
      const majDetourage = () => {
        if (!detourageDispo()) return;
        const oui = Recadrage.detourageVoulu();
        boutonDetourage.setAttribute('aria-pressed', String(oui));
        boutonDetourage.setAttribute('aria-label', oui ? 'Détourage automatique activé : appuyer pour le couper' : 'Détourage automatique coupé : appuyer pour l\'activer');
        aide.textContent = oui ? '✨ Détourage activé : posez l\'objet sur un fond uni et contrasté.' : 'Cadrez puis déclenchez.';
      };
      // <dialog> modal : passe au-dessus de toute fenêtre déjà ouverte (fiche matériel…).
      const ecran = el('dialog', { classe: 'camera appareil', 'aria-label': titre },
        el('div', { classe: 'inv-vrac-haut' },
          el('div', { classe: 'inv-vrac-titre' }, el('strong', { texte: titre })),
          boutonTorche, boutonDetourage, fermerBouton),
        vue,
        el('div', { classe: 'inv-rafale-commandes' }, boutonGalerie, declencheur, el('span', { classe: 'inv-rafale-vide' })),
        aide, galerie);
      const fermer = (resultat) => {
        if (fini) return;
        fini = true;
        if (flux) flux.getTracks().forEach((t) => t.stop());
        document.removeEventListener('keydown', clavier, true);
        if (ecran.open) ecran.close();
        ecran.remove();
        document.body.classList.remove('camera-ouverte');
        ok(resultat);
      };
      const clavier = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fermer(null); }
      };
      declencheur.addEventListener('click', () => {
        if (!video.videoWidth) return;
        const toile = document.createElement('canvas');
        toile.width = video.videoWidth;
        toile.height = video.videoHeight;
        toile.getContext('2d').drawImage(video, 0, 0);
        vue.classList.add('flash');
        toile.toBlob((b) => fermer(b ? new File([b], `photo-${Date.now()}.jpg`, { type: 'image/jpeg' }) : null), 'image/jpeg', 0.92);
      });
      boutonGalerie.addEventListener('click', () => galerie.click());
      galerie.addEventListener('change', () => { if (galerie.files[0]) fermer(galerie.files[0]); });
      boutonDetourage.addEventListener('click', () => { Recadrage.memoriserDetourage(!Recadrage.detourageVoulu()); majDetourage(); });
      boutonTorche.addEventListener('click', async () => {
        const piste = flux && flux.getVideoTracks()[0];
        if (!piste) return;
        try {
          torche = !torche;
          await piste.applyConstraints({ advanced: [{ torch: torche }] });
          boutonTorche.setAttribute('aria-pressed', String(torche));
        } catch (e) { torche = false; }
      });
      fermerBouton.addEventListener('click', () => fermer(null));
      document.addEventListener('keydown', clavier, true);
      navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false })
        .then((f) => {
          if (fini) { f.getTracks().forEach((t) => t.stop()); return; }
          flux = f;
          video.srcObject = f;
          video.addEventListener('loadeddata', () => { declencheur.disabled = false; declencheur.focus(); }, { once: true });
          const piste = f.getVideoTracks()[0];
          const capacites = piste && piste.getCapabilities ? piste.getCapabilities() : {};
          boutonTorche.hidden = !capacites.torch;
        })
        .catch((e) => {
          // Caméra refusée ou absente : on rend la main pour ouvrir l'appareil photo du téléphone.
          fini = true;
          document.removeEventListener('keydown', clavier, true);
          if (ecran.open) ecran.close();
          ecran.remove();
          document.body.classList.remove('camera-ouverte');
          ko(e);
        });
      ecran.addEventListener('cancel', (e) => { e.preventDefault(); fermer(null); }); // retour Android
      document.body.append(ecran);
      if (ecran.showModal) ecran.showModal();
      document.body.classList.add('camera-ouverte');
      majDetourage();
    });
  }

  // Interception des champs « prendre une photo » de toute l'appli (clic direct, via un <label> ou input.click()).
  document.addEventListener('click', (e) => {
    const champ = e.target;
    if (!(champ instanceof HTMLInputElement) || champ.type !== 'file' || !champ.hasAttribute('capture')) return;
    if (champ.dataset.natif === '1' || !dispo()) return;
    e.preventDefault();
    photo({ titre: champ.getAttribute('aria-label') || champ.title || 'Prendre une photo' }).then((fichier) => {
      if (!fichier) return;
      try {
        const dt = new DataTransfer();
        dt.items.add(fichier);
        champ.files = dt.files;
        champ.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (err) { /* navigateur trop ancien : rien */ }
    }).catch(() => {
      champ.dataset.natif = '1';
      champ.click();
      setTimeout(() => { delete champ.dataset.natif; }, 0);
    });
  }, true);

  return { photo };
})();
