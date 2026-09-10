import { AsyncLocalStorage } from "node:async_hooks";
import { requireThat } from "./model.js";
export interface DispatchPermit {
  root: string;
  kind: "command" | "notification";
  commandId?: string;
  epoch: number;
  actor: string;
  target: string | null;
  noInterrupt: boolean;
  closed: boolean;
}
export const dispatchContext = new AsyncLocalStorage<DispatchPermit>();
export async function withPermit<T>(permit: Omit<DispatchPermit, "closed">, run: () => Promise<T>): Promise<T> {
  const scope = { ...permit, closed: false };
  try { return await dispatchContext.run(scope, run); } finally { scope.closed = true; }
}
export function assertInterruptAllowed(): void {
  requireThat(!dispatchContext.getStore()?.noInterrupt, "STEER_UNAVAILABLE", "This notification must wait; interrupt-and-replace is forbidden");
}
