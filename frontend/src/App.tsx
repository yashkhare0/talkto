import { useEffect, Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Onboarding } from "@/components/onboarding";
import { JoinWorkspace } from "@/components/join-workspace";
import { WorkspaceLayout } from "@/components/workspace/workspace-layout";
import { MessageFeed } from "@/components/workspace/message-feed";
import { useAppStore } from "@/stores/app-store";
import { useMe, useAuthMe } from "@/hooks/use-queries";

// Apply dark mode class on initial load (before first paint)
if (localStorage.getItem("talkto-dark-mode") === "true") {
  document.documentElement.classList.add("dark");
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

/**
 * Check if the current URL is an invite join path: /join/:token
 */
function getJoinToken(): string | null {
  const path = window.location.pathname;
  const match = path.match(/^\/join\/(.+)$/);
  return match ? match[1] : null;
}

/** Inner app content that uses hooks. */
function AppContent() {
  const isOnboarded = useAppStore((s) => s.isOnboarded);
  const setAuthInfo = useAppStore((s) => s.setAuthInfo);
  const setActiveWorkspaceId = useAppStore((s) => s.setActiveWorkspaceId);
  const { data: me, isLoading, isError } = useMe();
  const { data: authInfo } = useAuthMe();

  // Store auth context in Zustand when it loads
  useEffect(() => {
    if (authInfo) {
      setAuthInfo(authInfo);
      if (authInfo.workspace_id) {
        setActiveWorkspaceId(authInfo.workspace_id);
      }
    }
  }, [authInfo, setAuthInfo, setActiveWorkspaceId]);

  // Check for invite join flow
  const joinToken = getJoinToken();
  if (joinToken) {
    return <JoinWorkspace token={joinToken} />;
  }

  // Show loading while checking for existing user
  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <span className="text-sm text-muted-foreground animate-pulse">
          Connecting...
        </span>
      </div>
    );
  }

  // Already onboarded this session — show workspace
  if (isOnboarded) {
    return (
      <WorkspaceLayout>
        <MessageFeed />
      </WorkspaceLayout>
    );
  }

  // No user exists — show new-user onboarding wizard
  if (isError) {
    return <Onboarding />;
  }

  // User exists but hasn't confirmed — show welcome-back screen
  if (me) {
    return <Onboarding existingUser={me} />;
  }

  // Fallback — shouldn't reach here
  return (
    <WorkspaceLayout>
      <MessageFeed />
    </WorkspaceLayout>
  );
}

/** Error boundary — catches rendering crashes and shows a recovery UI. */
class ErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary] Uncaught error:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen items-center justify-center bg-background">
          <div className="max-w-md text-center space-y-4 px-6">
            <h1 className="text-lg font-semibold text-foreground">
              Something went wrong
            </h1>
            <p className="text-sm text-muted-foreground">
              {this.state.error?.message ?? "An unexpected error occurred."}
            </p>
            <button
              onClick={() => {
                this.setState({ hasError: false, error: null });
                window.location.reload();
              }}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <AppContent />
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
