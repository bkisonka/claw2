# Running claw2 as a systemd service

The compose file already sets `restart: unless-stopped`, so the agent
returns after a host reboot wherever the Docker daemon starts at boot. This
guide adds a thin systemd wrapper, so the stack becomes a first-class
service on the host: it starts after Docker, stops cleanly, and is managed
with the usual `systemctl` commands.

# claw2 как системный сервис systemd

В compose-файле уже задано `restart: unless-stopped`, поэтому после
перезагрузки хоста агент возвращается сам — там, где демон Docker
запускается при загрузке. Это руководство добавляет тонкую обёртку
systemd, благодаря которой стек становится полноценным сервисом хоста:
он стартует после Docker, корректно останавливается и управляется
привычными командами `systemctl`.

---

## 1. Unit file / файл юнита

Create `/etc/systemd/system/claw2.service` (assume the repository is
checked out at `/opt/claw2`):

Создайте файл `/etc/systemd/system/claw2.service` (репозиторий
предположительно развёрнут в `/opt/claw2`):

```ini
[Unit]
Description=claw2 personal agent (docker compose)
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/claw2
ExecStart=/usr/bin/docker compose up -d
ExecReload=/usr/bin/docker compose up -d --build
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=600

[Install]
WantedBy=multi-user.target
```

Adjust `WorkingDirectory` to the actual checkout path; adjust the path to
`docker` (`which docker`) if it differs.

Поправьте `WorkingDirectory` под фактический путь развертывания и путь к
`docker` (`which docker`), если он отличается.

## 2. Enable and start / включение и запуск

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now claw2.service

systemctl status claw2.service
```

## 3. Everyday commands / повседневные команды

| Action / Действие | Command / Команда |
|---|---|
| Update and restart / обновить и перезапустить | `git pull && sudo systemctl reload claw2.service` |
| Stop / остановить | `sudo systemctl stop claw2.service` |
| Logs / журналы | `docker compose logs -f claw2` |

`ExecStart` keeps `restart: unless-stopped` in charge of crashes; systemd
supervises the stack as a whole, not each container.
