/** Cookies can lag behind session renewal, so managed requests obtain a current token. */
export async function sessionHeaders(headers: Record<string, string>, managed: boolean,
  getToken: () => Promise<string | null>): Promise<Record<string, string>> {
  if (!managed) return { ...headers };
  let token: string | null;
  try { token = await getToken(); }
  catch { throw new Error("Could not refresh sign-in. Retry or sign in again."); }
  if (!token) throw new Error("Sign in again to continue.");
  return { ...headers, Authorization: `Bearer ${token}` };
}
