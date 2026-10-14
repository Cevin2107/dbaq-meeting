// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { toast } from '../src/ui/toast.js';

describe('toast', () => {
  let host;

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement('div');
    host.id = 'toasts';
    document.body.append(host);
  });

  afterEach(() => {
    host.remove();
    vi.useRealTimers();
  });

  it('renders a plain toast as non-interactive text', () => {
    toast('Someone joined');
    const node = host.firstElementChild;
    expect(node.tagName).toBe('DIV');
    expect(node.classList.contains('clickable')).toBe(false);
    expect(node.textContent).toBe('Someone joined');
  });

  it('renders a clickable toast as a button that runs onClick and dismisses itself', () => {
    const onClick = vi.fn();
    toast('Ada: hi there', { onClick });
    const node = host.firstElementChild;
    expect(node.tagName).toBe('BUTTON');
    expect(node.getAttribute('type')).toBe('button');
    expect(node.classList.contains('clickable')).toBe(true);

    node.click();
    expect(onClick).toHaveBeenCalledOnce();
    expect(node.classList.contains('leaving')).toBe(true);
    vi.advanceTimersByTime(250);
    expect(host.children.length).toBe(0);
  });

  it('runs onClick at most once even if pressed again while leaving', () => {
    const onClick = vi.fn();
    toast('Ada: hi there', { onClick });
    const node = host.firstElementChild;
    node.click();
    node.click();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('dismisses on its own after the duration', () => {
    toast('Ada: hi there', { onClick: () => {}, duration: 6000 });
    vi.advanceTimersByTime(5999);
    expect(host.firstElementChild.classList.contains('leaving')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(host.firstElementChild.classList.contains('leaving')).toBe(true);
  });

  it('returns a dismisser that removes the toast early', () => {
    const dismiss = toast('Ada: hi there', { onClick: () => {} });
    dismiss();
    vi.advanceTimersByTime(250);
    expect(host.children.length).toBe(0);
  });
});
