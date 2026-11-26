/** Direct tests for newline-delimited JSON-RPC framing. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  encodeJsonRpcLine,
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
