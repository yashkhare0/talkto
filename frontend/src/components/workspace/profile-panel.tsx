/** Profile settings sheet — edit name, display name, about, instructions.
 *
 * Opens as a right-side Sheet overlay from the workspace header.
 * Calls PATCH /api/users/me on save.
 */
import { useEffect, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { useMe, useUpdateProfile } from "@/hooks/use-queries";
import {
  UserIcon,
  BookOpen,
  ScrollText,
  Save,
  RotateCcw,
} from "lucide-react";

interface ProfilePanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ProfilePanel({ open, onOpenChange }: ProfilePanelProps) {
  const { data: me } = useMe();
  const updateProfile = useUpdateProfile();

  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [about, setAbout] = useState("");
  const [instructions, setInstructions] = useState("");
  const [saved, setSaved] = useState(false);

  // Sync form state when user data loads or sheet opens
  useEffect(() => {
    if (me && open) {
      setName(me.name);
      setDisplayName(me.display_name ?? "");
      setAbout(me.about ?? "");
      setInstructions(me.agent_instructions ?? "");
      setSaved(false);
    }
  }, [me, open]);

  const hasChanges =
    me &&
    (name !== me.name ||
      displayName !== (me.display_name ?? "") ||
      about !== (me.about ?? "") ||
      instructions !== (me.agent_instructions ?? ""));

  const canSave = name.trim().length > 0 && hasChanges;

  const handleSave = async () => {
    if (!canSave) return;
    try {
      await updateProfile.mutateAsync({
        name: name.trim(),
        display_name: displayName.trim() || undefined,
        about: about.trim() || undefined,
        agent_instructions: instructions.trim() || undefined,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      // Error is available via updateProfile.isError
    }
  };

  const handleReset = () => {
    if (me) {
      setName(me.name);
      setDisplayName(me.display_name ?? "");
      setAbout(me.about ?? "");
      setInstructions(me.agent_instructions ?? "");
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex flex-col overflow-hidden">
        <SheetHeader>
          <SheetTitle className="text-base">Profile Settings</SheetTitle>
          <SheetDescription>
            Changes here update the context injected into every agent's system
            prompt on their next registration.
          </SheetDescription>
        </SheetHeader>

        <Separator className="opacity-50" />

        <div className="flex-1 space-y-6 overflow-y-auto px-4 py-2">
          {/* Identity section */}
          <section className="space-y-4">
            <div className="flex items-center gap-2 text-muted-foreground">
              <UserIcon className="h-4 w-4" />
              <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground">
                Identity
              </h3>
            </div>

            <div className="space-y-2">
              <label
                htmlFor="profile-name"
                className="text-xs font-medium text-muted-foreground"
              >
                Your name
              </label>
              <Input
                id="profile-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                className="h-9 border-border/60 bg-muted/30 text-sm focus-visible:border-foreground/30 focus-visible:ring-foreground/10"
                autoComplete="off"
              />
            </div>

            <div className="space-y-2">
              <label
                htmlFor="profile-display-name"
                className="text-xs font-medium text-muted-foreground"
              >
                Agents should call you
              </label>
              <Input
                id="profile-display-name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="e.g. Boss, Captain, your name"
                className="h-9 border-border/60 bg-muted/30 text-sm focus-visible:border-foreground/30 focus-visible:ring-foreground/10"
                autoComplete="off"
              />
              <p className="text-[11px] text-muted-foreground/40">
                If blank, agents will use your name.
              </p>
            </div>
          </section>

          <Separator className="opacity-30" />

          {/* About section */}
          <section className="space-y-4">
            <div className="flex items-center gap-2 text-muted-foreground">
              <BookOpen className="h-4 w-4" />
              <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground">
                About You
              </h3>
            </div>

            <Textarea
              value={about}
              onChange={(e) => setAbout(e.target.value)}
              placeholder="Your role, expertise, preferences — included in every agent's context"
              className="min-h-[100px] resize-none border-border/60 bg-muted/30 text-sm placeholder:text-muted-foreground/30 focus-visible:border-foreground/30 focus-visible:ring-foreground/10"
            />
          </section>

          <Separator className="opacity-30" />

          {/* Standing instructions section */}
          <section className="space-y-4">
            <div className="flex items-center gap-2 text-muted-foreground">
              <ScrollText className="h-4 w-4" />
              <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground">
                Standing Instructions
              </h3>
            </div>

            <Textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="Rules ALL agents must follow (e.g. always write tests, use conventional commits)"
              className="min-h-[100px] resize-none border-border/60 bg-muted/30 text-sm placeholder:text-muted-foreground/30 focus-visible:border-foreground/30 focus-visible:ring-foreground/10"
            />
          </section>
        </div>

        <Separator className="opacity-50" />

        {/* Footer actions */}
        <div className="flex items-center gap-2 px-4 pb-4 pt-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleReset}
            disabled={!hasChanges || updateProfile.isPending}
            className="gap-1.5 text-xs text-muted-foreground"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset
          </Button>

          <div className="flex-1" />

          {updateProfile.isError && (
            <span className="text-xs text-destructive">Save failed</span>
          )}

          {saved && (
            <span className="text-xs text-emerald-500">Saved</span>
          )}

          <Button
            size="sm"
            onClick={handleSave}
            disabled={!canSave || updateProfile.isPending}
            className="gap-1.5 text-xs"
          >
            {updateProfile.isPending ? (
              <span className="animate-pulse">Saving...</span>
            ) : (
              <>
                <Save className="h-3.5 w-3.5" />
                Save Changes
              </>
            )}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
