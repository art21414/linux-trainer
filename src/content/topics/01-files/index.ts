import type { Topic } from "../../types";
import type { World } from "../../../engine/world";
import theoryMd from "./theory.md?raw";

// ---------- помощники для setup/check ----------
const ago = (min: number) => new Date(Date.now() - min * 60_000);
const stamp = (w: World, path: string, d: Date) => w.base.utimes(path, d, d);
const bytes = (n: number) => "x".repeat(n - 1) + "\n";
/** Содержимое /root/answer без краевых пробелов; null — файла нет. */
async function answer(w: World): Promise<string | null> {
  const a = await w.read("/root/answer");
  return a === null ? null : a.trim();
}
/** Имена из ответа: по строке, последнее слово строки, без пути. Строки `total N` пропускаются. */
const namesOf = (a: string) =>
  a
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !/^total \d+/.test(s))
    .map((s) => s.split(/\s+/).pop()!.replace(/\/+$/, "").split("/").pop()!);
async function ls(w: World, dir: string): Promise<string[] | null> {
  try {
    return await w.base.readdir(dir);
  } catch {
    return null;
  }
}

export const files: Topic = {
  id: "files",
  n: 1,
  title: "Файлы и каталоги: то, что забывают",
  summary: "atime/mtime/ctime, ls -t/-S/-d, cp -r vs -a, glob и скобки, rm без сюрпризов",
  level: "base",
  theory: theoryMd,
  sets: [
    {
      id: "1",
      title: "Время файлов, ls и cp",
      exercises: [
        {
          id: "files-1-01",
          type: "choice",
          kind: "predict",
          theory: "times",
          prompt: "Конфиг правили вчера. Сегодня ты выполнил `chmod 640 app.conf`. Какие строки `stat app.conf` теперь показывают сегодняшнее время?",
          code: "$ chmod 640 app.conf\n$ stat app.conf | tail -4",
          options: ["Только Change", "Modify и Change", "Access, Modify и Change", "Только Modify"],
          answer: 0,
          explain:
            "chmod меняет inode (права), а не содержимое — это ctime (Change). mtime (Modify) двигается только при изменении данных, atime (Access) — при чтении, а chmod файл не читает. Birth не меняется никогда.",
        },
        {
          id: "files-1-02",
          type: "terminal",
          theory: "ls",
          prompt:
            "Приложение пишет в один из логов в **/var/log/app**, но в какой — никто не помнит. Найди файл, который менялся последним, и запиши его имя (только имя) в **/root/answer**.",
          setup: async (w) => {
            const logs: [string, number, number][] = [
              ["access.log", 9000, 180],
              ["app.log", 2500, 60],
              ["error.log", 300, 2],
              ["worker.log", 1200, 2 * 24 * 60],
            ];
            for (const [name, size, min] of logs) {
              await w.write(`/var/log/app/${name}`, bytes(size));
              await stamp(w, `/var/log/app/${name}`, ago(min));
            }
          },
          check: async ({ world }) => {
            const a = await answer(world);
            if (a === null) return false;
            if (a === "error.log" || a === "/var/log/app/error.log") return true;
            if (a.includes("\n")) return "В ответе несколько строк. Нужно одно имя: отрежь первую строку через head -1.";
            if (a.includes("error.log")) return "Файл верный, но в ответе лишнее — нужно только имя.";
            if (a.includes("access.log")) return "access.log — самый большой (это ls -S), а нужен самый свежий по времени изменения.";
            if (a.includes("worker.log")) return "worker.log — последний по алфавиту, а не по времени. Сортировка по mtime — ls -t.";
            return "Не тот файл. Отсортируй по времени изменения: ls -t, свежие сверху.";
          },
          hint: "ls умеет сортировать по mtime: свежие сверху. Первую строку отрежет head -1.",
          solution: "ls -t /var/log/app | head -1 > /root/answer",
          accept: ["ls -tr /var/log/app | tail -1 > /root/answer", "cd /var/log/app\nls -t | head -n 1 > /root/answer"],
          reject: ["ls -S /var/log/app | head -1 > /root/answer"],
          explain:
            "`ls -t` сортирует по mtime, свежие сверху; `ls -tr | tail -1` — то же с другого конца. Через пайп ls выводит по одному имени в строке, поэтому `head -1` даёт ровно одно имя. `-S` сортирует по размеру — частая подмена.",
        },
        {
          id: "files-1-03",
          type: "terminal",
          theory: "ls",
          prompt:
            "Сервис не может создать файл в **/srv/share**. Первый вопрос — кто владелец самого каталога? Запиши имя пользователя в **/root/answer**.",
          setup: async (w) => {
            const a = w.user("alice")!;
            const b = w.user("bob")!;
            await w.mkdir("/srv", 0o755, 0, 0);
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
            if (a.includes("alice"))
              return "alice — владелец файлов внутри: ls -l на каталог показывает его содержимое. Про сам каталог — ls -ld.";
            return "Не тот пользователь. Посмотри на сам каталог, а не на его содержимое.";
          },
          hint: "ls -l на каталог показывает файлы в нём. Нужен ключ, который покажет сам каталог.",
          solution: "ls -ld /srv/share > /root/answer",
          accept: ["stat -c %U /srv/share > /root/answer", "echo bob > /root/answer"],
          reject: ["echo alice > /root/answer"],
          explain:
            "`ls -l /srv/share` выводит содержимое каталога — там файлы alice. Сам каталог показывает `ls -ld` (или `stat`): его владелец bob. Та же ловушка с `ls -l` на симлинк к каталогу и с `ls *`.",
        },
        {
          id: "files-1-04",
          type: "choice",
          kind: "predict",
          theory: "cp",
          prompt:
            "Файл `/home/alice/site/index.html`: владелец alice, права `640`, mtime — 5 мая 2024. root выполняет команду ниже, umask `022`. Что будет у копии `/var/www/site/index.html`?",
          code: "# cp -r /home/alice/site /var/www/",
          options: [
            "root, права 640, mtime — сейчас",
            "alice, права 640, mtime — 5 мая 2024",
            "root, права 644, mtime — 5 мая 2024",
            "root, права 644, mtime — сейчас",
          ],
          answer: 0,
          explain:
            "Без `-p`/`-a` cp создаёт новый файл: владелец — тот, кто копирует, mtime — сейчас, права — исходные минус umask (640 & ~022 = 640). Права не «сбрасываются» в 644: umask только убирает биты. Сохранить владельца и время — `cp -a` или `cp -rp`.",
        },
        {
          id: "files-1-05",
          type: "terminal",
          theory: "cp",
          prompt:
            "Вчера сделали копию **/srv/app** в **/backup/app**. Сегодня конфиг в /srv/app обновили. Обнови копию: в /backup/app должны лежать те же файлы, что в /srv/app, на тех же местах.",
          setup: async (w) => {
            await w.write("/srv/app/app.conf", "version=2\n");
            await w.write("/srv/app/.env", "DB_PASS=s3cret\n", 0o600);
            await w.write("/srv/app/lib/util.sh", "#!/bin/bash\n", 0o755);
            await w.write("/backup/app/app.conf", "version=1\n");
            await w.write("/backup/app/lib/util.sh", "#!/bin/bash\n", 0o755);
          },
          check: async ({ world }) => {
            if (!(await world.exists("/srv/app/app.conf"))) return "Исходник /srv/app пострадал — нужна копия, а не перенос. Начни заново.";
            if (await world.exists("/backup/app/app"))
              return "Появился /backup/app/app: если цель — существующий каталог, cp -r кладёт источник внутрь. Убери вложенный каталог и копируй содержимое: /srv/app/.";
            if ((await world.read("/backup/app/app.conf")) !== "version=2\n") return false;
            if (!(await world.exists("/backup/app/.env")))
              return "app.conf свежий, но .env не скопировался: * не видит скрытые файлы. Копируй каталог целиком или через /srv/app/.";
            if (!(await world.exists("/backup/app/lib/util.sh"))) return "Пропал lib/util.sh — копируй рекурсивно.";
            return true;
          },
          hint: "cp -r в существующий каталог кладёт источник внутрь него. Нужно скопировать содержимое — и скрытые файлы тоже.",
          solution: "cp -r /srv/app/. /backup/app/",
          accept: ["rm -rf /backup/app\ncp -r /srv/app /backup/app", "cp -r /srv/app /backup/"],
          reject: ["cp -r /srv/app /backup/app", "cp -r /srv/app/* /backup/app/"],
          explain:
            "`cp -r /srv/app /backup/app` при существующем /backup/app создаёт /backup/app/app. `/srv/app/.` — это «содержимое каталога, включая скрытые», а `/srv/app/*` пропустит .env. Ещё вариант — `cp -rT`.",
        },
        {
          id: "files-1-06",
          type: "terminal",
          theory: "times",
          prompt:
            "Деплой прошёл несколько часов назад — его время хранится в mtime файла **/etc/app/.deployed**. После этого кто-то правил конфиги в **/etc/app**. Запиши в **/root/answer** имена файлов, изменённых позже метки, по одному в строке.",
          setup: async (w) => {
            const conf: [string, number][] = [
              ["main.conf", 2 * 24 * 60],
              ["logging.conf", 30 * 24 * 60],
              ["cache.conf", 180],
              ["db.conf", 60],
            ];
            for (const [name, min] of conf) {
              await w.write(`/etc/app/${name}`, `# ${name}\n`);
              await stamp(w, `/etc/app/${name}`, ago(min));
            }
            await w.write("/etc/app/.deployed", "release 2.4.1\n");
            await stamp(w, "/etc/app/.deployed", ago(300));
            await stamp(w, "/etc/app", ago(3 * 24 * 60));
          },
          check: async ({ world }) => {
            const a = await answer(world);
            if (a === null) return false;
            const names = namesOf(a);
            const want = ["cache.conf", "db.conf"];
            if (names.includes(".deployed")) return "Саму метку в список не включай — только файлы новее неё.";
            const extra = names.filter((n) => !want.includes(n));
            if (extra.length) return `${extra.join(", ")} — не из этого списка: сравни mtime с меткой (ls -lta или stat).`;
            const miss = want.filter((n) => !names.includes(n));
            if (miss.length) return `Найдены не все: файлов новее метки больше.`;
            return true;
          },
          hint: "Метка — скрытый файл: ls -lt его не покажет, нужен ещё -a. Всё, что выше неё в сортировке по времени, — ответ.",
          solution: "find /etc/app -type f -newer /etc/app/.deployed > /root/answer",
          accept: ["printf 'db.conf\\ncache.conf\\n' > /root/answer", "ls -t /etc/app | head -2 > /root/answer"],
          reject: ["ls -t /etc/app | head -3 > /root/answer"],
          explain:
            "Нужна сортировка по mtime с учётом скрытой метки: `ls -lta` покажет db.conf и cache.conf выше .deployed. `find -newer метка` делает то же сравнение сам. Для старых файлов ls -l пишет год вместо часов — точное время даст `ls -l --full-time` или `stat`.",
        },
      ],
    },
    {
      id: "2",
      title: "Glob, скобки и rm",
      exercises: [
        {
          id: "files-2-01",
          type: "terminal",
          theory: "glob",
          prompt:
            "Сборка намусорила в **/srv/build** временными файлами `*.tmp`. Удали все `.tmp` в этом каталоге — все до одного — и больше ничего не трогай.",
          setup: async (w) => {
            for (const f of ["app.tmp", "lib.tmp", ".deps.tmp", "template.tmpl", "app.bin", ".gitignore"])
              await w.write(`/srv/build/${f}`, `${f}\n`);
          },
          check: async ({ world }) => {
            const left = await ls(world, "/srv/build");
            if (!left) return "Каталог /srv/build пропал. Начни заново.";
            const keep = ["template.tmpl", "app.bin", ".gitignore"];
            const lost = keep.filter((f) => !left.includes(f));
            if (lost.length) return `Удалено лишнее: ${lost.join(", ")}. Шаблон должен кончаться на .tmp.`;
            const tmp = left.filter((f) => f.endsWith(".tmp"));
            if (tmp.length === 0) return true;
            if (tmp.length === 1 && tmp[0] === ".deps.tmp")
              return "Остался скрытый .deps.tmp: * не совпадает с именами на точку. Добавь шаблон .*.tmp или включи dotglob.";
            return false;
          },
          hint: "* не видит файлы, чьё имя начинается с точки. Для них нужен отдельный шаблон.",
          solution: "rm /srv/build/*.tmp /srv/build/.*.tmp",
          accept: ["cd /srv/build\nrm *.tmp .*.tmp", "find /srv/build -maxdepth 1 -name '*.tmp' -delete"],
          reject: ["rm /srv/build/*.tmp"],
          explain:
            "`*.tmp` пропускает `.deps.tmp`: glob не подставляет имена на точку, пока не включён `shopt -s dotglob`. `find -name '*.tmp'` скрытые видит — у find свои правила, и шаблон в кавычках до него доходит целым.",
        },
        {
          id: "files-2-02",
          type: "terminal",
          theory: "glob",
          prompt:
            "Под архив логов за 2025 год нужны каталоги **/srv/archive/2025-01** … **/srv/archive/2025-12** — так, чтобы `ls` выводил их по порядку месяцев. Создай их.",
          setup: async (w) => {
            await w.mkdir("/srv/archive", 0o755, 0, 0);
          },
          check: async ({ world }) => {
            const names = await ls(world, "/srv/archive");
            if (!names) return "Каталог /srv/archive пропал. Начни заново.";
            const want = Array.from({ length: 12 }, (_, i) => `2025-${String(i + 1).padStart(2, "0")}`);
            const noZero = names.filter((n) => /^2025-[1-9]$/.test(n));
            if (noZero.length)
              return `Есть ${noZero[0]} без ведущего нуля — ls выстроит 2025-1, 2025-10, 2025-11, 2025-12, 2025-2… Удали лишние и создай с нулём: {01..12}.`;
            const extra = names.filter((n) => !want.includes(n));
            if (extra.length) return `Лишнее в /srv/archive: ${extra.join(", ")}.`;
            for (const n of names)
              if (!(await world.info(`/srv/archive/${n}`))?.isDir) return `${n} — файл, а нужен каталог.`;
            if (names.length === 0) return false;
            if (names.length < 12) return `Создано ${names.length} из 12.`;
            return true;
          },
          hint: "Фигурные скобки умеют диапазоны. Ведущий ноль в начале диапазона bash сохранит.",
          solution: "mkdir /srv/archive/2025-{01..12}",
          accept: ["mkdir -p /srv/archive/2025-{01..12}", "cd /srv/archive\nmkdir 2025-{01..12}"],
          reject: ["mkdir /srv/archive/2025-{1..12}"],
          explain:
            "`{01..12}` даёт 01, 02 … 12: если у границы есть ведущий ноль, bash выравнивает все числа. Скобки — не glob: им не нужны существующие файлы, они просто генерируют строки. Без нуля сортировка по имени поставит 2025-10 перед 2025-2.",
        },
        {
          id: "files-2-03",
          type: "choice",
          kind: "predict",
          theory: "glob",
          prompt:
            "Rocky Linux 9, bash 5.1. root хотел отдать alice её скрытые файлы. Что, кроме них, сменит владельца?",
          code: "# cd /home/alice\n# chown -R alice .*",
          options: [
            "Ничего: .* совпадает только со скрытыми файлами",
            "Ещё сам /home/alice: .* включает «.»",
            "Ещё /home целиком, со всеми домашними каталогами",
            "Ничего: chown, как и rm, пропускает «.» и «..»",
          ],
          answer: 2,
          explain:
            "В bash 5.1 `.*` совпадает и с `.`, и с `..`, а `chown -R ..` пройдёт по /home и всем домашним каталогам. Защита от `.`/`..` есть только у rm (`refusing to remove '.' or '..'`). Безопасно: `.[!.]*`, `.??*` или `shopt -s dotglob` и `*`.",
        },
        {
          id: "files-2-04",
          type: "terminal",
          theory: "rm",
          prompt:
            "Загрузчик с багом создал в **~/uploads** файл с именем `-rf`. Удали только его — остальные файлы и каталоги должны остаться.",
          user: "alice",
          cwd: "/home/alice/uploads",
          setup: async (w) => {
            const a = w.user("alice")!;
            await w.mkdir("/home/alice/uploads/old", 0o755, a.uid, a.gid);
            for (const f of ["-rf", "report.pdf", "photo.jpg", "old/a.txt"])
              await w.write(`/home/alice/uploads/${f}`, f === "-rf" ? "" : `${f}\n`, 0o644, a.uid, a.gid);
          },
          check: async ({ world }) => {
            const d = "/home/alice/uploads";
            const lost: string[] = [];
            for (const f of ["report.pdf", "photo.jpg", "old/a.txt"]) if (!(await world.exists(`${d}/${f}`))) lost.push(f);
            const rf = await world.exists(`${d}/-rf`);
            if (lost.length && rf)
              return "Соседи удалены, а -rf остался: * подставил имя -rf в команду, и rm принял его за ключи. Начни заново: имя не должно начинаться с дефиса — ./-rf.";
            if (lost.length) return `-rf удалён, но пропало и это: ${lost.join(", ")}. Начни заново.`;
            return !rf;
          },
          hint: "rm принимает -rf за ключи, кавычки не помогают. Сделай так, чтобы аргумент не начинался с дефиса, или скажи rm, что ключи кончились.",
          solution: "rm ./-rf",
          accept: ["rm -- -rf", "rm /home/alice/uploads/-rf"],
          reject: ["rm *", "rm '-rf'"],
          explain:
            "Кавычки убирает bash — rm всё равно видит `-rf` и считает его ключами. `./-rf` и полный путь не начинаются с дефиса, а `--` объявляет конец ключей. `rm *` здесь — худший вариант: удалит всё, кроме `-rf`.",
        },
        {
          id: "files-2-05",
          type: "terminal",
          theory: "rm",
          prompt:
            "**/srv/ci/work** — рабочий каталог CI-агента (владелец bob, права 2770). Очисти его полностью, но сам каталог не удаляй и не пересоздавай.",
          setup: async (w) => {
            const b = w.user("bob")!;
            await w.mkdir("/srv/ci", 0o755, 0, 0);
            await w.mkdir("/srv/ci/work", 0o2770, b.uid, b.gid);
            await w.mkdir("/srv/ci/work/build", 0o755, b.uid, b.gid);
            await w.mkdir("/srv/ci/work/.cache", 0o755, b.uid, b.gid);
            await w.write("/srv/ci/work/build/out.bin", bytes(800), 0o755, b.uid, b.gid);
            await w.write("/srv/ci/work/.cache/deps.db", bytes(300), 0o644, b.uid, b.gid);
            await w.write("/srv/ci/work/.lock", "4242\n", 0o644, b.uid, b.gid);
            await w.write("/srv/ci/work/log.txt", "build ok\n", 0o644, b.uid, b.gid);
          },
          check: async ({ world }) => {
            const i = await world.info("/srv/ci/work");
            if (!i?.isDir) return "Каталога /srv/ci/work нет — а он должен остаться. Начни заново.";
            if (i.uid !== world.user("bob")!.uid || i.mode !== 0o2770)
              return "Каталог пересоздан: владелец или права уже не те (было bob и 2770). Удаляй содержимое, а не сам каталог.";
            const left = (await ls(world, "/srv/ci/work")) ?? [];
            if (left.length === 0) return true;
            if (left.every((n) => n.startsWith(".")))
              return `Остались скрытые: ${left.join(", ")} — * их не видит. Добавь .[!.]* или включи dotglob.`;
            return false;
          },
          hint: "Удалять нужно содержимое: и обычные, и скрытые имена. Для скрытых — шаблон, который не захватит . и ..",
          solution: "rm -rf /srv/ci/work/* /srv/ci/work/.[!.]*",
          accept: ["cd /srv/ci/work\nrm -rf * .??*", "find /srv/ci/work -mindepth 1 -delete"],
          reject: ["rm -rf /srv/ci/work/*", "rm -rf /srv/ci/work\nmkdir /srv/ci/work"],
          explain:
            "`*` не берёт `.cache` и `.lock`. `.[!.]*` — скрытые без `.` и `..`, `.??*` — скрытые от трёх символов. Пересоздать каталог — значит потерять владельца и setgid (`mkdir` от root даст root и 755). `find -mindepth 1 -delete` чистит всё, не трогая сам каталог.",
        },
        {
          id: "files-2-06",
          type: "choice",
          kind: "predict",
          theory: "rm",
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
            "Строка станет `rm -rf /*`, а `*` (он вне кавычек) раскроется в `/bin /boot /dev /etc …`. --preserve-root защищает только аргумент `/` целиком, а здесь его нет. Пустая переменная не ошибка, `set -u` ловит только незаданные. Защита — `\"${BUILD_DIR:?}\"/*`.",
        },
      ],
    },
  ],
  exam: {
    id: "exam",
    title: "Зачёт",
    exercises: [
      {
        id: "files-exam-01",
        type: "terminal",
        theory: "ls",
        prompt:
          "Место на /var заканчивается. Найди самый большой файл в **/var/log/nginx** (подкаталогов там нет) и запиши его имя в **/root/answer**.",
        setup: async (w) => {
          const logs: [string, number, number][] = [
            ["access.log", 30000, 1],
            ["access.log.1", 52000, 24 * 60],
            ["error.log", 4000, 5],
            ["error.log.1", 900, 24 * 60 + 3],
          ];
          for (const [name, size, min] of logs) {
            await w.write(`/var/log/nginx/${name}`, bytes(size));
            await stamp(w, `/var/log/nginx/${name}`, ago(min));
          }
        },
        check: async ({ world }) => {
          const a = await answer(world);
          if (a === null) return false;
          if (a === "access.log.1" || a === "/var/log/nginx/access.log.1") return true;
          if (a.includes("\n")) return "Нужно одно имя, а в ответе несколько строк.";
          if (a.includes("access.log.1")) return "Файл верный, но в ответе лишнее — нужно только имя.";
          if (/(^|\/)access\.log$/.test(a)) return "access.log — самый свежий (ls -t), а не самый большой. Размер — ls -S.";
          return "Не тот файл. Отсортируй по размеру.";
        },
        hint: "У ls есть сортировка по размеру — большие сверху.",
        solution: "ls -S /var/log/nginx | head -1 > /root/answer",
        accept: ["ls -Sr /var/log/nginx | tail -1 > /root/answer", "echo access.log.1 > /root/answer"],
        reject: ["ls -t /var/log/nginx | head -1 > /root/answer"],
        explain: "`ls -S` — по размеру, большие сверху. Самым большим часто оказывается вчерашняя ротация, а не текущий лог — поэтому смотреть надо, а не угадывать.",
      },
      {
        id: "files-exam-02",
        type: "terminal",
        theory: "cp",
        prompt:
          "Перед правкой обнови резервную копию **/etc/nginx** в **/root/nginx.bak** — она уже есть, вчерашняя. В итоге /root/nginx.bak должен повторять текущий /etc/nginx.",
        setup: async (w) => {
          await w.write("/etc/nginx/nginx.conf", "worker_processes 4;\n");
          await w.write("/etc/nginx/conf.d/site.conf", "server { listen 443 ssl; }\n");
          await w.write("/root/nginx.bak/nginx.conf", "worker_processes 2;\n");
          await w.write("/root/nginx.bak/conf.d/site.conf", "server { listen 80; }\n");
        },
        check: async ({ world }) => {
          if (await world.exists("/root/nginx.bak/nginx"))
            return "Получился /root/nginx.bak/nginx: cp -r в существующий каталог кладёт источник внутрь. Убери его и копируй содержимое.";
          if (await world.exists("/root/nginx")) return "Копия легла в /root/nginx, а нужна /root/nginx.bak.";
          const main = await world.read("/root/nginx.bak/nginx.conf");
          const site = await world.read("/root/nginx.bak/conf.d/site.conf");
          if (main === "worker_processes 4;\n" && site === "server { listen 443 ssl; }\n") return true;
          if (main === "worker_processes 4;\n") return "nginx.conf свежий, а conf.d/site.conf — нет. Копируй рекурсивно.";
          return false;
        },
        hint: "Цель уже существует — значит, cp -r положит каталог внутрь неё. Копируй содержимое: точка после слеша.",
        solution: "cp -r /etc/nginx/. /root/nginx.bak/",
        accept: ["rm -rf /root/nginx.bak\ncp -r /etc/nginx /root/nginx.bak"],
        reject: ["cp -r /etc/nginx /root/nginx.bak"],
        explain: "Если /root/nginx.bak существует, `cp -r /etc/nginx /root/nginx.bak` создаст /root/nginx.bak/nginx, а старые файлы останутся. `/etc/nginx/.` — содержимое каталога вместе со скрытыми.",
      },
      {
        id: "files-exam-03",
        type: "terminal",
        theory: "glob",
        prompt:
          "Скрипт с ошибкой в кавычках создал в **/srv/reports** файл с именем `*`. Удали его, отчёты не трогай.",
        setup: async (w) => {
          for (const f of ["*", "2025-09.csv", "2025-10.csv", "summary.txt"]) await w.write(`/srv/reports/${f}`, f === "*" ? "" : `${f}\n`);
        },
        check: async ({ world }) => {
          const left = await ls(world, "/srv/reports");
          if (!left) return "Каталог /srv/reports пропал. Начни заново.";
          const lost = ["2025-09.csv", "2025-10.csv", "summary.txt"].filter((f) => !left.includes(f));
          if (lost.length) return "Удалились и отчёты: без кавычек * — это все файлы каталога. Начни заново и экранируй звёздочку.";
          return !left.includes("*");
        },
        hint: "Без кавычек * раскроется во все файлы. Сделай звёздочку обычным символом.",
        solution: "rm '/srv/reports/*'",
        accept: ["cd /srv/reports\nrm \\*", "rm -- \"/srv/reports/*\""],
        reject: ["rm /srv/reports/*"],
        explain: "В одинарных, двойных кавычках или после `\\` glob не работает — rm получает имя `*` буквально. Без них `*` раскроется в список всех файлов каталога.",
      },
      {
        id: "files-exam-04",
        type: "terminal",
        theory: "glob",
        prompt:
          "Сайт переезжает: перенеси всё содержимое **/srv/old** в **/srv/new** — до последнего файла. Сам /srv/old оставь пустым: на него ещё смотрит старый конфиг.",
        setup: async (w) => {
          await w.write("/srv/old/index.html", "<h1>hi</h1>\n");
          await w.write("/srv/old/img/logo.png", "PNG\n");
          await w.write("/srv/old/.htaccess", "Deny from all\n");
          await w.write("/srv/old/.well-known/acme.txt", "token\n");
          await w.mkdir("/srv/new", 0o755, 0, 0);
        },
        check: async ({ world }) => {
          if (!(await world.info("/srv/old"))?.isDir) return "/srv/old пропал, а он должен остаться (пустым). Начни заново.";
          if (await world.exists("/srv/new/old"))
            return "Получился /srv/new/old: mv каталога в существующий каталог кладёт его внутрь. Переносить нужно содержимое.";
          const need = ["index.html", "img/logo.png", ".htaccess", ".well-known/acme.txt"];
          const moved: string[] = [];
          for (const f of need) if (await world.exists(`/srv/new/${f}`)) moved.push(f);
          const left = (await ls(world, "/srv/old")) ?? [];
          if (moved.length === need.length && left.length === 0) return true;
          if (left.length && left.every((n) => n.startsWith(".")) && moved.includes("index.html"))
            return `В /srv/old остались скрытые: ${left.join(", ")} — * их не видит.`;
          return false;
        },
        hint: "* не захватит .htaccess и .well-known. Добавь шаблон для скрытых, который не совпадёт с . и ..",
        solution: "mv /srv/old/* /srv/old/.[!.]* /srv/new/",
        accept: ["shopt -s dotglob\nmv /srv/old/* /srv/new/", "cd /srv/old\nmv * .??* /srv/new/"],
        reject: ["mv /srv/old/* /srv/new/", "mv /srv/old /srv/new"],
        explain:
          "`*` не видит имена на точку, поэтому нужен второй шаблон `.[!.]*` (или `shopt -s dotglob`). `mv /srv/old /srv/new` при существующем /srv/new положит каталог внутрь — получится /srv/new/old.",
      },
    ],
  },
};
