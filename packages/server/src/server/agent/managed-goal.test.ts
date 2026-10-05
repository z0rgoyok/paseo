import { afterEach, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { ManagedGoalStore } from "./managed-goal.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { createTestLogger } from "../../test-utils/test-logger.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
async function fixture() {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "paseo-managed-goal-"));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, store: new ManagedGoalStore(path.join(directory, "goals")) };
}
async function completed(store: ManagedGoalStore, id: string, request: string, turn: string) {
  const goal = await store.begin(id, request);
  await store.accept(id, goal.lease!.id, turn);
  return store.terminal(id, turn, "completed", { inputTokens: 10, outputTokens: 3 });
}

test("concurrent duplicate admissions produce one durable invocation lease", async () => {
  const { store } = await fixture();
  await store.set("actor", "Review exact SHA");
  const results = await Promise.allSettled([
    store.begin("actor", "delivery-1"),
    store.begin("actor", "delivery-1"),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect((await store.get("actor"))?.admittedRequests).toHaveLength(1);
});
test("restart between acceptance and result holds unknown delivery and retains receipt", async () => {
  const { store } = await fixture();
  await store.set("actor", "Review exact SHA");
  const admission = await store.begin("actor", "delivery-1");
  await store.accept("actor", admission.lease!.id, "turn-1");
  const restart = new ManagedGoalStore(store.directory),
    goal = await restart.get("actor");
  expect(goal).toMatchObject({ status: "active", phase: "held", lease: { turnId: "turn-1" } });
  await expect(restart.control("actor", "active")).rejects.toThrow("reconciled checkpoint");
  await restart.control("actor", "active", true);
  await expect(restart.begin("actor", "delivery-1")).rejects.toThrow("Duplicate");
});
test("ordinary terminal receipt is idempotent across restart and advances continuation cursor", async () => {
  const { store } = await fixture();
  await store.set("actor", "Review exact SHA");
  const result = await completed(store, "actor", "delivery-1", "turn-1");
  const restart = new ManagedGoalStore(store.directory);
  await restart.terminal("actor", "turn-1", "completed", { inputTokens: 1000 });
  expect(await restart.get("actor")).toEqual(result);
  expect(await restart.readyIds()).toEqual(["actor"]);
  await expect(restart.begin("actor", "delivery-1")).rejects.toThrow("Duplicate");
});
test("owner pause/cancel survives late completion and process restart", async () => {
  const { store } = await fixture();
  await store.set("actor", "Review exact SHA");
  const admission = await store.begin("actor", "delivery-1");
  await store.accept("actor", admission.lease!.id, "turn-1");
  await store.control("actor", "cancelled");
  await store.terminal("actor", "turn-1", "completed");
  const restart = new ManagedGoalStore(store.directory);
  expect((await restart.get("actor"))?.status).toBe("cancelled");
  expect(await restart.readyIds()).toEqual([]);
  await expect(restart.begin("actor", "delivery-2")).rejects.toThrow("active");
});
test("token usage and turn ceiling hold execution without declaring completion", async () => {
  const { store } = await fixture();
  await store.set("budget", "Review", 12);
  expect(await completed(store, "budget", "request", "turn")).toMatchObject({
    status: "budgetLimited",
    tokensUsed: 13,
  });
  await store.set("ceiling", "Review", null, 1);
  expect(await completed(store, "ceiling", "request", "turn")).toMatchObject({
    status: "usageLimited",
    turnsUsed: 1,
  });
  await expect(store.begin("ceiling", "next")).rejects.toThrow("active");
});
test("completion binds goal id, workspace and actual artifact digest", async () => {
  const { directory, store } = await fixture();
  const goal = await store.set("reviewer", "Submit my exact review");
  await fs.writeFile(path.join(directory, "review.md"), "Review SHA abc: no blockers");
  const sha = createHash("sha256").update("Review SHA abc: no blockers").digest("hex");
  await expect(
    store.complete("reviewer", "wrong-goal", directory, "review.md", sha),
  ).rejects.toThrow("binding");
  await expect(
    store.complete("reviewer", goal.goalId, directory, "review.md", "0".repeat(64)),
  ).rejects.toThrow("digest");
  const result = await store.complete("reviewer", goal.goalId, directory, "review.md", sha);
  expect(result.status).toBe("complete");
  expect(await new ManagedGoalStore(store.directory).get("reviewer")).toEqual(result);
  await expect(store.begin("reviewer", "next")).rejects.toThrow("active");
});
test("provider failure persists an infrastructure blocker; synthetic failure cannot clear unknown lease", async () => {
  const { store } = await fixture();
  await store.set("actor", "Review");
  const goal = await store.begin("actor", "delivery");
  await store.holdUnknownAdmission("actor");
  await store.terminal("actor", null, "failed");
  expect((await store.get("actor"))?.lease?.id).toBe(goal.lease!.id);
  await store.terminal("actor", "native-turn", "failed");
  expect((await store.get("actor"))?.status).toBe("active");
});
test("unwritable persistence never exposes an uncommitted active admission in cache", async () => {
  const { store } = await fixture();
  await store.set("actor", "Review");
  const before = await store.get("actor"),
    old = store.directory + "-saved";
  await fs.rename(store.directory, old);
  await fs.writeFile(store.directory, "occupied");
  await expect(store.begin("actor", "delivery")).rejects.toThrow();
  expect(await store.get("actor")).toEqual(before);
  await fs.unlink(store.directory);
  await fs.rename(old, store.directory);
});

async function managerFixture(maxTurns = 2) {
  const { directory, store } = await fixture(),
    starts: string[] = [];
  const registry = new AgentStorage(path.join(directory, "agents"), createTestLogger());
  const manager = new AgentManager({
    logger: createTestLogger(),
    registry,
    managedGoalStore: store,
    verifyTaskReceipt: async () => ({ taskKey: "TEST-1", issueId: 1, takeCommentId: 7 }),
    requireGoals: true,
    clients: {
      claude: createTestAgentClient("claude", { onStartTurn: (p) => starts.push(String(p)) }),
    },
  });
  const actor = await manager.createAgent(
    { provider: "claude", cwd: directory, modeId: "bypassPermissions" },
    undefined,
    {},
  );
  cleanups.push(async () => {
    const sessionId = manager.getAgent(actor.id)?.persistence?.sessionId;
    manager.prepareForShutdown();
    await manager.closeAgent(actor.id);
    await manager.flushForShutdown();
    if (sessionId)
      await fs
        .unlink(path.join(tmpdir(), "paseo-fake-provider-history", "claude", sessionId + ".jsonl"))
        .catch(() => undefined);
  });
  return { directory, store, manager, actor, starts, maxTurns };
}
test("Claude execution waits for persisted active goal; ordinary stop continues within bounded turns", async () => {
  const { manager, actor, starts, maxTurns } = await managerFixture();
  await expect(manager.runAgent(actor.id, "first")).rejects.toThrow("active manager goal");
  expect(starts).toEqual([]);
  await manager.setAgentGoal(actor.id, "Produce exact review", null, maxTurns);
  await manager.runAgent(actor.id, "first", { clientMessageId: "first-request" });
  expect(starts).toHaveLength(1);
  await expect
    .poll(async () => (await manager.getAgentGoal(actor.id))?.status, { timeout: 5000 })
    .toBe("usageLimited");
  expect(starts).toHaveLength(2);
});
test("owner pause between turns stops continuation and slash status allocates no work", async () => {
  const { manager, actor, starts } = await managerFixture();
  await manager.setAgentGoal(actor.id, "Produce exact review");
  await manager.runAgent(actor.id, "first");
  await manager.controlAgentGoal(actor.id, "paused");
  expect(manager.tryRunOutOfBand(actor.id, "/status")).toBe(true);
  await manager.flush();
  await new Promise((r) => setTimeout(r, 1200));
  expect(starts).toHaveLength(1);
  expect((await manager.getAgentGoal(actor.id))?.status).toBe("paused");
});
test("standalone reviewer completion stops at their verified review artifact", async () => {
  const { manager, actor, directory, starts } = await managerFixture();
  const goal = await manager.setAgentGoal(
    actor.id,
    "Submit my exact review; peer discussion is coordinated separately",
  );
  if (!goal || !("goalId" in goal)) throw new Error("Expected actual manager goal");
  await manager.runAgent(actor.id, "first");
  const text = "Reviewed exact source994+candidate; author checks verified";
  await fs.writeFile(path.join(directory, "review.md"), text);
  const receipt = await manager.submitAgentReceipt(actor.id, {
    receipt_type: "review_completed",
    take_comment: "https://tracker.tich.app/project/TEST/issue/1#comment-7",
    review_artifact: { path: "review.md", sha256: createHash("sha256").update(text).digest("hex") },
    verdict: "approved",
  });
  expect(receipt.status).toBe("processed");
  await new Promise((r) => setTimeout(r, 1200));
  expect(starts).toHaveLength(1);
  await expect(manager.runAgent(actor.id, "next task without new goal")).rejects.toThrow("active");
});

test("paused reviewer receipt is durable and never revokes the owner hold", async () => {
  const { manager, actor, directory, starts } = await managerFixture();
  await manager.setAgentGoal(actor.id, "Submit exact review");
  await manager.runAgent(actor.id, "first");
  await manager.controlAgentGoal(actor.id, "paused");
  const text = "review exact candidate";
  await fs.writeFile(path.join(directory, "review.md"), text);
  const receipt = {
    receipt_type: "review_completed",
    take_comment: "https://tracker.tich.app/project/TEST/issue/1#comment-7",
    review_artifact: { path: "review.md", sha256: createHash("sha256").update(text).digest("hex") },
    verdict: "approved",
  };
  const result = await manager.submitAgentReceipt(actor.id, receipt);
  expect(result.status).toBe("processed");
  expect((await manager.getAgentGoal(actor.id))?.status).toBe("paused");
  await manager.controlAgentGoal(actor.id, "active");
  expect((await manager.getAgentGoal(actor.id))?.status).toBe("complete");
  expect(starts).toHaveLength(1);
});
test("restart after known terminal resumes the same actor without replaying first request", async () => {
  const { manager, actor, store, starts } = await managerFixture();
  await manager.setAgentGoal(actor.id, "Resume only next checkpoint", null, 2);
  await manager.runAgent(actor.id, "first", { clientMessageId: "original" });
  manager.prepareForShutdown();
  await manager.closeAgent(actor.id);
  await manager.flushForShutdown();
  const registry = new AgentStorage(
    path.join(path.dirname(store.directory), "agents"),
    createTestLogger(),
  );
  const resumed: string[] = [];
  const next = new AgentManager({
    logger: createTestLogger(),
    registry,
    managedGoalStore: new ManagedGoalStore(store.directory),
    requireGoals: true,
    clients: {
      claude: createTestAgentClient("claude", { onStartTurn: (p) => resumed.push(String(p)) }),
    },
  });
  await next.recoverManagedGoalContinuations();
  await expect
    .poll(async () => (await next.getAgentGoal(actor.id))?.status, { timeout: 5000 })
    .toBe("usageLimited");
  expect(starts).toEqual(["first"]);
  expect(resumed).toHaveLength(1);
  expect(resumed[0]).toContain("durable checkpoint");
  next.prepareForShutdown();
  await next.closeAgent(actor.id);
  await next.flushForShutdown();
});
