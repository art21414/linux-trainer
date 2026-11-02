import { it } from "vitest";
import { createServer, Shell } from "../src/engine/shell";

const cmds = [
  "cd /tmp && mkdir src && echo hi > src/a.txt && chmod 600 src/a.txt && touch -d '2020-01-02 03:04' src/a.txt && chown bob src/a.txt",
  "cd /tmp && ls -l src",
  "cd /tmp && cp -r src b1 && cp -r src b1 && ls -R b1",
  "cd /tmp && cp -a src b2 && ls -l b2",
  "cd /tmp && cp -p src/a.txt p.txt && ls -l p.txt",
  "cd /tmp && cp src/a.txt plain.txt && ls -l plain.txt",
  "cd /tmp && cp --preserve=mode,timestamps src/a.txt pm.txt && ls -l pm.txt",
  "cd /tmp && touch -r src/a.txt ref.txt && ls -l ref.txt",
  "cd /tmp && touch -d yesterday y.txt; echo $?; touch -t 202001020304 t.txt; echo $?; ls -l t.txt",
  "cd /tmp && mkdir g && cd g && touch -- -rf && ls && rm -rf; ls; rm -- -rf && ls -a",
  "cd /tmp/g && touch ./-x && rm ./-x && ls -a",
  "cd /tmp/g && touch -- -i && rm -i; echo $?",
  "cd /tmp/g && echo {1..3} && echo f{a,b}.log && echo *.nope && touch .hid v && echo * && shopt -s dotglob && echo *",
  "cd /tmp/g && touch f{1..3}.log && ls && rm f{1..5}.log; echo rc=$?; ls",
  "cd /tmp/g && touch x{1..3}.txt && rm x[1-2].txt && ls",
  "cd /tmp && ls -d g && ls -ld g && ls -ltr src b2 | head -3",
  "cd /tmp && echo 1234567890 > big && echo 1 > small && ls -S && ls -Sr && ls -lt",
  "DIR=; echo rm -rf \"$DIR\"/tmp",
  "cd /tmp && mkdir -p m/n && rm -I m; echo rc=$?; rm -r m && ls -d m",
  "cd /tmp && stat src/a.txt",
  "cd /tmp && mv src/a.txt src/b.txt && ls src",
  "cd /tmp && rmdir b1; echo rc=$?",
  "cd /tmp && cp -r src/ dst/ && ls dst",
  "cd /tmp && touch -m -d '2001-01-01' src/b.txt && ls -l src/b.txt && touch -a src/b.txt; echo rc=$?",
  "cd /tmp && ls -lu src; echo rc=$?; ls -lc src; echo rc=$?",
  "cd /tmp && shopt -s nullglob; echo z*.none; shopt -u nullglob; echo z*.none",
  "cd /tmp && set -u; echo ok",
  "cd /tmp && rm -rf \"$NOPE\"/nothing; echo rc=$?",
  "cd /tmp && ls -A g; ls -a g",
  "cd /tmp && cp -a src arch && cp -a src arch && ls arch",
  "cd /tmp && cp -rT src tt && ls tt",
  "cd /tmp && echo {a..c}{1,2} {01..03} {x,y}",
];

it("probe", async () => {
  const w = await createServer();
  const sh = new Shell(w, { user: "root" });
  for (const c of cmds) {
    const r = await sh.run(c);
    console.log("$ " + c + "\n" + r.out + `[code ${r.code}]\n`);
  }
});
