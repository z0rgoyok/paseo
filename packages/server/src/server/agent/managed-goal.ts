import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export const ManagedGoalSchema = z.object({
  engine: z.literal("manager"),
  agentId: z.string(),
  goalId: z.string(),
  objective: z.string().min(1).max(16000),
  status: z.enum([
    "active",
    "paused",
    "cancelled",
    "blocked",
    "budgetLimited",
    "usageLimited",
    "complete",
  ]),
  tokenBudget: z.number().int().positive().nullable(),
  tokensUsed: z.number().nonnegative(),
  timeUsedSeconds: z.number().nonnegative(),
  createdAt: z.number(),
  updatedAt: z.number(),
  maxTurns: z.number().int().positive().max(1024),
  turnsUsed: z.number().int().nonnegative(),
  cursor: z.number().int().nonnegative(),
  phase: z.enum(["ready", "admitting", "started", "held"]),
  lease: z
    .object({
      id: z.string(),
      request: z.string(),
      startedAt: z.number(),
      turnId: z.string().nullable(),
    })
    .nullable(),
  admittedRequests: z.array(z.string()).max(1024),
  blocker: z.string().nullable(),
  retryCount: z.number().int().nonnegative().default(0),
  completion: z
    .object({
      path: z.string(),
      sha256: z.string(),
      finalStatus: z.enum(["complete", "blocked", "held"]).optional(),
    })
    .nullable(),
  taskCompletion: z.string().optional(),
  acceptedReceipt: z.string().optional(),
  events: z
    .array(z.object({ seq: z.number(), kind: z.string(), at: z.number(), id: z.string() }))
    .max(32),
});
export type ManagedGoal = z.infer<typeof ManagedGoalSchema>;

/** Single daemon writer. Each transaction atomically commits its cursor and receipt.
 * No secrets or prompt bodies enter the admission ledger. Unknown in-flight delivery
 * is held on restart, never replayed as another provider invocation. */
export class ManagedGoalStore {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly cache = new Map<string, ManagedGoal | null>();
  constructor(readonly directory: string) {}

