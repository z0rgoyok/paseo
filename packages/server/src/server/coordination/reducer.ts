import { type Entity, type Operation, type Team, type Reference, identifier, jsonValue, requireThat, leader, isLead, member } from "./model.js";
import { taskReadiness, invalidate, validateGraph } from "./graph.js";

export interface Reduction { changed: string[]; broadcasts: string[]; acknowledgements: { id: string; version: number }[]; eventCursor?: number }
const kinds = new Set(["task", "section", "resource", "result", "assignment"]);
export function reduce(team: Team, actor: string, operations: Operation[], now: string): Reduction {
  member(team, actor);
  requireThat(Array.isArray(operations) && operations.length <= 100, "INVALID_UPDATE", "At most 100 operations per transaction");
  jsonValue(operations);
  const changed = new Set<string>(); const broadcasts = new Set<string>();
  const acknowledgements: Reduction["acknowledgements"] = [];
  let eventCursor: number | undefined;
  function get(id: string): Entity { identifier(id); const e = team.entities[id]; requireThat(e, "NOT_FOUND", id); return e; }
  function refs(values: Reference[]): Reference[] {
    requireThat(Array.isArray(values) && values.length <= 256, "INVALID_REFERENCES", "At most 256 explicit references");
    for (const ref of values) {
      const source = get(ref.id);
      requireThat(["about", "reply_to", "relies_on", "watches"].includes(ref.relation), "INVALID_RELATION", String(ref.relation));
      requireThat(ref.version === source.version, "VERSION_CONFLICT", ref.id);
      if (["relies_on", "watches"].includes(ref.relation)) requireThat(source.stale.length === 0 && !source.supersededBy, "STALE_BASIS", ref.id);
    }
    requireThat(new Set(values.map(r => `${r.relation}:${r.id}`)).size === values.length, "DUPLICATE_REFERENCE", "One reference per relation and source");
    return values;
  }
  function touch(entity: Entity): void { entity.version++; entity.updatedAt = now; changed.add(entity.id); }
  for (const op of operations) {
    switch (op.op) {
      case "put": {
        identifier(op.id); requireThat(!op.id.startsWith("agent:"), "RESERVED_ENTITY", "Live Paseo facts are daemon-owned"); requireThat(kinds.has(op.kind), "INVALID_KIND", "Use post for immutable messages");
        jsonValue(op.data); requireThat(op.data !== null && typeof op.data === "object" && !Array.isArray(op.data), "INVALID_DATA", op.id);
        if (["task", "section", "assignment"].includes(op.kind)) leader(team, actor);
        else requireThat(actor === "human" || team.members[actor]?.role !== "observer", "READ_ONLY_MEMBER", actor);
        const existing = team.entities[op.id];
        requireThat((existing?.version ?? 0) === op.expectedVersion, "VERSION_CONFLICT", op.id);
        requireThat(!existing || existing.kind === op.kind, "KIND_IMMUTABLE", op.id);
        requireThat(!existing || existing.author === actor || isLead(team, actor), "AUTHOR_REQUIRED", op.id);
        if (op.kind === "result") {
          requireThat(typeof op.data.artifact === "string" && typeof op.data.sha256 === "string" && /^[a-f0-9]{64}$/.test(op.data.sha256), "INVALID_RESULT", "Result needs an artifact reference and SHA-256; this does not verify its contents");
        }
        const references = refs(op.refs ?? existing?.refs ?? []);
        if (op.kind === "task" && op.data.status === "done") {
          requireThat(Array.isArray(op.data.evidence) && op.data.evidence.length > 0, "EVIDENCE_REQUIRED", op.id);
          for (const child of Object.values(team.entities).filter(e => e.kind === "task" && e.data.parent === op.id)) requireThat(child.data.status === "done" && !child.stale.length, "CHILD_NOT_COMPLETE", child.id);
        }
        if (op.kind === "result") {
          const task = get(String(op.data.taskId)); requireThat(task.kind === "task", "INVALID_RESULT_TASK", task.id);
          if (!references.some(r => r.id === task.id && r.relation === "about")) references.push({ id: task.id, version: task.version, relation: "about" });
        }
        if (op.kind === "assignment") {
          const task = get(String(op.data.taskId)); const agentId = String(op.data.agentId);
          requireThat(team.members[agentId], "NOT_A_MEMBER", agentId);
          requireThat(["active", "waiting", "complete", "cancelled"].includes(String(op.data.status)), "INVALID_ASSIGNMENT", op.id);
          if (op.data.status === "active") {
            requireThat(!team.members[agentId].paused, "AGENT_UNAVAILABLE", agentId);
            requireThat(taskReadiness(team, task).ready && task.data.status === "active", "TASK_NOT_READY", task.id);
            requireThat(!Object.values(team.entities).some(e => e.kind === "task" && e.data.parent === task.id), "TASK_NOT_LEAF", task.id);
            const others = Object.values(team.entities).filter(e => e.id !== op.id && e.kind === "assignment" && e.data.status === "active");
            requireThat(!others.some(e => e.data.agentId === agentId), "AGENT_ASSIGNED", agentId);
            const resources = op.data.exclusive_resources ?? [];
            requireThat(Array.isArray(resources) && resources.every(r => typeof r === "string"), "INVALID_RESOURCES", op.id);
            requireThat(!others.some(e => Array.isArray(e.data.exclusive_resources) && e.data.exclusive_resources.some(r => typeof r === "string" && resources.includes(r))), "RESOURCE_ASSIGNED", op.id);
            if (!references.some(r => r.id === task.id && r.relation === "relies_on")) references.push({ id: task.id, version: task.version, relation: "relies_on" });
          }
        }
        team.entities[op.id] = { id: op.id, kind: op.kind, version: (existing?.version ?? 0) + 1, author: existing?.author ?? actor,
          data: op.data, refs: references, stale: existing?.stale ?? [], createdAt: existing?.createdAt ?? now, updatedAt: now };
        changed.add(op.id);
        break;
      }
      case "post": {
        identifier(op.id); requireThat(!team.entities[op.id], "ALREADY_EXISTS", op.id);
        requireThat(actor === "human" || team.members[actor]?.role !== "observer", "READ_ONLY_MEMBER", actor);
        const priority = op.priority ?? "normal";
        requireThat(["normal", "important", "urgent"].includes(priority), "INVALID_PRIORITY", priority);
        requireThat(typeof op.text === "string" && op.text.trim() && op.text.length <= (priority === "urgent" ? 4000 : 64000), "INVALID_MESSAGE", "Text required; urgent up to 4000 characters, normal up to 64000");
        if (op.pinned) leader(team, actor);
        const references: Reference[] = [];
        const about = new Set(op.about ?? []);
        for (const sourceId of [op.replaces, op.replyTo]) {
          if (!sourceId) continue;
          for (const reference of get(sourceId).refs) if (reference.relation === "about") about.add(reference.id);
        }
        if (!about.size || op.material || priority === "urgent" || op.replaces) about.add("topic:worktree");
        for (const id of about) {
          identifier(id);
          if (!team.entities[id]) {
            requireThat(id.startsWith("topic:"), "NOT_FOUND", id);
            team.entities[id] = { id, kind: "resource", version: 1, author: actor, data: { title: id.slice(6) }, refs: [], stale: [], createdAt: now, updatedAt: now };
          }
          const subject = get(id);
          references.push({ id, version: subject.version, relation: "about" });
          if (op.material || priority === "urgent" || op.replaces) touch(subject);
        }
        if (op.replyTo) { const parent = get(op.replyTo); requireThat(parent.kind === "message", "INVALID_REPLY", parent.id); references.push({ id: parent.id, version: parent.version, relation: "reply_to" }); }
        if (op.replaces) {
          const prior = get(op.replaces);
          requireThat(prior.kind === "message" && !prior.supersededBy, "INVALID_REPLACEMENT", prior.id);
          requireThat(prior.author === actor || isLead(team, actor), "AUTHOR_REQUIRED", prior.id);
          prior.supersededBy = op.id; touch(prior);
          if (prior.data.priority === "urgent") { requireThat(op.text.length <= 4000, "INVALID_MESSAGE", "Urgent resolutions must fit the delivery envelope"); broadcasts.add(op.id); }
        }
        team.entities[op.id] = { id: op.id, kind: "message", version: 1, author: actor,
          data: { text: op.text, priority, pinned: op.pinned ?? false, references: op.references ?? [], ...(op.replaces ? { replaces: op.replaces } : {}) },
          refs: references, stale: [], createdAt: now, updatedAt: now };
        if (priority === "urgent") broadcasts.add(op.id);
        changed.add(op.id);
        break;
      }
      case "resolve": {
        const entity = get(op.id);
        requireThat(entity.kind !== "message" && !entity.id.startsWith("agent:"), "IMMUTABLE_RECORD", "Correct messages with a new post; live observations are daemon-owned");
        requireThat(entity.version === op.expectedVersion, "VERSION_CONFLICT", op.id);
        requireThat(entity.author === actor || isLead(team, actor), "AUTHOR_REQUIRED", op.id);
        requireThat(typeof op.explanation === "string" && op.explanation.trim().length >= 10, "EXPLANATION_REQUIRED", "Describe how the changed facts were considered");
        for (const reason of entity.stale) requireThat(op.observed.some(r => r.id === reason.source && r.version === get(reason.source).version), "UNOBSERVED_CHANGE", reason.source);
        for (const observed of op.observed) requireThat(get(observed.id).version === observed.version, "VERSION_CONFLICT", observed.id);
        // A decision may explicitly remain valid. Its explanation and observed versions are in history.
        entity.refs = entity.refs.map(r => ({ ...r, version: get(r.id).version }));
        entity.stale = []; touch(entity);
        break;
      }
      case "ack": { const entity = get(op.id); requireThat(entity.version === op.version, "VERSION_CONFLICT", op.id); acknowledgements.push({ id: op.id, version: op.version }); break; }
      case "ack_events": {
        requireThat(Number.isSafeInteger(op.through) && op.through >= 0, "INVALID_CURSOR", String(op.through));
        eventCursor = Math.max(eventCursor ?? 0, op.through); break;
      }
      case "pause": {
        leader(team, actor); identifier(op.agentId); requireThat(team.members[op.agentId], "NOT_A_MEMBER", op.agentId);
        requireThat(op.agentId !== team.leader || op.paused || actor === "human", "HOST_RESUME_REQUIRED", "Only the host can resume a paused lead");
        team.members[op.agentId].paused = op.paused; break;
      }
      case "member": {
        leader(team, actor); identifier(op.agentId);
        requireThat(op.agentId !== "human" && op.agentId !== team.leader, "INVALID_MEMBER", "Use handoff to change the lead");
        requireThat(["worker", "observer"].includes(op.role), "INVALID_ROLE", op.role);
        team.members[op.agentId] = { role: op.role, paused: op.paused ?? false }; break;
      }
      case "peers": {
        leader(team, actor);
        for (const pair of op.pairs) requireThat(pair.length === 2 && pair[0] !== pair[1] && team.members[pair[0]] && team.members[pair[1]], "INVALID_PEER", String(pair));
        team.peers = op.pairs; break;
      }
      case "handoff": {
        leader(team, actor); requireThat(op.expectedEpoch === team.epoch, "EPOCH_CONFLICT", "The lead already changed");
        requireThat(op.leader !== team.leader && team.members[op.leader] && !team.members[op.leader].paused, "INVALID_SUCCESSOR", op.leader);
        team.members[team.leader] = { role: "observer", paused: true };
        team.leader = op.leader; team.members[op.leader] = { role: "lead", paused: false }; team.epoch++; break;
      }
      default: throw new Error(`Unsupported coordination operation: ${String((op as { op: unknown }).op)}`);
    }
  }
  for (const id of changed) invalidate(team, id);
  validateGraph(team);
  return { changed: [...changed], broadcasts: [...broadcasts], acknowledgements, ...(eventCursor !== undefined ? { eventCursor } : {}) };
}
