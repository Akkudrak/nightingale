import {
  AlignLeftIcon,
  ArchiveIcon,
  AudioLinesIcon,
  ImageIcon,
  LanguagesIcon,
  MicIcon,
  PackageOpenIcon,
  PencilLineIcon,
  RefreshCwIcon,
  Trash2Icon,
  UploadIcon,
  XCircleIcon,
} from 'lucide-react';
import { toast } from 'sonner';

import { exportSongCatalogZip } from '@/bridge/catalog-export';
import { exportSongFull, importSongFull } from '@/bridge/song-export';
import type { Song } from '@/types/Song';

import type { SongStatusInfo } from '../shared/song-status';
import type { ActionItemProps } from './action-item';

type AnalysisHandler = (fileHash: string) => void | Promise<void>;

type AnalysisHandlers = {
  enqueueOne: AnalysisHandler;
  cancelAnalysisOne: AnalysisHandler;
  deleteSongCache: AnalysisHandler;
  reanalyzeFull: AnalysisHandler;
  reanalyzeTranscript: AnalysisHandler;
  realign: AnalysisHandler;
  reanalyzeForceTranscribe: AnalysisHandler;
  refreshMetadata: (fileHash: string) => Promise<boolean | undefined>;
};

type BuildActionGroupsParams = {
  song: Song;
  status: SongStatusInfo;
  analysisBusy: boolean;
  supportsAnalysisActions: boolean;
  analysis: AnalysisHandlers;
  onEditLyrics: () => void;
  onChangeLanguage: () => void;
  run: (
    message: string,
    action: () => void | boolean | undefined | Promise<void | boolean | undefined>,
    onFalse?: string,
  ) => () => Promise<void>;
};

