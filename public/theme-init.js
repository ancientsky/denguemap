// Runs synchronously in <head> before CSS paints to avoid a flash of the wrong theme.
// External file (not inline) so the CSP can keep script-src 'self'.
// Mirrors src/lib/embed.ts: ?embed=1 and ?theme=light|dark are read from location.search and from the
// hash query (#/map?embed=1&theme=dark); first valid value wins (search, then hash). Embed mode ignores
// the visitor's saved preference (it must not depend on, or touch, the standalone site's localStorage).
(function () {
  function params(s) {
    try { return new URLSearchParams(s); } catch (e) { return new URLSearchParams(); }
  }
  var h = location.hash, q = h.indexOf('?');
  var sources = [params(location.search), params(q >= 0 ? h.slice(q + 1) : '')];
  var embed = false, urlTheme = null;
  for (var i = 0; i < sources.length; i++) {
    var e = sources[i].get('embed'), t = sources[i].get('theme');
    if (e === '1') embed = true;
    if (urlTheme === null && (t === 'light' || t === 'dark')) urlTheme = t;
  }
  var pref = 'system';
  if (urlTheme) pref = urlTheme;
  else if (!embed) {
    try {
      var v = localStorage.getItem('denguemap.theme');
      if (v === 'light' || v === 'dark') pref = v;
    } catch (err) { /* storage blocked */ }
  }
  var dark = pref === 'dark' || (pref === 'system' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  var root = document.documentElement;
  root.setAttribute('data-theme', dark ? 'dark' : 'light');
  root.setAttribute('data-theme-pref', pref);
  root.style.colorScheme = dark ? 'dark' : 'light';
  if (embed) root.setAttribute('data-embed', '1'); // lets CSS hide the site chrome before the app boots
})();
