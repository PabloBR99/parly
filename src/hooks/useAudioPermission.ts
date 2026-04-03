import { useCallback, useState } from 'react';
import { audioCaptureService } from '../services/audio/AudioCaptureService';

type PermissionStatus = 'unknown' | 'granted' | 'denied';

export function useAudioPermission(): {
  status: PermissionStatus;
  request: () => Promise<boolean>;
} {
  const [status, setStatus] = useState<PermissionStatus>('unknown');

  const request = useCallback(async (): Promise<boolean> => {
    const granted = await audioCaptureService.requestPermission();
    setStatus(granted ? 'granted' : 'denied');
    return granted;
  }, []);

  return { status, request };
}
