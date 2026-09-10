import { createPaseoToolCatalog as createBuiltinCatalog, type PaseoToolHostDependencies } from "./paseo-tools-builtin.js";
import { withTeamTools } from "../../coordination/tools.js";
import type { PaseoToolCatalog } from "./types.js";
export * from "./paseo-tools-builtin.js";

export function createPaseoToolCatalog(options: PaseoToolHostDependencies): PaseoToolCatalog {
  return withTeamTools(createBuiltinCatalog(options), options);
}
