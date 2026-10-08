import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState, type RefObject } from 'react';
import { toast } from 'sonner';

import {
  addCustomBackgroundUrl,
  importCustomBackgroundFile,
  loadCustomShaderSource,
  removeCustomBackground,
  usesNativeBackgroundPicker,
} from '@/bridge/backgrounds';
import { useDialogNav } from '@/features/menu/hooks/use-dialog-nav';
import { BUILT_IN_BACKGROUND_OPTIONS, selectionKey } from '@/features/playback/components/theme';
import { validateCustomShader } from '@/features/playback/lib/custom-shader';
import { Button } from '@/shared/components/ui/button';
import { ButtonGroup } from '@/shared/components/ui/button-group';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog';
import { Field, FieldDescription, FieldGroup } from '@/shared/components/ui/field';
import { Input } from '@/shared/components/ui/input';
import { Label } from '@/shared/components/ui/label';
import { useConfig } from '@/shared/config/use-config';
import { useConfigMutation } from '@/shared/config/use-config-mutation';
import { CONFIG } from '@/shared/query-keys';
import type { AppConfig } from '@/types/AppConfig';
import type { BackgroundSelection } from '@/types/BackgroundSelection';
import type { CustomBackground } from '@/types/CustomBackground';

import { SettingsSelect } from './settings-controls';

const BACKGROUND_ACCEPT = '.jpg,.jpeg,.png,.webp,.glsl,.frag,.fs,.mp4,.webm';
const SUPPORTED_FORMATS = '.jpg, .jpeg, .png, .webp, .glsl, .frag, .fs, .mp4, .webm';

type BackgroundSourceType = 'upload' | 'url';

type BackgroundOption = {
  value: string;
  label: string;
  description: string;
  selection: BackgroundSelection;
};

type DraftState = {
  sourceType: BackgroundSourceType;
  name: string;
  url: string;
  file: File | undefined;
};

function backgroundOptions(customBackgrounds: readonly CustomBackground[]): BackgroundOption[] {
  return [
    ...BUILT_IN_BACKGROUND_OPTIONS.map((option) => ({
      value: selectionKey(option.selection),
      label: option.label,
      description: 'Built in',
      selection: option.selection,
    })),
    ...customBackgrounds.map((background) => {
      const selection = { kind: 'custom' as const, id: background.id };
      return {
        value: selectionKey(selection),
        label: background.name,
        description: `Custom ${background.background_type}`,
        selection,
      };
    }),
  ];
}

function initialSelection(config: AppConfig, options: readonly BackgroundOption[]): string {
  if (config.last_background !== null) {
    const selected = selectionKey(config.last_background);
    if (options.some((option) => option.value === selected)) {
      return selected;
    }
  }
  return options[config.last_theme ?? 0]?.value ?? options[0].value;
}

function sourceLabel(background: CustomBackground): string {
  return background.source.kind === 'url' ? 'Link' : 'Uploaded file';
}

function truncateShaderError(message: string): string {
  return message.length > 320 ? `${message.slice(0, 317)}…` : message;
}

async function validateAddedShader(
  before: readonly CustomBackground[],
  saved: AppConfig,
  cacheConfig: (config: AppConfig) => void,
): Promise<AppConfig> {
  const previousIds = new Set(before.map((background) => background.id));
  const added = saved.custom_backgrounds.find((background) => !previousIds.has(background.id));
  if (added === undefined || added.background_type !== 'shader') {
    return saved;
  }
  const source = await loadCustomShaderSource(added);
  const error = validateCustomShader(source);
  if (error === undefined) {
    return saved;
  }
  const reverted = await removeCustomBackground(added.id);
  cacheConfig(reverted);
  throw new Error(`Shader did not compile: ${truncateShaderError(error)}`);
}

function canAddBackground(draft: DraftState, busy: boolean): boolean {
  if (busy || draft.name.trim() === '') {
    return false;
  }
  if (draft.sourceType === 'url') {
    return draft.url.trim() !== '';
  }
  return usesNativeBackgroundPicker || draft.file !== undefined;
}

function addButtonLabel(busy: boolean, sourceType: BackgroundSourceType): string {
  if (busy) {
    return 'Adding…';
  }
  if (usesNativeBackgroundPicker && sourceType === 'upload') {
    return 'Choose file';
  }
  return 'Add background';
}

function BackgroundList({
  backgrounds,
  busy,
  pendingRemoval,
  getFocusClassName,
  onRemove,
}: {
  backgrounds: readonly CustomBackground[];
  busy: boolean;
  pendingRemoval: string | null;
  getFocusClassName: (index: number) => string | undefined;
  onRemove: (id: string) => void;
}) {
  if (backgrounds.length === 0) {
    return <p className="text-sm text-muted-foreground">No custom backgrounds yet.</p>;
  }
  return (
    <div className="space-y-2">
      {backgrounds.map((background, index) => (
        <div
          key={background.id}
          className="flex items-center justify-between gap-3 rounded-lg border p-3"
        >
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{background.name}</p>
            <p className="text-xs capitalize text-muted-foreground">
              {background.background_type} · {sourceLabel(background)}
            </p>
          </div>
          <Button
            variant={pendingRemoval === background.id ? 'destructive' : 'outline'}
            size="sm"
            disabled={busy}
            className={getFocusClassName(index)}
            onClick={() => onRemove(background.id)}
          >
            {pendingRemoval === background.id ? 'Confirm remove' : 'Remove'}
          </Button>
        </div>
      ))}
    </div>
  );
}

