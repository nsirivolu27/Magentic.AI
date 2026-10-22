# Automation units

The company server can invoke a pinned AWS Lambda version using a completed,
independently reviewed workflow stage as input. This is an operator-triggered
backend integration. It does not deploy resources, automatically run on stage
completion, or expose cloud writes to chat agents.

## Configure

Install AWS CLI v2 on the server. Configure an AWS profile or workload role
with `lambda:InvokeFunction` on the exact numbered function ARN. The Lambda
execution role needs only the resources its implementation uses. Do not put
keys in the unit file. AWS CLI resolves credentials through its credential chain.

Set `MAGENTIC_AUTOMATION_UNITS_FILE` to a JSON file based on
`examples/automation-units.json`. Replace the workspace UUID, function ARN and
stage IDs with actual values. Use a numbered published version, not an alias.
Set `enabled` to true only when the destination is ready. Restart the company
server after configuration changes. With no file, the catalogue is empty.

## Review and invoke

Using a signed-in company admin session, send JSON to
`POST /api/automation-units`:

```json
{"action":"preview","unitId":"report-builder","runId":"<run UUID>","stageId":"review"}
```

Review the returned unit and payload. Submit the same references with
`action: "invoke"` and the returned `expectedIntentHash`. The server rechecks
membership, admin authority, company ownership, stage completion, distinct
approvals and the output fingerprint. Clients cannot supply a payload or ARN.
The payload contains only requestId, workspaceId, runId, stageId, outputHash
and the approved output. The credential detector rejects known secret patterns;
it is not a guarantee that arbitrary business text is safe to disclose.

`GET /api/automation-units?runId=<UUID>` returns configuration and receipts.
Pipeline MCP exposes `get_automation_units` for the same read-only inspection.
MCP credentials cannot dispatch. The current canvas has no invocation button.

## Delivery contract

- One invocation attempt per company, unit, run and stage; repeat requests return
  the same receipt, including failed or uncertain outcomes.
- One active invocation per company, four across this process; 500 retained
  receipts per company. Reaching the limit refuses new dispatches.
- A durable running claim is saved before invocation. Restart marks interrupted
  claims uncertain. There is no automatic retry, including inside AWS CLI.
- The adapter uses synchronous RequestResponse with a 1–60 second client limit.
  A timeout stops waiting; it cannot cancel a function already running in AWS.
- A successful HTTP response with FunctionError is recorded as failed. A
  disconnect, malformed response or mismatched executed version is uncertain.
- Receipts contain status, identity, timestamps, duration, hashes, response byte
  count and executed version. Function bodies, logs and transport errors are
  not saved or returned. Temporary input/output files are removed after the call.

The payload requestId is stable. Functions that produce side effects must
deduplicate it themselves. This application does not promise exactly-once AWS
execution. Investigate an uncertain outcome in AWS before deciding on recovery;
there is intentionally no retry button. Do not remove receipts to force a retry.
The existing single-writer workspace lock protects local storage. Multiple
server replicas require a shared transactional claim store before deployment.

## Next adapters

Step Functions can coordinate long-running jobs, SQS can decouple work, S3 can
hold large artifacts, and EventBridge can provide schedules. These are future
adapters, not enabled capabilities. Each needs its own permission scope,
idempotency and completion contract; adding a generic shell tool would bypass
the workflow controls.

AWS contract: https://docs.aws.amazon.com/cli/latest/reference/lambda/invoke.html
