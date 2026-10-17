// Synthetic data only. Stable timestamps make pre-refactor comparisons reproducible.
export function analysisFixture(){
 const hero='207165582859042818',stamp='2026-10-14T00:00:00.000Z';
 return {schemaVersion:3,battletag:'Fixture#100',source:'匿名测试',queriedAt:stamp,matches:Array.from({length:12},(_,i)=>({mid:'fixture-'+i,t:1000+i,ret:i%2?1:-1,mapGuid:'map',duration:i===0?180:600,hasGameData:true,resourceDataChecked:true,dataQueriedAt:stamp,teamScore:2,opponentScore:1,players:Array.from({length:10},(_,j)=>({name:j?'Player'+j+'#100':'Fixture#100',side:j<5?'T':'E',hero,stats:{kill:20+i,assist:8,death:4,heroDamage:10000+j*100,cure:null,resistDamage:6000,finalHit:10,soloKill:2,targetCompetingTime:20,healingTaken:3000,damageTaken:8000},res:j===8?{rows:[],error:true}:j===9?{rows:[]}:{rows:[{r:'dps',s:399,n:'白金',d:3}],rankQueriedAt:stamp}}))})),recentHistory:[],syncStatus:{fetchedMatches:12,reusedMatches:0},historyStatus:{requests:0}};
}

export function archiveFixture(){
 const a=analysisFixture(),b=analysisFixture();b.queriedAt='2026-10-15T00:00:00.000Z';
 b.matches=b.matches.map((m,i)=>({...m,mid:'fixture-'+(i+8),t:1008+i,players:m.players.map(p=>({...p,res:{rows:[]}}))}));
 return {tag:a.battletag,batches:{a:{content:{data:a},signature:'synthetic-a'},z:{content:{data:b},signature:'synthetic-z'}},matches:Array.from({length:20},(_,i)=>({mid:'fixture-'+i,t:1000+i,batchId:i<8?'a':'z'}))};
}
