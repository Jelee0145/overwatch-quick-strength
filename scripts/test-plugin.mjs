import {spawnSync} from 'node:child_process';
const python=process.env.PYTHON||(process.platform==='win32'?'python':'python3');
const result=spawnSync(python,['-m','unittest','discover','-s','test/plugin','-v'],{stdio:'inherit'});
if(result.error){console.error('Python test runner unavailable; set PYTHON to a Python 3.10+ executable.');process.exit(1);}
process.exit(result.status??1);
