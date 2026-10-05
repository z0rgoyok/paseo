import type { AgentReceipt } from "./agent-receipt.js";

export interface ReceiptRuntimeFacts {
  reviewerAssigned: boolean;
  probeRouteAvailable: boolean;
  backlogDecisionAccepted: boolean;
  unfixableInfraBlocker: boolean;
  productDecisionRequired: boolean;
}
export function mapReceiptState(receipt: AgentReceipt, facts: ReceiptRuntimeFacts) {
  const confirmedBlocker =
    (receipt.status === "infra_blocked" && facts.unfixableInfraBlocker) ||
    (receipt.status === "needs_product_decision" && facts.productDecisionRequired);
  const internal =
    facts.reviewerAssigned || facts.probeRouteAvailable || facts.backlogDecisionAccepted;
  if (confirmedBlocker)
    return {
      state: "blocked" as const,
      receiptStatus: receipt.status!,
      escalateOwner: true,
      continueLead: false,
    };
  if (receipt.status === "done")
    return {
      state: "done" as const,
      receiptStatus: "done",
      escalateOwner: false,
      continueLead: false,
    };
  return {
    state: "in_progress" as const,
    receiptStatus:
      receipt.status === "waiting_agents" || facts.reviewerAssigned ? "waiting_agents" : "working",
    escalateOwner: false,
    continueLead: internal || receipt.receipt_type !== "task_started",
  };
}
