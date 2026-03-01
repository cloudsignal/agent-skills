/**
 * TypeScript declarations for @cloudsignal/mqtt-client
 *
 * The npm package does not ship type declarations as of v2.1.0.
 * Place this file in your project's `types/` directory.
 */

declare module "@cloudsignal/mqtt-client" {
  interface CloudSignalOptions {
    /** Enable console debug logging. */
    debug?: boolean;
    /** Connection preset optimized for different platforms. */
    preset?: "mobile" | "desktop" | "agent" | "server";
    /** Auto-detect platform for optimal settings. */
    autoDetectPlatform?: boolean;
    /** CloudSignal token service URL (default: https://auth.cloudsignal.app). */
    tokenServiceUrl?: string;
    /** Enable request/response pattern over MQTT. */
    enableRequestResponse?: boolean;
    /** MQTT keepalive interval in seconds. */
    keepalive?: number;
    /** Connection timeout in milliseconds. */
    connectTimeout?: number;
    /** Reconnect period in milliseconds (SDK-managed reconnect). */
    reconnectPeriod?: number;
    /** Start with a clean session (no persisted subscriptions). */
    cleanSession?: boolean;
    /** Queue messages while offline. */
    offlineQueueEnabled?: boolean;
    /** Maximum offline queue size. */
    offlineQueueMaxSize?: number;
  }

  interface ConnectConfig {
    host: string;
    username?: string;
    password?: string;
    clientId?: string;
    willTopic?: string;
    willMessage?: string;
    willQos?: number;
  }

  interface ConnectWithTokenConfig {
    /** MQTT broker WebSocket URL (e.g., "wss://connect.cloudsignal.app:18885/"). */
    host: string;
    /** Organization ID from CloudSignal dashboard (e.g., "org_xxx"). */
    organizationId: string;
    /** Server-side secret key (for machine-to-machine auth). */
    secretKey?: string;
    /** User email (optional metadata). */
    userEmail?: string;
    /** User display name (optional metadata). */
    userName?: string;
    /** Custom metadata to associate with the connection. */
    metadata?: Record<string, unknown>;
    /**
     * Auth provider hint. In practice, the org's configured provider is used
     * automatically — this field is optional.
     */
    provider?: "supabase" | "firebase" | "auth0" | "clerk" | "oidc";
    /**
     * JWT from your auth provider (Clerk, Supabase, Auth0, Firebase, etc.).
     * CloudSignal's token service validates this against your org's JWKS endpoint.
     *
     * Note: SDK docs may reference "idToken" — use "externalToken" instead.
     */
    externalToken?: string;
    /** Integration ID for multi-integration orgs. */
    integrationId?: string;
  }

  interface PublishOptions {
    qos?: 0 | 1 | 2;
    retain?: boolean;
    properties?: {
      userProperties?: Record<string, string>;
    };
  }

  type MessageHandler = (topic: string, message: unknown, packet?: unknown) => void;
  type RequestHandler = (
    topic: string,
    payload: unknown,
    respond: (response: unknown) => Promise<void>
  ) => Promise<void>;

  class CloudSignal {
    constructor(options?: CloudSignalOptions);

    /** Connect with raw credentials (username/password). */
    connect(config: ConnectConfig): Promise<void>;
    /** Connect using a JWT from an external auth provider. */
    connectWithToken(config: ConnectWithTokenConfig): Promise<void>;
    /** Graceful disconnect. */
    disconnect(): void;
    /** Destroy the client (closes connection, cleans up resources). */
    destroy(): void;

    /** Subscribe to a topic with optional QoS. */
    subscribe(topic: string, qos?: number): Promise<void>;
    /** Unsubscribe from a topic. */
    unsubscribe(topic: string): Promise<void>;
    /** Publish a message (fire-and-forget from client). */
    transmit(topic: string, message: unknown, options?: PublishOptions): void;

    /** Register a handler for incoming messages. */
    onMessage(callback: MessageHandler): void;
    /** Send a request and await a response (request/response pattern). */
    request(topic: string, payload: unknown, options?: { timeout?: number }): Promise<unknown>;
    /** Register a handler for incoming requests. */
    onRequest(handler: RequestHandler): void;

    /** Check if currently connected. */
    isConnected(): boolean;
    /** Get current connection state. */
    getConnectionState(): "disconnected" | "connecting" | "connected" | "reconnecting";
    /** Get set of currently subscribed topics. */
    getSubscriptions(): Set<string>;
    /** Get current client configuration. */
    getConfig(): CloudSignalOptions;

    // --- Event handlers (assign a function or null) ---

    /** Called when connection status changes. */
    onConnectionStatusChange: ((isConnected: boolean) => void) | null;
    /** Called when the client goes offline. */
    onOffline: (() => void) | null;
    /** Called when the client comes back online. */
    onOnline: (() => void) | null;
    /** Called when the SDK is attempting to reconnect. */
    onReconnecting: ((attempt: number) => void) | null;
    /**
     * Called on authentication errors (expired/invalid token).
     *
     * IMPORTANT: The SDK's internal reconnect will retry with the original
     * (potentially expired) token. To reconnect with a fresh token, destroy
     * the client in this handler and reconnect from your application code.
     */
    onAuthError: ((error: Error) => void) | null;
  }

  export default CloudSignal;
}
