#!/usr/bin/env node
// Install the feature-follow skill as a user systemd timer that runs at the
// slots of skills/feature-follow/workflow.json (timer andrew-feature-follow.timer).
// Run it only when the user has ordered the workflow on; with
// workflow.json enabled=false the timer fires but the run exits at once.
// Usage: node scripts/install-feature-follow.mjs [--uninstall]
import { installFollowTimer } from "./install-follow-timer.mjs";
import { FEATURE_PROFILE } from "../skills/feature-follow/scripts/profile.mjs";

await installFollowTimer(FEATURE_PROFILE, { uninstall: process.argv.includes("--uninstall") });
