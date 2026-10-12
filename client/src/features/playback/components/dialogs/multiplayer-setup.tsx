import { useAtom } from 'jotai';
import { PlusIcon, UsersIcon, XIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { PlaybackPlayer } from '@/bridge/playback-session';
import { playbackPlayersSchema } from '@/bridge/schemas';
import { useDialogNav } from '@/features/menu/hooks/use-dialog-nav';
import { useMicDevicesQuery, type MicDevice } from '@/features/microphone/queries/use-mic-devices';
import { multiplayerPlayersAtom } from '@/features/playback/atoms/multiplayer-players';
import { useProfiles } from '@/features/profiles/queries/use-profiles';
import { Button } from '@/shared/components/ui/button';
import { Checkbox } from '@/shared/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog';
import { Field } from '@/shared/components/ui/field';
import { Label } from '@/shared/components/ui/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/shared/components/ui/select';
import { useConfig } from '@/shared/config/use-config';
import { useConfigMutation } from '@/shared/config/use-config-mutation';
import { cn } from '@/shared/utils/cn';
import type { AppConfig } from '@/types/AppConfig';

const MAX_PLAYERS = 4;
const RING = 'ring-2 ring-primary';
const NO_FOCUS_RING = 'focus-visible:ring-0 focus-visible:border-transparent';
const PROFILE_PREFIX = 'profile:';
const GUEST_VALUE = 'guest';
const PLAYER_COLORS = ['bg-rose-400', 'bg-fuchsia-400', 'bg-amber-400', 'bg-emerald-400'];

type MultiplayerSetupDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStart: (players: PlaybackPlayer[]) => void;
  queuePlayback?: boolean;
  submitLabel?: string;
};

const playerNumber = (id: string): number => Number(id.slice('player-'.length));

const profileValue = (profile: string | null): string =>
  profile === null ? GUEST_VALUE : `${PROFILE_PREFIX}${profile}`;

const parseProfile = (value: string): string | null =>
  value.startsWith(PROFILE_PREFIX) ? value.slice(PROFILE_PREFIX.length) : null;

function defaultPlayers(
  activeProfile: string | null,
  microphoneIds: readonly string[],
): PlaybackPlayer[] {
  return [0, 1].map((index) => ({
    id: `player-${index + 1}`,
    profile: index === 0 ? activeProfile : null,
    microphoneId: microphoneIds[index] ?? '',
  }));
}

type InitialPlayersInput = {
  activeProfile: string | null;
  profiles: readonly string[];
  microphones: readonly MicDevice[];
  preferredMicrophone: string | null;
  rememberedPlayers: readonly PlaybackPlayer[] | null;
};

function orderedMicrophoneIds(
  microphones: readonly MicDevice[],
  preferred: string | null,
): string[] {
  const preferredDevice = microphones.find(
    (microphone) =>
      microphone.deviceId === preferred ||
      microphone.name === preferred ||
      microphone.label === preferred,
  );
  const ids = microphones.map((microphone) => microphone.deviceId);
  if (preferredDevice === undefined) {
    return ids;
  }
  return [preferredDevice.deviceId, ...ids.filter((id) => id !== preferredDevice.deviceId)];
}

function initialPlayers(input: InitialPlayersInput): PlaybackPlayer[] {
  const microphoneIds = orderedMicrophoneIds(input.microphones, input.preferredMicrophone);
  const remembered = input.rememberedPlayers;
  if (remembered === null) {
    return defaultPlayers(input.activeProfile, microphoneIds);
  }

  const availableProfiles = new Set(input.profiles);
  const usedMicrophones = new Set<string>();
  return remembered.map((player, index) => {
    const rememberedMicrophoneAvailable =
      player.microphoneId !== '' && !usedMicrophones.has(player.microphoneId);
    const microphoneId = rememberedMicrophoneAvailable
      ? player.microphoneId
      : (microphoneIds.find((id) => !usedMicrophones.has(id)) ?? '');
    if (microphoneId !== '') {
      usedMicrophones.add(microphoneId);
    }
    return {
      id: `player-${index + 1}`,
      profile:
        player.profile !== null && availableProfiles.has(player.profile) ? player.profile : null,
      microphoneId,
    };
  });
}

