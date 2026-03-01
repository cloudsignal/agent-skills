# CloudSignal Agent Skills

Claude Code skills for integrating [CloudSignal](https://cloudsignal.app) real-time messaging into your applications.

## Installation

```bash
npx skills add cloudsignal/agent-skills
```

## Available Skills

| Skill | Command | Description |
|-------|---------|-------------|
| [cloudsignal-websocket](skills/cloudsignal-websocket/) | `/cloudsignal-websocket` | React MQTT context for real-time notifications over WebSocket. Supports Clerk, Supabase, Auth0, Firebase auth providers. |
| [cloudsignal-rest](skills/cloudsignal-rest/) | `/cloudsignal-rest` | Python REST publisher for serverless backends. Connection pooling, retry, throttling. |

## Quick Start

### Frontend (React/Next.js)

Invoke the skill in Claude Code:

```
/cloudsignal-websocket
```

Claude will ask for your auth provider (Clerk, Supabase, Auth0, Firebase), organization ID, and topic namespace, then generate:
- `mqtt-context.tsx` — Full React context provider with auth integration
- `cloudsignal.d.ts` — TypeScript declarations for `@cloudsignal/mqtt-client`

### Backend (Python)

Invoke the skill in Claude Code:

```
/cloudsignal-rest
```

Claude will ask for your topic namespace, message types, and Python framework, then generate:
- `cloudsignal.py` — Async REST publisher module with retry and throttling

## Architecture

```
  Frontend (WebSocket)              CloudSignal                Backend (REST)
 +-------------------+        +------------------+        +------------------+
 |  React App        |--JWT-->|  Token Service   |        |  Python Worker   |
 |  mqtt-context.tsx |        |  MQTT Broker     |<-HTTP--|  cloudsignal.py  |
 |                   |<--WSS--|  REST Publisher   |        |                  |
 +-------------------+        +------------------+        +------------------+
```

- **Frontend** connects via WebSocket using auth-provider JWT tokens
- **Backend** publishes via HTTP REST API — no persistent connections needed
- Both use the same topic namespace for end-to-end real-time messaging

## Prerequisites

1. A CloudSignal organization — [Create one at dashboard.cloudsignal.app](https://dashboard.cloudsignal.app)
2. An External Auth Provider integration configured (for frontend)
3. A REST Publisher API key (`sk_xxx`) (for backend)

## Testing Locally

To test skills during development without installing:

```bash
claude --add-dir ./skills/cloudsignal-websocket
claude --add-dir ./skills/cloudsignal-rest
```

## License

MIT
