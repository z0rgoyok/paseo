import { afterEach, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { AgentReceiptLedger, agentReceiptId, validateAgentReceipt } from "./agent-receipt.js";
import { trackerCommentReference } from "./task-receipt-readback.js";
import { mapReceiptState, type ReceiptRuntimeFacts } from "./receipt-state.js";
const take = "https://tracker.tich.app/project/TEST/issue/1#comment-7";
const artifact = { path: "review.md", sha256: "a".repeat(64) };
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

test.each([
  { receipt_type: "task_started", take_comment: take },
  { receipt_type: "task_state", take_comment: take, status: "working" },
  { receipt_type: "task_state", take_comment: take, status: "waiting_agents" },
  {
    receipt_type: "task_state",
    take_comment: take,
    status: "infra_blocked",
    blocker_comment: take,
  },
  {
    receipt_type: "task_state",
    take_comment: take,
    status: "needs_product_decision",
    blocker_comment: take,
  },
  { receipt_type: "task_state", take_comment: take, status: "done", completion_comment: take },
  {
    receipt_type: "review_completed",
    take_comment: take,
    review_artifact: artifact,
    verdict: "approved",
  },
])("common envelope accepts its selected branch %#", (receipt) => {
  expect(validateAgentReceipt(receipt)).toEqual(receipt);
});
test.each([
  { receipt_type: "task_started", take_comment: take, status: "working" },
  { receipt_type: "task_started", take_comment: take, blocker_comment: take },
  { receipt_type: "task_started", take_comment: take, completion_comment: take },
  { receipt_type: "task_state", take_comment: take },
  { receipt_type: "task_state", take_comment: take, status: "working", blocker_comment: take },
  {
    receipt_type: "task_state",
    take_comment: take,
    status: "waiting_agents",
    blocker_comment: take,
  },
  { receipt_type: "task_state", take_comment: take, status: "working", completion_comment: take },
  {
    receipt_type: "task_state",
    take_comment: take,
    status: "waiting_agents",
    completion_comment: take,
  },
  { receipt_type: "task_state", take_comment: take, status: "infra_blocked" },
  { receipt_type: "task_state", take_comment: take, status: "needs_product_decision" },
  {
    receipt_type: "task_state",
    take_comment: take,
    status: "infra_blocked",
    blocker_comment: take,
    completion_comment: take,
  },
  {
    receipt_type: "task_state",
    take_comment: take,
    status: "needs_product_decision",
    blocker_comment: take,
    completion_comment: take,
  },
  { receipt_type: "task_state", take_comment: take, status: "done" },
  {
    receipt_type: "task_state",
    take_comment: take,
    status: "done",
    completion_comment: take,
    blocker_comment: take,
  },
  { receipt_type: "review_completed", review_artifact: artifact, verdict: "approved" },
  { receipt_type: "review_completed", take_comment: take, verdict: "approved" },
  { receipt_type: "review_completed", take_comment: take, review_artifact: artifact },
  {
    receipt_type: "review_completed",
    take_comment: take,
    review_artifact: artifact,
    verdict: "approved",
    status: "done",
  },
  {
    receipt_type: "review_completed",
    take_comment: take,
    review_artifact: artifact,
    verdict: "approved",
    blocker_comment: take,
  },
  {
    receipt_type: "review_completed",
    take_comment: take,
    review_artifact: artifact,
    verdict: "approved",
    completion_comment: take,
  },
])("hook rejects cross-branch/missing mandatory fields %#", (receipt) => {
  expect(() => validateAgentReceipt(receipt)).toThrow("oneOf");
});
test("receipt identity is stable across key order and a lost ACK", async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "paseo-receipt-"));
  dirs.push(directory);
  const first = { receipt_type: "task_started", take_comment: take },
    second = { take_comment: take, receipt_type: "task_started" };
  expect(agentReceiptId("actor", "goal", validateAgentReceipt(first))).toBe(
    agentReceiptId("actor", "goal", validateAgentReceipt(second)),
  );
  let writes = 0;
  const result = await new AgentReceiptLedger(directory).submit(
    "actor",
    "goal",
    first,
    async () => ({ applied: ++writes }),
  );
  expect(
    await new AgentReceiptLedger(directory).submit("actor", "goal", second, async () => ({
      applied: ++writes,
    })),
  ).toEqual(result);
  expect(writes).toBe(1);
  expect(result.status).toBe("processed");
  expect((await fs.stat(path.join(directory, result.receipt_id + ".json"))).mode & 0o777).toBe(
    0o600,
  );
});
test("failed processing retains pending receipt and does not issue an ACK", async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "paseo-receipt-"));
  dirs.push(directory);
  const ledger = new AgentReceiptLedger(directory),
    receipt = validateAgentReceipt({ receipt_type: "task_started", take_comment: take });
  await expect(
    ledger.submit("actor", "goal", receipt, async () => {
      throw new Error("reader unavailable");
    }),
  ).rejects.toThrow();
  expect((await ledger.get(agentReceiptId("actor", "goal", receipt)))?.status).toBe("pending");
});
const facts: ReceiptRuntimeFacts = {
  reviewerAssigned: false,
  probeRouteAvailable: false,
  backlogDecisionAccepted: false,
  unfixableInfraBlocker: false,
  productDecisionRequired: false,
};
test.each(["reviewerAssigned", "probeRouteAvailable", "backlogDecisionAccepted"] as const)(
  "internal %s never becomes blocked or needs_user",
  (key) => {
    const receipt = validateAgentReceipt({
      receipt_type: "task_state",
      take_comment: take,
      status: "infra_blocked",
      blocker_comment: take,
    });
    expect(mapReceiptState(receipt, { ...facts, [key]: true })).toMatchObject({
      state: "in_progress",
      escalateOwner: false,
      continueLead: true,
    });
  },
);
test("only confirmed unfixable infrastructure/product decisions escalate the owner", () => {
  const receipt = validateAgentReceipt({
    receipt_type: "task_state",
    take_comment: take,
    status: "needs_product_decision",
    blocker_comment: take,
  });
  expect(mapReceiptState(receipt, facts).state).toBe("in_progress");
  expect(mapReceiptState(receipt, { ...facts, productDecisionRequired: true })).toMatchObject({
    state: "blocked",
    escalateOwner: true,
  });
});
test("Tracker reference is canonical and task-bound", () => {
  expect(trackerCommentReference(take)).toMatchObject({
    taskKey: "TEST-1",
    sequenceNumber: 1,
    commentId: 7,
  });
  expect(() =>
    trackerCommentReference("https://evil.test/project/TEST/issue/1#comment-7"),
  ).toThrow();
  expect(() => trackerCommentReference("https://tracker.tich.app/project/TEST/issue/1")).toThrow();
});
