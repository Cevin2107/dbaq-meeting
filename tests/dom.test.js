// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { el, clear, append } from '../src/ui/dom.js';

describe('el', () => {
  it('creates elements with classes and attributes', () => {
    const node = el('button', { class: 'btn', 'aria-label': 'Close', disabled: true });
    expect(node.tagName).toBe('BUTTON');
    expect(node.className).toBe('btn');
    expect(node.getAttribute('aria-label')).toBe('Close');
    expect(node.hasAttribute('disabled')).toBe(true);
  });

  it('skips null/undefined/false attributes', () => {
    const node = el('div', { id: null, title: undefined, hidden: false });
    expect(node.hasAttribute('id')).toBe(false);
    expect(node.hasAttribute('title')).toBe(false);
    expect(node.hasAttribute('hidden')).toBe(false);
  });

  it('wires event listeners from on* props', () => {
    const fn = vi.fn();
    const node = el('button', { onclick: fn });
    node.click();
    expect(fn).toHaveBeenCalledOnce();
  });

  it('applies style objects and datasets', () => {
    const node = el('div', { style: { color: 'red' }, dataset: { tileId: 'x' } });
    expect(node.style.color).toBe('red');
    expect(node.dataset.tileId).toBe('x');
  });

  it('appends nested children, flattening arrays and skipping nullish', () => {
    const node = el('ul', {}, [el('li', {}, 'one'), null, [el('li', {}, 'two'), false]], 'tail');
    expect(node.querySelectorAll('li')).toHaveLength(2);
    expect(node.textContent).toBe('onetwotail');
  });

  it('stringifies non-node children', () => {
    const node = el('span', {}, 42);
    expect(node.textContent).toBe('42');
  });
});

describe('clear / append', () => {
  it('clear removes all children', () => {
    const node = el('div', {}, el('span'), el('span'));
    clear(node);
    expect(node.childNodes).toHaveLength(0);
  });

  it('append returns the node for chaining', () => {
    const node = el('div');
    expect(append(node, ['a', 'b'])).toBe(node);
    expect(node.textContent).toBe('ab');
  });
});
