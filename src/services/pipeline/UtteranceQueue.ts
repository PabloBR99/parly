import type { Utterance } from '../../app/types';

type UtteranceHandler = (utterance: Utterance) => Promise<void>;

export class UtteranceQueue {
  private readonly queue: Utterance[] = [];
  private processing = false;
  private handler: UtteranceHandler | null = null;

  setHandler(handler: UtteranceHandler): void {
    this.handler = handler;
  }

  enqueue(utterance: Utterance): void {
    this.queue.push(utterance);
    if (!this.processing) {
      void this.processNext();
    }
  }

  clear(): void {
    this.queue.length = 0;
  }

  get isProcessing(): boolean {
    return this.processing;
  }

  private async processNext(): Promise<void> {
    if (!this.handler || this.queue.length === 0) {
      this.processing = false;
      return;
    }

    this.processing = true;
    const utterance = this.queue.shift()!;

    try {
      await this.handler(utterance);
    } catch (error) {
      console.error('[UtteranceQueue] Error processing utterance:', error);
    }

    void this.processNext();
  }
}
