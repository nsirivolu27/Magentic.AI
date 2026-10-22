export function companyPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Companies · Magentic</title><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/agency.css"><script src="/account-client.js" defer></script><script src="/company-client.js" defer></script></head>
  <body class="account-login"><main class="login-layout"><section class="login-story"><a href="/welcome" class="login-brand"><span class="login-diamond">◆</span>Magentic</a><div><span class="eyebrow">COMPANY WORKSPACES</span><h1>Your team.<br>Your agents.</h1><p>Documents, automations and approvals in your company workspace.</p></div></section>
  <section class="login-card"><h2>Choose your company</h2><p>Create or manage your company through Clerk.</p><div id="company-switcher"></div><div id="company-list" role="status">Loading companies…</div><p id="company-error" role="alert"></p><button id="company-refresh" class="secondary">Refresh companies</button><button class="secondary" data-account-signout>Sign out</button><p class="login-footnote">An admin sets up the workspace. Membership controls access.</p></section></main></body></html>`;
}

export const companyClientScript = `
(async function () {
  const config = await window.magenticAccountReady;
  if (!config.companies) { location.replace('/login'); return; }
  if (!window.Clerk.isSignedIn) return;
  window.Clerk.mountOrganizationSwitcher(document.getElementById('company-switcher'), {
    hidePersonal: true, afterCreateOrganizationUrl: '/companies', afterSelectOrganizationUrl: '/companies'
  });
  const list = document.getElementById('company-list');
  const error = document.getElementById('company-error');
  const refresh = document.getElementById('company-refresh');
  async function request(path, data) {
    const token = await window.Clerk.session.getToken();
    if (!token) throw new Error('Sign in again.');
    const response = await fetch(path, {method:data ? 'POST' : 'GET', cache:'no-store',
      headers:{'Content-Type':'application/json', Authorization:'Bearer '+token},
      ...(data ? {body:JSON.stringify(data)} : {}), signal:AbortSignal.timeout(15000)});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Company access is unavailable.');
    return result;
  }
  async function load() {
    refresh.disabled = true; error.textContent = ''; list.textContent = 'Loading companies…';
    try {
      const companies = await request('/api/companies'); list.replaceChildren();
      if (!companies.length) list.textContent = 'Create a company above, or ask its admin for an invitation.';
      for (const company of companies) {
        const card = document.createElement('section'); card.className = 'account-panel';
        const name = document.createElement('h3'); name.textContent = company.name;
        const button = document.createElement('button'); button.className = 'primary';
        button.textContent = company.workspaceId ? 'Open workspace' : company.canCreate ? 'Set up workspace' : 'Waiting for admin';
        button.disabled = !company.workspaceId && !company.canCreate;
        button.onclick = async () => {
          button.disabled = true; error.textContent = '';
          try {
            const result = await request('/api/companies/open', {organizationId:company.organizationId});
            sessionStorage.setItem('magentic.companyWorkspace', result.workspaceId);
            location.assign('/#/marketplace');
          } catch (failure) { error.textContent = failure.message; button.disabled = false; }
        };
        card.append(name, button); list.appendChild(card);
      }
    } catch (failure) { list.textContent = ''; error.textContent = failure.message; }
    finally { refresh.disabled = false; }
  }
  refresh.onclick = load;
  await load();
})().catch(() => { document.getElementById('company-error').textContent = 'Sign-in could not load. Return to /login and retry.'; });
`;
