import { GOAL_SOURCES, GOAL_STATUSES, RUN_MODES } from "../domain/types.js";

export const goalsSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://codex-auto.local/schema/goals.schema.json",
  title: "AutonomyGoalsFile",
  type: "object",
  additionalProperties: false,
  required: ["version", "goals"],
  properties: {
    version: {
      type: "integer",
      minimum: 1,
    },
    goals: {
      type: "array",
      items: {
        $ref: "#/$defs/goal",
      },
      default: [],
    },
  },
  $defs: {
    goal: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "title",
        "objective",
        "success_criteria",
        "constraints",
        "out_of_scope",
        "status",
        "run_mode",
        "created_at",
        "approved_at",
        "completed_at",
      ],
      properties: {
        id: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1 },
        objective: { type: "string", minLength: 1 },
        success_criteria: {
          type: "array",
          items: { type: "string", minLength: 1 },
          minItems: 1,
        },
        constraints: {
          type: "array",
          items: { type: "string", minLength: 1 },
          default: [],
        },
        out_of_scope: {
          type: "array",
          items: { type: "string", minLength: 1 },
          default: [],
        },
        status: {
          type: "string",
          enum: [...GOAL_STATUSES],
        },
        run_mode: {
          type: "string",
          enum: [...RUN_MODES],
        },
        created_at: {
          type: "string",
          format: "date-time",
        },
        approved_at: {
          type: ["string", "null"],
          format: "date-time",
        },
        completed_at: {
          type: ["string", "null"],
          format: "date-time",
        },
        source: {
          type: "string",
          enum: [...GOAL_SOURCES],
        },
        source_goal_id: {
          type: ["string", "null"],
          minLength: 1,
        },
      },
    },
  },
} as const;

export type GoalsSchema = typeof goalsSchema;
