# Security controls and AWS deployment design

This guide maps Magentic's application controls to a proposed AWS deployment. It follows the [AWS Well-Architected Security Pillar](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/welcome.html). AWS services below are design choices, not deployed or verified capabilities. This is a control inventory, not a penetration-test report.

## Existing application controls

| Control | Implementation and evidence |
| --- | --- |
| Company access | Clerk organization membership maps to workspace roles; unknown roles grant no access. [Company access](../workbench/company-access.ts), [isolation tests](../tests/company-workspaces.test.ts). |
| Server authorization | Workspace membership and operation permissions are checked by the API; UI visibility is not authorization. Cross-origin writes are checked. [Server](../workbench/server.ts). |
| Agent permissions | Repository agents have validated tool allowlists and call budgets; denied calls stop before dispatch. [Policy](../workbench/bot-schema.ts), [tests](../tests/mcp-policy.test.ts). |
| Independent review | Gated workflow handoffs reject approval by the run owner or output author. Registry approvals count distinct reviewers against the current content hash. [Pipeline](../workbench/pipeline.ts), [registry](../registry/record.ts). |
| Outbound messaging | Company Slack delivery requires an administrator session and a reviewed preview bound to its actor, workspace, content and destination. Delivery receipts prevent automatic duplicate retries. [Implementation](../workbench/slack.ts), [tests](../tests/slack.test.ts). |

These controls do not provide host isolation, encrypted storage, immutable audit archives, or a guarantee that model output is correct.

## Proposed AWS controls

Each row requires implementation and deployment evidence before being described as active.

| Area | AWS design for Magentic | Evidence required |
| --- | --- | --- |
| Identity and least privilege | IAM Identity Center with MFA for operators; separate IAM roles and temporary STS credentials for the API, workers and automation functions. Limit permissions to required actions and resources. Clerk still handles application membership. [IAM guidance](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html). | Role policies and denied-action tests; revoked users lose access. |
| Account boundaries | Separate development, production and security/logging accounts. Use Organizations service control policies as permission ceilings, not permission grants; review public and cross-account access with IAM Access Analyzer. [IAM guidance](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html). | Account layout, reviewed policies and resolved access findings. |
| Network isolation | Private application and worker subnets, restricted security groups, controlled outbound provider access and VPC Flow Logs. Use private endpoints for supported AWS services. [VPC guidance](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-security-best-practices.html). | Network diagram and tests denying public access to workers and storage. |
| Web and transport protection | HTTPS at a managed ingress with certificate renewal; AWS WAF rules and rate controls, plus an assessed Shield protection level. Test streaming chat and MCP traffic against these rules. [WAF and Shield](https://docs.aws.amazon.com/waf/latest/developerguide/what-is-aws-waf.html). | TLS checks, blocked attack samples and successful legitimate streams. |
| Secrets | Secrets Manager with scoped retrieval and supported rotation; KMS key policies limit decryption. Keep provider keys and webhook credentials out of browser bundles, prompts and logs. [Secrets guidance](https://docs.aws.amazon.com/secretsmanager/latest/userguide/best-practices.html). | Rotation exercise, access-denial tests and secret scans. |
| Stored data | Encrypt workspace storage and backups; use S3 Block Public Access, versioning and explicit retention. Consider Object Lock for audit evidence after retention approval. Define tenant access in the application and storage policies. [S3 guidance](https://docs.aws.amazon.com/AmazonS3/latest/userguide/security-best-practices.html). | Cross-company access tests, encryption settings and deletion/retention checks. |
| Audit and detection | Organization CloudTrail trails, selected data events, log integrity validation, CloudWatch alarms, GuardDuty threat detection and Security Hub CSPM posture findings. Export application audit events separately; CloudTrail does not record every Magentic action. [CloudTrail guidance](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/best-practices-security.html). | A controlled event produces an alert with actor, workspace, action and outcome; logs exclude secrets and raw prompts by default. |
| Vulnerabilities and operations | Inspector scans for supported EC2, ECR and Lambda resources. Patch hosts and dependencies; use Systems Manager Session Manager instead of public administrative ports. [Inspector](https://docs.aws.amazon.com/inspector/latest/user/what-is-inspector.html), [Session Manager](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager.html). | Scan coverage, remediation ownership, patch records and restricted operator sessions. |
| Release security | A scoped GitHub OIDC deployment role, reviewed infrastructure changes, locked dependencies, artifact checks and rollback. Restrict federation trust to the intended repository and release context. [IAM OIDC](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc.html). | An unrelated repository cannot assume the role; deployment and rollback are reproducible. |
| Recovery | AWS Backup for supported storage, protected retention and scheduled restore tests. Define acceptable data loss and recovery time with the company; measure both. [Restore testing](https://docs.aws.amazon.com/aws-backup/latest/devguide/restore-testing.html). | Restore a workspace and verify its references, approval state and audit history. |
| Incident response | Named responders and runbooks for compromised credentials, tenant exposure, malicious tool requests and model-provider leakage. Revoke access, contain workers, preserve evidence and validate recovery. [AWS response guide](https://docs.aws.amazon.com/whitepapers/latest/aws-security-incident-response-guide/). | A tabletop and containment exercise with recorded follow-up actions. |

## Agent and company data boundaries

For the hosted design, isolate execution workers from the API and from other tenants; a Git worktree alone is not a sandbox. Treat retrieved documents and tool responses as untrusted input. Prompts cannot authorize tools or override approval rules.

Restrict provider destinations, metadata-service access and network egress. Apply per-company concurrency, token and spending limits on the server. Test malicious references, forged workspace IDs, expired credentials and repeated delivery requests. WAF rules do not solve prompt injection or tenant authorization.

Keep sensitive material out of model training and provider requests unless the company's data policy permits it. Define retention, region, provider and deletion requirements before onboarding real company data.

## Before a hosted pilot

1. Implement the selected controls and attach the evidence listed above.
2. Run independent authorization, tenant-isolation and application security testing, including browser injection and session handling.
3. Exercise alerting, restore and incident response with synthetic data.
4. Review the company deployment separately from the relay-adapter container. Current JSON persistence assumes a single writer; scaling needs a storage and coordination design.

Under the [AWS shared responsibility model](https://aws.amazon.com/compliance/shared-responsibility-model/), AWS protects its underlying cloud infrastructure; the operator remains responsible for this application's configuration, identities, data and code. AWS hosting or use of GovCloud does not itself confer FedRAMP authorization, an ATO, or other compliance status on Magentic.

See [workspace deployment preparation](workspace-deployments.md) for the current rollout boundary.
