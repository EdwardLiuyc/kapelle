/**
 * The pop-up's top border — `chat/tui/panel.ts`, story M7-4 (#247) — and
 * the setup race guards (M9-3, #298).
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { HarnessesReply } from "../../client/contract.ts";
import type { DaemonAddress } from "../../client/daemon.ts";
import { until } from "../../integration/helpers.ts";
import { yellow } from "../common.ts";
import { border, panelParts } from "../tui/panel.ts";

test("the top border keeps its corner and the title's start at any width, and the count gives way first (M7-4)", () => {
  const title = "asker wants to edit";
  const plain = (t: string, right: string | undefined, width: number) =>
    stripTerminalSequences(border(t, right, width, yellow));
  assert.equal(
    plain(title, "1 of 2", 40),
    `┏ ${title} ${"━".repeat(8)} 1 of 2 ━┓`,
  );
  assert.equal(plain(title, undefined, 30), `┏ ${title} ${"━".repeat(7)}┓`);
  // Too narrow for both: the count goes, and a cut title says so.
  assert.equal(plain(title, "1 of 2", 15), "┏ asker wan… ━┓");
  assert.equal(plain(title, "1 of 2", 10), "┏ aske… ━┓");
  for (let width = 10; width <= 80; width += 1) {
    for (const right of [undefined, "1 of 2", "10 of 12"]) {
      const line = border(title, right, width, yellow);
      assert.equal(visibleWidth(line), width, `${width} ${right}: ${line}`);
      assert.ok(plain(title, right, width).startsWith("┏ a"), line);
    }
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}

const reply = (done = false): HarnessesReply => ({
  checkedAt: "now",
  done,
  harnesses: [
    {
      id: "pi",
      measured: true,
      state: "ready",
      program: "pi",
      version: "1.3.0",
      acpProgram: "pi-acp",
      acpVersion: "0.0.34",
    },
    {
      id: "claude",
      measured: true,
      state: "main_only",
      program: "claude",
      version: "2.1.307",
      acpProgram: "claude-agent-acp",
      install: "npm i -g @agentclientprotocol/claude-agent-acp@0.89.1",
    },
  ],
});

/** The same find after the fake install put claude-agent-acp in place. */
const installedReply = (): HarnessesReply => ({
  checkedAt: "now",
  done: false,
  harnesses: [
    {
      id: "claude",
      measured: true,
      state: "ready",
      program: "claude",
      version: "2.1.307",
      acpProgram: "claude-agent-acp",
      acpVersion: "0.89.1",
    },
  ],
});

async function fakeDaemon(
  t: TestContext,
  {
    holdGet = false,
    holdDone = false,
    holdPost = false,
    holdInstall = false,
  } = {},
) {
  const getSeen = deferred();
  const getRelease = deferred();
  const doneSeen = deferred();
  const doneRelease = deferred();
  const postRelease = deferred();
  const installSeen = deferred();
  const installRelease = deferred();
  let installBody: unknown;
  let posts = 0;
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method === "GET" && req.url === "/harnesses") {
        getSeen.resolve();
        if (holdGet) await getRelease.promise;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(reply()));
        return;
      }
      if (req.method === "POST" && req.url === "/harnesses") {
        posts++;
        if (holdPost) await postRelease.promise;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(reply()));
        return;
      }
      if (req.method === "POST" && req.url === "/harnesses/done") {
        doneSeen.resolve();
        if (holdDone) await doneRelease.promise;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(reply(true)));
        return;
      }
      if (req.method === "POST" && req.url === "/harnesses/install") {
        let text = "";
        for await (const chunk of req) text += chunk;
        installBody = JSON.parse(text);
        installSeen.resolve();
        if (holdInstall) await installRelease.promise;
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.write(
          `${JSON.stringify({ id: "claude", command: "npm i -g x@1" })}\n`,
        );
        res.end(`${JSON.stringify({ failed: [], setup: installedReply() })}\n`);
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "no_route", message: "no" } }));
    })();
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  t.after(
    () =>
      new Promise<void>((ok) => {
        server.close(() => ok());
        server.closeAllConnections();
      }),
  );
  const d: DaemonAddress = {
    port: (server.address() as AddressInfo).port,
    token: "test",
  };
  return {
    d,
    getSeen,
    getRelease,
    doneSeen,
    doneRelease,
    postRelease,
    installSeen,
    installRelease,
    installBody: () => installBody,
    posts: () => posts,
  };
}

