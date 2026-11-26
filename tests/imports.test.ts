/**
 * The import rules for the whole source tree (M12-2).
 *
 * `chat.ts` and `chat/` stay on the client side of the daemon, `protocol/`
 * stays below `core/`, and `client/` may depend only on itself and the wire
 * types. `cli.ts` is the composition root. `daemon.ts` and `daemon/` may use
 * `core/`, `protocol/`, `client/contract.ts` and daemon files, but never chat.
 * Tests and integration helpers are allowed to import anything.
 *
 * Inside `core/`, no file in `core/room/` imports `core/room.ts`, not even a
 * type: the agent parts work with no room (M12-8c). `core/chat.ts` does not
 * either: a chat is built from those parts, and is not a room (M11-12).
 *
 * The checker works on a graph so a made-up graph can prove each rule without
 * creating files. Declaration-level `import type` / `export type` edges are
 * erased at runtime; inline type specifiers still load their module under
 * `verbatimModuleSyntax`, so they remain runtime edges.
 *
 * The reader is lexical, not a TypeScript parser: an import-looking line in a
 * comment or string can invent an edge. That fails closed, and no source does
 * it today.
 */

import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import test from "node:test";

interface ImportEdge {
  spec: string;
  typeOnly: boolean;
}

type SourceGraph = Map<string, ImportEdge[]>;

const SOURCE_DIRS = ["protocol", "core", "client", "chat", "daemon"] as const;
const ROOT_SOURCE_FILES = [
  "chat.ts",
  "cli.ts",
  "daemon.ts",
  "render.ts",
] as const;
const ROOT_SOURCE_FILE_SET = new Set<string>(ROOT_SOURCE_FILES);
const EXEMPT_TOP_LEVEL = new Set([
  "integration",
  "tests",
  "node_modules",
  "dist",
]);

const toSlash = (path: string) => path.split(sep).join("/");

const targetOf = (
  file: string,
  spec: string | undefined,
): string | undefined => {
  if (!spec?.startsWith(".")) return undefined;
  const target = toSlash(join(dirname(file), spec));
  // NodeNext lets a `.js` specifier name a `.ts` source. Map it back, so
  // every rule sees the file it reaches. This assumes no source is a `.js`
  // file: the walk reads only `.ts` (`sourceFiles`), and none exists today.
  if (target.endsWith(".js")) return `${target.slice(0, -3)}.ts`;
  return target;
};

/** Comments are legal between the tokens of an import; they are not tokens. */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

/** True only for a declaration-level `import type` or `export type` clause. */
const typeOnlyClause = (clause: string): boolean => {
  const clean = withoutComments(clause).trim();
  if (!/^type(?:\s|$)/.test(clean)) return false;
  const rest = clean.slice(4).trim();
  // `import type from` and `import type, { A }` import a value named `type`.
  // Inline type specifiers such as `{ type A }` still load the module.
  return rest !== "" && !rest.startsWith(",") && !/^from(?:\s|$)/.test(rest);
};

