// Cloud adapter preserving every existing query import and call signature.
import {playerIdentity} from './cache-records.mjs';
import {digest,canonical,token} from './security.mjs';
import {upstream} from './dashen.mjs';
import {createMatchService} from './services/matches.mjs';
import {analysisService,dataService} from './services/runtime.mjs';
const service=createMatchService({provider:upstream,pick:analysisService.pick,playerIdentity,digest,canonical,createId:token,data:dataService});
export const {createQuery,queryStep,runQuery,queryProgress,accountScope,accountRecords,queryCheckpoint,restoreQuery,upgradeQuery,ingestCache}=service;
