import { StarIcon } from 'lucide-react';
import type { ComponentProps } from 'react';

import { Button } from '@/shared/components/ui/button';
import { cn } from '@/shared/utils/cn';

// `rest` is forwarded onto the underlying `Button` so a `SheetTrigger` Slot can
// attach its `onClick` handler when this component is used as the trigger
// element of a sheet/dialog (same lesson as GuestQueueButton).
export const GuestFavoritesFilterButton = ({
  active,
  className,
  ...rest
}: { active: boolean; className?: string } & Omit<
  ComponentProps<typeof Button>,
  'variant' | 'size' | 'type'
>) => {
  const label = active ? 'Favorites (showing)' : 'Favorites';
  return (
    <Button
      type="button"
      variant={active ? 'default' : 'outline'}
      size="sm"
      className={cn('relative gap-1.5', className)}
      aria-label={label}
      aria-pressed={active}
      {...rest}
    >
      <StarIcon aria-hidden="true" className={cn('transition-colors', active && 'fill-current')} />
      <span className="hidden sm:inline">Favorites</span>
    </Button>
  );
};
