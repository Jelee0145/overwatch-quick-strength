#!/bin/sh
# Run explicitly over SSH after uploading the verified standalone package.
set -eu
revision="$1"
archive="$2"
case "$revision" in *[!a-f0-9]*|'') exit 2;; esac
release="/opt/owqs/releases/20261020-$revision"
previous=$(readlink -f /opt/owqs/current)
[ -d "$previous/server" ]
[ ! -e "$release" ]
mkdir -m 755 "$release"
cd "$release"
cp "$archive" ./owqs-server.tar.gz
cp "$archive.sha256" ./owqs-server.tar.gz.sha256
sha256sum -c owqs-server.tar.gz.sha256
tar -xzf owqs-server.tar.gz
node --input-type=module -e 'await import("./src/worker.mjs"); await import("./server/runtime.mjs"); console.log("Release imports verified")'
backup="/var/lib/owqs/backups/pre-$revision"
mkdir -p -m 700 "$backup"
cp -p /etc/owqs/config.json "$backup/config.json"
chmod 600 "$backup/config.json"
BACKUP_PATH="$backup/state.sqlite3" node --input-type=module -e 'import {DatabaseSync,backup} from "node:sqlite";const db=new DatabaseSync("/var/lib/owqs/state.sqlite3",{readOnly:true});await backup(db,process.env.BACKUP_PATH);db.close();'
chmod 600 "$backup/state.sqlite3"
# Set up keys on the host; no configuration or key material leaves the server.
node /opt/owqs/admin-tools/scripts/setup-event-push.mjs --config /etc/owqs/config.json --subject https://106.55.47.68:8443
ln -s "$release" /opt/owqs/current.next
mv -Tf /opt/owqs/current.next /opt/owqs/current
rollback(){ ln -s "$previous" /opt/owqs/current.rollback; mv -Tf /opt/owqs/current.rollback /opt/owqs/current; systemctl restart owqs; }
if ! systemctl restart owqs; then rollback; exit 1; fi
healthy=0
for attempt in 1 2 3 4 5 6 7 8 9 10; do
 if curl -fsS -H 'Host: 106.55.47.68:8443' http://127.0.0.1:8788/api/health | EXPECTED_REVISION="$revision" node --input-type=module -e 'let s="";for await(const b of process.stdin)s+=b;const d=JSON.parse(s);if(!d.ok||!d.revision.startsWith(process.env.EXPECTED_REVISION))process.exit(1);'; then healthy=1; break; fi
 sleep 2
done
if [ "$healthy" != 1 ]; then rollback; exit 1; fi
systemctl is-active owqs
printf 'Published %s; previous %s retained\n' "$release" "$previous"
