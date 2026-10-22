import {Fault} from '../security.mjs';
import {normalizeAnalysisOptions} from './analysis-options.mjs';
// Legacy webpages allow arbitrary 1–50 windows and default to supplementing history.
export function legacyQueryOptions(b={}){return normalizeQueryOptions(b,{legacy:true});}
export function normalizeQueryOptions(b,{legacy=false}={}){
 if(!b||typeof b!=='object'||Array.isArray(b))throw new Fault('请求格式错误');
 const rawTag=b.battletag??b.playerId??b.player;if(typeof rawTag!=='string')throw new Fault('缺少玩家 ID');
 const battletag=rawTag.trim();if(!battletag||battletag.length>80||!/^.+#\d+$/.test(battletag))throw new Fault('请输入完整战网昵称（昵称#编号）');
 const limit=b.limit===undefined?10:Number(b.limit);if(!Number.isInteger(limit)||(legacy?limit<1||limit>50:![5,10,20].includes(limit)))throw new Fault(legacy?'查询场次只能是 1—50':'查询场次只能是 5、10 或 20');
 let slow=legacy;
 if(b.mode!==undefined){if(!['fast','slow'].includes(b.mode))throw new Fault('查询模式只能是 fast 或 slow');slow=b.mode==='slow';}
 if(b.fast!==undefined){if(typeof b.fast!=='boolean')throw new Fault('快查询选项格式错误');if(b.mode!==undefined&&b.fast!==!slow)throw new Fault('查询模式与快查询选项冲突');slow=!b.fast;}
 if(b.supplementOtherMatches!==undefined){if(typeof b.supplementOtherMatches!=='boolean')throw new Fault('补充对局选项格式错误');if((b.mode!==undefined||b.fast!==undefined)&&b.supplementOtherMatches!==slow)throw new Fault('查询模式与补充对局选项冲突');slow=b.supplementOtherMatches;}
 // Query adapters historically coerce supplied side/strategy to strings; history uses strict enum values.
 const {pool,statisticsRange,side,strategy,estimate}=normalizeAnalysisOptions({...b,side:b.side===undefined?'all':String(b.side),strategy:b.strategy===undefined?'legacy':String(b.strategy)});
 if(b.syncHistory!==undefined&&typeof b.syncHistory!=='boolean')throw new Fault('历史同步选项格式错误');
 return {battletag,limit,supplementOtherMatches:slow,mode:slow?'slow':'fast',pool,statisticsRange,side,strategy,estimate,syncHistory:b.syncHistory!==false};
}
export function queryRequestId(b={}){
 const values=[b.requestId,b.idempotencyKey].filter(v=>v!==undefined);
 if(values.some(v=>typeof v!=='string'||!v.trim()||v.length>100))throw new Fault('请求标识格式错误');
 if(values.length===2&&values[0]!==values[1])throw new Fault('请求标识冲突');
 return values[0]||null;
}
