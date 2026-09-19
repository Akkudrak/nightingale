import { usePixabaySlots } from '@/features/playback/hooks/use-pixabay-slots';
import type { VideoFlavor } from '@/features/playback/lib/video-flavor';
import { VIDEO_CLASS_NAME } from '@/features/playback/lib/video-styles';

type PixabayVideoProps = {
  flavor: VideoFlavor;
  isPlaying: boolean;
};

export const PixabayVideo = ({ flavor, isPlaying }: PixabayVideoProps) => {
  const { slots, onActiveEnded } = usePixabaySlots(flavor, isPlaying);

  return (
    <>
      {slots.map((slot) => (
        <video
          key={slot.id}
          ref={slot.ref}
          className={VIDEO_CLASS_NAME}
          style={{ visibility: slot.isActive ? 'visible' : 'hidden' }}
          src={slot.src || undefined}
          preload="auto"
          muted
          playsInline
          // The `'custom'` flavor picks ONE video at random and plays
          // it forever; let the browser rewind natively instead of
          // rotating through slots via `onEnded`.
          loop={flavor === 'custom' && slot.isActive}
          onEnded={slot.isActive && flavor !== 'custom' ? onActiveEnded : undefined}
          onError={slot.isActive ? onActiveEnded : undefined}
        />
      ))}
    </>
  );
};
