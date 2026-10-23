// An explicit address must never fall back to another work item.
export function selectedWorkId(view: "desk" | "pipelines", id: string | undefined, runs: { id: string }[]): string | undefined {
  if (id === "new") return undefined;
  return id ?? (view === "pipelines" ? runs[0]?.id : undefined);
}
