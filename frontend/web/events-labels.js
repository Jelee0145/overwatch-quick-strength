'use strict';
// Liquipedia writes labels in English; translate the common ones and keep the rest as-is.
// Shared by the event detail page and the events home standings.
window.EventLabels = (() => {
  const WORDS = [
    [/\bRegular Season\b/gi, '常规赛'],
    [/\bRegional Playoffs\b/gi, '区域季后赛'],
    [/\bPlayoffs?\b/gi, '季后赛'],
    [/\bSwiss (?:Stage|System|Standings)\b/gi, '瑞士轮'],
    [/\bSwiss\b/gi, '瑞士轮'],
    [/\bGroup Stage\b/gi, '小组赛'],
    [/\bGroup ([A-Z])\b/g, '$1 组'],
    [/\bMain Event\b/gi, '正赛'],
    [/\bKnockout Stage\b/gi, '淘汰赛'],
    [/\bPlay-?Ins?\b/gi, '附加赛'],
    [/\bUpper Bracket\b/gi, '胜者组'],
    [/\bLower Bracket\b/gi, '败者组'],
    [/\bGrand Finals?\b/gi, '总决赛'],
    [/\bQuarter-?finals?\b/gi, '四分之一决赛'],
    [/\bSemi-?finals?\b/gi, '半决赛'],
    [/\bFinals?\b/gi, '决赛'],
    [/\bThird Place Match\b/gi, '季军赛'],
    [/\bWeek (\d+)\b/gi, '第 $1 周'],
    [/\bDay (\d+)\b/gi, '第 $1 天'],
    [/\bRound (\d+)\b/gi, '第 $1 轮'],
    [/\bStage (\d+)\b/gi, '第 $1 阶段'],
    [/\bSingle[- ]Elimination\b/gi, '单败淘汰'],
    [/\bDouble[- ]Elimination\b/gi, '双败淘汰'],
    [/\bRound[- ]Robin(?: Stage| Standings)?\b/gi, '循环赛'],
    [/\bBracket\b/gi, '对阵'],
    [/\bOnline\b/gi, '线上'],
    [/\bOffline\b/gi, '线下'],
    [/\bHybrid\b/gi, '线上+线下'],
    [/\bInvited\b/gi, '受邀'],
    [/\bQualified\b/gi, '晋级'],
    // Last, so "Swiss/Round Robin Standings" collapse to the format name first.
    [/\bStandings\b/gi, '积分榜'],
    [/\bTBA\b/g, '待定'],
    [/\bTBD\b/g, '待定']
  ];
  const zh = (value) => WORDS.reduce((s, [re, to]) => s.replace(re, to), String(value || ''));
  const COLUMNS = {
    Matches: '比赛',
    Match: '比赛',
    Maps: '地图',
    Map: '地图',
    Games: '小局',
    Game: '小局',
    GD: '净胜局',
    Points: '积分',
    Pts: '积分',
    'Map Diff': '净胜图',
    'Map Diff.': '净胜图',
    Diff: '净胜',
    'W-L': '胜-负',
    Buchholz: '布赫霍尔茨分'
  };
  const ROLES = {
    dps: '输出',
    damage: '输出',
    tank: '重装',
    support: '支援',
    flex: '自由人',
    coach: '教练',
    'head coach': '主教练',
    'assistant coach': '助理教练',
    analyst: '分析师',
    manager: '经理',
    substitute: '替补'
  };
  const GROUPS = { main: '阵容', staff: '教练组', former: '前成员', substitutes: '替补' };
  const STATUS = { up: '晋级', stayup: '晋级', down: '淘汰', stay: '' };
  return { zh, COLUMNS, ROLES, GROUPS, STATUS };
})();
