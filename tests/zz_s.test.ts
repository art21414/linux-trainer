import { it } from "vitest";
import { createServer, Shell } from "../src/engine/shell";
it("x", async () => {
  const s = new Shell(await createServer(), {user:"root"});
  const out:string[]=[];
  for (const c of ["cd /tmp; echo hi > f; cp f /srv/nope/; ls /srv","echo A > s; echo B > d; chmod 600 d; chown bob d; stat -c '%a %U %i' d; cp s d; stat -c '%a %U %i' d; cat d","chmod 640 s; cp -p s d; stat -c '%a %U %i' d","touch -rf; touch -r f","mkdir -p /srv/app/releases/v2/conf; echo x > /srv/app/releases/v2/conf/c; ln -s releases/v2 /srv/app/current; cp -rL /srv/app/current /tmp/dst; ls -R /tmp/dst"]) {
    const r = await s.run(c); out.push("$ "+c+"\n"+r.out);
  }
  console.log(out.join(""));
});
