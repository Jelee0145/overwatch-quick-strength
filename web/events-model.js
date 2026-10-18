(function(root){
 'use strict';
 const dateFormat=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'});
 function day(value){if(!value)return '';const date=new Date(value);if(!Number.isFinite(date.getTime()))return '';const parts=Object.fromEntries(dateFormat.formatToParts(date).map(p=>[p.type,p.value]));return `${parts.year}-${parts.month}-${parts.day}`;}
 function select(matches,{view='scheduled',from='',to='',tournament='',region='',team=''}={}){
  const query=team.trim().toLocaleLowerCase();
  return matches.filter(m=>{
   const date=day(m.startsAt);
   return (view==='completed'?m.status==='completed':m.status!=='completed')&&(!from||date&&date>=from)&&(!to||date&&date<=to)&&(!tournament||m.tournament===tournament)&&(!region||m.region===region)&&(!query||m.teams.some(t=>[t.name,t.shortName].some(n=>n.toLocaleLowerCase().includes(query))));
  }).sort((a,b)=>{
   if(!a.startsAt||!b.startsAt)return a.startsAt?-1:b.startsAt?1:0;
   return (Date.parse(a.startsAt)-Date.parse(b.startsAt))*(view==='completed'?-1:1);
  });
 }
 root.EventsModel={day,select};
})(typeof window==='undefined'?globalThis:window);
