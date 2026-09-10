import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { type Team, type Entity, type Json, type Update, type Command, type ObjectValue, type Delivery, clone, canonical, identifier, member, leader, requireThat, isLead } from "./model.js";
import { reduce, type Reduction } from "./reducer.js";
import { stateProjection, taskReadiness, invalidate } from "./graph.js";

interface Statement { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[]; run(...args: unknown[]): { lastInsertRowid: number | bigint; changes: number | bigint } }
interface Database { exec(sql: string): void; prepare(sql: string): Statement; close(): void }
interface Sqlite { DatabaseSync: new(path: string) => Database }
export type SchemaValidator = (schema: ObjectValue, state: Record<string, unknown>) => void;
export interface BoardQuery { topic?: string; query?: string; before?: number; revision?: number; limit?: number; includeHistory?: boolean }
export interface BoardPage { messages: Entity[]; next: number | null; revision: number }
export interface Receipt { revision: number; eventSeq: number; changed: string[]; command?: Command }

export class TeamStore {
  private readonly db: Database;
  constructor(path: string, private readonly validateSchema?: SchemaValidator, private readonly clock = Date.now) {
    const sqlite = createRequire(import.meta.url)("node:sqlite") as Sqlite;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new sqlite.DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS team(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(actor TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(actor,id));
      CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries(id INTEGER PRIMARY KEY AUTOINCREMENT, eventSeq INTEGER NOT NULL, recipient TEXT NOT NULL, entityId TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, nextAttemptAt INTEGER NOT NULL DEFAULT 0, leaseUntil INTEGER NOT NULL DEFAULT 0, lastError TEXT, UNIQUE(eventSeq,recipient,entityId,version));
      CREATE TABLE IF NOT EXISTS receipts(actor TEXT NOT NULL, entityId TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(actor,entityId,version));
      CREATE TABLE IF NOT EXISTS inbox_cursors(owner TEXT PRIMARY KEY, seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS entities(id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS coordinator(id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, token TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), seconds INTEGER NOT NULL, nextAt INTEGER NOT NULL);`);
    // Losslessly import a pre-release single-row snapshot before normalized writes.
    this.transaction(() => {
      const row = this.db.prepare("SELECT value FROM team WHERE id=1").get() as { value: string } | undefined;
      if (!row) return;
      const team = JSON.parse(row.value) as Team;
      if (team.entities && Object.keys(team.entities).length) this.save(team);
    });
    if (path !== ":memory:") chmodSync(path, 0o600);
  }
  close(): void { this.db.close(); }

  acquireCoordinator(pid: number, token: string, alive: (pid: number) => boolean): void {
    this.transaction(() => {
      const owner = this.db.prepare("SELECT pid,token FROM coordinator WHERE id=1").get() as { pid: number; token: string } | undefined;
      requireThat(!owner || owner.token === token || !alive(owner.pid), "COORDINATOR_BUSY", "Another live daemon owns dispatch for this worktree");
      this.db.prepare("INSERT OR REPLACE INTO coordinator(id,pid,token) VALUES(1,?,?)").run(pid, token);
    });
  }
  releaseCoordinator(token: string): void { this.db.prepare("DELETE FROM coordinator WHERE id=1 AND token=?").run(token); }
  setHeartbeat(actor: string, seconds: number | null): void {
    this.transaction(() => {
      leader(this.load(), actor);
      if (seconds === null) this.db.prepare("DELETE FROM heartbeat WHERE id=1").run();
      else {
        requireThat(Number.isInteger(seconds) && seconds >= 30 && seconds <= 86400, "INVALID_HEARTBEAT", "Use 30..86400 seconds or null to disable");
        this.db.prepare("INSERT OR REPLACE INTO heartbeat(id,seconds,nextAt) VALUES(1,?,?)").run(seconds, this.clock() + seconds * 1000);
      }
      this.event(actor, "team.heartbeat.configured", { seconds });
    });
  }
  tick(): void {
    this.transaction(() => {
      const timer = this.db.prepare("SELECT seconds,nextAt FROM heartbeat WHERE id=1").get() as { seconds: number; nextAt: number } | undefined;
      if (!timer || timer.nextAt > this.clock()) return;
      this.db.prepare("UPDATE heartbeat SET nextAt=? WHERE id=1").run(this.clock() + timer.seconds * 1000);
      const seq = this.event("daemon", "team.heartbeat", { scheduledAt: timer.nextAt });
      this.enqueue(seq, "$lead", "$event", seq);
    });
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private event(actor: string, type: string, payload: unknown): number {
    return Number(this.db.prepare("INSERT INTO events(at,actor,type,payload) VALUES(?,?,?,?)").run(new Date(this.clock()).toISOString(), actor, type, canonical(payload)).lastInsertRowid);
  }
  isInitialized(): boolean {
    if (this.db.prepare("SELECT id FROM team WHERE id=1").get()) return true;
    requireThat(!this.db.prepare("SELECT seq FROM events LIMIT 1").get() && !this.db.prepare("SELECT id FROM entities LIMIT 1").get(), "CORRUPT_TEAM", "Coordination metadata is missing from a nonempty database");
    return false;
  }
  load(): Team {
    const row = this.db.prepare("SELECT value FROM team WHERE id=1").get() as { value: string } | undefined;
    requireThat(row, "TEAM_NOT_INITIALIZED", "Call team_init first");
    const team = JSON.parse(row.value) as Team;
    team.entities = Object.fromEntries((this.db.prepare("SELECT id,value FROM entities").all() as { id: string; value: string }[]).map(e => [e.id, JSON.parse(e.value)]));
    return team;
  }
  private save(team: Team): void {
    const { entities, ...metadata } = team;
    this.db.prepare("INSERT OR REPLACE INTO team(id,value) VALUES(1,?)").run(canonical(metadata));
    const existing = new Map((this.db.prepare("SELECT id,value FROM entities").all() as { id: string; value: string }[]).map(row => [row.id, row.value]));
    const write = this.db.prepare("INSERT INTO entities(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value");
    for (const entity of Object.values(entities)) {
      const value = canonical(entity);
      if (existing.get(entity.id) !== value) write.run(entity.id, value);
    }
  }
  initialize(root: string, lead: string, schema: ObjectValue | null = null): Team {
    identifier(lead); requireThat(lead !== "human", "INVALID_LEAD", "Select an agent as lead");
    return this.transaction(() => {
      requireThat(!this.db.prepare("SELECT id FROM team WHERE id=1").get(), "ALREADY_INITIALIZED", root);
      const team: Team = { format: 1, root, leader: lead, epoch: 1, revision: 1, schema, members: { [lead]: { role: "lead", paused: false } }, peers: [], entities: {} };
      if (schema) { requireThat(this.validateSchema, "SCHEMA_VALIDATOR_REQUIRED", "Configured schema validation cannot be skipped"); this.validateSchema(schema, stateProjection(team)); }
      this.save(team); this.event("human", "team.initialized", team); return clone(team);
    });
  }
  private replay(actor: string, id: string, digest: string): Receipt | null {
    identifier(id);
    const row = this.db.prepare("SELECT digest,receipt FROM requests WHERE actor=? AND id=?").get(actor, id) as { digest: string; receipt: string } | undefined;
    if (!row) return null;
    requireThat(row.digest === digest, "IDEMPOTENCY_CONFLICT", id);
    const result = JSON.parse(row.receipt) as Receipt;
    if (result.command) result.command = this.command(result.command.id);
    return result;
  }
  private enqueue(eventSeq: number, recipient: string, entityId: string, version: number): void {
    this.db.prepare("INSERT OR IGNORE INTO deliveries(eventSeq,recipient,entityId,version) VALUES(?,?,?,?)").run(eventSeq, recipient, entityId, version);
  }
  private recordUpdate(team: Team, actor: string, input: Update, reduction: Reduction, before: Team, type: string): Receipt {
    if (team.schema) { requireThat(this.validateSchema, "SCHEMA_VALIDATOR_REQUIRED", "Schema validation unavailable"); this.validateSchema(team.schema, stateProjection(team)); }
    this.save(team);
    const changed = Object.keys(team.entities).filter(id => canonical(team.entities[id]) !== canonical(before.entities[id] ?? null));
    const eventSeq = this.event(actor, type, { revision: team.revision, epoch: team.epoch, operations: input.operations,
      changes: changed.map(id => ({ id, before: before.entities[id] ?? null, after: team.entities[id] })), leader: team.leader });
    for (const id of reduction.broadcasts) {
      const entry = team.entities[id];
      for (const recipient of Object.keys(team.members)) if (recipient !== actor) this.enqueue(eventSeq, recipient, id, entry.version);
      if (entry.data.replaces) this.db.prepare("UPDATE deliveries SET status='superseded' WHERE entityId=? AND status<>'acked'").run(String(entry.data.replaces));
    }
    for (const ack of reduction.acknowledgements) {
      this.db.prepare("INSERT OR IGNORE INTO receipts(actor,entityId,version) VALUES(?,?,?)").run(actor, ack.id, ack.version);
      this.db.prepare("UPDATE deliveries SET status='acked',leaseUntil=0 WHERE recipient=? AND entityId=? AND version=?").run(actor, ack.id, ack.version);
    }
    // New members and successor sessions inherit all still-active urgent records.
    for (const id of Object.keys(team.members)) if (!before.members[id] || (id === team.leader && before.leader !== id)) {
      for (const e of Object.values(team.entities)) if (e.kind === "message" && e.data.priority === "urgent" && !e.supersededBy && e.author !== id) this.enqueue(eventSeq, id, e.id, e.version);
    }
    if (actor !== team.leader && changed.length) this.enqueue(eventSeq, "$lead", "$event", eventSeq);
    return { revision: team.revision, eventSeq, changed };
  }
  update(actor: string, input: Update): Receipt { return this.mutate(actor, input); }
  prepare(actor: string, input: Update, action: string, args: ObjectValue, target: string | null, taskId: string | null): Receipt {
    return this.mutate(actor, input, { action, args, target, taskId });
  }
  private mutate(actor: string, input: Update, intent?: Pick<Command, "action" | "args" | "target" | "taskId">): Receipt {
    const digest = createHash("sha256").update(canonical({ input, intent: intent ?? null })).digest("hex");
    return this.transaction(() => {
      const old = this.replay(actor, input.requestId, digest); if (old) return old;
      const team = this.load(); member(team, actor);
      if (input.expectedRevision !== undefined) requireThat(team.revision === input.expectedRevision, "REVISION_CONFLICT", String(team.revision));
      if (input.operations.some(op => op.op === "handoff")) {
        requireThat(!this.commands().some(c => ["prepared", "executing", "unknown"].includes(c.status)), "HANDOFF_BUSY", "Reconcile outstanding commands before changing authority");
      }
      if (intent) requireThat(!this.commands().some(c => c.action === "lead_handoff" && ["prepared", "executing", "unknown"].includes(c.status)), "HANDOFF_BUSY", "A native handoff is unresolved");
      const before = clone(team); team.revision++;
      const reduction = reduce(team, actor, input.operations, new Date(this.clock()).toISOString());
      if (reduction.eventCursor !== undefined) {
        const maximum = Number((this.db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM events").get() as { seq: number }).seq);
        requireThat(reduction.eventCursor <= maximum && reduction.eventCursor >= this.inboxCursor(actor), "INVALID_CURSOR", "Acknowledgement must advance within observed event history");
        const owner = isLead(team, actor) ? "$lead" : actor;
        this.db.prepare("INSERT OR REPLACE INTO inbox_cursors(owner,seq) VALUES(?,?)").run(owner, reduction.eventCursor);
        this.db.prepare("UPDATE deliveries SET status='acked',leaseUntil=0 WHERE recipient=? AND entityId='$event' AND eventSeq<=?").run(owner, reduction.eventCursor);
      }
      for (const ack of reduction.acknowledgements) this.db.prepare("INSERT OR IGNORE INTO receipts(actor,entityId,version) VALUES(?,?,?)").run(actor, ack.id, ack.version);
      let command: Command | undefined;
      if (intent) {
        this.authorize(team, actor, intent.action, intent.target, intent.taskId);
        const id = createHash("sha256").update(canonical([actor, input.requestId])).digest("hex");
        command = { id, actor, epoch: team.epoch, ...intent, status: "prepared", result: null, error: null };
        this.db.prepare("INSERT INTO commands(id,value) VALUES(?,?)").run(id, canonical(command));
      }
      const receipt = this.recordUpdate(team, actor, input, reduction, before, intent ? "command.prepared" : "team.updated");
      if (command) receipt.command = command;
      this.db.prepare("INSERT INTO requests(actor,id,digest,receipt) VALUES(?,?,?,?)").run(actor, input.requestId, digest, canonical(receipt));
      return receipt;
    });
  }
  authorize(team: Team, actor: string, action: string, target: string | null, taskId: string | null): void {
    member(team, actor);
    requireThat(actor === "human" || !team.members[actor].paused || (action === "cancel_agent" && actor === target && isLead(team, actor)), "AGENT_PAUSED", actor);
    if (!isLead(team, actor)) {
      requireThat(action === "send_agent_prompt" && target && (target === team.leader || team.peers.some(([a,b]) => (a === actor && b === target) || (a === target && b === actor))), "PEER_NOT_ALLOWED", target ?? action);
      requireThat(team.members[actor]?.role === "worker" && !team.members[actor].paused, "AGENT_PAUSED", actor);
    }
    if (target) requireThat(team.members[target], "CROSS_TEAM_TARGET", target);
    if (["create_agent", "send_agent_prompt"].includes(action)) {
      if (target) requireThat(!team.members[target].paused, "AGENT_PAUSED", target);
      requireThat(!this.pendingUrgent(actor, team).length, "URGENT_ACK_REQUIRED", actor);
      if (taskId) { const task = team.entities[taskId]; requireThat(task && taskReadiness(team, task).ready && task.data.status === "active", "TASK_NOT_READY", taskId); }
      const stale = Object.values(team.entities).filter(e => e.stale.length && (e.kind === "section" || e.id === taskId || (e.kind === "assignment" && e.data.agentId === target)));
      requireThat(!stale.length, "RECONSIDERATION_REQUIRED", stale.map(e => e.id).join(", "));
    }
  }
  command(id: string): Command {
    const row = this.db.prepare("SELECT value FROM commands WHERE id=?").get(id) as { value: string } | undefined;
    requireThat(row, "COMMAND_NOT_FOUND", id); return JSON.parse(row.value) as Command;
  }
  commands(): Command[] { return (this.db.prepare("SELECT value FROM commands ORDER BY rowid").all() as { value: string }[]).map(r => JSON.parse(r.value) as Command); }
  claim(id: string): Command {
    return this.transaction(() => {
      const command = this.command(id); const team = this.load();
      requireThat(command.status === "prepared", "COMMAND_ALREADY_ATTEMPTED", id);
      requireThat(command.epoch === team.epoch, "EPOCH_CONFLICT", id);
      this.authorize(team, command.actor, command.action, command.target, command.taskId);
      command.status = "executing"; this.db.prepare("UPDATE commands SET value=? WHERE id=?").run(canonical(command), id);
      this.event(command.actor, "command.executing", command); return command;
    });
  }
  finish(id: string, status: "completed" | "failed" | "unknown", result: Json, error: string | null = null): void {
    this.transaction(() => { const command = this.command(id); requireThat(command.status === "executing", "INVALID_COMMAND_STATE", command.status);
      command.status = status; command.result = result; command.error = error;
      this.db.prepare("UPDATE commands SET value=? WHERE id=?").run(canonical(command), id); this.event(command.actor, `command.${status}`, command); });
  }
  reconcile(actor: string, id: string, status: "completed" | "failed", evidence: string): void {
    this.transaction(() => { leader(this.load(), actor); requireThat(evidence.trim().length >= 10, "EVIDENCE_REQUIRED", id); const command = this.command(id);
      requireThat(command.status === "unknown" || (command.status === "prepared" && status === "failed"), "INVALID_COMMAND_STATE", command.status);
      command.status = status; command.error = evidence; this.db.prepare("UPDATE commands SET value=? WHERE id=?").run(canonical(command), id);
      this.event(actor, "command.reconciled", { command, evidence }); });
  }
  recover(): void {
    this.transaction(() => { for (const command of this.commands()) if (command.status === "executing") {
      command.status = "unknown"; command.error = "Process stopped during dispatch; inspect the actual agent before reconciling. Never replay blindly.";
      this.db.prepare("UPDATE commands SET value=? WHERE id=?").run(canonical(command), command.id); this.event("daemon", "command.unknown", command);
    } });
  }
  resetRuntimeObservations(): void {
    if (!this.isInitialized()) return;
    this.transaction(() => {
      const team = this.load(); const changed: string[] = []; team.revision++;
      for (const entity of Object.values(team.entities)) {
        if (!entity.id.startsWith("agent:") || entity.author !== "daemon") continue;
        entity.data = { ...entity.data, status: "unknown", previousStatus: entity.data.status ?? null };
        entity.version++; entity.updatedAt = new Date(this.clock()).toISOString(); changed.push(entity.id);
      }
      if (!changed.length) return;
      for (const id of changed) invalidate(team, id);
      this.save(team); const seq = this.event("daemon", "runtime.restarted", { revision: team.revision, changed });
      this.enqueue(seq, "$lead", "$event", seq);
    });
  }
  inboxCursor(actor: string): number {
    const team = this.load(); member(team, actor);
    const row = this.db.prepare("SELECT seq FROM inbox_cursors WHERE owner=?").get(isLead(team, actor) ? "$lead" : actor) as { seq: number } | undefined;
    return row?.seq ?? 0;
  }
  history(actor: string, after = 0, limit = 50): { events: unknown[]; next: number } {
    member(this.load(), actor); requireThat(Number.isSafeInteger(after) && after >= 0, "INVALID_CURSOR", String(after));
    requireThat(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, "INVALID_LIMIT", String(limit));
    const rows = this.db.prepare("SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?").all(after, limit) as { seq: number; payload: string }[];
    return { events: rows.map(r => ({ ...r, payload: JSON.parse(r.payload) })), next: rows.at(-1)?.seq ?? after };
  }
  deliveries(actor: string): Delivery[] {
    member(this.load(), actor);
    const all = this.db.prepare("SELECT * FROM deliveries ORDER BY id").all() as Delivery[];
    return isLead(this.load(), actor) ? all : all.filter(d => d.recipient === actor);
  }
  pendingUrgent(actor: string, team = this.load()): string[] {
    return Object.values(team.entities).filter(e => e.kind === "message" && e.data.priority === "urgent" && !e.supersededBy && e.author !== actor && !this.db.prepare("SELECT 1 FROM receipts WHERE actor=? AND entityId=? AND version=?").get(actor, e.id, e.version)).map(e => e.id);
  }
  deliveryCurrent(id: number, attempt: number): boolean {
    return Boolean(this.db.prepare("SELECT id FROM deliveries WHERE id=? AND attempts=? AND status='sending' AND leaseUntil>?").get(id, attempt, this.clock()));
  }
  claimDeliveries(runningAgents: string[], limit = 20): Delivery[] {
    return this.transaction(() => {
      const team = this.load(); const now = this.clock(); const result: Delivery[] = [];
      const recipients = [...new Set(runningAgents.filter(id => team.members[id] && !team.members[id].paused))];
      if (recipients.includes(team.leader)) recipients.push("$lead");
      if (!recipients.length) return [];
      const marks = recipients.map(() => "?").join(",");
      const rows = this.db.prepare(`SELECT * FROM deliveries WHERE (status='pending' OR (status='sending' AND leaseUntil<?)) AND nextAttemptAt<=? AND recipient IN (${marks}) ORDER BY CASE WHEN entityId='$event' THEN 1 ELSE 0 END,id LIMIT ?`).all(now, now, ...recipients, limit) as Delivery[];
      for (const delivery of rows) {
        const recipient = delivery.recipient === "$lead" ? team.leader : delivery.recipient;
        if (!runningAgents.includes(recipient) || team.members[recipient]?.paused || result.length >= limit) continue;
        delivery.status = "sending"; delivery.leaseUntil = now + 120000; delivery.attempts++;
        this.db.prepare("UPDATE deliveries SET status='sending',leaseUntil=?,attempts=? WHERE id=?").run(delivery.leaseUntil, delivery.attempts, delivery.id);
        result.push(delivery);
      }
      return result;
    });
  }
  deliveryResult(id: number, attempts: number, error: string | null): void {
    const delay = Math.min(60000, 1000 * 2 ** Math.min(attempts, 6));
    this.db.prepare("UPDATE deliveries SET status=?,leaseUntil=0,nextAttemptAt=?,lastError=? WHERE id=? AND status='sending' AND attempts=?").run(error ? "pending" : "delivered", this.clock() + delay, error, id, attempts);
  }
  observe(agentId: string, observation: ObjectValue): void {
    this.transaction(() => {
      const team = this.load(); if (!team.members[agentId]) return;
      const id = `agent:${agentId}`; const previous = team.entities[id];
      if (previous && canonical(previous.data) === canonical(observation)) return;
      const now = new Date(this.clock()).toISOString(); team.revision++;
      team.entities[id] = { id, kind: "resource", author: "daemon", version: (previous?.version ?? 0) + 1, data: observation,
        refs: [], stale: [], createdAt: previous?.createdAt ?? now, updatedAt: now };
      invalidate(team, id); this.save(team);
      const seq = this.event("daemon", "agent.observed", { agentId, before: previous ?? null, after: team.entities[id] });
      if (agentId !== team.leader) this.enqueue(seq, "$lead", "$event", seq);
    });
  }
  private snapshotValue(actor: string): Record<string, unknown> {
    const team = this.load(); member(team, actor);
    return { ...stateProjection(team), root: team.root, members: team.members, peers: team.peers,
      observations: Object.values(team.entities).filter(e => e.id.startsWith("agent:") && e.author === "daemon").map(e => ({ agentId: e.id.slice(6), ...e.data, observedAt: e.updatedAt, version: e.version })),
      inboxCursor: this.inboxCursor(actor),
      heartbeat: this.db.prepare("SELECT seconds,nextAt FROM heartbeat WHERE id=1").get() ?? null,
      pendingUrgent: this.pendingUrgent(actor), deliveries: this.deliveries(actor),
      lastEventSeq: Number((this.db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM events").get() as { seq: number }).seq) };
  }
  snapshot(actor: string): Record<string, unknown> { return this.transaction(() => this.snapshotValue(actor)); }
  bundle(actor: string, query?: string): Record<string, unknown> {
    return this.transaction(() => {
      const snapshot = this.snapshotValue(actor);
      return { snapshot, board: this.boardValue(actor, { query }), history: this.history(actor, Math.max(0, Number(snapshot.lastEventSeq) - 50), 50) };
    });
  }
  board(actor: string, options: BoardQuery = {}): BoardPage { return this.transaction(() => this.boardValue(actor, options)); }
  private boardValue(actor: string, options: { topic?: string; query?: string; before?: number; revision?: number; limit?: number; includeHistory?: boolean } = {}): { messages: Entity[]; next: number | null; revision: number } {
    const team = this.load(); member(team, actor);
    if (options.revision !== undefined) requireThat(options.revision === team.revision, "REVISION_CONFLICT", "The board changed; restart pagination");
    const limit = options.limit ?? 30; const offset = options.before ?? 0;
    requireThat(Number.isSafeInteger(limit) && limit > 0 && limit <= 100 && Number.isSafeInteger(offset) && offset >= 0, "INVALID_PAGE", "Bounded pagination required");
    const query = options.query?.toLocaleLowerCase();
    const rows = Object.values(team.entities).filter(e => e.kind === "message" && (options.includeHistory || !e.supersededBy) && (!options.topic || e.refs.some(r => r.id === options.topic)) && (!query || String(e.data.text).toLocaleLowerCase().includes(query)));
    const rank = (e: (typeof rows)[number]) => !e.supersededBy && e.data.priority === "urgent" ? 0 : e.data.pinned ? 1 : e.data.priority === "important" ? 2 : 3;
    rows.sort((a,b) => rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return { messages: rows.slice(offset, offset + limit), next: rows.length > offset + limit ? offset + limit : null, revision: team.revision };
  }
}
