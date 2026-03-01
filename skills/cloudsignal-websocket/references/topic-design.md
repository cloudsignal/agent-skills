# Topic Design Guidelines

## Topic Structure

```
{app_namespace}/{user_id}/notifications         — User alerts/toasts
{app_namespace}/{user_id}/transactions           — Balance/payment updates
{app_namespace}/{user_id}/jobs/{job_id}/progress — Job progress (high-frequency)
{app_namespace}/{user_id}/jobs/{job_id}/status   — Job lifecycle (low-frequency, critical)
{app_namespace}/admin/{tenant_id}/activity       — Admin dashboard feed
{app_namespace}/tenants/{tenant_id}/announcements — Broadcast to tenant members
```

## Wildcard Subscriptions (Frontend)

Use MQTT single-level wildcard `+` to match all entities:

```
{app_namespace}/{user_id}/jobs/+/progress   — All jobs for this user
{app_namespace}/{user_id}/jobs/+/status     — All job status changes for this user
```

## Tips

- Use a unique namespace prefix per app/environment to prevent cross-talk between apps
- Keep user IDs in the topic path for ACL enforcement at the broker level
- Separate high-frequency (progress) from critical (status) topics — lets you apply different QoS and retention policies
- Never put MQTT wildcard characters (`+`, `#`) in user-controlled topic segments
- The topic namespace (TOPIC_ROOT) MUST match between frontend and backend

## Topic Routing in Code

Always use exact prefix matching, not `.includes()`, to prevent false matches when topic segments contain similar substrings:

```tsx
// Bad:  topic.includes("/notifications")  — matches ".../job-notifications/..."
// Good: topic === `${prefix}/notifications`
```

For job topics with dynamic IDs, split the topic string and extract segments by index:

```tsx
const parts = topic.split("/");
const jobIdx = parts.indexOf("jobs") + 1;
const jobId = parts[jobIdx];
const msgType = parts[jobIdx + 1]; // "progress" or "status"
```
