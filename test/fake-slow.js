#!/usr/bin/env node
// A stream-json CLI that never answers, so interrupting can be tested.
setTimeout(() => {}, 60_000);
process.stdin.resume();