export function buildActionGroups({
  song,
  status,
  analysisBusy,
  supportsAnalysisActions,
  analysis,
  onEditLyrics,
  onChangeLanguage,
  run,
}: BuildActionGroupsParams): ActionItemProps[][] {
  const groups: ActionItemProps[][] = [];

  const supportsProvideLyrics = song.transcript_source !== 'Usdx';

  if (status.isReady !== true) {
    const notReadyGroup: ActionItemProps[] = [
      analysisBusy
        ? {
            icon: XCircleIcon,
            title: 'Cancel analysis',
            description: 'Stop analysis and remove this song from the queue.',
            destructive: true,
            onClick: run(`Cancelled analysis for "${song.title}"`, () =>
              analysis.cancelAnalysisOne(song.file_hash),
            ),
          }
        : {
            icon: AudioLinesIcon,
            title: 'Analyze song',
            description: 'Prepare lyrics, timing, key, tempo, and stems.',
            onClick: () => analysis.enqueueOne(song.file_hash),
          },
    ];

    if (supportsProvideLyrics) {
      notReadyGroup.push({
        icon: PencilLineIcon,
        title: 'Provide lyrics',
        description: 'Paste timed LRC, or lyrics to align.',
        disabled: analysisBusy,
        onClick: onEditLyrics,
      });
    }

    groups.push(notReadyGroup);
  }

  if (supportsAnalysisActions) {
    // LRC-provided songs have no AI-generated stems/timing to rebuild, so the
    // realign/refetch/transcribe actions don't apply. Offer editing the LRC and
    // an explicit opt-in to replace it with full AI analysis instead.
    if (song.transcript_source === 'Lrc') {
      groups.push([
        {
          icon: PencilLineIcon,
          title: 'Edit lyrics (LRC)',
          description: 'Replace or re-time the provided LRC.',
          onClick: onEditLyrics,
        },
        {
          icon: AudioLinesIcon,
          title: 'Analyze with AI',
          description: 'Replace the LRC with AI stems, lyrics, timing, and key.',
          onClick: run(`Analyzing "${song.title}" with AI`, () =>
            analysis.reanalyzeFull(song.file_hash),
          ),
        },
      ]);
    } else {
      groups.push([
        {
          icon: AlignLeftIcon,
          title: 'Realign',
          description: 'Rebuild timing from the current lyrics.',
          onClick: run(`Realigning "${song.title}"`, () => analysis.realign(song.file_hash)),
        },
        {
          icon: RefreshCwIcon,
          title: 'Refetch lyrics & align',
          description: 'Fetch fresh lyrics, then rebuild timing.',
          onClick: run(`Refetching lyrics & aligning "${song.title}"`, () =>
            analysis.reanalyzeTranscript(song.file_hash),
          ),
        },
        {
          icon: MicIcon,
          title: 'Force transcribe',
          description: 'Ignore online lyrics and transcribe the vocals.',
          onClick: run(`Force transcribing "${song.title}"`, () =>
            analysis.reanalyzeForceTranscribe(song.file_hash),
          ),
        },
        {
          icon: AudioLinesIcon,
          title: 'Full reanalysis',
          description: 'Recreate stems, lyrics, timing, key, and tempo.',
          onClick: run(`Full reanalysis (w/ stems) for "${song.title}"`, () =>
            analysis.reanalyzeFull(song.file_hash),
          ),
        },
      ]);

      groups.push([
        {
          icon: PencilLineIcon,
          title: 'Edit lyrics',
          description: 'Correct the words and rebuild their timing.',
          onClick: onEditLyrics,
        },
        {
          icon: LanguagesIcon,
          title: 'Change language',
          description: 'Set the language and choose how to reprocess.',
          onClick: onChangeLanguage,
        },
      ]);
    }

    if (!song.usdx) {
      groups.push([
        {
          icon: ImageIcon,
          title: 'Refresh metadata',
          description:
            'Reload title, artist, album, duration, and cover art from the library source.',
          onClick: run(
            `Refreshed metadata for "${song.title}"`,
            () => analysis.refreshMetadata(song.file_hash),
            `Nothing to refresh for "${song.title}"`,
          ),
        },
      ]);
    }

    groups.push([
      {
        icon: Trash2Icon,
        title: 'Delete cache',
        description: 'Remove every generated file for this song.',
        destructive: true,
        onClick: run(`Cache deleted for "${song.title}"`, () =>
          analysis.deleteSongCache(song.file_hash),
        ),
      },
    ]);
  }

  // Export catalog ZIP — visible for every song regardless of analysis
  // state, since exporting doesn't require stems or transcripts. The
  // bridge returns `null` when the user cancels the save dialog; we
  // toast accordingly instead of treating it as a failure.
  groups.push([
    {
      icon: PackageOpenIcon,
      title: 'Export catalog ZIP',
      description:
        'Save this song as a Nightingale-Catalog-compatible ZIP for upload to the catalog admin. Cover art, genre, bpm, year, notes, and credits are not exported — fill them in after import.',
      onClick: async () => {
        const result = await exportSongCatalogZip({
          fileHash: song.file_hash,
          title: song.title,
          artist: song.artist,
        });
        if (result === null) {
          toast.info(`Export cancelled for "${song.title}"`);
          return;
        }
        const kb = (result.bytes / 1024).toFixed(0);
        toast.success(`Exported ${kb} KB to ${result.path}`);
      },
    },
  ]);

  // Full-song export — bundles audio + cover + every analysis
  // artifact (transcript, stems, lyrics, key/tempo variants, playable
  // video) so an import on a fresh install skips the AI re-analysis
  // pipeline. Only available for LocalFile songs; the Rust side rejects
  // remote-origin exports with a clear error.
  groups.push(fullSongExportGroup(song));

  // Import is global — operates on a ZIP picked from disk, not the
  // current song — so it lives in its own group at the end.
  groups.push(importSongGroup());

  return groups;
}

function fullSongExportGroup(song: Song): ActionItemProps[] {
  if (song.origin.kind !== 'local_file') {
    return [];
  }
  return [
    {
      icon: ArchiveIcon,
      title: 'Export full song',
      description:
        'Save audio + cover + transcript + stems + lyrics + variants + metadata as a single ZIP. Importing such a ZIP on a fresh install skips the AI re-analysis pipeline.',
      onClick: async () => {
        const result = await exportSongFull({
          fileHash: song.file_hash,
          title: song.title,
          artist: song.artist,
        });
        if (result === null) {
          toast.info(`Export cancelled for "${song.title}"`);
          return;
        }
        const mb = (result.bytes / (1024 * 1024)).toFixed(1);
        toast.success(`Exported ${mb} MB to ${result.path}`);
      },
    },
  ];
}

function importSongGroup(): ActionItemProps[] {
  return [
    {
      icon: UploadIcon,
      title: 'Import song ZIP',
      description:
        'Restore a previously exported full-song ZIP into this Nightingale instance without re-running AI analysis.',
      onClick: async () => {
        const result = await importSongFull();
        if (result === null) {
          toast.info('Import cancelled');
          return;
        }
        toast.success(`Imported "${result.title}" — ${result.artist} to ${result.importedPath}`);
      },
    },
  ];
}
