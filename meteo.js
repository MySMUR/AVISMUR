// Météo en temps réel à Avignon dans le bandeau (Open-Meteo : gratuit, sans clé, aucune donnée personnelle).
// Rafraîchie toutes les 10 minutes ; hors ligne, la dernière valeur connue reste affichée (grisée).
(function () {
  const URL_METEO = 'https://api.open-meteo.com/v1/forecast?latitude=43.9493&longitude=4.8055'
    + '&current=temperature_2m,weather_code,wind_speed_10m,wind_gusts_10m,is_day&timezone=Europe%2FParis';
  const CLE = 'avismur-meteo';
  const PERIODE = 10 * 60 * 1000;

  // Codes météo WMO → pictogramme et libellé.
  function decrire(code, jour) {
    if (code === 0) return [jour ? '☀️' : '🌙', 'Ciel dégagé'];
    if (code <= 2) return [jour ? '🌤️' : '☁️', 'Peu nuageux'];
    if (code === 3) return ['☁️', 'Couvert'];
    if (code <= 48) return ['🌫️', 'Brouillard'];
    if (code <= 57) return ['🌦️', 'Bruine'];
    if (code <= 67) return ['🌧️', 'Pluie'];
    if (code <= 77) return ['🌨️', 'Neige'];
    if (code <= 82) return ['🌧️', 'Averses'];
    if (code <= 86) return ['🌨️', 'Averses de neige'];
    return ['⛈️', 'Orage'];
  }

  function afficher(d, perimee) {
    const el = document.getElementById('meteo');
    if (!el || !d) return;
    const [picto, libelle] = decrire(d.weather_code, d.is_day);
    const vent = Math.round(d.wind_speed_10m);
    const rafales = Math.round(d.wind_gusts_10m);
    el.querySelector('.meteo-picto').textContent = picto;
    el.querySelector('.meteo-temp').textContent = Math.round(d.temperature_2m) + '°';
    el.querySelector('.meteo-vent').textContent = vent + ' km/h';
    const heure = (d.time || '').slice(11, 16);
    el.title = `Avignon : ${libelle}, ${d.temperature_2m.toFixed(1)} °C — vent ${vent} km/h, rafales ${rafales} km/h`
      + (heure ? ` (relevé ${heure})` : '') + (perimee ? ' — hors ligne, dernière valeur connue' : '');
    el.setAttribute('aria-label', el.title);
    el.classList.toggle('meteo-perimee', !!perimee);
    el.classList.toggle('meteo-vent-fort', rafales >= 60);
    el.hidden = false;
  }

  function lireCache() {
    try { return JSON.parse(localStorage.getItem(CLE)); } catch (_) { return null; }
  }

  async function actualiser() {
    if (!navigator.onLine) { afficher(lireCache(), true); return; }
    try {
      const r = await fetch(URL_METEO, { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      const d = (await r.json()).current;
      try { localStorage.setItem(CLE, JSON.stringify(d)); } catch (_) {}
      afficher(d, false);
    } catch (_) {
      afficher(lireCache(), true);
    }
  }

  afficher(lireCache(), true);
  actualiser();
  setInterval(actualiser, PERIODE);
  window.addEventListener('online', actualiser);
  window.addEventListener('offline', () => afficher(lireCache(), true));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) actualiser(); });
})();
