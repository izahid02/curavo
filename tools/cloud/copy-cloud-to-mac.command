#!/bin/bash
# Curavo cloud -> Mac: a copy of everything the cloud server holds.
#
# What it copies: the cloud database (shops, licences, errors, leads, phones)
# and every shop's LOCKED backup.  The backups stay locked; only ARZ's
# recovery key opens them.  Copies go to ~/Projects/curavo-cloud-copies/,
# the newest 8 are kept (two months of weekly copies).
#
# Run it by double-clicking this file in Finder, or it runs by itself every
# Sunday (see tools/cloud/README-weekly-copy.txt).

SERVER="ubuntu@52.64.125.90"
KEY="$HOME/Projects/ARZ-licence-keys/curavo-cloud-key.pem"
DEST="$HOME/Projects/curavo-cloud-copies"
KEEP=8

mkdir -p "$DEST"
STAMP=$(date +%Y-%m-%d_%H%M)
OUT="$DEST/curavo-cloud_$STAMP.tgz"
LOG="$DEST/copy-log.txt"

echo "Copying the Curavo cloud to this Mac..."
# On the server: a consistent snapshot of the database (sqlite's own backup,
# never a plain file copy of a database in use), then everything packed up.
if ssh -i "$KEY" -o ConnectTimeout=20 -o BatchMode=yes "$SERVER" '
    set -e
    sudo sqlite3 /var/lib/curavo-cloud/cloud.db ".backup /tmp/cloud-snapshot.db"
    sudo tar czf - --exclude=./cloud.db --exclude=./cloud.db-wal --exclude=./cloud.db-shm \
        -C /var/lib/curavo-cloud . -C /tmp cloud-snapshot.db
    sudo rm -f /tmp/cloud-snapshot.db
  ' > "$OUT.part" && [ -s "$OUT.part" ] && tar tzf "$OUT.part" >/dev/null 2>&1; then
  mv "$OUT.part" "$OUT"
  SIZE=$(du -h "$OUT" | cut -f1)
  echo "$(date '+%Y-%m-%d %H:%M')  OK  $SIZE  $(basename "$OUT")" >> "$LOG"
  echo "OK - saved $(basename "$OUT") ($SIZE) in $DEST"
  # Keep only the newest $KEEP copies.
  ls -1t "$DEST"/curavo-cloud_*.tgz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r f; do rm -f "$f"; done
else
  rm -f "$OUT.part"
  echo "$(date '+%Y-%m-%d %H:%M')  FAILED" >> "$LOG"
  echo "FAILED - could not copy from the server."
  echo "Most likely: this Mac's internet address changed, so the server's SSH rule"
  echo "('My IP') no longer matches. Update it in AWS: EC2 -> Security groups ->"
  echo "launch-wizard-1 -> Edit inbound rules -> SSH -> Source: My IP -> Save."
  exit 1
fi
