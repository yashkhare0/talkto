/** Workspace settings panel -- Sheet overlay for managing members, API keys, and invites. */
import { useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAppStore } from "@/stores/app-store";
import {
  useMembers,
  useRemoveMember,
  useApiKeys,
  useCreateApiKey,
  useRevokeApiKey,
  useInvites,
  useCreateInvite,
  useRevokeInvite,
} from "@/hooks/use-queries";
import {
  Users,
  KeyRound,
  Link2,
  Plus,
  Trash2,
  Copy,
  Check,
  AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ApiKey, ApiKeyCreated, Invite, WorkspaceMember } from "@/lib/types";

interface WorkspaceSettingsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function WorkspaceSettings({ open, onOpenChange }: WorkspaceSettingsProps) {
  const workspaceId = useAppStore((s) => s.activeWorkspaceId);
  const role = useAppStore((s) => s.authInfo?.role);
  const isAdmin = role === "admin";

  const { data: members } = useMembers(workspaceId);
  const { data: apiKeys } = useApiKeys(workspaceId);
  const { data: invites } = useInvites(workspaceId);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex flex-col overflow-hidden">
        <SheetHeader>
          <SheetTitle className="text-base">Workspace Settings</SheetTitle>
          <SheetDescription>
            Manage members, API keys, and invite links.
          </SheetDescription>
        </SheetHeader>

        <Separator className="opacity-50" />

        <ScrollArea className="flex-1 overflow-hidden">
          <div className="space-y-6 p-4">
            {/* Members */}
            <MembersSection
              members={members ?? []}
              workspaceId={workspaceId}
              isAdmin={isAdmin}
            />

            <Separator className="opacity-30" />

            {/* API Keys */}
            <ApiKeysSection
              apiKeys={apiKeys ?? []}
              workspaceId={workspaceId}
              isAdmin={isAdmin}
            />

            <Separator className="opacity-30" />

            {/* Invites */}
            <InvitesSection
              invites={invites ?? []}
              workspaceId={workspaceId}
              isAdmin={isAdmin}
            />
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

// ── Members Section ─────────────────────────────────────

function MembersSection({
  members,
  workspaceId,
  isAdmin,
}: {
  members: WorkspaceMember[];
  workspaceId: string | null;
  isAdmin: boolean;
}) {
  const removeMember = useRemoveMember();
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Users className="h-4 w-4" />
        <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground">
          Members
        </h3>
        <Badge variant="secondary" className="ml-auto text-[10px]">
          {members.length}
        </Badge>
      </div>

      <div className="space-y-1">
        {members.map((member) => (
          <MemberRow
            key={member.user_id}
            member={member}
            isAdmin={isAdmin}
            onRemove={
              isAdmin && workspaceId
                ? () => removeMember.mutate({ workspaceId, userId: member.user_id })
                : undefined
            }
          />
        ))}

        {members.length === 0 && (
          <p className="py-4 text-center text-xs text-muted-foreground/50">
            No members found.
          </p>
        )}
      </div>
    </section>
  );
}

