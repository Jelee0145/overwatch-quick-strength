import { parseFragment } from '../shared/events-html.mjs';
import { liquipediaLogo } from './parser.mjs';
import { heroTerm, mapTerm } from './glossary.mjs';

// Reads one Liquipedia tournament page rendered by action=parse (API only; HTML pages are
// never fetched). Output is plain data for this site's own event detail page. Content is
// CC BY-SA 3.0; the caller keeps the source page so the page can attribute it.
const attr = (node, key) => node?.attrs?.find((a) => a.name === key)?.value || '';
const classes = (node) => attr(node, 'class').split(/\s+/);
const has = (node, name) => classes(node).includes(name);
const kids = (node) => (node?.childNodes || []).filter((n) => n.nodeName !== '#text');
const all = (node) => (node ? [node, ...(node.childNodes || []).flatMap(all)] : []);
const find = (node, name) => all(node).find((n) => has(n, name));
const findAll = (node, name) => all(node).filter((n) => has(n, name));
const raw = (node) =>
  node?.nodeName === '#text'
    ? node.value
    : node?.tagName === 'br'
      ? '\n'
      : (node?.childNodes || []).map(raw).join('');
const text = (node) => raw(node).replace(/\s+/g, ' ').trim();
const lines = (node) =>
  raw(node)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
const clip = (value, size) => String(value || '').slice(0, size);
const MAX_HTML = 3 * 1024 * 1024;

function logoOf(node) {
  const icon = all(node).find(
      (n) => has(n, 'team-template-image-icon') && !has(n, 'team-template-darkmode')
    ),
    image = all(icon).find((n) => n.tagName === 'img');
  return liquipediaLogo(attr(image, 'src'));
}
function teamOf(node) {
  const full = find(node, 'team-name'),
    short = find(node, 'team-shortname'),
    wide = find(node, 'hidden-xs'),
    narrow = find(node, 'visible-xs'),
    name = all(node).find((n) => has(n, 'name')),
    link = all(full || wide || name).find((n) => n.tagName === 'a');
  const title = attr(link, 'title').replace(/ \(page does not exist\)$/, '');
  const label = text(full) || text(wide) || title || text(name);
  return {
    name: clip(title || label || '待定', 160),
    shortName: clip(text(short) || text(narrow) || label || '待定', 80),
    logo: logoOf(node)
  };
}
const number = (value) => (/^\d{1,3}$/.test(value) ? Number(value) : null);

function parseGames(popup) {
  const games = findAll(popup, 'brkts-popup-body-grid-row').map((row) => {
    const parts = kids(row),
      labels = parts.filter((n) => has(n, 'generic-label')),
      detail = parts.find((n) => has(n, 'brkts-popup-body-grid-row-detail')),
      cells = kids(detail).filter((n) => has(n, 'brkts-popup-spaced'));
    const middle = cells[1],
      links = all(middle).filter((n) => n.tagName === 'a'),
      modeLink = links.find((a) => all(a).some((n) => n.tagName === 'img')),
      mapLink = links.filter((a) => a !== modeLink).pop();
    const result = labels.map((n) => attr(n, 'data-label-type'));
    const winner = result[0] === 'result-win' ? 0 : result[1] === 'result-win' ? 1 : null;
    const scores = [cells[0], cells[2]].map((n) => clip(text(n), 16));
    return {
      map: mapTerm(
        clip(attr(mapLink, 'title') || text(mapLink), 80),
        clip(attr(modeLink, 'title'), 40)
      ),
      scores,
      winner,
      played: winner !== null || scores.some(Boolean),
      picker: null,
      bans: [null, null]
    };
  });
  // OWCS rule: the loser of the previous map picks the next one. Liquipedia does not record
  // the picker, so this is an inference the page labels as such; map 1 stays unknown.
  for (let i = 1; i < games.length; i++)
    if (games[i].played && games[i - 1].winner !== null) games[i].picker = 1 - games[i - 1].winner;
  for (const row of findAll(popup, 'brkts-popup-veto-row')) {
    const index = Number(
      (text(find(row, 'brkts-popup-veto-row-indicator')).match(/(\d+)/) || [])[1]
    );
    const sides = kids(row).filter((n) => has(n, 'brkts-champion-icon'));
    if (!index || index > games.length || sides.length !== 2) continue;
    games[index - 1].bans = sides.map((side) => {
      const link = all(side).find((n) => n.tagName === 'a' && attr(n, 'title'));
      return link ? heroTerm(clip(attr(link, 'title'), 60)) : null;
    });
  }
  return games;
}

