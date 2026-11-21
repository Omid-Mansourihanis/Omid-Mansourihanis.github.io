// Site configuration. Edit these values; nothing else needs changing.
window.LOS_CONFIG = {
  // OSM basemap with 3D buildings, free and keyless (OpenFreeMap). Any MapLibre style URL works.
  osmStyle: 'https://tiles.openfreemap.org/styles/liberty',

  // Google Map Tiles API key (Photorealistic 3D Tiles). A key in a public repo is visible to everyone:
  // restrict it to HTTP referrer https://<user>.github.io/* and to the "Map Tiles API" only, and set a daily quota.
  // Leave empty to let each visitor paste their own key (kept in their browser only).
  googleMapsApiKey: '',

  dataDir: 'data/',
  defaultCity: 'new-york',
};
