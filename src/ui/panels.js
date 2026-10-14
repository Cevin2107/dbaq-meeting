import { el, clear } from './dom.js';
import { icon } from './icons.js';
import { toast } from './toast.js';
import { initials, colorFor } from '../lib/names.js';
import { formatChatTime } from '../lib/time.js';
import { linkify } from '../lib/linkify.js';
import { buildMeetingURL } from '../lib/codes.js';

/** Shared panel scaffold with a title and close button. */
function panelShell(title, onClose, ...content) {
  return el(
    'aside',
    { class: 'side-panel', role: 'complementary', 'aria-label': title },
    el(
      'div',
      { class: 'panel-header' },
      el('h2', {}, title),
      el('button', { class: 'icon-btn', 'aria-label': 'Close panel', onclick: onClose }, icon('close'))
    ),
    el('div', { class: 'panel-content' }, ...content)
  );
}

/**
 * Meeting details: shareable link + code with copy buttons, and — for the
 * host of a room — how the link is doing (`health`, a LinkHealth; see
 * lib/link-health.js). `dispose()` lets go of the subscription.
 */
export function buildInfoPanel({ code, persistent = false, health = null, onClose }) {
  const url = buildMeetingURL(code);
  // A status region: a screen reader hears the change when the link's
  // state moves — so it is only ever rewritten when the words change.
  const statusDot = el('span', { class: 'info-link-dot', 'aria-hidden': 'true' });
  const statusText = el('span', {}, '');
  const statusLine = el('div', { class: 'info-link-status', role: 'status' }, statusDot, statusText);
  const statusDetail = el('p', {});
  const statusSection = el('div', { class: 'info-link-health', hidden: true }, el('h3', {}, 'Link'), statusLine, statusDetail);
  const renderHealth = (snapshot) => {
    statusSection.hidden = !snapshot;
    if (!snapshot) return;
    statusSection.dataset.state = snapshot.state;
    if (statusText.textContent !== snapshot.label) statusText.textContent = snapshot.label;
    if (statusDetail.textContent !== snapshot.detail) statusDetail.textContent = snapshot.detail;
  };
  const disposeHealth = health ? health.on('change', renderHealth) : null;
  if (health) renderHealth(health.snapshot());

  const node = panelShell(
    'Meeting details',
    onClose,
    el(
      'div',
      { class: 'info-panel-body' },
      el('h3', {}, 'Joining info'),
      el('div', { class: 'info-link-box' }, url),
      el(
        'button',
        {
          class: 'btn btn-text',
          style: { alignSelf: 'flex-start' },
          onclick: () => copyText(url, 'Meeting link copied'),
        },
        icon('copy'),
        'Copy joining link'
      ),
      el('h3', {}, 'Meeting code'),
      el('div', { class: 'info-link-box' }, code),
      el(
        'button',
        {
          class: 'btn btn-text',
          style: { alignSelf: 'flex-start' },
          onclick: () => copyText(code, 'Meeting code copied'),
        },
        icon('copy'),
        'Copy meeting code'
      ),
      el(
        'p',
        {},
        persistent
          ? 'Share this link with people you want in the meeting. It never changes, so anyone with it can join whenever this meeting is running, today or next week.'
          : 'Share this link with people you want in the meeting. Anyone with the link can ask to join while the meeting is running.'
      ),
      health ? statusSection : null
    )
  );
  return { node, dispose: () => disposeHealth?.() };
}

/** Participants list; call refresh(roster) to re-render. */
export function buildPeoplePanel({ onClose }) {
  const list = el('div', { class: 'people-list scroll' });
  const node = panelShell('People', onClose, list);

  function refresh(roster) {
    // The list is rebuilt wholesale on every roster change — and someone
    // simply starting to talk is a roster change. Emptying a scroller
    // clamps its scrollTop to 0, so without this a reader scrolled into a
    // long participant list is yanked back to the top every few seconds.
    const scrollTop = list.scrollTop;
    clear(list);
    const everyone = roster.sorted();
    const raised = roster.raisedHands();

    if (raised.length) {
      list.append(el('div', { class: 'people-section-title' }, `Raised hands (${raised.length})`));
      for (const p of raised) list.append(personRow(p, true));
    }
    list.append(el('div', { class: 'people-section-title' }, `In call (${everyone.length})`));
    for (const p of everyone) list.append(personRow(p, false));
    // Clamped by the browser if the list got shorter (someone left).
    if (scrollTop) list.scrollTop = scrollTop;
  }

  function personRow(p, inHandSection) {
    // The icons are aria-hidden and a title on a span is not read out, so
    // each state icon names itself — or the row is just a name.
    const state = (label, iconName, className) =>
      el('span', { class: className, title: label, role: 'img', 'aria-label': label }, icon(iconName));
    const icons = [];
    if (p.hand && !inHandSection) icons.push(state('Hand raised', 'hand', 'hand-ic'));
    if (p.presenting) icons.push(state('Presenting', 'present'));
    icons.push(
      p.mic
        ? p.speaking
          ? state('Speaking', 'mic', 'speaking-ic')
          : state('Microphone on', 'mic')
        : state('Muted', 'micOff', 'muted-ic')
    );

    return el(
      'div',
      { class: 'person-row' },
      el('div', { class: 'avatar', style: { background: colorFor(p.name) } }, initials(p.name)),
      el(
        'div',
        { class: 'person-name' },
        el('div', { class: 'primary' }, p.name, p.isSelf ? ' (You)' : ''),
        p.reconnecting
          ? el('div', { class: 'secondary' }, 'Reconnecting…')
          : p.presenting
            ? el('div', { class: 'secondary' }, 'Presenting')
            : null
      ),
      el('div', { class: 'person-icons' }, ...icons)
    );
  }

  return { node, refresh };
}

