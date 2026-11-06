import { heroes } from '../shared/data.mjs';
import media from '../shared/media.mjs';

// Liquipedia writes heroes and maps in English. Only names confirmed against the site's
// own Chinese hero/map data are translated; anything unknown keeps its English name and
// no picture, rather than guessing. Pictures always come from this site's /media copies.
const HERO_NAMES = {
  Reaper: '死神',
  Tracer: '猎空',
  Mercy: '天使',
  Hanzo: '半藏',
  Torbjörn: '托比昂',
  Torbjorn: '托比昂',
  Reinhardt: '莱因哈特',
  Pharah: '法老之鹰',
  Winston: '温斯顿',
  Widowmaker: '黑百合',
  Bastion: '堡垒',
  Symmetra: '秩序之光',
  Zenyatta: '禅雅塔',
  Genji: '源氏',
  Roadhog: '路霸',
  Cassidy: '卡西迪',
  Junkrat: '狂鼠',
  Zarya: '查莉娅',
  'Soldier: 76': '士兵：76',
  'Soldier 76': '士兵：76',
  Lúcio: '卢西奥',
  Lucio: '卢西奥',
  'D.Va': 'D.Va',
  Mei: '美',
  Sombra: '黑影',
  Doomfist: '末日铁拳',
  Ana: '安娜',
  Orisa: '奥丽莎',
  Brigitte: '布丽吉塔',
  Moira: '莫伊拉',
  'Wrecking Ball': '破坏球',
  Sojourn: '索杰恩',
  Ashe: '艾什',
  Echo: '回声',
  Baptiste: '巴蒂斯特',
  Kiriko: '雾子',
  'Junker Queen': '渣客女王',
  Sigma: '西格玛',
  Ramattra: '拉玛刹',
  Lifeweaver: '生命之梭',
  Mauga: '毛加',
  Illari: '伊拉锐',
  Venture: '探奇',
  Hazard: '骇灾',
  Juno: '朱诺',
  Freja: '弗蕾娅',
  Wuyang: '无漾',
  Anran: '安燃',
  Emre: '埃姆雷',
  'Jetpack Cat': '飞天猫',
  Vendetta: '斩仇',
  Sierra: '西拉',
  'D.Mon': 'D.Mon'
};
const MAP_NAMES = {
  Busan: '釜山',
  Ilios: '伊利奥斯',
  'Lijiang Tower': '漓江塔',
  Nepal: '尼泊尔',
  Oasis: '绿洲城',
  'Antarctic Peninsula': '南极半岛',
  Samoa: '萨摩亚',
  'Circuit Royal': '皇家赛道',
  Dorado: '多拉多',
  Havana: '哈瓦那',
  Junkertown: '渣客镇',
  Rialto: '里阿尔托',
  'Route 66': '66号公路',
  'Shambali Monastery': '香巴里寺院',
  'Watchpoint: Gibraltar': '监测站：直布罗陀',
  'Blizzard World': '暴雪世界',
  Eichenwalde: '艾兴瓦尔德',
  Hollywood: '好莱坞',
  "King's Row": '国王大道',
  Midtown: '中城',
  Numbani: '努巴尼',
  Paraíso: '帕拉伊苏',
  Paraiso: '帕拉伊苏',
  Colosseo: '斗兽场',
  Esperança: '埃斯佩兰萨',
  Esperanca: '埃斯佩兰萨',
  'New Queen Street': '新皇后街',
  Runasapi: '鲁纳塞彼',
  'New Junk City': '新渣客城',
  Suravasa: '苏拉瓦萨',
  Aatlis: '阿特利斯',
  'Neon Junction': '霓虹枢纽',
  Hanaoka: '花冈',
  'Throne of Anubis': '阿努比斯王座'
};
const MODES = {
  Control: '占领要点',
  Escort: '运载目标',
  Hybrid: '攻击/护送',
  Flashpoint: '闪点作战',
  Push: '机动推进',
  Clash: '攻防阵线',
  Assault: '攻防作战'
};
const heroIcon = new Map(),
  mapImage = new Map();
for (const [guid, hero] of Object.entries(heroes))
  if (media.heroIcons?.[guid] && !heroIcon.has(hero.name)) heroIcon.set(hero.name, media.heroIcons[guid]);
for (const entry of Object.values(media.maps || {}))
  if (entry?.preview && !mapImage.has(entry.name)) mapImage.set(entry.name, entry.preview);

export function heroTerm(en) {
  const name = HERO_NAMES[en];
  return { en, name: name || en, icon: (name && heroIcon.get(name)) || null };
}
export function mapTerm(en, mode) {
  const name = MAP_NAMES[en];
  return {
    en,
    name: name || en,
    mode: MODES[mode] || mode || '',
    image: (name && mapImage.get(name)) || null
  };
}
