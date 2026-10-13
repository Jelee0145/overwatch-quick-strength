(function(root){
'use strict';
// The sole scoring configuration. Weights/finish ratios are product rules,
// not measured percentiles. Category baselines use medians of public snapshots.
const profiles={
 assassin:{name:'刺客 / 狗位',role:'dps',style:'dive',groups:{survival:.40,finish:.40,damage:.20},finish:{kill:.30,finalHit:.50,soloKill:.20},finalRatio:.55,soloRatio:.12,primary:{kill:60,heroDamage:50}},
 ranged:{name:'长枪 / 远程',role:'dps',style:'poke',groups:{survival:.40,finish:.30,damage:.30},finish:{kill:.35,finalHit:.50,soloKill:.15},finalRatio:.55,soloRatio:.08,primary:{kill:60,heroDamage:60}},
 utility_dps:{name:'功能输出',role:'dps',style:'brawl',groups:{survival:.40,finish:.25,damage:.20,utility:.15},finish:{kill:.45,finalHit:.40,soloKill:.15},utility:{assist:1},finalRatio:.40,soloRatio:.06,primary:{kill:55,heroDamage:55}},
 mobile_tank:{name:'机动坦',role:'tank',style:'dive',groups:{survival:.40,finish:.30,damage:.25,mitigation:.05},finish:{kill:.40,finalHit:.45,soloKill:.15},finalRatio:.40,soloRatio:.05,primary:{kill:60,heroDamage:55}},
 ground_tank:{name:'地推坦',role:'tank',style:'brawl',groups:{survival:.40,finish:.20,damage:.25,mitigation:.15},finish:{kill:.45,finalHit:.45,soloKill:.10},finalRatio:.40,soloRatio:.04,primary:{kill:55,heroDamage:60}},
 poke_tank:{name:'消耗坦',role:'tank',style:'poke',groups:{survival:.40,finish:.20,damage:.30,mitigation:.10},finish:{kill:.40,finalHit:.50,soloKill:.10},finalRatio:.40,soloRatio:.04,primary:{kill:55,heroDamage:60}},
 healing_support:{name:'治疗型支援',role:'healer',style:'brawl',groups:{survival:.40,finish:.10,damage:.10,utility:.40},finish:{kill:.50,finalHit:.40,soloKill:.10},utility:{cure:.80,assist:.20},finalRatio:.30,soloRatio:.03,primary:{cure:60}},
 utility_support:{name:'功能型支援',role:'healer',style:'dive',groups:{survival:.40,finish:.10,damage:.10,utility:.40},finish:{kill:.50,finalHit:.40,soloKill:.10},utility:{cure:.55,assist:.45},finalRatio:.30,soloRatio:.03,primary:{cure:55,assist:60}},
 offensive_support:{name:'输出型支援',role:'healer',style:'poke',groups:{survival:.40,finish:.20,damage:.20,utility:.20},finish:{kill:.35,finalHit:.50,soloKill:.15},utility:{cure:.80,assist:.20},finalRatio:.45,soloRatio:.06,primary:{kill:60,heroDamage:60,cure:50}}
};
const members={
 assassin:'tracer genji reaper venture anran vendetta echo',
 ranged:'widowmaker hanzo cassidy soldier76 sojourn ashe bastion pharah freja emre sierra shion',
 utility_dps:'mei symmetra torbjorn junkrat',
 mobile_tank:'winston doomfist wrecking-ball dva hazard dmon',
 ground_tank:'reinhardt orisa zarya ramattra roadhog mauga junker-queen',
 poke_tank:'sigma domina',
 healing_support:'lifeweaver moira juno mizuki doctrine',
 utility_support:'ana kiriko lucio brigitte mercy jetpackcat sombra',
 offensive_support:'zenyatta wuyang illari baptiste'
};
const heroProfiles=Object.fromEntries(Object.entries(members).flatMap(([id,slugs])=>slugs.split(' ').map(slug=>[slug,id])));
// Tags describe a default archetype, not an observed in-game team strategy.
const styles={
 poke:{name:'Poke / 消耗',shift:{damage:.02,finish:-.02}},
 dive:{name:'放狗',shift:{finish:.02,damage:-.02}},
 brawl:{name:'地推 / 抱团',shift:{utility:.02,damage:-.02}}
};
const overrides={
 torbjorn:{groups:{survival:.40,finish:.25,damage:.35},note:'功能输出·压制；炮台空间作用不可测，不强求助攻'},
 junkrat:{groups:{survival:.40,finish:.25,damage:.35},note:'功能输出·压制；区域封锁不可测，不强求助攻'},
 mercy:{groups:{survival:.40,utility:.60},survival:{death:1},utility:{cure:.55,assist:.45},primary:{cure:60,assist:60},baselineFromHero:['kill','death','heroDamage','cure','assist'],note:'增伤、复活无法从现有面板量化；不强求击杀或伤害'},
 roadhog:{groups:{survival:.40,finish:.30,damage:.30},note:'自愈承伤，不强求抵挡'},
 mauga:{groups:{survival:.40,finish:.30,damage:.30},note:'自愈承伤，不强求抵挡'},
 'junker-queen':{groups:{survival:.40,finish:.30,damage:.30},note:'自愈承伤，不强求抵挡'},
 widowmaker:{baselineMultipliers:{kill:.85,heroDamage:.70},finalRatio:.70,note:'狙击爆发，降低累计伤害与参与击杀目标，强化最后一击'},
 zenyatta:{note:'输出型支援：保留治疗底线，输出与击杀必须达标'},
 wuyang:{note:'输出型支援：保留治疗底线，输出与击杀必须达标'},
 sombra:{baselineFromHero:['kill','heroDamage','cure','assist'],primary:{assist:60,heroDamage:55},note:'当前接口为支援；治疗量级特殊，保留单独基准例外'}
};
// Heuristic relative need, not measured population healing percentiles.
const resources={version:'1.0',maxDelta:5,lowRatio:.65,highRatio:1.5,minDuration:120,
 needs:{assassin:1,ranged:.9,utility_dps:1.1,mobile_tank:2.2,ground_tank:3,poke_tank:2,
  healing_support:.7,utility_support:.65,offensive_support:.7},
 selfSustain:{soldier76:{sensitivity:.35,healingNeed:.65},tracer:{sensitivity:.30,healingNeed:.55},
  reaper:{sensitivity:.45,healingNeed:.65},mei:{sensitivity:.50,healingNeed:.65},
  roadhog:{sensitivity:.30,healingNeed:.55},mauga:{sensitivity:.40,healingNeed:.70},
  'junker-queen':{sensitivity:.45,healingNeed:.75},'wrecking-ball':{sensitivity:.35,healingNeed:.60},
  moira:{sensitivity:.40,healingNeed:.60},lucio:{sensitivity:.50,healingNeed:.70},
  brigitte:{sensitivity:.60,healingNeed:.80},mercy:{sensitivity:.60,healingNeed:.80},
  kiriko:{sensitivity:.65,healingNeed:.85},baptiste:{sensitivity:.65,healingNeed:.85},
  illari:{sensitivity:.65,healingNeed:.85}},
 source:'本场同队定位归一中位数；权重、区间和英雄敏感度为保守规则，非社区实测分位数'};
const rules={version:'2.1',profiles,heroProfiles,styles,overrides,resources,survival:{kd:.55,death:.45},
 defaults:{tank:'ground_tank',dps:'ranged',healer:'healing_support'},
 finishSource:'规则参考：定位击杀中位数 × 配置比例；非社区最后一击/单独消灭实测均值'};
root.QS_RATING_RULES=rules;if(typeof module!=='undefined')module.exports=rules;
})(typeof window!=='undefined'?window:globalThis);
