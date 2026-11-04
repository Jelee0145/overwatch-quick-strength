// Small visual helpers: header elevation on scroll and a pointer-following glow on hub cards.
(function () {
  var body = document.body;
  if (!body) return;
  body.classList.add('motion');
  // Nodes inserted while this is true get .enter (see theme.css): page load, and a moment after a user action.
  var animating = true,
    settle = setTimeout(function () {
      animating = false;
    }, 2500);
  ['pointerdown', 'keydown', 'input', 'change'].forEach(function (type) {
    document.addEventListener(
      type,
      function () {
        animating = true;
        clearTimeout(settle);
        settle = setTimeout(function () {
          animating = false;
        }, 1200);
      },
      { passive: true, capture: true }
    );
  });
  var ENTER = '.event-match,.events-day,.events-reservation,#players>tr,.empty-state,#chart>svg';
  new MutationObserver(function (records) {
    if (!animating) return;
    records.forEach(function (record) {
      record.addedNodes.forEach(function (node) {
        if (node.nodeType !== 1) return;
        if (node.matches(ENTER)) node.classList.add('enter');
        node.querySelectorAll(ENTER).forEach(function (child) {
          child.classList.add('enter');
        });
      });
    });
  }).observe(body, { childList: true, subtree: true });
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
  // Desktop analysis page: keep the settings panel vertically centred on the strength chart.
  var workspace = document.querySelector('.workspace'),
    side = workspace && workspace.querySelector(':scope > aside'),
    plot = workspace && workspace.querySelector('.canvas-wrap');
  if (side && plot) {
    var place = function () {
      if (!matchMedia('(min-width:761px)').matches) {
        side.style.marginTop = '';
        return;
      }
      side.style.marginTop = '0px';
      var w = workspace.getBoundingClientRect(),
        c = plot.getBoundingClientRect();
      side.style.marginTop = Math.max(0, c.top - w.top + (c.height - side.offsetHeight) / 2) + 'px';
    };
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(place);
      ro.observe(plot);
      ro.observe(side);
    }
    window.addEventListener('resize', place);
    window.addEventListener('owqs:analysis-updated', function () {
      setTimeout(place, 0);
    });
    setTimeout(place, 1200);
    place();
  }
})();
