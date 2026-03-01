# CloudSignal Architecture

## System Diagram

```
                          CloudSignal
                     +------------------+
  Frontend           |                  |           Backend
  (MQTT/WSS)        |  Auth Service    |     (REST Publisher)
 +----------+       |  auth.cloudsig.. |      +----------+
 |  React   |--JWT-->|                  |      |  Python  |
 |  App     |       |  MQTT Broker     |<-REST-|  Worker  |
 |          |<--WSS--|  connect.cloud.. |      |          |
 +----------+       |                  |      +----------+
                     |  REST Publisher  |
                     |  rest-pub.cloud. |
                     +------------------+
```

## Service URLs

| Service | URL | Used By |
|---------|-----|---------|
| Token Service | `https://auth.cloudsignal.app` | Frontend SDK (automatic) |
| MQTT Broker | `wss://connect.cloudsignal.app:18885/` | Frontend SDK (WebSocket) |
| REST Publisher | `https://rest-publisher.cloudsignal.app` | Backend (HTTP POST) |
| Dashboard | `https://dashboard.cloudsignal.app` | Configuration |

## Authentication Flow

1. Frontend authenticates user via auth provider (Clerk, Supabase, Auth0, Firebase)
2. Frontend passes auth JWT to CloudSignal's token service, which validates it against the org's configured JWKS endpoint and issues an MQTT-scoped token
3. Frontend connects to MQTT broker over WebSocket using the MQTT token
4. Frontend subscribes to user-specific topics
5. Backend publishes messages to CloudSignal's REST Publisher API (no persistent connection needed)
6. Frontend receives messages in real-time via the WebSocket connection

## Auth Provider Configuration

Each CloudSignal organization configures an External Auth Provider integration:
- Select provider type (Clerk, Supabase, Auth0, Firebase, or custom OIDC)
- Enter your JWKS URL (e.g., `https://your-clerk-domain/.well-known/jwks.json`)
- Configure required JWT claims (typically `email`)

The token service validates incoming JWTs against this JWKS endpoint before issuing MQTT credentials.

## Auth Provider Token Sources

| Auth Provider | User ID Source | Token Source |
|---------------|----------------|--------------|
| **Clerk** | `useUser().user.id` | `useAuth().getToken()` |
| **Supabase** | `session.user.id` | `session.access_token` |
| **Auth0** | `useAuth0().user.sub` | `useAuth0().getAccessTokenSilently()` |
| **Firebase** | `auth.currentUser.uid` | `auth.currentUser.getIdToken()` |
