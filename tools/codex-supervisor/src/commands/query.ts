import { Command } from "commander";

import type { CommandResult, CommandWarning, StatusSummary } from "../contracts/autonomy.js";
import { resolveRepoRoot } from "../shared/paths.js";
import { runStatusCommand } from "./status.js";

interface QueryOptions {
  target?: string;
  json?: boolean;
}

interface QueryState {
  ready_for_automation: boolean;
  ready_for_execution: boolean;
  automation_state: StatusSummary["automation_state"];
  goal_supply_state: StatusSummary["goal_supply_state"];
  next_automation_step: StatusSummary["next_automation_step"];
  next_automation_reason: string | null;
  recommended_automation_surface: StatusSummary["recommended_automation_surface"];
  recommended_automation_prompt: StatusSummary["recommended_automation_prompt"];
  decision_outcome: StatusSummary["decision_outcome"];
  decision_next_action: StatusSummary["decision_next_action"];
  decision_heartbeat: StatusSummary["decision_heartbeat"];
}

export interface QueryResult extends CommandResult {
  target_path: string;
  state: QueryState;
  thread: {
    binding_state: StatusSummary["thread_binding_state"];
    report_thread_id: string | null;
    current_thread_id: string | null;
  };
  current_goal: {
    id: string | null;
  };
  current_task: {
    id: string | null;
  };
  next_task: {
    id: string | null;
    title: string | null;
    remaining_ready: number;
  };
  blockers: {
    open_count: number;
  };
  verification: {
    required: number;
    passed: number;
    pending: number;
    completion_blocked: boolean;
  };
  warnings: CommandWarning[];
  recommended_action: StatusSummary["decision_next_action"];
}

export async function runQueryCommand(options: QueryOptions = {}): Promise<QueryResult> {
  const targetPath = resolveRepoRoot(options.target?.trim() || process.cwd());
  const status = await runStatusCommand(targetPath);
  return buildQueryResult(targetPath, status);
}

export function buildQueryResult(targetPath: string, status: StatusSummary): QueryResult {
  const warnings = status.warnings ?? [];
  return {
    ok: status.ok,
    message: [
      `recommended_action=${status.decision_next_action}`,
      `ready_for_automation=${status.ready_for_automation ? "yes" : "no"}`,
      `ready_for_execution=${status.ready_for_execution ? "yes" : "no"}`,
      `next_automation_step=${status.next_automation_step}`,
      `thread_binding_state=${status.thread_binding_state}`,
    ].join(" "),
    target_path: targetPath,
    state: {
      ready_for_automation: status.ready_for_automation,
      ready_for_execution: status.ready_for_execution,
      automation_state: status.automation_state,
      goal_supply_state: status.goal_supply_state,
      next_automation_step: status.next_automation_step,
      next_automation_reason: status.next_automation_reason,
      recommended_automation_surface: status.recommended_automation_surface,
      recommended_automation_prompt: status.recommended_automation_prompt,
      decision_outcome: status.decision_outcome,
      decision_next_action: status.decision_next_action,
      decision_heartbeat: status.decision_heartbeat,
    },
    thread: {
      binding_state: status.thread_binding_state,
      report_thread_id: status.report_thread_id,
      current_thread_id: status.current_thread_id,
    },
    current_goal: {
      id: status.current_goal_id,
    },
    current_task: {
      id: status.current_task_id,
    },
    next_task: {
      id: status.next_task_id,
      title: status.next_task_title,
      remaining_ready: status.remaining_ready,
    },
    blockers: {
      open_count: status.open_blocker_count,
    },
    verification: {
      required: status.verification_required,
      passed: status.verification_passed,
      pending: status.verification_pending,
      completion_blocked: status.completion_blocked_by_verification,
    },
    warnings,
    recommended_action: status.decision_next_action,
  };
}

export function registerQueryCommand(program: Command): void {
  program
    .command("query")
    .option("--target <path>", "Target repository root")
    .option("--json", "Print the stable machine-readable query payload")
    .description("Print a compact stable automation state summary for heartbeat, relay, scheduler, or UI consumers")
    .action(async (options: QueryOptions) => {
      const result = await runQueryCommand(options);
      console.log(options.json ? JSON.stringify(result, null, 2) : result.message);
    });
}
