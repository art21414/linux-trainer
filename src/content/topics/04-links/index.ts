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
const lines = (a: string) =>
  a
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
const ino = (w: World, p: string) => w.inodes.ino(p);
async function isLink(w: World, p: string): Promise<boolean> {
  return !!(await w.info(p))?.isLink;
}
/** Куда в итоге ведёт ссылка; null — цели нет (битая). */
async function target(w: World, p: string): Promise<string | null> {
  const t = await w.resolveFinal(p);
  return (await w.exists(t)) ? t : null;
}
async function rawLink(w: World, p: string): Promise<string | null> {
  try {
    return await w.base.readlink(p);
  } catch {
    return null;
  }
}
/** Ссылки внутри каталогов релизов — след `ln -sf` на ссылку-каталог. */
async function strayLinks(w: World, root: string): Promise<string[]> {
  const out: string[] = [];
  for (const p of w.subtree(root)) if (p !== root && (await isLink(w, p))) out.push(p);
  return out;
}
/** Номер inode из setup — по миру (у каждого прогона свой). */
const inoAtSetup = new WeakMap<World, number>();

/** /srv/app: релизы v1..v3, current -> releases/v2, previous -> releases/v1. */
async function releases(w: World) {
  for (const v of ["v1", "v2", "v3"]) {
    await w.write(`/srv/app/releases/${v}/conf/app.conf`, `release = ${v}\n`);
    await w.write(`/srv/app/releases/${v}/app.jar`, bytes(2048));
  }
  await w.fs.symlink("releases/v2", "/srv/app/current");
  await w.fs.symlink("releases/v1", "/srv/app/previous");
}
/** Отдельный диск под /backup (ext4): жёсткая ссылка туда невозможна. */
async function backupDisk(w: World) {
  await w.storage.addDisk("vdd", "1G");
  await w.storage.mkfs("/dev/vdd", "ext4");
  await w.mkdir("/backup");
  await w.storage.mount("/dev/vdd", "/backup");
}

const REPORT = "date,orders\n2026-11-21,140\n";
const APP = "listen = 8080\nworkers = 8\n";

const GUARDS: Record<string, Guard> = {
  "links-1-01": { keep: ["/srv/data"], reject: ["mv /srv/data/report.csv /srv/share/report.csv"] },
  "links-1-02": { keep: ["/srv/app"], reject: ["mv /srv/app/app.conf /etc/myapp.conf"] },
  "links-1-03": { keep: ["/srv/data", "/srv/old"], reject: ["rm /srv/old/db.dat.bak\necho 3 > /root/answer"] },
  "links-2-01": { keep: ["/srv"], reject: ["rm /srv/backup/huge.bin\nfind /srv -xdev -inum $(stat -c %i /srv/data/huge.bin) > /root/answer"] },
  "links-2-02": {
    keep: ["/etc/app.d", "/srv/app"],
    except: ["/etc/app.d/20-old.conf", "/etc/app.d/30-cache.conf"],
    reject: ["rm -f /etc/app.d/*"],
  },
  "links-2-03": { keep: ["/srv/app/releases"], reject: ["rm -rf /srv/app/releases/v2\nln -sfn releases/v3 /srv/app/current"] },
  "links-2-05": { keep: ["/srv/.snapshots"], reject: ["mv /srv/.snapshots/app.conf /srv/app/app.conf"] },
  "links-2-06": { keep: ["/srv/app"], reject: ["mv /srv/app/shared/app.conf /srv/app/releases/v3/conf/shared.conf"] },
  "links-3-01": {
    keep: ["/srv/app/releases"],
    reject: ["rm -rf /srv/app/releases/v3\nln -sfn releases/v2 /srv/app/current\nln -sfn releases/v1 /srv/app/previous"],
  },
  "links-3-02": { keep: ["/srv/app"], reject: ["mkdir -p /backup/conf\nmv /srv/app/app.conf /backup/conf/app.conf\nln -s /backup/conf/app.conf /srv/app/app.conf"] },
  "links-3-03": { keep: ["/srv/backup", "/srv/data/keep.sql"], reject: ["find /srv -name 'db.dump*' -delete"] },
  "links-4-01": { keep: ["/srv/app/releases", "/srv/app/current"], reject: ["rm -r /srv/app/previous/"] },
  "links-exam-01": { keep: ["/srv/www"], reject: ["mv /srv/www/robots.txt /srv/share/robots.txt"] },
  "links-exam-02": { keep: ["/opt/tool/releases"], reject: ["rm -rf /opt/tool/releases/2.4\nln -sfn releases/2.5 /opt/tool/current"] },
  "links-exam-03": { keep: ["/usr/local/bin", "/opt/tools"], reject: ["find /usr/local/bin -xtype l -delete\necho > /root/answer"] },
  "links-exam-04": { keep: ["/srv/www", "/etc/nginx/conf.d"], reject: ["mv /srv/www/shop/nginx.conf /etc/nginx/conf.d/shop.conf"] },
  "links-exam-05": { keep: ["/srv/www/releases"], reject: ["rm -rf /var/www/current/"] },
};

