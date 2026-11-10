#!/usr/bin/env node
// Install the dev-fix-follow skill as a user systemd timer that runs at the
// slots of skills/dev-fix-follow/workflow.json (timer andrew-dev-fix-follow.timer).
// The unit text is produced by install-follow-timer.mjs, shared with feature-follow.
// Usage: node scripts/install-dev-fix-follow.mjs [--uninstall]
import { installFollowTimer } from "./install-follow-timer.mjs";
import { DEV_PROFILE } from "../skills/dev-fix-follow/scripts/profile.mjs";

await installFollowTimer(DEV_PROFILE, { uninstall: process.argv.includes("--uninstall") });
