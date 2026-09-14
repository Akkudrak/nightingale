import { UserPlusIcon, UsersIcon } from 'lucide-react';
import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react';

import { Button } from '@/shared/components/ui/button';
import { Field, FieldGroup } from '@/shared/components/ui/field';
import { Input } from '@/shared/components/ui/input';
import { Label } from '@/shared/components/ui/label';
import { ScrollArea } from '@/shared/components/ui/scroll-area';
import { Spinner } from '@/shared/components/ui/spinner';
import { cn } from '@/shared/utils/cn';

type ProfileGateProps = {
  knownNames: ReadonlyArray<string>;
  hasResolved: boolean;
  loadError: Error | null;
  onSelect: (name: string) => Promise<void>;
  onCreate: (name: string) => Promise<void>;
  onRetry: () => void;
};

type CreateFormProps = {
  pendingName: string | null;
  onCancel: () => void;
  onSubmit: (name: string) => Promise<void>;
};

const CreateForm = ({ pendingName, onCancel, onSubmit }: CreateFormProps) => {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const trimmed = draft.trim();
  const submitting = pendingName !== null;

  // Move focus to the input on mount so the user can type right after
  // pressing Create new profile; deferred through an effect to match the
  // no-autofocus accessibility rule.
  useEffect(() => {
    document.getElementById('guest-profile-name')?.focus();
  }, []);

  const submit = async (): Promise<void> => {
    if (trimmed === '') {
      return;
    }
    setError(null);
    try {
      await onSubmit(trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create profile.');
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <FieldGroup>
        <Field>
          <Label htmlFor="guest-profile-name">Profile name</Label>
          <Input
            id="guest-profile-name"
            name="guestProfileName"
            autoComplete="off"
            value={draft}
            onChange={({ target }) => setDraft(target.value)}
            onKeyDown={handleKeyDown}
            disabled={submitting}
            aria-invalid={error !== null}
            aria-describedby={error !== null ? 'guest-profile-error' : undefined}
          />
          {error !== null ? (
            <p id="guest-profile-error" role="alert" className="mt-1 text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </Field>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={submitting || trimmed === ''}>
            {submitting ? <Spinner className="size-3" /> : 'Create'}
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
};

const ProfileList = ({
  knownNames,
  pendingName,
  onSelect,
}: {
  knownNames: ReadonlyArray<string>;
  pendingName: string | null;
  onSelect: (name: string) => Promise<void>;
}) => {
  if (knownNames.length === 0) {
    return (
      <p className="px-4 py-6 text-center text-xs text-muted-foreground">
        No profiles yet. Create one to get started.
      </p>
    );
  }

  return (
    <ul className="flex flex-col">
      {knownNames.map((name) => {
        const pending = pendingName === name;
        return (
          <li key={name}>
            <button
              type="button"
              onClick={() => void onSelect(name)}
              disabled={pendingName !== null}
              className={cn(
                'flex w-full items-center justify-between gap-3 border-b px-4 py-3 text-left text-sm transition-colors last:border-b-0',
                'hover:bg-muted focus-visible:bg-muted focus-visible:outline-none',
                'disabled:opacity-60',
              )}
            >
              <span className="truncate">{name}</span>
              {pending ? <Spinner className="size-3 shrink-0" aria-label="Selecting" /> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
};

export const ProfileGate = ({
  knownNames,
  hasResolved,
  loadError,
  onSelect,
  onCreate,
  onRetry,
}: ProfileGateProps) => {
  const [creating, setCreating] = useState(false);
  const [pendingName, setPendingName] = useState<string | null>(null);
  const [selectError, setSelectError] = useState<string | null>(null);

  const handleSelect = async (name: string): Promise<void> => {
    setSelectError(null);
    setPendingName(name);
    try {
      await onSelect(name);
    } catch (err) {
      setSelectError(err instanceof Error ? err.message : 'Could not switch profile.');
      setPendingName(null);
    }
  };

  const handleCreate = async (name: string): Promise<void> => {
    setSelectError(null);
    setPendingName(name);
    try {
      await onCreate(name);
    } catch (err) {
      setSelectError(err instanceof Error ? err.message : 'Could not create profile.');
      setPendingName(name);
      throw err;
    }
  };

  if (!hasResolved) {
    return (
      <main
        aria-busy="true"
        className="flex h-dvh w-full items-center justify-center bg-background text-foreground"
      >
        <Spinner className="size-5 text-muted-foreground" />
      </main>
    );
  }

  if (loadError !== null) {
    return (
      <main className="flex h-dvh w-full flex-col items-center justify-center gap-3 bg-background px-6 text-center text-foreground">
        <UsersIcon className="size-6 text-muted-foreground" aria-hidden="true" />
        <p className="text-sm">Could not load profiles.</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </main>
    );
  }

  return (
    <main className="flex h-dvh w-full flex-col bg-background text-foreground">
      <header className="flex items-center justify-center gap-2 border-b px-4 py-3">
        <UsersIcon className="size-4 text-muted-foreground" aria-hidden="true" />
        <h1 className="text-sm font-medium">Pick a profile to continue</h1>
      </header>
      <section className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 overflow-y-auto px-6 py-8">
        {creating ? (
          <CreateForm
            pendingName={pendingName}
            onCancel={() => {
              setCreating(false);
              setPendingName(null);
            }}
            onSubmit={handleCreate}
          />
        ) : (
          <>
            <ScrollArea className="max-h-72 rounded-md border">
              <ProfileList
                knownNames={knownNames}
                pendingName={pendingName}
                onSelect={handleSelect}
              />
            </ScrollArea>
            <Button
              type="button"
              variant="default"
              size="sm"
              className="self-center"
              onClick={() => {
                setSelectError(null);
                setCreating(true);
              }}
              disabled={pendingName !== null}
            >
              <UserPlusIcon aria-hidden="true" />
              Create new profile
            </Button>
            {selectError !== null ? (
              <p role="alert" className="text-center text-xs text-destructive">
                {selectError}
              </p>
            ) : null}
          </>
        )}
      </section>
    </main>
  );
};
