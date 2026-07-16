'use strict';
// Configuración para builds nativas (Capacitor) o despliegues donde el
// servidor WebSocket no es el mismo origen que sirve los archivos.
//
// En la web autohospedada (node server.js sirviendo public/) déjalo todo en
// null: el cliente usa el mismo origen con ws:// o wss:// según el protocolo.
//
// Para la app móvil, apunta al servidor público, p. ej.:
//   window.FUTBOLIN_SERVER_URL = 'wss://futbolin.ejemplo.com';
//   window.FUTBOLIN_SHARE_URL  = 'https://futbolin.ejemplo.com';
window.FUTBOLIN_SERVER_URL = null;
window.FUTBOLIN_SHARE_URL = null;
