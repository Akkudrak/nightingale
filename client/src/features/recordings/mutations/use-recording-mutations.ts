import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { deleteRecording, saveRecording, type SaveRecordingInput } from '@/bridge/recording';
import { RECORDINGS } from '@/shared/query-keys';

export const useSaveRecording = () => {
  const queryClient = useQueryClient();

  return useMutation<string, Error, SaveRecordingInput>({
    mutationFn: saveRecording,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: RECORDINGS });
    },
    onError: (error) => toast.error(`Could not save recording: ${error.message}`),
  });
};

export const useDeleteRecording = () => {
  const queryClient = useQueryClient();

  return useMutation<void, Error, string>({
    mutationFn: deleteRecording,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: RECORDINGS });
    },
    onError: (error) => toast.error(`Could not delete recording: ${error.message}`),
  });
};
