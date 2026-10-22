import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

// CPU prompt evaluation can exceed fetch's header deadline before emitting a token.
// The caller's execution budget must control both that wait and the response stream.
export function ollamaRequest(signal: AbortSignal): typeof fetch {
  return async (input, init) => {
    if (input instanceof Request) throw new Error("Ollama requests must use a URL.");
    const url = new URL(input);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Unsupported model protocol.");
    if (init?.body != null && typeof init.body !== "string") throw new Error("Ollama requests must contain JSON text.");
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const cancellation = init?.signal ? AbortSignal.any([signal, init.signal]) : signal;
    return new Promise<Response>((resolve, reject) => {
      const outgoing = request(url, { method: init?.method ?? "GET", headers, signal: cancellation }, incoming => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
        }
        resolve(new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, {
          status: incoming.statusCode ?? 500, headers: responseHeaders,
        }));
      });
      outgoing.on("error", reject);
      outgoing.end(init?.body ?? undefined);
    });
  };
}
