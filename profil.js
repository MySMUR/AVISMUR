/**
 * « Mon profil » (menu burger) : chaque agent gère son propre compte (backend : Profil.gs).
 *   - Coordonnées : téléphone (vérifié par un code SMS, il sert aux SMS de connexion), adresse mail.
 *   - Partage du numéro : avec les autres utilisateurs (annuaire du personnel) et avec l'application (SMS d'alerte, de rappel).
 *   - Notifications push : activer ou désactiver sur cet appareil, retirer un ancien appareil.
 *   - Mot de passe : changement (les autres appareils sont déconnectés, celui-ci reste connecté).
 *
 * Hors ligne : le profil connu est affiché (gardé sur l'appareil). Le mail et les choix de partage sont mis en
 * file d'attente et envoyés au retour du réseau ; le téléphone et le mot de passe nécessitent le réseau.
 */
const Profil = (() => {
  let zone;
  let App = {};
  let profil = null;     // dernier profil reçu du serveur
  let chargementEnCours = false;
  let erreurChargement = '';
  let etatNotif = '';    // voir Infos.etatNotifications()
  let finAppareil = '';  // fin de l'adresse d'abonnement push de cet appareil
  let telephone = { etape: '', numero: '', message: '', classe: '' }; // étape : '' | 'saisie' | 'code'
  const messages = {};   // message de chaque bloc : { texte, classe }
  const CLE = 'avismur_profil';

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
  let compteurId = 0;
  const nouvelId = () => `pro-${++compteurId}`;

  const telFr = (t) => String(t || '').replace(/^\+33/, '0').replace(/(\d{2})(?=\d)/g, '$1 ');
  const dateFr = (iso) => (iso ? iso.split('-').reverse().join('/') : '');

  // ---------- Cache sur l'appareil (affichage hors ligne) ----------
  function lireCache() {
    try {
      const c = JSON.parse(localStorage.getItem(CLE));
      return c && c.identifiant === App.identifiant() ? c : null;
    } catch (e) { return null; }
  }
  function ecrireCache() {
    try { if (profil) localStorage.setItem(CLE, JSON.stringify(profil)); } catch (e) { /* stockage plein */ }
  }

  function dire(bloc, texte, classe = '') {
    messages[bloc] = { texte, classe };
    const p = zone.querySelector(`[data-message="${bloc}"]`);
    if (p) { p.textContent = texte; p.className = `message ${classe}`.trim(); }
  }
  const zoneMessage = (bloc) => el('p', {
    classe: `message ${(messages[bloc] || {}).classe || ''}`.trim(), role: 'status', 'data-message': bloc, texte: (messages[bloc] || {}).texte || '',
  });

  const reseauKo = (err) => (err && err.serveur ? err.message : 'Pas de réseau : réessayez une fois connecté.');

  // ---------- Chargement ----------
  async function charger() {
    chargementEnCours = true;
    erreurChargement = '';
    rendre();
    try {
      const rep = await App.appeler('lireProfil');
      if (rep.ok) {
        profil = rep.profil;
        ecrireCache();
      } else if (rep.erreur) {
        erreurChargement = /Action inconnue/.test(rep.erreur) ? 'Le serveur n\'est pas encore à jour (fichier Profil.gs à ajouter dans Apps Script).' : rep.erreur;
      }
    } catch (err) {
      erreurChargement = profil ? 'Hors ligne : profil affiché tel que connu sur cet appareil.' : reseauKo(err);
    }
    chargementEnCours = false;
    await majNotifications();
    rendre();
  }

  async function majNotifications() {
    etatNotif = await App.etatNotifications();
    finAppareil = await App.finAbonnement();
  }

  // ---------- Préférences (mail, partage) : directes en ligne, en file d'attente sinon ----------
  async function enregistrerPreferences(changes, bloc, texteOk) {
    Object.assign(profil, changes);
    ecrireCache();
    dire(bloc, 'Enregistrement…');
    try {
      const rep = await App.appeler('enregistrerProfil', changes);
      if (rep.ok) {
        profil = rep.profil;
        ecrireCache();
        dire(bloc, texteOk, 'succes');
      } else {
        dire(bloc, rep.erreur || 'Refusé par le serveur.', 'erreur');
        charger();
      }
    } catch (err) {
      if (err && err.serveur) { dire(bloc, err.message, 'erreur'); return; }
      App.mettreEnFile({ action: 'enregistrerProfil', donnees: changes });
      dire(bloc, 'Hors ligne : gardé sur cet appareil, envoyé au retour du réseau.');
    }
  }

  // ---------- Blocs ----------
  function blocIdentite() {
    return el('section', { classe: 'pro-carte pro-identite' },
      el('div', { classe: 'pro-avatar', 'aria-hidden': 'true', texte: initiales(profil.nom) }),
      el('div', {},
        el('p', { classe: 'pro-nom', texte: profil.nom }),
        el('p', { classe: 'pro-fonction', texte: profil.fonction }),
        el('p', { classe: 'pro-cri', texte: `${profil.etudiant ? 'Identifiant' : 'Code CRI'} : ${profil.identifiant}` })));
  }
  const initiales = (nom) => String(nom || '').split(/[\s-]+/).filter(Boolean).slice(0, 2).map((m) => m[0]).join('').toUpperCase();

  function blocCoordonnees() {
    const idMail = nouvelId();
    const champMail = el('input', {
      id: idMail, type: 'email', inputmode: 'email', autocomplete: 'email', autocapitalize: 'none', spellcheck: 'false',
      valeur: profil.mail || '', placeholder: 'prenom.nom@ch-avignon.fr', maxlength: '120',
    });
    return el('section', { classe: 'pro-carte', 'aria-labelledby': 'pro-titre-coord' },
      el('h2', { id: 'pro-titre-coord', texte: 'Coordonnées' }),
      blocTelephone(),
      el('form', {
        classe: 'pro-ligne', novalidate: true,
        sursubmit: (e) => {
          e.preventDefault();
          const mail = champMail.value.trim();
          if (mail && !/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(mail)) { dire('mail', 'Adresse mail invalide.', 'erreur'); return; }
          if (mail === (profil.mail || '')) { dire('mail', 'Aucune modification.'); return; }
          enregistrerPreferences({ mail }, 'mail', mail ? 'Adresse mail enregistrée.' : 'Adresse mail retirée.');
        },
      },
      el('div', { classe: 'champ' }, el('label', { for: idMail, texte: 'Adresse mail' }), champMail),
      el('button', { type: 'submit', classe: 'cfg-bouton', texte: 'Enregistrer' })),
      zoneMessage('mail'));
  }

  function blocTelephone() {
    const actuel = profil.telephone ? telFr(profil.telephone) : '';
    const resume = el('div', { classe: 'pro-ligne' },
      el('div', { classe: 'pro-valeur' },
        el('span', { classe: 'pro-etiquette', texte: 'Téléphone portable' }),
        el('strong', { texte: actuel || (profil.telephoneBrut ? `${profil.telephoneBrut} (invalide)` : 'Non renseigné') }),
        el('small', { texte: 'Sert à recevoir les codes de connexion par SMS.' })),
      telephone.etape ? null : el('button', {
        type: 'button', classe: 'cfg-bouton', texte: actuel ? 'Modifier' : 'Ajouter',
        surclick: () => { telephone = { etape: 'saisie', numero: '', message: '', classe: '' }; rendre(); focaliser('#pro-tel'); },
      }));
    if (!telephone.etape) return el('div', {}, resume, zoneMessage('tel'));

    const messageTel = el('p', { classe: `message ${telephone.classe}`.trim(), role: 'status', texte: telephone.message });
    const annuler = el('button', { type: 'button', classe: 'lien', texte: 'Annuler', surclick: () => { telephone = { etape: '' }; rendre(); } });

    if (telephone.etape === 'saisie') {
      const champ = el('input', { id: 'pro-tel', type: 'tel', inputmode: 'tel', autocomplete: 'tel', valeur: telephone.numero, placeholder: '06 12 34 56 78' });
      return el('div', {}, resume,
        el('form', {
          classe: 'pro-sous-formulaire', novalidate: true,
          sursubmit: async (e) => {
            e.preventDefault();
            const bouton = e.currentTarget.querySelector('button[type="submit"]');
            telephone.numero = champ.value.trim();
            bouton.disabled = true;
            messageTel.className = 'message';
            messageTel.textContent = 'Envoi du code…';
            try {
              const rep = await App.appeler('demanderCodeTelephone', { telephone: telephone.numero });
              if (rep.ok) { telephone = { ...telephone, etape: 'code', message: rep.message, classe: 'info' }; rendre(); focaliser('#pro-code-tel'); return; }
              messageTel.textContent = rep.erreur || 'Refusé par le serveur.';
            } catch (err) { messageTel.textContent = reseauKo(err); }
            messageTel.className = 'message erreur';
            bouton.disabled = false;
          },
        },
        el('div', { classe: 'champ' }, el('label', { for: 'pro-tel', texte: 'Nouveau numéro de portable' }), champ),
        el('p', { classe: 'pro-aide', texte: 'Un code de confirmation sera envoyé par SMS à ce numéro.' }),
        el('div', { classe: 'pro-boutons' }, el('button', { type: 'submit', classe: 'principal', texte: 'Recevoir le code' }), annuler),
        messageTel));
    }

    const champCode = el('input', { id: 'pro-code-tel', classe: 'saisie-code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6' });
    const formulaire = el('form', {
      classe: 'pro-sous-formulaire', novalidate: true,
      sursubmit: async (e) => {
        e.preventDefault();
        const bouton = formulaire.querySelector('button[type="submit"]');
        bouton.disabled = true;
        messageTel.className = 'message';
        messageTel.textContent = 'Vérification…';
        try {
          const rep = await App.appeler('confirmerTelephone', { code: champCode.value.trim() });
          if (rep.ok) {
            profil = rep.profil;
            ecrireCache();
            telephone = { etape: '' };
            messages.tel = { texte: rep.message || 'Numéro enregistré.', classe: 'succes' };
            rendre();
            return;
          }
          messageTel.textContent = rep.erreur || 'Refusé par le serveur.';
        } catch (err) { messageTel.textContent = reseauKo(err); }
        messageTel.className = 'message erreur';
        bouton.disabled = false;
        champCode.value = '';
      },
    },
    el('div', { classe: 'champ' }, el('label', { for: 'pro-code-tel', texte: 'Code reçu par SMS (6 chiffres, valable 15 minutes)' }), champCode),
    el('div', { classe: 'pro-boutons' },
      el('button', { type: 'submit', classe: 'principal', texte: 'Valider le numéro' }),
      el('button', { type: 'button', classe: 'lien', texte: 'Changer de numéro', surclick: () => { telephone = { ...telephone, etape: 'saisie', message: '', classe: '' }; rendre(); focaliser('#pro-tel'); } }),
      annuler),
    messageTel);
    champCode.addEventListener('input', () => {
      const chiffres = champCode.value.replace(/\D/g, '').slice(0, 6);
      if (champCode.value !== chiffres) champCode.value = chiffres;
      if (chiffres.length === 6) formulaire.requestSubmit();
    });
    return el('div', {}, resume, formulaire);
  }

  function blocPartage() {
    const caseAvec = (cle, titre, detail) => {
      const id = nouvelId();
      return el('label', { classe: 'case-rester', for: id },
        el('input', {
          id, type: 'checkbox', checked: Boolean(profil[cle]),
          surchange: (e) => enregistrerPreferences({ [cle]: e.target.checked }, 'partage', 'Choix enregistré.'),
        }),
        el('span', {}, titre, el('small', { texte: detail })));
    };
    return el('section', { classe: 'pro-carte', 'aria-labelledby': 'pro-titre-partage' },
      el('h2', { id: 'pro-titre-partage', texte: 'Partage de mon numéro' }),
      profil.telephone ? null : el('p', { classe: 'pro-aide', texte: 'Aucun numéro valide enregistré : ces choix s\'appliqueront dès que vous en aurez ajouté un.' }),
      caseAvec('partageAnnuaire', 'Visible des autres utilisateurs',
        'Votre numéro apparaît dans l\'annuaire du personnel de l\'application.'),
      caseAvec('partageAppli', 'Utilisable par l\'application',
        'L\'application peut vous envoyer des SMS d\'alerte ou de rappel. Les SMS de connexion (première connexion, mot de passe oublié) sont envoyés dans tous les cas.'),
      zoneMessage('partage'));
  }

  function blocNotifications() {
    const textes = {
      actif: ['Activées sur cet appareil', 'pro-vert'],
      inactif: ['Désactivées sur cet appareil', 'pro-gris'],
      erreur: ['Le serveur n\'a pas pu enregistrer cet appareil', 'pro-orange'],
      bloque: ['Bloquées dans les réglages du navigateur', 'pro-orange'],
      ios: ['Installez d\'abord l\'appli', 'pro-orange'],
      impossible: ['Non prises en charge par ce navigateur', 'pro-gris'],
    };
    const [libelle, classe] = textes[etatNotif] || textes.inactif;
    const aide = {
      bloque: 'Pour les recevoir, autorisez les notifications pour MySMUR dans les réglages du navigateur (cadenas à côté de l\'adresse, ou Réglages > Notifications), puis revenez ici.',
      ios: 'Sur iPhone : bouton Partager, puis « Sur l\'écran d\'accueil ». Ouvrez ensuite MySMUR depuis l\'écran d\'accueil pour activer les notifications.',
    }[etatNotif];
    let bouton = null;
    if (etatNotif === 'actif') {
      bouton = el('button', {
        type: 'button', classe: 'cfg-bouton', texte: 'Désactiver',
        surclick: async (e) => {
          e.currentTarget.disabled = true;
          await App.desactiverNotifications();
          await majNotifications();
          messages.notif = { texte: 'Cet appareil ne recevra plus de notifications.', classe: '' };
          rafraichirListeNotifications();
        },
      });
    } else if (etatNotif === 'inactif' || etatNotif === 'erreur') {
      bouton = el('button', {
        type: 'button', classe: 'principal pro-bouton-court', texte: etatNotif === 'erreur' ? 'Réessayer' : 'Activer',
        surclick: async (e) => {
          e.currentTarget.disabled = true;
          etatNotif = await App.activerNotifications();
          finAppareil = await App.finAbonnement();
          messages.notif = etatNotif === 'actif' ? { texte: 'Notifications activées sur cet appareil.', classe: 'succes' } : { texte: '', classe: '' };
          rafraichirListeNotifications();
        },
      });
    }

    const autres = (profil.notifications || []).filter((n) => n.fin !== finAppareil);
    return el('section', { classe: 'pro-carte', 'aria-labelledby': 'pro-titre-notif' },
      el('h2', { id: 'pro-titre-notif', texte: 'Notifications' }),
      el('p', { classe: 'pro-aide', texte: 'Une alerte à chaque nouvelle information du mur d\'accueil qui vous concerne.' }),
      el('div', { classe: 'pro-ligne' },
        el('span', { classe: `usr-pastille ${classe}`, texte: libelle }),
        bouton),
      aide ? el('p', { classe: 'pro-aide', texte: aide }) : null,
      autres.length ? el('div', { classe: 'pro-appareils' },
        el('h3', { texte: 'Vos autres appareils recevant les notifications' }),
        el('ul', {}, autres.map((n) => el('li', {},
          el('span', {}, n.appareil, n.vu ? el('small', { texte: ` — utilisé le ${dateFr(n.vu)}` }) : null),
          el('button', {
            type: 'button', classe: 'lien danger', texte: 'Retirer',
            surclick: async (e) => {
              e.currentTarget.disabled = true;
              try {
                const rep = await App.appeler('retirerNotification', { fin: n.fin });
                if (rep.ok) { profil = rep.profil; ecrireCache(); messages.notif = { texte: `${n.appareil} ne recevra plus de notifications.`, classe: 'succes' }; } else messages.notif = { texte: rep.erreur, classe: 'erreur' };
              } catch (err) { messages.notif = { texte: reseauKo(err), classe: 'erreur' }; }
              rendre();
            },
          }))))) : null,
      zoneMessage('notif'));
  }

  /** Après activation ou désactivation : la liste du serveur change (abonnement ajouté ou retiré). */
  async function rafraichirListeNotifications() {
    rendre();
    try {
      const rep = await App.appeler('lireProfil');
      if (rep.ok) { profil = rep.profil; ecrireCache(); rendre(); }
    } catch (e) { /* hors ligne */ }
  }

  function champMotDePasse(id, libelle, autocomplete) {
    const champ = el('input', { id, type: 'password', autocomplete, required: true });
    const voir = el('button', {
      type: 'button', classe: 'voir', 'aria-pressed': 'false', texte: 'Afficher',
      surclick: () => {
        const visible = champ.type === 'password';
        champ.type = visible ? 'text' : 'password';
        voir.textContent = visible ? 'Masquer' : 'Afficher';
        voir.setAttribute('aria-pressed', String(visible));
        champ.focus();
      },
    });
    return el('div', { classe: 'champ' }, el('label', { for: id, texte: libelle }), el('div', { classe: 'avec-bouton' }, champ, voir));
  }

  function blocMotDePasse() {
    const formulaire = el('form', {
      classe: 'pro-sous-formulaire', novalidate: true,
      sursubmit: async (e) => {
        e.preventDefault();
        const ancien = formulaire.querySelector('#pro-mdp-actuel').value;
        const nouveau = formulaire.querySelector('#pro-mdp-nouveau').value;
        if (!ancien || !nouveau) { dire('mdp', 'Remplissez les deux champs.', 'erreur'); return; }
        if (nouveau !== formulaire.querySelector('#pro-mdp-confirmation').value) { dire('mdp', 'Les deux nouveaux mots de passe ne correspondent pas.', 'erreur'); return; }
        const bouton = formulaire.querySelector('button[type="submit"]');
        bouton.disabled = true;
        dire('mdp', 'Patientez…');
        try {
          const rep = await App.appeler('changerMotDePasse', { ancien, nouveau, jetonAppareil: App.jetonAppareil() });
          if (rep.ok) {
            App.nouvelleSession(rep);
            formulaire.reset();
            dire('mdp', rep.message || 'Mot de passe modifié.', 'succes');
          } else dire('mdp', rep.erreur || 'Refusé par le serveur.', 'erreur');
        } catch (err) { dire('mdp', reseauKo(err), 'erreur'); }
        bouton.disabled = false;
      },
    },
    champMotDePasse('pro-mdp-actuel', 'Mot de passe actuel', 'current-password'),
    champMotDePasse('pro-mdp-nouveau', 'Nouveau mot de passe', 'new-password'),
    el('div', { classe: 'champ' }, el('label', { for: 'pro-mdp-confirmation', texte: 'Confirmez le nouveau mot de passe' }),
      el('input', { id: 'pro-mdp-confirmation', type: 'password', autocomplete: 'new-password', required: true })),
    el('button', { type: 'submit', classe: 'principal pro-bouton-court', texte: 'Changer le mot de passe' }),
    zoneMessage('mdp'));
    const autres = Math.max(0, (profil.appareils || 0) - (App.jetonAppareil() ? 1 : 0));
    return el('section', { classe: 'pro-carte', 'aria-labelledby': 'pro-titre-mdp' },
      el('h2', { id: 'pro-titre-mdp', texte: 'Mot de passe' }),
      el('p', { classe: 'pro-aide', texte: `Au moins 8 caractères, avec des lettres et des chiffres. Cet appareil reste connecté ; ${autres ? `vos ${autres} autre(s) appareil(s) mémorisé(s) devront se reconnecter` : 'vos autres appareils devront se reconnecter'}.` }),
      formulaire,
      el('p', { classe: 'pro-aide', texte: 'Mot de passe oublié ? Déconnectez-vous puis choisissez « Recevoir un code par SMS » sur l\'écran de connexion.' }));
  }

  function focaliser(selecteur) {
    requestAnimationFrame(() => { const n = zone.querySelector(selecteur); if (n) n.focus(); });
  }

  function rendre() {
    if (!zone || zone.hidden) return;
    zone.innerHTML = '';
    zone.append(el('h1', { texte: 'Mon profil' }));
    if (erreurChargement) zone.append(el('p', { classe: `message ${profil ? '' : 'erreur'}`.trim(), role: 'status', texte: erreurChargement }));
    if (!profil) {
      if (chargementEnCours) zone.append(el('p', { classe: 'consigne', texte: 'Chargement de votre profil…' }));
      else zone.append(el('button', { type: 'button', classe: 'cfg-bouton', texte: 'Réessayer', surclick: charger }));
      return;
    }
    zone.append(blocIdentite(), blocCoordonnees(), blocPartage(), blocNotifications(), blocMotDePasse());
  }

  return {
    initialiser(options) {
      App = options;
      zone = document.getElementById('zone-profil');
    },
    ouvrir() {
      zone.hidden = false;
      profil = profil || lireCache();
      telephone = { etape: '' };
      Object.keys(messages).forEach((k) => delete messages[k]);
      rendre();
      charger();
    },
    masquer() {
      if (zone) zone.hidden = true;
    },
    /** Déconnexion : rien du profil ne reste pour l'agent suivant. */
    oublier() {
      profil = null;
      try { localStorage.removeItem(CLE); } catch (e) { /* rien */ }
    },
  };
})();
