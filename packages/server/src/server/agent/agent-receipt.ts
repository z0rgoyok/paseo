import { Ajv } from "ajv";
import schema from "./agent-receipt.schema.json" with { type: "json" };
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { writeDurableJsonAtomic } from "../atomic-file.js";

export { schema as AgentReceiptJsonSchema };
export interface AgentReceipt {
  receipt_type: "task_started" | "task_state" | "review_completed";
  take_comment?: string;
  status?: "working" | "waiting_agents" | "needs_product_decision" | "infra_blocked" | "done";
  completion_comment?: string;
  blocker_comment?: string;
  review_artifact?: { path: string; sha256: string };
  verdict?: "approved" | "changes_requested" | "blocked";
}

const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addFormat("uri", (value) => {
  try {
    return Boolean(new URL(value).protocol);
  } catch {
    return false;
  }
});
const validate = ajv.compile<AgentReceipt>(schema);

/** Validation hook shared by every provider. IDs and actor/task binding are
 * supplied by runtime context; no new Tracker object is created by validation. */
export function validateAgentReceipt(input: unknown): AgentReceipt {
  if (!validate(input))
    throw new Error(
      "Agent receipt rejected by envelope/oneOf schema: " +
        (validate.errors ?? []).map((e) => `${e.instancePath || "/"}: ${e.keyword}`).join("; "),
    );
  return structuredClone(input);
}
function canonical(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(canonical);
  if (input !== null && typeof input === "object")
    return Object.fromEntries(
      Object.entries(input)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, canonical(value)]),
    );
  return input;
}
export function agentReceiptId(
  agentId: string,
  goalBinding: string,
  receipt: AgentReceipt,
): string {
  return createHash("sha256")
    .update(JSON.stringify([agentId, goalBinding, canonical(receipt)]))
    .digest("hex");
}

export async function verifyReviewArtifact(
  cwd: string,
  receipt: AgentReceipt,
): Promise<AgentReceipt> {
  if (receipt.receipt_type !== "review_completed" || !receipt.review_artifact)
    throw new Error("Review receipt required");
  const root = await fs.realpath(cwd),
    file = await fs.realpath(path.resolve(cwd, receipt.review_artifact.path));
  if (!file.startsWith(root + path.sep))
    throw new Error("Review artifact outside assigned workspace");
  const info = await fs.stat(file);
  if (!info.isFile() || info.size === 0 || info.size > 4 * 1024 * 1024)
    throw new Error("Invalid review artifact");
  const sha256 = createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
  if (sha256 !== receipt.review_artifact.sha256) throw new Error("Review artifact digest mismatch");
  return { ...receipt, review_artifact: { path: file, sha256 } };
}

export interface ReceiptRecord {
  receipt_id: string;
  agent_id: string;
  goal_binding: string;
  receipt: AgentReceipt;
  status: "pending" | "processed";
  result?: unknown;
}

/** Durable receive/processing ledger. ACK follows the hook result. A lost reply
 * replays the same ID; oneOf validation precedes any state mutation. */
export class AgentReceiptLedger {
  private readonly tails = new Map<string, Promise<unknown>>();
  constructor(readonly directory: string) {}
  private filename(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid receipt id");
    return path.join(this.directory, id + ".json");
  }
  async get(id: string): Promise<ReceiptRecord | null> {
    try {
      return JSON.parse(await fs.readFile(this.filename(id), "utf8")) as ReceiptRecord;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  submit<T>(
    agentId: string,
    goalBinding: string,
    input: unknown,
    apply: (receipt: AgentReceipt) => Promise<T>,
  ): Promise<ReceiptRecord> {
    const receipt = validateAgentReceipt(input),
      id = agentReceiptId(agentId, goalBinding, receipt);
    const previous = this.tails.get(id) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        const existing = await this.get(id);
        if (existing?.status === "processed") return existing;
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        const record: ReceiptRecord = {
          receipt_id: id,
          agent_id: agentId,
          goal_binding: goalBinding,
          receipt,
          status: "pending",
        };
        await writeDurableJsonAtomic(this.filename(id), record);
        record.result = await apply(receipt);
        record.status = "processed";
        await writeDurableJsonAtomic(this.filename(id), record);
        return record;
      });
    this.tails.set(id, current);
    void current
      .finally(() => {
        if (this.tails.get(id) === current) this.tails.delete(id);
      })
      .catch(() => undefined);
    return current;
  }
}
