import { DECISION_EVENTS, RUN_MODES } from "../contracts/autonomy.js";

export const decisionPolicySchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://codex-auto.local/schema/decision-policy.schema.json",
  title: "AutonomyDecisionPolicyFile",
  type: "object",
  additionalProperties: false,
  required: ["version", "auto_continue", "ask_human", "heartbeat"],
  properties: {
    version: {
      type: "integer",
      minimum: 1,
    },
    auto_continue: {
      type: "object",
      additionalProperties: false,
      required: [
        "docs_only_changes",
        "approved_goal_followups",
        "recoverable_closeout_paths",
        "verification_retry",
        "auto_successor_goal",
      ],
      properties: {
        docs_only_changes: {
          type: "boolean",
        },
        approved_goal_followups: {
          type: "boolean",
        },
        recoverable_closeout_paths: {
          type: "array",
          items: {
            type: "string",
            minLength: 1,
          },
        },
        verification_retry: {
          type: "object",
          additionalProperties: false,
          required: ["max_retry_per_task", "allowed_failure_kinds"],
          properties: {
            max_retry_per_task: {
              type: "integer",
              minimum: 0,
            },
            allowed_failure_kinds: {
              type: "array",
              items: {
                type: "string",
                minLength: 1,
              },
            },
          },
        },
        auto_successor_goal: {
          type: "object",
          additionalProperties: false,
          required: [
            "enabled",
            "auto_approve_minimal_successor",
            "default_run_mode",
            "max_consecutive_auto_successors",
            "max_successor_goals_per_day",
            "objective",
            "success_criteria",
            "constraints",
            "out_of_scope",
            "allowed_lanes",
            "forbidden_lanes",
          ],
          properties: {
            enabled: { type: "boolean" },
            auto_approve_minimal_successor: { type: "boolean" },
            default_run_mode: {
              type: "string",
              enum: [...RUN_MODES],
            },
            max_consecutive_auto_successors: {
              type: "integer",
              minimum: 0,
            },
            max_successor_goals_per_day: {
              type: "integer",
              minimum: 0,
            },
            objective: {
              type: ["string", "null"],
              minLength: 1,
            },
            success_criteria: {
              type: "array",
              items: { type: "string", minLength: 1 },
            },
            constraints: {
              type: "array",
              items: { type: "string", minLength: 1 },
            },
            out_of_scope: {
              type: "array",
              items: { type: "string", minLength: 1 },
            },
            allowed_lanes: {
              type: "array",
              items: { type: "string", minLength: 1 },
            },
            forbidden_lanes: {
              type: "array",
              items: { type: "string", minLength: 1 },
            },
          },
        },
      },
    },
    ask_human: {
      type: "array",
      items: {
        type: "string",
        enum: [...DECISION_EVENTS],
      },
    },
    heartbeat: {
      type: "object",
      additionalProperties: false,
      required: ["ready_next_task", "recoverable_or_slow_verify", "blocked_or_confirmation"],
      properties: {
        ready_next_task: {
          type: "string",
          minLength: 1,
        },
        recoverable_or_slow_verify: {
          type: "string",
          minLength: 1,
        },
        blocked_or_confirmation: {
          type: "string",
          minLength: 1,
        },
      },
    },
  },
} as const;

export type DecisionPolicySchema = typeof decisionPolicySchema;
