import { create } from 'zustand';
import type { ModelStatus } from '../app/types';

interface ModelState {
  readonly whisperStatus: ModelStatus;
  readonly canaryStatus: ModelStatus;
  readonly zipvoiceStatus: ModelStatus;
  readonly whisperProgress: number; // 0-100
  readonly canaryProgress: number;  // 0-100
  readonly zipvoiceProgress: number; // 0-100
  readonly whisperError: string | null;
  readonly canaryError: string | null;
  readonly zipvoiceError: string | null;
}

interface ModelActions {
  setWhisperStatus: (status: ModelStatus) => void;
  setCanaryStatus: (status: ModelStatus) => void;
  setZipvoiceStatus: (status: ModelStatus) => void;
  setWhisperProgress: (progress: number) => void;
  setCanaryProgress: (progress: number) => void;
  setZipvoiceProgress: (progress: number) => void;
  setWhisperError: (error: string | null) => void;
  setCanaryError: (error: string | null) => void;
  setZipvoiceError: (error: string | null) => void;
}

export const useModelStore = create<ModelState & ModelActions>(set => ({
  whisperStatus: 'not_downloaded',
  canaryStatus: 'not_downloaded',
  zipvoiceStatus: 'not_downloaded',
  whisperProgress: 0,
  canaryProgress: 0,
  zipvoiceProgress: 0,
  whisperError: null,
  canaryError: null,
  zipvoiceError: null,

  setWhisperStatus: status => set({ whisperStatus: status }),
  setCanaryStatus: status => set({ canaryStatus: status }),
  setZipvoiceStatus: status => set({ zipvoiceStatus: status }),
  setWhisperProgress: progress => set({ whisperProgress: progress }),
  setCanaryProgress: progress => set({ canaryProgress: progress }),
  setZipvoiceProgress: progress => set({ zipvoiceProgress: progress }),
  setWhisperError: error => set({ whisperError: error }),
  setCanaryError: error => set({ canaryError: error }),
  setZipvoiceError: error => set({ zipvoiceError: error }),
}));
