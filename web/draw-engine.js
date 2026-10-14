'use strict';
window.HeroDrawEngine=Object.freeze({
 pool(heroes,role){return heroes.filter(hero=>role==='all'||hero.role===role);},
 pick(pool,random=()=>crypto.getRandomValues(new Uint32Array(1))[0]){
  if(!Array.isArray(pool)||!pool.length)throw Error('当前英雄池为空');
  // Rejection sampling avoids the modulo bias of a uint32 draw.
  const bound=2**32-(2**32%pool.length);let value;
  do{value=random();if(!Number.isInteger(value)||value<0||value>=2**32)throw Error('随机数生成失败');}while(value>=bound);
  return pool[value%pool.length];
 },
 sequence(pool,length,selectedIndex,selected,random){
  const sequence=[],gap=Math.min(8,pool.length-2);
  for(let i=0;i<length;i++){
   if(i===selectedIndex){sequence.push(selected);continue;}
   const recent=new Set(sequence.slice(Math.max(0,i-gap)).map(hero=>hero.id));
   if(Math.abs(i-selectedIndex)<=gap)recent.add(selected.id);
   sequence.push(this.pick(pool.filter(hero=>!recent.has(hero.id)),random));
  }
  return sequence;
 }
});
