import type { AutonomySettings, DecisionPolicyDocument } from "../contracts/autonomy.js";
import {
  DEFAULT_AUTONOMY_BRANCH,
  DEFAULT_BURST_HEARTBEAT_MINUTES,
  DEFAULT_CRUISE_CADENCE,
  DEFAULT_SAFE_BACKOFF_HEARTBEAT_MINUTES,
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

export function createDefaultDecisionPolicyDocument(): DecisionPolicyDocument {
  return {
    version: 1,
    auto_continue: {
      docs_only_changes: true,
      approved_goal_followups: true,
      recoverable_closeout_paths: [
        "autonomy/**",
        "docs/**",
        "README.md",
        "TEAM_GUIDE.md",
      ],
      verification_retry: {
        max_retry_per_task: 1,
        allowed_failure_kinds: [
          "timeout",
          "browser_visibility",
          "cold_start",
          "transient_network",
        ],
      },
      auto_successor_goal: {
        enabled: false,
        auto_approve_minimal_successor: false,
        default_run_mode: "sprint",
        max_consecutive_auto_successors: 3,
        max_successor_goals_per_day: 8,
        objective: null,
        success_criteria: [],
        constraints: [],
        out_of_scope: [],
        allowed_lanes: [
          "documentation",
          "verification",
          "maintenance",
          "small_refactor",
        ],
        forbidden_lanes: [
          "deploy",
          "release",
          "credential_change",
          "paid_external_service",
          "bulk_rewrite",
          "git_history_rewrite",
        ],
      },
    },
    ask_human: [
      "proposal_boundary",
      "scope_change",
      "dependency_or_env",
      "security_or_secret",
      "release_or_git",
      "external_service",
      "unknown_context",
    ],
    heartbeat: {
      ready_next_task: "1m",
      recoverable_or_slow_verify: "15m",
      blocked_or_confirmation: "30m_or_pause",
    },
  };
}

export function formatHourlyCadence(hours: number): string {
  return `every ${hours} hour${hours === 1 ? "" : "s"}`;
}

export function formatSprintHeartbeatCadence(minutes: number): string {
  return `every ${minutes} minute${minutes === 1 ? "" : "s"} while sprint is active`;
}

export function formatSelfReschedulingHeartbeatCadence(
  burstMinutes = DEFAULT_BURST_HEARTBEAT_MINUTES,
  normalMinutes = DEFAULT_SPRINT_HEARTBEAT_MINUTES,
  safeBackoffMinutes = DEFAULT_SAFE_BACKOFF_HEARTBEAT_MINUTES,
): string {
  return `self-rescheduling with ${safeBackoffMinutes}-minute entry lease: ${burstMinutes} minute after a clean ready task, ${normalMinutes} minutes normally, ${safeBackoffMinutes} minutes on safe backoff`;
}
