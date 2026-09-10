import { type Entity, type Team, requireThat } from "./model.js";

const invalidating = new Set(["relies_on", "watches"]);
/** Traverse reverse dependencies to a fixed point. Replies/about never invalidate. */
export function invalidate(team: Team, source: string): string[] {
  const affected: string[] = [];
  const queue = [source];
  const visited = new Set(queue);
  const origin = team.entities[source];
  for (let i = 0; i < queue.length; i++) {
    for (const entity of Object.values(team.entities)) {
      if (visited.has(entity.id) || !entity.refs.some(ref => ref.id === queue[i] && invalidating.has(ref.relation) && (queue[i] !== source || ref.version < origin.version))) continue;
      entity.stale = [...entity.stale.filter(reason => reason.source !== source), { source, version: origin.version, revision: team.revision }];
      visited.add(entity.id); queue.push(entity.id); affected.push(entity.id);
    }
  }
  return affected;
}
function deps(team: Team, entity: Entity): string[] {
  const values = entity.data.depends_on ?? [];
  requireThat(Array.isArray(values) && values.every(v => typeof v === "string"), "INVALID_PLAN", `${entity.id}.depends_on must be an array of IDs`);
  const result = [...values] as string[];
  const seen = new Set([entity.id]);
  let parent = entity.data.parent;
  while (parent) {
    requireThat(typeof parent === "string" && !seen.has(parent), "PLAN_CYCLE", entity.id);
    seen.add(parent);
    const item = team.entities[parent];
    requireThat(item?.kind === "task", "DANGLING_REFERENCE", String(parent));
    const inherited = item.data.depends_on ?? [];
    requireThat(Array.isArray(inherited) && inherited.every(v => typeof v === "string"), "INVALID_PLAN", parent);
    result.push(...inherited as string[]); parent = item.data.parent;
  }
  return [...new Set(result)];
}
export function validateGraph(team: Team): void {
  const entities = Object.values(team.entities);
  for (const entity of entities) {
    for (const ref of entity.refs) {
      const target = team.entities[ref.id];
      requireThat(target && ref.id !== entity.id, "DANGLING_REFERENCE", `${entity.id} -> ${ref.id}`);
      requireThat(Number.isSafeInteger(ref.version) && ref.version > 0 && ref.version <= target.version, "INVALID_REFERENCE_VERSION", ref.id);
    }
    if (entity.kind === "assignment") {
      const task = team.entities[String(entity.data.taskId)];
      requireThat(task?.kind === "task" && team.members[String(entity.data.agentId)], "INVALID_ASSIGNMENT", entity.id);
    }
    if (entity.kind !== "task") continue;
    requireThat(["pending", "active", "blocked", "done", "cancelled", "deferred"].includes(String(entity.data.status)), "INVALID_PLAN", `${entity.id}: unknown status`);
    for (const id of deps(team, entity)) requireThat(team.entities[id]?.kind === "task", "DANGLING_REFERENCE", id);
    if (entity.data.status === "blocked") requireThat(typeof entity.data.blocking_reason === "string" && entity.data.blocking_reason.trim(), "INVALID_PLAN", `${entity.id}: blocker required`);
    if (entity.data.status === "active") requireThat(!entity.data.blocking_reason, "INVALID_PLAN", `${entity.id}: active work cannot carry a waiting-stage blocker`);
    if (entity.data.status === "done") {
      requireThat(Array.isArray(entity.data.evidence) && entity.data.evidence.length > 0, "EVIDENCE_REQUIRED", entity.id);
      for (const child of entities.filter(e => e.kind === "task" && e.data.parent === entity.id)) {
        requireThat(child.data.status === "done" || entity.stale.length > 0, "CHILD_NOT_COMPLETE", child.id);
      }
    }
  }
  function assertAcyclic(edges: (entity: Entity) => string[]): void {
    const done = new Set<string>(); const visiting = new Set<string>();
    function walk(id: string): void {
      requireThat(!visiting.has(id), "DEPENDENCY_CYCLE", id);
      if (done.has(id)) return;
      visiting.add(id); for (const target of edges(team.entities[id])) walk(target);
      visiting.delete(id); done.add(id);
    }
    for (const entity of entities) walk(entity.id);
  }
  assertAcyclic(e => e.refs.filter(r => invalidating.has(r.relation)).map(r => r.id));
  // Completion of a parent depends on children; inherited prerequisites also apply.
  assertAcyclic(e => e.kind !== "task" ? [] : [...deps(team, e), ...entities.filter(x => x.kind === "task" && x.data.parent === e.id).map(x => x.id)]);
}
export function taskReadiness(team: Team, entity: Entity): { ready: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (entity.kind !== "task") return { ready: false, reasons: ["not a task"] };
  if (!["pending", "active"].includes(String(entity.data.status))) reasons.push(`status:${entity.data.status}`);
  if (entity.stale.length) reasons.push("needs reconsideration");
  for (const id of deps(team, entity)) {
    const source = team.entities[id];
    if (!source || source.data.status !== "done" || source.stale.length) reasons.push(`prerequisite:${id}`);
  }
  if (entity.data.blocking_reason) reasons.push(String(entity.data.blocking_reason));
  return { ready: reasons.length === 0, reasons };
}
export function stateProjection(team: Team): Record<string, unknown> {
  const entities = Object.values(team.entities);
  const tasks = entities.filter(e => e.kind === "task");
  function node(e: Entity): unknown {
    return { id: e.id, ...e.data, version: e.version, freshness: e.stale.length ? "needs_reconsideration" : "current", stale: e.stale,
      readiness: taskReadiness(team, e), children: tasks.filter(t => t.data.parent === e.id).map(node) };
  }
  return { revision: team.revision, epoch: team.epoch, leader: team.leader,
    sections: Object.fromEntries(entities.filter(e => e.kind === "section").map(e => [e.id, { data: e.data, version: e.version, stale: e.stale }])),
    plan: tasks.filter(e => !e.data.parent).map(node),
    assignments: entities.filter(e => e.kind === "assignment"),
    needs_reconsideration: entities.filter(e => e.stale.length).map(e => ({ id: e.id, reasons: e.stale })) };
}