const setupDataLoading = (...states: boolean[]): boolean => states.some(Boolean);

type SetupErrorInput = {
  microphonesError: boolean;
  microphoneCount: number;
  duplicateMicrophone: boolean;
  duplicateProfile: boolean;
  validMicrophones: boolean;
};

const setupDescription = (queuePlayback: boolean | undefined): string =>
  queuePlayback === true
    ? 'Choose one microphone per singer. This lineup stays active for every queued song.'
    : 'Choose one microphone per singer.';

const setupSubmitLabel = (label: string | undefined): string => label ?? 'Start multiplayer';

const combineMultiplayerChannels = (config: AppConfig | undefined): boolean =>
  config?.multiplayer_combine_multi_channel ?? true;

const capabilityDevices = (
  combineChannels: boolean,
  microphones: readonly MicDevice[],
  combinedMicrophones: readonly MicDevice[],
): readonly MicDevice[] => (combineChannels ? microphones : combinedMicrophones);

const shouldLoadCombinedCapabilities = (open: boolean, combineChannels: boolean): boolean =>
  open && !combineChannels;

function setupError(input: SetupErrorInput): string | null {
  if (input.microphonesError) {
    return 'Could not load microphones. Check microphone permission and try again.';
  }
  if (input.microphoneCount < 2) {
    return 'Connect at least two microphones to start multiplayer.';
  }
  if (input.duplicateMicrophone) {
    return 'Each player needs a different microphone.';
  }
  if (input.duplicateProfile) {
    return 'A saved profile can only be used once.';
  }
  if (!input.validMicrophones) {
    return 'Select a connected microphone for every player.';
  }
  return null;
}

type PlayerSetupStatus = {
  selectedMicrophones: Set<string>;
  duplicateProfile: boolean;
  duplicateMicrophone: boolean;
  validMicrophones: boolean;
  canStart: boolean;
};

function playerSetupStatus(
  players: readonly PlaybackPlayer[],
  microphones: readonly MicDevice[],
  loading: boolean,
): PlayerSetupStatus {
  const selectedProfiles = new Set(
    players.flatMap((player) => (player.profile === null ? [] : [player.profile])),
  );
  const selectedMicrophones = new Set(
    players.map((player) => player.microphoneId).filter((id) => id !== ''),
  );
  const duplicateProfile =
    selectedProfiles.size !== players.filter((player) => player.profile !== null).length;
  const validMicrophones = players.every(
    (player) =>
      player.microphoneId !== '' &&
      microphones.some((microphone) => microphone.deviceId === player.microphoneId),
  );
  const duplicateMicrophone = selectedMicrophones.size !== players.length;
  const canStart =
    players.length >= 2 &&
    !loading &&
    !duplicateProfile &&
    !duplicateMicrophone &&
    validMicrophones;
  return {
    selectedMicrophones,
    duplicateProfile,
    duplicateMicrophone,
    validMicrophones,
    canStart,
  };
}

const setupStops = (
  players: readonly PlaybackPlayer[],
  canAdd: boolean,
  canStart: boolean,
  hasMultiChannelInput: boolean,
) => [
  ...(hasMultiChannelInput ? [1] : []),
  ...players.map((_, index) => (index >= 2 ? 3 : 2)),
  ...(canAdd ? [1] : []),
  canStart ? 2 : 1,
];

type PlayerRowsProps = {
  players: PlaybackPlayer[];
  profiles: readonly string[];
  microphones: readonly MicDevice[];
  updatePlayer: (id: string, patch: Partial<PlaybackPlayer>) => void;
  removePlayer: (id: string) => void;
  segmentOffset: number;
  navClass: (segment: number, slot?: number) => string;
  focusSegment: (segment: number, slot?: number) => void;
};

