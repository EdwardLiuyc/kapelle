#!/usr/bin/env node
/**
 * The daemon — story M2-1, issue #31. The entry the `kapelle` bin and
 * `kapelle daemon start` load: importing it starts a daemon. The boot is
 * `daemon/main.ts`, and every route and its state is `daemon/app.ts` (M12-7a).
 */

import { main } from "./daemon/main.ts";

await main();
