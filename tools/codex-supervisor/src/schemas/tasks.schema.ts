import { REVIEW_STATUSES, TASK_PRIORITIES, TASK_SOURCES, TASK_STATUSES } from "../domain/types.js";

export const tasksSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://codex-auto.local/schema/tasks.schema.json",
  title: "AutonomyTasksFile",
  type: "object",
  additionalProperties: false,
  required: ["version", "tasks"],
  properties: {
    version: {
      type: "integer",
      minimum: 1,
    },
    tasks: {
      type: "array",
      items: {
        $ref: "#/$defs/task",
      },
      default: [],
    },
  },
  $defs: {
    task: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "goal_id",
        "title",
        "status",
        "priority",
        "depends_on",
        "acceptance",
        "file_hints",
        "retry_count",
        "last_error",
        "updated_at",
        "commit_hash",
        "review_status",
        "source",
        "source_task_id",
      ],
      properties: {
        id: { type: "string", minLength: 1 },
        goal_id: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1 },
        status: { type: "string", enum: [...TASK_STATUSES] },
        priority: { type: "string", enum: [...TASK_PRIORITIES] },
        depends_on: {
          type: "array",
          items: { type: "string", minLength: 1 },
          uniqueItems: true,
          default: [],
        },
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
        retry_count: {
          type: "integer",
          minimum: 0,
          default: 0,
        },
        last_error: {
          type: ["string", "null"],
        },
        updated_at: {
          type: "string",
          format: "date-time",
        },
        commit_hash: {
          type: ["string", "null"],
        },
        review_status: {
          type: "string",
          enum: [...REVIEW_STATUSES],
        },
        source: {
          type: "string",
          enum: [...TASK_SOURCES],
        },
        source_task_id: {
          type: ["string", "null"],
        },
      },
    },
  },
} as const;

export type TasksSchema = typeof tasksSchema;
