# Account portal

Open `/login` for sign-in and `/#/account` for account and billing. With no
account configuration, the existing local session works as before. No pricing
is invented in the interface: it reads the configured recurring price from Stripe.

## Set up

1. Create a Clerk development application. Enable the sign-in methods you need.
   Add the application's loopback origin and `/login` return path to its allowed
   redirect configuration. This server remains bound to loopback.
2. Copy the publishable key, Frontend API origin, and PEM public key from Clerk.
   Set `MAGENTIC_ACCOUNTS_FILE` to an absolute path to a private JSON file:

   ```json
   {
     "clerk": {
       "publishableKey": "pk_test_REPLACE_WITH_REAL_KEY",
       "issuer": "https://your-instance.clerk.accounts.dev",
       "publicKey": "-----BEGIN PUBLIC KEY-----\nREPLACE_WITH_REAL_PEM\n-----END PUBLIC KEY-----",
       "authorizedParties": ["http://127.0.0.1:4182"]
     },
     "members": [
       {"workspaceId": "workspace", "actor": "user_REPLACE", "roles": ["author", "admin"]}
     ],
     "billing": {
       "priceId": "price_REPLACE",
       "customers": [{"workspaceId": "workspace", "customerId": "cus_REPLACE"}]
     }
   }
   ```

   The placeholders are illustrative, not working credentials. Member IDs are
   Clerk user IDs, not emails. Use existing workspace IDs. Add an independent
   member with `approver` for review; signing in does not create membership.
3. For billing, create a test customer and a fixed recurring price in Stripe.
   Configure Stripe's customer portal. Map each workspace to a distinct customer.
   Set `MAGENTIC_STRIPE_SECRET_KEY` on the server, starting with a test key.
   Omit `billing` if you only need login. Do not commit settings or paste secrets
   into the application. Set environment variables in the launch environment;
   the application does not automatically read a new `.env` file.
4. Restart on the same port as the configured origin. Open `/login`, sign in,
   then open Account & billing. Checkout opens Stripe; card entry happens there.
   The page reads Stripe again when refreshed. A return URL is not payment proof.

## Boundaries

Clerk sessions are verified on every request using RS256, the configured public
key, issuer, authorized party, timestamps and session status. Rotate the PEM
configuration when rotating Clerk signing keys. Sessions remain valid until
their short-lived token expires after sign-out or revocation. The browser loads
ClerkJS to renew the session cookie. Membership and roles are server configuration,
not browser claims or payment metadata. No Clerk secret key is required for this flow.

Managed mode disables the automatic local-owner login and legacy local MCP
tokens. MCP clients may present a valid Clerk session bearer token with the same
workspace membership checks. This is not a complete MCP OAuth authorization
server or a long-lived machine-token provisioning system. Reconfigure clients
before enabling managed mode; do not copy browser tokens into persisted config.

Managed users can switch among assigned workspaces, but cannot create workspaces
or mint local-owner credentials. Provision workspaces in local mode before
enabling managed login. A public signup never gains workspace access by itself.
Workflow approval gates and content signatures are unchanged.

Only admins can view billing details or create checkout/portal sessions. Customer,
price and return origins come from server configuration. Pending checkout sessions
are reused and existing subscriptions block another checkout. The JSON request
accepts only the action and a request ID. Billing uses timeouts, a workspace lock
and Stripe idempotency; provider errors do not reveal credentials.

This slice does not enforce paid entitlements, calculate tax, provision customers
automatically, or handle webhook-driven fulfillment. It reads current subscription
state directly from Stripe. Run one billing writer; multi-instance checkout needs
a shared lock before deployment. Live mode can charge real money after the user
confirms on Stripe. No government authorization or compliance certification is implied.

## Verification

Run `corepack pnpm typecheck`, `corepack pnpm test`, `corepack pnpm build`, and
`corepack pnpm build:workbench`. Account tests use locally signed fixture tokens
and a fake Stripe transport. They do not prove live provider configuration.
Before enabling real accounts, test login, logout, a non-member, workspace
switching, test checkout, cancellation and portal return with your own Clerk and
Stripe test applications.