const playerNavSlots = (index: number) =>
  index >= 2 ? { profile: 1, microphone: 2 } : { profile: 0, microphone: 1 };

function updatedPlayers(
  players: readonly PlaybackPlayer[],
  id: string,
  patch: Partial<PlaybackPlayer>,
): PlaybackPlayer[] {
  const key = patch.microphoneId !== undefined ? 'microphoneId' : 'profile';
  const player = players.find((candidate) => candidate.id === id);
  if (player === undefined || patch[key] === undefined || patch[key] === null) {
    return players.map((candidate) =>
      candidate.id === id ? { ...candidate, ...patch } : candidate,
    );
  }
  return players.map((candidate) => {
    if (candidate.id === id) {
      return { ...candidate, ...patch };
    }
    return candidate[key] === patch[key] ? { ...candidate, [key]: player[key] } : candidate;
  });
}

function PlayerRows({
  players,
  profiles,
  microphones,
  updatePlayer,
  removePlayer,
  segmentOffset,
  navClass,
  focusSegment,
}: PlayerRowsProps) {
  return players.map((player, index) => {
    const slots = playerNavSlots(index);
    const segment = index + segmentOffset;
    return (
      <div
        key={player.id}
        className="grid gap-3 px-1 py-3 sm:grid-cols-[7rem_minmax(0,0.8fr)_minmax(0,1.2fr)] sm:items-end"
      >
        <div className="flex h-7 items-center gap-2">
          <span
            className={`size-2.5 rounded-full ${PLAYER_COLORS[playerNumber(player.id) - 1]}`}
            aria-hidden="true"
          />
          <h3 className="text-sm font-semibold">Player {index + 1}</h3>
          {index >= 2 ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className={navClass(segment, 0)}
              onFocus={() => focusSegment(segment, 0)}
              onMouseEnter={() => focusSegment(segment, 0)}
              onClick={() => removePlayer(player.id)}
              aria-label={`Remove player ${index + 1}`}
            >
              <XIcon />
            </Button>
          ) : null}
        </div>

        <Field className="min-w-0">
          <Label htmlFor={`${player.id}-profile`} className="sm:sr-only">
            Profile
          </Label>
          <Select
            value={profileValue(player.profile)}
            onValueChange={(value) => updatePlayer(player.id, { profile: parseProfile(value) })}
          >
            <SelectTrigger
              id={`${player.id}-profile`}
              className={cn(
                'w-full min-w-0 overflow-hidden [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:truncate',
                navClass(segment, slots.profile),
              )}
              onFocus={() => focusSegment(segment, slots.profile)}
              onMouseEnter={() => focusSegment(segment, slots.profile)}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Profile</SelectLabel>
                <SelectItem value={GUEST_VALUE}>Guest</SelectItem>
                {profiles.map((profile) => (
                  <SelectItem key={profile} value={`${PROFILE_PREFIX}${profile}`}>
                    {profile}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>

        <Field className="min-w-0">
          <Label htmlFor={`${player.id}-microphone`} className="sm:sr-only">
            Microphone
          </Label>
          <Select
            value={player.microphoneId || undefined}
            onValueChange={(microphoneId) => updatePlayer(player.id, { microphoneId })}
          >
            <SelectTrigger
              id={`${player.id}-microphone`}
              className={cn(
                'w-full min-w-0 overflow-hidden [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:truncate',
                navClass(segment, slots.microphone),
              )}
              onFocus={() => focusSegment(segment, slots.microphone)}
              onMouseEnter={() => focusSegment(segment, slots.microphone)}
            >
              <SelectValue placeholder="Select microphone" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Microphone</SelectLabel>
                {microphones.map((microphone) => (
                  <SelectItem key={microphone.deviceId} value={microphone.deviceId}>
                    {microphone.label}
                  </SelectItem>
                ))}
                {player.microphoneId !== '' &&
                  !microphones.some(
                    (microphone) => microphone.deviceId === player.microphoneId,
                  ) && (
                    <SelectItem value={player.microphoneId}>
                      Selected microphone: {player.microphoneId}
                    </SelectItem>
                  )}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      </div>
    );
  });
}

type CombineChannelsFieldProps = {
  available: boolean;
  checked: boolean;
  className: string;
  onFocus: () => void;
  onCheckedChange: (checked: boolean) => void;
};

function CombineChannelsField({
  available,
  checked,
  className,
  onFocus,
  onCheckedChange,
}: CombineChannelsFieldProps) {
  if (!available) {
    return null;
  }

  return (
    <Label className="gap-1.5 text-sm font-normal text-muted-foreground">
      <Checkbox
        checked={checked}
        className={className}
        onFocus={onFocus}
        onMouseEnter={onFocus}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      Combine multi-channel
    </Label>
  );
}

export function MultiplayerSetupDialog({
  open,
  onOpenChange,
  onStart,
  queuePlayback,
  submitLabel,
}: MultiplayerSetupDialogProps) {
  const { data: profileStore, isLoading: profilesLoading } = useProfiles();
  const { data: config, isLoading: configLoading } = useConfig();
  const { mutate: saveConfig } = useConfigMutation();
  const combineChannels = combineMultiplayerChannels(config);
  const microphones = useMicDevicesQuery(undefined, open, combineChannels);
  const capabilityQuery = useMicDevicesQuery(
    undefined,
    shouldLoadCombinedCapabilities(open, combineChannels),
    true,
  );
  const hasMultiChannelInput = capabilityDevices(
    combineChannels,
    microphones.data,
    capabilityQuery.data,
  ).some((device) => device.channelCount > 1);
  const [rememberedPlayers, setRememberedPlayers] = useAtom(multiplayerPlayersAtom);
  const [players, setPlayers] = useState<PlaybackPlayer[]>([]);
  const initialized = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      initialized.current = false;
      return;
    }
    const loading = setupDataLoading(profilesLoading, configLoading, microphones.isLoading);
    if (initialized.current || loading) {
      return;
    }
    initialized.current = true;
    setPlayers(
      initialPlayers({
        activeProfile: profileStore?.active ?? null,
        profiles: profileStore?.profiles ?? [],
        microphones: microphones.data,
        preferredMicrophone: config?.preferred_mic ?? null,
        rememberedPlayers,
      }),
    );
  }, [
    config?.preferred_mic,
    configLoading,
    microphones.data,
    microphones.isLoading,
    open,
    profileStore?.active,
    profileStore?.profiles,
    profilesLoading,
    rememberedPlayers,
  ]);

  const loading = setupDataLoading(profilesLoading, configLoading, microphones.isLoading);
  const { selectedMicrophones, duplicateProfile, duplicateMicrophone, validMicrophones, canStart } =
    useMemo(
      () => playerSetupStatus(players, microphones.data, loading),
      [loading, microphones.data, players],
    );
  const canAddPlayer = players.length < MAX_PLAYERS;
  const playerSegmentOffset = Number(hasMultiChannelInput);
  const addPlayerSegment = playerSegmentOffset + players.length;
  const footerSegment = addPlayerSegment + (canAddPlayer ? 1 : 0);
  const stops = useMemo(
    () => setupStops(players, canAddPlayer, canStart, hasMultiChannelInput),
    [canAddPlayer, canStart, hasMultiChannelInput, players],
  );
  const closeDialog = () => onOpenChange(false);
  const { isFocused, focusSegment } = useDialogNav({
    open,
    itemCount: stops.reduce((total, count) => total + count, 0),
    stops,
    containerRef,
    onBack: closeDialog,
  });
  const navClass = (segment: number, slot = 0): string =>
    cn(NO_FOCUS_RING, isFocused(segment, slot) && RING);

  useEffect(() => {
    if (!open || !initialized.current || !playbackPlayersSchema.safeParse(players).success) {
      return;
    }
    if (players === rememberedPlayers) {
      return;
    }
    setRememberedPlayers(players);
    saveConfig({ multiplayer_players: players });
  }, [open, players, rememberedPlayers, saveConfig, setRememberedPlayers]);

  const updatePlayer = (id: string, patch: Partial<PlaybackPlayer>) => {
    setPlayers((current) => updatedPlayers(current, id, patch));
  };

  const addPlayer = () => {
    const usedIds = new Set(players.map((player) => player.id));
    const nextNumber = [1, 2, 3, 4].find((number) => !usedIds.has(`player-${number}`));
    const nextMicrophone = microphones.data.find(
      (microphone) => !selectedMicrophones.has(microphone.deviceId),
    );
    if (nextNumber === undefined) {
      return;
    }
    setPlayers((current) =>
      [
        ...current,
        {
          id: `player-${nextNumber}`,
          profile: null,
          microphoneId: nextMicrophone?.deviceId ?? '',
        },
      ].toSorted((left, right) => playerNumber(left.id) - playerNumber(right.id)),
    );
  };

  const removePlayer = (id: string) => {
    setPlayers((current) => current.filter((player) => player.id !== id));
  };

  const error = setupError({
    microphonesError: microphones.isError,
    microphoneCount: microphones.data.length,
    duplicateMicrophone,
    duplicateProfile,
    validMicrophones,
  });

  const startMultiplayer = () => {
    onStart(players);
    closeDialog();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ref={containerRef}
        showCloseButton={false}
        className="max-h-[min(90vh,46rem)] overflow-y-auto sm:max-w-3xl"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UsersIcon className="size-5" /> Set up players
          </DialogTitle>
          <DialogDescription>{setupDescription(queuePlayback)}</DialogDescription>
        </DialogHeader>

        <CombineChannelsField
          available={hasMultiChannelInput}
          checked={combineChannels}
          className={navClass(0)}
          onFocus={() => focusSegment(0)}
          onCheckedChange={(multiplayer_combine_multi_channel) =>
            saveConfig({ multiplayer_combine_multi_channel })
          }
        />

        <div>
          <div className="hidden grid-cols-[7rem_minmax(0,0.8fr)_minmax(0,1.2fr)] gap-3 border-b px-1 pb-2 text-xs font-medium text-muted-foreground sm:grid">
            <span>Player</span>
            <span>Profile</span>
            <span>Microphone</span>
          </div>
          <div className="divide-y border-b">
            <PlayerRows
              players={players}
              profiles={profileStore?.profiles ?? []}
              microphones={microphones.data}
              updatePlayer={updatePlayer}
              removePlayer={removePlayer}
              segmentOffset={playerSegmentOffset}
              navClass={navClass}
              focusSegment={focusSegment}
            />
          </div>
          <div className="mt-2 flex min-h-8 items-center justify-between gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={canAddPlayer ? navClass(addPlayerSegment) : undefined}
              disabled={!canAddPlayer}
              onFocus={() => focusSegment(addPlayerSegment)}
              onMouseEnter={() => focusSegment(addPlayerSegment)}
              onClick={addPlayer}
            >
              <PlusIcon /> Add player
            </Button>
            {error !== null ? (
              <p role="alert" className="text-right text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            className={navClass(footerSegment, 0)}
            onFocus={() => focusSegment(footerSegment, 0)}
            onMouseEnter={() => focusSegment(footerSegment, 0)}
            onClick={closeDialog}
          >
            Cancel
          </Button>
          <Button
            type="button"
            className={canStart ? navClass(footerSegment, 1) : undefined}
            disabled={!canStart}
            onFocus={() => focusSegment(footerSegment, 1)}
            onMouseEnter={() => focusSegment(footerSegment, 1)}
            onClick={startMultiplayer}
          >
            {setupSubmitLabel(submitLabel)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
