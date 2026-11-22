import type { Topic } from "../../types";
import type { World } from "../../../engine/world";
import { guarded, type Guard } from "../../guard";
import theoryMd from "./theory.md?raw";

// ---------- помощники для setup/check ----------
const bytes = (n: number) => "x".repeat(n - 1) + "\n";
/** Содержимое /root/answer без краевых пробелов; null — файла нет. */
async function answer(w: World): Promise<string | null> {
  const a = await w.read("/root/answer");
  return a === null ? null : a.trim();
}
async function ls(w: World, dir: string): Promise<string[] | null> {
  try {
    return await w.base.readdir(dir);
  } catch {
    return null;
  }
}
/** Добавить пользователей в (новую) группу и обновить /etc/group. */
async function groupWith(w: World, name: string, members: string[]) {
  const g = w.group(name) ?? w.addGroup(name);
  for (const m of members) w.user(m)!.groups.push(name);
  await w.syncEtc();
  return g;
}
/** Отдельный диск 1 ГиБ (XFS) под /srv: на нём видно, освободилось ли место. */
async function srvDisk(w: World) {
  await w.storage.addDisk("vdd", "1G");
  await w.storage.mkfs("/dev/vdd", "xfs");
  await w.storage.mount("/dev/vdd", "/srv");
}
const usedMiB = async (w: World, p: string) => (await w.storage.usageAt(p)).used / 2 ** 20;
/** pid процесса, державшего файл, — по миру (у каждого прогона свой). */
const pidAtSetup = new WeakMap<World, number>();

/** Удалённый, но открытый лог: /srv/app/logs/debug.log 700 МБ держит служба svc. */
async function leakedLog(w: World, svc: string) {
  await srvDisk(w);
  await w.storage.createFile("/srv/app/logs/debug.log", "700M");
  await w.write("/srv/app/logs/access.log", "GET / 200\n");
  await w.write("/srv/app/app.conf", "listen = 8080\n");
  const { pid } = await w.holdOpen({ service: svc, cmd: `/usr/bin/${svc}` }, "/srv/app/logs/debug.log");
  await w.holdOpen({ service: "httpd", cmd: "/usr/sbin/httpd -DFOREGROUND" }, "/srv/app/logs/access.log");
  await w.fs.rm("/srv/app/logs/debug.log");
  pidAtSetup.set(w, pid);
}

const CONF_OLD = "listen = 8080\nworkers = 4\n";
const CONF_NEW = "listen = 8080\nworkers = 8\n";
const CONFD = "# confd\nbackend = etcd\ntoken = 7f3a9c\n";

const GUARDS: Record<string, Guard> = {
  "move-1-01": {
    keep: ["/etc/app"],
    except: ["/etc/app/app.conf", "/etc/app/app.conf.old"],
    reject: ["rm /etc/app/logging.conf\nmv /etc/app/app.conf /etc/app/app.conf.old\nmv /tmp/app.conf.new /etc/app/app.conf"],
  },
  "move-1-02": { keep: ["/srv/releases"], except: ["/srv/releases/v1"], reject: ["rm -r /srv/releases/v1 /srv/releases/v2"] },
  "move-1-03": { keep: ["/home/alice/uploads"], except: ["/home/alice/uploads/-rf"] },
  "move-2-01": { keep: ["/var/www"], except: ["/var/www/html"], reject: ["rm -rf /var/www/html\nmv /srv/build /var/www/html"] },
  "move-2-02": {
    keep: ["/srv/ci"],
    except: ["/srv/ci/work/build", "/srv/ci/work/.cache", "/srv/ci/work/.lock", "/srv/ci/work/log.txt"],
    reject: ["rm -rf /srv/ci/work/* /srv/ci/work/.[!.]* /srv/ci/agent.conf"],
  },
  "move-2-04": { keep: ["/srv/app"], reject: ["lsof +L1 | awk 'NR==2 {print $2}' > /root/answer\nkill $(pidof myapp)"] },
  "move-2-05": {
    keep: ["/srv/export"],
    except: ["/srv/export/a.txt", "/srv/export/b.txt", "/srv/export/q3 sales.txt"],
    reject: ["rm -f /srv/export/README.md\ncd /srv/export\nfor f in *.txt; do mv -- \"$f\" \"${f%.txt}.csv\"; done"],
  },
  "move-3-01": { keep: ["/srv/app"], reject: ["rm -rf /srv/app/logs\n: > /proc/$(pidof myapp)/fd/3"] },
  "move-3-02": { keep: ["/etc/confd"], except: ["/etc/confd/confd.conf"], reject: ["rm -f /etc/confd/confd.local\ncp /proc/$(pidof confd)/fd/3 /etc/confd/confd.conf"] },
  "move-3-03": {
    keep: ["/archive", "/srv/incoming"],
    except: ["/srv/incoming/2026-11"],
    reject: ["rm -rf /archive/2026-11\nmv /srv/incoming/2026-11 /archive/"],
  },
  "move-exam-01": { keep: ["/srv/inbox/keep"], reject: ["rm -rf /srv/inbox/*"] },
  "move-exam-02": { keep: ["/srv/app"], reject: ["rm -rf /srv/app/logs\nsystemctl restart logd"] },
  "move-exam-03": { keep: ["/srv/dev-share"], except: ["/srv/dev-share"], reject: ["chmod 777 /srv/dev-share"] },
  "move-exam-04": {
    keep: ["/var/cache/app"],
    except: ["/var/cache/app/tmp1", "/var/cache/app/tmp2"],
    reject: ["rm -rf /var/cache/app/*"],
  },
  "move-exam-05": {
    keep: ["/srv/photos"],
    except: ["/srv/photos/IMG_001.JPG", "/srv/photos/IMG_002.JPG", "/srv/photos/team photo.JPG"],
    reject: ["rm /srv/photos/notes.txt\ncd /srv/photos\nfor f in *.JPG; do mv -- \"$f\" \"${f%.JPG}.jpg\"; done"],
  },
};

