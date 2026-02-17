/** WebSocket hook for real-time updates from the backend.
 *
 * Connects to /ws, handles reconnection, and dispatches events
 * to the Zustand store and TanStack Query cache.
 *
 * Uses refs for callbacks to avoid dependency-triggered reconnect loops.
 */
import { useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "@/stores/app-store";
import { queryKeys } from "@/hooks/use-queries";
import type {
  WSEvent,
  WSNewMessageData,
  WSAgentStatusData,
  WSAgentTypingData,
} from "@/lib/types";

const WS_URL = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws`;
const RECONNECT_DELAY = 2000;
const HEARTBEAT_INTERVAL = 30_000;

export function useWebSocket(enabled: boolean = true) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const heartbeatTimer = useRef<ReturnType<typeof setInterval>>(undefined);
  const pendingSubscriptions = useRef<string[]>([]);
  const mountedRef = useRef(true);
  const qc = useQueryClient();

  // Grab stable action references from Zustand (these never change identity)
  const addRealtimeMessage = useAppStore((s) => s.addRealtimeMessage);
  const setAgentStatus = useAppStore((s) => s.setAgentStatus);
  const setAgentTyping = useAppStore((s) => s.setAgentTyping);
  const setWsConnected = useAppStore((s) => s.setWsConnected);

  // Keep a ref to the latest queryClient so the WS handlers always use
  // the current one without needing it in dependency arrays.
  const qcRef = useRef(qc);
  useEffect(() => { qcRef.current = qc; }, [qc]);

  const handleEvent = useCallback(
    (event: WSEvent) => {
      const queryClient = qcRef.current;

      switch (event.type) {
        case "new_message": {
          const msg = event.data as WSNewMessageData;
          addRealtimeMessage({
            id: msg.id,
            channel_id: msg.channel_id,
            sender_id: msg.sender_id,
            sender_name: msg.sender_name,
            sender_type: msg.sender_type,
            content: msg.content,
            mentions: msg.mentions,
            parent_id: msg.parent_id,
            created_at: msg.created_at,
          });
          // Clear typing indicator when agent sends a message
          if (msg.sender_name) {
            setAgentTyping(msg.channel_id, msg.sender_name, false);
          }
          queryClient.invalidateQueries({
            queryKey: queryKeys.messages(msg.channel_id),
          });
          break;
        }

        case "agent_status": {
          const data = event.data as WSAgentStatusData;
          setAgentStatus(data.agent_name, data.status);
          queryClient.invalidateQueries({ queryKey: queryKeys.agents });
          break;
        }

        case "agent_typing": {
          const data = event.data as WSAgentTypingData;
          setAgentTyping(data.channel_id, data.agent_name, data.is_typing, data.error);
          break;
        }

        case "channel_created": {
          queryClient.invalidateQueries({ queryKey: queryKeys.channels });
          break;
        }

        case "feature_update": {
          queryClient.invalidateQueries({ queryKey: ["features"] });
          break;
        }

        default:
          break;
      }
    },
    [addRealtimeMessage, setAgentStatus, setAgentTyping],
  );

  // Keep refs so the WS handlers always use the latest versions without
  // needing them in useCallback dependency arrays.
  const handleEventRef = useRef(handleEvent);
  useEffect(() => { handleEventRef.current = handleEvent; }, [handleEvent]);

  // Ref for recursive reconnect — avoids referencing `connect` before declaration.
  const connectRef = useRef<() => void>(undefined);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      setWsConnected(true);

      // Flush any subscriptions that were queued before the socket was open
      if (pendingSubscriptions.current.length > 0) {
        ws.send(JSON.stringify({ action: "subscribe", channel_ids: pendingSubscriptions.current }));
        pendingSubscriptions.current = [];
      }

      // Start heartbeat
      heartbeatTimer.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ action: "ping" }));
        }
      }, HEARTBEAT_INTERVAL);
    };

    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as WSEvent;
        handleEventRef.current(event);
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      setWsConnected(false);
      if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
      // Auto-reconnect (only if still mounted)
      if (mountedRef.current) {
        reconnectTimer.current = setTimeout(() => connectRef.current?.(), RECONNECT_DELAY);
      }
    };

    ws.onerror = () => {
      ws.close();
    };

    wsRef.current = ws;
  }, [setWsConnected]);

  useEffect(() => { connectRef.current = connect; }, [connect]);

  const subscribe = useCallback((channelIds: string[]) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action: "subscribe", channel_ids: channelIds }));
    } else {
      // Queue subscriptions until the socket is open
      pendingSubscriptions.current = channelIds;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled) return;
    connect();

    return () => {
      mountedRef.current = false;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [enabled, connect]);

  return { subscribe };
}