function MemberRow({
  member,
  isAdmin,
  onRemove,
}: {
  member: WorkspaceMember;
  isAdmin: boolean;
  onRemove?: () => void;
}) {
  const initial = (member.display_name ?? member.user_name)?.[0]?.toUpperCase() ?? "?";
  const displayName = member.display_name ?? member.user_name;

  return (
    <div className="group flex items-center gap-2 rounded-md border border-border/30 bg-card/50 px-3 py-2 transition-colors hover:border-border/60">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
        {initial}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-foreground">
          {displayName}
        </p>
        <p className="text-[10px] text-muted-foreground/60">
          {member.user_type}
        </p>
      </div>
      <Badge
        variant="secondary"
        className={cn(
          "text-[10px]",
          member.role === "admin"
            ? "bg-talkto-warning/10 text-talkto-warning"
            : "bg-muted text-muted-foreground",
        )}
      >
        {member.role}
      </Badge>
      {isAdmin && member.role !== "admin" && onRemove && (
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-muted-foreground/40 opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
          title="Remove member"
          onClick={onRemove}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}

// ── API Keys Section ────────────────────────────────────

function ApiKeysSection({
  apiKeys,
  workspaceId,
  isAdmin,
}: {
  apiKeys: ApiKey[];
  workspaceId: string | null;
  isAdmin: boolean;
}) {
  const [showForm, setShowForm] = useState(false);
  const [newKey, setNewKey] = useState<ApiKeyCreated | null>(null);

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 text-muted-foreground">
        <KeyRound className="h-4 w-4" />
        <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground">
          API Keys
        </h3>
        <Badge variant="secondary" className="ml-auto text-[10px]">
          {apiKeys.filter((k) => !k.revoked_at).length}
        </Badge>
      </div>

      {/* Newly created key -- shown only once */}
      {newKey && (
        <NewKeyBanner rawKey={newKey.raw_key} onDismiss={() => setNewKey(null)} />
      )}

      {/* Create form */}
      {isAdmin && !showForm && !newKey && (
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 text-xs text-muted-foreground"
          onClick={() => setShowForm(true)}
        >
          <Plus className="h-3.5 w-3.5" />
          Create Key
        </Button>
      )}

      {showForm && workspaceId && (
        <CreateApiKeyForm
          workspaceId={workspaceId}
          onCreated={(key) => {
            setNewKey(key);
            setShowForm(false);
          }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {/* Key list */}
      <div className="space-y-1">
        {apiKeys
          .filter((k) => !k.revoked_at)
          .map((key) => (
            <ApiKeyRow key={key.id} apiKey={key} workspaceId={workspaceId} isAdmin={isAdmin} />
          ))}

        {apiKeys.filter((k) => !k.revoked_at).length === 0 && !newKey && (
          <p className="py-4 text-center text-xs text-muted-foreground/50">
            No active API keys.
          </p>
        )}
      </div>
    </section>
  );
}

function NewKeyBanner({ rawKey, onDismiss }: { rawKey: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(rawKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="rounded-md border border-talkto-warning/30 bg-talkto-warning/5 p-3 space-y-2">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-talkto-warning" />
        <p className="text-[11px] text-talkto-warning">
          Copy this key now. It will not be shown again.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <code className="flex-1 truncate rounded bg-muted px-2 py-1 text-[11px] font-mono text-foreground">
          {rawKey}
        </code>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={handleCopy}
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-talkto-success" />
          ) : (
            <Copy className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </Button>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 text-[10px] text-muted-foreground"
        onClick={onDismiss}
      >
        Dismiss
      </Button>
    </div>
  );
}

function CreateApiKeyForm({
  workspaceId,
  onCreated,
  onCancel,
}: {
  workspaceId: string;
  onCreated: (key: ApiKeyCreated) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const createKey = useCreateApiKey();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const result = await createKey.mutateAsync({
        workspaceId,
        data: { name: name.trim() || undefined },
      });
      onCreated(result);
    } catch {
      // Error shown via mutation state
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <Input
        placeholder="Key name (optional)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="h-8 text-xs"
        autoFocus
      />
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          className="h-7 text-xs"
          disabled={createKey.isPending}
        >
          {createKey.isPending ? "Creating..." : "Create"}
        </Button>
      </div>
    </form>
  );
}

function ApiKeyRow({
  apiKey,
  workspaceId,
  isAdmin,
}: {
  apiKey: ApiKey;
  workspaceId: string | null;
  isAdmin: boolean;
}) {
  const revokeKey = useRevokeApiKey();
  const createdDate = new Date(apiKey.created_at).toLocaleDateString();

  return (
    <div className="group flex items-center gap-2 rounded-md border border-border/30 bg-card/50 px-3 py-2 transition-colors hover:border-border/60">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <code className="text-[11px] font-mono text-foreground">
            {apiKey.key_prefix}...
          </code>
          {apiKey.name && (
            <span className="truncate text-[11px] text-muted-foreground/70">
              {apiKey.name}
            </span>
          )}
        </div>
        <p className="text-[10px] text-muted-foreground/50">
          Created {createdDate}
          {apiKey.expires_at && (
            <> -- expires {new Date(apiKey.expires_at).toLocaleDateString()}</>
          )}
        </p>
      </div>
      {isAdmin && workspaceId && (
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-muted-foreground/40 opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
          title="Revoke key"
          disabled={revokeKey.isPending}
          onClick={() =>
            revokeKey.mutate({ workspaceId, keyId: apiKey.id })
          }
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}

// ── Invites Section ─────────────────────────────────────

function InvitesSection({
  invites,
  workspaceId,
  isAdmin,
}: {
  invites: Invite[];
  workspaceId: string | null;
  isAdmin: boolean;
}) {
  const [showForm, setShowForm] = useState(false);

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Link2 className="h-4 w-4" />
        <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground">
          Invite Links
        </h3>
        <Badge variant="secondary" className="ml-auto text-[10px]">
          {invites.filter((i) => !i.revoked_at).length}
        </Badge>
      </div>

      {isAdmin && !showForm && (
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 text-xs text-muted-foreground"
          onClick={() => setShowForm(true)}
        >
          <Plus className="h-3.5 w-3.5" />
          Create Invite
        </Button>
      )}

      {showForm && workspaceId && (
        <CreateInviteForm
          workspaceId={workspaceId}
          onCreated={() => setShowForm(false)}
          onCancel={() => setShowForm(false)}
        />
      )}

      <div className="space-y-1">
        {invites
          .filter((i) => !i.revoked_at)
          .map((invite) => (
            <InviteRow
              key={invite.id}
              invite={invite}
              workspaceId={workspaceId}
              isAdmin={isAdmin}
            />
          ))}

        {invites.filter((i) => !i.revoked_at).length === 0 && (
          <p className="py-4 text-center text-xs text-muted-foreground/50">
            No active invites.
          </p>
        )}
      </div>
    </section>
  );
}

function CreateInviteForm({
  workspaceId,
  onCreated,
  onCancel,
}: {
  workspaceId: string;
  onCreated: () => void;
  onCancel: () => void;
}) {
  const createInvite = useCreateInvite();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await createInvite.mutateAsync({ workspaceId });
      onCreated();
    } catch {
      // Error shown via mutation state
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex justify-end gap-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 text-xs"
        onClick={onCancel}
      >
        Cancel
      </Button>
      <Button
        type="submit"
        size="sm"
        className="h-7 text-xs"
        disabled={createInvite.isPending}
      >
        {createInvite.isPending ? "Creating..." : "Create"}
      </Button>
    </form>
  );
}

function InviteRow({
  invite,
  workspaceId,
  isAdmin,
}: {
  invite: Invite;
  workspaceId: string | null;
  isAdmin: boolean;
}) {
  const revokeInvite = useRevokeInvite();
  const [copied, setCopied] = useState(false);

  const inviteUrl =
    invite.invite_url ?? `${window.location.origin}/join/${invite.token}`;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(inviteUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="group rounded-md border border-border/30 bg-card/50 px-3 py-2 transition-colors hover:border-border/60">
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate text-[11px] font-mono text-foreground">
          {inviteUrl}
        </code>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
          title="Copy invite URL"
          onClick={handleCopy}
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-talkto-success" />
          ) : (
            <Copy className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </Button>
        {isAdmin && workspaceId && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0 text-muted-foreground/40 opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
            title="Revoke invite"
            disabled={revokeInvite.isPending}
            onClick={() =>
              revokeInvite.mutate({ workspaceId, inviteId: invite.id })
            }
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      <div className="mt-1 flex items-center gap-3 text-[10px] text-muted-foreground/50">
        <span>
          {invite.use_count}{invite.max_uses != null ? `/${invite.max_uses}` : ""} uses
        </span>
        <span>Role: {invite.role}</span>
        {invite.expires_at && (
          <span>Expires {new Date(invite.expires_at).toLocaleDateString()}</span>
        )}
      </div>
    </div>
  );
}
