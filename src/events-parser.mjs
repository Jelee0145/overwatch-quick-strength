import {parseFragment} from './shared/events-html.mjs';

const attr=(node,key)=>node.attrs?.find(a=>a.name===key)?.value||'';
const has=(node,name)=>attr(node,'class').split(/\s+/).includes(name);
const nodes=node=>[node,...(node.childNodes||[]).flatMap(nodes)];
const text=node=>(node?.nodeName==='#text'?node.value:(node?.childNodes||[]).map(text).join('')).replace(/\s+/g,' ').trim();
const first=(node,name)=>nodes(node).find(n=>has(n,name));
export function liquipediaLink(value){
 try{const u=new URL(value,'https://liquipedia.net');return u.protocol==='https:'&&u.hostname==='liquipedia.net'&&!u.username&&!u.password&&!u.port&&u.pathname.startsWith('/overwatch/')?u.href:null;}catch{return null;}
}
export function liquipediaLogo(value){
 try{const u=new URL(value,'https://liquipedia.net');return u.protocol==='https:'&&u.hostname==='liquipedia.net'&&!u.username&&!u.password&&!u.port&&u.pathname.startsWith('/commons/images/')&&/\.(png|svg|webp|jpe?g|gif)$/i.test(u.pathname)?u.href:null;}catch{return null;}
}
function region(path){
 if(/\/China(?:\/|$)/i.test(path))return '中国';
 if(/\/Korea(?:\/|$)/i.test(path))return '韩国';
 if(/\/Japan(?:\/|$)/i.test(path))return '日本';
 if(/\/Pacific(?:\/|$)/i.test(path))return '太平洋';
 if(/\/(?:North_America|NA)(?:\/|$)/i.test(path))return '北美';
 if(/\/EMEA(?:\/|$)/i.test(path))return 'EMEA';
 if(/\/Asia(?:\/|$)/i.test(path))return '亚洲';
 return '国际赛';
}
function team(node){
 const name=first(node,'name'),link=nodes(name||node).find(n=>n.tagName==='a');
 const icon=nodes(node).find(n=>has(n,'team-template-image-icon')&&!has(n,'team-template-darkmode')),image=nodes(icon||{}).find(n=>n.tagName==='img');
 return {name:(attr(link||{},'title').replace(/ \(page does not exist\)$/,'')||text(name)||'待定').slice(0,160),shortName:text(name).slice(0,80)||'待定',logo:liquipediaLogo(attr(image||{},'src'))};
}
export function parseEvents(html){
 if(typeof html!=='string'||html.length>2*1024*1024)throw Error('赛事数据格式异常');
 const tree=parseFragment(html),all=nodes(tree),sections=all.filter(n=>/\btype=(upcoming|recent)\b/.test(attr(n,'data-filter-expansion-template')));
 if(sections.length!==2||!sections.some(n=>attr(n,'data-filter-expansion-template').includes('type=upcoming'))||!sections.some(n=>attr(n,'data-filter-expansion-template').includes('type=recent')))throw Error('赛事页面结构已变化');
 const matches=[],seen=new Map();
 for(const section of sections){
  const cards=nodes(section).filter(n=>has(n,'match-info'));
  if(!cards.length&&text(section)&&!/^No (?:upcoming|recent|completed) matches\.?$/i.test(text(section)))throw Error('赛事列表结构已变化');
  for(const card of cards){
   const tournament=first(card,'match-info-tournament-name'),link=nodes(tournament||{}).find(n=>n.tagName==='a'),url=liquipediaLink(attr(link||{},'href'));
   if(!url)throw Error('赛事来源链接缺失');
   const path=decodeURI(new URL(url).pathname);
   if(!path.startsWith('/overwatch/Overwatch_Champions_Series/'))continue;
   const opponents=nodes(card).filter(n=>has(n,'match-info-header-opponent'));
   if(opponents.length!==2||!text(tournament))throw Error('赛事对阵格式已变化');
   const timer=first(card,'timer-object'),raw=attr(timer||{},'data-timestamp'),seconds=/^\d+$/.test(raw)?Number(raw):0;
   const startsAt=seconds>0&&Number.isFinite(seconds)&&seconds<253402300800?new Date(seconds*1000).toISOString():null;
   const teams=opponents.map(team),scoreNodes=nodes(card).filter(n=>has(n,'match-info-header-scoreholder-score'));
   const scores=teams.map((_,i)=>/^\d{1,3}$/.test(text(scoreNodes[i]))?Number(text(scoreNodes[i])):null);
   const format=text(first(card,'match-info-header-scoreholder-lower')).match(/\bBo\s*(\d{1,2})\b/i);
   const status=attr(section,'data-filter-expansion-template').includes('type=recent')||attr(timer||{},'data-finished')==='finished'?'completed':'scheduled';
   const id=[url,startsAt||'tbd',...teams.map(t=>t.name)].join('|');
   const match={id,startsAt,status,teams,scores,bestOf:format?Number(format[1]):null,tournament:text(tournament).slice(0,240),region:region(path),sourceUrl:url};
   if(seen.has(id)){if(status==='completed')matches[seen.get(id)]=match;continue;}
   seen.set(id,matches.length);matches.push(match);
  }
 }
 return matches;
}
