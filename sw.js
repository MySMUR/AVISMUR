// À incrémenter à chaque mise à jour, avec les ?v= de index.html.
const CACHE = 'avismur-v250';
const FICHIERS = [
  './', 'index.html', 'style.css?v=114', 'app.js?v=62', 'simulation.js?v=4', 'regulation.js?v=9', 'config.js?v=6', 'checklists.js?v=13', 'ambulancier.js?v=28', 'actions.js?v=12', 'config-admin.js?v=7', 'utilisateurs.js?v=12', 'parc.js?v=7', 'compteur.js?v=5', 'traceurs.js?v=1', 'inventaires.js?v=80', 'infos.js?v=7', 'materiel.js?v=22', 'profil.js?v=6', 'annuaire.js?v=3', 'meteo.js?v=1', 'lib/qrcode.js?v=1', 'recadrage.js?v=4', 'detourage.js?v=3', 'camera.js?v=1', 'cible-nfc.js?v=1', 
  'manifest.webmanifest',
  'img/logo-smur.png', 'img/logo-cha.png', 'img/icon-192.png', 'img/icon-512.png', 'img/icon-maskable-512.png',
  'img/vues/jumpy_gauche.svg', 'img/vues/jumpy_droite.svg', 'img/vues/jumpy_avant.svg', 'img/vues/jumpy_arriere.svg',
  'img/vues/jaune_gauche.jpg', 'img/vues/jaune_droite.jpg', 'img/vues/jaune_avant.jpg', 'img/vues/jaune_arriere.jpg',
];

self.addEventListener('install', (e) => {
  // Fichier par fichier : un seul fichier introuvable ne doit pas bloquer toute la mise à jour
  // (avec addAll, l'échec d'un fichier laissait l'ancienne version installée, sans aucun message).
  e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(FICHIERS.map((f) => c.add(f)))));
  self.skipWaiting();
});

// Supprime les anciennes versions du cache (uniquement celles de cette app : préfixe « avismur- »,
// ou l'ancien « smur-pwa- ») — ne jamais toucher aux caches des autres apps du domaine —
// et prend la main sur les pages ouvertes.
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((cles) => Promise.all(cles.filter((c) => (c.startsWith('avismur-') || c.startsWith('smur-pwa-')) && c !== CACHE).map((c) => caches.delete(c))))
      .then(() => self.clients.claim())
  );
});

// Réseau d'abord, en revalidant toujours auprès du serveur (pas de copie périmée du navigateur).
// Hors ligne : la dernière version en cache. Les appels à l'API ne passent jamais par le cache.
self.addEventListener('fetch', (e) => {
  // Seuls les fichiers de l'application passent par le cache ; le reste (API, polices,
  // moteur de lecture du compteur) va directement au réseau.
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((r) => {
        if (r.ok) {
          const copie = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copie));
        }
        return r;
      })
      .catch(() => caches.open(CACHE).then((c) => c.match(e.request)))
  );
});

// ---------- Notifications push (mur d'informations, voir infos.js et Push.gs du backend) ----------
// Le serveur envoie un message chiffré : { titre, corps, tag, url, urgent }.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { corps: e.data ? e.data.text() : '' }; }
  const options = {
    body: d.corps || '',
    icon: 'img/icon-192.png',
    tag: d.tag || undefined,
    renotify: Boolean(d.tag),
    requireInteraction: Boolean(d.urgent), // une alerte urgente reste affichée jusqu'à ce qu'on la touche
    vibrate: d.urgent ? [300, 100, 300, 100, 600] : [150],
    data: { url: d.url || './' },
  };
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((liste) => {
    // Appli ouverte : le mur se met à jour tout seul.
    liste.forEach((c) => c.postMessage({ type: 'push-recu' }));
    const visible = liste.some((c) => c.visibilityState === 'visible');
    return Promise.all([
      self.registration.showNotification(d.titre || 'MySMUR', options),
      // Pastille sur l'icône : seulement si l'appli n'est pas déjà sous les yeux de l'agent.
      visible ? null : lirePastille().then((n) => ecrirePastille(n + 1)),
    ]);
  }));
});

// ---------- Pastille sur l'icône de l'appli (nombre de notifications non lues) ----------
// iPhone (appli sur l'écran d'accueil), Windows, macOS : le nombre s'affiche grâce à setAppBadge.
// Android : le système met lui-même une pastille tant qu'une notification est dans le volet
// (point, ou nombre selon le lanceur — Samsung : réglage « Afficher le nombre »).
// Le compteur est rangé dans un cache à part (hors préfixe « avismur- », que l'activation efface).
// L'appli le remet à zéro quand elle passe au premier plan (app.js, effacerPastille).
const CACHE_PASTILLE = 'mysmur-pastille';
function lirePastille() {
  return caches.open(CACHE_PASTILLE).then((c) => c.match('n')).then((r) => (r ? r.text() : '0'))
    .then((t) => parseInt(t, 10) || 0).catch(() => 0);
}
function ecrirePastille(n) {
  n = Math.max(0, n);
  const maj = caches.open(CACHE_PASTILLE).then((c) => c.put('n', new Response(String(n)))).catch(() => {});
  const api = !('setAppBadge' in navigator) ? null
    : (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => { /* non pris en charge ici */ });
  return Promise.all([maj, api]);
}

// Notification balayée sans être ouverte : une de moins sur la pastille.
self.addEventListener('notificationclose', (e) => {
  e.waitUntil(lirePastille().then((n) => ecrirePastille(n - 1)));
});

// Toucher la notification : ouvre l'appli (ou la ramène au premier plan) sur l'information concernée.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((liste) => {
    const ouverte = liste.find((c) => c.url.startsWith(self.registration.scope));
    if (ouverte) {
      ouverte.postMessage({ type: 'ouvrir-info', url });
      return ouverte.focus();
    }
    return self.clients.openWindow(url);
  }));
});
