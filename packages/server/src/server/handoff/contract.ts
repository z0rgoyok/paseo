import { z } from "zod";
import path from "node:path";

export const HandoffConfigSchema = z
  .object({
    issuer: z.string().min(1).max(256),
    projects: z.record(
      z.string(),
      z
        .object({
          cwd: z.string().refine(path.isAbsolute, "Project cwd must be absolute"),
          provider: z.enum(["codex", "claude"]),
          model: z.string().min(1),
          thinkingOptionId: z.string().optional(),
          systemPrompt: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type HandoffConfig = z.infer<typeof HandoffConfigSchema>;
export const AssignmentSchema = z
  .object({
    task_ref: z.string().url().max(2048),
    project: z.string().min(1).max(128),
    objective: z.string().trim().min(1).max(16000),
    brief: z.string().min(1).max(64000),
    take_comment: z.string().url().max(2048).optional(),
  })
  .strict();
export type Assignment = z.infer<typeof AssignmentSchema>;
export const AssignmentReceiptSchema = z.object({
  handoff_id: z.string(),
  executor_id: z.string(),
  task_ref: z.string(),
  accepted_at: z.string(),
  disposition: z.literal("accepted"),
  owner: z.literal("paseo"),
});
export type AssignmentReceipt = z.infer<typeof AssignmentReceiptSchema>;
export const HandoffRecordSchema = z.object({
  receipt: AssignmentReceiptSchema,
  assignment: AssignmentSchema,
  fingerprint: z.string(),
  phase: z.enum(["queued", "initializing", "starting", "started", "held"]),
  error: z.string().nullable(),
});
export type HandoffRecord = z.infer<typeof HandoffRecordSchema>;
