import { createRequire } from 'node:module';
const requireSqlite = () => createRequire(import.meta.url)('node:sqlite');
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const compiled = pathToFileURL(join(process.env.PASEO_TEAM_TEST_BUILD ?? new URL('../.coordination-build/', import.meta.url).pathname, '/')).href;
const load = name => import(new URL(name + '.js', compiled));
const { TeamStore } = await load('store');
const { taskReadiness } = await load('graph');

let n = 0;
const request = (operations, extra = {}) => ({ requestId: `r${++n}`, operations, ...extra });
const put = (id, kind, data, expectedVersion = 0, refs = []) => ({ op: 'put', id, kind, data, expectedVersion, refs });
const ref = (id, version, relation = 'relies_on') => ({ id, version, relation });
const post = (id, text, extra = {}) => ({ op: 'post', id, text, ...extra });
function setup(t, validate, path = ':memory:', clock) {
  const s = new TeamStore(path, validate, clock); s.initialize('/repo/worktree-a', 'lead');
  s.update('lead', request([{ op: 'member', agentId: 'a', role: 'worker' }, { op: 'member', agentId: 'b', role: 'worker' }]));
  t.after(() => s.close()); return s;
}
test('raw messages retain authored text, references and thread links', t => {
  const s = setup(t); s.update('a', request([post('m1', 'Original finding', { about: ['topic:api'], references: ['result.json'] })]));
  s.update('b', request([post('m2', 'I disagree with this interpretation', { replyTo: 'm1' })]));
  assert.equal(s.load().entities.m1.data.text, 'Original finding');
  assert(s.load().entities.m2.refs.some(r => r.relation === 'reply_to' && r.id === 'm1'));
  assert.equal(s.board('a', { query: 'finding' }).messages.length, 1);
});
test('one source correction invalidates all transitive consumers, not replies', t => {
  const s = setup(t);
  s.update('lead', request([post('m1', 'CI on current code'), put('focus', 'section', { text: 'Ship' }, 0, [ref('m1', 1)]), put('next', 'section', { text: 'Then verify UI' }, 0, [ref('focus', 1)]), post('reply', 'Noted', { replyTo: 'm1' })]));
  assert.equal(s.load().entities.focus.stale.length, 0);
  s.update('lead', request([post('m2', 'Correction: CI was for an older commit', { replaces: 'm1' })]));
  assert.equal(s.load().entities.focus.stale[0].source, 'm1');
  assert.equal(s.load().entities.next.stale[0].source, 'm1');
  assert.equal(s.load().entities.reply.stale.length, 0);
  assert.equal(s.load().entities.m1.supersededBy, 'm2');
  assert.equal(s.board('a').messages.some(x => x.id === 'm1'), false);
  assert.equal(s.board('a', { includeHistory: true }).messages.some(x => x.id === 'm1'), true);
});
test('new relevant material invalidates watches even without a previous message link', t => {
  const s = setup(t);
  s.update('lead', request([put('topic:runtime', 'resource', { text: 'Runtime' }), put('intent', 'section', { text: 'No blockers' }, 0, [ref('topic:runtime', 1, 'watches')])]));
  s.update('a', request([post('routine', 'Reading logs', { about: ['topic:runtime'] })]));
  assert.equal(s.load().entities.intent.stale.length, 0);
  s.update('a', request([post('new-constraint', 'Wrong deployment', { about: ['topic:runtime'], material: true })]));
  assert.equal(s.load().entities.intent.stale.length, 1);
});
test('timestamp-only rewrites do not clear reconsideration obligations', t => {
  const s = setup(t);
  s.update('lead', request([put('source', 'resource', { value: 1 }), put('focus', 'section', { text: 'Continue' }, 0, [ref('source', 1)])]));
  s.update('lead', request([put('source', 'resource', { value: 2 }, 1)]));
  s.update('lead', request([put('focus', 'section', { text: 'Continue', timestamp: 'new' }, 1, [ref('source', 2)])]));
  assert.equal(s.load().entities.focus.stale.length, 1);
  assert.throws(() => s.update('lead', request([{ op: 'resolve', id: 'focus', expectedVersion: 2, explanation: 'Reviewed the changed input', observed: [] }])), /UNOBSERVED_CHANGE/);
  s.update('lead', request([{ op: 'resolve', id: 'focus', expectedVersion: 2, explanation: 'The changed input affects only the other environment', observed: [{ id: 'source', version: 2 }] }]));
  assert.equal(s.load().entities.focus.stale.length, 0);
});
test('source revision changed during reasoning rejects stale decision', t => {
  const s = setup(t); s.update('lead', request([put('source', 'resource', { value: 1 })]));
  s.update('lead', request([put('source', 'resource', { value: 2 }, 1)]));
  assert.throws(() => s.update('lead', request([put('focus', 'section', { text: 'Based on old data' }, 0, [ref('source', 1)])])), /VERSION_CONFLICT/);
});
test('dangling references and dependency cycles roll back entire update', t => {
  const s = setup(t); const revision = s.load().revision;
  assert.throws(() => s.update('lead', request([put('x', 'section', {}, 0, [ref('absent', 1)])])), /NOT_FOUND/);
  assert.equal(s.load().revision, revision);
  s.update('lead', request([put('x', 'section', {}), put('y', 'section', {}, 0, [ref('x', 1)])]));
  assert.throws(() => s.update('lead', request([put('x', 'section', {}, 1, [ref('y', 1)])])), /DEPENDENCY_CYCLE/);
  assert.equal(s.load().entities.x.version, 1);
});
test('inherited prerequisites and cancelled tasks do not falsely become ready', t => {
  const s = setup(t);
  s.update('lead', request([put('pre', 'task', { status: 'cancelled' }), put('parent', 'task', { status: 'pending', depends_on: ['pre'] }), put('child', 'task', { status: 'pending', parent: 'parent' })]));
  assert.equal(taskReadiness(s.load(), s.load().entities.child).ready, false);
  assert.throws(() => s.update('lead', request([put('pre', 'task', { status: 'pending', depends_on: ['child'] }, 1)])), /DEPENDENCY_CYCLE/);
});
test('done needs evidence and completed children; idle never marks task done', t => {
  const s = setup(t);
  assert.throws(() => s.update('lead', request([put('task', 'task', { status: 'done' })])), /EVIDENCE_REQUIRED/);
  s.update('lead', request([put('task', 'task', { status: 'active' })]));
  s.observe('a', { status: 'idle', turnId: null });
  assert.equal(s.load().entities.task.data.status, 'active');
});
test('workers cannot edit plans, pin decisions, impersonate lead or replace a peer', t => {
  const s = setup(t);
  assert.throws(() => s.update('a', request([put('focus', 'section', { text: 'Deploy' })])), /LEAD_REQUIRED/);
  assert.throws(() => s.update('a', request([post('pin', 'Deploy', { pinned: true })])), /LEAD_REQUIRED/);
  s.update('a', request([post('m1', 'My finding')]));
  assert.throws(() => s.update('b', request([post('m2', 'I overwrite you', { replaces: 'm1' })])), /AUTHOR_REQUIRED/);
});
test('urgent publication persists all recipients but claims only running recipients', t => {
  const s = setup(t); s.update('a', request([post('u1', 'Backend temporarily unreliable', { priority: 'urgent' })]));
  const ds = s.deliveries('lead').filter(d => d.entityId === 'u1'); assert.deepEqual(ds.map(d => d.recipient).sort(), ['b', 'lead']);
  const claimed = s.claimDeliveries(['b']); assert.equal(claimed.length, 1); assert.equal(claimed[0].recipient, 'b');
  s.deliveryResult(claimed[0].id, claimed[0].attempts, null);
  assert.equal(s.pendingUrgent('b')[0], 'u1');
  s.update('b', request([{ op: 'ack', id: 'u1', version: 1 }])); assert.equal(s.pendingUrgent('b').length, 0);
});
test('new members inherit urgent messages; acknowledged warnings remain on board', t => {
  const s = setup(t); s.update('a', request([post('u1', 'Keep this restriction', { priority: 'urgent' })]));
  s.update('lead', request([{ op: 'member', agentId: 'c', role: 'worker' }]));
  assert.equal(s.pendingUrgent('c')[0], 'u1');
  s.update('c', request([{ op: 'ack', id: 'u1', version: 1 }]));
  assert.equal(s.board('c').messages[0].id, 'u1');
});
test('replacing urgent warning closes old delivery and broadcasts its resolution', t => {
  const s = setup(t); s.update('a', request([post('u1', 'Old warning', { priority: 'urgent' })]));
  s.update('a', request([post('u2', 'The deployment has been corrected', { replaces: 'u1' })]));
  assert.equal(s.pendingUrgent('b').length, 0);
  assert.equal(s.deliveries('lead').find(d => d.entityId === 'u1').status, 'superseded');
  assert(s.deliveries('lead').some(d => d.entityId === 'u2' && d.recipient === 'b'));
});
test('failed urgent delivery remains retryable across reopening with a lease', t => {
  const dir = mkdtempSync(join(tmpdir(), 'team-store-')); t.after(() => rmSync(dir, { recursive: true, force: true })); let now = 1;
  const path = join(dir, 'team.sqlite'); const s = new TeamStore(path, undefined, () => now); s.initialize('/repo', 'lead');
  s.update('lead', request([{ op: 'member', agentId: 'b', role: 'worker' }, post('u', 'Warning', { priority: 'urgent' })]));
  const first = s.claimDeliveries(['b'])[0]; assert(first); s.close();
  const second = new TeamStore(path, undefined, () => now); t.after(() => second.close());
  assert.equal(second.claimDeliveries(['b']).length, 0); now += 120001;
  const retry = second.claimDeliveries(['b'])[0]; assert.equal(retry.id, first.id); assert.equal(retry.attempts, 2);
  second.deliveryResult(first.id, first.attempts, null); assert.equal(second.deliveries('lead')[0].status, 'sending');
});
test('idempotency applies before revision check and mismatched reuse is rejected', t => {
  const s = setup(t); const input = request([post('m', 'Keep once')], { expectedRevision: s.load().revision });
  const first = s.update('a', input); assert.deepEqual(s.update('a', input), first);
  assert.throws(() => s.update('a', { ...input, operations: [post('other', 'Different')] }), /IDEMPOTENCY_CONFLICT/);
});
test('state and command intent are committed before dispatch', t => {
  const s = setup(t); const receipt = s.prepare('lead', request([put('focus', 'section', { text: 'Continue implementation' })]), 'send_agent_prompt', { agentId: 'a', prompt: 'Continue' }, 'a', null);
  assert.equal(s.command(receipt.command.id).status, 'prepared'); assert.equal(s.load().entities.focus.data.text, 'Continue implementation');
  s.claim(receipt.command.id); s.finish(receipt.command.id, 'completed', { accepted: true });
  assert.throws(() => s.claim(receipt.command.id), /COMMAND_ALREADY_ATTEMPTED/);
});
test('communication ACL and pending urgent block dispatch, stop remains possible', t => {
  const s = setup(t);
  assert.throws(() => s.prepare('a', request([]), 'send_agent_prompt', {}, 'b', null), /PEER_NOT_ALLOWED/);
  s.update('lead', request([{ op: 'peers', pairs: [['a', 'b']] }]));
  s.prepare('a', request([]), 'send_agent_prompt', {}, 'b', null);
  s.update('b', request([post('u', 'Stop relying on the old server', { priority: 'urgent' })]));
  assert.throws(() => s.prepare('lead', request([]), 'send_agent_prompt', {}, 'a', null), /URGENT_ACK_REQUIRED/);
  assert(s.prepare('lead', request([]), 'cancel_agent', {}, 'a', null).command);
});
test('acknowledgement can accompany command in one transaction', t => {
  const s = setup(t); s.update('a', request([post('u', 'New relevant warning', { priority: 'urgent' })]));
  assert(s.prepare('lead', request([{ op: 'ack', id: 'u', version: 1 }]), 'send_agent_prompt', {}, 'b', null).command);
});
test('crash during external dispatch becomes unknown and is never auto-replayed', t => {
  const s = setup(t); const c = s.prepare('lead', request([]), 'send_agent_prompt', {}, 'a', null).command;
  s.claim(c.id); s.recover(); assert.equal(s.command(c.id).status, 'unknown');
  assert.throws(() => s.claim(c.id), /COMMAND_ALREADY_ATTEMPTED/);
  s.reconcile('lead', c.id, 'completed', 'Observed the exact provider turn and prompt identity');
  assert.equal(s.command(c.id).status, 'completed');
});
test('handoff changes epoch, routes pending lead inbox, and fences previous lead', t => {
  const s = setup(t); s.update('a', request([post('m', 'Result ready')]));
  s.update('lead', request([{ op: 'handoff', leader: 'b', expectedEpoch: 1 }]));
  assert.equal(s.load().epoch, 2); assert.equal(s.load().leader, 'b');
  assert.throws(() => s.update('lead', request([put('focus', 'section', { text: 'Old lead command' })])), /LEAD_REQUIRED/);
  assert(s.claimDeliveries(['b']).some(d => d.recipient === '$lead'));
});
test('handoff cannot race unresolved external command', t => {
  const s = setup(t); s.prepare('lead', request([]), 'send_agent_prompt', {}, 'a', null);
  assert.throws(() => s.update('lead', request([{ op: 'handoff', leader: 'b', expectedEpoch: 1 }])), /HANDOFF_BUSY/);
});
test('schema failure rolls back state, urgent deliveries, history and idempotency receipt', t => {
  let reject = false; const s = new TeamStore(':memory:', () => { if (reject) throw new Error('SCHEMA_REJECT'); }); t.after(() => s.close());
  s.initialize('/repo', 'lead', { type: 'object' }); s.update('lead', request([{ op: 'member', agentId: 'b', role: 'worker' }]));
  const before = s.snapshot('lead'); reject = true;
  assert.throws(() => s.update('lead', request([post('u', 'Should not be sent', { priority: 'urgent' })])), /SCHEMA_REJECT/);
  assert.deepEqual(s.snapshot('lead'), before);
});
test('SQLite revision conflict protects competing writers', t => {
  const dir = mkdtempSync(join(tmpdir(), 'team-race-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'team.sqlite'); const a = new TeamStore(path); a.initialize('/repo', 'lead'); const b = new TeamStore(path);
  t.after(() => { a.close(); b.close(); }); const revision = b.load().revision;
  a.update('lead', request([put('focus', 'section', { text: 'A' })], { expectedRevision: revision }));
  assert.throws(() => b.update('lead', request([put('next', 'section', { text: 'B' })], { expectedRevision: revision })), /REVISION_CONFLICT/);
});
test('pagination detects a changed view rather than silently skipping messages', t => {
  const s = setup(t); s.update('a', request([post('m1', 'One'), post('m2', 'Two')])); const page = s.board('a', { limit: 1 });
  s.update('a', request([post('m3', 'Three')]));
  assert.throws(() => s.board('a', { before: page.next, revision: page.revision }), /REVISION_CONFLICT/);
});
test('malformed JSON, proto keys and empty urgent text are rejected', t => {
  const s = setup(t);
  assert.throws(() => s.update('a', request([post('x', '')])), /INVALID_MESSAGE/);
  assert.throws(() => s.update('lead', request([put('__proto__', 'section', {})])), /INVALID_ID/);
  assert.throws(() => s.update('lead', request([put('x', 'section', { n: Infinity })])), /INVALID_JSON/);
});
test('reopening a child invalidates its completed parent instead of denying the correction', t => {
  const s = setup(t);
  s.update('lead', request([put('parent', 'task', { status: 'active' }), put('child', 'task', { status: 'done', evidence: ['result'], parent: 'parent' })]));
  s.update('lead', request([put('parent', 'task', { status: 'done', evidence: ['accepted'] }, 1)]));
  s.update('lead', request([put('child', 'task', { status: 'active', parent: 'parent' }, 1)]));
  assert(s.load().entities.parent.stale.length > 0);
});
test('source corruption cannot shadow canonical plan identifiers in the view', t => {
  const s = setup(t); s.update('lead', request([put('real-id', 'task', { id: 'forged-id', status: 'pending' })]));
  assert.equal(s.snapshot('lead').plan[0].id, 'real-id');
});
test('coordinator ownership is exclusive and recovery is permitted only for a dead owner', t => {
  const s = setup(t); s.acquireCoordinator(111, 'first', () => true);
  assert.throws(() => s.acquireCoordinator(222, 'second', () => true), /COORDINATOR_BUSY/);
  s.acquireCoordinator(222, 'second', () => false); s.releaseCoordinator('first');
  assert.throws(() => s.acquireCoordinator(333, 'third', () => true), /COORDINATOR_BUSY/);
  s.releaseCoordinator('second'); s.acquireCoordinator(333, 'third', () => true);
});
test('daemon facts are versioned graph sources and cannot be overwritten by a model', t => {
  const s = setup(t); s.observe('a', { status: 'running', model: 'test-model' });
  s.update('lead', request([put('focus', 'section', { text: 'A is working' }, 0, [ref('agent:a', 1, 'watches')])]));
  s.observe('a', { status: 'idle', model: 'test-model' });
  assert.equal(s.load().entities.focus.stale[0].source, 'agent:a');
  assert.throws(() => s.update('lead', request([put('agent:a', 'resource', { status: 'running' }, 2)])), /RESERVED_ENTITY/);
});
test('one durable heartbeat follows a new lead and does not duplicate after restart', t => {
  let now = 0; const s = setup(t, undefined, ':memory:', () => now); s.setHeartbeat('lead', 60);
  now = 60001; s.tick(); s.tick(); assert.equal(s.history('lead').events.filter(e => e.type === 'team.heartbeat').length, 1);
  s.update('lead', request([{ op: 'handoff', leader: 'b', expectedEpoch: 1 }]));
  assert(s.claimDeliveries(['b']).some(d => d.recipient === '$lead'));
  s.setHeartbeat('b', null); now += 120000; s.tick(); assert.equal(s.history('b').events.filter(e => e.type === 'team.heartbeat').length, 1);
});
test('an in-progress native handoff fences other commands until reconciled', t => {
  const s = setup(t); const c = s.prepare('lead', request([]), 'lead_handoff', { leaderId: 'b' }, null, null).command; s.claim(c.id);
  assert.throws(() => s.prepare('lead', request([]), 'send_agent_prompt', {}, 'a', null), /HANDOFF_BUSY/);
});
test('long client IDs cannot collide across actors or break created-agent checkpoint IDs', t => {
  const s = setup(t); const c = s.prepare('lead', { requestId: 'r'.repeat(512), operations: [] }, 'create_agent', {}, null, null).command;
  assert.match(c.id, /^[a-f0-9]{64}$/);
});
test('board and panel projections return a common committed revision', t => {
  const s = setup(t); s.update('a', request([post('m', 'Original message')])); const bundle = s.bundle('a');
  assert.equal(bundle.snapshot.revision, bundle.board.revision);
});
test('urgent delivery cannot silently fall back to interrupt-and-replace', async () => {
  const { withPermit, assertInterruptAllowed } = await load('context');
  await assert.rejects(withPermit({ root: '/repo', kind: 'notification', epoch: 1, actor: 'daemon', target: 'a', noInterrupt: true }, async () => assertInterruptAllowed()), /STEER_UNAVAILABLE/);
  assert.doesNotThrow(assertInterruptAllowed);
});
test('worktree identity merges subdirectories but isolates sibling Git worktrees', async t => {
  const { execFileSync } = await import('node:child_process'); const { mkdirSync, writeFileSync } = await import('node:fs');
  const { locateWorktree } = await load('worktree');
  const dir = mkdtempSync(join(tmpdir(), 'team-git-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo'); mkdirSync(repo); const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init'); writeFileSync(join(repo, 'a.txt'), 'test'); git('add', 'a.txt'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'test');
  mkdirSync(join(repo, 'nested')); const other = join(dir, 'other'); git('worktree', 'add', '-b', 'other', other);
  const a = await locateWorktree(repo), nested = await locateWorktree(join(repo, 'nested')), b = await locateWorktree(other);
  assert.equal(a.database, nested.database); assert.notEqual(a.database, b.database);
  assert(b.database.startsWith(join(repo, '.git', 'cogerentor')));
  git('worktree', 'remove', other);
});
test('read-only panel requires a bearer token and rejects cross-host and write requests', async t => {
  const { startPanel } = await load('panel'); const s = setup(t);
  const panel = await startPanel(s); t.after(() => panel.close()); const url = new URL(panel.url); const token = url.hash.slice(1);
  const endpoint = url.origin + '/api/state';
  assert.equal((await fetch(endpoint)).status, 401);
  assert.equal((await fetch(endpoint, { headers: { Authorization: 'Bearer ' + token } })).status, 200);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + token } })).status, 403);
  const { request } = await import('node:http');
  const hostileHostStatus = await new Promise((resolve, reject) => {
    const req = request(endpoint, { headers: { Host: 'attacker.invalid', Authorization: 'Bearer ' + token } }, response => { response.resume(); resolve(response.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(hostileHostStatus, 403);
  const body = await (await fetch(endpoint, { headers: { Authorization: 'Bearer ' + token } })).json();
  assert.equal(body.snapshot.revision, body.board.revision);
});
test('replacements inherit topics and invalidate topic watchers without repeating tags', t => {
  const s = setup(t); s.update('a', request([post('first', 'Old report', { about: ['topic:api'] })]));
  s.update('lead', request([put('api-next', 'section', { text: 'Next API step' }, 0, [ref('topic:api', 1, 'watches')])]));
  s.update('a', request([post('correction', 'The previous report was for another build', { replaces: 'first' })]));
  assert(s.load().entities['api-next'].stale.some(r => r.source === 'topic:api'));
  assert(s.board('b', { topic: 'topic:api' }).messages.some(m => m.id === 'correction'));
});
test('an untagged material warning invalidates the worktree scope', t => {
  const s = setup(t); s.update('a', request([post('hello', 'Starting work')]));
  s.update('lead', request([put('intent', 'section', { text: 'Continue work' }, 0, [ref('topic:worktree', 1, 'watches')])]));
  s.update('b', request([post('urgent', 'Shared environment unavailable', { priority: 'urgent' })]));
  assert(s.load().entities.intent.stale.length);
});
test('message versions cannot be silently bumped through decision reconsideration', t => {
  const s = setup(t); s.update('a', request([post('urgent', 'Do not trust this environment', { priority: 'urgent' })]));
  assert.throws(() => s.update('a', request([{ op: 'resolve', id: 'urgent', expectedVersion: 1, explanation: 'This is still relevant', observed: [] }])), /IMMUTABLE_RECORD/);
});
test('durable event processing cursor survives reopen and transfers to the successor', t => {
  const dir = mkdtempSync(join(tmpdir(), 'team-cursor-')); const path = join(dir, 'team.sqlite');
  let s = new TeamStore(path); t.after(() => { s.close(); rmSync(dir, { recursive: true, force: true }); });
  s.initialize('/repo', 'lead'); s.update('lead', request([{ op: 'member', agentId: 'next', role: 'worker' }]));
  const through = s.history('lead').next;
  s.update('lead', request([{ op: 'ack_events', through }])); s.close(); s = new TeamStore(path);
  assert.equal(s.inboxCursor('lead'), through);
  s.update('lead', request([{ op: 'handoff', leader: 'next', expectedEpoch: 1 }])); assert.equal(s.inboxCursor('next'), through);
  assert.throws(() => s.update('next', request([{ op: 'ack_events', through: 999999 }])), /INVALID_CURSOR/);
});
test('a paused lead cannot resume itself or be selected for delivery', t => {
  const s = setup(t); s.update('human', request([{ op: 'pause', agentId: 'lead', paused: true }]));
  s.update('a', request([post('urgent', 'Notice', { priority: 'urgent' })]));
  assert.equal(s.claimDeliveries(['lead']).length, 0);
  assert.throws(() => s.update('lead', request([{ op: 'pause', agentId: 'lead', paused: false }])), /HOST_RESUME_REQUIRED/);
  s.update('human', request([{ op: 'pause', agentId: 'lead', paused: false }])); assert(s.claimDeliveries(['lead']).length);
});
test('state metadata no longer embeds the complete message board', t => {
  const { DatabaseSync } = requireSqlite(); const dir = mkdtempSync(join(tmpdir(), 'team-normalized-')); const path = join(dir, 'team.sqlite');
  const s = setup(t, undefined, path); t.after(() => rmSync(dir, { recursive: true, force: true }));
  s.update('a', request([post('long', 'x'.repeat(20000))]));
  const db = new DatabaseSync(path); try {
    const stored = JSON.parse(db.prepare('SELECT value FROM team').get().value);
    assert.equal(stored.entities, undefined); assert(JSON.stringify(stored).length < 3000);
    assert(db.prepare('SELECT value FROM entities WHERE id=?').get('long').value.length > 20000);
  } finally { db.close(); }
});
test('a prepared command can be abandoned without falsely recording execution', t => {
  const s = setup(t); const c = s.prepare('lead', request([]), 'send_agent_prompt', { prompt: 'Work' }, 'a', null).command;
  assert.throws(() => s.reconcile('lead', c.id, 'completed', 'Not actually started'), /INVALID_COMMAND_STATE/);
  s.reconcile('lead', c.id, 'failed', 'No provider call was made; task cancelled');
  assert.equal(s.command(c.id).status, 'failed');
  assert.doesNotThrow(() => s.update('lead', request([{ op: 'handoff', leader: 'b', expectedEpoch: 1 }])));
});
test('one declared exclusive resource cannot have two active assignees', t => {
  const s = setup(t); s.update('lead', request([put('task', 'task', { status: 'active' })]));
  s.update('lead', request([put('as-a', 'assignment', { taskId: 'task', agentId: 'a', status: 'active', exclusive_resources: ['git-index'] })]));
  assert.throws(() => s.update('lead', request([put('as-b', 'assignment', { taskId: 'task', agentId: 'b', status: 'active', exclusive_resources: ['git-index'] })])), /RESOURCE_ASSIGNED/);
  s.update('lead', request([{ op: 'pause', agentId: 'a', paused: true }, put('as-a', 'assignment', { taskId: 'task', agentId: 'a', status: 'cancelled' }, 1, [])]));
  assert.doesNotThrow(() => s.update('lead', request([put('as-b', 'assignment', { taskId: 'task', agentId: 'b', status: 'active', exclusive_resources: ['git-index'] })])));
});
test('structured submissions stay separate from acceptance and require task and digest', t => {
  const s = setup(t); s.update('lead', request([put('task', 'task', { status: 'active' })]));
  assert.throws(() => s.update('a', request([put('bad', 'result', { taskId: 'task', artifact: 'result.json', sha256: 'bad' })])), /INVALID_RESULT/);
  s.update('a', request([put('r1', 'result', { taskId: 'task', artifact: 'result.json', sha256: 'a'.repeat(64), status: 'ready_for_review' })]));
  assert.equal(s.load().entities.task.data.status, 'active');
});
test('a withdrawn urgent lease is no longer admissible for dispatch', t => {
  const s = setup(t); s.update('a', request([post('old', 'Warning', { priority: 'urgent' })]));
  const d = s.claimDeliveries(['b'])[0]; assert.equal(s.deliveryCurrent(d.id, d.attempts), true);
  s.update('a', request([post('new', 'Warning resolved', { replaces: 'old' })]));
  assert.equal(s.deliveryCurrent(d.id, d.attempts), false);
});
test('parked recipients do not starve active urgent recipients behind a long inbox', t => {
  let now = 0; const s = setup(t, undefined, ':memory:', () => now);
  s.setHeartbeat('lead', 30); for (let i = 0; i < 1002; i++) { now += 30000; s.tick(); }
  s.update('a', request([post('u', 'Urgent for an active worker', { priority: 'urgent' })]));
  const deliveries = s.claimDeliveries(['b']); assert.equal(deliveries.length, 1); assert.equal(deliveries[0].entityId, 'u');
});
test('runtime observations become unknown after restart and invalidate dependent plans', t => {
  const s = setup(t); s.observe('a', { status: 'running' });
  s.update('lead', request([put('focus', 'section', { text: 'Worker is running' }, 0, [ref('agent:a', 1)])]));
  s.resetRuntimeObservations(); assert.equal(s.load().entities['agent:a'].data.status, 'unknown'); assert(s.load().entities.focus.stale.length);
  s.observe('a', { status: 'idle' }); assert.equal(s.load().entities['agent:a'].data.status, 'idle');
});