export const moveDelete: Topic = guarded({
  id: "move",
  n: 3,
  title: "Перемещение, переименование, удаление",
  summary: "mv = rename внутри ФС и copy+remove между ФС, mv в существующий каталог, rmdir как страховка, файл -rf и rm *, пустая переменная, удалённый, но открытый файл",
  level: "base",
  theory: theoryMd,
  sets: [
    {
      id: "1",
      title: "Разминка: mv и rm",
      exercises: [
        {
          id: "move-1-01",
          type: "terminal",
          theory: "mv",
          prompt:
            "Новая версия конфига лежит в **/tmp/app.conf.new**. Поставь её на место **/etc/app/app.conf**, а текущую версию переименуй в **/etc/app/app.conf.old** — на случай отката.",
          setup: async (w) => {
            await w.write("/etc/app/app.conf", CONF_OLD);
            await w.write("/etc/app/logging.conf", "level = info\n");
            await w.write("/tmp/app.conf.new", CONF_NEW);
          },
          check: async ({ world }) => {
            const cur = await world.read("/etc/app/app.conf");
            const old = await world.read("/etc/app/app.conf.old");
            if (cur === CONF_NEW && old === CONF_OLD) return true;
            if (cur === CONF_NEW && old === null) return "Новый конфиг на месте, а старый потерян: mv поверх существующего файла молча его заменяет. Начни заново.";
            if (old === CONF_OLD) return "Старая версия сохранена, новая ещё не на месте.";
            return false;
          },
          hint: "Порядок важен: сначала убери старое, потом поставь новое.",
          solution: "mv /etc/app/app.conf /etc/app/app.conf.old\nmv /tmp/app.conf.new /etc/app/app.conf",
          accept: [
            "cd /etc/app\nmv app.conf app.conf.old\nmv /tmp/app.conf.new app.conf",
            "cp /etc/app/app.conf /etc/app/app.conf.old\ncp /tmp/app.conf.new /etc/app/app.conf",
          ],
          reject: ["mv /tmp/app.conf.new /etc/app/app.conf"],
          explain:
            "`mv` поверх существующего файла заменяет его без вопросов (если нет алиаса `-i`). Внутри одной ФС `mv` — это `rename()`: мгновенно, inode и mtime сохраняются.",
        },
        {
          id: "move-1-02",
          type: "terminal",
          theory: "rm",
          prompt:
            "В **/srv/releases** остались каталоги старых релизов **v1** и **v2**. Удали те из них, что пусты. Если в каком-то что-то лежит — не трогай его: там может быть чужой файл.",
          setup: async (w) => {
            await w.mkdir("/srv/releases/v1");
            await w.mkdir("/srv/releases/v2");
            await w.write("/srv/releases/v2/.keep", "do not delete: hotfix in progress (bob)\n");
            await w.write("/srv/releases/v3/app.jar", bytes(4096));
          },
          check: async ({ world }) => !(await world.exists("/srv/releases/v1")),
          hint: "Есть команда, которая удаляет каталог, только если он пуст.",
          solution: "rmdir /srv/releases/v1",
          accept: ["rmdir /srv/releases/v1 /srv/releases/v2", "rm -d /srv/releases/v1 /srv/releases/v2"],
          reject: ["ls /srv/releases"],
          explain:
            "`ls` показал бы v2 пустым — в нём только скрытый `.keep`. `rmdir` (или `rm -d`) сам проверяет пустоту: v1 удалит, на v2 ответит `Directory not empty`. `rm -r` снёс бы v2 вместе с чужим файлом.",
        },
        {
          id: "move-1-03",
          type: "terminal",
          theory: "danger",
          user: "alice",
          cwd: "/home/alice/uploads",
          prompt:
            "Загрузчик с багом создал в **~/uploads** файл с именем `-rf`. Удали только его — остальные файлы и каталоги должны остаться.",
          setup: async (w) => {
            const a = w.user("alice")!;
            await w.mkdir("/home/alice/uploads/old", 0o755, a.uid, a.gid);
            for (const f of ["-rf", "report.pdf", "photo.jpg", "old/a.txt"])
              await w.write(`/home/alice/uploads/${f}`, f === "-rf" ? "" : `${f}\n`, 0o644, a.uid, a.gid);
          },
          check: async ({ world }) => !(await world.exists("/home/alice/uploads/-rf")),
          hint: "rm принимает -rf за ключи, кавычки не помогают. Сделай так, чтобы аргумент не начинался с дефиса, или скажи rm, что ключи кончились.",
          solution: "rm ./-rf",
          accept: ["rm -- -rf", "rm /home/alice/uploads/-rf"],
          reject: ["rm *", "rm '-rf'"],
          explain:
            "Кавычки снимает bash — rm всё равно видит `-rf` и считает его ключами. `./-rf` и полный путь не начинаются с дефиса, `--` объявляет конец ключей. `rm *` здесь — худший вариант: удалит всё, кроме `-rf`.",
        },
      ],
    },
    {
      id: "2",
      title: "Средние: выкладка, чистка, место",
      exercises: [
        {
          id: "move-2-01",
          type: "terminal",
          theory: "mv",
          prompt:
            "Выложи новую сборку из **/srv/build** вместо текущего сайта **/var/www/html**. Старую версию сохрани как **/var/www/html.old** — для отката.",
          setup: async (w) => {
            await w.write("/var/www/html/index.html", "<h1>v1</h1>\n");
            await w.write("/srv/build/index.html", "<h1>v2</h1>\n");
            await w.write("/srv/build/app.js", "console.log(2)\n");
          },
          check: async ({ world }) => {
            if (await world.exists("/var/www/html/build"))
              return "Сборка легла в /var/www/html/build: цель существовала, и mv положил источник внутрь. Сайт отдаёт старую версию.";
            const cur = await world.read("/var/www/html/index.html");
            const old = await world.read("/var/www/html.old/index.html");
            if (cur === "<h1>v2</h1>\n" && old === "<h1>v1</h1>\n") return (await world.exists("/var/www/html/app.js"));
            if (cur === "<h1>v2</h1>\n") return "Новая версия на месте, а старой для отката нет.";
            return false;
          },
          hint: "Если цель — существующий каталог, mv кладёт источник внутрь. Сначала освободи имя.",
          solution: "mv /var/www/html /var/www/html.old\nmv /srv/build /var/www/html",
          accept: ["mv /var/www/html /var/www/html.old\ncp -a /srv/build /var/www/html", "cd /var/www\nmv html html.old\nmv /srv/build html"],
          reject: ["mv /srv/build /var/www/html"],
          explain:
            "`mv /srv/build /var/www/html` при существующем html создаёт `html/build`. Освобождаем имя (`mv html html.old`), потом переименовываем новое. Внутри одной ФС оба шага мгновенны — простой выкладки почти нет.",
        },
        {
          id: "move-2-02",
          type: "terminal",
          theory: "rm",
          prompt:
            "**/srv/ci/work** — рабочий каталог CI-агента (владелец bob, права 2770). Очисти его полностью, но сам каталог не удаляй и не пересоздавай.",
          setup: async (w) => {
            const b = w.user("bob")!;
            await w.mkdir("/srv/ci", 0o755, 0, 0);
            await w.write("/srv/ci/agent.conf", "url = https://ci.example.com\n");
            await w.mkdir("/srv/ci/work", 0o2770, b.uid, b.gid);
            await w.mkdir("/srv/ci/work/build", 0o755, b.uid, b.gid);
            await w.mkdir("/srv/ci/work/.cache", 0o755, b.uid, b.gid);
            await w.write("/srv/ci/work/build/out.bin", bytes(800), 0o755, b.uid, b.gid);
            await w.write("/srv/ci/work/.cache/deps.db", bytes(300), 0o644, b.uid, b.gid);
            await w.write("/srv/ci/work/.lock", "4242\n", 0o644, b.uid, b.gid);
            await w.write("/srv/ci/work/log.txt", "build ok\n", 0o644, b.uid, b.gid);
          },
          check: async ({ world }) => {
            const left = (await ls(world, "/srv/ci/work")) ?? [];
            if (left.length === 0) return true;
            if (left.every((n) => n.startsWith(".")))
              return `Остались скрытые: ${left.join(", ")} — * их не видит.`;
            return false;
          },
          hint: "Удалять нужно содержимое: и обычные, и скрытые имена. Можно шаблоном, можно find.",
          solution: "find /srv/ci/work -mindepth 1 -delete",
          accept: ["rm -rf /srv/ci/work/* /srv/ci/work/.[!.]*", "cd /srv/ci/work\nrm -rf ./* ./.cache ./.lock"],
          reject: ["rm -rf /srv/ci/work/*", "rm -rf /srv/ci/work\nmkdir /srv/ci/work"],
          explain:
            "`*` не берёт `.cache` и `.lock`. `find -mindepth 1 -delete` удаляет всё внутри, не трогая сам каталог. Пересоздать каталог — значит потерять владельца bob и setgid: `mkdir` от root даст root и 755.",
        },
        {
          id: "move-2-03",
          type: "choice",
          kind: "predict",
          theory: "danger",
          prompt: "В каталоге лежат файл `a.txt`, каталог `logs` (с файлами) и файл `-rf`. Что останется после команды?",
          code: "$ ls\na.txt  logs  -rf\n$ rm *\n$ ls",
          options: [
            "Только файл `-rf`",
            "Только каталог `logs`: rm без -r каталоги не удаляет",
            "Ничего: удалено всё",
            "Всё на месте: rm ругнётся на неизвестный ключ",
          ],
          answer: 0,
          explain:
            "`*` раскрывается в `a.txt logs -rf`, а GNU rm понимает ключи в любом месте строки: это `rm -rf a.txt logs`. Удалится всё, кроме самого `-rf`, и logs — рекурсивно. Безопасно — `rm ./*` или `rm -- *`.",
        },
        {
          id: "move-2-04",
          type: "terminal",
          theory: "deleted-open",
          prompt:
            "Ночью на **/srv** почистили логи, но `df` по-прежнему показывает, что диск почти полон, хотя `du` насчитывает копейки. Найди процесс, который держит удалённый файл, и запиши его **PID** в **/root/answer**. Процессы не трогай.",
          setup: (w) => leakedLog(w, "myapp"),
          check: async ({ world }) => {
            const pid = pidAtSetup.get(world)!;
            if (!world.procs.isAlive(pid)) return "Процесс завершён — задача была только найти его. Начни заново.";
            const a = await answer(world);
            if (a === null) return false;
            if (a === String(pid)) return true;
            return "Не тот PID. Нужен процесс с удалённым (deleted) файлом, а не тот, что пишет в живой лог.";
          },
          hint: "lsof умеет показать открытые файлы, у которых не осталось ни одного имени.",
          solution: "lsof +L1 | awk 'NR==2 {print $2}' > /root/answer",
          accept: ["pidof myapp > /root/answer"],
          reject: ["pidof httpd > /root/answer"],
          explain:
            "`lsof +L1` — открытые файлы с числом ссылок меньше 1, то есть удалённые. Колонка PID — тот, кто держит место. `du` идёт по именам и такой файл не видит, `df` спрашивает ФС о блоках — отсюда расхождение.",
        },
        {
          id: "move-2-05",
          type: "terminal",
          theory: "mv",
          cwd: "/srv/export",
          prompt:
            "Выгрузка положила отчёты в **/srv/export** с расширением `.txt`, а импорт ждёт `.csv`. Переименуй все `*.txt` в `*.csv` (имена — те же).",
          setup: async (w) => {
            for (const f of ["a", "b", "q3 sales"]) await w.write(`/srv/export/${f}.txt`, `${f};100\n`);
            await w.write("/srv/export/README.md", "# export\n");
          },
          check: async ({ world }) => {
            const left = ((await ls(world, "/srv/export")) ?? []).filter((n) => n.endsWith(".txt"));
            for (const f of ["a", "b", "q3 sales"])
              if ((await world.read(`/srv/export/${f}.csv`)) !== `${f};100\n`) return left.length ? false : `Нет ${f}.csv с исходным содержимым.`;
            if (left.length) return `Остались .txt: ${left.join(", ")}.`;
            return true;
          },
          hint: "mv *.txt *.csv не сработает. Нужен цикл и отрезание суффикса у переменной.",
          solution: 'for f in *.txt; do mv -- "$f" "${f%.txt}.csv"; done',
          accept: [
            'cd /srv/export\nfor f in *.txt; do mv "$f" "${f%.txt}.csv"; done',
            'mv a.txt a.csv\nmv b.txt b.csv\nmv "q3 sales.txt" "q3 sales.csv"',
          ],
          reject: ["mv /srv/export/*.txt /srv/export/*.csv", 'for f in *.txt; do mv $f ${f%.txt}.csv; done'],
          explain:
            "`mv *.txt *.csv` получает список файлов и требует, чтобы последним был каталог: `target '*.csv' is not a directory`. В цикле `${f%.txt}` отрезает суффикс, а кавычки нужны для `q3 sales.txt` — без них mv получит три аргумента.",
        },
      ],
    },
    {
      id: "3",
      title: "Сложные: место, спасение, слияние",
      exercises: [
        {
          id: "move-3-01",
          type: "terminal",
          theory: "deleted-open",
          prompt:
            "**/srv** забит: кто-то удалил разросшийся `debug.log`, но myapp держит его открытым, и место не вернулось. Перезапускать myapp днём нельзя. Освободи место.",
          setup: (w) => leakedLog(w, "myapp"),
          check: async ({ world }) => {
            const pid = pidAtSetup.get(world)!;
            if (!world.procs.isAlive(pid)) return "Место освободилось, но myapp перезапущен или убит — а этого было нельзя. Начни заново.";
            return (await usedMiB(world, "/srv")) < 300;
          },
          hint: "Удалённый файл всё ещё доступен через дескриптор процесса в /proc. Его можно обрезать.",
          solution: ": > /proc/$(pidof myapp)/fd/3",
          accept: ["lsof +L1\n: > /proc/$(pidof myapp)/fd/3", "ls -l /proc/$(pidof myapp)/fd\n: > /proc/$(pidof myapp)/fd/3"],
          reject: ["systemctl restart myapp", "kill $(pidof myapp)"],
          explain:
            "`/proc/PID/fd/3` ведёт в тот самый удалённый файл, и `: >` обрезает его до нуля — ядро сразу освобождает блоки. Номер дескриптора видно в `lsof +L1` (колонка FD, `3w`) или в `ls -l /proc/PID/fd`. Правильное решение на будущее — переоткрытие логов (logrotate + reload).",
        },
        {
          id: "move-3-02",
          type: "terminal",
          theory: "deleted-open",
          prompt:
            "Конфиг **/etc/confd/confd.conf** удалили по ошибке, бэкапа нет. Демон confd ещё работает и держит файл открытым. Верни конфиг на место с прежним содержимым и правами 640.",
          setup: async (w) => {
            await w.write("/etc/confd/confd.conf", CONFD, 0o640);
            await w.write("/etc/confd/confd.local", "# local overrides\n", 0o640);
            const { pid } = await w.holdOpen({ service: "confd", cmd: "/usr/bin/confd" }, "/etc/confd/confd.conf", { mode: "r" });
            pidAtSetup.set(w, pid);
            await w.fs.rm("/etc/confd/confd.conf");
          },
          check: async ({ world }) => {
            const i = await world.info("/etc/confd/confd.conf");
            if (!i) return world.procs.isAlive(pidAtSetup.get(world)!) ? false : "confd перезапущен — дескриптор закрыт, и содержимое потеряно навсегда. Начни заново.";
            if ((await world.read("/etc/confd/confd.conf")) !== CONFD) return "Файл есть, но содержимое не то. Его можно достать из дескриптора процесса.";
            if ((i.mode & 0o7777) !== 0o640) return `Содержимое верное, но права ${(i.mode & 0o7777).toString(8)} — нужны 640 (в конфиге токен).`;
            return true;
          },
          hint: "Пока процесс жив, файл виден в /proc/PID/fd. Его можно скопировать.",
          solution: "cp /proc/$(pidof confd)/fd/3 /etc/confd/confd.conf\nchmod 640 /etc/confd/confd.conf",
          accept: ["lsof +L1\ncp /proc/$(pidof confd)/fd/3 /etc/confd/confd.conf"],
          reject: ["touch /etc/confd/confd.conf", "systemctl restart confd\ncp /proc/$(pidof confd)/fd/3 /etc/confd/confd.conf"],
          explain:
            "`/proc/PID/fd/N` — ссылка на открытый файл, даже удалённый (`(deleted)` в `ls -l`). `cp` из неё даёт новый файл с тем же содержимым; права, владельца и SELinux-контекст проверьте руками. Перезапуск закрыл бы дескриптор — и шанс пропал бы.",
        },
        {
          id: "move-3-03",
          type: "terminal",
          theory: "mv",
          prompt:
            "Влей ноябрьские файлы из **/srv/incoming/2026-11** в архив **/archive/2026-11** — там уже лежат файлы за первую половину месяца. После этого каталога /srv/incoming/2026-11 быть не должно.",
          setup: async (w) => {
            for (const d of ["01", "02", "15"]) await w.write(`/archive/2026-11/report-${d}.csv`, `day ${d}\n`);
            for (const d of ["16", "17"]) await w.write(`/srv/incoming/2026-11/report-${d}.csv`, `day ${d}\n`);
            await w.mkdir("/srv/incoming/2026-12");
          },
          check: async ({ world }) => {
            if (await world.exists("/archive/2026-11/2026-11")) return "Получился /archive/2026-11/2026-11: существующая цель, и mv положил источник внутрь.";
            for (const d of ["16", "17"])
              if ((await world.read(`/archive/2026-11/report-${d}.csv`)) !== `day ${d}\n`) return false;
            if (await world.exists("/srv/incoming/2026-11")) return "Файлы в архиве, но пустой /srv/incoming/2026-11 остался.";
            return true;
          },
          hint: "Каталог поверх непустого каталога mv не кладёт. Перенеси содержимое, потом убери пустой источник.",
          solution: "mv /srv/incoming/2026-11/* /archive/2026-11/\nrmdir /srv/incoming/2026-11",
          accept: [
            "cp -a /srv/incoming/2026-11/. /archive/2026-11/\nrm -rf /srv/incoming/2026-11",
            "mv /srv/incoming/2026-11/report-16.csv /srv/incoming/2026-11/report-17.csv /archive/2026-11/\nrmdir /srv/incoming/2026-11",
          ],
          reject: ["mv /srv/incoming/2026-11 /archive/2026-11", "mv /srv/incoming/2026-11 /archive/"],
          explain:
            "`mv dir /archive/2026-11` кладёт источник внутрь, а `mv dir /archive/` упирается в непустой каталог: `File exists` (на ext4 — `Directory not empty`). Сливают содержимым: `mv dir/* цель/`, потом `rmdir` — он ещё и проверит, что ничего не забыто.",
        },
      ],
    },
    {
      id: "4",
      title: "На подумать: rm и mv без иллюзий",
      exercises: [
        {
          id: "move-4-01",
          type: "choice",
          kind: "predict",
          theory: "rm",
          prompt: "У root в `~/.bashrc` стоит алиас RHEL `alias rm='rm -i'`. Что сделает команда?",
          code: "# rm -rf /srv/build",
          options: [
            "Удалит каталог без единого вопроса",
            "Спросит про каждый файл: алиас добавил -i",
            "Спросит один раз: `rm: remove 1 argument recursively?`",
            "Откажется: -i и -f несовместимы",
          ],
          answer: 0,
          explain:
            "Строка становится `rm -i -rf /srv/build`, а у rm из `-i` и `-f` побеждает последний. Алиас защищает от `rm файл`, но не от `rm -rf`. Один вопрос задаёт `-I` — он стоит в алиасах не по умолчанию.",
        },
        {
          id: "move-4-02",
          type: "choice",
          kind: "predict",
          theory: "danger",
          prompt: "Скрипт очистки запустили от root, а `BUILD_DIR` в окружении оказалась пустой (`BUILD_DIR=`). Что сделает эта строка?",
          code: 'rm -rf "$BUILD_DIR"/*',
          options: [
            "Ничего: сработает защита --preserve-root",
            "Удалит всё содержимое корня: /bin, /etc, /home…",
            "Ошибка: bash не подставит пустую переменную",
            "Ничего: * в такой строке не раскрывается",
          ],
          answer: 1,
          explain:
            "Строка станет `rm -rf /*`, а `*` (он вне кавычек) раскроется в `/bin /boot /dev /etc …`. --preserve-root защищает только аргумент `/` целиком. Пустая переменная — не ошибка, `set -u` ловит только незаданные. Защита — `\"${BUILD_DIR:?}\"/*`.",
        },
        {
          id: "move-4-03",
          type: "choice",
          kind: "predict",
          theory: "mv",
          prompt: "`dump.sql` и `/srv/data` на одной ФС. Что изменится у файла после переименования?",
          code: "$ cd /srv/data\n$ mv dump.sql dump-old.sql\n$ stat dump-old.sql",
          options: [
            "Номер inode и mtime прежние, сдвинулся только ctime",
            "Новый номер inode, mtime прежний",
            "Номер inode прежний, mtime и ctime — сейчас",
            "Ничего не изменится, даже ctime",
          ],
          answer: 0,
          explain:
            "Внутри одной ФС mv — это `rename()`: переписана строка в каталоге, данные не тронуты, поэтому inode и mtime те же. ctime сдвигается (изменились метаданные), и меняются mtime/ctime самого каталога. Между ФС было бы наоборот: новый inode — это копия.",
        },
      ],
    },
  ],
  exam: {
    id: "exam",
    title: "Зачёт",
    exercises: [
      {
        id: "move-exam-01",
        type: "terminal",
        theory: "danger",
        prompt:
          "В **/srv/inbox** — загрузки от внешнего клиента, имена файлов могут быть любыми. Удали из каталога все файлы, а подкаталог **keep** со всем содержимым оставь.",
        setup: async (w) => {
          await w.write("/srv/inbox/keep/contract.pdf", "PDF\n");
          for (const f of ["-rf", "invoice.pdf", "notes.txt"]) await w.write(`/srv/inbox/${f}`, f === "-rf" ? "" : `${f}\n`);
        },
        check: async ({ world }) => {
          const left = (await ls(world, "/srv/inbox")) ?? [];
          const files: string[] = [];
          for (const n of left) if (!(await world.info(`/srv/inbox/${n}`))?.isDir) files.push(n);
          if (files.length === 0) return true;
          if (files.length === 1 && files[0] === "-rf") return "Остался файл -rf: rm принимает его за ключи. Помогут ./-rf или --.";
          return false;
        },
        hint: "Сначала посмотри, что за имена там лежат. Если какое-то начинается с дефиса — * подставит его в rm как ключ.",
        solution: "find /srv/inbox -maxdepth 1 -type f -delete",
        accept: ["rm -f /srv/inbox/invoice.pdf /srv/inbox/notes.txt /srv/inbox/-rf", "rm -- /srv/inbox/-rf /srv/inbox/invoice.pdf /srv/inbox/notes.txt"],
        reject: ["cd /srv/inbox\nrm *"],
        explain:
          "`*` раскрывается в голые имена, и `-rf` достаётся rm как ключи: `rm *` сносит keep, а сам `-rf` остаётся. Полные пути и `./*` не начинаются с дефиса, `find -type f -delete` от имён не зависит вовсе.",
      },
      {
        id: "move-exam-02",
        type: "terminal",
        theory: "deleted-open",
        prompt:
          "**/srv** почти полон, хотя `du` этого не подтверждает. Найди, кто держит удалённый файл, и верни место. Службу перезапускать **можно**, но в итоге она должна работать.",
        setup: (w) => leakedLog(w, "logd"),
        check: async ({ world }) => {
          const svc = world.services.get("logd");
          if (!svc || !world.procs.isAlive(svc.pid)) return "Служба logd не работает — её нужно было перезапустить, а не убить.";
          return (await usedMiB(world, "/srv")) < 300;
        },
        hint: "lsof покажет, чей это файл. Дальше — перезапуск службы или обрезка через /proc.",
        solution: "systemctl restart logd",
        accept: [": > /proc/$(pidof logd)/fd/3", "lsof +L1\nsystemctl restart logd"],
        reject: ["kill $(pidof logd)", "rm -rf /srv/app/logs/*"],
        explain:
          "Блоки удалённого файла освобождаются, когда закрыт последний дескриптор. `systemctl restart` закрывает его вместе с процессом и запускает службу заново. `kill` тоже вернёт место, но служба останется лежать.",
      },
      {
        id: "move-exam-03",
        type: "terminal",
        theory: "rm",
        prompt:
          "alice (в группе **dev**) не может удалить свой же файл в **/srv/dev-share**: `Permission denied`. Почини так, чтобы участники dev могли создавать и удалять файлы в этом каталоге, а остальные — нет.",
        setup: async (w) => {
          const g = await groupWith(w, "dev", ["alice"]);
          const a = w.user("alice")!;
          await w.mkdir("/srv/dev-share", 0o755, 0, g.gid);
          await w.write("/srv/dev-share/alice-notes.txt", "todo\n", 0o644, a.uid, a.gid);
          await w.write("/srv/dev-share/build.log", "ok\n", 0o664, 0, g.gid);
        },
        check: async ({ world }) => {
          const alice = world.user("alice")!;
          const nobody = world.user("nobody")!;
          if (await world.canModifyDir("/srv/dev-share", nobody)) return "Теперь удалять файлы в каталоге может кто угодно. Нужна только группа dev.";
          return world.canModifyDir("/srv/dev-share", alice);
        },
        hint: "Удаление меняет каталог, а не файл. Чьи права на каталог нужно расширить?",
        solution: "chmod g+w /srv/dev-share",
        accept: ["chmod 775 /srv/dev-share", "chmod g=rwx /srv/dev-share"],
        reject: ["chmod o+w /srv/dev-share", "chmod 666 /srv/dev-share/alice-notes.txt"],
        explain:
          "`rm` вызывает `unlink()` — убирает запись из каталога, поэтому нужны `w` и `x` на каталог, а права на сам файл не важны. Группе dev — `g+w`; `777` открыл бы удаление всем.",
      },
      {
        id: "move-exam-04",
        type: "terminal",
        theory: "rm",
        prompt:
          "В **/var/cache/app** накопились временные каталоги. Удали из них пустые, а непустые оставь — в них может работать приложение.",
        setup: async (w) => {
          await w.mkdir("/var/cache/app/tmp1");
          await w.mkdir("/var/cache/app/tmp2");
          await w.write("/var/cache/app/data/index.db", bytes(2048));
          await w.write("/var/cache/app/sess/.s1", "user=42\n");
        },
        check: async ({ world }) => !(await world.exists("/var/cache/app/tmp1")) && !(await world.exists("/var/cache/app/tmp2")),
        hint: "Команда, которая удаляет каталог, только если он пуст, — и отказывается иначе.",
        solution: "rmdir /var/cache/app/tmp1 /var/cache/app/tmp2",
        accept: ["rmdir /var/cache/app/*", "rm -d /var/cache/app/tmp1 /var/cache/app/tmp2"],
        reject: ["rmdir /var/cache/app/tmp1"],
        explain:
          "`rmdir /var/cache/app/*` — удобный приём: пустые удалятся, на непустые (data и sess со скрытым файлом) будет `Directory not empty`, и ничего не пропадёт.",
      },
      {
        id: "move-exam-05",
        type: "terminal",
        theory: "mv",
        cwd: "/srv/photos",
        prompt: "Сайт не видит фотографии с расширением `.JPG`. Переименуй в **/srv/photos** все `*.JPG` в `*.jpg`.",
        setup: async (w) => {
          for (const f of ["IMG_001", "IMG_002", "team photo"]) await w.write(`/srv/photos/${f}.JPG`, `JPEG ${f}\n`);
          await w.write("/srv/photos/notes.txt", "shot on 2026-11-20\n");
        },
        check: async ({ world }) => {
          for (const f of ["IMG_001", "IMG_002", "team photo"])
            if ((await world.read(`/srv/photos/${f}.jpg`)) !== `JPEG ${f}\n`) return false;
          const left = ((await ls(world, "/srv/photos")) ?? []).filter((n) => n.endsWith(".JPG"));
          return left.length ? `Остались: ${left.join(", ")}.` : true;
        },
        hint: "Цикл по файлам и отрезание суффикса у переменной. Не забудь про имя с пробелом.",
        solution: 'for f in *.JPG; do mv -- "$f" "${f%.JPG}.jpg"; done',
        accept: ['mv IMG_001.JPG IMG_001.jpg\nmv IMG_002.JPG IMG_002.jpg\nmv "team photo.JPG" "team photo.jpg"'],
        reject: ["mv *.JPG *.jpg", 'for f in *.JPG; do mv $f ${f%.JPG}.jpg; done'],
        explain:
          "`mv *.JPG *.jpg` не переименовывает пачкой. Цикл с `\"$f\"` и `\"${f%.JPG}.jpg\"` справится и с `team photo.JPG`; без кавычек имя развалится на два аргумента.",
      },
    ],
  },
}, GUARDS);
