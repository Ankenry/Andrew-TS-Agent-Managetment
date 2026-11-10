#!/usr/bin/env node
// node skills/dev-fix-follow/scripts/run.mjs [--preview | --post | --scheduled] [--ticket <TICKET_URL_OR_ID>] [--force] [--json]
// Flags are documented in cli.mjs; the dev-fix-follow profile is in profile.mjs.
import { main } from './cli.mjs';
import { DEV_PROFILE } from './profile.mjs';

await main(DEV_PROFILE);
