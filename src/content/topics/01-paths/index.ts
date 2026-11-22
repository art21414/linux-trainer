import type { Topic } from "../../types";
import type { World } from "../../../engine/world";
import theoryMd from "./theory.md?raw";

// ---------- помощники для setup/check ----------
const ago = (min: number) => new Date(Date.now() - min * 60_000);
const DAY = 24 * 60;
/** Выставить mtime (и atime, если задан) — как будто файл менялся давно. */
const stamp = (w: World, path: string, mtimeMin: number, atimeMin = mtimeMin) =>
  w.setTimes(path, { mtime: ago(mtimeMin), atime: ago(atimeMin) });
const bytes = (n: number) => "x".repeat(n - 1) + "\n";
const REPORT = "Q3 revenue: 140\nQ3 costs: 95\nmargin: 32%\n";

/** Содержимое /root/answer без краевых пробелов; null — файла нет. */
async function answer(w: World): Promise<string | null> {
  const a = await w.read("/root/answer");
  return a === null ? null : a.trim();
}
/** Имена из ответа: по строке, последнее слово строки, без пути и слэша на конце. Строки `total N` пропускаются. */
const namesOf = (a: string) =>
  a
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !/^total \d+/.test(s))
    .map((s) => s.split(/\s+/).pop()!)
    .filter((n) => n !== "." && n !== "..")
    .map((n) => n.replace(/\/+$/, "").split("/").pop()!);
/** Ответ — одно имя файла (допускается полный путь и строка ls -l). */
const oneName = (a: string): string | null => {
  const n = namesOf(a);
  return n.length === 1 ? n[0] : null;
};

/** /srv/app: два релиза, current -> releases/v2. */
async function appTree(w: World) {
  for (const v of ["v1", "v2"]) {
    await w.mkdir(`/srv/app/releases/${v}/conf`);
    await w.mkdir(`/srv/app/releases/${v}/bin`);
    await w.write(`/srv/app/releases/${v}/conf/app.conf`, `# release ${v}\nlisten = 8080\nworkers = ${v === "v1" ? 4 : 8}\n`);
  }
  await w.write("/srv/app/releases/v2/app.jar", bytes(4096));
  await w.fs.symlink("releases/v2", "/srv/app/current");
}

