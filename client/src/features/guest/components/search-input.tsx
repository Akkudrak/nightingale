import { SearchIcon, XIcon } from 'lucide-react';
import type { ChangeEvent } from 'react';

import { Button } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';
import { cn } from '@/shared/utils/cn';

type SearchInputProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
};

export const SearchInput = ({ value, onChange, placeholder, className }: SearchInputProps) => {
  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange(event.target.value);
  };
  const handleClear = () => {
    onChange('');
  };

  return (
    <div className={cn('relative w-full', className)}>
      <SearchIcon
        className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        type="search"
        value={value}
        onChange={handleChange}
        placeholder={placeholder ?? 'Search songs or artists'}
        className="h-9 pl-7 pr-9 text-sm"
        aria-label="Search the karaoke library"
      />
      {value !== '' ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={handleClear}
          aria-label="Clear search"
          className="absolute top-1/2 right-1 -translate-y-1/2"
        >
          <XIcon />
        </Button>
      ) : null}
    </div>
  );
};
