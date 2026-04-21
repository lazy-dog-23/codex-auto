import { SLICE_STATUSES } from "../domain/types.js";

export const slicesSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://codex-auto.local/schema/slices.schema.json",
  title: "AutonomySlicesFile",
  type: "object",
  additionalProperties: false,
  required: ["version", "slices"],
  properties: {
    version: {
      type: "integer",
      minimum: 1,
    },
    slices: {
      type: "array",
      items: {
        $ref: "#/$defs/slice",
      },
      default: [],
    },
  },
  $defs: {
    slice: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "goal_id",
        "title",
        "objective",
        "status",
        "acceptance",
        "file_hints",
        "task_ids",
        "created_at",
        "updated_at",
        "completed_at",
      ],
      properties: {
        id: { type: "string", minLength: 1 },
        goal_id: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1 },
        objective: { type: "string", minLength: 1 },
        status: { type: "string", enum: [...SLICE_STATUSES] },
        acceptance: {
          type: "array",
          items: { type: "string", minLength: 1 },
          default: [],
        },
        file_hints: {
          type: "array",
          items: { type: "string", minLength: 1 },
          default: [],
        },
        task_ids: {
          type: "array",
          items: { type: "string", minLength: 1 },
          uniqueItems: true,
          default: [],
        },
        created_at: {
          type: "string",
          format: "date-time",
        },
        updated_at: {
          type: "string",
          format: "date-time",
        },
        completed_at: {
          type: ["string", "null"],
          format: "date-time",
        },
      },
    },
  },
} as const;

export type SlicesSchema = typeof slicesSchema;