export const paths: Topic = {
  id: "paths",
  n: 1,
  title: "Пути и ls",
  summary: "cd -, ~-, логический и физический путь, readlink -f, ls -l без иллюзий, -d, -A, -t, -S, -u",
  level: "base",
  theory: theoryMd,
  sets: [
    {
      id: "1",
      title: "Разминка: пути и ls",
      exercises: [
        {
          id: "paths-1-01",
          type: "terminal",
          theory: "paths",
          cwd: "/srv/app/releases/v2/conf",
          prompt:
            "Ты в каталоге конфигов нового релиза **/srv/app/releases/v2/conf**. Для сравнения нужен конфиг прошлого релиза: скопируй **app.conf** из **/srv/app/releases/v1/conf** сюда, под именем **app.conf.v1**.",
          setup: appTree,
          check: async ({ world }) => {
            const got = await world.read("/srv/app/releases/v2/conf/app.conf.v1");
            if (got === null) return false;
            if (got.includes("release v2")) return "Это конфиг текущего релиза v2, а нужен из v1.";
            return got.includes("release v1");
          },
          hint: "От conf до releases — два уровня вверх.",
          solution: "cp ../../v1/conf/app.conf app.conf.v1",
          accept: [
            "cp /srv/app/releases/v1/conf/app.conf ./app.conf.v1",
            "cd ../../v1/conf\ncp app.conf ~-/app.conf.v1",
          ],
          reject: ["cp app.conf app.conf.v1"],
          explain:
            "`..` — настоящая запись каталога, поэтому работает в любой команде: `../../v1` из `v2/conf` — это `releases/v1`. Второй вариант — через `~-`: после `cd` туда, откуда пришёл, ведёт `$OLDPWD`.",
        },
        {
          id: "paths-1-02",
          type: "terminal",
          theory: "ls",
          prompt:
            "Сервис не может создать файл в **/srv/share**. Первый вопрос — кто владелец самого каталога? Запиши имя пользователя в **/root/answer**.",
          setup: async (w) => {
            const a = w.user("alice")!;
            const b = w.user("bob")!;
            await w.mkdir("/srv/share", 0o755, b.uid, b.gid);
            await w.write("/srv/share/report.txt", "Q3\n", 0o644, a.uid, a.gid);
            await w.write("/srv/share/data.csv", "id,sum\n1,10\n", 0o644, a.uid, a.gid);
          },
          check: async ({ world }) => {
            const a = await answer(world);
            if (a === null) return false;
            const first = a.split("\n")[0].trim();
            if (first === "bob") return true;
            if (/^d/.test(first) && first.split(/\s+/)[2] === "bob") return true;
            if (/Uid: \(\s*\d+\/\s*bob\)/.test(a)) return true;
            if (a.includes("alice"))
              return "alice — владелец файлов внутри: ls -l на каталог показывает его содержимое. Нужен сам каталог.";
            return "Не тот пользователь. Посмотри на сам каталог, а не на его содержимое.";
          },
          hint: "ls -l на каталог показывает файлы в нём. Нужен ключ, который покажет сам каталог.",
          solution: "ls -ld /srv/share > /root/answer",
          accept: ["stat -c %U /srv/share > /root/answer", "stat /srv/share > /root/answer", "echo bob > /root/answer"],
          reject: ["echo alice > /root/answer", "ls -l /srv/share > /root/answer"],
          explain:
            "`ls -l /srv/share` выводит содержимое — там файлы alice. Сам каталог показывает `ls -ld` (или `stat`): его владелец bob. При Permission denied на создание файла важны права каталога, а не файлов в нём.",
        },
        {
          id: "paths-1-03",
          type: "terminal",
          theory: "ls",
          prompt:
            "Разработчик клянётся, что положил в **/srv/app** файл с переменными окружения, но `ls /srv/app` его не показывает. Найди его и запиши имя в **/root/answer**.",
          setup: async (w) => {
            await w.write("/srv/app/app.conf", "listen = 8080\n");
            await w.write("/srv/app/run.sh", "#!/bin/bash\nexec java -jar app.jar\n", 0o755);
            await w.write("/srv/app/.env", "DB_HOST=db1\nDB_PASS=secret\n", 0o600);
            await w.write("/srv/app/.gitignore", "logs/\n");
            await w.mkdir("/srv/app/logs");
          },
          check: async ({ world }) => {
            const a = await answer(world);
            if (a === null) return false;
            if (a === ".env" || a === "/srv/app/.env") return true;
            if (a.includes(".env")) return "Файл найден, но в ответе лишнее — нужно только имя.";
            if (a.includes(".gitignore")) return ".gitignore — список исключений для git. Переменные окружения лежат в другом скрытом файле.";
            return "Его нет в обычном выводе ls. Имена с точкой в начале ls прячет — нужен ключ, который их покажет.";
          },
          hint: "Скрытые файлы — просто имена с точкой в начале. У ls есть ключ, который их показывает.",
          solution: "ls -A /srv/app | grep env > /root/answer",
          accept: ["echo .env > /root/answer", "ls -a /srv/app | grep '^.e' > /root/answer"],
          reject: ["ls /srv/app > /root/answer"],
          explain:
            "Атрибута «скрытый» в Linux нет: `ls` просто пропускает имена, начинающиеся с точки. `-a` показывает их вместе с `.` и `..`, `-A` — без них.",
        },
      ],
    },
    {
      id: "2",
      title: "Средние: ls и ссылки",
      exercises: [
        {
          id: "paths-2-01",
          type: "terminal",
          theory: "ls",
          prompt:
            "Приложение пишет в один из логов в **/var/log/app**, но в какой — никто не помнит. Найди файл, который менялся последним, и запиши его имя (только имя) в **/root/answer**.",
          setup: async (w) => {
            const logs: [string, number, number][] = [
              ["access.log", 9000, 180],
              ["app.log", 2500, 60],
              ["error.log", 300, 2],
              ["worker.log", 1200, 2 * DAY],
            ];
            for (const [name, size, min] of logs) {
              await w.write(`/var/log/app/${name}`, bytes(size));
              await stamp(w, `/var/log/app/${name}`, min);
            }
          },
          check: async ({ world }) => {
            const a = await answer(world);
            if (a === null) return false;
            if (a === "error.log" || a === "/var/log/app/error.log") return true;
            if (a.includes("\n")) return "В ответе несколько строк. Нужно одно имя: отрежь первую строку через head -1.";
            if (a.includes("error.log")) return "Файл верный, но в ответе лишнее — нужно только имя.";
            if (a.includes("access.log")) return "access.log — самый большой (это ls -S), а нужен самый свежий по времени изменения.";
            if (a.includes("worker.log")) return "worker.log — последний по алфавиту, а не по времени.";
            return "Не тот файл. Отсортируй по времени изменения.";
          },
          hint: "ls умеет сортировать по mtime, свежие сверху. Первую строку отрежет head -1.",
          solution: "ls -t /var/log/app | head -1 > /root/answer",
          accept: ["ls -tr /var/log/app | tail -1 > /root/answer", "cd /var/log/app\nls -t | head -n 1 > /root/answer"],
          reject: ["ls -S /var/log/app | head -1 > /root/answer", "ls /var/log/app | tail -1 > /root/answer"],
          explain:
            "`ls -t` сортирует по mtime, свежие сверху; `ls -tr | tail -1` — то же с другого конца. В пайп ls выводит по одному имени в строке, поэтому `head -1` даёт ровно одно имя. `-S` — сортировка по размеру, частая подмена.",
        },
        {
          id: "paths-2-02",
          type: "terminal",
          theory: "symlinks",
          prompt:
            "На сервере три релиза в **/srv/app/releases**, активный — тот, на который указывает **/srv/app/current**. Запиши в **/root/answer** полный физический путь к активному релизу.",
          setup: async (w) => {
            await appTree(w);
            await w.mkdir("/srv/app/releases/v3/conf");
          },
          check: async ({ world }) => {
            const a = await answer(world);
            if (a === null) return false;
            const p = a.replace(/\/+$/, "");
            if (p === "/srv/app/releases/v2") return true;
            if (p === "releases/v2") return "Это то, что записано в самой ссылке, — относительный путь. Нужен полный, от корня.";
            if (p === "/srv/app/current") return "Это логический путь: bash помнит, как ты пришёл. Нужен физический.";
            if (p.includes("v3")) return "v3 — самый новый, но current указывает не на него. Не угадывай, спроси у ссылки.";
            return "Не тот путь. Спроси у ссылки, куда она ведёт, и получи полный путь.";
          },
          hint: "readlink без флагов покажет только то, что записано в ссылке. Нужен полный путь до конца.",
          solution: "readlink -f /srv/app/current > /root/answer",
          accept: [
            "realpath /srv/app/current > /root/answer",
            "cd /srv/app/current\npwd -P > /root/answer",
            "cd -P /srv/app/current\npwd > /root/answer",
          ],
          reject: ["cd /srv/app/current\npwd > /root/answer", "readlink /srv/app/current > /root/answer"],
          explain:
            "`readlink` выдаёт строку, записанную в ссылке (`releases/v2`), — она относительная и может вести к следующей ссылке. `readlink -f` и `realpath` раскрывают путь до конца. `pwd` после `cd` через ссылку покажет логический путь, физический — `pwd -P`.",
        },
        {
          id: "paths-2-03",
          type: "terminal",
          theory: "ls",
          prompt:
            "В **/etc/app** вперемешку конфиги и каталоги. Для инвентаризации запиши в **/root/answer** только подкаталоги, по одному в строке.",
          setup: async (w) => {
            await w.write("/etc/app/app.conf", "listen = 8080\n");
            await w.write("/etc/app/logging.conf", "level = info\n");
            await w.write("/etc/app/README", "see docs\n");
            for (const d of ["certs", "conf.d", "plugins"]) await w.mkdir(`/etc/app/${d}`);
            await w.write("/etc/app/conf.d/10-db.conf", "host = db1\n");
          },
          check: async ({ world }) => {
            const a = await answer(world);
            if (a === null) return false;
            const got = namesOf(a).sort().join(" ");
            if (got === "certs conf.d plugins") return true;
            if (/app\.conf|logging\.conf|README/.test(got)) return "В ответе есть и файлы. Нужны только каталоги.";
            if (got.includes("10-db.conf")) return "Это содержимое подкаталога. Нужны сами подкаталоги /etc/app.";
            return "Не тот список. Нужны три подкаталога /etc/app.";
          },
          hint: "Шаблон со слэшем на конце совпадает только с каталогами. Не забудь, что ls на каталог показывает содержимое.",
          solution: "ls -d /etc/app/*/ > /root/answer",
          accept: [
            "cd /etc/app\nls -d */ > /root/answer",
            "ls -p /etc/app | grep / > /root/answer",
            "ls -l /etc/app | grep ^d > /root/answer",
          ],
          reject: ["ls /etc/app > /root/answer", "ls /etc/app/*/ > /root/answer"],
          explain:
            "`*/` совпадает только с каталогами (и ссылками на них), а `-d` не даёт ls зайти внутрь — без него `ls */` выведет содержимое каждого. Тот же результат дают `ls -p | grep /` и `ls -l | grep ^d`.",
        },
        {
          id: "paths-2-04",
          type: "terminal",
          theory: "ls-long",
          prompt:
            "Уволившегося сотрудника удалили через `userdel`, а его файлы в **/srv/projects** остались. Чтобы потом найти все такие файлы, узнай, какой uid теперь записан у них владельцем, и запиши число в **/root/answer**.",
          setup: async (w) => {
            const a = w.user("alice")!;
            await w.write("/srv/projects/report.txt", "Q3 plan\n", 0o644, a.uid, a.gid);
            await w.write("/srv/projects/old-crm.sql", bytes(2048), 0o640, 1005, 1005);
            await w.write("/srv/projects/notes.txt", "todo: migrate\n", 0o644, 1005, 1005);
          },
          check: async ({ world }) => {
            const a = await answer(world);
            if (a === null) return false;
            if (a === "1005") return true;
            if (a === "1000" || a.includes("alice")) return "Это alice — она в системе есть. Ищи файлы, у которых вместо имени число.";
            if (a.includes("1005")) return "uid верный, но в ответе лишнее — нужно только число.";
            return "Не тот uid. Посмотри на колонку владельца в ls -l.";
          },
          hint: "Если пользователя нет в /etc/passwd, ls -l покажет вместо имени число.",
          solution: "stat -c %u /srv/projects/notes.txt > /root/answer",
          accept: ["echo 1005 > /root/answer"],
          reject: ["echo 1000 > /root/answer"],
          explain:
            "В inode хранится uid, имя `ls` берёт из `/etc/passwd`. Учётки нет — остаётся число. Опасность: следующий пользователь с uid 1005 станет владельцем этих файлов. Найти их все — `find / -nouser` (или `find / -uid 1005`).",
        },
        {
          id: "paths-2-05",
          type: "terminal",
          theory: "ls-long",
          prompt:
            "Коллега просит в тикет длинный листинг активного релиза: права, владельцы и размеры всего, что лежит внутри. Активный релиз — то, на что указывает **/srv/app/current**. Сохрани листинг в **/root/answer**.",
          setup: appTree,
          check: async ({ world }) => {
            const a = await answer(world);
            if (a === null) return false;
            if (a.includes("-> releases/v2")) return "Это строка самой ссылки, а не то, что за ней.";
            if (!/rw/.test(a)) return "Нужен длинный формат: права, владельцы, размеры.";
            const n = namesOf(a).sort().join(" ");
            if (n === "app.jar bin conf") return true;
            return "В листинге не то содержимое. Нужно то, что лежит в активном релизе.";
          },
          hint: "ls -l на ссылку показывает саму ссылку. Как заставить его пройти по ней?",
          solution: "ls -l /srv/app/current/ > /root/answer",
          accept: [
            "ls -lL /srv/app/current > /root/answer",
            "ls -l /srv/app/releases/v2 > /root/answer",
            "ls -la /srv/app/current/ > /root/answer",
            "cd /srv/app/current\nls -l > /root/answer",
          ],
          reject: ["ls -l /srv/app/current > /root/answer", "ls /srv/app/current/ > /root/answer"],
          explain:
            "С `-l` ls не разыменовывает ссылку из командной строки и выводит одну строку `current -> releases/v2`. Слэш на конце (`current/`) или `-L` заставляют пройти по ней. Так же ведёт себя `ls -l /bin` на RHEL 9.",
        },
        {
          id: "paths-2-06",
          type: "terminal",
          theory: "ls",
          prompt:
            "Мониторинг говорит, что очередь **/var/spool/app/queue** не пустеет. Посчитай, сколько в ней записей, включая скрытые временные файлы, и запиши число в **/root/answer**.",
          setup: async (w) => {
            for (const f of ["msg-1001", "msg-1002", "msg-1003", ".msg-1004.tmp", ".lock"])
              await w.write(`/var/spool/app/queue/${f}`, "job\n");
          },
          check: async ({ world }) => {
            const a = await answer(world);
            if (a === null) return false;
            if (a === "5") return true;
            if (a === "7") return "На два больше: в подсчёт попали . и .. — они есть в любом каталоге.";
            if (a === "3") return "Скрытые файлы не посчитаны.";
            return "Не то число. Посчитай все записи, кроме . и ..";
          },
          hint: "Нужен ключ ls, который показывает скрытые, но без . и ..",
          solution: "ls -A /var/spool/app/queue | wc -l > /root/answer",
          accept: ["echo 5 > /root/answer"],
          reject: ["ls -a /var/spool/app/queue | wc -l > /root/answer", "ls /var/spool/app/queue | wc -l > /root/answer"],
          explain:
            "`-a` добавляет `.` и `..` — подсчёт всегда завышен на два. `-A` показывает скрытые без них. В пайп ls пишет по одному имени в строке, поэтому `wc -l` считает файлы (пока в именах нет перевода строки).",
        },
      ],
    },
    {
      id: "3",
      title: "Сложные: ссылки и сортировки",
      exercises: [
        {
          id: "paths-3-01",
          type: "terminal",
          theory: "symlinks",
          prompt:
            "Логи вынесли на отдельный диск: **/var/log/app** теперь ссылка. Приложение упало — найди самый свежий лог в /var/log/app и запиши в **/root/answer** его полный физический путь: коллега будет искать файл на диске, без ссылок.",
          setup: async (w) => {
            const logs: [string, number][] = [
              ["app.log", 30],
              ["error.log", 3],
              ["gc.log", 2 * DAY],
            ];
            for (const [name, min] of logs) {
              await w.write(`/data/logs/app/${name}`, bytes(500));
              await stamp(w, `/data/logs/app/${name}`, min);
            }
            await w.fs.symlink("/data/logs/app", "/var/log/app");
          },
          check: async ({ world }) => {
            const a = await answer(world);
            if (a === null) return false;
            if (a === "/data/logs/app/error.log") return true;
            if (a === "/var/log/app/error.log") return "Файл верный, но путь идёт через ссылку /var/log/app. Нужен физический.";
            if (a === "error.log") return "Файл верный, но нужен полный путь от корня.";
            if (a.includes("->")) return "Это строка самой ссылки: ls -l на ссылку не заходит внутрь.";
            return "Не тот файл или путь. Сначала найди самый свежий лог, потом раскрой путь до конца.";
          },
          hint: "Два шага: ls -t найдёт файл, realpath (или cd -P) уберёт ссылку из пути.",
          solution: "realpath /var/log/app/$(ls -t /var/log/app | head -1) > /root/answer",
          accept: [
            "cd -P /var/log/app\necho $PWD/$(ls -t | head -1) > /root/answer",
            "cd /var/log/app\nrealpath $(ls -t | head -1) > /root/answer",
            "echo /data/logs/app/error.log > /root/answer",
          ],
          reject: [
            "cd /var/log/app\necho $PWD/$(ls -t | head -1) > /root/answer",
            "ls -t /var/log/app | head -1 > /root/answer",
          ],
          explain:
            "`ls -t | head -1` даёт имя самого свежего файла, `realpath` раскрывает ссылку. Если перейти через `cd` без `-P`, `$PWD` останется логическим — `/var/log/app`. И заметь: `ls -lt /var/log/app` без слэша покажет одну строку — саму ссылку.",
        },
        {
          id: "paths-3-02",
          type: "terminal",
          theory: "ls",
          prompt:
            "Перед чисткой **/srv/reports** нужно понять, какой отчёт дольше всех никто не открывал (по времени последнего чтения). Запиши его имя в **/root/answer**.",
          setup: async (w) => {
            // mtime и atime нарочно не совпадают по порядку
            await w.write("/srv/reports/jan.csv", "month,sum\n01,100\n");
            await stamp(w, "/srv/reports/jan.csv", 1 * DAY, 40 * DAY);
            await w.write("/srv/reports/feb.csv", "month,sum\n02,110\n");
            await stamp(w, "/srv/reports/feb.csv", 30 * DAY, 2 * DAY);
            await w.write("/srv/reports/mar.csv", "month,sum\n03,120\n");
            await stamp(w, "/srv/reports/mar.csv", 10 * DAY, 60);
          },
          check: async ({ world }) => {
            const a = await answer(world);
            if (a === null) return false;
            const n = oneName(a);
            if (n === null) return "Нужно одно имя, а в ответе несколько строк.";
            if (n === "jan.csv") return true;
            if (n === "feb.csv") return "feb.csv — самый старый по mtime (изменение). А нужно время последнего чтения.";
            if (n === "mar.csv") return "mar.csv открывали час назад. Похоже, вывод отсортирован по имени: -lu показывает atime, но сортирует по имени.";
            return "Не тот файл.";
          },
          hint: "Время чтения — atime, ключ -u. Посмотри в теории, когда -u сортирует, а когда только показывает.",
          solution: "ls -tu /srv/reports | tail -1 > /root/answer",
          accept: [
            "ls -u /srv/reports | tail -1 > /root/answer",
            "ls -ltu /srv/reports | tail -1 > /root/answer",
            "ls -tur /srv/reports | head -1 > /root/answer",
          ],
          reject: ["ls -lu /srv/reports | tail -1 > /root/answer", "ls -t /srv/reports | tail -1 > /root/answer"],
          explain:
            "`-u` подставляет atime. Но с `-l` без `-t` ls только **показывает** atime, а сортирует по имени — отсюда mar.csv. Сортируют по atime `ls -tu`, `ls -ltu` или просто `ls -u` без `-l`.",
        },
        {
          id: "paths-3-03",
          type: "terminal",
          theory: "symlinks",
          cwd: "/srv/app/current",
          prompt:
            "Ты зашёл в релиз через ссылку **current**. Сборщик пишет в отчёт пути от `$PWD`, и они не совпадают с тем, что лежит на диске. Перейди в этот же каталог так, чтобы `$PWD` стал физическим путём.",
          setup: appTree,
          check: async ({ shell }) => {
            const cwd = shell.cwd.replace(/\/+$/, "");
            if (cwd === "/srv/app/releases/v2") return true;
            if (cwd === "/srv/app/current") return "$PWD всё ещё логический — через ссылку current.";
            return "Нужен тот же каталог — активный релиз, а не другой.";
          },
          hint: "У cd есть режим, в котором ссылки раскрываются сразу.",
          solution: "cd -P .",
          accept: ['cd "$(pwd -P)"', "cd /srv/app/releases/v2", "cd -P /srv/app/current"],
          reject: ["cd .", "cd /srv/app/current"],
          explain:
            "`cd` по умолчанию работает в режиме `-L`: запоминает путь так, как ты его набрал. `cd -P` раскрывает ссылки сразу, и `$PWD` совпадает с `pwd -P`. В скриптах, работающих внутри `current`, так и делают.",
        },
      ],
    },
    {
      id: "4",
      title: "На подумать: куда ведут пути",
      exercises: [
        {
          id: "paths-4-01",
          type: "terminal",
          theory: "symlinks",
          cwd: "/srv/app/current",
          prompt:
            "Ты в **/srv/app/current** (это ссылка на `releases/v2`). Положи хотфикс **/tmp/hotfix.conf** в **/srv/app** — рядом со ссылкой current, на уровень выше неё. Релизы не трогай.",
          setup: async (w) => {
            await appTree(w);
            await w.write("/tmp/hotfix.conf", "workers = 16\n");
          },
          check: async ({ world }) => {
            if (await world.exists("/srv/app/releases/hotfix.conf"))
              return "Файл лёг в /srv/app/releases: для cp `..` — настоящий родитель v2, а не то, что «вверху» по $PWD. Убери его оттуда.";
            return (await world.read("/srv/app/hotfix.conf")) === "workers = 16\n";
          },
          hint: "Для cp `..` из current — это родитель настоящего каталога v2. Куда это?",
          solution: "cp /tmp/hotfix.conf /srv/app/",
          accept: ["cd ..\ncp /tmp/hotfix.conf .", "cp /tmp/hotfix.conf ../.."],
          reject: ["cp /tmp/hotfix.conf .."],
          explain:
            "Внешние команды получают `..` от ядра: у каталога `v2` это `releases`. А `cd ..` — встроенная команда bash: в режиме `-L` она отрезает компонент от `$PWD` и приводит в `/srv/app`. Отсюда разница: `cp f ..` — в releases, `cd ..; cp f .` — в /srv/app. Надёжнее всего абсолютный путь.",
        },
        {
          id: "paths-4-02",
          type: "choice",
          kind: "predict",
          theory: "paths",
          prompt:
            "Скрипт бэкапа запускается из cron от root. `BACKUP_DIR` он берёт из env-файла, но этой ночью файл не подгрузился, и переменная пустая. Что сделает строка с `cp`?",
          code: '#!/bin/bash\ncd /srv/app\ncp app.conf "$BACKUP_DIR/app.conf.bak"',
          options: [
            "Тихо скопирует конфиг в корень: `/app.conf.bak`",
            "Упадёт: `cp: cannot create regular file '/app.conf.bak': Permission denied`",
            "Скопирует в текущий каталог: `/srv/app/app.conf.bak`",
            "Упадёт: `BACKUP_DIR: parameter null or not set`",
          ],
          answer: 0,
          explain:
            "Пустая переменная превращает `\"$BACKUP_DIR/app.conf.bak\"` в `/app.conf.bak` — путь от корня. Root писать в `/` может, ошибки не будет. `parameter null or not set` напечатал бы bash, если бы в скрипте было `${BACKUP_DIR:?}` — так и надо защищаться.",
        },
        {
          id: "paths-4-03",
          type: "terminal",
          theory: "ls-long",
          prompt:
            "В **/srv/drop** лежит отчёт **report.txt**: ls его показывает, а `cat /srv/drop/report.txt` отвечает `No such file or directory`. Почини: отчёт должен открываться по имени report.txt, содержимое — прежнее.",
          setup: async (w) => {
            await w.write("/srv/drop/report.txt ", REPORT);
            await w.write("/srv/drop/summary.txt", "ok\n");
          },
          check: async ({ world }) => {
            const good = await world.read("/srv/drop/report.txt");
            const bad = await world.exists("/srv/drop/report.txt ");
            if ((await world.read("/srv/drop/summary.txt")) !== "ok\n") return "Пострадал соседний summary.txt — трогать нужно только отчёт. Начни заново.";
            if (good === null) return false;
            if (good !== REPORT) return "report.txt открывается, но это не исходный отчёт. Переименуй файл, а не пиши новый.";
            if (bad) return "Отчёт открывается, но рядом остался файл с кривым именем — переименуй, а не копируй.";
            return true;
          },
          hint: "Посмотри, как ls в терминале показывает это имя — кавычки там не просто так.",
          solution: "mv '/srv/drop/report.txt ' /srv/drop/report.txt",
          accept: ["mv /srv/drop/report.txt\\  /srv/drop/report.txt", "cd /srv/drop\nmv report.txt* report.txt"],
          reject: [
            "touch /srv/drop/report.txt",
            "cp '/srv/drop/report.txt ' /srv/drop/report.txt",
            "rm -f /srv/drop/*\necho 'Q3 revenue: 140' > /srv/drop/report.txt",
          ],
          explain:
            "В терминале ls показал `'report.txt '` — в кавычках, потому что в конце имени пробел. В пайпе кавычек нет, и пробел не видно. Имя с пробелом передают в кавычках или экранируют `\\ `.",
        },
      ],
    },
  ],
  exam: {
    id: "exam",
    title: "Зачёт",
    exercises: [
      {
        id: "paths-exam-01",
        type: "terminal",
        theory: "ls",
        prompt:
          "Место на /var заканчивается. Найди самый большой файл в **/var/log/nginx** (подкаталогов там нет) и запиши его имя в **/root/answer**.",
        setup: async (w) => {
          const logs: [string, number, number][] = [
            ["access.log", 30000, 1],
            ["access.log.1", 52000, DAY],
            ["error.log", 4000, 5],
            ["error.log.1", 900, DAY + 3],
          ];
          for (const [name, size, min] of logs) {
            await w.write(`/var/log/nginx/${name}`, bytes(size));
            await stamp(w, `/var/log/nginx/${name}`, min);
          }
        },
        check: async ({ world }) => {
          const a = await answer(world);
          if (a === null) return false;
          if (a === "access.log.1" || a === "/var/log/nginx/access.log.1") return true;
          if (a.includes("\n")) return "Нужно одно имя, а в ответе несколько строк.";
          if (a.includes("access.log.1")) return "Файл верный, но в ответе лишнее — нужно только имя.";
          if (/(^|\/)access\.log$/.test(a)) return "access.log — самый свежий (ls -t), а не самый большой.";
          return "Не тот файл. Отсортируй по размеру.";
        },
        hint: "У ls есть сортировка по размеру — большие сверху.",
        solution: "ls -S /var/log/nginx | head -1 > /root/answer",
        accept: ["ls -Sr /var/log/nginx | tail -1 > /root/answer", "echo access.log.1 > /root/answer"],
        reject: ["ls -t /var/log/nginx | head -1 > /root/answer"],
        explain:
          "`ls -S` — по размеру, большие сверху. Самым большим часто оказывается вчерашняя ротация, а не текущий лог, поэтому смотреть надо, а не угадывать.",
      },
      {
        id: "paths-exam-02",
        type: "terminal",
        theory: "symlinks",
        prompt:
          "Для разбора инцидента нужно точно знать, какая версия tool работает. Запускается она через **/opt/tool/current**. Запиши в **/root/answer** полный путь к каталогу, на который этот путь в итоге указывает.",
        setup: async (w) => {
          await w.mkdir("/opt/tool/releases/2.4/bin");
          await w.mkdir("/opt/tool/releases/2.5/bin");
          await w.fs.symlink("releases/2.4", "/opt/tool/stable");
          await w.fs.symlink("stable", "/opt/tool/current");
        },
        check: async ({ world }) => {
          const a = await answer(world);
          if (a === null) return false;
          const p = a.replace(/\/+$/, "");
          if (p === "/opt/tool/releases/2.4") return true;
          if (p === "stable" || p === "/opt/tool/stable") return "stable — только первое звено: это тоже ссылка. Пройди цепочку до конца.";
          if (p === "releases/2.4") return "Каталог верный, но путь относительный. Нужен от корня.";
          if (p.includes("2.5")) return "2.5 — самая новая, но работает не она. Не угадывай.";
          return "Не тот путь.";
        },
        hint: "Ссылка может указывать на другую ссылку. Какой ключ readlink идёт до конца?",
        solution: "readlink -f /opt/tool/current > /root/answer",
        accept: ["realpath /opt/tool/current > /root/answer", "cd -P /opt/tool/current\npwd > /root/answer"],
        reject: ["readlink /opt/tool/current > /root/answer"],
        explain:
          "`current -> stable -> releases/2.4`. `readlink` без ключей показывает одно звено, `readlink -f` и `realpath` проходят всю цепочку и дают абсолютный путь.",
      },
      {
        id: "paths-exam-03",
        type: "terminal",
        theory: "ls",
        prompt:
          "Несколько минут назад кто-то поменял один из файлов в **/srv/app**, и приложение начало падать. Найди самый недавно изменённый файл (скрытые тоже считаются) и запиши его имя в **/root/answer**.",
        setup: async (w) => {
          await w.write("/srv/app/app.conf", "listen = 8080\n");
          await w.write("/srv/app/run.sh", "#!/bin/bash\nexec java -jar app.jar\n", 0o755);
          await w.mkdir("/srv/app/logs");
          await w.write("/srv/app/.env", "DB_HOST=db2\n", 0o600);
          await stamp(w, "/srv/app/app.conf", 2 * DAY);
          await stamp(w, "/srv/app/run.sh", DAY);
          await stamp(w, "/srv/app/logs", 180);
          await stamp(w, "/srv/app/.env", 5);
        },
        check: async ({ world }) => {
          const a = await answer(world);
          if (a === null) return false;
          if (a === ".env" || a === "/srv/app/.env") return true;
          if (a === "." || a === "..") return "Это сам каталог (или родитель): -a показывает . и .., и их время тоже сортируется. Нужен ключ без них.";
          if (/app\.conf|run\.sh|logs/.test(a) && !a.includes("\n")) return "Скрытые файлы в сортировку не попали.";
          if (a.includes("\n")) return "Нужно одно имя.";
          return "Не тот файл.";
        },
        hint: "Сортировка по времени плюс ключ, который покажет скрытые, но без . и ..",
        solution: "ls -At /srv/app | head -1 > /root/answer",
        accept: ["ls -Atr /srv/app | tail -1 > /root/answer", "echo .env > /root/answer"],
        reject: ["ls -t /srv/app | head -1 > /root/answer", "ls -at /srv/app | head -1 > /root/answer"],
        explain:
          "Без `-A` скрытый `.env` в сортировку не попадает. С `-a` первым легко окажется `.`: mtime каталога меняется при каждом создании или удалении файла в нём.",
      },
      {
        id: "paths-exam-04",
        type: "terminal",
        theory: "ls-long",
        prompt:
          "Веб-сервер не может писать в **/var/www** — это ссылка. Запиши в **/root/answer** строку `ls -l` про сам каталог, на который она ведёт (права и владелец), — не про ссылку и не про содержимое.",
        setup: async (w) => {
          const b = w.user("bob")!;
          await w.mkdir("/srv/www", 0o755, b.uid, b.gid);
          await w.write("/srv/www/index.html", "<h1>hi</h1>\n", 0o644, b.uid, b.gid);
          await w.fs.symlink("/srv/www", "/var/www");
        },
        check: async ({ world }) => {
          const a = await answer(world);
          if (a === null) return false;
          const lines = a.split("\n").filter((s) => s.trim());
          if (lines.length !== 1 || /^total/.test(lines[0])) return "Это содержимое каталога, а нужна одна строка про сам каталог.";
          const www = await world.info("/srv/www");
          if (!www || (www.mode & 0o7777) !== 0o755 || www.uid !== world.user("bob")!.uid)
            return "Права или владелец /srv/www изменились. Задача — только посмотреть, а не чинить. Начни заново.";
          const l = lines[0];
          if (/^l/.test(l)) return "Это строка самой ссылки: у ссылки всегда lrwxrwxrwx, её права ни на что не влияют.";
          if (/^d/.test(l) && l.split(/\s+/)[2] === "bob") return true;
          return "Нужна строка ls -l про каталог.";
        },
        hint: "Два ключа: один — показать сам каталог, второй — пройти по ссылке.",
        solution: "ls -ldL /var/www > /root/answer",
        accept: ["ls -ld /srv/www > /root/answer", "ls -ld /var/www/ > /root/answer"],
        reject: ["ls -ld /var/www > /root/answer", "ls -l /var/www/ > /root/answer", "chmod 777 /srv/www\nls -ldL /var/www > /root/answer"],
        explain:
          "`ls -ld /var/www` покажет ссылку (`lrwxrwxrwx`) — её права не проверяются. `-L` или слэш на конце проходят по ссылке, `-d` не даёт зайти внутрь. Владелец каталога — bob, а веб-сервер работает от своего пользователя.",
      },
      {
        id: "paths-exam-05",
        type: "terminal",
        theory: "ls",
        prompt:
          "Логи в **/var/log/app** будут сжимать по очереди, начиная с самого старого. Запиши в **/root/answer** имена всех файлов каталога по времени изменения: самый старый — первым, по одному в строке.",
        setup: async (w) => {
          const logs: [string, number][] = [
            ["app.log", 1],
            ["app.log.1", DAY],
            ["app.log.2.gz", 2 * DAY],
            ["app.log.3.gz", 3 * DAY],
            ["error.log", 120],
          ];
          for (const [name, min] of logs) {
            await w.write(`/var/log/app/${name}`, bytes(300));
            await stamp(w, `/var/log/app/${name}`, min);
          }
        },
        check: async ({ world }) => {
          const a = await answer(world);
          if (a === null) return false;
          const got = namesOf(a).join(" ");
          const want = ["app.log.3.gz", "app.log.2.gz", "app.log.1", "error.log", "app.log"];
          if (got === want.join(" ")) return true;
          if (got === [...want].reverse().join(" ")) return "Порядок обратный: сверху самый свежий. Переверни сортировку.";
          if (namesOf(a).length !== want.length) return "Нужны все пять файлов, по одному в строке.";
          return "Порядок не по времени изменения.";
        },
        hint: "Сортировка по времени плюс ключ, который её переворачивает.",
        solution: "ls -tr /var/log/app > /root/answer",
        accept: ["ls -rt /var/log/app > /root/answer", "ls -1tr /var/log/app > /root/answer", "ls -ltr /var/log/app > /root/answer"],
        reject: ["ls -t /var/log/app > /root/answer", "ls -r /var/log/app > /root/answer"],
        explain:
          "`-t` — свежие сверху, `-r` переворачивает: старые первыми. Это тот же `ls -ltr`, которым смотрят логи: самый свежий оказывается внизу, у приглашения.",
      },
    ],
  },
};