function BackgroundSourceField({
  draft,
  fileInputRef,
  focusClassName,
  onUrlChange,
  onFileChange,
}: {
  draft: DraftState;
  fileInputRef: RefObject<HTMLInputElement | null>;
  focusClassName?: string;
  onUrlChange: (url: string) => void;
  onFileChange: (file: File | undefined) => void;
}) {
  if (draft.sourceType === 'url') {
    return (
      <Field>
        <Label htmlFor="background-url">HTTPS link</Label>
        <Input
          id="background-url"
          type="url"
          value={draft.url}
          maxLength={2048}
          placeholder="https://example.com/background"
          className={focusClassName}
          onChange={(event) => onUrlChange(event.target.value)}
        />
      </Field>
    );
  }
  if (usesNativeBackgroundPicker) {
    return null;
  }
  return (
    <Field>
      <Label>File</Label>
      <input
        ref={fileInputRef}
        id="background-file"
        type="file"
        accept={BACKGROUND_ACCEPT}
        className="hidden"
        onChange={(event) => onFileChange(event.target.files?.[0])}
      />
      <div className="flex min-w-0 items-center gap-3">
        <Button
          type="button"
          variant="outline"
          className={focusClassName}
          onClick={() => fileInputRef.current?.click()}
        >
          Choose file
        </Button>
        <span className="truncate text-sm text-muted-foreground" aria-live="polite">
          {draft.file?.name ?? 'No file selected'}
        </span>
      </div>
    </Field>
  );
}

function BackgroundDraftFields({
  draft,
  fileInputRef,
  baseFocusIndex,
  getFocusClassName,
  onSourceChange,
  onNameChange,
  onUrlChange,
  onFileChange,
}: {
  draft: DraftState;
  fileInputRef: RefObject<HTMLInputElement | null>;
  baseFocusIndex: number;
  getFocusClassName: (index: number) => string | undefined;
  onSourceChange: (source: BackgroundSourceType) => void;
  onNameChange: (name: string) => void;
  onUrlChange: (url: string) => void;
  onFileChange: (file: File | undefined) => void;
}) {
  return (
    <FieldGroup>
      <Field>
        <Label>Source</Label>
        <ButtonGroup>
          <Button
            variant={draft.sourceType === 'upload' ? 'default' : 'outline'}
            className={getFocusClassName(baseFocusIndex)}
            onClick={() => onSourceChange('upload')}
          >
            Upload
          </Button>
          <Button
            variant={draft.sourceType === 'url' ? 'default' : 'outline'}
            className={getFocusClassName(baseFocusIndex + 1)}
            onClick={() => onSourceChange('url')}
          >
            Link
          </Button>
        </ButtonGroup>
        <FieldDescription>Supported: {SUPPORTED_FORMATS}</FieldDescription>
      </Field>

      <Field>
        <Label htmlFor="background-name">Name</Label>
        <Input
          id="background-name"
          value={draft.name}
          maxLength={80}
          placeholder="My background"
          className={getFocusClassName(baseFocusIndex + 2)}
          onChange={(event) => onNameChange(event.target.value)}
        />
      </Field>

      <BackgroundSourceField
        draft={draft}
        fileInputRef={fileInputRef}
        focusClassName={getFocusClassName(baseFocusIndex + 3)}
        onUrlChange={onUrlChange}
        onFileChange={onFileChange}
      />
    </FieldGroup>
  );
}

function sourceControlCount(draft: DraftState): number {
  return draft.sourceType === 'url' || !usesNativeBackgroundPicker ? 1 : 0;
}

function backgroundManagerStops(backgroundCount: number, draft: DraftState): number[] {
  return [
    ...Array.from({ length: backgroundCount }, () => 1),
    2,
    1,
    ...(sourceControlCount(draft) === 1 ? [1] : []),
    2,
  ];
}

