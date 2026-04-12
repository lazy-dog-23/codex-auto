import { CYCLE_STATUSES, LAST_RESULTS } from '../domain/types.js';

export const stateSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://codex-auto.local/schema/state.schema.json',
  title: 'AutonomyStateFile',
  type: 'object',
  additionalProperties: false,
  required: [
    'version',
    'current_task_id',
    'cycle_status',
    'last_planner_run_at',
    'last_worker_run_at',
    'last_result',
    'consecutive_worker_failures',
    'needs_human_review',
    'open_blocker_count',
  ],
  properties: {
    version: {
      type: 'integer',
      minimum: 1,
    },
    current_task_id: {
      type: ['string', 'null'],
      minLength: 1,
    },
    cycle_status: {
      type: 'string',
      enum: [...CYCLE_STATUSES],
    },
    last_planner_run_at: {
      type: ['string', 'null'],
      format: 'date-time',
    },
    last_worker_run_at: {
      type: ['string', 'null'],
      format: 'date-time',
    },
    last_result: {
      type: 'string',
      enum: [...LAST_RESULTS],
    },
    consecutive_worker_failures: {
      type: 'integer',
      minimum: 0,
    },
    needs_human_review: {
      type: 'boolean',
    },
    open_blocker_count: {
      type: 'integer',
      minimum: 0,
    },
  },
} as const;

export type StateSchema = typeof stateSchema;
