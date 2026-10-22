import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { setting } from "../env.js";
import { automationUnitSchema } from "./automation-schema.js";
import type { AutomationInvoker } from "./automation-runtime.js";

const exec = promisify(execFile);
export interface LambdaCommand {
  args: string[]; timeout: number; env: NodeJS.ProcessEnv;
}
export type LambdaRunner = (command: LambdaCommand) => Promise<string>;
const run: LambdaRunner = async command => (await exec("aws", command.args, {
  timeout: command.timeout, env: command.env, windowsHide: true, maxBuffer: 16 * 1024,
})).stdout;

export function lambdaInvoker(runner: LambdaRunner = run): AutomationInvoker {
  return async (rawUnit, payload) => {
    const unit = automationUnitSchema.parse(rawUnit);
    if (!unit.enabled) throw new Error("Lambda unit is disabled.");
    const [, partition, , region] = unit.functionArn.split(":");
    const directory = await mkdtemp(join(tmpdir(), "magentic-lambda-"));
    try {
      const input = join(directory, "input.json"), output = join(directory, "output.json");
      await writeFile(input, JSON.stringify(payload), { mode: 0o600 });
      // Keep credentials in the CLI's credential chain and payloads out of process arguments.
      const env: NodeJS.ProcessEnv = {};
      for (const name of ["PATH", "SystemRoot", "HOME", "USERPROFILE", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA",
        "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
        "AWS_ROLE_ARN", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_SESSION_NAME", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
        "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_AUTHORIZATION_TOKEN", "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE"]) {
        const value = setting(name); if (value !== undefined) env[name] = value;
      }
      env.AWS_MAX_ATTEMPTS = "1";
      env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS = "true";
      const args = ["lambda", "invoke", "--function-name", unit.functionArn, "--region", region!,
        "--endpoint-url", `https://lambda.${region}.amazonaws.com${partition === "aws-cn" ? ".cn" : ""}`,
        "--invocation-type", "RequestResponse", "--log-type", "None", "--payload", `fileb://${input}`,
        "--cli-connect-timeout", "5", "--cli-read-timeout", String(unit.timeoutSeconds),
        "--output", "json", "--no-cli-pager", "--no-cli-auto-prompt",
        ...(unit.profile ? ["--profile", unit.profile] : []), output];
      const metadata = JSON.parse(await runner({ args, timeout: unit.timeoutSeconds * 1000, env }));
      if (metadata.StatusCode !== 200 || metadata.ExecutedVersion !== unit.functionArn.split(":").at(-1)) return { status: "uncertain" };
      const size = (await stat(output)).size;
      if (size > 6 * 1024 * 1024) return { status: "uncertain" };
      const bytes = await readFile(output);
      // A function response can contain customer data or secrets; retain evidence, not its body.
      return { status: metadata.FunctionError ? "failed" : "succeeded", executedVersion: metadata.ExecutedVersion,
        responseHash: createHash("sha256").update(bytes).digest("hex"), responseBytes: bytes.length };
    } catch { return { status: "uncertain" }; }
    finally { await rm(directory, { recursive: true, force: true }); }
  };
}
