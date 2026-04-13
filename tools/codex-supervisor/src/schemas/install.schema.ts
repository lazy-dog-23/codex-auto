export const installSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://codex-auto.local/schema/install.schema.json",
  title: "AutonomyInstallFile",
  type: "object",
  additionalProperties: false,
  required: ["version", "product_version", "installed_at", "managed_paths", "source_repo"],
  properties: {
    version: {
      type: "integer",
      minimum: 1,
    },
    product_version: {
      type: "string",
      minLength: 1,
    },
    installed_at: {
      type: "string",
      format: "date-time",
    },
    managed_paths: {
      type: "array",
      items: {
        type: "string",
        minLength: 1,
      },
      uniqueItems: true,
      default: [],
    },
    source_repo: {
      type: "string",
      minLength: 1,
    },
  },
} as const;

export type InstallSchema = typeof installSchema;
