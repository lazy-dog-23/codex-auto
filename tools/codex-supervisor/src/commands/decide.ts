import { Command } from "commander";

import type { CommandResult, DecisionAdvice, StatusSummary } from "../contracts/autonomy.js";
import { buildDecisionAdvice } from "../domain/decision.js";
import { detectGitRepository } from "../infra/git.js";
import { resolveRepoPaths } from "../shared/paths.js";
import { loadDecisionPolicyDocument } from "./control-plane.js";
import { runStatusCommand } from "./status.js";

export interface DecisionResult extends CommandResult, DecisionAdvice {
  status: Pick<
    StatusSummary,
    | "ready_for_automation"
    | "ready_for_execution"
    | "automation_state"
    | "goal_supply_state"
    | "next_automation_step"
    | "next_automation_reason"
    | "current_goal_id"
    | "current_task_id"
    | "next_task_id"
    | "successor_goal_available"
    | "successor_goal_auto_approve"
    | "successor_goal_reason"
    | "thread_binding_state"
    | "recommended_automation_surface"
  >;
  policy_version: number;
}

function formatDecisionResult(result: DecisionResult): string {
  return [
    `decision_event=${result.decision_event}`,
    `decision_outcome=${result.decision_outcome}`,
    `decision_next_action=${result.decision_next_action}`,
    `decision_heartbeat=${result.decision_heartbeat}`,
    `reason=${result.decision_reason}`,
    `evidence=${result.decision_evidence.length > 0 ? result.decision_evidence.join("; ") : "none"}`,
  ].join(" ");
}

export async function runDecideCommand(repoRoot = process.cwd()): Promise<DecisionResult> {
  const gitRepo = await detectGitRepository(repoRoot, { allowFilesystemFallback: true });
  const controlRoot = gitRepo?.path ?? repoRoot;
  const paths = resolveRepoPaths(controlRoot);
  const [status, policy] = await Promise.all([
    runStatusCommand(controlRoot),
    loadDecisionPolicyDocument(paths),
  ]);
  const decision = buildDecisionAdvice(status, policy);
  const result: DecisionResult = {
    ok: true,
    message: decision.decision_reason,
    ...decision,
    status: {
      ready_for_automation: status.ready_for_automation,
      ready_for_execution: status.ready_for_execution,
      automation_state: status.automation_state,
      goal_supply_state: status.goal_supply_state,
      next_automation_step: status.next_automation_step,
      next_automation_reason: status.next_automation_reason,
      current_goal_id: status.current_goal_id,
      current_task_id: status.current_task_id,
      next_task_id: status.next_task_id,
      successor_goal_available: status.successor_goal_available,
      successor_goal_auto_approve: status.successor_goal_auto_approve,
      successor_goal_reason: status.successor_goal_reason,
      thread_binding_state: status.thread_binding_state,
      recommended_automation_surface: status.recommended_automation_surface,
    },
    policy_version: policy.version,
  };

  return {
    ...result,
    message: formatDecisionResult(result),
  };
}

export function registerDecideCommand(program: Command): void {
  program
    .command("decide")
    .description("Classify the current autonomy boundary and recommend whether to continue, repair, back off, or ask the operator")
    .option("--json", "Emit machine-readable JSON")
    .action(async (options: { json?: boolean }) => {
      const result = await runDecideCommand();
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(result.message);
    });
}
