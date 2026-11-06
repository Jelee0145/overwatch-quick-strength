(function (root) {
  'use strict';
  const dateFormat = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  function day(value) {
    if (!value) return '';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    const parts = Object.fromEntries(dateFormat.formatToParts(date).map((p) => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
  function select(
    matches,
    {
      view = 'scheduled',
      from = '',
      to = '',
      tournament = '',
      region = '',
      team = '',
      series = 'owcs'
    } = {}
  ) {
    const query = team.trim().toLocaleLowerCase();
    return matches
      .filter((m) => {
        const date = day(m.startsAt);
        return (
          (series === 'all' || (m.series || 'owcs') === series) &&
          (view === 'completed' ? m.status === 'completed' : m.status !== 'completed') &&
          (!from || (date && date >= from)) &&
          (!to || (date && date <= to)) &&
          (!tournament || m.tournament === tournament) &&
          (!region || m.region === region) &&
          (!query ||
            m.teams.some((t) =>
              [t.name, t.shortName].some((n) => n.toLocaleLowerCase().includes(query))
            ))
        );
      })
      .sort((a, b) => {
        if (!a.startsAt || !b.startsAt) return a.startsAt ? -1 : b.startsAt ? 1 : 0;
        return (Date.parse(a.startsAt) - Date.parse(b.startsAt)) * (view === 'completed' ? -1 : 1);
      });
  }
  // Same rules as backend/src/events/source.mjs detailPath/detailRoot: OWCS stage pages only,
  // with known subpages rolled up to their stage.
  const DETAIL_PATH = /^Overwatch_Champions_Series\/[A-Za-z0-9_\-]+(?:\/[A-Za-z0-9_\-]+){0,4}$/;
  const SUBPAGES =
    /\/(?:Regular_Season|Playoffs|Regional_Playoffs|Group_Stage|Main_Event|Swiss_Stage|Knockout_Stage|Play-?Ins?|Playoff)$/i;
  function detailRoot(sourceUrl) {
    let url;
    try {
      url = new URL(sourceUrl);
    } catch {
      return null;
    }
    if (url.origin !== 'https://liquipedia.net' || !url.pathname.startsWith('/overwatch/'))
      return null;
    let path;
    try {
      path = decodeURIComponent(url.pathname.slice('/overwatch/'.length)).replace(SUBPAGES, '');
    } catch {
      return null;
    }
    return path.length <= 160 && DETAIL_PATH.test(path) ? path : null;
  }
  // Mirrors the detail parser's match id: page URL, start time and both team names.
  function detailHref(match) {
    const root = (match?.series || 'owcs') === 'owcs' && detailRoot(match?.sourceUrl);
    if (!root) return null;
    const url = new URL(match.sourceUrl),
      id = [
        url.origin + url.pathname,
        match.startsAt || 'tbd',
        ...(match.teams || []).map((t) => t?.name || '')
      ].join('|');
    return '/tools/event.html?' + new URLSearchParams({ t: root }) + '#m=' + encodeURIComponent(id);
  }
  root.EventsModel = { day, select, detailRoot, detailHref };
})(typeof window === 'undefined' ? globalThis : window);
