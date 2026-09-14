import { FileTextIcon, LoaderIcon } from 'lucide-react';

import { useGuestLyrics } from '@/features/guest/hooks/use-guest-lyrics';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/shared/components/ui/sheet';
import { cn } from '@/shared/utils/cn';
import type { Song } from '@/types/Song';

type GuestLyricsDrawerProps = {
  song: Song | null;
  onClose: () => void;
};

const LyricsHeader = ({ song }: { song: Song }) => (
  <SheetHeader className="border-b">
    <SheetTitle className="truncate" title={song.title}>
      {song.title !== '' ? song.title : 'Lyrics'}
    </SheetTitle>
    <SheetDescription className="truncate" title={song.artist}>
      {song.artist !== '' ? song.artist : 'Unknown artist'}
    </SheetDescription>
  </SheetHeader>
);

const LyricsLoading = () => (
  <div className="flex flex-1 items-center justify-center gap-2 px-6 py-12 text-sm text-muted-foreground">
    <LoaderIcon className="size-4 animate-spin" aria-hidden="true" />
    Loading lyrics
  </div>
);

const LyricsEmpty = () => (
  <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-12 text-center text-muted-foreground">
    <FileTextIcon className="size-6" aria-hidden="true" />
    <p className="text-sm">No lyrics available for this song yet.</p>
    <p className="text-xs">Ask the host to run the analysis to generate lyrics.</p>
  </div>
);

const LyricsText = ({ lines }: { lines: ReadonlyArray<string> }) => (
  <div className="themed-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain">
    <pre
      className={cn(
        'whitespace-pre-wrap px-6 py-6 font-sans text-base/loose text-foreground',
        'sm:text-sm/loose',
      )}
    >
      {lines.join('\n')}
    </pre>
  </div>
);

const LyricsBody = ({ fileHash }: { fileHash: string }) => {
  const { data, isLoading } = useGuestLyrics(fileHash);

  if (isLoading || !data) {
    return <LyricsLoading />;
  }
  if (data.lines.length === 0) {
    return <LyricsEmpty />;
  }
  return <LyricsText lines={data.lines} />;
};

export const GuestLyricsDrawer = ({ song, onClose }: GuestLyricsDrawerProps) => {
  const open = song !== null;

  return (
    <Sheet open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <SheetContent
        side="right"
        showCloseButton
        className={cn('flex w-full max-w-md flex-col gap-0 p-0 sm:max-w-md', '[&>button]:top-3')}
      >
        {song !== null ? (
          <>
            <LyricsHeader song={song} />
            <LyricsBody fileHash={song.file_hash} />
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
};
