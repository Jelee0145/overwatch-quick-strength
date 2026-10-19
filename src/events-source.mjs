import {Fault} from './security.mjs';

export const EVENT_SOURCE='https://liquipedia.net/overwatch/api.php';
export const EVENT_LIMIT=200;
const DAY=86400000;
export function eventQuery(params){
 const series=(params.get('series')||'owcs').trim().toLowerCase();
 if(!['owcs','all'].includes(series))throw new Fault('赛事范围只支持 owcs 或 all');
 const from=(params.get('from')||'').trim(),to=(params.get('to')||'').trim();
 for(const value of [from,to])if(value&&(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value))throw new Fault('日期请使用有效的 YYYY-MM-DD');
 if(from&&to&&from>to)throw new Fault('开始日期不能晚于结束日期');
 if(from&&to&&Date.parse(to)-Date.parse(from)>365*DAY)throw new Fault('日期范围最多为 366 天，请分段查询');
 return {series,from:from&&to?from:'',to:from&&to?to:''};
}
export function eventApi({series='owcs',from='',to=''}={},limit=50){
 let conditions=series==='owcs'?' AND [[pagename::>Overwatch_Champions_Series/]] AND [[pagename::<Overwatch_Champions_Series0]]':'';
 if(from&&to){
  const stamp=ms=>new Date(ms).toISOString().slice(0,19).replace('T',' '),start=Date.parse(from+'T00:00:00+08:00'),end=Date.parse(to+'T00:00:00+08:00')+DAY;
  conditions+=' AND ([[date::>'+stamp(start)+']] OR [[date::'+stamp(start)+']]) AND [[date::<'+stamp(end)+']]';
 }
 const text=['upcoming','recent'].map(type=>'<div data-filter-expansion-template="#invoke:Lua|invoke|module=MatchTicker/Custom|fn=mainPage|type='+type+'">{{#invoke:Lua|invoke|module=MatchTicker/Custom|fn=mainPage|type='+type+'|limit='+limit+'|additionalConditions='+conditions+'}}</div>').join('\n');
 return EVENT_SOURCE+'?'+new URLSearchParams({action:'parse',text,contentmodel:'wikitext',prop:'text',format:'json',title:'Liquipedia:Matches'});
}
export function splitEventRange(range){
 if(!range.from||range.from===range.to)return null;
 const first=Date.parse(range.from),last=Date.parse(range.to),mid=first+Math.floor((last-first)/DAY/2)*DAY,date=ms=>new Date(ms).toISOString().slice(0,10);
 return [{...range,to:date(mid)},{...range,from:date(mid+DAY)}];
}
