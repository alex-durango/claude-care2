(function () {
  try {
    var s = localStorage.getItem("claudecare:tweaks");
    if (!s) return;
    var p = (JSON.parse(s) || {}).palette;
    if (p && /^[a-z]+$/.test(p)) {
      document.documentElement.classList.add("palette-" + p);
    }
  } catch (e) {}
})();
