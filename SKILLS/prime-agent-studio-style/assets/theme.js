// Theme resolution, same rule as Prime Agent Studio (public/theme.js).
// Load it in <head> before the CSS paints. Preference values: 'dark' (default), 'light', 'system'.
(() => {
  const KEY = 'theme';            // use your own storage key
  let pref = 'dark';
  try { pref = localStorage.getItem(KEY) || 'dark'; } catch {}
  // ?theme=dark|light|system wins over the stored value (previews, tests, screenshots). It is not saved.
  const asked = new URLSearchParams(location.search).get('theme');
  if (['dark', 'light', 'system'].includes(asked)) pref = asked;
  const apply = () => {
    document.documentElement.dataset.theme =
      pref === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : pref;
  };
  apply();
  if (pref === 'system') matchMedia('(prefers-color-scheme: light)').addEventListener('change', apply);
})();
