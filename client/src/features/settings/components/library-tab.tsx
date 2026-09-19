import { EyeIcon, EyeOffIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';

import { Hint } from '@/features/settings/components/settings-controls';
import { Button } from '@/shared/components/ui/button';
import { Field, FieldGroup } from '@/shared/components/ui/field';
import { Input } from '@/shared/components/ui/input';
import { Label } from '@/shared/components/ui/label';
import { useConfig } from '@/shared/config/use-config';
import { useConfigMutation } from '@/shared/config/use-config-mutation';

import { NAV } from './constants';

/**
 * Settings → Library tab. Hosted on its own because adding it inline
 * to `settings.tsx` would push the page past oxlint's complexity cap;
 * the `useServerGuestMode` hook extraction (parallel concern) set
 * the precedent for this pattern.
 */
export const LibraryTab = () => {
  const { data: config } = useConfig();
  const { mutate } = useConfigMutation();
  const [revealApiKey, setRevealApiKey] = useState(false);

  const apiKey = config?.youtube_api_key ?? '';
  const isApiKeySet = apiKey.trim().length > 0;

  const handleApiKeyChange = (value: string) => {
    const trimmed = value;
    if (trimmed.length === 0) {
      mutate({ youtube_api_key: null });
    } else {
      mutate({ youtube_api_key: trimmed });
    }
  };

  return (
    <FieldGroup>
      <Field>
        <Label htmlFor="youtube-api-key">YouTube API key</Label>
        <Hint>
          Optional. Lets the song-list search bar fall back to YouTube Data API v3 when a song isn't
          in the local library — tick the YouTube toggle next to the search input to opt in. Paste
          your own key (create one in the Google Cloud Console). Each user brings their own 10k-unit
          daily quota. Stored in
          <code className="mx-1 rounded bg-muted px-1 py-0.5 text-xs">
            ~/.nightingale/config.json
          </code>
          .
        </Hint>
        <div className="flex items-center gap-2">
          <Input
            id="youtube-api-key"
            type={revealApiKey ? 'text' : 'password'}
            value={apiKey}
            onChange={({ target: { value } }) => handleApiKeyChange(value)}
            placeholder="AIzaSy…"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => setRevealApiKey((prev) => !prev)}
            aria-label={revealApiKey ? 'Hide API key' : 'Show API key'}
            title={revealApiKey ? 'Hide API key' : 'Show API key'}
          >
            {revealApiKey ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => handleApiKeyChange('')}
            disabled={!isApiKeySet}
            aria-label="Clear YouTube API key"
            title="Clear"
          >
            <Trash2Icon className="size-4" />
          </Button>
        </div>
      </Field>
    </FieldGroup>
  );
};

export const LIBRARY_TAB_KEY = NAV.library.youtubeApiKey;
