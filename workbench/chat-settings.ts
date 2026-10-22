export type ChatHistory = "current" | "recent" | "all";

export function contextMessages<T>(messages: T[], history: ChatHistory): T[] {
  if (history === "current") return messages.slice(-1);
  // Three exchanges plus the current question keeps ordinary chats bounded.
  return history === "recent" ? messages.slice(-7) : [...messages];
}

export function chatLoginDestination(next?: string | null): string {
  // Only named destinations are accepted, so sign-in cannot redirect to another site.
  return next === "chat" ? "/#/base-chat" : "/";
}
