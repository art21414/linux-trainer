# Инструменты команды

## Настоящий Rocky Linux 9 в Docker (сверка команд и вывода)
В облачной сессии Docker есть, но демон не запущен. Запуск (один раз за сессию):
```bash
docker info >/dev/null 2>&1 || (dockerd >/tmp/dockerd.log 2>&1 &) ; sleep 5; docker info | head -1
```
Образ: `rockylinux/rockylinux:9-ubi-init` (Rocky 9.8). В нём есть: coreutils, findutils, grep, sed, gawk,
procps (ps, top, kill, pgrep), util-linux (lsblk, findmnt, mount, blkid), systemctl (без запущенного systemd),
acl (getfacl/setfacl), tar, gzip, shadow-utils, sudo.
```bash
docker run --rm rockylinux/rockylinux:9-ubi-init bash -c 'useradd alice; ls -l /etc/passwd; df -hT /'
# loop-устройства, mount: добавить --privileged
docker run --rm --privileged rockylinux/rockylinux:9-ubi-init bash -c 'lsblk; findmnt /'
```
Ограничения: **нет** man, mkfs.xfs, ip/ss, lvm2, firewalld, SELinux; `dnf install` не работает —
зеркала Rocky закрыты сетевой политикой окружения. Такое сверяем по докам:
man7.org, docs.redhat.com (RHEL 9), upstream-документация. Помечаем «проверено по докам, не запуском».
Вывод `df`/`lsblk` в контейнере отражает хост (overlay, vda) — сверяем **формат**, а не значения.

## Браузер для QA и дизайна
Chromium + Playwright предустановлены: `require('playwright')`, `chromium.launch()` без опций.
`npx playwright install` не запускать.

## Проект
`npm test` (vitest), `npm run build` (typecheck + сборка), `npx vite preview` — собранная версия.
