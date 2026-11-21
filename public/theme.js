// Applies the saved look before the page paints (so there is no flash of the wrong
// theme). Loaded as a plain script in <head>; everything else is a module.
(function () {
  var THEMES = ["tide", "ink", "harbor"], KEY = "slab:look";
  function read() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } }
  function apply(v) {
    var el = document.documentElement;
    if (THEMES.indexOf(v.theme) > 0) el.setAttribute("data-theme", v.theme); else el.removeAttribute("data-theme");
    if (v.mode === "light" || v.mode === "dark") el.setAttribute("data-mode", v.mode); else el.removeAttribute("data-mode");
  }
  var now = read();
  // ?theme=ink&mode=dark previews a look without saving it
  var q = new URLSearchParams(location.search);
  var preview = { theme: q.get("theme") || now.theme, mode: q.get("mode") || now.mode };
  apply(preview);
  window.BallastTheme = {
    get: function () { return { theme: preview.theme || "tide", mode: preview.mode || "" }; },
    set: function (patch) {
      for (var k in patch) { now[k] = patch[k]; preview[k] = patch[k]; }
      try { localStorage.setItem(KEY, JSON.stringify(now)); } catch (e) { /* storage unavailable */ }
      apply(preview);
    },
  };
})();
