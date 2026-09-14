import { ListMusicIcon } from 'lucide-react';
import type { ComponentProps } from 'react';

import { usePlaybackQueueQuery } from '@/features/playback-queue/use-playback-queue';
import { Button } from '@/shared/components/ui/button';
import { cn } from '@/shared/utils/cn';

// `rest` is forwarded onto the underlying `Button` so a `SheetTrigger` Slot can
// attach its `onClick` handler when this component is used as the trigger
// element of a sheet/dialog.
export const GuestQueueButton = ({
  className,
  ...rest
}: { className?: string } & Omit<ComponentProps<typeof Button>, 'variant' | 'size' | 'type'>) => {
  const { data: entries = [] } = usePlaybackQueueQuery();
  const count = entries.length;
  const label = count === 0 ? 'Queue (empty)' : `Queue (${count})`;

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn('relative gap-1.5', className)}
      aria-label={label}
      {...rest}
    >
      <ListMusicIcon aria-hidden="true" />
      <span className="hidden sm:inline">Queue</span>
      {count > 0 ? (
        <span
          aria-hidden="true"
          className="ml-0.5 inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[0.65rem] font-semibold leading-5 text-primary-foreground tabular-nums"
        >
          {count}
        </span>
      ) : null}
    </Button>
  );
};
