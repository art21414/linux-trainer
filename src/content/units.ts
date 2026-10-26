// Учебный контент. Как добавить урок — см. CLAUDE.md, раздел «Контент».
import type { Unit } from "./types";

export const UNITS: Unit[] = [
  {
    id: "u1",
    title: "Первые шаги",
    subtitle: "Где я, что тут лежит и как создать файл",
    color: "#58cc02",
    shade: "#46a302",
    lessons: [
      {
        id: "u1l1",
        title: "Где я?",
        icon: "🧭",
        exercises: [
          {
            type: "theory",
            title: "Терминал — это диалог",
            body: "Ты пишешь **команду**, сервер отвечает.\n\nСлева — **приглашение**: кто ты, на каком сервере и в каком каталоге. `~` — твой домашний каталог. `$` — обычный пользователь, `#` — root.",
            code: "[alice@server1 ~]$ pwd\n/home/alice",
          },
          {
            type: "choice",
            prompt: "Какая команда показывает, в каком каталоге ты сейчас?",
            options: ["pwd", "ls", "cd", "whoami"],
            answer: 0,
            explain: "pwd — print working directory. ls показывает содержимое, cd переходит, whoami — кто ты.",
          },
          {
            type: "choice",
            kind: "predict",
            prompt: "Что выведет команда?",
            code: "[bob@server1 ~]$ pwd",
            options: ["/home/bob", "/root", "~", "/home"],
            answer: 0,
            explain: "~ — это сокращение. Домашний каталог bob — /home/bob, а pwd всегда пишет полный путь.",
          },
          {
            type: "choice",
            prompt: "Приглашение заканчивается на #. Что это значит?",
            code: "[root@server1 ~]#",
            options: ["Ты работаешь от root", "В команде ошибка", "Это комментарий", "Сервер ждёт пароль"],
            answer: 0,
            explain: "# — признак суперпользователя root. С ним можно всё, поэтому аккуратнее.",
          },
          {
            type: "tiles",
            prompt: "Перейди в каталог /var/log",
            answer: ["cd", "/var/log"],
            extra: ["ls", "pwd", "-l"],
          },
          {
            type: "tiles",
            prompt: "Покажи подробный список файлов в /etc",
            answer: ["ls", "-l", "/etc"],
            extra: ["cd", "-a", "/var"],
            explain: "-l — long: права, владелец, размер и дата у каждого файла.",
          },
          {
            type: "terminal",
            prompt: "Перейди в каталог **/var/log**.",
            user: "alice",
            check: async ({ shell }) => shell.cwd === "/var/log" || (shell.cwd === "/var" ? "Ты в /var. Осталось зайти в log." : false),
            hint: "Команда cd и путь. Можно абсолютный: начинается с /",
            solution: "cd /var/log",
          },
          {
            type: "terminal",
            prompt: "Узнай, от какого пользователя ты работаешь, а потом вернись в **домашний каталог**.",
            user: "alice",
            cwd: "/tmp",
            check: async ({ shell }) => {
              const asked = shell.history.some((h) => /^(whoami|id)\b/.test(h));
              const home = shell.cwd === shell.env.HOME;
              if (asked && home) return true;
              if (home) return "Дома. А кто ты — так и не спросил (whoami).";
              return false;
            },
            hint: "whoami — кто я. cd без аргументов (или cd ~) — домой.",
            solution: "whoami\ncd",
          },
        ],
      },
      {
        id: "u1l2",
        title: "Файлы и каталоги",
        icon: "📁",
        exercises: [
          {
            type: "theory",
            title: "Создаём и смотрим",
            body: "`mkdir` — создать каталог.\n\n`touch` — создать пустой файл.\n\n`echo текст > файл` — записать текст в файл (старое содержимое пропадёт). `>>` — дописать в конец.\n\n`cat` — показать содержимое.",
            code: "$ mkdir notes\n$ echo hello > notes/a.txt\n$ cat notes/a.txt\nhello",
          },
          {
            type: "tiles",
            prompt: "Создай каталог backup",
            answer: ["mkdir", "backup"],
            extra: ["touch", "cd", "-r"],
          },
          {
            type: "fill",
            prompt: "Создай всю цепочку каталогов одной командой",
            template: "mkdir ___ /srv/app/logs",
            options: ["-p", "-r", "-f", "-a"],
            answer: 0,
            explain: "-p (parents) создаёт недостающие родительские каталоги и не ругается, если каталог уже есть.",
          },
          {
            type: "choice",
            kind: "predict",
            prompt: "Что выведет последняя команда?",
            code: "$ echo one > a.txt\n$ echo two > a.txt\n$ cat a.txt",
            options: ["two", "one\ntwo", "one", "ошибка: файл уже существует"],
            answer: 0,
            explain: "> перезаписывает файл целиком. Чтобы дописать, нужен >>.",
          },
          {
            type: "choice",
            kind: "bug",
            prompt: "Хотели удалить каталог docs со всем содержимым. Как правильно?",
            code: "$ rm docs\nrm: cannot remove 'docs': Is a directory",
            options: ["rm -r docs", "rm -f docs", "rmdir -f docs", "del docs"],
            answer: 0,
            explain: "rm без -r удаляет только файлы. -r — рекурсивно, вместе с содержимым. rmdir удаляет только пустые каталоги.",
          },
          {
            type: "tiles",
            prompt: "Допиши строку world в конец файла notes.txt",
            answer: ["echo", "world", ">>", "notes.txt"],
            extra: [">", "cat", "|"],
            explain: ">> дописывает в конец. Одиночный > стёр бы файл.",
          },
          {
            type: "terminal",
            prompt: "В домашнем каталоге создай каталог **project**, а в нём файл **README** с текстом **hello**.",
            user: "alice",
            check: async ({ world, shell }) => {
              const home = shell.env.HOME;
              const text = await world.read(`${home}/project/README`);
              if (text !== null && text.includes("hello")) return true;
              if (text !== null) return "README есть, но слова hello в нём нет. echo hello > ...";
              if (await world.exists(`${home}/project`)) return "Каталог есть. Теперь файл README внутри.";
              return false;
            },
            hint: "mkdir project, потом echo hello > project/README",
            solution: "mkdir project\necho hello > project/README",
          },
          {
            type: "terminal",
            prompt: "Скопируй файл **/etc/hosts** в каталог **~/project**, а потом удали каталог **/tmp/trash** со всем содержимым.",
            user: "alice",
            setup: async (w) => {
              const a = w.user("alice")!;
              await w.mkdir("/home/alice/project", 0o755, a.uid, a.gid);
              await w.mkdir("/tmp/trash", 0o755, a.uid, a.gid);
              await w.write("/tmp/trash/old.log", "мусор\n", 0o644, a.uid, a.gid);
              await w.write("/tmp/trash/core.1234", "ещё мусор\n", 0o644, a.uid, a.gid);
            },
            check: async ({ world }) => {
              const copied = await world.exists("/home/alice/project/hosts");
              const removed = !(await world.exists("/tmp/trash"));
              if (copied && removed) return true;
              if (copied) return "Скопировал. Теперь /tmp/trash.";
              if (removed) return "Мусор удалён. А hosts так и не скопирован.";
              return false;
            },
            hint: "cp источник куда. Для каталога с файлами — rm -r.",
            solution: "cp /etc/hosts ~/project/\nrm -r /tmp/trash",
          },
        ],
      },
    ],
  },
  {
    id: "u2",
    title: "Права доступа",
    subtitle: "rwx, chmod, chown — кто что может с файлом",
    color: "#1cb0f6",
    shade: "#1899d6",
    lessons: [
      {
        id: "u2l1",
        title: "Читаем rwx",
        icon: "🔍",
        exercises: [
          {
            type: "theory",
            title: "Права в ls -l",
            body: "Первый символ — **тип**: `-` файл, `d` каталог.\n\nДальше три тройки: **владелец** (u), **группа** (g), **остальные** (o).\n\n`r` — читать, `w` — менять, `x` — запускать (для каталога — входить).",
            code: "-rw-r-----. 1 alice dev report.txt\n └┬┘└┬┘└┬┘    └─┬─┘ └┬┘\n  u  g  o  владелец группа",
          },
          {
            type: "theory",
            title: "Права числами",
            body: "`r` = 4, `w` = 2, `x` = 1. В каждой тройке складываем.\n\n`rwx` = 7, `rw-` = 6, `r-x` = 5, `r--` = 4.",
            code: "rw- r-- ---\n 6   4   0   →  640",
          },
          {
            type: "choice",
            prompt: "Что может сделать с файлом участник группы dev (не alice)?",
            code: "-rwxr-x---. 1 alice dev 512 deploy.sh",
            options: ["Читать и запускать", "Читать, менять и запускать", "Только читать", "Ничего"],
            answer: 0,
            explain: "Вторая тройка r-x — права группы: чтение и запуск, без записи.",
          },
          {
            type: "choice",
            prompt: "Какое число соответствует rwxr-xr-x?",
            options: ["755", "644", "777", "750"],
            answer: 0,
            explain: "rwx = 4+2+1 = 7, r-x = 4+1 = 5. Итого 755.",
          },
          {
            type: "choice",
            prompt: "Что означает d в начале строки?",
            code: "drwxr-x---. 2 alice dev 6 docs",
            options: ["Это каталог", "Файл удалён", "Права по умолчанию", "Это диск"],
            answer: 0,
          },
          {
            type: "fill",
            prompt: "Нужны права rw-r----- . Какое число?",
            template: "chmod ___ report.txt",
            options: ["640", "644", "460", "750"],
            answer: 0,
            explain: "rw- = 6, r-- = 4, --- = 0.",
          },
          {
            type: "choice",
            prompt: "Кто может прочитать этот файл?",
            code: "----------. 1 root root 1024 /etc/shadow",
            options: ["Только root", "Никто, даже root", "Все пользователи", "Только группа root"],
            answer: 0,
            explain: "Права 000, но root проверку прав на чтение и запись обходит. Поэтому от root нужна аккуратность.",
          },
          {
            type: "terminal",
            prompt: "Скрипт **~/run.sh** не запускается. Сделай его исполняемым для владельца.",
            user: "alice",
            setup: async (w) => {
              const a = w.user("alice")!;
              await w.write("/home/alice/run.sh", "#!/bin/bash\necho 'Сервер жив'\n", 0o644, a.uid, a.gid);
            },
            check: async ({ world }) => {
              const i = await world.info("/home/alice/run.sh");
              if (!i) return "Файл пропал. Начни задание заново.";
              if (!(i.mode & 0o100)) return false;
              if (i.mode & 0o002) return "Запускается, но менять его теперь может кто угодно. Убери запись у остальных: chmod o-w";
              return true;
            },
            hint: "chmod и буква x. Для владельца — u+x.",
            solution: "chmod u+x ~/run.sh",
          },
        ],
      },
      {
        id: "u2l2",
        title: "chmod и chown",
        icon: "🔐",
        exercises: [
          {
            type: "theory",
            title: "Меняем права и владельца",
            body: "`chmod g+w файл` — буквами: кому (`u g o a`), что сделать (`+ - =`), какие права.\n\n`chmod 640 файл` — числами.\n\n`chown alice:dev файл` — владелец и группа. `chown :dev` или `chgrp dev` — только группа. Владельца меняет только root.",
            code: "# chmod g+w /srv/project\n# chown alice:dev report.txt",
          },
          {
            type: "tiles",
            prompt: "Добавь группе право записи на /srv/project",
            answer: ["chmod", "g+w", "/srv/project"],
            extra: ["o+w", "chown", "+x"],
          },
          {
            type: "choice",
            prompt: "Нужно дать группе право записи, не трогая остальных. Какая команда?",
            options: ["chmod g+w file", "chmod 777 file", "chmod o+w file", "chown :dev file"],
            answer: 0,
            explain: "777 и o+w дают запись всем подряд. chown меняет группу, а не права.",
          },
          {
            type: "choice",
            kind: "bug",
            prompt: "Хотели сменить только группу файла на dev. Как исправить?",
            code: "# chown dev report.txt\nchown: invalid user: ‘dev’",
            options: ["chown :dev report.txt", "chown -g dev report.txt", "chmod dev report.txt", "chown report.txt dev"],
            answer: 0,
            explain: "Без двоеточия chown считает dev пользователем. :dev — только группа. То же делает chgrp dev.",
          },
          {
            type: "tiles",
            prompt: "Сделай alice владельцем, а dev — группой файла report.txt",
            answer: ["chown", "alice:dev", "report.txt"],
            extra: ["chmod", "dev:alice", "-R"],
          },
          {
            type: "fill",
            prompt: "Сменить владельца у каталога и всего, что внутри",
            template: "chown ___ alice /srv/data",
            options: ["-R", "-r", "-a", "-p"],
            answer: 0,
            explain: "У chown и chmod рекурсия — заглавная -R. У cp и rm работает и -r.",
          },
          {
            type: "terminal",
            prompt: "Дай группе **dev** право записи в каталог **/srv/project**. Сейчас он root:root, bob уже в группе dev.",
            user: "root",
            setup: async (w) => {
              const g = w.addGroup("dev");
              const bob = w.user("bob")!;
              bob.groups.push(g.name);
              await w.syncEtc();
              await w.mkdir("/srv/project", 0o755, 0, 0);
              await w.write("/srv/project/app.conf", "port=8080\n", 0o644, 0, 0);
            },
            check: async ({ world }) => {
              const bob = world.user("bob")!;
              const nobody = world.user("nobody")!;
              const i = await world.info("/srv/project");
              if (!i) return "Каталог пропал! Начни заново.";
              const bobCan = await world.canModifyDir("/srv/project", bob);
              const anyoneCan = await world.canModifyDir("/srv/project", nobody);
              if (bobCan && anyoneCan) return "Работает, но писать теперь может вообще кто угодно. Доступ нужен только группе dev.";
              if (bobCan) return true;
              const dev = world.group("dev")!;
              if (i.gid === dev.gid) return "Группа уже dev. Осталось дать ей право записи.";
              if (i.mode & 0o020) return "Право записи у группы есть, но группа-то root. Сделай группой dev.";
              return false;
            },
            hint: "Два шага: сменить группу каталога (chgrp или chown :dev) и дать группе w (chmod g+w).",
            solution: "chgrp dev /srv/project\nchmod g+w /srv/project",
          },
          {
            type: "terminal",
            prompt: "Ты — alice. Закрой файл **~/secret.txt** от всех, кроме себя: группа и остальные не должны ни читать, ни писать.",
            user: "alice",
            setup: async (w) => {
              const a = w.user("alice")!;
              await w.write("/home/alice/secret.txt", "пароль от прода: hunter2\n", 0o664, a.uid, a.gid);
            },
            check: async ({ world }) => {
              const i = await world.info("/home/alice/secret.txt");
              if (!i) return "Файл удалён. Так, конечно, тоже секретно, но нет. Начни заново.";
              if ((i.mode & 0o600) !== 0o600) return "Теперь и ты не можешь его читать или менять. Верни себе rw.";
              if (i.mode & 0o077) return false;
              return true;
            },
            hint: "Нужно 600 (rw-------). Или буквами: chmod go-rw",
            solution: "chmod 600 ~/secret.txt",
          },
        ],
      },
    ],
  },
];

export const ALL_LESSONS = UNITS.flatMap((u) => u.lessons);
