import { AUTO_COMMIT_MODES, INSTALL_SOURCES, REPORT_SURFACES } from "../domain/types.js";

export const settingsSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://codex-auto.local/schema/settings.schema.json",
  title: "AutonomySettingsFile",
  type: "object",
  additionalProperties: false,
  required: [
    "version",
    "install_source",
    "initial_confirmation_required",
    "report_surface",
    "auto_commit",
    "autonomy_branch",
    "default_cruise_cadence",
    "default_sprint_heartbeat_minutes",
  ],
  properties: {
    version: {
      type: "integer",
      minimum: 1,
    },
    install_source: {
      type: "string",
      enum: [...INSTALL_SOURCES],
    },
    initial_confirmation_required: {
      type: "boolean",
    },
    report_surface: {
      type: "string",
      enum: [...REPORT_SURFACES],
    },
    auto_commit: {
      type: "string",
      enum: [...AUTO_COMMIT_MODES],
    },
    autonomy_branch: {
      type: "string",
      minLength: 1,
    },
    default_cruise_cadence: {
      type: "object",
      additionalProperties: false,
      required: ["planner_hours", "worker_hours", "reviewer_hours"],
      properties: {
        planner_hours: { type: "integer", minimum: 1 },
        worker_hours: { type: "integer", minimum: 1 },
        reviewer_hours: { type: "integer", minimum: 1 },
      },
    },
    default_sprint_heartbeat_minutes: {
      type: "integer",
      minimum: 1,
    },
  },
} as const;

export type SettingsSchema = typeof settingsSchema;
