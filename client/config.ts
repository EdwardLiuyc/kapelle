/**
 * The project config (M10-5): `GET /config` as lines, and the form's typed
 * values as the body of a `PATCH /config`.
 *
 * **Both chat screens print and save from here**, so they cannot differ. The
 * daemon reads and writes `.kapelle/config.json`; the chat never touches the
 * file, as `client/` cannot import `core/config.ts`.
 *
 * **The screen never guesses** (M4-5): a typed value is sent as JSON when it
 * parses and as the text when it does not, so the daemon's own rule refuses
 * it and names the key. Blank is `null`: the key leaves the file, and its
 * default applies again.
 */

import type { ConfigRow, ConfigView } from "./contract.ts";
import { call, type DaemonAddress, type Reply } from "./daemon.ts";
import { printable } from "./room.ts";

/** When a saved value takes effect. The form and the save line say it. */
export const CONFIG_APPLIES =
  "saved values apply to later runs, new rooms, the next sweep and new " +
  "checkouts, not to work already underway";

/** `GET /config` for the repository `cwd` is in. */
export const readConfig = (
  d: DaemonAddress,
  cwd: string,
): Promise<Reply<ConfigView>> =>
  call<ConfigView>(d, `/config?cwd=${encodeURIComponent(cwd)}`);

/** A value as one line of text: a number, or a JSON array. */
export const valueText = (v: ConfigRow["value"] | undefined) =>
  v === undefined ? "" : JSON.stringify(v);

/** Where a row's value in use comes from, in words. */
export function sourceText(row: ConfigRow): string {
  if (row.source === "env") {
    const file =
      row.file === undefined ? "" : `; the file says ${valueText(row.file)}`;
    return `env ${row.env ?? "KAPELLE_*"} wins${file}`;
  }
  return row.source === "config" ? "config" : "default";
}

/** The view as lines: the file, then one line per key with its value in
 *  use and its source. Every value comes from the daemon. */
export function configLines(v: ConfigView): string[] {
  return [
    printable(`config for ${v.root} (${v.path})`),
    ...v.rows.map((r) =>
      printable(`${r.key} = ${valueText(r.value)} (${sourceText(r)})`),
    ),
  ];
}

/** Any JSON value a person can type. The daemon owns the rules for a
 *  particular key; this side only keeps the value as JSON. */
type ConfigPatchValue =
  | string
  | number
  | boolean
  | null
  | ConfigPatchValue[]
  | { [key: string]: ConfigPatchValue };

/** A `PATCH /config` body: the keys that changed, with their JSON values. */
export type ConfigPatch = Record<string, ConfigPatchValue>;

/** Text as JSON when it parses, else the text itself for the daemon to
 *  refuse. */
function typedValue(text: string): ConfigPatchValue {
  try {
    return JSON.parse(text) as ConfigPatchValue;
  } catch {
    return text;
  }
}

/** The keys whose typed value differs from the file's, as a
 *  `PATCH /config` body. Values are compared, not text, so `60000.0` or
 *  other spacing in a list is no change. A key not in `typed` is unchanged. */
export function configPatch(
  rows: readonly ConfigRow[],
  typed: Readonly<Record<string, string>>,
): ConfigPatch {
  const patch = new Map<string, ConfigPatchValue>();
  for (const r of rows) {
    const text = (typed[r.key] ?? valueText(r.file)).trim();
    const value = text === "" ? null : typedValue(text);
    if (JSON.stringify(value) !== JSON.stringify(r.file ?? null)) {
      patch.set(r.key, value);
    }
  }
  return Object.fromEntries(patch);
}
