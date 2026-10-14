// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { buildChatPanel } from '../src/ui/panels.js';

const msg = (text, over = {}) => ({ peerId: 'p1', name: 'Ada', text, ts: Date.now(), self: false, ...over });

function panelFor(messages) {
  const panel = buildChatPanel({ messages, onSend: vi.fn(), onClose: vi.fn() });
  document.body.append(panel.node);
  return panel;
}

describe('chat message rendering', () => {
  it('renders URLs as links opening safely in a new tab', () => {
    const panel = panelFor([msg('see https://example.com/x for details')]);
    const body = panel.node.querySelector('.chat-msg-body');
    const link = body.querySelector('a');

    expect(body.textContent).toBe('see https://example.com/x for details');
    expect(link.textContent).toBe('https://example.com/x');
    expect(link.getAttribute('href')).toBe('https://example.com/x');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel').split(' ')).toEqual(
      expect.arrayContaining(['noopener', 'noreferrer'])
    );
    expect(link.getAttribute('title')).toBe('https://example.com/x');
  });

  it('links messages that arrive after the panel is open', () => {
    const panel = panelFor([]);
    panel.appendMessage(msg('www.example.com'));
    expect(panel.node.querySelector('.chat-msg-body a').getAttribute('href')).toBe(
      'https://www.example.com/'
    );
  });

  it('keeps messages without URLs as plain text', () => {
    const panel = panelFor([msg('hello there, run main.js')]);
    const body = panel.node.querySelector('.chat-msg-body');
    expect(body.querySelector('a')).toBeNull();
    expect(body.textContent).toBe('hello there, run main.js');
  });

  it('does not let message text inject markup', () => {
    const panel = panelFor([msg('<img src=x onerror=alert(1)> <b>bold</b> https://ok.com')]);
    const body = panel.node.querySelector('.chat-msg-body');

    expect(body.querySelector('img')).toBeNull();
    expect(body.querySelector('b')).toBeNull();
    expect(body.textContent).toBe('<img src=x onerror=alert(1)> <b>bold</b> https://ok.com');
    expect(body.querySelectorAll('a')).toHaveLength(1);
  });

  it('never emits a javascript: href', () => {
    const panel = panelFor([msg('javascript:alert(1) and "javascript:alert(2)"')]);
    const body = panel.node.querySelector('.chat-msg-body');
    expect(body.querySelector('a')).toBeNull();
    expect(body.textContent).toBe('javascript:alert(1) and "javascript:alert(2)"');
  });
});

describe('chat input', () => {
  it('does not send while an IME composition is being committed', () => {
    const onSend = vi.fn();
    const panel = buildChatPanel({ messages: [], onSend, onClose: vi.fn() });
    document.body.append(panel.node);
    const input = panel.node.querySelector('.chat-input-row input');

    input.value = 'こんにちは';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe('こんにちは');

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onSend).toHaveBeenCalledWith('こんにちは');
  });
});
