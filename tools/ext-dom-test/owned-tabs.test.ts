import { due, register, scheduleClose, KEEP_FAILED_MS, MAX_FAILED_OPEN, type Owned } from "../../ext-workana/src/ownedTabs";

const fails: string[] = [];
const ok = (n: string, c: boolean, d = "") => { if (!c) fails.push(n); console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  " + d}`); };
let o: Owned = {};
const t0 = 1_000_000;
// 35 bids: 26 sent (close after 5 s), 7 job closed (15 s), 2 other failures (kept 10 min, max 3).
for (let i = 1; i <= 35; i++) o = register(o, i, "submit", t0 + i);
for (let i = 1; i <= 26; i++) o = scheduleClose(o, i, 5000, t0 + 100);
for (let i = 27; i <= 33; i++) o = scheduleClose(o, i, 15000, t0 + 100, true);
for (let i = 34; i <= 35; i++) o = scheduleClose(o, i, KEEP_FAILED_MS, t0 + 100, true);
const open = new Set(Array.from({ length: 35 }, (_, i) => i + 1));
// A suspended worker wakes up a minute later: everything due is closed in one go.
let r = due(o, t0 + 60000, open, new Set());
ok("after a minute: 33 tabs closed (sent + job closed)", r.close.length === 33, String(r.close.length));
ok("the 2 other failures stay for inspection", Object.keys(r.owned).length === 2);
r = due(r.owned, t0 + KEEP_FAILED_MS + 1000, new Set([34, 35]), new Set());
ok("...and close after 10 minutes", r.close.length === 2 && Object.keys(r.owned).length === 0);
// Never more than MAX_FAILED_OPEN failed tabs kept.
o = {};
for (let i = 1; i <= 6; i++) { o = register(o, i, "submit", t0 + i); o = scheduleClose(o, i, KEEP_FAILED_MS, t0, true); }
r = due(o, t0 + 1000, new Set([1, 2, 3, 4, 5, 6]), new Set());
ok(`at most ${MAX_FAILED_OPEN} failed tabs kept, oldest closed first`, r.close.sort().join() === "1,2,3", r.close.join());
// The tab in use (current bid / conversation read) is never closed; closed-by-you tabs are forgotten.
o = register({}, 7, "submit", t0); o = scheduleClose(o, 7, 0, t0);
r = due(o, t0 + 1, new Set([7]), new Set([7]));
ok("tab in use is never closed", r.close.length === 0);
r = due(o, t0 + 1, new Set(), new Set());
ok("tabs you closed yourself are forgotten", r.close.length === 0 && Object.keys(r.owned).length === 0);
console.log(fails.length ? `${fails.length} FAILED` : "all passed");
process.exit(fails.length ? 1 : 0);
