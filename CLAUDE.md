# linux-trainer — память проекта

Мобильное приложение для изучения Linux в формате Duolingo. Цель — база Linux до уровня mid-DevOps:
RHCSA (EX200) + cgroups, namespaces, systemd в глубину, сеть, диагностика, bash. Сотни уроков, тысячи заданий.
Учимся в электричке короткими сессиями по 5 минут: минимум текста, упор на практику.

**Перед работой прочитай:** `docs/roadmap.md` (что сделано и что дальше) и `docs/decisions.md` (почему так).
**В конце КАЖДОЙ сессии** обнови оба файла и запушь. Следующая сессия не помнит переписку — только эти файлы.

## Как работать с Артёмом
- Артём — junior DevOps. Код не пишет: Claude пишет всё, Артём тестирует и правит логику/формат. Общение на русском.
- Строго по шагам: разведка → короткий отчёт + план → «ок» от Артёма → выполнение. Не смешивать.
- Коротко и по делу, без простыней. Если нужно действие Артёма (настройки GitHub и т.п.) — точный путь по кнопкам.
- Артём присылает журнал неизвестных команд (Профиль → «Журнал неизвестных команд») — по нему добавляем команды.

## Стек и запуск
- Vite + TypeScript, без фреймворка (свой мини-хелпер `h()` в `src/ui/dom.ts`). PWA (манифест + `public/sw.js`).
- Хостинг: GitHub Pages, деплой `.github/workflows/deploy.yml` при пуше в `main` (сначала тесты, потом сборка).
- `npm run dev` — разработка, `npm test` — тесты (vitest), `npm run build` — typecheck + сборка в `dist/`.
- Адрес: https://art21414.github.io/linux-trainer/ (base в `vite.config.ts` = `/linux-trainer/`).
- Иконки: `node scripts/make-icons.mjs` (рисует из SVG Палыча, нужен Playwright).

## Архитектура
```
src/engine/        — симулятор сервера
  world.ts         — «мир»: пользователи, группы, владельцы (uid/gid), umask, проверка доступа,
                     «охраняемая» ФС (Proxy над InMemoryFs из just-bash)
  shell.ts         — Shell: сессия терминала (just-bash + мир), su-стек, история, Tab, createServer()
  commands/        — наши команды поверх just-bash: files.ts (ls, stat, cat), perms.ts (chmod, chown,
                     chgrp, umask), users.ts (id, useradd, usermod, su, sudo, ...), misc.ts (rm-защита,
                     uname, man, заглушки UNSUPPORTED)
src/content/       — уроки (units.ts), типы заданий (types.ts), фразы Палыча (palych.ts)
src/ui/            — экраны: home, lesson, finish, sandbox, profile; terminal.ts; mascot.ts (Палыч)
src/state/progress.ts — XP, стрик, цель дня, ошибки, журнал неизвестных команд, экспорт/импорт
tests/             — engine.test.ts (поведение команд), content.test.ts (каждое задание решаемо)
```

### Движок: главное
- **just-bash** даёт парсер bash, пайпы, перенаправления, переменные, ~70 текстовых утилит. Его ФС знает только mode.
- Владельцы/группы хранятся в `World.owners` (путь → uid/gid). Создание файлов через охраняемую ФС ставит
  владельца = текущий пользователь, права по umask, наследует группу у каталога с setgid.
- Проверка доступа: в охраняемой ФС (чтение/запись/создание/удаление) + в наших командах. root обходит r/w.
- Каждый `bash.exec` изолирован: cwd и переменные Shell переносит сам (`env.PWD`).
- Ошибки ФС вида `EACCES: permission denied, open '/x'` нормализуются в `Permission denied` (`normalizeErrors`).
- Вывод — как в Rocky Linux 9 (точка SELinux в `ls -l`, приглашение `[user@server1 dir]$`, тексты ошибок GNU).
- Неизвестная команда → `bash: X: command not found` + запись в журнал. Известная в RHEL, но не реализованная
  (список `UNSUPPORTED` в misc.ts) → «тренажёр её пока не умеет» + журнал.

### Как добавить команду
1. Написать `defineCommand("name", async (args, ctx) => ...)` в `src/engine/commands/*.ts`.
   Состояние брать из `World` (`w.info()`, `w.canAccess()`, `w.cur`...), путь — `resolve(ctx.cwd, arg)`.
   Опции — `parseArgs()` из util.ts. Ошибки — точные тексты из RHEL. Вывод — строки с `\n`.
2. Зарегистрировать в списке `custom` в `Shell` (shell.ts). Убрать из `UNSUPPORTED`, если была там.
3. Тест в `tests/engine.test.ts` с ожидаемым выводом как в настоящем Rocky.

## Контент
- Иерархия: раздел (Unit) → урок (Lesson, 3–5 минут, 6–9 заданий) → задания (Exercise).
- Типы заданий (`src/content/types.ts`): `theory` (карточка), `choice` (kind: choice/predict/bug),
  `fill` (пропуск `___`), `tiles` (сборка команды из плиток), `terminal` (проверка по состоянию мира).
- Задание `terminal`: `setup(world)` готовит сервер (права root, без проверок), `check({world, shell})`
  возвращает `true` / `false` / строку-подсказку «почти». **Проверяем состояние, а не текст команды**,
  чтобы любой правильный путь засчитывался. `solution` обязателен — тест прогоняет его.
- Ошибочные задания повторяются в конце урока. XP: 10 за урок + 5 без ошибок. Стрик — по дням.
- После добавления контента: `npm test` (проверит, что решения работают и стартовое состояние не решено).

## Палыч (талисман)
Старый сисадмин: майка RTFM, пузо, залысина, очки, кофе `>_`, сигарета. SVG в `src/ui/mascot.ts`,
анимации и настроения (idle/happy/angry/shock/think/smug/sleep) в `src/styles/mascot.css`.
Сам моргает, смотрит по сторонам, отхлёбывает кофе, затягивается, засыпает через минуту бездействия.
Реакции на команды — `reactToCommand()` в lesson.ts, фразы — `src/content/palych.ts` (пополнять смело).