function parseMatch(popup, page, stage) {
  const timer = find(popup, 'timer-object'),
    stamp = attr(timer, 'data-timestamp'),
    seconds = /^\d+$/.test(stamp) ? Number(stamp) : 0,
    startsAt =
      seconds > 0 && seconds < 253402300800 ? new Date(seconds * 1000).toISOString() : null;
  const header = find(popup, 'match-info-header'),
    opponents = kids(header).filter((n) => has(n, 'match-info-header-opponent'));
  if (opponents.length !== 2) return null;
  const teams = opponents.map(teamOf);
  const scoreNodes = findAll(header, 'match-info-header-scoreholder-score'),
    scores = scoreNodes.length === 2 ? scoreNodes.map((n) => number(text(n))) : [null, null];
  const format = text(find(header, 'match-info-header-scoreholder-lower')).match(/Bo\s*(\d{1,2})/i);
  const winner = opponents.findIndex((n) => has(n, 'match-info-header-winner'));
  const mvp = find(popup, 'brkts-popup-mvp');
  const url = 'https://liquipedia.net/overwatch/' + page;
  return {
    id: [url, startsAt || 'tbd', ...teams.map((t) => t.name)].join('|'),
    page,
    stage: clip(stage, 120),
    startsAt,
    finished: attr(timer, 'data-finished') === 'finished',
    bestOf: format ? Number(format[1]) : null,
    teams,
    scores,
    winner: winner >= 0 ? winner : null,
    games: parseGames(popup).slice(0, 9),
    mvp: mvp
      ? all(mvp)
          .filter((n) => n.tagName === 'a')
          .map((a) => clip(text(a), 60))
          .slice(0, 4)
      : []
  };
}

function parseStandings(table, heading) {
  const title = clip(text(find(table, 'table2__title')) || heading, 120);
  const kind = has(table, 'standings-swiss') ? 'swiss' : 'group';
  const head = all(table).find((n) => has(n, 'table2__row--head')),
    columns = kids(head).map((th) => text(th));
  let rows = all(table).filter((n) => n.tagName === 'tr' && has(n, 'table2__row--body'));
  // Group tables carry one row set per week; keep only the latest.
  const areas = rows.map((r) => Number(attr(r, 'data-toggle-area-content')) || 0),
    latest = Math.max(0, ...areas);
  if (latest) rows = rows.filter((_, i) => areas[i] === latest);
  const rounds = columns.filter((c) => /^Round \d+$/i.test(c)).length;
  return {
    title,
    kind,
    columns: columns.filter((c, i) => i > 0 && c && c !== 'Participant' && !/^Round \d+$/i.test(c)),
    rounds,
    rows: rows.slice(0, 64).map((row) => {
      const cells = kids(row),
        stats = [],
        history = [];
      let team = null;
      cells.forEach((cell, i) => {
        const label = columns[i] || '';
        if (find(cell, 'block-team') && !team) team = teamOf(find(cell, 'block-team'));
        else if (has(cell, 'standings-swiss-match')) {
          const result = find(cell, 'label--standings-result');
          if (!result) return history.push(null);
          const opponent = find(cell, 'team-template-team-icon');
          history.push({
            score: kids(result)
              .map((n) => text(n))
              .join(''),
            result: attr(result, 'data-label-type').replace('result-', ''),
            opponent: clip(attr(opponent, 'data-highlighting-class'), 160)
          });
        } else if (i > 0 && label && label !== 'Participant') stats.push(clip(text(cell), 24));
      });
      return {
        place: number(text(find(row, 'label--placement'))),
        status: clip(attr(row, 'data-position-status'), 16),
        team: team || { name: '待定', shortName: '待定', logo: null },
        stats,
        history
      };
    })
  };
}