  private file(agentId: string): string {
    if (!/^[\w-]{1,128}$/.test(agentId)) throw new Error("Invalid goal agent binding");
    return path.join(this.directory, agentId + ".json");
  }
  private async persist(goal: ManagedGoal): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.file(goal.agentId),
      temporary = target + "." + randomUUID();
    try {
      const fd = await fs.open(temporary, "wx", 0o600);
      try {
        await fd.writeFile(JSON.stringify(ManagedGoalSchema.parse(goal)));
        await fd.sync();
      } finally {
        await fd.close();
      }
      await fs.rename(temporary, target);
      this.cache.set(goal.agentId, goal);
      const dir = await fs.open(this.directory, "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } finally {
      await fs.unlink(temporary).catch(() => undefined);
    }
    this.cache.set(goal.agentId, goal);
  }
  private event(goal: ManagedGoal, kind: string, id: string = randomUUID()): void {
    goal.cursor += 1;
    goal.updatedAt = Date.now();
    goal.events.push({ seq: goal.cursor, kind, id, at: goal.updatedAt });
    goal.events = goal.events.slice(-32);
  }
  private serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(action);
    this.tails.set(id, current);
    void current
      .finally(() => {
        if (this.tails.get(id) === current) this.tails.delete(id);
      })
      .catch(() => undefined);
    return current;
  }
  private async load(id: string): Promise<ManagedGoal | null> {
    if (this.cache.has(id)) return this.cache.get(id)!;
    let goal: ManagedGoal;
    try {
      goal = ManagedGoalSchema.parse(JSON.parse(await fs.readFile(this.file(id), "utf8")));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        this.cache.set(id, null);
        return null;
      }
      throw e;
    }
    if (goal.agentId !== id) throw new Error("Goal agent binding mismatch");
    if (goal.phase === "admitting" || goal.phase === "started") {
      goal.phase = "held";
      goal.blocker = "restart: native delivery receipt requires reconciliation";
      this.event(goal, "recovery_unknown_delivery");
      await this.persist(goal);
    } else this.cache.set(id, goal);
    return goal;
  }
  get(id: string): Promise<ManagedGoal | null> {
    return this.serial(id, async () => {
      const goal = await this.load(id);
      return goal ? structuredClone(goal) : null;
    });
  }
  private async mutable(id: string): Promise<ManagedGoal | null> {
    const goal = await this.load(id);
    return goal ? structuredClone(goal) : null;
  }
  set(
    id: string,
    objective: string,
    tokenBudget: number | null = null,
    maxTurns = 128,
  ): Promise<ManagedGoal> {
    return this.serial(id, async () => {
      const existing = await this.load(id);
      if (
        existing?.objective === objective &&
        existing.status !== "complete" &&
        existing.status !== "cancelled"
      )
        return structuredClone(existing);
      if (existing?.lease)
        throw new Error("Pause and reconcile the existing goal before replacement");
      const now = Date.now();
      const goal = ManagedGoalSchema.parse({
        engine: "manager",
        agentId: id,
        goalId: randomUUID(),
        objective,
        status: "active",
        tokenBudget,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: now,
        updatedAt: now,
        maxTurns,
        turnsUsed: 0,
        cursor: 0,
        phase: "ready",
        lease: null,
        admittedRequests: [],
        blocker: null,
        completion: null,
        events: [],
      });
      this.event(goal, "registered");
      await this.persist(goal);
      return structuredClone(goal);
    });
  }
  control(
    id: string,
    status: "active" | "paused" | "cancelled" | "blocked",
    acknowledgeUnknown = false,
  ): Promise<ManagedGoal> {
    return this.serial(id, async () => {
      const goal = await this.mutable(id);
      if (!goal) throw new Error("Goal absent");
      if (["complete", "budgetLimited", "usageLimited"].includes(goal.status))
        throw new Error("Goal cannot be resumed; completion or budget ceiling recorded");
      if (status === "active" && goal.phase === "held" && goal.lease) {
        if (!acknowledgeUnknown)
          throw new Error("Unknown native delivery: explicit reconciled checkpoint required");
        goal.lease = null;
      }
      goal.status = status;
      if (
        status === "active" &&
        (goal.completion?.finalStatus === "complete" || goal.taskCompletion)
      )
        goal.status = "complete";
      if (status === "active" && !goal.lease) {
        goal.phase = "ready";
        goal.blocker = null;
        goal.retryCount = 0;
      }
      this.event(goal, "owner_" + status);
      await this.persist(goal);
      return structuredClone(goal);
    });
  }
  begin(id: string, requestId: string): Promise<ManagedGoal> {
    return this.serial(id, async () => {
      const goal = await this.mutable(id);
      if (!goal || goal.status !== "active")
        throw new Error("Executable turn requires a persistent active manager goal");
      if (goal.lease || goal.phase !== "ready")
        throw new Error("Goal admission already pending or held");
      const request = createHash("sha256").update(requestId).digest("hex");
      if (goal.admittedRequests.includes(request))
        throw new Error("Duplicate goal delivery refused");
      if (goal.turnsUsed >= goal.maxTurns) throw new Error("Goal continuation ceiling reached");
      goal.lease = { id: randomUUID(), request, startedAt: Date.now(), turnId: null };
      goal.phase = "admitting";
      goal.admittedRequests.push(request);
      this.event(goal, "admission", goal.lease.id);
      await this.persist(goal);
      return structuredClone(goal);
    });
  }
  accept(id: string, leaseId: string, turnId: string): Promise<void> {
    return this.serial(id, async () => {
      const goal = await this.mutable(id);
      if (!goal?.lease || goal.lease.id !== leaseId || goal.status !== "active")
        throw new Error("Goal admission revoked");
      if (goal.lease.turnId === turnId) return;
      if (goal.lease.turnId) throw new Error("Goal lease already bound to another turn");
      goal.lease.turnId = turnId;
      goal.phase = "started";
      this.event(goal, "accepted", leaseId);
      await this.persist(goal);
    });
  }
  private applyTerminalDisposition(
    goal: ManagedGoal,
    kind: "completed" | "failed" | "cancelled",
  ): void {
    if (goal.status !== "active") return;
    {
      if (kind === "failed") {
        goal.retryCount += 1;
        goal.blocker = "provider turn failed; responsible lead/probe route handles recovery";
        if (goal.retryCount >= 3) goal.phase = "held";
      } else if (kind === "cancelled") {
        goal.status = "paused";
        goal.blocker = "turn interrupted; explicit continuation required";
      } else if (goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget)
        goal.status = "budgetLimited";
      else if (goal.turnsUsed >= goal.maxTurns) goal.status = "usageLimited";
    }
  }
  terminal(
    id: string,
    turnId: string | null,
    kind: "completed" | "failed" | "cancelled",
    usage?: { inputTokens?: number; outputTokens?: number },
  ): Promise<ManagedGoal | null> {
    return this.serial(id, async () => {
      const goal = await this.mutable(id);
      if (!turnId) return goal ? structuredClone(goal) : null;
      if (!goal?.lease || (goal.lease.turnId !== null && goal.lease.turnId !== turnId))
        return goal ? structuredClone(goal) : null;
      const receipt = goal.lease.id;
      goal.tokensUsed +=
        Math.max(0, usage?.inputTokens ?? 0) + Math.max(0, usage?.outputTokens ?? 0);
      goal.timeUsedSeconds += Math.max(0, (Date.now() - goal.lease.startedAt) / 1000);
      goal.turnsUsed += 1;
      goal.lease = null;
      goal.phase = goal.completion?.finalStatus === "held" ? "held" : "ready";
      if (kind === "completed") goal.retryCount = 0;
      this.applyTerminalDisposition(goal, kind);
      this.event(goal, kind, receipt);
      await this.persist(goal);
      return structuredClone(goal);
    });
  }
  complete(
    id: string,
    goalId: string,
    cwd: string,
    evidencePath: string,
    sha256: string,
    finalStatus: "complete" | "blocked" | "held" = "complete",
  ): Promise<ManagedGoal> {
    return this.serial(id, async () => {
      const goal = await this.mutable(id);
      if (!goal || goal.goalId !== goalId) throw new Error("Completion goal binding mismatch");
      if (goal.status === "complete") {
        if (goal.completion?.sha256 !== sha256) throw new Error("Conflicting completion receipt");
        return structuredClone(goal);
      }
      if (["budgetLimited", "usageLimited"].includes(goal.status))
        throw new Error("Completion held by resource ceiling");
      const root = await fs.realpath(cwd),
        file = await fs.realpath(path.resolve(cwd, evidencePath));
      if (!file.startsWith(root + path.sep))
        throw new Error("Completion evidence outside agent workspace");
      const info = await fs.stat(file);
      if (!info.isFile() || info.size === 0 || info.size > 4 * 1024 * 1024)
        throw new Error("Invalid completion artifact");
      if (
        !/^[a-f0-9]{64}$/.test(sha256) ||
        createHash("sha256")
          .update(await fs.readFile(file))
          .digest("hex") !== sha256
      )
        throw new Error("Completion artifact digest mismatch");
      goal.completion = { path: file, sha256, finalStatus };
      if (goal.status === "active") {
        if (finalStatus === "held") goal.phase = "held";
        else goal.status = finalStatus;
      }
      this.event(goal, "verified_completion");
      await this.persist(goal);
      return structuredClone(goal);
    });
  }
  async readyIds(includeUnknown = false): Promise<string[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.directory);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const ids: string[] = [];
    for (const name of names.filter((n) => /^[\w-]{1,128}\.json$/.test(n)).slice(0, 1024)) {
      const id = name.slice(0, -5),
        goal = await this.get(id);
      if (
        goal?.status === "active" &&
        ((goal.phase === "ready" && goal.turnsUsed > 0) ||
          (includeUnknown && goal.phase === "held" && goal.lease))
      )
        ids.push(id);
    }
    return ids;
  }
  holdUnknownAdmission(id: string): Promise<void> {
    return this.serial(id, async () => {
      const goal = await this.mutable(id);
      if (!goal?.lease) return;
      goal.phase = "held";
      goal.blocker = "provider admission outcome unknown; native receipt reconciliation required";
      this.event(goal, "unknown_delivery");
      await this.persist(goal);
    });
  }
  reconcileAbsentDelivery(id: string, deliveryId: string): Promise<void> {
    return this.serial(id, async () => {
      const goal = await this.mutable(id);
      if (!goal?.lease || goal.lease.id !== deliveryId) return;
      goal.lease = null;
      goal.phase = "ready";
      this.event(goal, "native_not_received", deliveryId);
      await this.persist(goal);
    });
  }
  completeAcceptedTask(id: string, verifiedComment: string): Promise<ManagedGoal> {
    return this.serial(id, async () => {
      const goal = await this.mutable(id);
      if (!goal) throw new Error("Goal absent");
      goal.taskCompletion = verifiedComment;
      if (goal.status === "active") goal.status = "complete";
      this.event(goal, "verified_task_completion");
      await this.persist(goal);
      return structuredClone(goal);
    });
  }
  finishAcceptedActor(id: string, receiptId: string): Promise<ManagedGoal> {
    return this.serial(id, async () => {
      const goal = await this.mutable(id);
      if (!goal) throw new Error("Goal absent");
      if (goal.status === "complete") return structuredClone(goal);
      if (goal.status !== "active") throw new Error("Owner hold/resource ceiling preserved");
      goal.acceptedReceipt = receiptId;
      goal.status = "complete";
      this.event(goal, "lead_accepted_actor_result", receiptId);
      await this.persist(goal);
      return structuredClone(goal);
    });
  }
}
