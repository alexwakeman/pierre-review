// Applies the stored colour scheme BEFORE FIRST PAINT (docs/FRONTEND.md § Colour schemes).
// A plain blocking script in <head>, not inline: the CSP allows 'self' scripts only. It repeats the
// storage rule of src/lib/colorSchemes.ts (keys 'theme', 'theme-scheme-light', 'theme-scheme-dark');
// test/colorSchemes.test.ts pins the two together. An unknown id matches no CSS block, so the mode's
// default colours show and the app corrects the attribute on mount.
(function () {
  try {
    var s = window.localStorage;
    var mode = s.getItem('theme') === 'light' ? 'light' : 'dark';
    var id = s.getItem('theme-scheme-' + mode) || mode;
    var root = document.documentElement;
    root.classList.toggle('dark', mode === 'dark');
    root.setAttribute('data-scheme', id);
  } catch (e) {
    // Storage blocked: index.html's static `class="dark"` stands.
  }
})();
