import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ChatVault {
  read(scope: string): unknown;
  write(scope: string, value: unknown): void;
}

export function memoryChatVault(): ChatVault {
  const records = new Map<string, unknown>();
  return { read: scope => structuredClone(records.get(scope)), write: (scope, value) => { records.set(scope, structuredClone(value)); } };
}

export function fileChatVault(directory: string, configuredKey?: string): ChatVault {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const keyPath = join(directory, "vault.key");
  if (configuredKey && !/^[a-f0-9]{64}$/i.test(configuredKey)) throw new Error("MAGENTIC_CONNECTIONS_KEY must contain 64 hexadecimal characters.");
  if (!configuredKey && !existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { flag: "wx", mode: 0o600 });
  const key = configuredKey ? Buffer.from(configuredKey, "hex") : readFileSync(keyPath);
  if (key.length !== 32) throw new Error("The connection vault key is invalid.");
  const pathFor = (scope: string) => join(directory, createHash("sha256").update(scope).digest("hex") + ".json");
  return {
    read(scope) {
      const path = pathFor(scope);
      if (!existsSync(path)) return undefined;
      try {
        const value = JSON.parse(readFileSync(path, "utf8"));
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64"));
        // Moving a credential file to another member's scope must not grant access.
        decipher.setAAD(Buffer.from(scope));
        decipher.setAuthTag(Buffer.from(value.tag, "base64"));
        return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data, "base64")), decipher.final()]).toString("utf8"));
      } catch { throw new Error("The connection vault could not be read. Restore its matching key and data."); }
    },
    write(scope, value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(scope));
      const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
      const path = pathFor(scope);
      const temporary = path + ".pending";
      writeFileSync(temporary, JSON.stringify({ iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") }), { mode: 0o600 });
      renameSync(temporary, path);
    },
  };
}
