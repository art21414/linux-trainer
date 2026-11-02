import type { Topic } from "../../types";
import type { World } from "../../../engine/world";
import theoryMd from "./theory.md?raw";

const oct = (m: number) => (m & 0o7777).toString(8).padStart(4, "0");

/** Добавить пользователей в (новую) группу и обновить /etc/group. */
async function groupWith(w: World, name: string, members: string[]) {
  const g = w.group(name) ?? w.addGroup(name);
  for (const m of members) w.user(m)!.groups.push(name);
  await w.syncEtc();
  return g;
}

/** Права всех объектов дерева: каталогам и файлам — свои ожидания. */
async function treeModes(w: World, root: string, dirMode: number, fileMode: number, skip: string[] = []) {
  let badDir = 0;
  let execFile = 0;
  let badFile = 0;
  for (const p of w.subtree(root)) {
    if (skip.includes(p)) continue;
    const i = (await w.info(p))!;
    const m = i.mode & 0o7777;
    if (i.isDir) badDir += m === dirMode ? 0 : 1;
    else if (m & 0o111) execFile++;
    else if (m !== fileMode) badFile++;
  }
  return { badDir, execFile, badFile, count: w.subtree(root).length };
}

const BASHRC = "# .bashrc\n\n# Source global definitions\nif [ -f /etc/bashrc ]; then\n    . /etc/bashrc\nfi\n\n# User specific aliases and functions\n";
const BASH_PROFILE = "# .bash_profile\n\n# Get the aliases and functions\nif [ -f ~/.bashrc ]; then\n\t. ~/.bashrc\nfi\n\n# User specific environment and startup programs\n";

