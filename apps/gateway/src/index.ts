#!/usr/bin/env node

const gateway = process.argv[2]?.toLowerCase() || 'feishu';

const gateways: Record<string, () => Promise<{ main: () => Promise<void> }>> = {
  feishu: () => import('./feishu.js'),
  fs: () => import('./feishu.js'),
};

const loader = gateways[gateway];
if (!loader) {
  console.error(`Unknown gateway: ${gateway}`);
  console.error(`Supported: ${Object.keys(gateways).join(', ')}`);
  process.exit(1);
}

loader()
  .then((m) => m.main())
  .catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });

export {};
