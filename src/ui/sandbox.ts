// Свободный терминал: живёт, пока открыто приложение. Кнопка ↺ — новый сервер.
import { createServer, Shell } from "../engine/shell";
import { logUnknown } from "../state/progress";
import { h } from "./dom";
import { reactToCommand } from "./lesson";
import { Mascot } from "./mascot";
import { navBar } from "./chrome";
import { TerminalView } from "./terminal";

let saved: { shell: Shell; term: TerminalView } | null = null;

const MOTD =
  "Activate the web console with: systemctl enable --now cockpit.socket\n\n" +
  `Last login: ${new Date(Date.now() - 3600_000).toDateString()} 08:12:44 from 10.0.2.2\n` +
  "─ Песочница: делай что хочешь, сервер не жалко.\n" +
  "─ Ты alice (есть sudo). Ещё есть bob и root.\n" +
  "─ TAB — дополнение, ↑ — история, exit — выйти из su.";

async function makeSession(): Promise<{ shell: Shell; term: TerminalView }> {
  const w = await createServer();
  const shell = new Shell(w, {
    user: "alice",
    onNotFound: (c) => logUnknown(c, shell.history.at(-1) ?? c, "notfound"),
    onUnsupported: (c) => logUnknown(c, shell.history.at(-1) ?? c, "unsupported"),
  });
  return { shell, term: new TerminalView(shell, { motd: MOTD }) };
}

export function renderSandbox(root: HTMLElement, go: (hash: string) => void): () => void {
  const mascot = new Mascot({ size: "sm" });
  const area = h("div", { class: "sandbox" });
  const reset = h("button", { class: "btn ghost small", style: { width: "auto", flex: "none" }, title: "Новый сервер" }, "↺ Сброс");
  area.append(h("div", { class: "sandbox-head" }, mascot.el, reset));
  root.append(h("div", { class: "screen" }, area, navBar("sandbox", go)));

  let current: TerminalView | null = null;
  const attach = (s: { shell: Shell; term: TerminalView }) => {
    current?.el.remove();
    current?.destroy();
    current = s.term;
    area.append(s.term.el);
    s.term.mount();
    s.term.onResult = (r) => reactToCommand(mascot, r);
  };

  void (async () => {
    saved ??= await makeSession();
    attach(saved);
    mascot.say("Это песочница. Ломай что хочешь — я потом подниму.", 4500);
  })();

  reset.onclick = async () => {
    saved = await makeSession();
    attach(saved);
    mascot.react("clear", "smug", false);
    mascot.say("Поднял новый сервер. С чистого листа.");
  };

  return () => {
    current?.destroy();
    current?.el.remove();
    mascot.destroy();
  };
}
