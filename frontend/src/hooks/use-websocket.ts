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
  WSMessageDeletedData,
  WSAgentStatusData,
  WSAgentTypingData,
  WSAgentStreamingData,
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
  const removeRealtimeMessage = useAppStore((s) => s.removeRealtimeMessage);
  const setAgentStatus = useAppStore((s) => s.setAgentStatus);
  const setAgentTyping = useAppStore((s) => s.setAgentTyping);
  const appendStreamingDelta = useAppStore((s) => s.appendStreamingDelta);
  const clearStreamingMessage = useAppStore((s) => s.clearStreamingMessage);
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
            edited_at: null,
            created_at: msg.created_at,
          });
          // Clear typing indicator and streaming text when agent sends a message
          if (msg.sender_name) {
            setAgentTyping(msg.channel_id, msg.sender_name, false);
            clearStreamingMessage(msg.channel_id, msg.sender_name);
          }
          queryClient.invalidateQueries({
            queryKey: queryKeys.messages(msg.channel_id),
          });
          break;
        }

        case "message_deleted": {
          const del = event.data as WSMessageDeletedData;
          removeRealtimeMessage(del.id);
          queryClient.invalidateQueries({
            queryKey: queryKeys.messages(del.channel_id),
          });
          break;
        }

        case "message_edited": {
          const edited = event.data as { channel_id: string };
          queryClient.invalidateQueries({
            queryKey: queryKeys.messages(edited.channel_id),
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
          // Clear streaming text when typing stops (agent finished or errored)
          if (!data.is_typing) {
            clearStreamingMessage(data.channel_id, data.agent_name);
          }
          break;
        }

        case "agent_streaming": {
          const data = event.data as WSAgentStreamingData;
          appendStreamingDelta(data.channel_id, data.agent_name, data.delta);
          break;
        }

        case "reaction": {
          // Invalidate messages to refetch with updated reactions
          const reaction = event.data as { channel_id: string };
          queryClient.invalidateQueries({
            queryKey: queryKeys.messages(reaction.channel_id),
          });
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
    [addRealtimeMessage, removeRealtimeMessage, setAgentStatus, setAgentTyping, appendStreamingDelta, clearStreamingMessage],
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
