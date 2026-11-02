// À incrémenter à chaque mise à jour, avec les ?v= de index.html.
const CACHE = 'avismur-v48';
const FICHIERS = [
  './', 'index.html', 'style.css?v=27', 'app.js?v=21', 'config.js?v=6', 'checklists.js?v=13', 'ambulancier.js?v=24', 'actions.js?v=10', 'config-admin.js?v=6', 'parc.js?v=6', 'compteur.js?v=5',
  'manifest.webmanifest',
  'img/logo-smur.png', 'img/logo-cha.png', 'img/icon-192.png', 'img/icon-512.png', 'img/icon-maskable-512.png',
  'img/vues/jumpy_gauche.svg', 'img/vues/jumpy_droite.svg', 'img/vues/jumpy_avant.svg', 'img/vues/jumpy_arriere.svg',
  'img/vues/jaune_gauche.jpg', 'img/vues/jaune_droite.jpg', 'img/vues/jaune_avant.jpg', 'img/vues/jaune_arriere.jpg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FICHIERS)));
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
