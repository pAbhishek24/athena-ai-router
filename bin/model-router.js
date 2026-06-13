#!/usr/bin/env node

const { main } = require('../src/cli');

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
