import { useCallback } from 'react';

import { useLibraryFilter } from '@/features/menu/hooks/use-library-filter';
import { Button } from '@/shared/components/ui/button';
import { ButtonGroup } from '@/shared/components/ui/button-group';
import { cn } from '@/shared/utils/cn';

// 27 buttons: `#` for non-letter starts, then `A` through `Z`. The backend
// matches `#` against `s.artist NOT GLOB '[A-Za-z]*'` and the rest against
// the lowercased first character.
const LETTERS: readonly string[] = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')];

type AzFilterProps = {
  className?: string;
};

export const AzFilter = ({ className }: AzFilterProps) => {
  const { first_letter, setLibraryFilter } = useLibraryFilter();
  const active = first_letter ?? null;

  const select = useCallback(
    (value: string) => {
      setLibraryFilter((current) => ({
        ...current,
        first_letter: current.first_letter === value ? null : value,
      }));
    },
    [setLibraryFilter],
  );

  return (
    <ButtonGroup
      aria-label="Filter by artist first letter"
      className={cn(
        'scrollbar-hide w-full max-w-full items-center justify-start overflow-x-auto py-1 px-0.5',
        className,
      )}
    >
      {LETTERS.map((letter) => {
        const isActive = active === letter;
        return (
          <Button
            key={letter}
            type="button"
            variant={isActive ? 'default' : 'outline'}
            size="sm"
            aria-pressed={isActive}
            onClick={() => select(letter)}
            className="size-9 shrink-0 px-0 font-semibold tabular-nums"
            title={letter === '#' ? 'Non-letter starts' : `Artists starting with ${letter}`}
          >
            {letter}
          </Button>
        );
      })}
    </ButtonGroup>
  );
};