export const permissions: Topic = {
  id: "perm",
  n: 2,
  title: "Права: rwx, umask, SUID/SGID/sticky",
  summary: "Каталоги, чья тройка срабатывает, X, umask, спецбиты",
  level: "base",
  theory: theoryMd,
  sets: [
    {
      id: "1",
      title: "Каталоги и чья тройка",
      exercises: [
        {
          id: "perm-1-01",
          type: "terminal",
          theory: "dir",
          prompt:
            "Аналитики (группа **analysts**, в ней bob) жалуются: `ls /srv/reports` показывает имена отчётов, а открыть ни один нельзя — Permission denied. Почини: analysts должны видеть список и читать отчёты, но не создавать и не удалять файлы. Остальным доступа не давай.",
          setup: async (w) => {
            const g = await groupWith(w, "analysts", ["bob"]);
            await w.mkdir("/srv/reports", 0o740, 0, g.gid);
            await w.write("/srv/reports/q3.csv", "month,revenue\n09,120\n", 0o644, 0, 0);
            await w.write("/srv/reports/q4.csv", "month,revenue\n12,140\n", 0o644, 0, 0);
          },
          check: async ({ world }) => {
            const bob = world.user("bob")!;
            const nobody = world.user("nobody")!;
            const f = "/srv/reports/q3.csv";
            if (!(await world.exists(f))) return "Отчёты пропали. Начни заново.";
            if (await world.canAccess(f, "r", nobody)) return "Отчёты теперь читает любой пользователь. Доступ нужен только analysts.";
            if (await world.canModifyDir("/srv/reports", bob)) return "Читать bob может, но и удалять отчёты тоже: у группы лишний w.";
            if (!(await world.canAccess(f, "r", bob))) return false;
            if (!(await world.canAccess("/srv/reports", "r", bob))) return "Файлы bob открывает, но список больше не видит — верни группе r.";
            return true;
          },
          hint: "Имена видно — значит, r у группы есть. Какого бита не хватает, чтобы пройти внутрь?",
          solution: "chmod g+x /srv/reports",
          accept: ["chmod 750 /srv/reports", "chmod g=rx /srv/reports"],
          reject: ["chmod 755 /srv/reports", "chmod 770 /srv/reports"],
          explain:
            "`r` на каталоге — только список имён. Открыть файл, сделать `stat` или `cd` можно лишь с `x`. Отсюда `ls` работает, а `ls -l` показывает `-?????????`. Нужен `g+x` (итог 750); `755` пустил бы всех, `770` разрешил бы группе удалять отчёты.",
        },
        {
          id: "perm-1-02",
          type: "terminal",
          theory: "dir",
          user: "alice",
          prompt:
            "Ты — alice. Скрипт bob забирает твою страницу **~/site/index.html** и должен её читать. Но видеть, что ещё лежит у тебя в домашнем каталоге, bob не должен. Настрой права.",
          setup: async (w) => {
            const a = w.user("alice")!;
            await w.mkdir("/home/alice/site", 0o755, a.uid, a.gid);
            await w.write("/home/alice/site/index.html", "<h1>hi</h1>\n", 0o644, a.uid, a.gid);
            await w.write("/home/alice/salary-2026.txt", "alice 250000\n", 0o600, a.uid, a.gid);
          },
          check: async ({ world }) => {
            const bob = world.user("bob")!;
            const page = "/home/alice/site/index.html";
            if (!(await world.exists(page))) return "Страница пропала. Начни заново.";
            if (await world.canModifyDir("/home/alice", bob)) return "bob теперь может создавать и удалять файлы в твоём домашнем каталоге. Убери w.";
            const read = await world.canAccess(page, "r", bob);
            if (read && (await world.canAccess("/home/alice", "r", bob)))
              return "Страницу bob читает, но и список твоих файлов видит тоже. Ему нужен только «проход».";
            return read;
          },
          hint: "Чтобы открыть файл по известному пути, список каталога не нужен. Хватит одного бита.",
          solution: "chmod o+x ~",
          accept: ["chmod 711 ~", "chmod 701 /home/alice"],
          reject: ["chmod 755 ~"],
          explain:
            "`x` без `r` на каталоге — проход вслепую: `cat ~alice/site/index.html` работает, `ls ~alice` — `Permission denied`. Так обычно открывают веб-серверу `~/public_html`. `755` показал бы всем список файлов домашнего каталога.",
        },
        {
          id: "perm-1-03",
          type: "choice",
          kind: "predict",
          theory: "dir",
          prompt: "alice в терминале удаляет дамп, который root оставил в её домашнем каталоге. Что будет?",
          code:
            "$ ls -ld ~ ~/dump.core\ndrwx------. 3 alice alice 92 Nov  2 10:00 /home/alice\n-rw-------. 1 root  root   5 Nov  2 09:58 /home/alice/dump.core\n$ rm ~/dump.core",
          options: [
            "rm: remove write-protected regular file '/home/alice/dump.core'? — после y файл удалён",
            "rm: cannot remove '/home/alice/dump.core': Permission denied",
            "rm: cannot remove '/home/alice/dump.core': Operation not permitted",
            "rm: remove write-protected regular file '/home/alice/dump.core'? — после y: Permission denied",
          ],
          answer: 0,
          explain:
            "Удаление меняет каталог, а не файл: у alice есть `w` и `x` на `/home/alice`, этого достаточно. Права файла влияют только на вопрос: писать в файл нельзя, и `rm` переспрашивает (если stdin — терминал). `Permission denied` был бы без `w` на каталог, `Operation not permitted` — при sticky-бите.",
        },
        {
          id: "perm-1-04",
          type: "terminal",
          theory: "order",
          user: "alice",
          prompt:
            "Ты — alice, состоишь в группе **dev**. Дописать в свой файл **/srv/shared/todo.txt** не получается — Permission denied, хотя у группы dev на нём есть rw. Почини: тебе и группе — чтение и запись, остальным — только чтение.",
          setup: async (w) => {
            const g = await groupWith(w, "dev", ["alice"]);
            const a = w.user("alice")!;
            await w.mkdir("/srv/shared", 0o755, 0, 0);
            await w.write("/srv/shared/todo.txt", "- обновить ядро\n", 0o464, a.uid, g.gid);
          },
          check: async ({ world }) => {
            const i = await world.info("/srv/shared/todo.txt");
            if (!i) return "Файл пропал. Начни заново.";
            const m = i.mode & 0o7777;
            if (!(m & 0o200)) return false;
            if (m & 0o002) return "Писать теперь могут все. Остальным — только чтение.";
            if ((m & 0o060) !== 0o060) return "Группе dev нужны чтение и запись — не отбирай их.";
            if ((m & 0o007) !== 0o004) return "Остальным оставь чтение.";
            return m === 0o664 ? true : `Сейчас ${m.toString(8)}, а нужно rw-rw-r-- (664).`;
          },
          hint: "Посмотри `ls -l` и вспомни, какую тройку ядро применяет к владельцу.",
          solution: "chmod u+w /srv/shared/todo.txt",
          accept: ["chmod 664 /srv/shared/todo.txt", "chmod u=rw /srv/shared/todo.txt"],
          reject: ["chmod 666 /srv/shared/todo.txt"],
          explain:
            "Проверяется одна тройка — первая подходящая. alice владелец → её права `r--`, и до группы дело не доходит, хотя alice в dev. Права не складываются. Лечится `u+w`.",
        },
        {
          id: "perm-1-05",
          type: "choice",
          kind: "predict",
          theory: "order",
          prompt: "Это bob. Что выведет последняя команда?",
          code:
            "$ id\nuid=1001(bob) gid=1001(bob) groups=1001(bob),1005(contractors)\n$ ls -l /srv/app/app.conf\n-rw----r--. 1 root contractors 10 Nov  2 10:00 /srv/app/app.conf\n$ cat /srv/app/app.conf",
          options: [
            "cat: /srv/app/app.conf: Permission denied",
            "Содержимое файла: bob не владелец, ему достаются права остальных r--",
            "Содержимое файла: права группы и остальных объединяются",
            "cat: /srv/app/app.conf: Operation not permitted",
          ],
          answer: 0,
          explain:
            "bob не владелец, но его группа совпала с группой файла — применяется тройка группы `---`, и проверка заканчивается. До `r--` остальных дело не доходит: посторонний файл прочитает, а bob — нет. `Operation not permitted` — это EPERM (sticky, chmod чужого файла), а не нехватка rwx.",
        },
        {
          id: "perm-1-06",
          type: "terminal",
          theory: "chmod",
          prompt:
            "Коллега «чинил» сайт командой `chmod -R 755 /srv/www` — теперь все HTML, CSS и картинки исполняемые. Верни как положено: каталоги — 755, файлы — 644. Желательно одной командой.",
          setup: async (w) => {
            for (const d of ["/srv/www", "/srv/www/css", "/srv/www/img"]) await w.mkdir(d, 0o755, 0, 0);
            await w.write("/srv/www/index.html", "<h1>ok</h1>\n", 0o755, 0, 0);
            await w.write("/srv/www/css/site.css", "body { margin: 0 }\n", 0o755, 0, 0);
            await w.write("/srv/www/img/logo.png", "PNG\n", 0o755, 0, 0);
          },
          check: async ({ world }) => {
            const t = await treeModes(world, "/srv/www", 0o755, 0o644);
            if (t.count < 6) return "Часть сайта пропала. Начни заново.";
            if (t.badDir) return "У каталогов сломались права: им нужен 755, иначе в них не зайти.";
            if (t.execFile) return "Файлы всё ещё исполняемые. X оставляет x, если он уже есть, — сначала сними x у всех.";
            if (t.badFile) return "x у файлов снят, но права не 644.";
            return true;
          },
          hint: "Заглавная X даёт x каталогам — и файлам, у которых x уже есть. Значит, у файлов x сначала надо снять.",
          solution: "chmod -R a-x,a+X /srv/www",
          accept: ["chmod -R a-x+X /srv/www", "find /srv/www -type f -exec chmod 644 {} +"],
          reject: ["chmod -R u=rwX,go=rX /srv/www", "chmod -R 644 /srv/www"],
          explain:
            "`a-x,a+X`: первый пункт снимает x у всего, второй возвращает его только каталогам — у файлов x уже нет. `u=rwX,go=rX` не помогает: X видит x, оставленный `755`. Без X: `find /srv/www -type f -exec chmod 644 {} +`.",
        },
      ],
    },
    {
      id: "2",
      title: "umask и спецбиты",
      exercises: [
        {
          id: "perm-2-01",
          type: "choice",
          kind: "predict",
          theory: "umask",
          prompt: "Что выведет stat?",
          code: "$ umask 033\n$ touch f; mkdir d\n$ stat -c '%a %A %n' f d",
          options: [
            "633 -rw--wx-wx f / 744 drwxr--r-- d",
            "644 -rw-r--r-- f / 744 drwxr--r-- d",
            "644 -rw-r--r-- f / 755 drwxr-xr-x d",
            "744 -rwxr--r-- f / 744 drwxr--r-- d",
          ],
          answer: 1,
          explain:
            "umask не вычитается, а снимает биты: 666 AND NOT 033 = 644 (x у файла не было — снимать нечего), 777 AND NOT 033 = 744. «666 − 033 = 633» — частая ошибка: вышла бы запись для группы и остальных. А x новый файл от umask не получает никогда.",
        },
        {
          id: "perm-2-02",
          type: "terminal",
          theory: "umask",
          user: "alice",
          prompt:
            "Ты — alice. Отчёты должна читать твоя группа, но не остальные. Выстави в этой сессии umask так, чтобы новые файлы сразу получались `rw-r-----`, а каталоги — `rwxr-x---`, и создай каталог **~/reports** с файлом **~/reports/q4.txt**. Без chmod.",
          check: async ({ world }) => {
            const d = await world.info("/home/alice/reports");
            const f = await world.info("/home/alice/reports/q4.txt");
            const um = world.umask;
            if (um === 0o750 || um === 0o640) return `umask ${oct(um)} — это маска запрещённых битов, а не права. Посчитай, что надо запретить.`;
            if (!d || !f) return false;
            if (um !== 0o027)
              return `Сейчас umask ${oct(um)}: файлы получат ${(0o666 & ~um).toString(8)}, каталоги — ${(0o777 & ~um).toString(8)}.`;
            if ((d.mode & 0o777) !== 0o750 || (f.mode & 0o777) !== 0o640)
              return "umask верный, но каталог или файл созданы до его смены. Удали их и создай заново.";
            return true;
          },
          hint: "Права = база (666 у файлов, 777 у каталогов) без битов umask. Что запретить группе и что — остальным?",
          solution: "umask 027\nmkdir ~/reports\ntouch ~/reports/q4.txt",
          accept: ["umask u=rwx,g=rx,o=\nmkdir ~/reports && touch ~/reports/q4.txt", "umask 0027; mkdir -p ~/reports; touch ~/reports/q4.txt"],
          reject: ["umask 026\nmkdir ~/reports\ntouch ~/reports/q4.txt", "umask 750\nmkdir ~/reports\ntouch ~/reports/q4.txt"],
          explain:
            "`umask 027`: группе запрещена запись (2), остальным — всё (7). Файлы: 666 → 640, каталоги: 777 → 750. Символьно — `umask u=rwx,g=rx,o=` (задаёт разрешённое). `026` оставил бы остальным x на каталогах. Закроешь сессию — вернётся 0022.",
        },
        {
          id: "perm-2-03",
          type: "terminal",
          theory: "special",
          prompt:
            "Команде **devs** (alice, bob) нужен общий каталог **/srv/team**: участники создают в нём файлы, всё новое внутри автоматически получает группу devs, а не личную группу автора. Остальным — никакого доступа. Создай и настрой.",
          setup: async (w) => {
            await groupWith(w, "devs", ["alice", "bob"]);
          },
          check: async ({ world }) => {
            const i = await world.info("/srv/team");
            if (!i || !i.isDir) return false;
            const m = i.mode;
            if (i.gid !== world.group("devs")!.gid) return "Группа каталога пока не devs.";
            if ((m & 0o070) !== 0o070) return "Группе devs нужны rwx: заходить и создавать файлы.";
            if (m & 0o007) return "Остальным доступ не нужен.";
            if (!(m & 0o2000)) return "Почти: без SGID файл alice получит группу alice, а не devs. Нужен g+s.";
            return true;
          },
          hint: "Создать, отдать группе devs, выставить права. Какой спецбит заставляет новые файлы брать группу каталога?",
          solution: "mkdir /srv/team\nchgrp devs /srv/team\nchmod 2770 /srv/team",
          accept: [
            "mkdir -p /srv/team && chown root:devs /srv/team && chmod u=rwx,g=rwxs,o= /srv/team",
            "mkdir /srv/team\nchgrp devs /srv/team\nchmod 3770 /srv/team",
          ],
          reject: ["mkdir /srv/team\nchgrp devs /srv/team\nchmod 770 /srv/team", "mkdir /srv/team\nchgrp devs /srv/team\nchmod 2777 /srv/team"],
          explain:
            "SGID на каталоге (`2` в старшей цифре, `g+s`): новое внутри получает группу каталога, подкаталоги — и сам бит. Без него у файла alice будет группа alice. SGID даёт группу, но не права: при umask 0022 коллега файл прочитает, но не изменит. Sticky сверху (3770) запретит удалять чужое.",
        },
        {
          id: "perm-2-04",
          type: "terminal",
          theory: "special",
          prompt:
            "Тестировщики (группа **qa**, в ней bob) не могут зайти в **/srv/qa** — Permission denied. `ls -ld` показывает: `drwxrwSr-x. 2 root qa 6 Nov  2 10:00 /srv/qa`. Почини, сохранив наследование группы для новых файлов.",
          setup: async (w) => {
            const g = await groupWith(w, "qa", ["bob"]);
            await w.mkdir("/srv/qa", 0o2765, 0, g.gid);
          },
          check: async ({ world }) => {
            const i = await world.info("/srv/qa");
            if (!i) return "Каталог пропал. Начни заново.";
            const m = i.mode & 0o7777;
            if (i.gid !== world.group("qa")!.gid) return "Группа каталога должна остаться qa.";
            if (!(m & 0o010)) return false;
            if (!(m & 0o2000)) return "Войти теперь можно, но SGID пропал — новые файлы получат личную группу автора. Верни g+s.";
            return m === 0o2775 ? true : `Сейчас ${m.toString(8)}. Нужно было только вернуть группе x, остальное не трогай.`;
          },
          hint: "Заглавная S в тройке группы: SGID стоит, а x — нет.",
          solution: "chmod g+x /srv/qa",
          accept: ["chmod 2775 /srv/qa", "chmod 775 /srv/qa"],
          reject: ["chmod 00775 /srv/qa", "chmod g-s,g+x /srv/qa"],
          explain:
            "`S` = SGID без x, а без x группа не войдёт. `g+x` даёт `drwxrwsr-x` (2775). Сработал бы и `chmod 775`: на каталоге числовой chmod SGID не снимает. А `00775` или `g-s` снимут — и файлы перестанут наследовать группу qa.",
        },
        {
          id: "perm-2-05",
          type: "terminal",
          theory: "special",
          user: "alice",
          prompt:
            "Ты — alice (в группе wheel). Сборка падает: мешает **/tmp/app.lock**. Его оставил bob, процесс давно умер. `rm` отказывает, хотя /tmp открыт всем на запись. Убери lock-файл. Права /tmp и другие чужие файлы в нём не трогай.",
          setup: async (w) => {
            const b = w.user("bob")!;
            await w.write("/tmp/app.lock", "4242\n", 0o644, b.uid, b.gid);
            await w.write("/tmp/bob-cache.db", "cache\n", 0o600, b.uid, b.gid);
          },
          check: async ({ world }) => {
            const t = await world.info("/tmp");
            if (!t) return "/tmp пропал. Начни заново.";
            if (!(await world.exists("/tmp/bob-cache.db"))) return "Удалён чужой файл, который не просили: /tmp/bob-cache.db.";
            const gone = !(await world.exists("/tmp/app.lock"));
            if ((t.mode & 0o7777) !== 0o1777)
              return gone ? "Lock удалён, но права /tmp изменены: без sticky любой удалит чужие файлы. Верни 1777." : "Права /tmp изменены — верни 1777.";
            return gone;
          },
          hint: "На /tmp стоит sticky (t в конце drwxrwxrwt). Кто, кроме владельца файла, может удалять в таком каталоге?",
          solution: "sudo rm /tmp/app.lock",
          accept: ["sudo rm -f /tmp/app.lock"],
          reject: ["rm -f /tmp/app.lock", "sudo chmod 777 /tmp\nrm /tmp/app.lock"],
          explain:
            "Sticky: в каталоге удалить или переименовать файл может только его владелец, владелец каталога или root — `w` на каталог не помогает. Ошибка при этом — `Operation not permitted`, а не `Permission denied`. Правильно — удалить от root. Снять sticky с /tmp — дыра: любой сможет удалять и подменять чужие файлы.",
        },
        {
          id: "perm-2-06",
          type: "terminal",
          theory: "special",
          prompt:
            "Сканер безопасности ругается: в **/usr/local/bin** у одного файла стоит SUID root, который ему не нужен. Найди его и сними **только SUID**, остальные права не меняй. У одного файла там намеренно стоит SGID — его не трогай.",
          setup: async (w) => {
            const g = w.addGroup("lock");
            await w.syncEtc();
            const files: [string, number, number][] = [
              ["backup-db", 0o755, 0],
              ["deploy", 0o750, 0],
              ["healthcheck", 0o755, 0],
              ["lockrun", 0o2755, g.gid],
              ["report-gen", 0o4755, 0],
            ];
            for (const [n, m, gid] of files) await w.write(`/usr/local/bin/${n}`, "\u007fELF\n", m, 0, gid);
          },
          check: async ({ world }) => {
            const want: Record<string, number> = {
              "backup-db": 0o755,
              deploy: 0o750,
              healthcheck: 0o755,
              lockrun: 0o2755,
              "report-gen": 0o755,
            };
            const modes: Record<string, number> = {};
            for (const n of Object.keys(want)) {
              const i = await world.info(`/usr/local/bin/${n}`);
              if (!i) return `Файл ${n} пропал. Начни заново.`;
              modes[n] = i.mode & 0o7777;
            }
            if (modes.lockrun !== 0o2755) return "SGID у lockrun был нужен — ты его задел. Снимай только SUID (u-s).";
            if (modes["report-gen"] & 0o4000) return false;
            if (modes["report-gen"] !== 0o755) return `SUID снят, но поменялись и другие права report-gen: сейчас ${modes["report-gen"].toString(8)}, было 4755.`;
            for (const n of Object.keys(want)) if (modes[n] !== want[n]) return `Права ${n} изменились — их трогать не нужно.`;
            return true;
          },
          hint: "ls -l /usr/local/bin: ищи s на месте x владельца (rws). s в тройке группы — это SGID.",
          solution: "chmod u-s /usr/local/bin/report-gen",
          accept: ["chmod 755 /usr/local/bin/report-gen", "chmod u-s /usr/local/bin/*"],
          reject: ["chmod -s /usr/local/bin/*", "chmod 644 /usr/local/bin/report-gen"],
          explain:
            "SUID — `s` в тройке владельца: `-rwsr-xr-x`. `u-s` снимает только его. `chmod -s` без «кому» снимает и SUID, и SGID — задел бы lockrun. На обычном файле `chmod 755` тоже сбрасывает SUID: числом спецбиты сохраняются только у каталогов. По всему диску ищут так: `find / -perm -4000 -type f`.",
        },
      ],
    },
  ],
  exam: {
    id: "exam",
    title: "Зачёт: права",
    exercises: [
      {
        id: "perm-exam-01",
        type: "terminal",
        theory: "special",
        prompt:
          "Стажёр настроил каталог проекта и оставил вот это: `drwxrwS--T. 2 root root 6 Nov  2 10:00 /srv/proj`. Нужно: группа **devs**; участники заходят и создают файлы; новые файлы получают группу devs; удалять чужие файлы участники не могут; остальным — ничего. Почини.",
        setup: async (w) => {
          await groupWith(w, "devs", ["alice", "bob"]);
          await w.mkdir("/srv/proj", 0o3760, 0, 0);
        },
        check: async ({ world }) => {
          const i = await world.info("/srv/proj");
          if (!i) return "Каталог пропал. Начни заново.";
          const m = i.mode & 0o7777;
          const devs = world.group("devs")!.gid;
          if (m === 0o3770 && i.gid === devs) return true;
          if (i.gid !== devs) return m === 0o3760 ? false : "Права меняются, но группа каталога всё ещё не devs.";
          if ((m & 0o070) !== 0o070) return "Группа devs, но войти она не может: S — это SGID без x.";
          if (!(m & 0o2000)) return "SGID пропал — новые файлы не получат группу devs.";
          if (!(m & 0o1000)) return "Sticky пропал — участники смогут удалять чужие файлы. Трёхзначный chmod его снимает.";
          if (m & 0o007) return "Остальным доступ не нужен.";
          return `Сейчас ${m.toString(8)}, нужно 3770.`;
        },
        hint: "Разбери буквы: S — SGID без x, T — sticky без x у остальных. Плюс группа.",
        solution: "chgrp devs /srv/proj\nchmod g+x /srv/proj",
        accept: ["chown :devs /srv/proj && chmod 3770 /srv/proj"],
        reject: ["chgrp devs /srv/proj\nchmod 770 /srv/proj"],
        explain:
          "`S` в группе — SGID без x: группа не войдёт. `T` — sticky при остальных без x, и здесь это норма: остальным ничего не нужно. Достаточно сменить группу и добавить `g+x` → `drwxrws--T` (3770). Ловушка: `chmod 770` оставит SGID (каталог!), но снимет sticky.",
      },
      {
        id: "perm-exam-02",
        type: "terminal",
        theory: "chmod",
        prompt:
          "После `chmod -R 777 /srv/docs` наведи порядок: каталоги — 750, файлы — 640. Исключение — скрипт **/srv/docs/tools/build.sh**: он должен остаться исполняемым (750).",
        setup: async (w) => {
          for (const d of ["/srv/docs", "/srv/docs/guides", "/srv/docs/tools"]) await w.mkdir(d, 0o777, 0, 0);
          await w.write("/srv/docs/README.md", "# docs\n", 0o777, 0, 0);
          await w.write("/srv/docs/guides/setup.md", "## setup\n", 0o777, 0, 0);
          await w.write("/srv/docs/tools/build.sh", "#!/bin/bash\nmake html\n", 0o777, 0, 0);
        },
        check: async ({ world }) => {
          const sh = "/srv/docs/tools/build.sh";
          const t = await treeModes(world, "/srv/docs", 0o750, 0o640, [sh]);
          const s = await world.info(sh);
          if (t.count < 6 || !s) return "Часть файлов пропала. Начни заново.";
          if (t.badDir) return "Не все каталоги 750.";
          if (t.execFile) return "Обычные файлы всё ещё исполняемые: X не снимает x, который уже стоит.";
          if (t.badFile) return "x у файлов снят, но права не 640.";
          const m = s.mode & 0o7777;
          if (m !== 0o750) return m & 0o100 ? `build.sh: сейчас ${m.toString(8)}, нужно 750.` : "Остальное в порядке, но build.sh перестал запускаться — верни ему 750.";
          return true;
        },
        hint: "Сначала сними x у всего, потом верни его каталогам через X — и отдельно скрипту.",
        solution: "chmod -R a-x,u=rwX,g=rX,o= /srv/docs\nchmod 750 /srv/docs/tools/build.sh",
        accept: [
          "chmod -R u=rw,g=r,o=,ug+X /srv/docs && chmod ug+x /srv/docs/tools/build.sh",
          "find /srv/docs -type d -exec chmod 750 {} +\nfind /srv/docs -type f -exec chmod 640 {} +\nchmod 750 /srv/docs/tools/build.sh",
        ],
        reject: ["chmod -R u=rwX,g=rX,o= /srv/docs", "chmod -R a-x,u=rwX,g=rX,o= /srv/docs"],
        explain:
          "`u=rwX,g=rX,o=` на файлах с 777 оставит x: X видит, что x уже есть. Рабочие варианты — `a-x,u=rwX,g=rX,o=` или `u=rw,g=r,o=,ug+X`: сначала обнулить x, потом X. Скрипту — отдельный `chmod 750`. Через find: `-type d` и `-type f` по отдельности.",
      },
      {
        id: "perm-exam-03",
        type: "terminal",
        theory: "umask",
        user: "alice",
        prompt:
          "Ты — alice. Сделай так, чтобы **при каждом входе** на сервер твои новые файлы создавались `rw-r-----`, а каталоги — `rwxr-x---`.",
        setup: async (w) => {
          const a = w.user("alice")!;
          await w.write("/home/alice/.bashrc", BASHRC, 0o644, a.uid, a.gid);
          await w.write("/home/alice/.bash_profile", BASH_PROFILE, 0o644, a.uid, a.gid);
        },
        check: async ({ world }) => {
          const rc = (await world.read("/home/alice/.bashrc")) ?? "";
          const prof = (await world.read("/home/alice/.bash_profile")) ?? "";
          if (!rc.includes("/etc/bashrc")) return "~/.bashrc затёрт (`>` вместо `>>`): пропало подключение /etc/bashrc. Начни заново и дописывай через >>.";
          if (!prof.includes(".bashrc")) return "~/.bash_profile затёрт: он больше не подключает ~/.bashrc. Начни заново и дописывай через >>.";
          const vals = [...`${rc}\n${prof}`.matchAll(/^\s*umask\s+(\S+)\s*$/gm)].map((x) => x[1]);
          const last = vals[vals.length - 1];
          if (last !== undefined) {
            if (/^0{0,2}27$/.test(last) || last === "u=rwx,g=rx,o=") return true;
            return `В файле umask ${last}. Это маска запрещённых битов, а не права: что запретить группе и остальным?`;
          }
          if (world.umask === 0o027) return "В этой сессии работает, но после перелогина снова будет 0022. Пропиши umask в ~/.bashrc.";
          return false;
        },
        hint: "Команда umask живёт до выхода из сессии. Какой файл bash читает при каждом входе? И не перепутай > с >>.",
        solution: "echo 'umask 027' >> ~/.bashrc",
        accept: ['echo "umask 0027" >> ~/.bash_profile', "echo 'umask u=rwx,g=rx,o=' >> ~/.bashrc"],
        reject: ["umask 027", "echo 'umask 750' >> ~/.bashrc"],
        explain:
          "При входе по ssh bash читает `~/.bash_profile`, а тот подключает `~/.bashrc` — строка `umask 027` в любом из них сработает. 027 — маска: группе запретить w, остальным всё. Дописывать только через `>>`: `>` затрёт файл вместе с подключением /etc/bashrc.",
      },
      {
        id: "perm-exam-04",
        type: "terminal",
        theory: "dir",
        prompt:
          "bob (группа **qa**) должен **читать** лог **/srv/qa/logs/app.log** — сейчас Permission denied. Найди все причины и почини. Писать qa не должна ни в лог, ни в каталог; остальным — никакого доступа.",
        setup: async (w) => {
          const g = await groupWith(w, "qa", ["bob"]);
          await w.mkdir("/srv/qa", 0o750, 0, g.gid);
          await w.mkdir("/srv/qa/logs", 0o740, 0, g.gid);
          await w.write("/srv/qa/logs/app.log", "INFO started\n", 0o600, 0, 0);
        },
        check: async ({ world }) => {
          const bob = world.user("bob")!;
          const nobody = world.user("nobody")!;
          const log = "/srv/qa/logs/app.log";
          const f = await world.info(log);
          if (!f) return "Лог пропал. Начни заново.";
          if (f.mode & 0o007 || (await world.canAccess(log, "r", nobody))) return "Лог открыт остальным. Доступ нужен только qa.";
          if (await world.canAccess(log, "w", bob)) return "bob теперь может писать в лог — это лишнее.";
          if (await world.canModifyDir("/srv/qa/logs", bob)) return "qa теперь может создавать и удалять файлы в logs — это лишнее.";
          const pathOk = await world.canAccess("/srv/qa/logs", "x", bob);
          const fileOk = world.permOn(f, "r", bob);
          if (pathOk && fileOk) return true;
          if (!pathOk && !fileOk) return false;
          if (!pathOk) return "Сам лог bob прочитал бы, но в каталог logs ему не пройти: у группы r без x.";
          return "До лога bob уже доходит, но сам файл ему не прочитать: посмотри владельца, группу и права app.log.";
        },
        hint: "Проверь весь путь: каждому каталогу нужен x для qa. И посмотри, кому принадлежит сам лог.",
        solution: "chmod g+x /srv/qa/logs\nchgrp qa /srv/qa/logs/app.log\nchmod g+r /srv/qa/logs/app.log",
        accept: ["chmod 750 /srv/qa/logs && chown :qa /srv/qa/logs/app.log && chmod 640 /srv/qa/logs/app.log"],
        reject: ["chmod -R 755 /srv/qa", "chmod g+x /srv/qa/logs\nchmod o+r /srv/qa/logs/app.log"],
        explain:
          "Причин две: у logs группе дан `r` без `x` (имена видно, войти нельзя), а лог — `root:root 600`, qa к нему не относится. Лечение: `g+x` на logs, группа qa и `g+r` на файл. `o+r` сработал бы формально (чужих не пустит /srv/qa 750), но доступ «через остальных» хрупкий: поменяют права каталога — лог откроется всем.",
      },
    ],
  },
};
