/** Worktree-local coordination. Text remains authored by agents; links are explicit. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ObjectValue = { [key: string]: Json };
export type Relation = "about" | "reply_to" | "relies_on" | "watches";
export interface Reference { id: string; version: number; relation: Relation }
export interface Staleness { source: string; version: number; revision: number }
export interface Entity {
  id: string;
  kind: "task" | "section" | "message" | "resource" | "result" | "assignment";
  version: number;
  author: string;
  data: ObjectValue;
  refs: Reference[];
  stale: Staleness[];
  createdAt: string;
  updatedAt: string;
  supersededBy?: string;
}
export interface Member { role: "lead" | "worker" | "observer"; paused: boolean }
export interface Team {
  format: 1;
  root: string;
  revision: number;
  epoch: number;
  leader: string;
  schema: ObjectValue | null;
  members: Record<string, Member>;
  peers: [string, string][];
  entities: Record<string, Entity>;
}
export type Operation =
  | { op: "put"; id: string; kind: Entity["kind"]; expectedVersion: number; data: ObjectValue; refs?: Reference[] }
  | { op: "post"; id: string; text: string; priority?: "normal" | "important" | "urgent"; pinned?: boolean; about?: string[]; replyTo?: string; replaces?: string; material?: boolean; references?: string[] }
  | { op: "resolve"; id: string; expectedVersion: number; explanation: string; observed: { id: string; version: number }[] }
  | { op: "ack"; id: string; version: number }
  | { op: "member"; agentId: string; role: "worker" | "observer"; paused?: boolean }
  | { op: "peers"; pairs: [string, string][] }
  | { op: "handoff"; leader: string; expectedEpoch: number };
export interface Update { requestId: string; expectedRevision?: number; operations: Operation[] }
export interface Delivery {
  id: number; eventSeq: number; recipient: string; entityId: string; version: number;
  status: "pending" | "sending" | "delivered" | "acked" | "superseded";
  attempts: number; nextAttemptAt: number; leaseUntil: number; lastError: string | null;
}
export interface Command {
  id: string; actor: string; epoch: number; action: string; args: ObjectValue;
  target: string | null; taskId: string | null;
  status: "prepared" | "executing" | "completed" | "failed" | "unknown";
  result: Json; error: string | null;
}
export class CoordinationError extends Error {
  constructor(public readonly code: string, message: string) { super(`${code}: ${message}`); this.name = "CoordinationError"; }
}
export function requireThat(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new CoordinationError(code, message);
}
export function identifier(value: unknown): asserts value is string {
  requireThat(typeof value === "string" && value.length > 0 && value.length <= 512 && !["__proto__", "prototype", "constructor"].includes(value), "INVALID_ID", "Expected a nonempty, bounded identifier");
}
export function jsonValue(value: unknown, depth = 0): asserts value is Json {
  requireThat(depth < 64, "INVALID_JSON", "Maximum nesting exceeded");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") { requireThat(Number.isFinite(value), "INVALID_JSON", "Non-finite number"); return; }
  requireThat(typeof value === "object" && value !== null, "INVALID_JSON", "Only JSON values are supported");
  if (Array.isArray(value)) { for (const item of value) jsonValue(item, depth + 1); return; }
  requireThat(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, "INVALID_JSON", "Plain objects only");
  for (const [key, item] of Object.entries(value)) { identifier(key); jsonValue(item, depth + 1); }
}
export function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
export function canonical(value: unknown): string {
  jsonValue(value);
  function sorted(v: Json): Json {
    if (Array.isArray(v)) return v.map(sorted);
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted(v[k])]));
    return v;
  }
  return JSON.stringify(sorted(value));
}
export function isLead(team: Team, actor: string): boolean { return actor === "human" || actor === team.leader; }
export function member(team: Team, actor: string): void {
  requireThat(actor === "human" || Object.hasOwn(team.members, actor), "NOT_A_MEMBER", actor);
}
export function leader(team: Team, actor: string): void {
  member(team, actor); requireThat(isLead(team, actor), "LEAD_REQUIRED", "Only the current lead or authenticated host caller can change coordination policy");
}
