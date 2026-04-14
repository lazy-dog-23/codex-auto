export const installSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://codex-auto.local/schema/install.schema.json",
  title: "AutonomyInstallFile",
  type: "object",
  additionalProperties: false,
  required: ["version", "product_version", "installed_at", "managed_paths", "managed_files", "source_repo"],
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
    managed_files: {
      type: "array",
      default: [],
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "template_id", "installed_hash", "last_reconciled_product_version", "management_class"],
        properties: {
          path: {
            type: "string",
            minLength: 1,
          },
          template_id: {
            type: "string",
            minLength: 1,
          },
          installed_hash: {
            type: "string",
            minLength: 1,
          },
          last_reconciled_product_version: {
            type: "string",
            minLength: 1,
          },
          management_class: {
            type: "string",
            enum: ["static_template", "repo_customized", "runtime_state"],
          },
          baseline_origin: {
            type: "string",
            enum: ["template", "repo_specific"],
          },
          content_mode: {
            type: "string",
            enum: ["full_file", "markdown_section"],
          },
          section_start_marker: {
            type: "string",
            minLength: 1,
          },
          section_end_marker: {
            type: "string",
            minLength: 1,
          },
        },
      },
    },
    source_repo: {
      type: "string",
      minLength: 1,
    },
  },
} as const;

export type InstallSchema = typeof installSchema;
