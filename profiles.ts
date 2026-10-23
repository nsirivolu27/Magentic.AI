import { z } from "zod";
import { setting } from "./env.js";

const profileSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
  baseUrl: z.string().url(),
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/),
  workspaceId: z.string().uuid().transform((id) => id.toLowerCase()),
}).strict();

/** One immutable profile per MCP process; tools cannot choose a key or tenant. */
export function resolveProfile(env: NodeJS.ProcessEnv = process.env) {
  if (!setting("MAGENTIC_PROFILE", env) && !setting("MAGENTIC_PROFILES_JSON", env)) {
    return { baseUrl: env.LNKZ_BASE_URL ?? "", apiKey: env.LNKZ_API_KEY ?? "", workspaceId: undefined };
  }
  let profiles: z.infer<typeof profileSchema>[];
  try {
    profiles = z.array(profileSchema).min(1).max(100).parse(JSON.parse(setting("MAGENTIC_PROFILES_JSON", env) ?? ""));
    if (new Set(profiles.map((profile) => profile.name)).size !== profiles.length) throw new Error();
  } catch {
    throw new Error("MAGENTIC_PROFILES_JSON must contain valid, uniquely named profiles using apiKeyEnv references.");
  }
  const profile = profiles.find((entry) => entry.name === setting("MAGENTIC_PROFILE", env));
  if (!profile) throw new Error("MAGENTIC_PROFILE must select a configured profile; no fallback credentials will be used.");
  const apiKey = env[profile.apiKeyEnv]?.trim();
  if (!apiKey) throw new Error("The selected profile's API key environment variable is missing.");
  return { baseUrl: profile.baseUrl, apiKey, workspaceId: profile.workspaceId };
}
