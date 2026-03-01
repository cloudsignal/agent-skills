# CloudSignal REST Publisher API Reference

## Base URL

```
https://rest-publisher.cloudsignal.app
```

Override via `CLOUDSIGNAL_API_URL` environment variable.

## Authentication

All requests require a **REST Publisher API key** in the `Authorization` header:

```
Authorization: Bearer sk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

API keys are created in the CloudSignal dashboard under **API Keys**. Use keys with the `sk_` prefix (secret keys). Public keys (`pk_`) and restricted keys (`rk_`) are not valid for the REST Publisher.

## Endpoints

### POST /v1/publish

Publish a single MQTT message to any topic within your organization's namespace.

**Request:**

```http
POST /v1/publish HTTP/1.1
Host: rest-publisher.cloudsignal.app
Authorization: Bearer sk_xxx
Content-Type: application/json

{
  "topic": "myapp/user_abc123/notifications",
  "payload": {
    "type": "export_complete",
    "title": "Export Ready",
    "message": "Your data export is ready for download."
  },
  "qos": 1,
  "retain": false
}
```

**Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `topic` | string | Yes | Full MQTT topic path. Must be within your org's ACL rules. |
| `payload` | object | Yes | JSON-serializable message body. Delivered as-is to subscribers. |
| `qos` | integer | No | MQTT Quality of Service level. `0` = fire-and-forget, `1` = at-least-once (default), `2` = exactly-once. |
| `retain` | boolean | No | If `true`, broker stores this message and delivers it to future subscribers. Default: `false`. |

**Responses:**

| Status | Meaning |
|--------|---------|
| `200 OK` | Message published successfully. |
| `202 Accepted` | Message accepted for delivery (async processing). |
| `400 Bad Request` | Invalid payload (missing topic, malformed JSON). |
| `401 Unauthorized` | Missing or invalid API key. |
| `403 Forbidden` | API key lacks permission for this topic (ACL violation). |
| `429 Too Many Requests` | Rate limit exceeded. Back off and retry. |
| `500 Internal Server Error` | Server error. Retry with backoff. |

**Rate Limits:**

- Default: 100 requests/second per API key
- Burst: 200 requests/second (short bursts)
- Rate limit headers are included in responses: `X-RateLimit-Remaining`, `X-RateLimit-Reset`

## Topic Naming

Topics follow the pattern: `{namespace}/{user_id}/{resource}[/{sub_id}/{action}]`

Examples:
```
myapp/user_abc123/notifications           — User notifications
myapp/user_abc123/jobs/job_xyz/progress   — Job progress updates
myapp/user_abc123/jobs/job_xyz/status     — Job status changes
myapp/user_abc123/transactions            — Balance/payment updates
```

Topics must match your organization's ACL rules. The namespace prefix should match the frontend `TOPIC_ROOT`.

## Error Handling Best Practices

- **Retry on 429 and 5xx**: Use exponential backoff (recommended: 0.5s base, max 2 retries)
- **Don't retry on 400/401/403**: These are permanent errors that require configuration changes
- **Use `publish()` for progress**: High-frequency updates where missing one message is acceptable
- **Use `publish_with_retry()` for critical messages**: Status changes, notifications, transactions