References: [Clerk JavaScript integration](https://clerk.com/docs/js-frontend/getting-started/quickstart),
[session verification](https://clerk.com/docs/guides/sessions/manual-jwt-verification),
[Stripe Checkout](https://docs.stripe.com/api/checkout/sessions/create),
[billing portal](https://docs.stripe.com/api/customer_portal/sessions/create).

## Recovery and checkout checks

Clerk startup and sign-out have bounded waits with explicit retry paths. A signed-in
person without workspace membership can switch accounts without reopening the app.
The billing page displays readable subscription states and keeps billing management
available when the price for new purchases is archived or misconfigured. Existing
subscriptions show their actual invoices in Stripe, not the price configured for
new customers. Retrying checkout in the same page reuses its request ID.

Subscription lists, pending checkouts and prices are validated before offering a
purchase. Unexpected or incomplete responses block new checkout. Returned customer
and mode fields, when present, must match the configured workspace. Tiered,
metered, transformed-quantity and custom-amount prices are not offered as fixed
subscriptions. Stripe's special ISK and UGX amount representations are respected
when displaying a purchase price; Stripe confirms the final total before payment.

These checks still use test fixtures until your provider settings are installed.
The local portal does not enforce paid feature limits or receive webhooks.

## Chat entry and usage controls

Open `/login?next=chat` to return to `/#/base-chat` after sign-in. In local
mode the page explicitly offers local chat without claiming an online session.
The redirect accepts the named `chat` destination only, never an arbitrary URL.

General uses `/api/base-chat` with no workspace tools. Workspace MCP uses
`/api/chat` with read-only tools and the existing membership and approval checks.
Switching model, mode, or assistant starts a fresh conversation. Chats are held
in this browser tab only; reloading clears them.

Usage controls choose an output cap and which conversation messages to send.
The UI defaults to the last three exchanges plus the current question. Both
endpoints validate a supplied cap as an integer from 128 to 8192. Unsupported
providers reject a requested cap; omitting it preserves the existing default.
Ollama receives `numPredict`; hosted adapters use their output-token field.
MCP may invoke the model four times, so the output cap is per call, not a total
request budget. Input, instructions and tool results consume additional tokens.

Replies show reported input/output token counts and server elapsed time. Missing
usage is shown as unknown, never zero cost. No price estimate, automatic model
routing, training, or deployment occurs through these controls. Hosted models
still require valid credentials and access to the selected model.

The optional `metrics: true` request field adds `elapsedMs` to the answer event.
Clients that omit it retain the previous event shape. The request remains strict:
`history` accepts `current`, `recent`, or `all`; unknown properties are rejected.

## Company workspaces

The separate `company:workbench` entry point supports Clerk Organizations.
Enable Organizations in the Clerk application, configure its allowed redirects,
and replace static membership with this account configuration fragment:

```json
"members": [],
"companies": {
  "roles": {
    "org:admin": ["admin", "author", "approver"],
    "org:member": ["author"],
    "org:reviewer": ["approver"]
  }
}
```

Create the custom reviewer role in Clerk if using it. Unknown roles get no access.
Membership is read from Clerk's Backend API on each authorized request; outages
refuse access. Email domains, names, browser role claims and billing never grant
membership. Removing a member blocks their next request; already-running jobs
remain company-owned work and must be cancelled separately when appropriate.

Set `MAGENTIC_CLERK_SECRET_KEY` in the server's secret environment, not JSON or
browser storage. Set `MAGENTIC_PUBLIC_ORIGIN` to the exact HTTPS portal origin
and include it in `clerk.authorizedParties`. Set `MAGENTIC_WORKSPACES_DIR` to a
dedicated persistent directory and `MAGENTIC_WORKBENCH_PORT` to the upstream port.
For local integration testing only, an HTTP localhost origin is accepted.
Run `corepack pnpm build:workbench`, then `corepack pnpm company:workbench`.

The server binds loopback. A same-machine HTTPS reverse proxy must preserve Host
and Origin and forward to that port; forwarded headers do not select a tenant.
No public hosting, certificates or cloud resources are created by this command.
Sign in at `/login`, then open `/companies`. Use Clerk's organization control to
create/manage companies and invitations. A verified company admin sets up one
workspace; other members can enter once it exists. Repeated setup returns the
same workspace. Companies with the same display name remain separate.

Each company installs its own marketplace copies, configures workflows, adds
reference documents, and uses existing Model Studio release and approval flows.
Company mode supports approved assistant stages through the existing scheduler.
The marketplace's repository-agent drafts can be saved and assigned, but host
repository execution is deliberately absent until isolated workers are provided.
Host dataset imports, folder learning, local MCP credentials and host command
execution are also unavailable. Add documents or inline datasets instead.
Models currently use operator-configured server providers; per-company model
credentials and provider billing enrollment are separate work.

This is a single-process, single-writer company server with the existing
50-workspace limit (one slot is reserved), local persistent files, and bounded
Clerk membership pagination. Run only one process per data directory. Horizontal
scaling needs a shared transactional database, job queue and object storage;
backups, recovery drills, rate limiting and operational deployment remain required
before a production rollout. Clerk sign-in, company creation and invitation UI
need a live integration check with your application; automated tests use signed
fixture sessions and fake membership responses, not real accounts.

Provider contracts: [Clerk memberships](https://clerk.com/docs/reference/backend/user/get-organization-membership-list),
[organization switcher](https://clerk.com/docs/js-frontend/reference/components/organization/organization-switcher).
