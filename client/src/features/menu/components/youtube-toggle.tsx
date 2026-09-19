import { YoutubeIcon } from 'lucide-react';
import { useId } from 'react';

import { Checkbox } from '@/shared/components/ui/checkbox';

/**
 * Reusable "also search YouTube" toggle. Used in the library filters
 * toolbar and the guest `/guest` toolbar so the affordance is identical
 * across both routes. Reads its persisted state from `useYouTubeEnabled`,
 * but accepts explicit `checked`/`onChange` so callers that want to
 * drive it imperatively can override the default atom binding.
 */
type YouTubeToggleProps = {
  checked?: boolean;
  onChange?: (next: boolean) => void;
  className?: string;
};

export const YouTubeToggle = ({
  checked: checkedOverride,
  onChange: onChangeOverride,
  className,
}: YouTubeToggleProps = {}) => {
  const labelId = useId();
  return (
    <label
      htmlFor={labelId}
      className={
        'flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-input bg-background/40 px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground ' +
        (className ?? '')
      }
      title="Also search YouTube (opens videos in your browser)"
    >
      <Checkbox
        id={labelId}
        checked={checkedOverride === true}
        onCheckedChange={(value) => onChangeOverride?.(value === true)}
        aria-label="Also search YouTube"
      />
      <YoutubeIcon className="size-3.5" aria-hidden="true" />
      <span className="hidden sm:inline">YouTube</span>
    </label>
  );
};
