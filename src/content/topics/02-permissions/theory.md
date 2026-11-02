# Права: rwx, umask, SUID/SGID/sticky

`rwx`, `chmod 640` и `chown` ты знаешь. Здесь — где это ломается: каталоги, «чья тройка», заглавная `X`, umask и спецбиты.

## Права на каталог {#dir}

Каталог — файл со списком «имя → inode». Отсюда смысл битов:

| Бит | Что даёт на каталоге |
|---|---|
| `r` | прочитать список имён |
| `x` | пройти: `cd`, открыть или `stat` файл внутри по имени |
| `w` | создать, удалить, переименовать — **только вместе с `x`** |

**`r` без `x`** — имена видно, больше ничего:

```text
$ ls -ld /srv/reports
drwxr-----. 2 root analysts 20 Nov  2 10:00 /srv/reports
$ ls /srv/reports
q3.csv
$ ls -l /srv/reports
ls: cannot access '/srv/reports/q3.csv': Permission denied
total 0
-????????? ? ? ? ?            ? q3.csv
$ cat /srv/reports/q3.csv
cat: /srv/reports/q3.csv: Permission denied
```

**`x` без `r`** — проход вслепую: список закрыт, а файл по известному имени открывается. Так дают веб-серверу дойти до `~/site`, не показывая остальное:

```text
$ ls -ld /home/alice
drwx--x--x. 3 alice alice 77 Nov  2 10:00 /home/alice
$ ls /home/alice
ls: cannot open directory '/home/alice': Permission denied
$ cat /home/alice/site/index.html
<h1>hi</h1>
```

**Удаление — операция над каталогом.** Права самого файла не важны, нужны `w` и `x` на каталог. Если файл чужой и закрыт на запись, `rm` лишь переспросит — и после `y` удалит:

```text
$ ls -l ~/dump.core
-rw-------. 1 root root 5 Nov  2 10:00 /home/alice/dump.core
$ rm ~/dump.core
rm: remove write-protected regular file '/home/alice/dump.core'? y
$ ls ~/dump.core
ls: cannot access '/home/alice/dump.core': No such file or directory
```

> **Ловушка.** `chmod 000 file` от удаления не спасает. Спасает каталог без `w` или sticky-бит.

> **На практике.** Вопрос `rm` задаёт, только если stdin — терминал. В скрипте, в cron и с `-f` файл исчезнет молча.

## Чья тройка сработает {#order}

Ядро проверяет **одну** тройку — первую подходящую:

1. ты владелец → права владельца, и всё;
2. иначе твоя группа (основная или дополнительная) = группа файла → права группы;
3. иначе → права остальных.

Права **не складываются** и не «добираются» из следующей тройки:

```text
$ id
uid=1000(alice) gid=1000(alice) groups=1000(alice),1006(dev)
$ ls -l /srv/shared/todo.txt
-r--rw-r--. 1 alice dev 5 Nov  2 10:00 /srv/shared/todo.txt
$ echo x >> /srv/shared/todo.txt
bash: /srv/shared/todo.txt: Permission denied
```

alice в dev, у dev есть `w`, но alice — владелец, и проверка остановилась на `r--`.

Работает и наоборот: группа может получить **меньше**, чем все остальные:

```text
$ ls -l /srv/app/app.conf
-rw----r--. 1 root contractors 10 Nov  2 10:00 /srv/app/app.conf
$ cat /srv/app/app.conf     # bob в contractors
cat: /srv/app/app.conf: Permission denied
```

Любой посторонний файл прочитает, а bob — нет.

> **Ловушка.** Добавил пользователя в группу через `usermod -aG`, а доступа нет. Группы процесса фиксируются при входе: нужен новый логин (или `newgrp`), открытые сессии не обновятся.

> **На практике.** Для root `r` и `w` не проверяются. Но запустить файл root может, только если `x` есть хотя бы в одной тройке: `-rw-r--r--` скрипт и от root даёт `Permission denied`.

## chmod: буквы, числа, X {#chmod}

Символьная запись — пункты через запятую, применяются **по порядку**: кому (`ugoa`), действие (`+ - =`), что (`rwxXst` или `u`/`g`/`o` — скопировать чужую тройку).

| Запись | Что делает |
|---|---|
| `g=u` | группе — те же права, что у владельца |
| `o=` | остальным — ничего |
| `go-w` | снять запись у группы и остальных |
| `a-x,a+X` | снять все `x` и вернуть их только каталогам |

**`X` (заглавная)** даёт `x`, если это каталог **или** у файла уже есть `x` хоть в одной тройке. «Уже есть» — на момент применения, с учётом предыдущих пунктов той же команды.

Классика: кто-то выполнил `chmod -R 755 /srv/www`, и все `.html` стали исполняемыми. Лечим:

```text
# chmod -R u=rwX,go=rX /srv/www
# stat -c '%a %n' /srv/www/index.html
755 /srv/www/index.html
# chmod -R a-x,a+X /srv/www
# stat -c '%a %n' /srv/www/index.html
644 /srv/www/index.html
```

Первая команда не помогла: `u=rwX` видит у файла `x` (его поставил тот самый `755`) и оставляет. Нужно сначала `a-x`, потом `+X`.