function parseParticipant(card) {
  const opponent = find(card, 'team-participant-card__opponent'),
    team = teamOf(opponent),
    qualifier = find(card, 'team-participant-card__qualifier-details'),
    placement = find(card, 'placement-text');
  const tabs = findAll(card, 'switch-pill-option').map((n) => text(n));
  const areas = all(card).filter(
    (n) => attr(n, 'data-toggle-area-content') && find(n, 'team-participant-card__member')
  );
  const groups = (areas.length ? areas : [card]).map((area, i) => ({
    label: clip(tabs[i] || 'Main', 40),
    members: findAll(area, 'team-participant-card__member')
      .slice(0, 20)
      .map((member) => {
        const role = all(find(member, 'team-participant-card__member-role-left')).find(
            (n) => n.tagName === 'img'
          ),
          flag = all(find(member, 'flag')).find((n) => n.tagName === 'img'),
          name = find(member, 'name');
        return {
          id: clip(text(name), 60),
          role: clip(
            attr(role, 'alt') || text(find(member, 'team-participant-card__member-role-right')),
            30
          ),
          country: clip(attr(flag, 'alt'), 60)
        };
      })
      .filter((m) => m.id)
  }));
  return {
    team,
    label: clip(text(find(card, 'team-participant-card__label')), 40),
    qualifier: clip(text(qualifier), 120),
    qualifierPlacement: clip(text(placement), 20),
    groups: groups.filter((g) => g.members.length)
  };
}

const INFO = {
  'Series:': 'series',
  'Organizers:': 'organizers',
  'Organizer:': 'organizers',
  'Type:': 'type',
  'Location:': 'location',
  'Venue:': 'venue',
  'Format:': 'format',
  'Prize Pool:': 'prizePool',
  'Start Date:': 'startDate',
  'End Date:': 'endDate',
  'Teams:': 'teams'
};
function parseInfo(box) {
  if (!box) return null;
  const info = {
    title: clip(text(find(box, 'infobox-header')).replace(/^\[e\]\[h\]\s*/, ''), 200)
  };
  for (const label of findAll(box, 'infobox-description')) {
    const key = INFO[text(label)],
      value = kids(label.parentNode).find((n) => n !== label);
    if (!key || !value || info[key]) continue;
    const parts = lines(value).map((line) => clip(line, 120));
    info[key] = ['organizers', 'format'].includes(key) ? parts.slice(0, 8) : parts.join(' ');
  }
  return info;
}

export function parseDetailPage(html, page) {
  if (typeof html !== 'string' || html.length > MAX_HTML) throw Error('赛事详情格式异常');
  const tree = parseFragment(html);
  const result = { info: null, matches: [], standings: [], participants: [] };
  let heading = '',
    sub = '';
  const walk = (node) => {
    if (/^h[2-4]$/.test(node.tagName || '')) {
      heading = text(node).replace(/\s*\[\s*edit\s*\]\s*$/i, '');
      sub = '';
      return;
    }
    if (has(node, 'fo-nttax-infobox') && !result.info) {
      result.info = parseInfo(node);
      return;
    }
    if (has(node, 'brkts-matchlist-title')) sub = text(node).replace(/\s*Show\s*Hide\s*$/i, '');
    if (has(node, 'brkts-popup') && has(node, 'brkts-match-info-popup')) {
      const match = parseMatch(
        node,
        page,
        [...new Set([heading, sub].filter(Boolean))].join(' · ')
      );
      if (match && result.matches.length < 400) result.matches.push(match);
      return;
    }
    if (has(node, 'table2') && (has(node, 'standings-swiss') || has(node, 'standings-group'))) {
      if (result.standings.length < 12) result.standings.push(parseStandings(node, heading));
      return;
    }
    if (has(node, 'team-participant-card') && has(node, 'general-collapsible')) {
      if (result.participants.length < 64) result.participants.push(parseParticipant(node));
      return;
    }
    for (const child of node.childNodes || []) {
      child.parentNode = node;
      walk(child);
    }
  };
  walk(tree);
  return result;
}
