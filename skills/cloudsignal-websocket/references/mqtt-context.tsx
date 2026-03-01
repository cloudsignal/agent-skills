"use client";

/**
 * CloudSignal MQTT Context — Reference Implementation
 *
 * A production-grade React context for CloudSignal MQTT with external auth provider
 * token lifecycle management (Clerk, Supabase, Auth0, Firebase, etc.).
 *
 * Handles: connection, auth error recovery, proactive token refresh, reconnect on
 * tab visibility change, exact topic routing, safe JSON parsing, and cleanup.
 *
 * To adapt to your auth provider, replace:
 *   - useUser()    → your user context that provides { id: string }
 *   - useAuth()    → your auth hook that provides getToken(): Promise<string | null>
 *   - TOPIC_ROOT   → your app namespace
 *   - Message types → your domain-specific payloads
 */

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import CloudSignal from "@cloudsignal/mqtt-client";

// =============================================================================
// Configuration
// =============================================================================

const CLOUDSIGNAL_ORG_ID = process.env.NEXT_PUBLIC_CLOUDSIGNAL_ORG_ID;
const CLOUDSIGNAL_HOST =
  process.env.NEXT_PUBLIC_CLOUDSIGNAL_HOST || "wss://connect.cloudsignal.app:18885/";

/** Topic namespace — all topics are prefixed with this. Use a unique value per app. */
const TOPIC_ROOT = "myapp";

/** Delay before reconnecting after a network disconnect. */
const RECONNECT_DELAY_MS = 3_000;

/** Delay before retrying after an auth error (longer to let auth provider refresh). */
const AUTH_ERROR_DELAY_MS = 10_000;

/** Stop retrying after this many consecutive auth errors. */
const MAX_AUTH_ERRORS = 3;

/**
 * Proactively reconnect with a fresh JWT before CloudSignal's MQTT token expires.
 * Set this to ~10 min less than your token TTL. CloudSignal default is 1 hour.
 */
const TOKEN_REFRESH_INTERVAL_MS = 50 * 60 * 1_000; // 50 minutes

// =============================================================================
// Message types — replace with your domain-specific payloads
// =============================================================================

export interface ProgressMessage {
  job_id: string;
  current: number;
  total: number;
  percentage: number;
}

export interface StatusMessage {
  job_id: string;
  status: "pending" | "processing" | "completed" | "failed";
  file_url?: string;
  error?: string;
  total_count?: number;
}

export interface TransactionMessage {
  type: string;
  amount: number;
  new_balance: number;
  description: string;
  reference_id?: string;
  timestamp: string;
}

export interface NotificationMessage {
  type: string;
  title: string;
  message: string;
  action_url?: string;
  job_id?: string;
}

// =============================================================================
// Auth provider adapter — replace these two hooks with your auth provider
// =============================================================================

/**
 * Must return an object with at least { id: string } when the user is
 * authenticated, or null/undefined when logged out.
 *
 * Examples:
 *   Clerk:    const { user } = useUser();          → user.id
 *   Supabase: const { session } = useSession();    → session.user.id
 *   Auth0:    const { user } = useAuth0();         → user.sub
 *   Firebase: const user = useAuthState(auth);     → user.uid
 */
function useCurrentUser(): { id: string } | null | undefined {
  // --- Replace with your auth provider hook ---
  // Example for Clerk:
  //   import { useUser } from "@clerk/nextjs";
  //   const { user } = useUser();
  //   return user ? { id: user.id } : null;
  throw new Error("Replace useCurrentUser() with your auth provider hook");
}

/**
 * Must return a function that resolves to a valid JWT string, or null if
 * the user's session has expired and cannot be refreshed.
 *
 * Most auth providers handle caching and silent refresh internally.
 *
 * Examples:
 *   Clerk:    const { getToken } = useAuth();
 *   Supabase: return () => supabase.auth.getSession().then(s => s.data.session?.access_token ?? null);
 *   Auth0:    const { getAccessTokenSilently } = useAuth0();
 *   Firebase: return () => auth.currentUser?.getIdToken() ?? Promise.resolve(null);
 */
function useGetToken(): () => Promise<string | null> {
  // --- Replace with your auth provider hook ---
  throw new Error("Replace useGetToken() with your auth provider hook");
}

// =============================================================================
// Context types
// =============================================================================

type MessageHandler<T> = (message: T) => void;

