/** Direct tests for newline-delimited JSON-RPC framing. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  encodeJsonRpcLine,
  MAX_LINE_LENGTH,
  type OutgoingMessage,
  parseJsonRpcLine,
} from "../json-rpc.ts";

test("encoding adds exactly one line delimiter", () => {
  const message: OutgoingMessage = {
    jsonrpc: "2.0",
    id: 1,
    method: "test",
    params: { ok: true },
  };
  assert.equal(encodeJsonRpcLine(message), `${JSON.stringify(message)}\n`);
});

test("a JSON object is a message, while primitives and arrays are malformed", () => {
  const object = '{"jsonrpc":"2.0","id":1,"result":{}}';
  assert.deepEqual(parseJsonRpcLine(`  ${object}\n`), {
    kind: "message",
    message: { jsonrpc: "2.0", id: 1, result: {} },
  });
  for (const line of ["null", "true", "42", '"text"', "[]"]) {
    assert.deepEqual(parseJsonRpcLine(line), { kind: "malformed", line });
  }
});

test("blank and non-JSON lines are classified without a message", () => {
  assert.deepEqual(parseJsonRpcLine(" \n\t"), { kind: "empty" });
  assert.deepEqual(parseJsonRpcLine("not json"), {
    kind: "malformed",
    line: "not json",
  });
});

test("the 32 MiB cap admits the limit and refuses one more character", () => {
  assert.equal(MAX_LINE_LENGTH, 32 * 1024 * 1024);
  const atLimit = " ".repeat(MAX_LINE_LENGTH);
  assert.deepEqual(parseJsonRpcLine(atLimit), { kind: "empty" });
  assert.deepEqual(parseJsonRpcLine(`${atLimit} `), {
    kind: "oversized",
    length: MAX_LINE_LENGTH + 1,
  });
});
