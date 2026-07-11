#!/usr/bin/env node
import { initStorage, applySettingsToEnv, migrateFromLegacy } from '@orion/shared';
import { main } from '@orion/agent';

const args = process.argv.slice(2);
const migrateIdx = args.findIndex((a) => a === '--migrate');
if (migrateIdx !== -1) {
  const sourceDir = args[migrateIdx + 1] || process.env.INIT_CWD || process.cwd();
  initStorage({ workspaceRoot: sourceDir });
  migrateFromLegacy(sourceDir);
  process.exit(0);
}

initStorage({ workspaceRoot: process.env.INIT_CWD || process.cwd() });
applySettingsToEnv();

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
