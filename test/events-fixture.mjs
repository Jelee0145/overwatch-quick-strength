export function card({
  path = 'Overwatch_Champions_Series/2026/Asia/Stage_3/Korea/Regular_Season',
  name = 'OWCS Korea Stage 3 - Regular Season',
  timestamp = '1792339200',
  teams = ['Crazy Raccoon', 'Team Falcons'],
  scores = null,
  bestOf = 5,
  finished = false
} = {}) {
  return `<div class="match-info"><span class="timer-object" ${timestamp === null ? '' : `data-timestamp="${timestamp}"`} ${finished ? 'data-finished="finished"' : ''}></span><div class="match-info-header">${teams.map((t) => `<div class="match-info-header-opponent"><span class="name"><a title="${t}">${t.slice(0, 3)}</a></span></div>`).join('')}<span class="match-info-header-scoreholder-upper">${scores ? scores.map((s) => `<span class="match-info-header-scoreholder-score">${s}</span>`).join(':') : 'vs'}</span><span class="match-info-header-scoreholder-lower">(Bo${bestOf})</span></div><div class="match-info-tournament-name"><a href="/overwatch/${path}">${name}</a></div></div>`;
}
export function page(
  upcoming = card(),
  recent = card({ finished: true, scores: [3, 0], timestamp: '1792252800' })
) {
  return `<div data-filter-expansion-template="#invoke:Lua|invoke|module=MatchTicker/Custom|fn=mainPage|type=upcoming|limit=50">${upcoming}</div><div data-filter-expansion-template="#invoke:Lua|invoke|module=MatchTicker/Custom|fn=mainPage|type=recent|limit=50">${recent}</div>`;
}
export const response = (html) => Response.json({ parse: { text: { '*': html } } });
