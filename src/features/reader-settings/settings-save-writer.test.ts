import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ReaderSettings } from '../../domain/types';
import { defaultSettings } from '../../repositories/reader-defaults';
import { SerializedSettingsSaveWriter, type SettingsSaveScheduler } from './settings-save-writer';
import { SettingsSlider } from './SettingsSlider';

class ManualScheduler implements SettingsSaveScheduler {
  private nextId = 0;
  private readonly callbacks = new Map<number, () => void>();

  set(callback: () => void): number {
    const id = ++this.nextId;
    this.callbacks.set(id, callback);
    return id;
  }

  clear(handle: unknown): void {
    this.callbacks.delete(handle as number);
  }

  runAll(): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    callbacks.forEach((callback) => callback());
  }
}

function settings(fontSize: number): ReaderSettings {
  return { ...defaultSettings, fontSize };
}

describe('SerializedSettingsSaveWriter', () => {
  it('coalesces trailing drafts and flushes the latest value', async () => {
    const scheduler = new ManualScheduler();
    const write = vi.fn(async () => undefined);
    const committed = vi.fn();
    const writer = new SerializedSettingsSaveWriter({
      delayMs: 300,
      scheduler,
      write,
      onCommitted: committed,
      onError: vi.fn(),
    });
    writer.schedule(settings(19));
    writer.schedule(settings(22));
    expect(write).not.toHaveBeenCalled();
    scheduler.runAll();
    await writer.flush();
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ fontSize: 22 }));
    expect(committed).toHaveBeenCalledWith(expect.objectContaining({ fontSize: 22 }));
  });

  it('serializes writes that become ready while an earlier save is running', async () => {
    const scheduler = new ManualScheduler();
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const writer = new SerializedSettingsSaveWriter({
      delayMs: 300,
      scheduler,
      write: async (value) => {
        order.push(`${value.fontSize}:start`);
        if (value.fontSize === 19) await new Promise<void>((resolve) => (releaseFirst = resolve));
        order.push(`${value.fontSize}:end`);
      },
      onCommitted: vi.fn(),
      onError: vi.fn(),
    });
    writer.schedule(settings(19));
    scheduler.runAll();
    await Promise.resolve();
    writer.schedule(settings(20));
    scheduler.runAll();
    await Promise.resolve();
    expect(order).toEqual(['19:start']);
    releaseFirst?.();
    await writer.flush();
    expect(order).toEqual(['19:start', '19:end', '20:start', '20:end']);
  });

  it('flushes on dispose and keeps the queue usable after a reported error', async () => {
    const scheduler = new ManualScheduler();
    const onError = vi.fn();
    const write = vi
      .fn<(value: ReaderSettings) => Promise<void>>()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValue(undefined);
    const writer = new SerializedSettingsSaveWriter({
      delayMs: 300,
      scheduler,
      write,
      onCommitted: vi.fn(),
      onError,
    });
    writer.schedule(settings(21));
    await writer.dispose();
    expect(onError).toHaveBeenCalledOnce();
    writer.schedule(settings(23));
    await writer.flush();
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith(expect.objectContaining({ fontSize: 23 }));
  });
});

describe('SettingsSlider accessibility', () => {
  it('links the visible label and current value to the range control', () => {
    const markup = renderToStaticMarkup(
      createElement(SettingsSlider, {
        label: '글자 크기',
        value: 18,
        min: 13,
        max: 28,
        step: 1,
        suffix: 'px',
        onChange: vi.fn(),
      }),
    );
    expect(markup).toContain('글자 크기');
    expect(markup).toContain('18px');
    expect(markup).toContain('aria-labelledby=');
    expect(markup).toContain('aria-valuetext="18px"');
    expect(markup).toContain('type="range"');
  });
});
