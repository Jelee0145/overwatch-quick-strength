// Hand-written fixture that mirrors the class structure of Liquipedia's action=parse output
// for an OWCS stage page (content from Liquipedia, CC BY-SA 3.0; trimmed and anonymised).
export const ROOT = 'Overwatch_Champions_Series/2026/Asia/Stage_3/Korea';
export const SUB = ROOT + '/Regular_Season';
export const BADGE = 'https://liquipedia.net/commons/images/thumb/a/ab/CR.png/50px-CR.png';
const team = (name, short, logo = '') =>
  (logo
    ? `<span class="team-template-image-icon team-template-lightmode"><img src="${logo}"></span>` +
      `<span class="team-template-image-icon team-template-darkmode"><img src="/commons/images/dark.png"></span>`
    : '') +
  `<span class="team-name"><a href="/overwatch/${name}" title="${name}">${name}</a></span>` +
  `<span class="team-shortname">${short}</span>`;
const game = (map, mode, a, b, win) =>
  `<div class="brkts-popup-body-grid-row">` +
  `<div class="generic-label" data-label-type="${win === 0 ? 'result-win' : 'result-loss'}"></div>` +
  `<div class="brkts-popup-body-grid-row-detail">` +
  `<div class="brkts-popup-spaced">${a}</div>` +
  `<div class="brkts-popup-spaced"><a href="/overwatch/${mode}" title="${mode}"><img src="/m.png"></a><a href="/overwatch/${map}" title="${map}">${map}</a></div>` +
  `<div class="brkts-popup-spaced">${b}</div></div>` +
  `<div class="generic-label" data-label-type="${win === 1 ? 'result-win' : 'result-loss'}"></div></div>`;
const veto = (n, left, right) =>
  `<div class="brkts-popup-veto-row"><div class="brkts-champion-icon"><a href="/overwatch/${left}" title="${left}"><img src="/h.png"></a></div>` +
  `<div class="brkts-popup-veto-row-indicator">Map ${n}</div>` +
  `<div class="brkts-champion-icon"><a href="/overwatch/${right}" title="${right}"><img src="/h.png"></a></div></div>`;
export const popup = (stamp = 1792339200) =>
  `<div class="brkts-popup brkts-match-info-popup">` +
  `<span class="timer-object" data-timestamp="${stamp}" data-finished="finished"></span>` +
  `<div class="match-info-header">` +
  `<div class="match-info-header-opponent match-info-header-winner">${team('Crazy Raccoon', 'CR', BADGE)}</div>` +
  `<div class="match-info-header-scoreholder"><span class="match-info-header-scoreholder-upper"><span class="match-info-header-scoreholder-score">3</span>:<span class="match-info-header-scoreholder-score">1</span></span><span class="match-info-header-scoreholder-lower">(Bo5)</span></div>` +
  `<div class="match-info-header-opponent">${team('Team Falcons', 'FLC')}</div></div>` +
  game('Busan', 'Control', 2, 0, 0) +
  game("King's Row", 'Hybrid', 2, 3, 1) +
  game('Colosseo', 'Push', 1, 0, 0) +
  game('Dorado', 'Escort', 3, 2, 0) +
  `<div class="brkts-popup-body-grid-row"><div class="generic-label"></div><div class="brkts-popup-body-grid-row-detail"><div class="brkts-popup-spaced"></div><div class="brkts-popup-spaced"></div><div class="brkts-popup-spaced"></div></div><div class="generic-label"></div></div>` +
  veto(1, 'Tracer', 'Ana') +
  veto(2, 'Shion', 'Kiriko') +
  `<div class="brkts-popup-mvp">MVP: <a href="/overwatch/Proper">Proper</a></div></div>`;
const swiss =
  `<div class="table2 standings-swiss"><div class="table2__title">Swiss Standings</div><table><tbody>` +
  `<tr class="table2__row--head"><th>#</th><th>Participant</th><th>Matches</th><th>Maps</th><th>Round 1</th><th>Round 2</th></tr>` +
  `<tr class="table2__row--body" data-position-status="up"><td><span class="label--placement">1</span></td>` +
  `<td><span class="block-team">${team('Crazy Raccoon', 'CR', BADGE)}</span></td><td>2-0</td><td>6-1</td>` +
  `<td class="standings-swiss-match"><span class="label--standings-result" data-label-type="result-win"><span>3</span><span>-</span><span>1</span></span><span class="team-template-team-icon" data-highlighting-class="Team Falcons"></span></td>` +
  `<td class="standings-swiss-match"></td></tr></tbody></table></div>`;
const member = (id, role, country) =>
  `<div class="team-participant-card__member"><span class="team-participant-card__member-role-left"><img alt="${role}"></span><span class="flag"><img alt="${country}"></span><span class="name">${id}</span></div>`;
const teamcard =
  `<div class="team-participant-card general-collapsible">` +
  `<div class="team-participant-card__opponent">${team('Crazy Raccoon', 'CR', BADGE)}</div>` +
  `<div class="team-participant-card__qualifier-details">Invited</div>` +
  `<span class="switch-pill-option">Main</span><span class="switch-pill-option">Staff</span>` +
  `<div data-toggle-area-content="1">${member('Proper', 'DPS', 'South Korea')}${member('Rio', 'Support', 'South Korea')}</div>` +
  `<div data-toggle-area-content="2"><div class="team-participant-card__member"><span class="team-participant-card__member-role-right">Coach</span><span class="name">Coach1</span></div></div></div>`;
const infobox =
  `<div class="fo-nttax-infobox"><div class="infobox-header">[e][h] OWCS 2026 Korea Stage 3</div>` +
  `<div><div class="infobox-description">Organizers:</div><div>WDG<br>Blizzard</div></div>` +
  `<div><div class="infobox-description">Type:</div><div>Online</div></div>` +
  `<div><div class="infobox-description">Prize Pool:</div><div>$100,000 USD</div></div>` +
  `<div><div class="infobox-description">Start Date:</div><div>2026-10-10</div></div></div>`;
export const rootHtml = `${infobox}<h2>Participants</h2>${teamcard}<h2>Results</h2><h3>Swiss Stage</h3>${swiss}`;
export const subHtml = `<h3>Week 1</h3><div class="brkts-matchlist-title">Day 1 Show Hide</div>${popup()}`;
