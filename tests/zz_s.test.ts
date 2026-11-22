import { it } from "vitest";
import { createServer, Shell } from "../src/engine/shell";
import { readFileSync } from "fs";
it("x", async () => {
  const s = new Shell(await createServer(), {user:"root"});
  const cmds = readFileSync("/tmp/claude-0/s/cmds.txt","utf8").split("\n").filter(Boolean);
  const out:string[]=[];
  for (const c of cmds) { const r = await s.run(c); out.push("$ "+c+"\n"+r.out.replace(/\x1b\[[0-9;]*m/g,"")); }
  console.log(out.join(""));
});
