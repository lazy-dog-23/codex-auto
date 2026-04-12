import { BLOCKER_SEVERITIES, BLOCKER_STATUSES } from '../domain/types.js';

export const blockersSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://codex-auto.local/schema/blockers.schema.json',
  title: 'AutonomyBlockersFile',
  type: 'object',
  additionalProperties: false,
  required: ['version', 'blockers'],
  properties: {
    version: {
      type: 'integer',
      minimum: 1,
    },
    blockers: {
      type: 'array',
      items: {
        $ref: '#/$defs/blocker',
      },
      default: [],
    },
  },
  $defs: {
    blocker: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'task_id', 'question', 'severity', 'status', 'resolution', 'opened_at', 'resolved_at'],
      properties: {
        id: { type: 'string', minLength: 1 },
        task_id: { type: 'string', minLength: 1 },
        question: { type: 'string', minLength: 1 },
        severity: { type: 'string', enum: [...BLOCKER_SEVERITIES] },
        status: { type: 'string', enum: [...BLOCKER_STATUSES] },
        resolution: {
          type: ['string', 'null'],
        },
        opened_at: {
          type: 'string',
          format: 'date-time',
        },
        resolved_at: {
          type: ['string', 'null'],
          format: 'date-time',
        },
      },
      allOf: [
        {
          if: {
            properties: {
              status: {
                const: 'open',
              },
            },
          },
          then: {
            properties: {
              resolution: { const: null },
              resolved_at: { const: null },
            },
          },
        },
        {
          if: {
            properties: {
              status: {
                const: 'resolved',
              },
            },
          },
          then: {
            properties: {
              resolution: {
                type: 'string',
                minLength: 1,
              },
              resolved_at: {
                type: 'string',
                format: 'date-time',
              },
            },
          },
        },
      ],
    },
  },
} as const;

export type BlockersSchema = typeof blockersSchema;
