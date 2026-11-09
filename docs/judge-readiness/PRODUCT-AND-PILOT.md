# PermitZero — Product and Pilot

## 1. Product framing

PermitZero is a control plane that sits between AI agents and consequential
enterprise tools. It intercepts every consequential tool call, binds it to a tenant,
identity, task, policy version, and exact argument hash, then allows, denies, queues
for human approval, or halts before a connector executes.

Problem: autonomous agents can perform consequential actions; ordinary tool
permissions do not authorize the exact action, context, destination, and amount.

## 2. Potential integrations (not yet implemented; illustrative only)

- ERP and accounts payable.
- Procurement systems.
- Vendor management.
- Cloud infrastructure control planes.
- Enterprise workflow tools.
- Agent frameworks.
- Internal enterprise APIs.

## 3. Initial buyer hypotheses

- CIO / CTO.
- CISO.
- Head of AI.
- Head of Finance Operations.
- Enterprise Risk.
- Platform Engineering.

## 4. Pilot proposal (simulated technical demonstration vs real deployment)

The pilot distinguishes a simulated technical demonstration from a real customer
deployment. No paying customers, signed partnerships, revenue, or live production
deployments are claimed.

### Scope
- One tenant, one agent framework, one connector type (simulated finance), one
  approval workflow, a defined set of policy rules.

### Customer environment
- Customer-hosted or PermitZero-hosted evaluation instance; customer provides
  identity provider integration and synthetic or anonymized data.

### Integration boundaries
- Read-only or simulated connectors initially; no live payment rails.
- Agent calls PermitZero instead of calling the connector directly.

### Data requirements
- Synthetic or anonymized invoices, vendors, POs; no production PII or secrets.

### Identity model
- Customer IdP (OIDC/SAML) mapped to PermitZero principals and roles; step-up
  auth for sensitive actions.

### Policy ownership
- Customer owns policy rules; PermitZero provides the PDP and publication workflow
  (two-person publication for high-risk rules).

### Approval workflow
- Quorum + separation of duties; requester cannot approve own action; approvals
  bound to exact action hash + policy revision.

### Audit requirements
- Hash-chained per-tenant audit log; `verifyAuditChain`; retention + legal hold.

### Success metrics
- Zero unauthorized executions in the pilot; 100% of consequential actions
  intercepted; approval latency within agreed SLO; audit chain verifies.

### Security review
- Customer security review of threat model, RLS, and secret handling; no
  independent third-party review claimed unless performed.

### Rollback
- Disable the connector / revert to direct agent-to-tool calls; revoke permits;
  retain audit trail.

### Exit criteria
- Defined pilot duration, agreed success metrics met, security review passed,
  decision to productionize or stop. No lock-in; simulated demo remains available
  for evaluation.