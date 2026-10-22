import { config } from "../config.ts";
import type { SqlBackend } from "./backend.ts";

export async function getBackend(): Promise<SqlBackend> {
  if (config.backend === "zetaris") {
    const { ZetarisBackend } = await import("./zetaris.ts");
    return new ZetarisBackend();
  }
  const { LocalBackend } = await import("./local.ts");
  return new LocalBackend();
}
