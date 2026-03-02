# CloudSignal SDK Pitfalls

Issues discovered during production integration. Handle all of these in generated code.

## 1. Token Expiry Causes Reconnect Loop

**Problem**: The SDK's internal reconnect retries with the original (now-expired) token. Since the token is stale, every reconnect attempt triggers another auth error.

**Solution**: On `onAuthError`, destroy the client entirely and reconnect from scratch with a fresh JWT from your auth provider. Do NOT rely on the SDK's built-in reconnect for auth errors.

```tsx
client.onAuthError = (error) => {
  client.destroy();           // Kill the stale-token reconnect loop
  clientRef.current = null;
  scheduleReconnectWithFreshToken();  // Your code gets a new JWT
};
```

## 2. `externalToken` Not `idToken`

Documentation may reference `idToken` and `provider` parameters. The actual SDK uses `externalToken` and infers the provider from your org configuration:

```tsx
// Correct
await client.connectWithToken({
  host: "wss://connect.cloudsignal.app:18885/",
  organizationId: "org_xxx",
  externalToken: yourJwt,
});
```

## 3. No TypeScript Declarations

The npm package doesn't ship `.d.ts` files. Always generate the `cloudsignal.d.ts` type declaration file alongside the context provider.

## 4. React StrictMode Double-Mount

In development, React StrictMode mounts components twice. Without guards, this creates two simultaneous MQTT connections. Use the `connectingRef` + `mountedRef` pattern:

```tsx
const connectingRef = useRef(false);
const mountedRef = useRef(true);

// In connect function:
if (connectingRef.current || clientRef.current) return;
connectingRef.current = true;

// In cleanup:
mountedRef.current = false;
```

## 5. Token Service Version Mismatch

SDK v2.x expects `/v2/tokens/exchange`. If you get 422 errors, ensure your CloudSignal organization is on a compatible token service version.

## 6. CJS `require()` Breaks `mqtt.connect()`

**Problem**: Using `const CloudSignal = require("@cloudsignal/mqtt-client")` (CommonJS) triggers Node's `_interopDefault` wrapper, which breaks the internal `mqtt.connect()` call. This commonly happens when trying to avoid chunk splitting in bundlers.

**Solution**: Always use ESM `import`:

```tsx
// Correct — ESM import
import CloudSignal from "@cloudsignal/mqtt-client";

// Wrong — CJS require breaks internal mqtt.connect()
const CloudSignal = require("@cloudsignal/mqtt-client");
```

If your bundler forces CJS, use dynamic `import()` instead:

```tsx
const { default: CloudSignal } = await import("@cloudsignal/mqtt-client");
```
