#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root." >&2
  exit 1
fi

: "${MOD_DOMAIN:?MOD_DOMAIN is required}"
: "${ADMIN_KEY:?ADMIN_KEY is required}"
: "${CLIENT_KEY:?CLIENT_KEY is required}"

apt-get update
apt-get install -y python3 nginx certbot python3-certbot-nginx

if command -v ufw >/dev/null 2>&1 && ufw status | grep -qi "Status: active"; then
  ufw allow OpenSSH
  ufw allow 80/tcp
  ufw allow 443/tcp
fi

id -u ytvalhalla >/dev/null 2>&1 || useradd --system --home /nonexistent --shell /usr/sbin/nologin ytvalhalla

install -d -o root -g root -m 0755 /opt/yt-valhalla-mod
install -d -o ytvalhalla -g ytvalhalla -m 0750 /var/lib/yt-valhalla
install -o root -g root -m 0755 server.py /opt/yt-valhalla-mod/server.py
install -o root -g root -m 0644 yt-valhalla-mod.service /etc/systemd/system/yt-valhalla-mod.service

cat >/etc/yt-valhalla-mod.env <<EOF
YT_VALHALLA_HOST=127.0.0.1
YT_VALHALLA_PORT=8787
YT_VALHALLA_DB=/var/lib/yt-valhalla/mod-control.db
YT_VALHALLA_ADMIN_KEY=${ADMIN_KEY}
YT_VALHALLA_CLIENT_KEY=${CLIENT_KEY}
YT_VALHALLA_ALLOWED_ORIGIN=https://frishkamarath-afk.github.io
YT_VALHALLA_TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-}
YT_VALHALLA_TELEGRAM_ADMIN_CHAT_ID=${TELEGRAM_ADMIN_CHAT_ID:-}
YT_VALHALLA_TELEGRAM_REQUIRED=true
EOF
chmod 0600 /etc/yt-valhalla-mod.env

cat >/etc/nginx/conf.d/yt-valhalla-mod.conf <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${MOD_DOMAIN};

    access_log /var/log/nginx/yt-valhalla-mod.access.log;
    error_log /var/log/nginx/yt-valhalla-mod.error.log;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
nginx -t

systemctl daemon-reload
systemctl enable --now yt-valhalla-mod.service
systemctl enable --now nginx
systemctl restart yt-valhalla-mod.service
systemctl reload nginx
certbot --nginx -d "${MOD_DOMAIN}" --non-interactive --agree-tos --register-unsafely-without-email --redirect
systemctl reload nginx

echo "Installed: https://${MOD_DOMAIN}/health"
