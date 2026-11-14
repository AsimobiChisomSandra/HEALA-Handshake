/* Registers the offline cache. Does nothing when the page is opened as a plain file (file://). */
(function () {
  'use strict';
  if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function () { /* offline cache is optional */ });
    navigator.serviceWorker.ready.then(function () {
      var banner = document.querySelector('.banner');
      if (!banner || document.getElementById('offlineReady')) return;
      var s = document.createElement('span');
      s.id = 'offlineReady';
      s.textContent = ' Offline ready: this page now works without internet.';
      banner.appendChild(s);
    });
  });
})();
