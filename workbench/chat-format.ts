import { escape } from "./ui.js";

// Only a small formatting subset becomes HTML. Model output never creates links or raw elements.
export function formatChatText(text: string): string {
  const inline = (line: string) => escape(line).replace(/`([^`\n]+)`/g, "<code>$1</code>").replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  const output: string[] = [];
  let code: string[] | undefined;
  let list = "";
  const closeList = () => { if (list) { output.push(`</${list}>`); list = ""; } };
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      closeList();
      if (code) { output.push(`<pre><code>${escape(code.join("\n"))}</code></pre>`); code = undefined; }
      else code = [];
      continue;
    }
    if (code) { code.push(line); continue; }
    const item = line.match(/^\s*(?:([-*])|\d+\.)\s+(.+)$/);
    if (item) {
      const kind = item[1] ? "ul" : "ol";
      if (list !== kind) { closeList(); output.push(`<${kind}>`); list = kind; }
      output.push(`<li>${inline(item[2]!)}</li>`); continue;
    }
    closeList();
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) output.push(`<h3>${inline(heading[1]!)}</h3>`);
    else if (line.trim()) output.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  if (code) output.push(`<pre><code>${escape(code.join("\n"))}</code></pre>`);
  return output.join("");
}
