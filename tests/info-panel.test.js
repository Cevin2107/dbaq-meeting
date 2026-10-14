// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { buildInfoPanel } from '../src/ui/panels.js';
import { LinkHealth } from '../src/lib/link-health.js';

/*
 * The meeting info panel shows the host how the link is doing — in a status
 * region, so a screen reader hears it move, and rewritten only when the
 * words change, so it is not re-announced on every heartbeat. Guests see no
 * such line; nor does a meeting without a room.
 */

function panelWith(health) {
  const panel = buildInfoPanel({ code: 'abc-defg-hij', persistent: true, health, onClose: vi.fn() });
  document.body.append(panel.node);
  return panel;
}

const section = (panel) => panel.node.querySelector('.info-link-health');
const status = (panel) => panel.node.querySelector('.info-link-status');

describe('the Link line in the meeting info panel', () => {
  it('reflects the state it is given, and follows it as it changes', () => {
    const health = new LinkHealth();
    health.role({ host: true });
    health.beat({ ok: true });
    const panel = panelWith(health);

    expect(section(panel).hidden).toBe(false);
    expect(status(panel).getAttribute('role')).toBe('status');
    expect(status(panel).textContent).toBe('Working');
    expect(section(panel).dataset.state).toBe('working');

    health.codeChanged();
    expect(status(panel).textContent).toBe('Refreshing…');
    expect(section(panel).dataset.state).toBe('refreshing');

    health.beat({ ok: false });
    expect(status(panel).textContent).toBe('Can’t be updated');
    expect(section(panel).querySelector('p').textContent).toMatch(/ask them to reopen the link/);

    health.beat({ ok: false, held: true });
    expect(status(panel).textContent).toBe('In use by another meeting');
    expect(section(panel).dataset.state).toBe('held');

    health.beat({ ok: true });
    expect(status(panel).textContent).toBe('Working');
  });

  it('does not rewrite the status text when nothing changed', () => {
    const health = new LinkHealth();
    health.role({ host: true });
    health.beat({ ok: true });
    const panel = panelWith(health);
    const textNode = status(panel).querySelector('span:last-child').firstChild;
    health.beat({ ok: true });
    health.beat({ ok: true });
    health.role({ host: true });
    // The very same text node: nothing was re-announced.
    expect(status(panel).querySelector('span:last-child').firstChild).toBe(textNode);
  });

  it('shows nothing to a guest, and appears once the host role is theirs', () => {
    const health = new LinkHealth();
    health.role({ host: false });
    const panel = panelWith(health);
    expect(section(panel).hidden).toBe(true);
    health.role({ host: true });
    expect(section(panel).hidden).toBe(false);
    expect(status(panel).textContent).toBe('Refreshing…');
  });

  it('has no line at all for a meeting without a room', () => {
    const panel = buildInfoPanel({ code: 'raw-invite-code', persistent: false, onClose: vi.fn() });
    expect(panel.node.querySelector('.info-link-health')).toBeNull();
    panel.dispose(); // harmless with nothing subscribed
  });

  it('stops following the state once disposed', () => {
    const health = new LinkHealth();
    health.role({ host: true });
    health.beat({ ok: true });
    const panel = panelWith(health);
    panel.dispose();
    health.beat({ ok: false });
    expect(status(panel).textContent).toBe('Working');
  });
});