function BackgroundManagerDialog({
  open,
  config,
  onOpenChange,
  cacheConfig,
}: {
  open: boolean;
  config: AppConfig | undefined;
  onOpenChange: (open: boolean) => void;
  cacheConfig: (config: AppConfig) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<DraftState>({
    sourceType: 'upload',
    name: '',
    url: '',
    file: undefined,
  });
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);
  const addMutation = useMutation({
    mutationFn: async (nextDraft: DraftState) => {
      if (config === undefined || nextDraft.name.trim() === '') {
        return undefined;
      }
      const saved =
        nextDraft.sourceType === 'url'
          ? await addCustomBackgroundUrl({ name: nextDraft.name, url: nextDraft.url })
          : await importCustomBackgroundFile({ name: nextDraft.name, file: nextDraft.file });
      if (saved === undefined) {
        return undefined;
      }
      return validateAddedShader(config.custom_backgrounds, saved, cacheConfig);
    },
    onSuccess: (saved) => {
      if (saved === undefined) {
        return;
      }
      cacheConfig(saved);
      setDraft((current) => ({ ...current, name: '', url: '', file: undefined }));
      if (fileInputRef.current !== null) {
        fileInputRef.current.value = '';
      }
      toast.success('Background added');
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : 'Could not add background'),
  });
  const removeMutation = useMutation({
    mutationFn: removeCustomBackground,
    onSuccess: (saved) => {
      cacheConfig(saved);
      setPendingRemoval(null);
      toast.success('Background removed');
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : 'Could not remove background'),
  });
  const backgrounds = config?.custom_backgrounds ?? [];
  const busy = addMutation.isLoading || removeMutation.isLoading;
  const removeBackground = (id: string) => {
    if (pendingRemoval === id) {
      removeMutation.mutate(id);
    } else {
      setPendingRemoval(id);
    }
  };
  const containerRef = useRef<HTMLDivElement>(null);
  const stops = backgroundManagerStops(backgrounds.length, draft);
  const itemCount = stops.reduce((total, count) => total + count, 0);
  const { focusedIndex } = useDialogNav({
    open,
    itemCount,
    stops,
    onBack: () => onOpenChange(false),
    containerRef,
  });
  const getFocusClassName = (index: number) =>
    focusedIndex === index ? 'relative z-10 ring-2 ring-primary' : undefined;
  const draftFocusIndex = backgrounds.length;
  const footerFocusIndex = draftFocusIndex + 3 + sourceControlCount(draft);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ref={containerRef}
        showCloseButton={false}
        className="max-h-[85vh] overflow-y-auto sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>Custom backgrounds</DialogTitle>
          <DialogDescription>
            Add images, Nightingale GLSL shaders, or silent looping videos.
          </DialogDescription>
        </DialogHeader>

        <BackgroundList
          backgrounds={backgrounds}
          busy={busy}
          pendingRemoval={pendingRemoval}
          getFocusClassName={getFocusClassName}
          onRemove={removeBackground}
        />

        <BackgroundDraftFields
          draft={draft}
          fileInputRef={fileInputRef}
          baseFocusIndex={draftFocusIndex}
          getFocusClassName={getFocusClassName}
          onSourceChange={(sourceType) => setDraft((current) => ({ ...current, sourceType }))}
          onNameChange={(name) => setDraft((current) => ({ ...current, name }))}
          onUrlChange={(url) => setDraft((current) => ({ ...current, url }))}
          onFileChange={(file) =>
            setDraft((current) => ({
              ...current,
              file,
              name:
                file !== undefined && current.name === ''
                  ? file.name.replace(/\.[^.]+$/, '')
                  : current.name,
            }))
          }
        />

        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            className={getFocusClassName(footerFocusIndex)}
            onClick={() => onOpenChange(false)}
          >
            Close
          </Button>
          <Button
            disabled={!canAddBackground(draft, busy)}
            className={getFocusClassName(footerFocusIndex + 1)}
            onClick={() => addMutation.mutate(draft)}
          >
            {addButtonLabel(busy, draft.sourceType)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function BackgroundSettings({
  selectClassName,
  manageClassName,
  onDialogOpenChange,
}: {
  selectClassName?: string;
  manageClassName?: string;
  onDialogOpenChange?: (open: boolean) => void;
}) {
  const { data: config } = useConfig();
  const { mutate } = useConfigMutation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const options = useMemo(
    () => backgroundOptions(config?.custom_backgrounds ?? []),
    [config?.custom_backgrounds],
  );
  const selected = config === undefined ? options[0].value : initialSelection(config, options);

  const updateOpen = (next: boolean) => {
    setOpen(next);
    onDialogOpenChange?.(next);
  };
  const cacheConfig = (next: AppConfig) => {
    queryClient.setQueryData(CONFIG, next);
    void queryClient.invalidateQueries({ queryKey: CONFIG });
  };

  return (
    <>
      <Field>
        <Label htmlFor="default-background">Default background</Label>
        <FieldDescription>
          Used when playback starts; press T during playback to cycle
        </FieldDescription>
        <div className="flex flex-col gap-2 sm:flex-row">
          <SettingsSelect
            id="default-background"
            label="Default background"
            placeholder="Select background"
            value={selected}
            options={options}
            triggerClassName={selectClassName}
            onValueChange={(value) => {
              const option = options.find((candidate) => candidate.value === value);
              if (option !== undefined) {
                mutate({ last_background: option.selection });
              }
            }}
          />
          <Button variant="outline" className={manageClassName} onClick={() => updateOpen(true)}>
            Manage
          </Button>
        </div>
      </Field>

      <BackgroundManagerDialog
        open={open}
        config={config}
        onOpenChange={updateOpen}
        cacheConfig={cacheConfig}
      />
    </>
  );
}
