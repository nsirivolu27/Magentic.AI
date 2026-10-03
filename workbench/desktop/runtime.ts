import { fork, type ChildProcess } from "node:child_process";

export function localAppUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("The local runtime did not provide an address.");
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("The desktop runtime must use a loopback address.");
  }
  return url.href;
}

export function edgeArguments(url: string, profile: string): string[] {
  return [`--app=${localAppUrl(url)}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-background-mode", "--window-size=1440,960"];
}

export async function stopRuntime(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill(), 5000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    // The child closes its own server when the launcher disconnects, including
    // when the application window exits without an explicit shutdown command.
    if (child.connected) child.disconnect();
    else child.kill();
  });
}

export async function startRuntime(entry: string, timeoutMs = 15000, env: NodeJS.ProcessEnv = process.env): Promise<{ child: ChildProcess; url: string }> {
  const child = fork(entry, ["--desktop"], { stdio: ["ignore", "inherit", "inherit", "ipc"], execArgv: [], env });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("The local runtime did not start in time.")), timeoutMs);
      const onError = (error: Error) => finish(error);
      const onExit = () => finish(new Error("The local runtime exited before it was ready."));
      const onMessage = (message: unknown) => {
        try { finish(undefined, localAppUrl((message as { url?: unknown })?.url)); }
        catch (error) { finish(error as Error); }
      };
      function finish(error?: Error, url?: string) {
        clearTimeout(timer); child.off("error", onError); child.off("exit", onExit); child.off("message", onMessage);
        if (error) reject(error); else resolve(url!);
      }
      child.once("error", onError); child.once("exit", onExit); child.once("message", onMessage);
    });
    return { child, url };
  } catch (error) { await stopRuntime(child); throw error; }
}
