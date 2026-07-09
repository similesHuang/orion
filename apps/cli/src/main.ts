#!/usr/bin/env node
import { main } from '@orion/agent';

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
