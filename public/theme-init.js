// Runs synchronously in <head> before CSS paints to avoid a flash of the wrong theme.
// External file (not inline) so the CSP can keep script-src 'self'.
(function () {
  var pref = 'system';
  try {
    var v = localStorage.getItem('denguemap.theme');
    if (v === 'light' || v === 'dark') pref = v;
  } catch (e) { /* storage blocked */ }
  var dark = pref === 'dark' || (pref === 'system' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  var root = document.documentElement;
  root.setAttribute('data-theme', dark ? 'dark' : 'light');
  root.setAttribute('data-theme-pref', pref);
  root.style.colorScheme = dark ? 'dark' : 'light';
})();
