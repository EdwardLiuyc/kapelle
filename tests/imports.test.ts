/**
 * The import rules for the whole source tree (M12-2).
 *
 * `chat.ts` and `chat/` stay on the client side of the daemon, `protocol/`
 * stays below `core/`, and `client/` may depend only on itself and the wire
 * types. Tests and integration helpers are allowed to import anything.
 *
 * The checker works on a graph so a made-up graph can prove each rule without
 * creating files. Type-only edges are erased at runtime and do not break the
 * layer rules or make a runtime loop.
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import test from "node:test";

interface ImportEdge {
  spec: string;
  typeOnly: boolean;
}

type SourceGraph = Map<string, ImportEdge[]>;

const SOURCE_DIRS = ["protocol", "core", "client", "chat", "daemon"] as const;

const toSlash = (path: string) => path.split(sep).join("/");

const targetOf = (
  file: string,
  spec: string | undefined,
): string | undefined =>
  spec?.startsWith(".") ? toSlash(join(dirname(file), spec)) : undefined;

/** Comments are legal between the tokens of an import; they are not tokens. */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

/**
 * True when a named specifier carries the `type` modifier. The grammar is
 * ambiguous around `as`: `type as` imports a type named `as`, while
 * `type as foo` imports a value named `type` as `foo`. `type as as as` is
 * the type import again.
 */
const typeOnlySpecifier = (spec: string): boolean => {
  if (!/^type(?:\s|$)/.test(spec)) return false;
  const rest = spec.slice(4).trim();
  if (/^as(?:\s|$)/.test(rest)) {
    return rest === "as" || /^as\s+as\s+as$/.test(rest);
  }
  return rest !== "";
};

/** True when the whole clause is `import type …` or `export type …`. */
const typeOnlyClause = (clause: string): boolean => {
  const clean = withoutComments(clause).trim();
  if (!/^type(?:\s|$)/.test(clean)) return false;
  const rest = clean.slice(4).trim();
  // `import type from` and `import type, { A }` import a value named `type`.
  return rest !== "" && !rest.startsWith(",") && !/^from(?:\s|$)/.test(rest);
};

/** True when a named import/export clause holds only `type` specifiers. */
const allTypeSpecifiers = (clause: string): boolean => {
  const named = withoutComments(clause).match(/^\s*\{([\s\S]*)\}\s*$/);
  if (!named) return false;
  const specs = named[1]
    .split(",")
    .map((spec) => spec.trim())
    .filter(Boolean);
  return specs.length > 0 && specs.every(typeOnlySpecifier);
};

const importsOf = (source: string): ImportEdge[] => {
  // `export … from` and a bare `import "x"` load a module too. A literal
  // `import("x")` loads one when it runs, so it gets the same check.
  const staticImports = [
    ...source.matchAll(
      /^[ \t]*(?:(import|export)([^;]*?)\bfrom|import) "([^"]+)";/gms,
    ),
  ].map((m) => {
    const clause = m[2] ?? "";
    return {
      spec: m[3] ?? "",
      typeOnly: typeOnlyClause(clause) || allTypeSpecifiers(clause),
    };
  });
  const dynamicImports = [
    ...source.matchAll(/\bimport\s*\(\s*(["'`])([^"'`]+)\1\s*\)/g),
  ].map((m) => ({ spec: m[2], typeOnly: false }));
  return [...staticImports, ...dynamicImports];
};

// A test helper has no recovery path; the test runner reports the read error.
// pi-lens-ignore: unsafe-boundary
const sourceFiles = async (root: string): Promise<string[]> => {
  const files: string[] = [];
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
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".ts")) files.push(entry.name);
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

// Keeping the rule branches together makes the rule book readable.
// pi-lens-ignore: high-complexity
const checkGraph = (graph: SourceGraph): string[] => {
  const problems: string[] = [];
  for (const [file, edges] of graph) {
    for (const edge of edges) {
      const target = targetOf(file, edge.spec);
      const fail = (reason: string) =>
        problems.push(`${file} imports ${edge.spec}: ${reason}`);

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

test("the source reader treats an all-type named import as type-only", () => {
  assert.deepEqual(importsOf('import { type A } from "./a.ts";'), [
    { spec: "./a.ts", typeOnly: true },
  ]);
  assert.deepEqual(importsOf('export { type A, type B } from "./b.ts";'), [
    { spec: "./b.ts", typeOnly: true },
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

test("the source reader ignores comments inside a type-only clause", () => {
  assert.deepEqual(importsOf('import { /* reason */ type A } from "./a.ts";'), [
    { spec: "./a.ts", typeOnly: true },
  ]);
  assert.deepEqual(importsOf('import type /* reason */ { A } from "./b.ts";'), [
    { spec: "./b.ts", typeOnly: true },
  ]);
  assert.deepEqual(importsOf('import type /* reason */ from "./c.ts";'), [
    { spec: "./c.ts", typeOnly: false },
  ]);
});

test("the checker rejects each layer rule", () => {
  const cases: [string, SourceGraph][] = [
    [
      "protocol",
      makeGraph({
        "protocol/a.ts": [["../core/b.ts"]],
        "core/b.ts": [],
      }),
    ],
    [
      "core",
      makeGraph({
        "core/a.ts": [["../client/b.ts"]],
        "client/b.ts": [],
      }),
    ],
    [
      "client",
      makeGraph({
        "client/a.ts": [["../core/b.ts"]],
        "core/b.ts": [],
      }),
    ],
    [
      "chat.ts",
      makeGraph({
        "chat.ts": [["./core/b.ts"]],
        "core/b.ts": [],
      }),
    ],
    [
      "chat",
      makeGraph({
        "chat/tui/a.ts": [["../../core/b.ts"]],
        "core/b.ts": [],
      }),
    ],
  ];
  for (const [name, graph] of cases) {
    assert.equal(checkGraph(graph).length, 1, `${name} rule`);
  }
});

test("the checker rejects a package outside a named exception", () => {
  const cases = [
    makeGraph({ "client/a.ts": [["marked"]] }),
    makeGraph({ "protocol/a.ts": [["marked"]] }),
    makeGraph({ "core/a.ts": [["marked"]] }),
    makeGraph({ "chat/tui/a.ts": [["marked"]] }),
  ];
  for (const graph of cases) assert.equal(checkGraph(graph).length, 1);
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
  assert.equal(checkGraph(wrongFile).length, 3);
});

test("type-only imports stay allowed", () => {
  const graph = makeGraph({
    "chat/tui/a.ts": [["../../core/b.ts", true]],
    "protocol/a.ts": [["../core/b.ts", true]],
    "core/b.ts": [["../client/c.ts", true]],
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

test("a type-only edge does not make a runtime loop", () => {
  const graph = makeGraph({
    "core/a.ts": [["./b.ts"]],
    "core/b.ts": [["./a.ts", true]],
  });
  assert.deepEqual(checkGraph(graph), []);
});
