import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Onboarding } from "@/components/onboarding";
import { WorkspaceLayout } from "@/components/workspace/workspace-layout";
import { MessageFeed } from "@/components/workspace/message-feed";
import { useAppStore } from "@/stores/app-store";
import { useMe } from "@/hooks/use-queries";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

/** Inner app content that uses hooks. */
function AppContent() {
  const isOnboarded = useAppStore((s) => s.isOnboarded);
  const { data: me, isLoading, isError } = useMe();

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

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AppContent />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
