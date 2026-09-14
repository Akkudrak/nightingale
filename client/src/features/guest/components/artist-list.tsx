import { ChevronRightIcon, LoaderIcon, UsersIcon } from 'lucide-react';

import { Button } from '@/shared/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/shared/components/ui/sheet';
import { cn } from '@/shared/utils/cn';

import { useGuestArtists } from '../hooks/use-guest-library';

type ArtistListProps = {
  selected: string | null;
  onSelect: (artist: string | null) => void;
};

const ArtistRow = ({
  label,
  count,
  selected,
  onSelect,
}: {
  label: string;
  count: number | null;
  selected: boolean;
  onSelect: () => void;
}) => (
  <button
    type="button"
    onClick={onSelect}
    aria-pressed={selected}
    className={cn(
      'flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors',
      'hover:bg-muted focus-visible:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30',
      selected && 'bg-muted font-medium text-foreground',
    )}
  >
    <span className="truncate">{label}</span>
    {count !== null ? (
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{count}</span>
    ) : null}
  </button>
);

const ArtistsBody = ({ selected, onSelect }: ArtistListProps) => {
  const { data: artists, isLoading, isError } = useGuestArtists();

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
        <LoaderIcon className="size-3 animate-spin" aria-hidden="true" />
        Loading artists
      </div>
    );
  }

  if (isError) {
    return <div className="px-3 py-4 text-xs text-muted-foreground">Could not load artists.</div>;
  }

  return (
    <div className="flex flex-col gap-0.5 p-2">
      <ArtistRow
        label="All artists"
        count={null}
        selected={selected === null}
        onSelect={() => onSelect(null)}
      />
      {artists.map((artist) => (
        <ArtistRow
          key={artist.value}
          label={artist.label}
          count={Number(artist.count)}
          selected={selected === artist.value}
          onSelect={() => onSelect(artist.value)}
        />
      ))}
    </div>
  );
};

export const ArtistSidebar = (props: ArtistListProps) => (
  <aside className="hidden w-60 shrink-0 border-r bg-card/40 md:flex md:flex-col">
    <header className="flex items-center gap-2 border-b px-4 py-3">
      <UsersIcon className="size-4 text-muted-foreground" aria-hidden="true" />
      <h2 className="text-xs font-medium tracking-wide uppercase">Artists</h2>
    </header>
    <div className="themed-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <ArtistsBody {...props} />
    </div>
  </aside>
);

export const ArtistDrawer = ({ selected, onSelect }: ArtistListProps) => {
  const selectedLabel = selected ?? 'All artists';

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5 md:hidden">
          <UsersIcon aria-hidden="true" />
          <span className="truncate max-w-[10rem]">{selectedLabel}</span>
          <ChevronRightIcon aria-hidden="true" />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" showCloseButton className="w-80 max-w-[85vw] p-0">
        <SheetHeader className="border-b">
          <SheetTitle>Artists</SheetTitle>
        </SheetHeader>
        <div className="themed-scrollbar h-[calc(100dvh-5rem)] overflow-y-auto overscroll-contain">
          <ArtistsBody selected={selected} onSelect={onSelect} />
        </div>
      </SheetContent>
    </Sheet>
  );
};
