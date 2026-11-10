#!/usr/bin/env node
// node skills/feature-follow/scripts/run.mjs [--preview | --post | --scheduled] [--ticket <TICKET_URL_OR_ID>] [--force] [--json]
// The code is shared with dev-fix-follow (skills/dev-fix-follow/scripts/cli.mjs);
// only the profile differs (profile.mjs: feature_request tickets, labels, prefixes, paths).
import { main } from '../../dev-fix-follow/scripts/cli.mjs';
import { FEATURE_PROFILE } from './profile.mjs';

await main(FEATURE_PROFILE);
