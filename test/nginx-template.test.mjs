import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';

const template=await readFile(path.resolve(import.meta.dirname,'../deploy/nginx-https.conf'),'utf8');

test('public origin keeps one connection and can resume TLS sessions',()=>{
 // A first-load graph is several files; without HTTP/2 each one pays a handshake on
 // a path that measurably drops handshake packets.
 assert.match(template,/^\s*listen 8443 ssl;/m);
 assert.match(template,/^\s*http2 on;/m);
 assert.doesNotMatch(template,/listen 8443 ssl http2;/,'the combined form is deprecated in nginx 1.25+');
 assert.match(template,/ssl_session_cache shared:/);
 assert.match(template,/ssl_session_timeout /);
});

test('upstream sockets are pooled so loopback does not accumulate TIME_WAIT',()=>{
 assert.match(template,/upstream owqs_backend\s*\{/);
 assert.match(template,/keepalive \d+;/);
 // Both are required before nginx reuses an upstream connection.
 assert.match(template,/proxy_http_version 1\.1;/);
 assert.match(template,/proxy_set_header Connection "";/);
 for(const [,target] of template.matchAll(/proxy_pass (http:\/\/[^;]+);/g))assert.match(target,/^http:\/\/owqs_backend(\/|$)/,`${target} must use the pooled upstream`);
});

test('access log records request timing for post-hoc latency checks',()=>{
 // The format may wrap across lines; require both the definition and its fields.
 assert.match(template,/log_format owqs /);
 assert.match(template,/\$request_time/);
 assert.match(template,/\$upstream_response_time/);
 assert.match(template,/access_log [^\n]* owqs;/);
});
