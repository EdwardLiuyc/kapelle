/**
 * Folder completion — `client/folder.ts`, story M4-5 (#181), and which disk
 * counts with a daemon address set (M11-5, #479).
 */

import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  rmdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { DaemonAddress } from "../daemon.ts";
import {
  absoluteFolder,
  completeDaemonFolder,
  completeFolder,
  expandHome,
  folderToSend,
} from "../folder.ts";

test("~ and ~/… are the home folder; nothing else changes", () => {
  assert.equal(expandHome("~"), homedir());
  assert.equal(expandHome("~/src"), `${homedir()}/src`);
  for (const p of ["~bob", "/a/~/b", "src"]) assert.equal(expandHome(p), p);
});

test("a bare ~ completes like ~/", () => {
  // The same folder, so the same value and the same names under it.
  assert.deepEqual(completeFolder("~", "/"), completeFolder("~/", "/"));
  assert.ok(completeFolder("~", "/").value.startsWith("~/"), "not ~/");
});

test("Tab completes folders only, as far as they agree", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "folder-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const d of ["agent-team", "agent-notes", "apps", ".hidden"]) {
    await mkdir(join(root, d));
  }
  await writeFile(join(root, "agent-file"), "");
  await symlink(join(root, "apps"), join(root, "apps-link"));
  await symlink(join(root, "gone"), join(root, "broken"));

  // Many: the shared part, and the folders that still match. Never a file.
  assert.deepEqual(completeFolder(`${root}/ag`, "/"), {
    value: `${root}/agent-`,
    options: ["agent-notes", "agent-team"],
  });
  // One: filled in, with a slash after it, ready for the next Tab.
  assert.deepEqual(completeFolder(`${root}/agent-t`, "/"), {
    value: `${root}/agent-team/`,
    options: [],
  });
  // A link to a folder counts; a broken one does not.
  assert.deepEqual(completeFolder(`${root}/app`, "/").options, [
    "apps",
    "apps-link",
  ]);
  assert.deepEqual(completeFolder(`${root}/br`, "/").options, []);
  // Hidden folders only when asked for.
  assert.deepEqual(completeFolder(`${root}/.h`, "/").value, `${root}/.hidden/`);
  assert.ok(!completeFolder(`${root}/`, "/").options.includes(".hidden"));
  // A relative path completes from `cwd`.
  assert.deepEqual(completeFolder("agent-t", root).value, "agent-team/");
  // No match, or no such folder: the text stays as typed.
  assert.deepEqual(completeFolder(`${root}/zz`, "/"), {
    value: `${root}/zz`,
    options: [],
  });
  assert.deepEqual(completeFolder(`${root}/nope/x`, "/"), {
    value: `${root}/nope/x`,
    options: [],
  });
});

test("a removed current folder gives no path, never a throw", async (t) => {
  const gone = await mkdtemp(join(tmpdir(), "folder-gone-"));
  const back = process.cwd();
  t.after(() => process.chdir(back));
  process.chdir(gone);
  await rmdir(gone);

  // `process.cwd()` throws here: only a full path still resolves.
  assert.equal(absoluteFolder(), undefined);
  assert.equal(absoluteFolder("sub"), undefined);
  assert.equal(absoluteFolder("/tmp/../tmp"), "/tmp");
  assert.equal(absoluteFolder("~"), homedir());
  assert.deepEqual(completeFolder("sub", absoluteFolder()), {
    value: "sub",
    options: [],
  });
});

test("a local daemon gets a full path from this disk; a remote one gets the text as typed (M11-5)", async (t) => {
  // Local: the folder `kapelle` was typed in, `~` from this home.
  assert.equal(folderToSend(undefined, false), process.cwd());
  assert.equal(folderToSend("sub", false), join(process.cwd(), "sub"));
  assert.equal(folderToSend("~/x", false), join(homedir(), "x"));
  // Remote: nothing is resolved here, and none is the daemon user's home.
  for (const typed of ["sub", "~/x", "/srv/app", "."]) {
    assert.equal(folderToSend(typed, true), typed);
  }
  assert.equal(folderToSend(undefined, true), "~");
  assert.equal(folderToSend("", true), "~");

  // A removed current folder matters only to a local daemon.
  const gone = await mkdtemp(join(tmpdir(), "folder-gone-"));
  const back = process.cwd();
  t.after(() => process.chdir(back));
  process.chdir(gone);
  await rmdir(gone);
  assert.equal(folderToSend(undefined, false), undefined);
  assert.equal(folderToSend("sub", true), "sub");
});

/** A daemon that answers `GET /folders` from a disk this machine lacks. */
async function remoteFolders(t: TestContext, status = 200) {
  const asked: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    asked.push(`${url.pathname} ${url.searchParams.get("path")}`);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        status === 200
          ? {
              path: "/srv/kapelle-remote-only",
              folders: [".cache", "agent-notes", "agent-team", "apps"],
            }
          : { error: { code: "invalid_request", message: "no such folder" } },
      ),
    );
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  t.after(() => server.close());
  const d: DaemonAddress = {
    port: (server.address() as AddressInfo).port,
    token: "key",
    fromClient: true,
  };
  return { d, asked };
}

test("a remote completion lists the daemon's folders, with the same rules as a local one (M11-5)", async (t) => {
  const { d, asked } = await remoteFolders(t);
  assert.deepEqual(await completeDaemonFolder(d, "~/src/ag"), {
    value: "~/src/agent-",
    options: ["agent-notes", "agent-team"],
  });
  assert.deepEqual(await completeDaemonFolder(d, "/srv/x/agent-t"), {
    value: "/srv/x/agent-team/",
    options: [],
  });
  assert.equal((await completeDaemonFolder(d, "/a/.c")).value, "/a/.cache/");
  assert.ok(!(await completeDaemonFolder(d, "/a/")).options.includes(".cache"));
  // A relative name lists the daemon user's home; a bare `~` is `~/`.
  assert.equal((await completeDaemonFolder(d, "ap")).value, "apps/");
  assert.equal((await completeDaemonFolder(d, "~")).options.length, 3);
  // Each folder went as typed, for the daemon to resolve.
  assert.deepEqual(asked, [
    "/folders ~/src/",
    "/folders /srv/x/",
    "/folders /a/",
    "/folders /a/",
    "/folders .",
    "/folders ~/",
  ]);
});

test("a refused or lost remote completion leaves the text as typed (M11-5)", async (t) => {
  const { d } = await remoteFolders(t, 400);
  assert.deepEqual(await completeDaemonFolder(d, "~/nope/x"), {
    value: "~/nope/x",
    options: [],
  });
  const lost: DaemonAddress = { port: 1, token: "key", fromClient: true };
  assert.deepEqual(await completeDaemonFolder(lost, "~/x"), {
    value: "~/x",
    options: [],
  });
});