export const links: Topic = guarded(
  {
    id: "links",
    n: 4,
    title: "Inode и ссылки",
    summary: "inode и имя, счётчик ссылок, find -inum, ln и ln -s, относительный путь в ссылке, readlink -e, -xtype l, ln -sfn, rm ссылки без слэша",
    level: "base",
    theory: theoryMd,
    sets: [
      {
        id: "1",
        title: "Разминка: имена и ссылки",
        exercises: [
          {
            id: "links-1-01",
            type: "terminal",
            theory: "hard",
            prompt:
              "Скрипт отчётов пишет **/srv/data/report.csv**, а веб-сервер отдаёт **/srv/share/report.csv**. Сделай /srv/share/report.csv вторым именем (жёсткой ссылкой) того же файла — не копией.",
            setup: async (w) => {
              await w.write("/srv/data/report.csv", REPORT);
              await w.mkdir("/srv/share");
            },
            check: async ({ world }) => {
              const p = "/srv/share/report.csv";
              const i = await world.info(p);
              if (!i) return false;
              if (i.isLink) return "Это символическая ссылка — отдельный файл с путём. Нужно второе имя того же inode.";
              if (ino(world, p) !== ino(world, "/srv/data/report.csv")) return "Это копия: у неё свой inode. Нужно второе имя того же файла.";
              return true;
            },
            hint: "ln без ключей создаёт жёсткую ссылку.",
            solution: "ln /srv/data/report.csv /srv/share/report.csv",
            accept: ["cd /srv/share\nln /srv/data/report.csv ."],
            reject: ["cp /srv/data/report.csv /srv/share/report.csv", "ln -s /srv/data/report.csv /srv/share/report.csv"],
            explain:
              "Жёсткая ссылка — ещё одна строка «имя → inode» в каталоге. Номер в `ls -i` у обоих имён один, счётчик ссылок стал 2, данные хранятся один раз.",
          },
          {
            id: "links-1-02",
            type: "terminal",
            theory: "symlink",
            cwd: "/srv/app",
            prompt:
              "Ты в **/srv/app**. Старый скрипт ищет конфиг по пути **/etc/myapp.conf**. Создай там символическую ссылку на **/srv/app/app.conf**.",
            setup: async (w) => {
              await w.write("/srv/app/app.conf", APP);
            },
            check: async ({ world }) => {
              const p = "/etc/myapp.conf";
              if (!(await world.info(p))) return false;
              if (!(await isLink(world, p))) return "Это не символическая ссылка.";
              const t = await target(world, p);
              if (t === null) return `Ссылка битая: в ней записано «${await rawLink(world, p)}», а относительный путь считается от каталога ссылки — /etc.`;
              return t === "/srv/app/app.conf" || "Ссылка ведёт не туда.";
            },
            hint: "Относительный путь в ссылке считается не от текущего каталога.",
            solution: "ln -s /srv/app/app.conf /etc/myapp.conf",
            accept: ["ln -sr app.conf /etc/myapp.conf", "ln -s ../srv/app/app.conf /etc/myapp.conf"],
            reject: ["ln -s app.conf /etc/myapp.conf", "cp /srv/app/app.conf /etc/myapp.conf"],
            explain:
              "`ln -s app.conf /etc/myapp.conf` записывает в ссылку строку `app.conf`, и ядро ищет её рядом со ссылкой — `/etc/app.conf`. Нужен абсолютный путь или `ln -sr`, который сам посчитает `../srv/app/app.conf`.",
          },
          {
            id: "links-1-03",
            type: "terminal",
            theory: "hard",
            prompt:
              "Перед удалением **/srv/data/db.dat** выясни, сколько у этого файла имён (жёстких ссылок) — если больше одного, `rm` места не освободит. Запиши число в **/root/answer**.",
            setup: async (w) => {
              await w.write("/srv/data/db.dat", bytes(4096));
              await w.fs.link("/srv/data/db.dat", "/srv/old/db.dat.bak");
              await w.fs.link("/srv/data/db.dat", "/srv/data/.db.dat.snap");
              await w.write("/srv/old/readme.txt", "old stuff\n");
            },
            check: async ({ world }) => {
              const a = await answer(world);
              if (a === null) return false;
              if (a === "3") return true;
              if (a === "1") return "Имён больше одного: посмотри на счётчик ссылок во второй колонке ls -l или %h в stat.";
              return "Не то число. Счётчик ссылок — вторая колонка ls -l.";
            },
            hint: "Число жёстких ссылок хранится в inode: его показывают ls -l и stat.",
            solution: "stat -c %h /srv/data/db.dat > /root/answer",
            accept: ["ls -l /srv/data/db.dat | awk '{print $2}' > /root/answer"],
            reject: ["echo 1 > /root/answer"],
            explain:
              "Вторая колонка `ls -l` и `%h` в `stat` — число имён у inode. Данные освободятся, только когда удалят все три (и файл никто не держит открытым).",
          },
        ],
      },
      {
        id: "2",
        title: "Средние: найти, починить, переключить",
        exercises: [
          {
            id: "links-2-01",
            type: "terminal",
            theory: "hard",
            prompt:
              "Файл **/srv/data/huge.bin** не освобождает место после `rm` — у него есть другие имена. Найди **все** имена этого файла в /srv и запиши полные пути в **/root/answer**, по одному в строке.",
            setup: async (w) => {
              await w.write("/srv/data/huge.bin", bytes(8192));
              await w.fs.link("/srv/data/huge.bin", "/srv/old/huge.bin.1");
              await w.fs.link("/srv/data/huge.bin", "/srv/tmp/x.bin");
              await w.write("/srv/backup/huge.bin", bytes(8192)); // копия: то же имя, другой inode
            },
            check: async ({ world }) => {
              const a = await answer(world);
              if (a === null) return false;
              const got = lines(a).sort().join(" ");
              const want = ["/srv/data/huge.bin", "/srv/old/huge.bin.1", "/srv/tmp/x.bin"].sort().join(" ");
              if (got === want) return true;
              if (got.includes("/srv/backup/huge.bin")) return "/srv/backup/huge.bin — копия с тем же именем, но это другой inode. Ищи по номеру, а не по имени.";
              if (!got.includes("/srv/tmp/x.bin")) return "Найдены не все: у второго имени может быть совсем другое название. Ищи по номеру inode.";
              return "Список не тот. Нужны полные пути всех имён этого inode.";
            },
            hint: "У find есть поиск по номеру inode. Номер узнаешь через stat или ls -i.",
            solution: "find /srv -xdev -inum $(stat -c %i /srv/data/huge.bin) > /root/answer",
            accept: ["find /srv -samefile /srv/data/huge.bin > /root/answer"],
            reject: ["find /srv -name 'huge*' > /root/answer"],
            explain:
              "Имена не связаны между собой ничем, кроме номера inode. `find -inum N` (или `-samefile`) находит их все; `-xdev` нужен, потому что номер уникален только внутри одной ФС. Поиск по имени даст и чужую копию, и не найдёт `x.bin`.",
          },
          {
            id: "links-2-02",
            type: "terminal",
            theory: "symlink",
            prompt:
              "В **/etc/app.d** лежат ссылки на конфиги релизов. После удаления старого релиза часть ссылок стала битой, и приложение ругается при старте. Удали битые ссылки, рабочие и обычные файлы не трогай.",
            setup: async (w) => {
              await w.write("/srv/app/releases/v2/conf/main.conf", "main = 1\n");
              await w.write("/srv/app/releases/v2/conf/db.conf", "db = 1\n");
              await w.fs.symlink("/srv/app/releases/v2/conf/main.conf", "/etc/app.d/10-main.conf");
              await w.fs.symlink("/srv/app/releases/v1/conf/old.conf", "/etc/app.d/20-old.conf");
              await w.fs.symlink("../../srv/app/releases/v1/conf/cache.conf", "/etc/app.d/30-cache.conf");
              await w.fs.symlink("../../srv/app/releases/v2/conf/db.conf", "/etc/app.d/40-db.conf");
              await w.write("/etc/app.d/99-local.conf", "debug = 0\n");
            },
            check: async ({ world }) => {
              const left = [];
              for (const f of ["20-old.conf", "30-cache.conf"]) if (await world.info(`/etc/app.d/${f}`)) left.push(f);
              return left.length === 0 || `Битые ещё остались: ${left.join(", ")}.`;
            },
            hint: "find умеет искать ссылки, цель которых не найдена.",
            solution: "find /etc/app.d -xtype l -delete",
            accept: ["rm /etc/app.d/20-old.conf /etc/app.d/30-cache.conf", "find /etc/app.d -xtype l\nfind /etc/app.d -xtype l -delete"],
            reject: ["rm /etc/app.d/20-old.conf"],
            explain:
              "`-xtype l` — «после разыменования это всё ещё ссылка», то есть цели нет. Обрати внимание на `40-db.conf`: относительная, но рабочая — относительный путь сам по себе не делает ссылку битой.",
          },
          {
            id: "links-2-03",
            type: "terminal",
            theory: "switch",
            prompt:
              "Выкатываем релиз: переключи **/srv/app/current** (сейчас ведёт на `releases/v2`) на `releases/v3`.",
            setup: releases,
            check: async ({ world }) => {
              const stray = await strayLinks(world, "/srv/app/releases");
              if (stray.length) return `Внутри релизов появилась ссылка ${stray[0]}: ln -sf на ссылку-каталог кладёт новую ссылку внутрь. Убери её и переключи правильно.`;
              if (!(await isLink(world, "/srv/app/current"))) return "current больше не ссылка — схема выкладки сломана.";
              const t = await target(world, "/srv/app/current");
              if (t === "/srv/app/releases/v2") return false;
              return t === "/srv/app/releases/v3" || "current ведёт не на v3.";
            },
            hint: "Если последний аргумент ln — ссылка на каталог, ln положит новую ссылку внутрь. Есть ключ, который это запрещает.",
            solution: "ln -sfn releases/v3 /srv/app/current",
            accept: ["ln -sfT releases/v3 /srv/app/current", "cd /srv/app\nrm current\nln -s releases/v3 current", "ln -sfn /srv/app/releases/v3 /srv/app/current"],
            reject: ["ln -sf releases/v3 /srv/app/current"],
            explain:
              "`ln -sf releases/v3 current` видит, что `current` — каталог (через ссылку), и создаёт `releases/v2/v3`. `-n` (или `-T`) велит считать `current` самой ссылкой и заменить её.",
          },
          {
            id: "links-2-04",
            type: "choice",
            kind: "predict",
            theory: "hard",
            prompt: "Что выведут две последние команды?",
            code: "$ ln app.conf app.hard\n$ ln -s app.conf app.soft\n$ mv app.conf app.conf.orig\n$ cat app.hard\n$ cat app.soft",
            options: [
              "Содержимое конфига, затем `cat: app.soft: No such file or directory`",
              "Обе — содержимое конфига: ссылки идут за файлом",
              "`No such file or directory` для обеих: оригинала больше нет",
              "`cat: app.hard: No such file or directory`, затем содержимое конфига",
            ],
            answer: 0,
            explain:
              "Жёсткая ссылка указывает на inode, переименование её не касается. Символическая хранит путь `app.conf`, по которому теперь пусто, — ссылка битая.",
          },
          {
            id: "links-2-05",
            type: "terminal",
            theory: "hard",
            prompt:
              "**/srv/app/app.conf** удалили по ошибке. У него была жёсткая ссылка **/srv/.snapshots/app.conf**. Верни /srv/app/app.conf так, чтобы это снова был **тот же файл**, что и в снимке (тот же inode), а не копия и не символическая ссылка.",
            setup: async (w) => {
              await w.write("/srv/app/app.conf", APP);
              await w.fs.link("/srv/app/app.conf", "/srv/.snapshots/app.conf");
              await w.fs.rm("/srv/app/app.conf");
            },
            check: async ({ world }) => {
              const p = "/srv/app/app.conf";
              const i = await world.info(p);
              if (!i) return false;
              if (i.isLink) return "Это символическая ссылка, а нужен тот же inode.";
              return ino(world, p) === ino(world, "/srv/.snapshots/app.conf") || "Содержимое на месте, но это копия — другой inode.";
            },
            hint: "Пока у inode есть хоть одно имя, ему можно дать ещё одно.",
            solution: "ln /srv/.snapshots/app.conf /srv/app/app.conf",
            accept: ["cd /srv/app\nln /srv/.snapshots/app.conf app.conf"],
            reject: ["cp /srv/.snapshots/app.conf /srv/app/app.conf", "ln -s /srv/.snapshots/app.conf /srv/app/app.conf"],
            explain:
              "`rm` убрал одно имя, inode жив, пока есть второе. `ln` просто добавляет новую строку в каталог — файл вернулся тем же самым, со всеми правами и временами.",
          },
          {
            id: "links-2-06",
            type: "terminal",
            theory: "symlink",
            prompt:
              "Каталог **/srv/app** целиком переносят на другие серверы. Сделай в **/srv/app/releases/v3/conf** ссылку **shared.conf** на **/srv/app/shared/app.conf** так, чтобы она работала в любой копии дерева, куда бы его ни положили.",
            setup: async (w) => {
              await releases(w);
              await w.write("/srv/app/shared/app.conf", APP);
            },
            check: async ({ world }) => {
              const p = "/srv/app/releases/v3/conf/shared.conf";
              if (!(await world.info(p))) return false;
              if (!(await isLink(world, p))) return "Это не символическая ссылка.";
              const raw = (await rawLink(world, p)) ?? "";
              const t = await target(world, p);
              if (t === null) return `Ссылка битая: «${raw}» считается от каталога ссылки, /srv/app/releases/v3/conf.`;
              if (t !== "/srv/app/shared/app.conf") return "Ссылка ведёт не туда.";
              if (raw.startsWith("/")) return "Ссылка рабочая, но абсолютная: в копии дерева на другом пути она поведёт в /srv/app исходного сервера (или в никуда).";
              return true;
            },
            hint: "Нужен относительный путь от каталога ссылки. ln умеет посчитать его сам.",
            solution: "ln -sr /srv/app/shared/app.conf /srv/app/releases/v3/conf/shared.conf",
            accept: ["ln -s ../../../shared/app.conf /srv/app/releases/v3/conf/shared.conf"],
            reject: ["ln -s /srv/app/shared/app.conf /srv/app/releases/v3/conf/shared.conf", "ln -s shared/app.conf /srv/app/releases/v3/conf/shared.conf"],
            explain:
              "`-r` превращает цель в путь от каталога ссылки: `../../../shared/app.conf`. Такая ссылка переживает перенос дерева целиком. Абсолютная ведёт в `/srv/app` на любом сервере, а `shared/app.conf` ищется внутри `conf/`.",
          },
        ],
      },
      {
        id: "3",
        title: "Сложные: откат, другой диск, все имена",
        exercises: [
          {
            id: "links-3-01",
            type: "terminal",
            theory: "switch",
            prompt:
              "Релиз сломан, нужен откат. Сейчас **/srv/app/current** ведёт на `releases/v2`, а **/srv/app/previous** — на `releases/v1`. Сделай так, чтобы current вёл на v1, а previous — на v2 (чтобы можно было вернуться).",
            setup: releases,
            check: async ({ world }) => {
              const stray = await strayLinks(world, "/srv/app/releases");
              if (stray.length) return `Внутри релизов появилась ссылка ${stray[0]} — след ln -sf без -n. Убери её.`;
              for (const l of ["current", "previous"])
                if (!(await isLink(world, `/srv/app/${l}`))) return `${l} больше не ссылка.`;
              const c = await target(world, "/srv/app/current");
              const p = await target(world, "/srv/app/previous");
              if (c === "/srv/app/releases/v1" && p === "/srv/app/releases/v2") return true;
              if (c === "/srv/app/releases/v1") return "current откачен, а previous не переставлен на v2.";
              return false;
            },
            hint: "Две ссылки на каталоги — два ln с ключом, запрещающим заходить внутрь цели.",
            solution: "ln -sfn releases/v1 /srv/app/current\nln -sfn releases/v2 /srv/app/previous",
            accept: ["cd /srv/app\nln -sfT releases/v1 current\nln -sfT releases/v2 previous", "cd /srv/app\nrm current previous\nln -s releases/v1 current\nln -s releases/v2 previous"],
            reject: ["ln -sf releases/v1 /srv/app/current\nln -sf releases/v2 /srv/app/previous"],
            explain:
              "Каждый `ln -sf` без `-n` положил бы новую ссылку внутрь релиза. С `-sfn` переключение — замена одной ссылки, а откат — та же операция в обратную сторону.",
          },
          {
            id: "links-3-02",
            type: "terminal",
            theory: "hard",
            prompt:
              "Агент бэкапа читает конфиги только из **/backup/conf** (это отдельный диск). Сделай так, чтобы **/backup/conf/app.conf** всегда показывал актуальный **/srv/app/app.conf** — без копирования и без переноса оригинала.",
            setup: async (w) => {
              await w.write("/srv/app/app.conf", APP);
              await backupDisk(w);
              await w.mkdir("/backup/conf");
            },
            check: async ({ world }) => {
              const p = "/backup/conf/app.conf";
              const i = await world.info(p);
              if (!i) return false;
              if (!i.isLink) return "Это копия: при правке оригинала она устареет.";
              return (await target(world, p)) === "/srv/app/app.conf" || "Ссылка битая или ведёт не туда.";
            },
            hint: "Попробуй ln без ключей — и прочитай ошибку.",
            solution: "ln -s /srv/app/app.conf /backup/conf/app.conf",
            accept: ["ln -sr /srv/app/app.conf /backup/conf/app.conf"],
            reject: ["ln /srv/app/app.conf /backup/conf/app.conf", "cp /srv/app/app.conf /backup/conf/app.conf"],
            explain:
              "Жёсткая ссылка между ФС невозможна: `Invalid cross-device link` — номер inode с одного диска ничего не значит на другом. Символическая хранит путь и может вести куда угодно.",
          },
          {
            id: "links-3-03",
            type: "terminal",
            theory: "hard",
            prompt:
              "Дамп **/srv/data/db.dump** удаляют уже второй раз, а место не возвращается: у файла есть другие имена. Удали этот файл полностью — все его имена. Отдельную копию **/srv/backup/db.dump** и остальные файлы не трогай.",
            setup: async (w) => {
              await w.write("/srv/data/db.dump", bytes(16384));
              await w.fs.link("/srv/data/db.dump", "/srv/old/db.dump.1");
              await w.fs.link("/srv/data/db.dump", "/srv/tmp/.restore.tmp");
              await w.write("/srv/backup/db.dump", bytes(16384));
              await w.write("/srv/data/keep.sql", "-- schema\n");
              inoAtSetup.set(w, ino(w, "/srv/data/db.dump"));
            },
            check: async ({ world }) => {
              const n = inoAtSetup.get(world);
              const left: string[] = [];
              for (const p of world.subtree("/srv"))
                if ((await world.info(p))?.isFile && ino(world, p) === n && p !== "/srv/backup/db.dump") left.push(p);
              if (left.length === 0) return true;
              if (!left.includes("/srv/data/db.dump")) return `Имя db.dump удалено, но у файла ещё остались имена: ${left.join(", ")}.`;
              return false;
            },
            hint: "Найди имена по номеру inode — и удали найденное тем же find.",
            solution: "find /srv -xdev -inum $(stat -c %i /srv/data/db.dump) -delete",
            accept: ["rm /srv/data/db.dump /srv/old/db.dump.1 /srv/tmp/.restore.tmp", "find /srv -xdev -samefile /srv/data/db.dump\nrm /srv/data/db.dump /srv/old/db.dump.1 /srv/tmp/.restore.tmp"],
            reject: ["rm /srv/data/db.dump /srv/old/db.dump.1"],
            explain:
              "Данные освобождаются, когда у inode не осталось имён. По имени их не найти — третье называется `.restore.tmp`. `find -inum … -delete` удаляет ровно имена этого inode, а копию с тем же именем не трогает.",
          },
        ],
      },
      {
        id: "4",
        title: "На подумать: ссылки с подвохом",
        exercises: [
          {
            id: "links-4-01",
            type: "terminal",
            theory: "switch",
            prompt:
              "Ссылка **/srv/app/previous** на `releases/v1` больше не нужна. Удали её. Сам релиз v1 и остальное не трогай — v1 ещё понадобится для разбора.",
            setup: releases,
            check: async ({ world }) => !(await world.info("/srv/app/previous")),
            hint: "Подумай, что значит слэш на конце для ссылки на каталог.",
            solution: "rm /srv/app/previous",
            accept: ["unlink /srv/app/previous", "cd /srv/app\nrm previous"],
            reject: ["rm -rf /srv/app/releases/v1\nrm /srv/app/previous"],
            explain:
              "`rm -r previous/` прошёл бы **по** ссылке: удалил бы всё содержимое v1 и напоследок ответил `Not a directory`, оставив саму ссылку. Ссылку удаляют без слэша — `rm` или `unlink`.",
          },
          {
            id: "links-4-02",
            type: "choice",
            kind: "predict",
            theory: "symlink",
            prompt: "Что выведет `cat`?",
            code: "$ cd /srv/app\n$ ln -s app.conf /tmp/app.conf\n$ cat /tmp/app.conf",
            options: [
              "`cat: /tmp/app.conf: Too many levels of symbolic links`",
              "Содержимое /srv/app/app.conf",
              "`cat: /tmp/app.conf: No such file or directory`",
              "Ничего: ссылка на саму себя пуста",
            ],
            answer: 0,
            explain:
              "В ссылке записано `app.conf`, а относительный путь считается от каталога ссылки — `/tmp/app.conf`, то есть от неё самой. Ядро бросает разыменование после 40 переходов: ELOOP.",
          },
          {
            id: "links-4-03",
            type: "choice",
            kind: "bug",
            theory: "symlink",
            prompt: "Скрипт деплоя должен падать, если ссылка на конфиг битая. Но он пишет «config OK» и при битой ссылке. Почему?",
            code: '#!/bin/bash\ncfg=/etc/app.d/10-main.conf\nif readlink -f "$cfg" > /dev/null; then\n  echo "config OK"\nelse\n  echo "broken link" >&2; exit 1\nfi',
            options: [
              "`readlink -f` выдаёт путь и код 0, даже если последнего компонента нет; нужен `readlink -e`",
              "Вывод ушёл в /dev/null, а `if` проверяет вывод, а не код возврата",
              "`readlink` без `-n` всегда завершается с кодом 0",
              "Нужно `readlink -f $cfg` без кавычек",
            ],
            answer: 0,
            explain:
              "`-f` канонизирует путь и терпит отсутствие последнего компонента — для битой ссылки код 0. `-e` требует, чтобы существовало всё. `if` смотрит на код возврата, а не на вывод. Ещё вариант — `[ -e \"$cfg\" ]`: он тоже идёт по ссылке.",
          },
        ],
      },
    ],
    exam: {
      id: "exam",
      title: "Зачёт",
      exercises: [
        {
          id: "links-exam-01",
          type: "terminal",
          theory: "hard",
          prompt:
            "Сделай **/srv/share/robots.txt** вторым именем файла **/srv/www/robots.txt**, чтобы правки в одном месте сразу были видны в другом.",
          setup: async (w) => {
            await w.write("/srv/www/robots.txt", "User-agent: *\nDisallow: /admin\n");
            await w.mkdir("/srv/share");
          },
          check: async ({ world }) => {
            const i = await world.info("/srv/share/robots.txt");
            if (!i) return false;
            if (i.isLink) return "Это символическая ссылка, а нужен тот же inode.";
            return ino(world, "/srv/share/robots.txt") === ino(world, "/srv/www/robots.txt") || "Это копия — другой inode.";
          },
          hint: "Копия, даже cp -a, — уже другой файл. Нужно ещё одно имя этого.",
          solution: "ln /srv/www/robots.txt /srv/share/robots.txt",
          accept: ["cd /srv/share\nln /srv/www/robots.txt"],
          reject: ["cp -a /srv/www/robots.txt /srv/share/robots.txt"],
          explain: "Даже `cp -a` даёт новый inode. Второе имя того же файла — только `ln`.",
        },
        {
          id: "links-exam-02",
          type: "terminal",
          theory: "switch",
          prompt: "**/opt/tool/current** ведёт на `releases/2.4`. Переключи его на `releases/2.5`.",
          setup: async (w) => {
            await w.mkdir("/opt/tool/releases/2.4/bin");
            await w.mkdir("/opt/tool/releases/2.5/bin");
            await w.fs.symlink("releases/2.4", "/opt/tool/current");
          },
          check: async ({ world }) => {
            const stray = await strayLinks(world, "/opt/tool/releases");
            if (stray.length) return `Появилась ссылка ${stray[0]} внутри релиза: ln -sf зашёл в каталог за ссылкой.`;
            if (!(await isLink(world, "/opt/tool/current"))) return "current больше не ссылка.";
            return (await target(world, "/opt/tool/current")) === "/opt/tool/releases/2.5";
          },
          hint: "Ключ, который запрещает ln заходить в каталог за ссылкой.",
          solution: "ln -sfn releases/2.5 /opt/tool/current",
          accept: ["ln -sfT releases/2.5 /opt/tool/current"],
          reject: ["ln -sf releases/2.5 /opt/tool/current"],
          explain: "Без `-n` ln считает `current` каталогом и создаёт `releases/2.4/2.5`. `-sfn` заменяет саму ссылку.",
        },
        {
          id: "links-exam-03",
          type: "terminal",
          theory: "symlink",
          prompt:
            "В **/usr/local/bin** — ссылки на утилиты из /opt/tools. Некоторые утилиты удалили. Запиши в **/root/answer** полные пути битых ссылок из /usr/local/bin, по одному в строке. Ничего не удаляй — список нужен для тикета.",
          setup: async (w) => {
            for (const t of ["jq", "yq"]) await w.write(`/opt/tools/${t}/bin/${t}`, "#!/bin/bash\n", 0o755);
            await w.fs.symlink("/opt/tools/jq/bin/jq", "/usr/local/bin/jq");
            await w.fs.symlink("../../../opt/tools/yq/bin/yq", "/usr/local/bin/yq");
            await w.fs.symlink("/opt/tools/helm/bin/helm", "/usr/local/bin/helm");
            await w.fs.symlink("../../../opt/tools/kubectl/bin/kubectl", "/usr/local/bin/kubectl");
            await w.write("/usr/local/bin/backup.sh", "#!/bin/bash\n", 0o755);
          },
          check: async ({ world }) => {
            const a = await answer(world);
            if (a === null) return false;
            const got = lines(a).sort().join(" ");
            if (got === "/usr/local/bin/helm /usr/local/bin/kubectl") return true;
            if (got.includes("yq")) return "yq — относительная, но рабочая ссылка.";
            return "Список не тот: нужны ссылки, цель которых не найдена.";
          },
          hint: "find умеет отличать ссылки, которые после разыменования остаются ссылками.",
          solution: "find /usr/local/bin -xtype l > /root/answer",
          accept: ["printf '/usr/local/bin/helm\\n/usr/local/bin/kubectl\\n' > /root/answer"],
          reject: ["find /usr/local/bin -type l > /root/answer"],
          explain: "`-type l` — все ссылки, `-xtype l` — те, что после разыменования остались ссылками, то есть битые. Относительная ссылка `yq` рабочая.",
        },
        {
          id: "links-exam-04",
          type: "terminal",
          theory: "symlink",
          cwd: "/srv/www/shop",
          prompt:
            "Ты в **/srv/www/shop**. nginx в RHEL подключает всё из `/etc/nginx/conf.d/*.conf`, а конфиг сайта живёт вместе с сайтом. Подключи его: создай ссылку **/etc/nginx/conf.d/shop.conf** на **/srv/www/shop/nginx.conf**.",
          setup: async (w) => {
            await w.write("/srv/www/shop/nginx.conf", "server { listen 80; server_name shop; }\n");
            await w.write("/srv/www/blog/nginx.conf", "server { listen 80; server_name blog; }\n");
            await w.mkdir("/etc/nginx/conf.d");
            await w.fs.symlink("/srv/www/blog/nginx.conf", "/etc/nginx/conf.d/blog.conf");
          },
          check: async ({ world }) => {
            const p = "/etc/nginx/conf.d/shop.conf";
            if (!(await world.info(p))) return false;
            if (!(await isLink(world, p))) return "Это копия, а не ссылка: правки в /srv/www/shop/nginx.conf перестанут применяться.";
            const t = await target(world, p);
            if (t === null) return `Ссылка битая: «${await rawLink(world, p)}» считается от /etc/nginx/conf.d.`;
            return t === "/srv/www/shop/nginx.conf" || "Ссылка ведёт не туда.";
          },
          hint: "Куда будет считаться относительный путь, записанный в ссылку?",
          solution: "ln -s /srv/www/shop/nginx.conf /etc/nginx/conf.d/shop.conf",
          accept: ["ln -sr nginx.conf /etc/nginx/conf.d/shop.conf", "ln -s ../../../srv/www/shop/nginx.conf /etc/nginx/conf.d/shop.conf"],
          reject: ["ln -s nginx.conf /etc/nginx/conf.d/shop.conf", "cp nginx.conf /etc/nginx/conf.d/shop.conf"],
          explain:
            "`ln -s nginx.conf /etc/nginx/conf.d/shop.conf` записывает в ссылку `nginx.conf`, а ищется он рядом со ссылкой — `/etc/nginx/conf.d/nginx.conf`, которого нет. Нужен абсолютный путь или `ln -sr`, который сам посчитает `../../../srv/www/shop/nginx.conf`.",
        },
        {
          id: "links-exam-05",
          type: "terminal",
          theory: "switch",
          prompt:
            "Сайт переехал, ссылка **/var/www/current** (на `/srv/www/releases/v7`) больше не нужна. Удали ссылку, файлы релиза v7 оставь.",
          setup: async (w) => {
            await w.write("/srv/www/releases/v7/index.html", "<h1>v7</h1>\n");
            await w.write("/srv/www/releases/v7/app.js", "console.log(7)\n");
            await w.fs.symlink("/srv/www/releases/v7", "/var/www/current");
          },
          check: async ({ world }) => !(await world.info("/var/www/current")),
          hint: "Слэш на конце имени ссылки меняет всё.",
          solution: "unlink /var/www/current",
          accept: ["rm /var/www/current"],
          reject: ["rm -rf /var/www/current/\nrm /var/www/current"],
          explain: "`rm -r current/` идёт по ссылке и чистит релиз. Без слэша `rm` и `unlink` удаляют только саму ссылку.",
        },
      ],
    },
  },
  GUARDS,
);
