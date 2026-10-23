# Company Slack messages

Open **Workspace → Controls → Slack**. This integration sends company audit summaries and human-written team updates to one operator-configured channel per workspace. It does not read Slack conversations, accept commands, approve handoffs, or grant agents a messaging tool.

## Configure the company server

An operator creates a Slack app with an incoming webhook for the intended channel, following [Slack's incoming webhook guide](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/). The webhook fixes the real destination; the channel label below must match it. Magentic does not verify that label against Slack.

Set `MAGENTIC_SLACK_FILE` to a private JSON file:

```json
{
  "connections": [
    {
      "workspaceId": "company-workspace-id",
      "channel": "#company-audit",
      "webhookSetting": "MAGENTIC_SLACK_WEBHOOK_COMPANY"
    }
  ]
}
```

Use the workspace ID recorded by Magentic, not an email domain or an assumed organization ID. Duplicate workspace IDs and unknown keys are rejected at startup. Put the webhook URL in the named server-side setting, never in this JSON file, source control, the browser, or a message. Settings are read through `setting()`. Only HTTPS Slack and GovSlack incoming-webhook URLs are accepted; redirects are refused.

The operator must restart their company server after changing the JSON configuration. This work does not restart an existing company server. Local/demo previews show the unconnected state and do not load this capability.

## Send a reviewed update

1. Sign in to the company workspace as an administrator.
2. Open **Workspace → Controls → Slack**.
3. Choose an audit summary or write a team update.
4. Select **Preview message**, read the exact content and channel, then **Send to Slack**.

The server checks membership, the admin role and the company-session capability on every request. Agent MCP tokens cannot send. Previews expire after five minutes and are bound to the actor, workspace, content hash and webhook destination. A changed destination requires a new preview. Credentials detected in the message are rejected, but detection is not a substitute for reviewing sensitive content.

An audit summary records the workflow version/hash and configuration-check counts as of preview time. It is not a compliance certificate or a complete export of the audit trail. No prompts, references, repository paths or credentials are added to that summary. Audit notifications are manual in this slice; there is no background subscription to every event.

## Receipts and uncertain delivery

Delivery receipts persist under the company data directory in `slack-receipts/`, separated by a hash of the workspace ID. They contain the actor, channel label, timestamp, preview ID, message hash and outcome, not message bodies or webhook URLs. Slack's HTTP 200 `ok` response means accepted, not read by a person.

A pending receipt is persisted before sending. Retrying that preview returns its existing receipt instead of posting again, including after a restart. A timeout, unexpected response or crash can leave the outcome **Unconfirmed** even when Slack received the message. Check the channel before creating a new preview. There is no automatic retry.

This file-backed implementation assumes one company-server process owns these records. It is not a distributed outbox. Sending stops if receipt storage cannot be read/written or reaches 1,000 records per workspace. Preserve receipts while any preview can still be valid; archive storage only during operator maintenance with the server stopped. Removing receipts removes the replay history for those IDs.
