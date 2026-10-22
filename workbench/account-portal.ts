import { chatLoginDestination } from "./chat-settings.js";
import type { AccountsConfig } from "./accounts.js";

export function accountPublicConfig(config?: AccountsConfig) {
  return config ? { enabled: true, publishableKey: config.clerk.publishableKey, issuer: config.clerk.issuer, ...(config.companies ? { companies: true } : {}) } : { enabled: false };
}

export function loginPage(config?: AccountsConfig, next?: string | null): string {
  const destination = chatLoginDestination(next);
  const chat = next === "chat";
  return `<!doctype html><html lang="en" data-login-next="${chat ? "chat" : "workspace"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · Magentic</title><link rel="icon" href="/icon.svg"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/agency.css"><script src="/account-client.js" defer></script></head>
  <body class="account-login"><main class="login-layout"><section class="login-story"><a href="/welcome" class="login-brand"><span aria-hidden="true" class="login-diamond">◆</span>Magentic</a><div><span class="eyebrow">YOUR WORK, CONNECTED</span><h1>Your models.<br>Your workspace.</h1><p>Chat, build, and review.</p></div><ol class="login-steps"><li><span>01</span>Shape the task</li><li><span>02</span>Run your workflow</li><li><span>03</span>Review the result</li></ol></section>
  <section class="login-card" aria-labelledby="login-title"><span class="eyebrow">WORKSPACE ACCESS</span><h2 id="login-title">${chat ? "Chat with Magentic" : "Welcome to Magentic"}</h2><p>${config ? "Sign in to your account." : "Your local workspace is ready."}</p><div id="account-sign-in">${config ? '<p role="status">Loading secure sign-in…</p>' : `<a href="${destination}" class="primary">${chat ? "Open local chat" : "Open local workspace"}</a><p class="muted">Online sign-in is not configured.</p>`}</div><p id="account-login-error" role="alert"></p><p class="login-footnote">Workspace access requires membership.</p></section></main></body></html>`;
}

// One small script also keeps Clerk's short-lived cookie fresh in the workspace.
// It never stores a session token in localStorage or puts one in a URL.
export const accountClientScript = `
window.magenticAccountReady = (async function () {
  async function within(promise, message) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 15000); })]); }
    finally { clearTimeout(timer); }
  }
  let response;
  try { response = await fetch('/api/account/config', {cache:'no-store', signal:AbortSignal.timeout(15000)}); }
  catch { throw new Error('Could not load sign-in settings. Check your connection and retry.'); }
  if (!response.ok) throw new Error('Could not load sign-in settings.');
  const config = await response.json();
  if (!config.enabled) return config;
  async function script(path, key) {
    let element;
    try { await within(new Promise((resolve, reject) => {
      element = document.createElement('script');
      element.src = config.issuer + path; element.crossOrigin = 'anonymous';
      if (key) element.setAttribute('data-clerk-publishable-key', key);
      element.onload = resolve; element.onerror = () => reject(new Error('Could not reach Clerk. Check your connection and retry.'));
      document.head.appendChild(element);
    }), 'Clerk took too long to respond. Retry sign-in.'); }
    catch (error) { element?.remove(); throw error; }
  }
  await script('/npm/@clerk/ui@1/dist/ui.browser.js');
  await script('/npm/@clerk/clerk-js@6/dist/clerk.browser.js', config.publishableKey);
  try { await within(window.Clerk.load({ui:{ClerkUI:window.__internal_ClerkUICtor}}), 'Clerk took too long to respond.'); }
  catch { throw new Error('Sign-in could not start. Check the Clerk configuration and retry.'); }
  async function signOut(button) {
    button.disabled = true;
    try { await within(window.Clerk.signOut({redirectUrl:location.origin+'/login'}), 'Sign-out took too long.'); }
    catch { const notice = document.getElementById('account-login-error') || document.getElementById('notice'); if (notice) notice.textContent = 'Could not sign out. Check your connection and retry.'; }
    finally { button.disabled = false; }
  }
  const chat = document.documentElement?.dataset?.loginNext === 'chat';
  const destination = config.companies ? '/companies' : chat ? '/#/base-chat' : '/';
  const target = document.getElementById('account-sign-in');
  if (target) {
    target.replaceChildren();
    if (window.Clerk.isSignedIn) {
      const link = document.createElement('a'); link.href = destination; link.className = 'primary'; link.textContent = chat ? 'Open chat' : 'Open workspace'; target.appendChild(link);
      const button = document.createElement('button'); button.className = 'secondary'; button.textContent = 'Use another account';
      button.onclick = () => signOut(button); target.appendChild(button);
    } else window.Clerk.mountSignIn(target, {routing:'hash', forceRedirectUrl:location.origin+destination});
  } else if (!window.Clerk.isSignedIn) location.replace(location.hash === '#/base-chat' || location.hash === '#/chat' ? '/login?next=chat' : '/login');
  document.addEventListener('click', event => {
    const button = event.target?.closest?.('[data-account-signout]');
    if (button) void signOut(button);
  });
  return config;
})();
window.magenticAccountReady.catch(error => {
  const target = document.getElementById('account-login-error');
  if (target) {
    target.textContent = error.message;
    const content = document.getElementById('account-sign-in');
    if (content) {
      content.replaceChildren();
      const retry = document.createElement('button'); retry.className = 'primary'; retry.textContent = 'Retry sign-in';
      retry.onclick = () => location.reload(); content.appendChild(retry);
    }
  }
});
`;
