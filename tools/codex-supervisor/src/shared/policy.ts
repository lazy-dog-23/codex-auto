import type { AutonomySettings } from "../contracts/autonomy.js";
import {
  DEFAULT_AUTONOMY_BRANCH,
  DEFAULT_CRUISE_CADENCE,
  DEFAULT_SPRINT_HEARTBEAT_MINUTES,
} from "../contracts/autonomy.js";

export const REPORTER_CADENCE_DESCRIPTION = "heartbeat plus immediate critical exceptions";

export function createDefaultAutonomySettings(): AutonomySettings {
  return {
    version: 1,
    install_source: "local_package",
    initial_confirmation_required: true,
    report_surface: "thread_and_inbox",
    auto_commit: "autonomy_branch",
    autonomy_branch: DEFAULT_AUTONOMY_BRANCH,
    auto_continue_within_goal: true,
    block_on_major_decision: true,
    default_cruise_cadence: { ...DEFAULT_CRUISE_CADENCE },
    default_sprint_heartbeat_minutes: DEFAULT_SPRINT_HEARTBEAT_MINUTES,
  };
}

export function formatHourlyCadence(hours: number): string {
  return `every ${hours} hour${hours === 1 ? "" : "s"}`;
}

export function formatSprintHeartbeatCadence(minutes: number): string {
  return `every ${minutes} minute${minutes === 1 ? "" : "s"} while sprint is active`;
}
