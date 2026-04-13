import { VERIFICATION_AXIS_STATUSES, VERIFICATION_POLICIES } from "../contracts/autonomy.js";

export const verificationSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://codex-auto.local/schema/verification.schema.json",
  title: "AutonomyVerificationFile",
  type: "object",
  additionalProperties: false,
  required: ["version", "goal_id", "policy", "axes"],
  properties: {
    version: {
      type: "integer",
      minimum: 1,
    },
    goal_id: {
      type: ["string", "null"],
      minLength: 1,
    },
    policy: {
      type: "string",
      enum: [...VERIFICATION_POLICIES],
    },
    axes: {
      type: "array",
      default: [],
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "title",
          "required",
          "status",
          "evidence",
          "source_task_id",
          "last_checked_at",
          "reason",
        ],
        properties: {
          id: {
            type: "string",
            minLength: 1,
          },
          title: {
            type: "string",
            minLength: 1,
          },
          required: {
            type: "boolean",
          },
          status: {
            type: "string",
            enum: [...VERIFICATION_AXIS_STATUSES],
          },
          evidence: {
            type: "array",
            default: [],
            items: {
              type: "string",
              minLength: 1,
            },
          },
          source_task_id: {
            type: ["string", "null"],
          },
          last_checked_at: {
            type: ["string", "null"],
            format: "date-time",
          },
          reason: {
            type: ["string", "null"],
          },
        },
      },
    },
  },
} as const;

export type VerificationSchema = typeof verificationSchema;
