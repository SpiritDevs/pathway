import { fnv1a32, type DiffThemeName } from "./diffRendering";
import { LRUCache } from "./lruCache";

export interface HighlightRequest {
  id: number;
  code: string;
  language: string;
  themeName: DiffThemeName;
}

export interface HighlightResponse {
  id: number;
  html: string | null;
}

interface HighlightJob extends HighlightRequest {
  key: string;
  listeners: Set<(html: string | null) => void>;
}

export function markdownHighlightKey(code: string, language: string, themeName: DiffThemeName) {
  return `${fnv1a32(code).toString(36)}:${code.length}:${language}:${themeName}`;
}

// One serial worker bounds CPU use. Overflow stays readable as plain code;
// unmounted blocks release their queued work before another thread opens.
export class MarkdownHighlightQueue {
  private readonly cache = new LRUCache<string>(500, 50 * 1024 * 1024);
  private readonly jobs = new Map<string, HighlightJob>();
  private readonly queue: HighlightJob[] = [];
  private active: HighlightJob | undefined;
  private worker: Worker | undefined;
  private failed = false;
  private nextId = 0;
  private queuedBytes = 0;

  constructor(private readonly createWorker: () => Worker) {}

  get(key: string) {
    return this.cache.get(key);
  }

  request(code: string, language: string, themeName: DiffThemeName) {
    const key = markdownHighlightKey(code, language, themeName);
    const cached = this.get(key);
    if (cached !== null || this.failed) {
      return { result: Promise.resolve(cached), cancel() {} };
    }
    let job = this.jobs.get(key);
    if (job === undefined) {
      if (this.jobs.size >= 32 || this.queuedBytes + code.length * 2 > 4 * 1024 * 1024) {
        return { result: Promise.resolve(null), cancel() {} };
      }
      job = { id: ++this.nextId, key, code, language, themeName, listeners: new Set() };
      this.jobs.set(key, job);
      this.queue.push(job);
      this.queuedBytes += code.length * 2;
    }
    const subscribedJob = job;
    let resolveResult!: (html: string | null) => void;
    const result = new Promise<string | null>((resolve) => {
      resolveResult = resolve;
      subscribedJob.listeners.add(resolve);
    });
    this.drain();
    return {
      result,
      cancel: () => {
        subscribedJob.listeners.delete(resolveResult);
        resolveResult(null);
        if (subscribedJob.listeners.size === 0 && this.active !== subscribedJob) {
          const index = this.queue.indexOf(subscribedJob);
          if (index !== -1) {
            this.queue.splice(index, 1);
            this.remove(subscribedJob);
          }
        }
      },
    };
  }

  private remove(job: HighlightJob) {
    this.jobs.delete(job.key);
    this.queuedBytes -= job.code.length * 2;
  }

  private drain() {
    if (this.active || this.queue.length === 0 || this.failed) return;
    try {
      if (!this.worker) {
        this.worker = this.createWorker();
        this.worker.addEventListener("message", ({ data }: MessageEvent<HighlightResponse>) => {
          const job = this.active;
          if (!job || data.id !== job.id) return;
          if (data.html !== null) {
            this.cache.set(job.key, data.html, Math.max(data.html.length * 2, job.code.length * 3));
          }
          this.remove(job);
          this.active = undefined;
          for (const listener of job.listeners) listener(data.html);
          this.drain();
        });
        this.worker.addEventListener("error", () => this.fail());
        this.worker.addEventListener("messageerror", () => this.fail());
      }
      this.active = this.queue.shift();
      if (this.active) {
        const { id, code, language, themeName } = this.active;
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker, not a window.
        this.worker.postMessage({ id, code, language, themeName } satisfies HighlightRequest);
      }
    } catch {
      this.fail();
    }
  }

  private fail() {
    this.failed = true;
    this.worker?.terminate();
    for (const job of this.jobs.values()) {
      for (const listener of job.listeners) listener(null);
    }
    this.jobs.clear();
    this.queue.length = 0;
    this.active = undefined;
    this.queuedBytes = 0;
  }
}
