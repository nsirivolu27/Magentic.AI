import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
const argument = process.argv[2] ?? "--port=4184";
if (!/^--port=\d+$/.test(argument) || process.argv.length > 3) throw new Error("Use node docs/site/serve.mjs --port=4184");
const port = Number(argument.slice(7));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port must be 1–65535.");
// Serve only presentation assets. The checkout also contains private local runtime data.
const files = new Map([
  ["/", ["index.html", "text/html"]],
  ["/index.html", ["index.html", "text/html"]],
  ["/presentation.css", ["presentation.css", "text/css"]],
  ["/presentation.js", ["presentation.js", "text/javascript"]],
]);
const server = createServer(async (request, response) => {
  const file = files.get((request.url ?? "/").split("?")[0]);
  if (!file || !["GET", "HEAD"].includes(request.method ?? "")) {
    response.writeHead(404); response.end("Not found"); return;
  }
  try {
    const content = await readFile(new URL(file[0], import.meta.url));
    response.writeHead(200, { "Content-Type": file[1] + "; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    response.end(request.method === "HEAD" ? undefined : content);
  } catch { response.writeHead(500); response.end("Presentation asset unavailable."); }
});
server.listen(port, "127.0.0.1", () => process.stdout.write("Presentation: http://127.0.0.1:" + port + "/\n"));
