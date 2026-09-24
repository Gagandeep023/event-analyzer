/**
 * Append-only JSONL store, rotated by date and by size.
 *
 * Comfortable to a few million events. Beyond that the full scan per query
 * becomes the bottleneck, which is what the SQLite store in v0.2 is for.
 *
 * Two things keep it usable at this scale:
 *   - an in-memory index of (file, min time, max time), so a range query reads
 *     only the files that overlap
 *   - a single-entry result cache keyed by range plus filter hash, so the
 *     dashboard's six simultaneous panel requests cost one disk pass, not six
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AnalyticsEvent, Filter, TimeRange, UserAlias } from '../../types';
import { matchesAll } from '../../core/filter';
import { deriveMeta, withinRange, type AliasCapableStore, type StoreMeta } from './EventStore';

export interface JsonlFileStoreOptions {
  /** Directory holding the JSONL files. Created if absent. */
  dir: string;
  /** Rotate once a file exceeds this many megabytes. Default 64. */
  maxFileMb?: number;
  allowRegexFilters?: boolean;
}

interface Segment {
  file: string;
  min: number;
  max: number;
  count: number;
}

const ALIAS_FILE = 'aliases.jsonl';

export class JsonlFileStore implements AliasCapableStore {
  name = 'JsonlFileStore';
  private dir: string;
  private maxBytes: number;
  private allowRegex: boolean;
  private segments: Segment[] = [];
  private generation = 0;
  private cache: { key: string; generation: number; events: AnalyticsEvent[] } | null = null;

  constructor(options: JsonlFileStoreOptions) {
    this.dir = options.dir;
    this.maxBytes = (options.maxFileMb ?? 64) * 1024 * 1024;
    this.allowRegex = options.allowRegexFilters ?? false;
    mkdirSync(this.dir, { recursive: true });
    this.reindex();
  }

  /** Rebuilds the segment index by scanning the directory once. */
  private reindex(): void {
    this.segments = [];
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith('.jsonl') || file === ALIAS_FILE) continue;
      const events = this.readFile(file);
      if (events.length === 0) continue;
      let min = Infinity;
      let max = -Infinity;
      for (const ev of events) {
        const t = ev.time ?? 0;
        if (t < min) min = t;
        if (t > max) max = t;
      }
      this.segments.push({ file, min, max, count: events.length });
    }
    this.segments.sort((a, b) => a.min - b.min);
  }

  private readFile(file: string): AnalyticsEvent[] {
    const path = join(this.dir, file);
    if (!existsSync(path)) return [];
    const out: AnalyticsEvent[] = [];
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line) as AnalyticsEvent);
      } catch {
        // A truncated final line from an interrupted write. Skip it rather than
        // failing the whole read.
      }
    }
    return out;
  }

  /** File an event belongs in, based on its own day, not on arrival time. */
  private fileFor(ev: AnalyticsEvent): string {
    const d = new Date(ev.time ?? Date.now());
    const stamp = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    let index = 0;
    let file = `events-${stamp}.jsonl`;
    // Roll to a new part once the current one is too large.
    while (existsSync(join(this.dir, file)) && statSync(join(this.dir, file)).size >= this.maxBytes) {
      index += 1;
      file = `events-${stamp}.${index}.jsonl`;
    }
    return file;
  }

  async append(events: AnalyticsEvent[]): Promise<void> {
    if (events.length === 0) return;
    const byFile = new Map<string, string[]>();
    for (const ev of events) {
      const file = this.fileFor(ev);
      (byFile.get(file) ?? byFile.set(file, []).get(file)!).push(JSON.stringify(ev));
    }
    for (const [file, lines] of byFile) {
      appendFileSync(join(this.dir, file), lines.join('\n') + '\n', 'utf-8');
    }
    this.generation += 1;
    this.reindex();
  }

  async query(range: TimeRange, filters?: Filter[]): Promise<AnalyticsEvent[]> {
    const key = `${range.from}:${range.to}:${filters ? JSON.stringify(filters) : ''}`;
    if (this.cache && this.cache.key === key && this.cache.generation === this.generation) {
      return this.cache.events;
    }

    const allowRegex = this.allowRegex;
    const out: AnalyticsEvent[] = [];
    for (const segment of this.segments) {
      // Skip files that cannot overlap the range at all.
      if (segment.max < range.from || segment.min >= range.to) continue;
      for (const ev of this.readFile(segment.file)) {
        if (withinRange(ev, range) && matchesAll(ev, filters, { allowRegex })) out.push(ev);
      }
    }
    out.sort((a, b) => (a.time ?? 0) - (b.time ?? 0) || (a.event_id ?? 0) - (b.event_id ?? 0));

    this.cache = { key, generation: this.generation, events: out };
    return out;
  }

  async count(range?: TimeRange): Promise<number> {
    if (!range) {
      let n = 0;
      for (const s of this.segments) n += s.count;
      return n;
    }
    return (await this.query(range)).length;
  }

  async meta(): Promise<StoreMeta> {
    // Meta needs every property key, so it scans. Cached by generation upstream.
    const all: AnalyticsEvent[] = [];
    for (const segment of this.segments) all.push(...this.readFile(segment.file));
    return deriveMeta(all);
  }

  async appendAliases(aliases: UserAlias[]): Promise<void> {
    if (aliases.length === 0) return;
    appendFileSync(
      join(this.dir, ALIAS_FILE),
      aliases.map((a) => JSON.stringify(a)).join('\n') + '\n',
      'utf-8',
    );
  }

  async aliases(): Promise<UserAlias[]> {
    const path = join(this.dir, ALIAS_FILE);
    if (!existsSync(path)) return [];
    const out: UserAlias[] = [];
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line) as UserAlias);
      } catch {
        // Skip a torn line.
      }
    }
    return out;
  }

  async clear(): Promise<void> {
    for (const file of readdirSync(this.dir)) {
      if (file.endsWith('.jsonl')) writeFileSync(join(this.dir, file), '', 'utf-8');
    }
    this.generation += 1;
    this.cache = null;
    this.reindex();
  }

  /** Current segment index. Diagnostic hook. */
  segmentCount(): number {
    return this.segments.length;
  }
}
