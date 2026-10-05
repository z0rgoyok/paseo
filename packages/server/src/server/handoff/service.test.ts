import { afterEach, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HandoffService } from "./service.js";
import type { AssignmentExecution } from "./service.js";
const directories: string[] = [];
afterEach(async () => {
  for (const d of directories.splice(0)) await fs.rm(d, { recursive: true, force: true });
});
const input = {
  task_ref: "https://paperclip.example/TIC/issues/TIC-1",
  project: "project",
  objective: "Implement accepted brief",
  brief: "Scope and acceptance criteria",
};
async function setup(execution: AssignmentExecution) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "paseo-handoff-"));
  directories.push(directory);
  const config = {
    issuer: "company-a",
    projects: { project: { cwd: directory, provider: "claude", model: "configured-model" } },
  };
  return { directory, config, service: new HandoffService(directory, config, execution) };
}
test("lost reply and simultaneous retries retain one executor and one first start", async () => {
  let created = 0,
    started = 0;
  const { service, directory, config } = await setup({
    initialize: async () => {
      created++;
    },
    start: async () => {
      started++;
    },
  });
  const receipts = await Promise.all(Array.from({ length: 10 }, () => service.assign(input)));
  await service.flush();
  expect(new Set(receipts.map((r) => r.executor_id)).size).toBe(1);
  expect(created).toBe(1);
  expect(started).toBe(1);
  const restarted = new HandoffService(directory, config, {
    initialize: async () => {
      throw new Error("duplicate");
    },
    start: async () => {
      throw new Error("duplicate");
    },
  });
  await restarted.recover();
  expect(await restarted.assign(input)).toEqual(receipts[0]);
});
test("changed brief and unassigned projects cannot replace existing work", async () => {
  const { service } = await setup({ initialize: async () => {}, start: async () => {} });
  await service.assign(input);
  await service.flush();
  await expect(service.assign({ ...input, objective: "Other work" })).rejects.toThrow(
    "another brief",
  );
  await expect(service.assign({ ...input, project: "outside" })).rejects.toThrow("not assigned");
});
test("URL fragments do not turn a retry into another assignment", async () => {
  const { service } = await setup({ initialize: async () => {}, start: async () => {} });
  const first = await service.assign(input);
  const second = await service.assign({ ...input, task_ref: input.task_ref + "?view=1#comment" });
  expect(second).toEqual(first);
  await service.flush();
});
test("unknown start survives restart without another provider invocation", async () => {
  let started = 0;
  const { service, directory, config } = await setup({
    initialize: async () => {},
    start: async () => {
      started++;
      throw new Error("disconnected after accept");
    },
  });
  const receipt = await service.assign(input);
  await service.flush();
  expect((await service.inspect(receipt.handoff_id))?.phase).toBe("held");
  const next = new HandoffService(directory, config, {
    initialize: async () => {
      started++;
    },
    start: async () => {
      started++;
    },
  });
  await next.recover();
  expect(await next.assign(input)).toEqual(receipt);
  expect(started).toBe(1);
});
test("receipt confirms durable assignment ownership before provider work completes", async () => {
  let release = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { service, directory } = await setup({
    initialize: async () => wait,
    start: async () => {},
  });
  const receipt = await service.assign(input);
  expect(receipt).toMatchObject({ disposition: "accepted", owner: "paseo" });
  expect((await fs.stat(path.join(directory, receipt.handoff_id + ".json"))).mode & 0o777).toBe(
    0o600,
  );
  release();
  await service.flush();
});