> **Ловушка.** Число на **каталоге** не снимает setuid/setgid: `chmod 755` на `drwxrwsr-x` даёт `2755`. Снять: `chmod g-s` или `chmod 00755`. А sticky трёхзначное число снимает: `chmod 777` на `/tmp`-подобном каталоге даст `777`.

> **На практике.** Права меняет только владелец или root. Чужой файл, даже доступный тебе на запись через группу: `chmod: changing permissions of 'f': Operation not permitted`.

## umask {#umask}

umask — маска **запрещённых** битов. Итог = база `AND NOT umask`. База: **666** у файлов, **777** у каталогов (с ними `touch` и `mkdir` создают объект).

Это **не вычитание**:

```text
$ umask 033
$ touch f; mkdir d
$ stat -c '%a %A %n' f d
644 -rw-r--r-- f
744 drwxr--r-- d
```

666 − 033 дало бы 633 (`-rw--wx-wx`). Но `x` у файла нет — снимать нечего. Новый файл **никогда** не получает `x` от umask, только через `chmod`.

| umask | файл | каталог |
|---|---|---|
| `0022` | 644 | 755 |
| `0002` | 664 | 775 |
| `0027` | 640 | 750 |
| `0077` | 600 | 700 |

**В Rocky 9 — `0022` и у root, и у обычных пользователей.** Его ставит `pam_umask` (в `/etc/pam.d/postlogin`) из `UMASK 022` в `/etc/login.defs`. В RHEL 7/8 `/etc/bashrc` давал пользователям `0002` — в RHEL 9 этого блока нет.

```text
$ umask
0022
$ umask -S
u=rwx,g=rx,o=rx
```

Символьная форма задаёт **разрешённое**: `umask u=rwx,g=rx,o=` — то же, что `umask 027`.

> **Ловушка.** `umask 750` bash примет молча: это маска, а не права. Новые файлы получат `026` (`-----w-rw-`).

> **На практике.** umask живёт до конца сессии. Постоянно — строкой `umask 027` в `~/.bashrc` (при входе по ssh его подключает `~/.bash_profile`). Проверяй через `su - user`: `su user -c '…'` без `-` `~/.bashrc` не читает.

## SUID, SGID, sticky {#special}

| Бит | Число | На файле | На каталоге |
|---|---|---|---|
| SUID `u+s` | 4000 | запуск с правами **владельца** файла | — |
| SGID `g+s` | 2000 | запуск с правами группы файла | новое внутри получает **группу каталога**, подкаталоги — и сам SGID |
| sticky `+t` | 1000 | — | удалить или переименовать файл может только его владелец, владелец каталога или root |

В `ls -l` бит встаёт на место `x` своей тройки. **Строчная** буква — бит и `x` есть. **Заглавная** — бит есть, а `x` нет (почти всегда ошибка):

| `ls -l` | Число | Что это |
|---|---|---|
| `-rwsr-xr-x` | 4755 | SUID, работает |
| `-rwSr--r--` | 4644 | SUID на неисполняемом файле |
| `drwxrwsr-x` | 2775 | SGID-каталог, норма |
| `drwxrwSr-x` | 2765 | группа даже не войдёт |
| `drwxrwxrwt` | 1777 | как `/tmp` |
| `drwxrwxrwT` | 1776 | остальные не создадут файл |

**Общий каталог команды** — SGID:

```text
# mkdir /srv/team
# chgrp devs /srv/team
# chmod 2770 /srv/team
$ touch /srv/team/a.txt     # от alice
$ ls -l /srv/team
total 0
-rw-r--r--. 1 alice devs 0 Nov  2 10:00 a.txt
```

Без SGID было бы `alice alice`. Но SGID даёт только **группу**: при umask `0022` файл `644`, и коллега его не изменит. Нужен umask `0002` у участников или ACL по умолчанию.

**Sticky** — почему в `/tmp` не удалить чужой файл, даже открытый всем на запись:

```text
$ ls -l /tmp/app.lock
-rw-rw-rw-. 1 alice alice 5 Nov  2 10:00 /tmp/app.lock
$ rm -f /tmp/app.lock       # от bob
rm: cannot remove '/tmp/app.lock': Operation not permitted
```

Ошибка — `Operation not permitted`, а не `Permission denied`: права на каталог есть, запрещает именно sticky.

**Найти SUID** (аудит):

```text
# find /usr -perm -4000 -type f | sort
/usr/bin/chage
/usr/bin/gpasswd
/usr/bin/mount
/usr/bin/newgrp
/usr/bin/su
/usr/bin/umount
/usr/sbin/pam_timestamp_check
/usr/sbin/unix_chkpwd
```

`-perm -4000` — бит 4000 стоит (остальные любые). `-perm /6000` — SUID **или** SGID. `-perm 4000` без знака — права **ровно** `4000`, почти ничего не найдёт. По всему диску: `find / -perm -4000 -type f 2>/dev/null`.

> **Ловушка.** На скрипты (`#!/bin/bash`) Linux SUID игнорирует — работает только на бинарниках. А `chown` файла сбрасывает SUID (и SGID у исполняемого) даже от root: после смены владельца бит ставят заново.
