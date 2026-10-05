import { z } from "zod";

export const NativeGoalSnapshotSchema = z.object({
  threadId: z.string(), objective: z.string(),
  status: z.enum(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]),
  tokenBudget: z.number().nullable().optional(), tokensUsed: z.number(),
  timeUsedSeconds: z.number(), createdAt: z.number(), updatedAt: z.number(),
});
export type NativeGoalSnapshot = z.infer<typeof NativeGoalSnapshotSchema>;

export async function readNativeGoalSnapshot(
  client: { request(method: string, params?: unknown): Promise<unknown> }, threadId: string,
): Promise<NativeGoalSnapshot | null> {
  const result = z.object({ goal: NativeGoalSnapshotSchema.nullable() }).parse(
    await client.request("thread/goal/get", { threadId }),
  );
  if (result.goal && result.goal.threadId !== threadId) throw new Error("Native goal thread mismatch");
  return result.goal;
}