const importsOf = (source: string): ImportEdge[] => {
  // `export … from` and a bare `import "x"` load a module too. A literal
  // `import("x")` loads one when it runs, so it gets the same check.
  const staticImports = [
    ...source.matchAll(
      /^[ \t]*(?:(import|export)([^;]*?)\bfrom|import) (["'])([^"']+)\3;/gms,
    ),
  ].map((m) => {
    const clause = m[2] ?? "";
    return {
      spec: m[4] ?? "",
      typeOnly: typeOnlyClause(clause),
    };
  });
  const dynamicImports = [
    ...source.matchAll(/\bimport\s*\(\s*(["'`])([^"'`]+)\1\s*\)/g),
  ].map((m) => ({ spec: m[2], typeOnly: false }));
  return [...staticImports, ...dynamicImports];
};

// A test helper has no recovery path; the test runner reports the read error.
// The walk and its coverage check are one invariant.
// pi-lens-ignore: unsafe-boundary, high-complexity, high-fan-out
const sourceFiles = async (root: string): Promise<string[]> => {
  const files: string[] = [];
  const unexpected: string[] = [];
  for (const dir of SOURCE_DIRS) {
    for (const entry of await readdir(join(root, dir), {
      withFileTypes: true,
      recursive: true,
    })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const file = toSlash(relative(root, join(entry.parentPath, entry.name)));
      if (file.split("/").includes("tests")) continue;
      files.push(file);
    }
  }

  const rootEntries = await readdir(root, { withFileTypes: true });
  for (const entry of rootEntries) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    if (!ROOT_SOURCE_FILE_SET.has(entry.name)) unexpected.push(entry.name);
    else files.push(entry.name);
  }

  for (const entry of rootEntries) {
    if (!entry.isDirectory()) continue;
    // Tool worktrees and probe homes are local dot-directories, not source.
    if (entry.name.startsWith(".")) continue;
    if (SOURCE_DIRS.some((dir) => dir === entry.name)) continue;
    if (EXEMPT_TOP_LEVEL.has(entry.name)) continue;
    for (const nested of await readdir(join(root, entry.name), {
      withFileTypes: true,
      recursive: true,
    })) {
      if (!nested.isFile() || !nested.name.endsWith(".ts")) continue;
      unexpected.push(
        toSlash(relative(root, join(nested.parentPath, nested.name))),
      );
    }
  }

  if (unexpected.length) {
    throw new Error(
      `unexpected top-level source: ${unexpected.sort().join(", ")}`,
    );
  }
  return files.sort();
};

const sourceGraph = async (root: string): Promise<SourceGraph> => {
  const graph: SourceGraph = new Map();
  for (const file of await sourceFiles(root)) {
    graph.set(file, importsOf(await readFile(join(root, file), "utf8")));
  }
  return graph;
};

const runtimeCycle = (graph: SourceGraph): string[] | undefined => {
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (file: string): string[] | undefined => {
    state.set(file, 1);
    stack.push(file);
    for (const edge of graph.get(file) ?? []) {
      if (edge.typeOnly) continue;
      const target = targetOf(file, edge.spec);
      if (!target || !graph.has(target) || state.get(target) === 2) continue;
      if (state.get(target) === 1) {
        return [...stack.slice(stack.indexOf(target)), target];
      }
      const found = visit(target);
      if (found) return found;
    }
    stack.pop();
    state.set(file, 2);
    return undefined;
  };
  for (const file of graph.keys()) {
    if (state.has(file)) continue;
    const found = visit(file);
    if (found) return found;
  }
  return undefined;
};

type TopLevelSource = "cli.ts" | "daemon.ts" | `daemon/${string}`;

const isTopLevel = (file: string): file is TopLevelSource =>
  file === "cli.ts" || file === "daemon.ts" || file.startsWith("daemon/");

const hasRule = (file: string): boolean =>
  file === "chat.ts" ||
  file.startsWith("chat/") ||
  isTopLevel(file) ||
  file === "render.ts" ||
  file.startsWith("protocol/") ||
  file.startsWith("core/") ||
  file.startsWith("client/");

const topLevelViolation = (
  file: TopLevelSource,
  target: string | undefined,
): string | undefined => {
  if (file === "cli.ts") {
    if (target === undefined) return "cli.ts may not import packages";
    if (
      target === "chat.ts" ||
      target === "daemon.ts" ||
      target === "render.ts" ||
      target.startsWith("client/") ||
      target.startsWith("core/") ||
      target.startsWith("protocol/")
    ) {
      return undefined;
    }
    return "cli.ts may import only client/, core/, protocol/, render.ts, chat.ts and daemon.ts";
  }

  if (target === undefined) return "daemon may not import packages";
  if (
    target.startsWith("daemon/") ||
    target.startsWith("core/") ||
    target.startsWith("protocol/") ||
    target === "client/contract.ts"
  ) {
    return undefined;
  }
  return "daemon may import only daemon/, core/, protocol/ and client/contract.ts";
};

// Keeping the rule branches together makes the rule book readable.
// pi-lens-ignore: high-complexity
const checkGraph = (graph: SourceGraph): string[] => {
  const problems: string[] = [];
  for (const [file, edges] of graph) {
    if (!hasRule(file)) {
      problems.push(`no rule covers ${file}`);
      continue;
    }
    for (const edge of edges) {
      const target = targetOf(file, edge.spec);
      const fail = (reason: string) =>
        problems.push(`${file} imports ${edge.spec}: ${reason}`);

      // M12-8c: the agent parts work with no room, so they name none, not
      // even for a type.
      if (file.startsWith("core/room/") && target === "core/room.ts") {
        fail("core/room/ may not import core/room.ts");
        continue;
      }
      // M11-12: a chat is built from those parts, and is not a room.
      if (file === "core/chat.ts" && target === "core/room.ts") {
        fail("core/chat.ts may not import core/room.ts");
        continue;
      }
      if (edge.typeOnly) continue;
      if (edge.spec.startsWith("node:")) continue;

      if (file === "chat.ts" || file.startsWith("chat/")) {
        if (target === undefined) {
          // AGENTS.md names the deep key reader and xterm exceptions.
          const key = "@earendil-works/pi-tui/dist/keys.js";
          const allowed =
            edge.spec === "@earendil-works/pi-tui" ||
            (edge.spec === key && file === "chat/tui/question.ts") ||
            (edge.spec === "@xterm/headless" && file === "chat/tui/term.ts");
          if (!allowed) fail("chat may use only its named packages");
          continue;
        }
        if (target === "chat.ts") {
          fail("chat must not import chat.ts; it runs main()");
          continue;
        }
        if (
          target.startsWith("chat/") ||
          target.startsWith("client/") ||
          target === "core/runtime.ts"
        ) {
          continue;
        }
        fail("chat may use only client/, pi-tui and core/runtime.ts");
        continue;
      }

      if (isTopLevel(file)) {
        const reason = topLevelViolation(file, target);
        if (reason) fail(reason);
        continue;
      }

      if (file === "render.ts") {
        if (target === undefined) {
          fail("render.ts may not import packages");
        } else if (target !== "core/markdown.ts" && target !== "core/text.ts") {
          fail("render.ts may import only its named core files");
        }
        continue;
      }

      if (file.startsWith("protocol/")) {
        if (target === undefined) {
          fail("protocol/ may not import packages");
        } else if (!target.startsWith("protocol/")) {
          fail("protocol/ may import only protocol/");
        }
      } else if (file.startsWith("core/")) {
        if (target === undefined) {
          // AGENTS.md names core/markdown.ts as marked's owner.
          if (file !== "core/markdown.ts" || edge.spec !== "marked") {
            fail("core/ may not import this package");
          }
        } else if (
          !target.startsWith("core/") &&
          !target.startsWith("protocol/")
        ) {
          fail("core/ may import only core/ or protocol/");
        }
      } else if (file.startsWith("client/")) {
        if (target === undefined) {
          fail("client/ may not import packages");
        } else if (
          !target.startsWith("client/") &&
          target !== "protocol/types.ts"
        ) {
          fail("client/ may import only client/ and protocol/types.ts");
        }
      }
    }
  }
  const cycle = runtimeCycle(graph);
  if (cycle) problems.push(`runtime import loop: ${cycle.join(" -> ")}`);
  return problems;
};

const makeGraph = (
  entries: Record<string, [string, boolean?][]>,
): SourceGraph =>
  new Map(
    Object.entries(entries).map(([file, edges]) => [
      file,
      edges.map(([spec, typeOnly = false]) => ({ spec, typeOnly })),
    ]),
  );

test("the whole source tree follows the import rules", async () => {
  const graph = await sourceGraph(join(import.meta.dirname, ".."));
  for (const dir of SOURCE_DIRS) {
    assert.ok(
      [...graph.keys()].some((file) => file.startsWith(`${dir}/`)),
      `the walk reached ${dir}/`,
    );
  }
  assert.ok(graph.has("chat.ts"), "the walk reached chat.ts");
  assert.ok(graph.has("render.ts"), "the walk reached render.ts");
  assert.deepEqual(checkGraph(graph), []);
});

test("the source walk rejects uncovered top-level sources", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kapelle-imports-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of SOURCE_DIRS) await mkdir(join(root, dir));
  for (const file of ROOT_SOURCE_FILES) await writeFile(join(root, file), "");
  await mkdir(join(root, "widgets"));
  await writeFile(join(root, "widgets", "a.ts"), "");
  await writeFile(join(root, "extra.ts"), "");
  await assert.rejects(
    sourceFiles(root),
    /unexpected top-level source: extra\.ts, widgets\/a\.ts/,
  );
});

test("the source walk ignores top-level dot-directories", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kapelle-imports-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of SOURCE_DIRS) await mkdir(join(root, dir));
  for (const file of ROOT_SOURCE_FILES) await writeFile(join(root, file), "");
  await mkdir(join(root, ".claude", "worktrees", "agent"), {
    recursive: true,
  });
  await writeFile(
    join(root, ".claude", "worktrees", "agent", "checkout.ts"),
    "",
  );
  assert.deepEqual(await sourceFiles(root), [...ROOT_SOURCE_FILES].sort());
});

test("the checker rejects a source file with no rule", () => {
  const graph = makeGraph({
    "worker.ts": [["./core/run.ts"]],
    "core/run.ts": [],
  });
  assert.deepEqual(checkGraph(graph), ["no rule covers worker.ts"]);
});

test("the source reader keeps a mixed type/value import at runtime", () => {
  const source = `
    import type { A } from "./a.ts";
    import { type B, c } from "./b.ts";
    export type { D } from "./d.ts";
    void import("./e.ts");
  `;
  assert.deepEqual(importsOf(source), [
    { spec: "./a.ts", typeOnly: true },
    { spec: "./b.ts", typeOnly: false },
    { spec: "./d.ts", typeOnly: true },
    { spec: "./e.ts", typeOnly: false },
  ]);
});

test("the source reader keeps an all-type named import at runtime", () => {
  assert.deepEqual(importsOf('import { type A } from "./a.ts";'), [
    { spec: "./a.ts", typeOnly: false },
  ]);
  assert.deepEqual(importsOf('export { type A, type B } from "./b.ts";'), [
    { spec: "./b.ts", typeOnly: false },
  ]);
});

test("the source reader keeps a value import named type at runtime", () => {
  assert.deepEqual(importsOf('import type from "./a.ts";'), [
    { spec: "./a.ts", typeOnly: false },
  ]);
  assert.deepEqual(importsOf('import type, { A } from "./b.ts";'), [
    { spec: "./b.ts", typeOnly: false },
  ]);
  assert.deepEqual(importsOf('import { type as foo } from "./c.ts";'), [
    { spec: "./c.ts", typeOnly: false },
  ]);
  assert.deepEqual(importsOf('export { type as foo } from "./d.ts";'), [
    { spec: "./d.ts", typeOnly: false },
  ]);
});

test("the source reader ignores comments without changing the module load", () => {
  assert.deepEqual(importsOf('import { /* reason */ type A } from "./a.ts";'), [
    { spec: "./a.ts", typeOnly: false },
  ]);
  assert.deepEqual(importsOf('import type /* reason */ { A } from "./b.ts";'), [
    { spec: "./b.ts", typeOnly: true },
  ]);
  assert.deepEqual(importsOf('import /* reason */ type { A } from "./b.ts";'), [
    { spec: "./b.ts", typeOnly: true },
  ]);
  assert.deepEqual(importsOf('import type /* reason */ from "./c.ts";'), [
    { spec: "./c.ts", typeOnly: false },
  ]);
});

test("the source reader accepts single-quoted static imports", () => {
  const source = "import { A } from './a.ts';\nexport { B } from './b.ts';";
  assert.deepEqual(importsOf(source), [
    { spec: "./a.ts", typeOnly: false },
    { spec: "./b.ts", typeOnly: false },
  ]);
});

test("the checker rejects each layer rule", () => {
  const cases: [string, SourceGraph, string][] = [
    [
      "protocol",
      makeGraph({
        "protocol/a.ts": [["../core/b.ts"]],
        "core/b.ts": [],
      }),
      "protocol/a.ts imports ../core/b.ts: protocol/ may import only protocol/",
    ],
    [
      "core",
      makeGraph({
        "core/a.ts": [["../client/b.ts"]],
        "client/b.ts": [],
      }),
      "core/a.ts imports ../client/b.ts: core/ may import only core/ or protocol/",
    ],
    [
      "client",
      makeGraph({
        "client/a.ts": [["../core/b.ts"]],
        "core/b.ts": [],
      }),
      "client/a.ts imports ../core/b.ts: client/ may import only client/ and protocol/types.ts",
    ],
    [
      "chat.ts",
      makeGraph({
        "chat.ts": [["./core/b.ts"]],
        "core/b.ts": [],
      }),
      "chat.ts imports ./core/b.ts: chat may use only client/, pi-tui and core/runtime.ts",
    ],
    [
      "chat/",
      makeGraph({
        "chat/tui/a.ts": [["../../core/b.ts"]],
        "core/b.ts": [],
      }),
      "chat/tui/a.ts imports ../../core/b.ts: chat may use only client/, pi-tui and core/runtime.ts",
    ],
    [
      "chat entry",
      makeGraph({
        "chat/tui/a.ts": [["../../chat.ts"]],
        "chat.ts": [],
      }),
      "chat/tui/a.ts imports ../../chat.ts: chat must not import chat.ts; it runs main()",
    ],
    [
      "cli.ts",
      makeGraph({
        "cli.ts": [["./chat/tui.ts"]],
        "chat/tui.ts": [],
      }),
      "cli.ts imports ./chat/tui.ts: cli.ts may import only client/, core/, protocol/, render.ts, chat.ts and daemon.ts",
    ],
    [
      "daemon.ts",
      makeGraph({
        "daemon.ts": [["./chat/tui.ts"]],
        "chat/tui.ts": [],
      }),
      "daemon.ts imports ./chat/tui.ts: daemon may import only daemon/, core/, protocol/ and client/contract.ts",
    ],
    [
      "daemon/",
      makeGraph({
        "daemon/a.ts": [["../client/daemon.ts"]],
        "client/daemon.ts": [],
      }),
      "daemon/a.ts imports ../client/daemon.ts: daemon may import only daemon/, core/, protocol/ and client/contract.ts",
    ],
  ];
  for (const [name, graph, expected] of cases) {
    assert.deepEqual(checkGraph(graph), [expected], `${name} rule`);
  }
});

test("the checker rejects a package outside a named exception", () => {
  const cases: [SourceGraph, string][] = [
    [
      makeGraph({ "client/a.ts": [["marked"]] }),
      "client/a.ts imports marked: client/ may not import packages",
    ],
    [
      makeGraph({ "protocol/a.ts": [["marked"]] }),
      "protocol/a.ts imports marked: protocol/ may not import packages",
    ],
    [
      makeGraph({ "core/a.ts": [["marked"]] }),
      "core/a.ts imports marked: core/ may not import this package",
    ],
    [
      makeGraph({ "chat/tui/a.ts": [["marked"]] }),
      "chat/tui/a.ts imports marked: chat may use only its named packages",
    ],
    [
      makeGraph({ "cli.ts": [["marked"]] }),
      "cli.ts imports marked: cli.ts may not import packages",
    ],
    [
      makeGraph({ "daemon.ts": [["marked"]] }),
      "daemon.ts imports marked: daemon may not import packages",
    ],
    [
      makeGraph({ "daemon/a.ts": [["marked"]] }),
      "daemon/a.ts imports marked: daemon may not import packages",
    ],
  ];
  for (const [graph, expected] of cases) {
    assert.deepEqual(checkGraph(graph), [expected]);
  }
});

test("the named exceptions belong to their named file", () => {
  const allowed = makeGraph({
    "render.ts": [
      ["./core/markdown.ts"],
      ["./core/text.ts"],
      ["./protocol/types.ts", true],
    ],
    "core/markdown.ts": [["marked"]],
    "core/text.ts": [],
    "protocol/types.ts": [],
    "chat/tui/question.ts": [
      ["@earendil-works/pi-tui"],
      ["@earendil-works/pi-tui/dist/keys.js"],
      ["../../client/daemon.ts"],
      ["../../core/runtime.ts"],
    ],
    "chat/tui/term.ts": [["@xterm/headless"]],
    "client/daemon.ts": [["../protocol/types.ts"]],
    "core/runtime.ts": [],
  });
  assert.deepEqual(checkGraph(allowed), []);

  const wrongFile = makeGraph({
    "chat/tui/panel.ts": [["@earendil-works/pi-tui/dist/keys.js"]],
    "chat/tui/theme.ts": [["@xterm/headless"]],
    "render.ts": [["./client/daemon.ts"]],
    "client/daemon.ts": [],
  });
  assert.deepEqual(checkGraph(wrongFile), [
    "chat/tui/panel.ts imports @earendil-works/pi-tui/dist/keys.js: chat may use only its named packages",
    "chat/tui/theme.ts imports @xterm/headless: chat may use only its named packages",
    "render.ts imports ./client/daemon.ts: render.ts may import only its named core files",
  ]);
});

test("the top-level entries may import their actual lower layers", () => {
  const allowed = makeGraph({
    "cli.ts": [
      ["./client/command.ts"],
      ["./client/contract.ts"],
      ["./core/run.ts"],
      ["./protocol/types.ts"],
      ["./render.ts"],
      ["./chat.ts"],
      ["./daemon.ts"],
    ],
    "daemon.ts": [["./daemon/main.ts"]],
    "daemon/app.ts": [
      ["../client/contract.ts"],
      ["../core/run.ts"],
      ["../protocol/registry.ts"],
      ["./http.ts"],
    ],
    "client/command.ts": [],
    "client/contract.ts": [],
    "core/run.ts": [],
    "protocol/types.ts": [],
    "render.ts": [],
    "chat.ts": [],
    "daemon/main.ts": [],
    "daemon/http.ts": [],
  });
  assert.deepEqual(checkGraph(allowed), []);
});

test("the checker rejects a core/room/ import of core/room.ts, type-only too", () => {
  const graph = makeGraph({
    "core/room.ts": [["./room/a.ts"]],
    "core/room/a.ts": [["../room.ts", true]],
    "core/room/b.ts": [["../room.ts"], ["./a.ts"]],
    "core/room/c.ts": [["../room.js", true]],
    "core/room/d.ts": [["../room.js"]],
  });
  assert.deepEqual(checkGraph(graph), [
    "core/room/a.ts imports ../room.ts: core/room/ may not import core/room.ts",
    "core/room/b.ts imports ../room.ts: core/room/ may not import core/room.ts",
    "core/room/c.ts imports ../room.js: core/room/ may not import core/room.ts",
    "core/room/d.ts imports ../room.js: core/room/ may not import core/room.ts",
  ]);
});

test("the checker rejects a core/chat.ts import of core/room.ts, type-only too", () => {
  const graph = makeGraph({
    "core/room.ts": [],
    "core/chat.ts": [["./room.ts", true], ["./room/member.ts"]],
    "core/room/member.ts": [],
  });
  assert.deepEqual(checkGraph(graph), [
    "core/chat.ts imports ./room.ts: core/chat.ts may not import core/room.ts",
  ]);
});

test("type-only imports stay allowed", () => {
  const graph = makeGraph({
    "chat/tui/a.ts": [["../../core/b.ts", true]],
    "protocol/a.ts": [["../core/b.ts", true]],
    "core/b.ts": [
      ["../client/c.ts", true],
      ["marked", true],
    ],
    "client/c.ts": [],
  });
  assert.deepEqual(checkGraph(graph), []);
});

test("the checker rejects a runtime loop", () => {
  const graph = makeGraph({
    "core/a.ts": [["./b.ts"]],
    "core/b.ts": [["./a.ts"]],
  });
  assert.deepEqual(checkGraph(graph), [
    "runtime import loop: core/a.ts -> core/b.ts -> core/a.ts",
  ]);
});

test("a runtime edge named type still makes a loop", () => {
  const graph: SourceGraph = new Map([
    ["core/a.ts", importsOf('import { type as foo } from "./b.ts"; void foo;')],
    ["core/b.ts", importsOf('import { a } from "./a.ts"; void a;')],
  ]);
  assert.deepEqual(checkGraph(graph), [
    "runtime import loop: core/a.ts -> core/b.ts -> core/a.ts",
  ]);
});

test("an inline type specifier still makes a runtime loop", () => {
  const graph: SourceGraph = new Map([
    ["core/a.ts", importsOf('import { type A } from "./b.ts";')],
    ["core/b.ts", importsOf('import { a } from "./a.ts";')],
  ]);
  assert.deepEqual(checkGraph(graph), [
    "runtime import loop: core/a.ts -> core/b.ts -> core/a.ts",
  ]);
});

test("a declaration-level type import is erased from the runtime graph", () => {
  const graph: SourceGraph = new Map([
    ["core/a.ts", importsOf('import type { A } from "./b.ts";')],
    ["core/b.ts", importsOf('import { a } from "./a.ts";')],
  ]);
  assert.deepEqual(checkGraph(graph), []);
});

test("a type-only edge does not make a runtime loop", () => {
  const graph = makeGraph({
    "core/a.ts": [["./b.ts"]],
    "core/b.ts": [["./a.ts", true]],
  });
  assert.deepEqual(checkGraph(graph), []);
});
