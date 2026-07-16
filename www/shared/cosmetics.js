'use strict';
// Datos puros de cosméticos (UMD, como en billar y pingpong). Sin dibujo: las
// funciones que convierten esto en píxeles viven en client.js
// (buildFigureSprites / drawTeamBadge / swatches de los pickers).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Cosmetics = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const TEAMS = [
    { name: 'Rojos', shirt: '#d43d3d', shorts: '#f0f0f4', skin: '#e8b88a' },
    { name: 'Blancos', shirt: '#f0f0f4', shorts: '#20264a', skin: '#c98d5e' },
    { name: 'Verdes', shirt: '#3db554', shorts: '#f0f0f4', skin: '#f0c9a0' },
    { name: 'Amarillos', shirt: '#f0c541', shorts: '#28304a', skin: '#8a5a3a' },
    { name: 'Azulones', shirt: '#3d7ad4', shorts: '#f0f0f4', skin: '#e8b88a' },
    { name: 'Granates', shirt: '#8a2438', shorts: '#28304a', skin: '#f5d5b5' },
  ];

  const TABLES = [
    { name: 'Bar de barrio', field: '#2c8a3e', line: '#e8e8e8', frame: '#6a4526', floor: '#8a7050', wall: '#4a3f38' },
    { name: 'Azulejo', field: '#2456a8', line: '#e8e8f0', frame: '#7a5a35', floor: '#9ab4bc', wall: '#55606e' },
    { name: 'Chiringuito', field: '#28a08a', line: '#fff8e0', frame: '#c9a06a', floor: '#d4b088', wall: '#7ab8d4' },
    { name: 'Neon', field: '#31285a', line: '#e858c0', frame: '#201a3e', floor: '#2a2f3e', wall: '#141824' },
  ];

  const BALLS = [
    { name: 'Blanca', color: '#f4f4ec', dark: '#c9c9b0' },
    { name: 'Naranja', color: '#f08020', dark: '#b85a10' },
    { name: 'Corcho', color: '#c9a06a', dark: '#9a7448' },
  ];

  return { TEAMS, TABLES, BALLS };
});
