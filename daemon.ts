#!/usr/bin/env node
/**
 * The daemon — story M2-1, issue #31. The entry the `kapelle` bin and
 * `kapelle daemon start` load: importing it starts a daemon. The boot is
 * `daemon/main.ts`, the app and its route table are `daemon/app.ts`
 * (M12-7a), and the routes' handlers are in `daemon/routes/` (M12-7b).
 */

import { main } from "./daemon/main.ts";

await main();
