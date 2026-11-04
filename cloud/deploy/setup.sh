#!/usr/bin/env bash
# Curavo cloud - one-time server setup (Ubuntu 24.04).  Run with:  sudo bash setup.sh
# Safe to run again: it keeps the existing data and password.
set -euo pipefail

DOMAIN="cloud.curavo.in"
APP=/opt/curavo-cloud            # the program
DATA=/var/lib/curavo-cloud       # the data (database + locked backups) - this is what matters
ENVF=/etc/curavo-cloud.env       # secrets, readable by root only
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "== 1/6  Updating Ubuntu and installing tools"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get upgrade -y -q
apt-get install -y -q python3-venv python3-pip caddy sqlite3 unattended-upgrades

echo "== 2/6  A little swap space (safety net for the 2 GB of memory)"
if [ ! -f /swapfile ]; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== 3/6  Installing the Curavo cloud program"
id curavo >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin curavo
mkdir -p "$APP" "$DATA"
rm -rf "$APP/cloud"
cp -r "$HERE/cloud" "$APP/cloud"
[ -d "$APP/venv" ] || python3 -m venv "$APP/venv"
grep -v psycopg2 "$APP/cloud/server/requirements.txt" > /tmp/curavo-req.txt   # Postgres driver: not used yet
"$APP/venv/bin/pip" install -q --upgrade pip
"$APP/venv/bin/pip" install -q -r /tmp/curavo-req.txt
chown -R curavo:curavo "$DATA"
chmod 700 "$DATA"

echo "== 4/6  Secrets (made once, kept on later runs)"
NEW_PASSWORD=""
if [ ! -f "$ENVF" ]; then
  NEW_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"
  RELEASE_TOKEN="$(openssl rand -hex 24)"
  cat > "$ENVF" <<ENV
CURAVO_CLOUD_DATA=$DATA
CURAVO_ADMIN_USER=arz
CURAVO_ADMIN_PASSWORD=$NEW_PASSWORD
CURAVO_PUBLIC_URL=https://$DOMAIN
CURAVO_RELEASE_TOKEN=$RELEASE_TOKEN
ENV
  chmod 600 "$ENVF"
fi

echo "== 5/6  Running it as a service (starts by itself after a reboot)"
cat > /etc/systemd/system/curavo-cloud.service <<UNIT
[Unit]
Description=Curavo cloud server
After=network-online.target
Wants=network-online.target

[Service]
User=curavo
Group=curavo
EnvironmentFile=$ENVF
WorkingDirectory=$APP/cloud/server
ExecStart=$APP/venv/bin/uvicorn curavo_cloud.main:app --host 127.0.0.1 --port 8100 --proxy-headers --forwarded-allow-ips 127.0.0.1
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$DATA
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now curavo-cloud
systemctl restart curavo-cloud

# The cloud's own licence-signing key (never the master key).  Sent separately
# with scp to the home folder, moved here once, readable only by the service.
for k in "$HERE/../online_licence_key.pem" "/home/${SUDO_USER:-ubuntu}/online_licence_key.pem"; do
  if [ -f "$k" ]; then
    install -o curavo -g curavo -m 600 "$k" "$DATA/online_licence_key.pem"
    shred -u "$k" 2>/dev/null || rm -f "$k"
    echo "   online licence key installed"
  fi
done
[ -f "$DATA/online_licence_key.pem" ] || echo "   NOTE: no online licence key yet - paid accounts will not get keys automatically"

# The public website (curavo.in): plain files.
SITE_DOMAIN="curavo.in"
if [ -d "$HERE/website" ]; then
  rm -rf "$APP/website"
  cp -r "$HERE/website" "$APP/website"
  chmod -R a+rX "$APP/website"
fi

echo "== 6/6  HTTPS for $DOMAIN and $SITE_DOMAIN (Caddy gets and renews the certificates itself)"
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
    encode gzip
    request_body {
        max_size 600MB
    }
    reverse_proxy 127.0.0.1:8100
}

$SITE_DOMAIN {
    encode gzip
    root * $APP/website
    # The account pages are one file that handles every account address.
    @account path /account /account/* /link
    rewrite @account /account.html
    file_server
}

www.$SITE_DOMAIN {
    redir https://$SITE_DOMAIN{uri} permanent
}
CADDY
systemctl enable caddy >/dev/null 2>&1 || true
systemctl reload caddy || systemctl restart caddy

sleep 3
echo
if curl -fsS http://127.0.0.1:8100/health >/dev/null; then echo "OK  Curavo cloud is running."; else echo "PROBLEM  the server did not answer - send Claude:  sudo journalctl -u curavo-cloud -n 50"; fi
echo
if [ -n "$NEW_PASSWORD" ]; then
  echo "================================================================"
  echo " Curavo Control sign-in   (save this now - it is shown only once)"
  echo "   address:  https://$DOMAIN"
  echo "   user:     arz"
  echo "   password: $NEW_PASSWORD"
  echo "================================================================"
else
  echo "Password unchanged (see:  sudo cat $ENVF)"
fi