interface MQTTContextValue {
  /** Whether the WebSocket is currently connected to the MQTT broker. */
  isConnected: boolean;
  /** Human-readable connection state for debug UI. */
  connectionState: string;
  /**
   * Subscribe to job-specific progress and status messages.
   * Returns an unsubscribe function — call it in useEffect cleanup.
   */
  subscribeToJob: (
    jobId: string,
    handlers: {
      onProgress?: MessageHandler<ProgressMessage>;
      onStatus?: MessageHandler<StatusMessage>;
    }
  ) => () => void;
  /** Subscribe to transaction messages. Returns unsubscribe function. */
  onTransaction: (handler: MessageHandler<TransactionMessage>) => () => void;
  /** Subscribe to notification messages. Returns unsubscribe function. */
  onNotification: (handler: MessageHandler<NotificationMessage>) => () => void;
  /** Force reconnect (resets auth error counter). */
  reconnect: () => void;
}

const MQTTContext = createContext<MQTTContextValue | undefined>(undefined);

// =============================================================================
// Provider
// =============================================================================

export function MQTTProvider({ children }: { children: ReactNode }) {
  const user = useCurrentUser();
  const getToken = useGetToken();
  const [isConnected, setIsConnected] = useState(false);
  const [connectionState, setConnectionState] = useState("disconnected");

  // --- Refs ---
  const clientRef = useRef<CloudSignal | null>(null);
  const connectingRef = useRef(false);
  const mountedRef = useRef(true);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const tokenRefreshTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const authErrorCountRef = useRef(0);
  const lastConnectedUserIdRef = useRef<string | null>(null);

  // Handler registries — using refs so the message callback never goes stale
  const transactionHandlersRef = useRef<Set<MessageHandler<TransactionMessage>>>(new Set());
  const notificationHandlersRef = useRef<Set<MessageHandler<NotificationMessage>>>(new Set());
  const jobHandlersRef = useRef<
    Map<string, { onProgress?: MessageHandler<ProgressMessage>; onStatus?: MessageHandler<StatusMessage> }>
  >(new Map());

  /**
   * Stable ref for the connect function.
   *
   * Timers (token refresh, reconnect) fire long after creation. If they
   * captured connectToCloudSignal directly, they'd close over stale state
   * (old profile, old getToken). Instead they call connectRef.current which
   * is always the latest version.
   */
  const connectRef = useRef<(() => Promise<void>) | undefined>(undefined);

  // --- Helpers ---

  const clearAllTimeouts = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (tokenRefreshTimeoutRef.current) {
      clearTimeout(tokenRefreshTimeoutRef.current);
      tokenRefreshTimeoutRef.current = null;
    }
  }, []);

  const disconnect = useCallback(() => {
    clearAllTimeouts();
    if (clientRef.current) {
      try {
        clientRef.current.destroy();
      } catch {
        // SDK may throw if already destroyed
      }
      clientRef.current = null;
    }
    connectingRef.current = false;
    setIsConnected(false);
    setConnectionState("disconnected");
  }, [clearAllTimeouts]);

  // --- Proactive token refresh ---
  // Destroys the current connection and reconnects with a fresh JWT before
  // the CloudSignal MQTT token expires. This avoids the auth-error reconnect
  // loop described in the SDK pitfalls section.
  const scheduleTokenRefresh = useCallback(() => {
    if (tokenRefreshTimeoutRef.current) clearTimeout(tokenRefreshTimeoutRef.current);
    if (!mountedRef.current) return;

    tokenRefreshTimeoutRef.current = setTimeout(() => {
      tokenRefreshTimeoutRef.current = null;
      if (!mountedRef.current || !clientRef.current) return;

      // Destroy current connection
      try {
        clientRef.current.destroy();
      } catch {
        // ignore
      }
      clientRef.current = null;
      connectingRef.current = false;
      authErrorCountRef.current = 0;

      // Reconnect via stable ref with small delay
      setTimeout(() => {
        if (mountedRef.current && !clientRef.current && !connectingRef.current) {
          connectRef.current?.();
        }
      }, 500);
    }, TOKEN_REFRESH_INTERVAL_MS);
  }, []);

  // --- Reconnect scheduler ---
  const scheduleReconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
    if (!mountedRef.current) return;

    reconnectTimeoutRef.current = setTimeout(() => {
      reconnectTimeoutRef.current = null;
      if (mountedRef.current && !clientRef.current && !connectingRef.current) {
        connectRef.current?.();
      }
    }, RECONNECT_DELAY_MS);
  }, []);

  // --- Main connection function ---
  const connectToCloudSignal = useCallback(async () => {
    // Guards
    if (!mountedRef.current) return;
    if (connectingRef.current || clientRef.current) return;
    if (!user?.id || !CLOUDSIGNAL_ORG_ID) return;
    if (authErrorCountRef.current >= MAX_AUTH_ERRORS) {
      setConnectionState("auth_failed");
      return;
    }

    connectingRef.current = true;
    setConnectionState("connecting");

    try {
      // 1. Get a fresh JWT from your auth provider.
      //    Most providers (Clerk, Auth0, Firebase) cache the token and only
      //    refresh if it's about to expire. This call is cheap when cached.
      const token = await getToken();
      if (!token) {
        connectingRef.current = false;
        setConnectionState("no_token");
        return;
      }

      // 2. Create a new CloudSignal client.
      //    A new client is created on every connect (including reconnects)
      //    because the SDK's internal reconnect uses the original token,
      //    which may have expired. Destroying and recreating is the only
      //    reliable way to connect with a fresh token.
      const userId = user.id;

      const client = new CloudSignal({
        tokenServiceUrl: "https://auth.cloudsignal.app",
        preset: "desktop",
        debug: process.env.NODE_ENV === "development",
      });

      // --- SDK event handlers ---

      client.onConnectionStatusChange = (connected: boolean) => {
        if (!mountedRef.current) return;
        setIsConnected(connected);
        setConnectionState(connected ? "connected" : "disconnected");

        if (connected) {
          authErrorCountRef.current = 0;
        } else if (!connectingRef.current) {
          clearAllTimeouts();
          scheduleReconnect();
        }
      };

      client.onReconnecting = (attempt: number) => {
        if (!mountedRef.current) return;
        setConnectionState("reconnecting");
      };

      // Auth errors get special handling: destroy the client to stop the SDK's
      // internal reconnect loop (which would retry with the stale token), then
      // schedule our own reconnect which fetches a fresh JWT.
      client.onAuthError = (error: Error) => {
        if (!mountedRef.current) return;
        console.error("[MQTT] Auth error:", error);

        authErrorCountRef.current++;
        clearAllTimeouts();

        if (clientRef.current) {
          try {
            clientRef.current.destroy();
          } catch {
            // ignore
          }
          clientRef.current = null;
        }
        setIsConnected(false);
        connectingRef.current = false;

        if (authErrorCountRef.current >= MAX_AUTH_ERRORS) {
          setConnectionState("auth_failed");
          return;
        }

        setConnectionState("auth_error");

        // Retry with a longer delay — give the auth provider time to refresh
        reconnectTimeoutRef.current = setTimeout(() => {
          reconnectTimeoutRef.current = null;
          if (mountedRef.current && !clientRef.current && !connectingRef.current) {
            connectRef.current?.();
          }
        }, AUTH_ERROR_DELAY_MS);
      };

      // 3. Connect — CloudSignal's token service validates your JWT against
      //    the JWKS endpoint configured in your org, then issues an
      //    MQTT-scoped token for the WebSocket connection.
      await client.connectWithToken({
        host: CLOUDSIGNAL_HOST,
        organizationId: CLOUDSIGNAL_ORG_ID,
        externalToken: token,
      });

      // Guard: component may have unmounted during the async connect
      if (!mountedRef.current) {
        client.destroy();
        connectingRef.current = false;
        return;
      }

      clientRef.current = client;
      lastConnectedUserIdRef.current = userId;

      // 4. Schedule proactive token refresh
      scheduleTokenRefresh();

      // 5. Subscribe to user-specific topics
      const prefix = `${TOPIC_ROOT}/${userId}`;
      try {
        await Promise.all([
          client.subscribe(`${prefix}/notifications`),
          client.subscribe(`${prefix}/transactions`),
          client.subscribe(`${prefix}/jobs/+/progress`),
          client.subscribe(`${prefix}/jobs/+/status`),
        ]);
      } catch (subError) {
        console.error("[MQTT] Partial subscribe failure:", subError);
        // Continue — partial subscriptions are better than none
      }

      // 6. Route incoming messages
      client.onMessage((topic: string, message: unknown) => {
        if (!mountedRef.current) return;

        // Safe JSON parse — one bad message should not crash the handler
        let payload: unknown;
        try {
          payload = typeof message === "string" ? JSON.parse(message) : message;
        } catch {
          console.error("[MQTT] Failed to parse message on topic:", topic);
          return;
        }

        // Route by exact topic match (not .includes()) to prevent false matches
        if (topic === `${prefix}/notifications`) {
          notificationHandlersRef.current.forEach((h) => {
            try { h(payload as NotificationMessage); } catch (e) { console.error("[MQTT] Handler error:", e); }
          });
        } else if (topic === `${prefix}/transactions`) {
          transactionHandlersRef.current.forEach((h) => {
            try { h(payload as TransactionMessage); } catch (e) { console.error("[MQTT] Handler error:", e); }
          });
        } else if (topic.startsWith(`${prefix}/jobs/`)) {
          const parts = topic.split("/");
          const jobIdx = parts.indexOf("jobs") + 1;
          const jobId = parts[jobIdx];
          const msgType = parts[jobIdx + 1]; // "progress" or "status"

          const handlers = jobHandlersRef.current.get(jobId);
          if (handlers) {
            if (msgType === "progress" && handlers.onProgress) {
              handlers.onProgress(payload as ProgressMessage);
            } else if (msgType === "status" && handlers.onStatus) {
              handlers.onStatus(payload as StatusMessage);
            }
          }
        }
      });
    } catch (error) {
      console.error("[MQTT] Connection failed:", error);
      if (mountedRef.current) {
        setConnectionState("error");
        scheduleReconnect();
      }
    } finally {
      connectingRef.current = false;
    }
  }, [user?.id, getToken, clearAllTimeouts, scheduleTokenRefresh, scheduleReconnect]);

  // Keep the stable ref in sync on every render
  useEffect(() => {
    connectRef.current = connectToCloudSignal;
  });

  // --- Lifecycle: connect on login, disconnect on logout ---
  useEffect(() => {
    mountedRef.current = true;
    const currentUserId = user?.id ?? null;

    if (currentUserId !== lastConnectedUserIdRef.current) {
      if (currentUserId) {
        authErrorCountRef.current = 0;
        lastConnectedUserIdRef.current = currentUserId;
        connectToCloudSignal();
      } else {
        lastConnectedUserIdRef.current = null;
        disconnect();
      }
    }

    return () => {
      mountedRef.current = false;
      disconnect();
    };
  }, [user?.id, connectToCloudSignal, disconnect]);

  // --- Reconnect when browser tab becomes visible ---
  useEffect(() => {
    const onVisible = () => {
      if (
        document.visibilityState === "visible" &&
        user?.id &&
        !clientRef.current &&
        !connectingRef.current &&
        authErrorCountRef.current < MAX_AUTH_ERRORS
      ) {
        connectRef.current?.();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [user?.id]);

  // --- Public API ---

  const reconnect = useCallback(() => {
    authErrorCountRef.current = 0;
    disconnect();
    setTimeout(() => connectRef.current?.(), 100);
  }, [disconnect]);

  const subscribeToJob = useCallback(
    (
      jobId: string,
      handlers: {
        onProgress?: MessageHandler<ProgressMessage>;
        onStatus?: MessageHandler<StatusMessage>;
      }
    ) => {
      jobHandlersRef.current.set(jobId, handlers);
      return () => {
        jobHandlersRef.current.delete(jobId);
      };
    },
    []
  );

  const onTransaction = useCallback((handler: MessageHandler<TransactionMessage>) => {
    transactionHandlersRef.current.add(handler);
    return () => {
      transactionHandlersRef.current.delete(handler);
    };
  }, []);

  const onNotification = useCallback((handler: MessageHandler<NotificationMessage>) => {
    notificationHandlersRef.current.add(handler);
    return () => {
      notificationHandlersRef.current.delete(handler);
    };
  }, []);

  return (
    <MQTTContext.Provider
      value={{ isConnected, connectionState, subscribeToJob, onTransaction, onNotification, reconnect }}
    >
      {children}
    </MQTTContext.Provider>
  );
}

// =============================================================================
// Hook
// =============================================================================

export function useMQTT() {
  const ctx = useContext(MQTTContext);
  if (!ctx) throw new Error("useMQTT must be used within <MQTTProvider>");
  return ctx;
}
