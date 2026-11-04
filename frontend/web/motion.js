// Small visual helpers: header elevation on scroll and a pointer-following glow on hub cards.
(function () {
  var body = document.body;
  if (!body) return;
  body.classList.add('motion');
  var settle;
  function lists(ms) {
    body.classList.add('motion-lists');
    clearTimeout(settle);
    settle = setTimeout(function () {
      body.classList.remove('motion-lists');
    }, ms);
  }
  lists(2500);
  ['pointerdown', 'keydown', 'input', 'change'].forEach(function (type) {
    document.addEventListener(
      type,
      function () {
        lists(1200);
      },
      { passive: true, capture: true }
    );
  });
  var ticking = false;
  var top = 0;
  function sync() {
    ticking = false;
    body.classList.toggle('is-scrolled', top > 4);
  }
  // The mobile shell scrolls inside <main>, so listen to every scroll target (scroll does not bubble).
  document.addEventListener(
    'scroll',
    function (event) {
      var t = event.target;
      top =
        t === document || t === document.documentElement
          ? window.scrollY
          : t.tagName === 'MAIN'
            ? t.scrollTop
            : top;
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(sync);
      }
    },
    { passive: true, capture: true }
  );
  sync();
  if (!window.matchMedia || !matchMedia('(hover:hover)').matches) return;
  document.addEventListener(
    'pointermove',
    function (event) {
      var card = event.target.closest && event.target.closest('.tool-entry');
      if (!card) return;
      var box = card.getBoundingClientRect();
      card.style.setProperty('--mx', event.clientX - box.left + 'px');
      card.style.setProperty('--my', event.clientY - box.top + 'px');
    },
    { passive: true }
  );
})();
