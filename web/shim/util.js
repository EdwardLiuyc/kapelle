/**
 * `node:util` in the browser (spike/pwa): `parseArgs` for the one way
 * `client/command.ts` calls it: string options only, positionals allowed,
 * strict. The messages match Node's closely enough for a person.
 */
export function parseArgs({ args, options }) {
  const values = {};
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    if (!Object.hasOwn(options, name)) {
      throw new TypeError(`Unknown option '--${name}'`);
    }
    if (eq >= 0) values[name] = arg.slice(eq + 1);
    else if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
      values[name] = args[++i];
    } else throw new TypeError(`Option '--${name} <value>' argument missing`);
  }
  return { values, positionals };
}
