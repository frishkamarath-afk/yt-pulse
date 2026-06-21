# YT Valhalla mod control API

Минимальный backend для вкладки `Управление модом` в админ-панели и для проверки доступа из Forge-мода.

## Что делает сервис

- хранит состояние мода: включён / выключен;
- принимает логи запусков только после согласия пользователя в моде;
- пишет в SQLite: публичный IP, ОС/архитектуру, Java, CPU, доступную память, версию мода, версию Minecraft и случайный ID установки;
- не собирает имя Windows-пользователя, MAC-адрес, серийники, список файлов или токены.

## Установка на VDS

Нужен Debian/Ubuntu сервер с открытыми портами `80` и `443`.

```bash
cd /root/yt-valhalla-mod
MOD_DOMAIN="1-2-3-4.sslip.io" \
ADMIN_KEY="admin-key" \
CLIENT_KEY="client-key" \
bash install.sh
```

`MOD_DOMAIN` можно сделать через `sslip.io`: для IP `1.2.3.4` домен будет `1-2-3-4.sslip.io`.
Caddy сам выпустит HTTPS-сертификат.

## Проверка

```bash
curl https://1-2-3-4.sslip.io/health
curl "https://1-2-3-4.sslip.io/api/v1/status?clientKey=client-key"
curl -H "Authorization: Bearer admin-key" https://1-2-3-4.sslip.io/api/v1/admin/state
```

## Сервис systemd

```bash
systemctl status yt-valhalla-mod.service
journalctl -u yt-valhalla-mod.service -n 100 --no-pager
systemctl restart yt-valhalla-mod.service
```
