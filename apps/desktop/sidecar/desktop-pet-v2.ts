#!/usr/bin/env node
/** Desktop Pet v2 entry — skin-system edition, delegates to desktop-pet.ts. */
process.env.PET_SKIN = process.env.PET_SKIN || 'vita';
await import('./desktop-pet.js');
