import {Fault} from './security.mjs';
const regions={CN:'中国',KR:'韩国',JP:'日本',PAC:'太平洋',NA:'北美',ASIA:'亚洲',GLOBAL:'国际赛',EMEA:'EMEA'};
export function filterEvents(data,params){
 const allowed=['from','to','region','tournament','team','status','limit'];
 for(const key of params.keys())if(!allowed.includes(key))throw new Fault('不支持的赛程筛选参数');
 const filters=Object.fromEntries(allowed.map(k=>[k,(params.get(k)||'').trim()]));
 for(const key of ['team','region','tournament'])if(filters[key].length>160)throw new Fault('赛程筛选内容过长');
 for(const key of ['from','to'])if(filters[key]&&(!/^\d{4}-\d{2}-\d{2}$/.test(filters[key])||!Number.isFinite(Date.parse(filters[key]+'T00:00:00Z'))||new Date(filters[key]+'T00:00:00Z').toISOString().slice(0,10)!==filters[key]))throw new Fault('日期请使用有效的 YYYY-MM-DD');
 if(filters.from&&filters.to&&filters.from>filters.to)throw new Fault('开始日期不能晚于结束日期');
 filters.status=filters.status||'scheduled';if(!['scheduled','completed','all'].includes(filters.status))throw new Fault('比赛状态只能是 scheduled、completed 或 all');
 const limit=filters.limit?Number(filters.limit):10;if(!Number.isInteger(limit)||limit<1||limit>20)throw new Fault('赛程条数只能是 1—20');delete filters.limit;
 filters.region=regions[filters.region.toUpperCase()]||filters.region.replace(/赛区$/,'');
 const contains=(value,query)=>String(value||'').toLowerCase().includes(query.toLowerCase());
 const matches=data.matches.filter(m=>{
  const date=m.startsAt?new Date(Date.parse(m.startsAt)+8*3600000).toISOString().slice(0,10):'';
  return (filters.status==='all'||m.status===filters.status)&&(!filters.from||date&&date>=filters.from)&&(!filters.to||date&&date<=filters.to)&&(!filters.region||m.region===filters.region)&&(!filters.tournament||contains(m.tournament,filters.tournament))&&(!filters.team||m.teams.some(t=>contains(t.name,filters.team)||contains(t.shortName,filters.team)));
 }).sort((a,b)=>!a.startsAt||!b.startsAt?a.startsAt?-1:b.startsAt?1:0:(Date.parse(a.startsAt)-Date.parse(b.startsAt))*(filters.status==='completed'?-1:1));
 return {...data,matches:matches.slice(0,limit),total:matches.length,limit,filters};
}
