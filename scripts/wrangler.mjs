import {spawn} from 'node:child_process';import path from 'node:path';
const base=path.resolve(import.meta.dirname,'..');
const child=spawn(process.execPath,[path.join(base,'node_modules/wrangler/bin/wrangler.js'),...process.argv.slice(2)],{cwd:base,stdio:'inherit',env:{...process.env,WRANGLER_SEND_METRICS:'false',WRANGLER_LOG_PATH:path.join(base,'.wrangler/logs'),XDG_CONFIG_HOME:path.join(base,'.private/config')}});
child.on('exit',code=>process.exit(code??1));
