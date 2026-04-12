import { RESULT_STATES, REVIEW_STATUSES, SUMMARY_KINDS } from "../contracts/autonomy.js";

const resultEntrySchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "goal_id", "summary"],
  properties: {
    status: {
      type: "string",
      enum: [...RESULT_STATES],
    },
    goal_id: {
      type: ["string", "null"],
      minLength: 1,
    },
    task_id: {
      type: ["string", "null"],
      minLength: 1,
    },
    summary: {
      type: ["string", "null"],
    },
    happened_at: {
      type: ["string", "null"],
      format: "date-time",
    },
    sent_at: {
      type: ["string", "null"],
      format: "date-time",
    },
    verify_summary: {
      type: ["string", "null"],
    },
    hash: {
      type: ["string", "null"],
    },
    message: {
      type: ["string", "null"],
    },
    review_status: {
      type: ["string", "null"],
      enum: [...REVIEW_STATUSES, null],
    },
  },
} as const;

export const resultsSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://codex-auto.local/schema/results.schema.json",
  title: "AutonomyResultsFile",
  type: "object",
  additionalProperties: false,
  required: ["version", "planner", "worker", "review", "commit", "reporter"],
  properties: {
    version: {
      type: "integer",
      minimum: 1,
    },
    last_thread_summary_sent_at: {
      type: ["string", "null"],
      format: "date-time",
    },
    last_inbox_run_at: {
      type: ["string", "null"],
      format: "date-time",
    },
    last_summary_kind: {
      type: ["string", "null"],
      enum: [...SUMMARY_KINDS, null],
    },
    last_summary_reason: {
      type: ["string", "null"],
    },
    planner: resultEntrySchema,
    worker: resultEntrySchema,
    review: resultEntrySchema,
    commit: resultEntrySchema,
    reporter: resultEntrySchema,
  },
} as const;

export type ResultsSchema = typeof resultsSchema;
