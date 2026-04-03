import { NativeModules } from 'react-native';

// Thresholds in MB
const WARN_THRESHOLD_MB = 500;
const CRITICAL_THRESHOLD_MB = 200;

type MemoryPressureLevel = 'normal' | 'warning' | 'critical';
type PressureCallback = (level: MemoryPressureLevel) => void;

class MemoryMonitor {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private callbacks: PressureCallback[] = [];

  start(intervalMs = 10_000): void {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => void this.check(), intervalMs);
  }

  stop(): void {
    if (!this.intervalId) return;
    clearInterval(this.intervalId);
    this.intervalId = null;
  }

  onPressure(cb: PressureCallback): () => void {
    this.callbacks.push(cb);
    return () => {
      this.callbacks = this.callbacks.filter(c => c !== cb);
    };
  }

  async getAvailableMB(): Promise<number> {
    try {
      const mb: number =
        await NativeModules.ParlyMemory?.getAvailableMemoryMB?.();
      return mb ?? 4096;
    } catch {
      return 4096;
    }
  }

  private async check(): Promise<void> {
    const available = await this.getAvailableMB();
    const level: MemoryPressureLevel =
      available < CRITICAL_THRESHOLD_MB
        ? 'critical'
        : available < WARN_THRESHOLD_MB
        ? 'warning'
        : 'normal';

    if (level !== 'normal') {
      this.callbacks.forEach(cb => cb(level));
    }
  }
}

export const memoryMonitor = new MemoryMonitor();
