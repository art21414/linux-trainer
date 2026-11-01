// ВРЕМЕННАЯ тема-пример: перенесена из старых уроков. Методист перепишет.
import type { Topic } from "../../types";
import theoryMd from "./theory.md?raw";

export const permissions: Topic = {
  id: "perm",
  n: 2,
  title: "Права доступа",
  summary: "rwx, chmod, chown, umask: кто что может с файлом и каталогом",
  level: "base",
  theory: theoryMd,
  sets: [
    {
      id: "1",
      title: "Читаем и меняем права",
      exercises: [
        {
          id: "perm-1-01",
          type: "terminal",
          theory: "chmod",
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
          accept: ["chmod 744 ~/run.sh", "chmod 755 ~/run.sh"],
          reject: ["chmod 666 ~/run.sh"],
        },
        {
          id: "perm-1-02",
          type: "terminal",
          theory: "chmod",
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
          accept: ["chmod go-rw ~/secret.txt", "chmod u=rw,go= ~/secret.txt"],
          reject: ["chmod 640 ~/secret.txt"],
        },
        {
          id: "perm-1-03",
          type: "terminal",
          theory: "chmod",
          prompt: "Файл **/home/alice/report.txt** принадлежит root:root. Сделай владельцем alice, а группой — dev.",
          setup: async (w) => {
            w.addGroup("dev");
            await w.syncEtc();
            await w.write("/home/alice/report.txt", "Q3\n", 0o644, 0, 0);
          },
          check: async ({ world }) => {
            const i = await world.info("/home/alice/report.txt");
            if (!i) return "Файл пропал.";
            const alice = world.user("alice")!;
            const dev = world.group("dev")!;
            if (i.uid === alice.uid && i.gid === dev.gid) return true;
            if (i.uid === alice.uid) return "Владелец верный, группа ещё нет.";
            if (i.gid === dev.gid) return "Группа верная, владелец ещё нет.";
            return false;
          },
          hint: "chown умеет менять обоих сразу: владелец:группа.",
          solution: "chown alice:dev /home/alice/report.txt",
          accept: ["chown alice /home/alice/report.txt\nchgrp dev /home/alice/report.txt"],
          reject: ["chown alice /home/alice/report.txt"],
          explain: "`chown user:group` меняет обоих. Если оставить только `user`, группа не изменится.",
        },
        {
          id: "perm-1-04",
          type: "choice",
          kind: "bug",
          theory: "chmod",
          prompt: "Хотели сменить только группу файла на dev. Как исправить?",
          code: "# chown dev report.txt\nchown: invalid user: ‘dev’",
          options: ["chown :dev report.txt", "chown -g dev report.txt", "chmod dev report.txt", "chown report.txt dev"],
          answer: 0,
          explain: "Без двоеточия chown считает dev пользователем. `:dev` — только группа. То же делает `chgrp dev`. У chown нет флага -g.",
        },
      ],
    },
    {
      id: "2",
      title: "Группы, рекурсия, umask",
      exercises: [
        {
          id: "perm-2-01",
          type: "terminal",
          theory: "chmod",
          prompt: "Дай группе **dev** право записи в каталог **/srv/project**. Сейчас он root:root, bob уже в группе dev.",
          setup: async (w) => {
            const g = w.addGroup("dev");
            w.user("bob")!.groups.push(g.name);
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
          accept: ["chown :dev /srv/project; chmod 775 /srv/project", "chown root:dev /srv/project && chmod g=rwx /srv/project", "chgrp dev /srv/project; chmod 2775 /srv/project"],
          reject: ["chmod 777 /srv/project"],
          explain: "`chmod 777` тоже «работает», но пускает в каталог всех. Нужна группа dev и `g+w`.",
        },
        {
          id: "perm-2-02",
          type: "terminal",
          theory: "chmod",
          prompt: "Каталог **/srv/data** со всем содержимым принадлежит root. Передай alice владение им и **всем вложенным файлам**.",
          setup: async (w) => {
            await w.mkdir("/srv/data/sub", 0o755, 0, 0);
            await w.write("/srv/data/a.txt", "a\n", 0o644, 0, 0);
            await w.write("/srv/data/sub/b.txt", "b\n", 0o644, 0, 0);
          },
          check: async ({ world }) => {
            const alice = world.user("alice")!;
            const paths = ["/srv/data", "/srv/data/a.txt", "/srv/data/sub", "/srv/data/sub/b.txt"];
            let ok = 0;
            for (const p of paths) if ((await world.info(p))?.uid === alice.uid) ok++;
            if (ok === paths.length) return true;
            if (ok > 0) return "Часть файлов уже у alice, но не все. Нужна рекурсия.";
            return false;
          },
          hint: "У chown рекурсия — заглавная -R.",
          solution: "chown -R alice /srv/data",
          accept: ["chown -R alice:alice /srv/data"],
          reject: ["chown alice /srv/data"],
          explain: "У chown и chmod рекурсия — `-R` (заглавная). Без неё меняется только сам каталог.",
        },
        {
          id: "perm-2-03",
          type: "terminal",
          theory: "chmod",
          prompt: "Каталог **/srv/app** открыт всем (777). Оставь владельцу всё, группе — только чтение и вход, остальным — ничего.",
          setup: async (w) => {
            await w.mkdir("/srv/app", 0o777, 0, 0);
          },
          check: async ({ world }) => {
            const i = await world.info("/srv/app");
            if (!i) return "Каталог пропал.";
            const m = i.mode & 0o777;
            if (m === 0o750) return true;
            if (m & 0o007) return "У остальных ещё остались права.";
            if (m & 0o020) return "Группа всё ещё может писать.";
            return false;
          },
          hint: "rwx r-x --- — это какое число?",
          solution: "chmod 750 /srv/app",
          accept: ["chmod u=rwx,g=rx,o= /srv/app", "chmod g-w,o-rwx /srv/app"],
          reject: ["chmod 755 /srv/app"],
        },
        {
          id: "perm-2-04",
          type: "choice",
          kind: "predict",
          theory: "chmod",
          prompt: "Какие права будут у файла `f` и каталога `d`?",
          code: "$ umask 027\n$ touch f; mkdir d",
          options: ["f: 640, d: 750", "f: 750, d: 750", "f: 640, d: 640", "f: 644, d: 755"],
          answer: 0,
          explain: "Файлы создаются с 666, каталоги с 777, umask вычитает биты: 666-027 = 640, 777-027 = 750. Файлу `x` по умолчанию не дают никогда.",
        },
      ],
    },
  ],
  exam: {
    id: "exam",
    title: "Зачёт: права доступа",
    exercises: [
      {
        id: "perm-exam-01",
        type: "terminal",
        theory: "chmod",
        prompt: "Скрипт **/usr/local/bin/backup.sh** (644, root) должны запускать все, но менять — только root.",
        setup: async (w) => {
          await w.write("/usr/local/bin/backup.sh", "#!/bin/bash\ntar czf /tmp/b.tgz /etc\n", 0o644, 0, 0);
        },
        check: async ({ world }) => {
          const i = await world.info("/usr/local/bin/backup.sh");
          if (!i) return "Файл пропал.";
          const m = i.mode & 0o777;
          if (m === 0o755) return true;
          if (m & 0o022) return "Менять его теперь могут не только root.";
          return false;
        },
        hint: "rwxr-xr-x",
        solution: "chmod 755 /usr/local/bin/backup.sh",
        accept: ["chmod a+x /usr/local/bin/backup.sh"],
        reject: ["chmod 777 /usr/local/bin/backup.sh"],
      },
      {
        id: "perm-exam-02",
        type: "terminal",
        theory: "chmod",
        user: "alice",
        prompt: "Файл **~/notes.txt** (666). Пусть владелец читает и пишет, группа только читает, остальные — ничего.",
        setup: async (w) => {
          const a = w.user("alice")!;
          await w.write("/home/alice/notes.txt", "todo\n", 0o666, a.uid, a.gid);
        },
        check: async ({ world }) => ((await world.info("/home/alice/notes.txt"))!.mode & 0o777) === 0o640,
        hint: "rw- r-- ---",
        solution: "chmod 640 ~/notes.txt",
        accept: ["chmod u=rw,g=r,o= ~/notes.txt"],
        reject: ["chmod 600 ~/notes.txt"],
      },
      {
        id: "perm-exam-03",
        type: "terminal",
        theory: "chmod",
        prompt: "Сделай группой каталога **/srv/logs** группу dev, не меняя владельца.",
        setup: async (w) => {
          w.addGroup("dev");
          await w.syncEtc();
          await w.mkdir("/srv/logs", 0o755, 0, 0);
        },
        check: async ({ world }) => {
          const i = await world.info("/srv/logs");
          return !!i && i.gid === world.group("dev")!.gid && i.uid === 0;
        },
        hint: "Либо chgrp, либо chown с двоеточием.",
        solution: "chgrp dev /srv/logs",
        accept: ["chown :dev /srv/logs", "chown root:dev /srv/logs"],
        reject: ["chown dev /srv/logs"],
      },
      {
        id: "perm-exam-04",
        type: "terminal",
        theory: "chmod",
        prompt: "Файл **/home/alice/deploy.sh** (700) принадлежит root. Передай его alice, права не меняй.",
        setup: async (w) => {
          await w.write("/home/alice/deploy.sh", "#!/bin/bash\n", 0o700, 0, 0);
        },
        check: async ({ world }) => {
          const i = await world.info("/home/alice/deploy.sh");
          if (!i) return "Файл пропал.";
          if (i.uid !== world.user("alice")!.uid) return false;
          return (i.mode & 0o777) === 0o700 ? true : "Права изменились, а должны остаться 700.";
        },
        hint: "Меняется владелец, а не права.",
        solution: "chown alice /home/alice/deploy.sh",
        accept: ["chown alice:alice /home/alice/deploy.sh"],
        reject: ["chmod 777 /home/alice/deploy.sh"],
      },
    ],
  },
};
