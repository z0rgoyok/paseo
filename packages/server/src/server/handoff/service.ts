import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { writeDurableJsonAtomic } from "../atomic-file.js";
import {
  AssignmentSchema,
  HandoffRecordSchema,
  type Assignment,
  type AssignmentReceipt,
  type HandoffConfig,
  type HandoffRecord,
} from "./contract.js";

export interface AssignmentExecution {
  initialize(assignment: Assignment, executorId: string): Promise<void>;
  start(assignment: Assignment, executorId: string, handoffId: string): Promise<void>;
}

/** The receiver owns durable admission. Paperclip receives an assignment receipt,
 * not execution status. An uncertain provider start is never replayed blindly. */
export class HandoffService {
  private readonly admissions = new Map<string, Promise<AssignmentReceipt>>();
  private readonly workers = new Map<string, Promise<void>>();
  private readonly pending: string[] = [];
  private accepting = true;
  constructor(
    private readonly directory: string,
    private readonly config: HandoffConfig,
    private readonly execution: AssignmentExecution,
  ) {}
  private file(id: string) {
    return path.join(this.directory, id + ".json");
  }
  private async read(id: string): Promise<HandoffRecord | null> {
    try {
      return HandoffRecordSchema.parse(JSON.parse(await fs.readFile(this.file(id), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  assign(input: unknown): Promise<AssignmentReceipt> {
    if (!this.accepting) return Promise.reject(new Error("Assignment ingress is stopping"));
    const assignment = AssignmentSchema.parse(input);
    const reference = new URL(assignment.task_ref);
    if (
      reference.username ||
      reference.password ||
      !["https:", "http:"].includes(reference.protocol)
    )
      return Promise.reject(new Error("Task reference must be an HTTP URL without credentials"));
    reference.hash = "";
    reference.search = "";
    reference.pathname = reference.pathname.replace(/\/$/, "");
    assignment.task_ref = reference.toString();
    if (!Object.hasOwn(this.config.projects, assignment.project))
      return Promise.reject(new Error("Project is not assigned to this connection"));
    const id = createHash("sha256")
      .update(JSON.stringify([this.config.issuer, assignment.task_ref]))
      .digest("hex");
    const previous = this.admissions.get(id) ?? Promise.resolve(undefined);
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        const fingerprint = createHash("sha256").update(JSON.stringify(assignment)).digest("hex");
        const existing = await this.read(id);
        if (existing) {
          if (existing.fingerprint !== fingerprint)
            throw new Error("Task already assigned with another brief; revise it in Paseo");
          if (existing.phase === "queued") this.kick(id);
          return existing.receipt;
        }
        const hex = id.slice(0, 32);
        const executorId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
        const receipt: AssignmentReceipt = {
          handoff_id: id,
          executor_id: executorId,
          task_ref: assignment.task_ref,
          accepted_at: new Date().toISOString(),
          disposition: "accepted",
          owner: "paseo",
        };
        const record: HandoffRecord = {
          receipt,
          assignment,
          fingerprint,
          phase: "queued",
          error: null,
        };
        await writeDurableJsonAtomic(this.file(id), record);
        this.kick(id);
        return receipt;
      });
    this.admissions.set(id, operation);
    void operation
      .finally(() => {
        if (this.admissions.get(id) === operation) this.admissions.delete(id);
      })
      .catch(() => undefined);
    return operation;
  }
  private kick(id: string) {
    if (!this.accepting || this.workers.has(id)) return;
    if (this.workers.size >= 1) {
      if (!this.pending.includes(id)) this.pending.push(id);
      return;
    }
    const worker = this.execute(id);
    this.workers.set(id, worker);
    void worker
      .finally(() => {
        this.workers.delete(id);
        const next = this.pending.shift();
        if (next) this.kick(next);
      })
      .catch(() => undefined);
  }
  private async execute(id: string): Promise<void> {
    const record = await this.read(id);
    if (!record || record.phase !== "queued") return;
    try {
      record.phase = "initializing";
      await writeDurableJsonAtomic(this.file(id), record);
      await this.execution.initialize(record.assignment, record.receipt.executor_id);
      if (!this.accepting) {
        record.phase = "held";
        await writeDurableJsonAtomic(this.file(id), record);
        return;
      }
      record.phase = "starting";
      await writeDurableJsonAtomic(this.file(id), record);
      await this.execution.start(record.assignment, record.receipt.executor_id, id);
      record.phase = "started";
      await writeDurableJsonAtomic(this.file(id), record);
    } catch {
      record.phase = "held";
      record.error =
        "Paseo admission needs provider/session readback; automatic duplicate start refused";
      await writeDurableJsonAtomic(this.file(id), record);
    }
  }
  async recover(): Promise<void> {
    let files: string[];
    try {
      files = await fs.readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const file of files.filter((f) => /^[a-f0-9]{64}\.json$/.test(f))) {
      const id = file.slice(0, -5),
        record = await this.read(id);
      if (!record) continue;
      if (record.phase === "queued") this.kick(id);
      else if (["initializing", "starting"].includes(record.phase)) {
        record.phase = "held";
        record.error =
          "Restart requires native session reconciliation; assignment identity retained";
        await writeDurableJsonAtomic(this.file(id), record);
      }
    }
  }
  async stop(): Promise<void> {
    this.accepting = false;
    await Promise.allSettled(this.workers.values());
  }
  async flush(): Promise<void> {
    await Promise.allSettled(this.workers.values());
  }
  async inspect(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid assignment id");
    const record = await this.read(id);
    if (!record) return null;
    return { receipt: record.receipt, phase: record.phase, error: record.error };
  }
}
