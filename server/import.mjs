import {SqliteDatabase} from './storage.mjs';
import {importMigration} from './migration.mjs';
process.umask(0o077);
let body='',bytes=0;for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>256*1024*1024)throw Error('Migration too large');body+=chunk.toString('utf8');}
const database=new SqliteDatabase(process.env.OWQS_DATABASE||'/var/lib/owqs/state.sqlite3');
try{const summary=await importMigration(database,JSON.parse(body),{configPath:process.env.OWQS_CONFIG||'/etc/owqs/config.json'});console.log(JSON.stringify({imported:true,...summary}));}
catch{console.error('Migration validation/import failed; no confidential details logged');process.exitCode=1;}
finally{await database.close();}
