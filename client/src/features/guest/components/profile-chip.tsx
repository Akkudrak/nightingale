import { ChevronDownIcon, UserIcon } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/shared/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog';
import { ScrollArea } from '@/shared/components/ui/scroll-area';
import { Spinner } from '@/shared/components/ui/spinner';
import { cn } from '@/shared/utils/cn';

type ProfileChipProps = {
  name: string;
  knownNames: ReadonlyArray<string>;
  onSwitch: (name: string) => Promise<void>;
  onSignOut: () => void;
};

const RowStatus = ({ isPending, isCurrent }: { isPending: boolean; isCurrent: boolean }) => {
  if (isPending) {
    return <Spinner className="size-3 shrink-0" aria-label="Switching" />;
  }
  if (isCurrent) {
    return (
      <span className="text-[0.65rem] tracking-wide uppercase text-muted-foreground">Current</span>
    );
  }
  return null;
};

export const ProfileChip = ({ name, knownNames, onSwitch, onSignOut }: ProfileChipProps) => {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleOpenChange = (next: boolean): void => {
    setOpen(next);
    if (!next) {
      setPending(null);
      setError(null);
    }
  };

  const handleSelect = async (target: string): Promise<void> => {
    if (target === name) {
      setOpen(false);
      return;
    }
    setError(null);
    setPending(target);
    try {
      await onSwitch(target);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not switch profile.');
    } finally {
      setPending(null);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className="gap-1.5"
        aria-label={`Active profile: ${name}. Switch profile.`}
      >
        <UserIcon aria-hidden="true" />
        <span className="max-w-[8rem] truncate">{name}</span>
        <ChevronDownIcon aria-hidden="true" />
      </Button>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Switch profile</DialogTitle>
            <DialogDescription>
              Currently signed in as <strong>{name}</strong>.
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-72 rounded-md border">
            <ul className="flex flex-col">
              {knownNames.map((candidate) => {
                const isCurrent = candidate === name;
                const isPending = pending === candidate;
                return (
                  <li key={candidate}>
                    <button
                      type="button"
                      onClick={() => void handleSelect(candidate)}
                      disabled={pending !== null}
                      aria-current={isCurrent ? 'true' : undefined}
                      className={cn(
                        'flex w-full items-center justify-between gap-3 border-b px-4 py-3 text-left text-sm transition-colors last:border-b-0',
                        'hover:bg-muted focus-visible:bg-muted focus-visible:outline-none',
                        'disabled:opacity-60',
                        isCurrent && 'font-medium text-foreground',
                      )}
                    >
                      <span className="truncate">{candidate}</span>
                      <RowStatus isPending={isPending} isCurrent={isCurrent} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </ScrollArea>
          {error !== null ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setOpen(false);
                onSignOut();
              }}
              disabled={pending !== null}
            >
              Sign out
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setOpen(false)}
              disabled={pending !== null}
            >
              Cancel
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
};