function makeBox(
  d: DaemonAddress,
  {
    onSay,
    onStatus,
  }: { onSay?: (text: string) => void; onStatus?: () => void } = {},
) {
  return panelParts({
    d,
    fresh: async () => {},
    tui: {
      showOverlay: () => ({ hide() {} }),
      setFocus() {},
      requestRender() {},
    },
    editor: {},
    queue: {
      asking: false,
      show() {},
      away: () => false,
    },
    rooms: new Map(),
    view: () => ({ roomId: "r" }),
    shown: () => true,
    say: onSay ?? (() => {}),
    setStatus: onStatus ?? (() => {}),
    offer() {},
    question() {},
    changes() {},
    forward() {},
    run: async () => true,
    end() {},
    left: () => "",
  } as unknown as Parameters<typeof panelParts>[0]);
}

test("startup still opens setup when the person has not touched it", async (t) => {
  const fake = await fakeDaemon(t);
  const box = makeBox(fake.d);
  await box.atStart();
  assert.equal(box.panel?.title, "agents");
  assert.equal(fake.posts(), 1);
});

test("a late startup reply does not reopen setup after a manual close", async (t) => {
  const fake = await fakeDaemon(t, { holdGet: true });
  const box = makeBox(fake.d);
  const starting = box.atStart();
  await fake.getSeen.promise;

  // The person opens /setup while the startup GET is pending, then closes it.
  await box.showSetup();
  assert.equal(box.panel?.title, "agents");
  box.hidePanel();
  assert.equal(box.panel, undefined);

  fake.getRelease.resolve();
  await starting;
  assert.equal(
    box.panel,
    undefined,
    "the late startup GET must not reopen setup after the person closed it",
  );
  assert.equal(fake.posts(), 1);
});

test("a stale done reply does not close a newer setup panel", async (t) => {
  const fake = await fakeDaemon(t, { holdDone: true });
  const box = makeBox(fake.d);
  await box.showSetup();
  assert.equal(box.panel?.title, "agents");

  const finishing = box.setupDone();
  await fake.doneSeen.promise;
  box.hidePanel();

  await box.showSetup();
  const newer = box.panel?.body;
  assert.ok(newer, "a newer setup panel is open");

  fake.doneRelease.resolve();
  await finishing;
  assert.equal(
    box.panel?.body,
    newer,
    "the earlier markDone answer must not close the newer setup panel",
  );

  // A direct /setup done still closes the current setup panel.
  await box.setupDone();
  assert.equal(box.panel, undefined);

  // A different panel with the same title is not a setup panel.
  const unrelated = { render: () => [], invalidate() {} };
  box.showPanel("agents", unrelated);
  const shown = box.panel;
  assert.ok(shown, "an unrelated panel titled agents is open");
  await box.setupDone();
  assert.equal(
    box.panel,
    shown,
    "an unrelated panel titled agents must not be closed",
  );
});

test("the start draws the reply it holds while the daemon finds again", async (t) => {
  const fake = await fakeDaemon(t, { holdPost: true });
  const box = makeBox(fake.d);
  const starting = box.atStart();
  // The GET's list shows at once, not "looking for agents…".
  for (let i = 0; i < 100 && fake.posts() === 0; i++) {
    await new Promise((ok) => setTimeout(ok, 10));
  }
  assert.equal(fake.posts(), 1);
  const lines = box.panel?.body.render(80).join("\n") ?? "";
  assert.match(lines, /pi +ready \(pi 1\.3\.0, pi-acp 0\.0\.34\)/);
  assert.doesNotMatch(lines, /looking for agents/);
  fake.postRelease.resolve();
  await starting;
  assert.equal(box.panel?.title, "agents");
});

test("an install that ends after Esc says so on the status line", async (t) => {
  const fake = await fakeDaemon(t, { holdInstall: true });
  const said: string[] = [];
  let statusCalls = 0;
  const box = makeBox(fake.d, {
    onSay: (text) => said.push(text),
    onStatus: () => {
      statusCalls++;
    },
  });
  await box.showSetup();
  const list = box.panel?.body;
  assert.ok(list, "the setup list is open");
  assert.match(list.render(80).join("\n"), /\[ \] claude/);
  list.handleInput?.(" ");
  assert.match(box.panel?.body.render(80).join("\n") ?? "", /\[x\] claude/);
  list.handleInput?.("\r");
  await fake.installSeen.promise;
  assert.deepEqual(fake.installBody(), { ids: ["claude"] });

  // The person hides the output; npm goes on, and the result must reach the
  // status line, not only a `say` the next status refresh may drop.
  box.hidePanel();
  const atHide = statusCalls;
  fake.installRelease.resolve();
  await until("the install's result", () =>
    said.some((s) => s.includes("setup: installed claude")),
  );
  assert.ok(
    statusCalls > atHide,
    "the status line is told the install ended after the panel is gone",
  );
});

test("the start does not open setup over a busy side view", async (t) => {
  const fake = await fakeDaemon(t);
  const box = makeBox(fake.d);
  await box.atStart(() => true);
  assert.equal(box.panel, undefined);
  assert.equal(fake.posts(), 0);
});