/**
 * In-call chat. Messages live in the controller (survive panel close);
 * the panel renders them and appends new ones.
 */
export function buildChatPanel({ messages, onSend, onClose }) {
  const scroller = el('div', { class: 'chat-messages scroll' });
  const empty = el(
    'div',
    { class: 'chat-empty' },
    icon('chat'),
    el('span', {}, 'No messages yet'),
    el('span', {}, 'Messages can only be seen by people in the call and are deleted when the call ends.')
  );
  // Shown when a message lands while the reader is scrolled up in the
  // history — jumping them to the bottom would steal their place.
  const jumpBtn = el(
    'button',
    { class: 'chat-jump', hidden: true, onclick: () => scrollToEnd() },
    icon('arrowDown'),
    'New messages'
  );
  scroller.addEventListener('scroll', () => {
    if (nearBottom()) jumpBtn.hidden = true;
  });

  function nearBottom() {
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
  }

  function scrollToEnd() {
    scroller.scrollTop = scroller.scrollHeight;
    jumpBtn.hidden = true;
  }

  const input = el('input', {
    type: 'text',
    placeholder: 'Send a message to everyone',
    'aria-label': 'Chat message',
    maxlength: '4000',
    onkeydown: (e) => {
      // An IME's Enter commits the composition (CJK input); it isn't a send.
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) submit();
    },
    oninput: () => {
      sendBtn.disabled = !input.value.trim();
    },
  });
  const sendBtn = el(
    'button',
    { class: 'icon-btn chat-send', 'aria-label': 'Send message', disabled: true, onclick: submit },
    icon('send')
  );

  const node = panelShell(
    'In-call messages',
    onClose,
    el('div', { class: 'chat-notice' }, 'Messages are only visible to people in the call right now and are deleted when the call ends.'),
    messages.length ? scroller : empty,
    jumpBtn,
    el('div', { class: 'chat-input-row' }, input, sendBtn)
  );

  let lastSender = null;
  let lastTs = 0;

  for (const m of messages) appendMessage(m, false);
  queueMicrotask(() => {
    scroller.scrollTop = scroller.scrollHeight;
  });

  function submit() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    sendBtn.disabled = true;
    onSend(text);
    input.focus();
  }

  function appendMessage(m, scroll = true) {
    if (empty.isConnected) empty.replaceWith(scroller);
    // Decided before the append changes scrollHeight: stick to the bottom
    // only when the reader is already there (or just sent this message).
    const stick = nearBottom() || m.self;
    const compact = m.peerId === lastSender && m.ts - lastTs < 120000;
    lastSender = m.peerId;
    lastTs = m.ts;

    const item = el('div', { class: compact ? 'chat-msg compact' : 'chat-msg' });
    if (!compact) {
      item.append(
        el(
          'div',
          { class: 'chat-msg-head' },
          el('b', {}, m.self ? 'You' : m.name),
          el('time', {}, formatChatTime(m.ts))
        )
      );
    }
    item.append(chatBody(m.text));
    scroller.append(item);
    if (!scroll) return;
    if (stick) scrollToEnd();
    else jumpBtn.hidden = false;
  }

  return { node, appendMessage, focus: () => input.focus() };
}

/**
 * Message body with URLs turned into links. Segments are appended as text
 * nodes and <a> elements (never markup), so message text cannot inject HTML.
 */
function chatBody(text) {
  const body = el('div', { class: 'chat-msg-body' });
  for (const part of linkify(text)) {
    if (part.type !== 'link') {
      body.append(document.createTextNode(part.text));
      continue;
    }
    body.append(
      el(
        'a',
        {
          class: 'chat-link',
          href: part.href,
          target: '_blank',
          // noopener/noreferrer: a shared link must not reach back into the
          // call. nofollow/ugc: this text is user-generated.
          rel: 'noopener noreferrer nofollow ugc',
          // Hover shows the resolved target, which is punycode for lookalike
          // hosts.
          title: part.href,
        },
        part.text
      )
    );
  }
  return body;
}

export async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    toast(message, { icon: 'check' });
  } catch {
    toast('Copy failed. Select the text manually.', { icon: 'info' });
  }
}
