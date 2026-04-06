import { create } from 'zustand';

interface AudioLevelState {
  /** RMS energy level from the microphone, 0.0–1.0 (clamped). */
  readonly level: number;
  setLevel: (level: number) => void;
}

export const useAudioLevelStore = create<AudioLevelState>(set => ({
  level: 0,
  setLevel: (level) => set({ level: Math.min(1, Math.max(0, level)) }),
}));
