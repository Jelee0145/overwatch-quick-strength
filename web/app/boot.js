// Concatenated after the app modules: wire the page once, then start cloud boot.
function queueMapArt() {
  QS_ASSETS.render($('chart').querySelector('svg'), $('art').checked);
}
wireTimeline();
wireExport();
wireQuery();
['limit', 'side', 'strategy', 'estimate', 'art'].forEach(
  (id) =>
    ($(id).onchange = () => {
      generate();
    })
);
let redrawTimer = null;
$('title').oninput = () => {
  clearTimeout(redrawTimer);
  redrawTimer = setTimeout(generate, 150);
};
$('matchSelect').onchange = () => showPlayers(Number($('matchSelect').value));
generate();
(async () => {
  try {
    await Cloud.boot();
    const latest = await Cloud.latest();
    if (latest.historyTag) await openHistory(latest.historyTag);
    else if (latest.result) {
      raw = OWQS_SERVICES.data.normalize(latest.result);
      $('battleTag').value = raw.battletag;
      generate();
    }
    if (latest.activeJob) {
      activeJob = latest.activeJob;
      busy(true);
      poll();
    }
  } catch (e) {
    status(e.message, true);
  }
})();
$('limit').onchange = null;
window.OWQS_APP = {
  get model() {
    return model;
  },
  get activeJob() {
    return activeJob;
  },
  timeline,
  showPlayers,
  showPerformance,
  ensurePlayerDetail,
  settleTimeline
};
