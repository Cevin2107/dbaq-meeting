import { el, clear } from './dom.js';
import { icon } from './icons.js';
import { toast } from './toast.js';
import { trapFocus } from './focus.js';
import { openBackgroundDialog } from './effects.js';
import { toggleTheme, effectiveTheme } from './theme.js';
import { TileGrid } from './tiles.js';
import { PictureInPicture, PipUnavailableError } from './pip.js';
import { buildInfoPanel, buildPeoplePanel, buildChatPanel } from './panels.js';
import { AudioLevelMonitor } from '../net/audio-levels.js';
import { formatClock, formatDuration } from '../lib/time.js';
import { displayCode, buildMeetingURL } from '../lib/codes.js';
import { getPref, setPref } from '../lib/prefs.js';
import { sounds } from '../lib/sound.js';
import { nicknameField } from './nickname.js';

const REACTIONS = ['💖', '👍', '🎉', '👏', '😂', '😮', '😢', '🤔'];

/**
 * The meeting room. Owns tiles, control bar, panels,
 * reactions, and active-speaker detection.
 *
 * @param {HTMLElement} root
 * @param {{media: import('../net/media.js').LocalMedia, session: import('../net/session.js').RoomSession}} call
 * @param {object} ctx
 * @returns {() => void} cleanup
 */
export function mountMeeting(root, call, ctx) {
  clear(root);
  const { media, session } = call;
  const { roster } = session;
  // Share the persistent room code when the meeting has one; the raw peer
  // invite code (legacy one-time links) otherwise. A room code is stable
  // for the life of the room, but a raw invite code follows the host —
  // when the role migrates, the new host serves a new one.
  let meetingCode = call.roomCode ?? session.code;

  // ---- state ----
  const chatMessages = [];
  const handsUp = new Set();
  let openPanelName = null;
  let openPanel = null;
  let chatPanel = null;
  let peoplePanel = null;
  let unreadChat = 0;
  const chatToasts = []; // dismissers for message previews still on screen
  let userPinnedId = null; // explicit pin from the user (overrides auto-pin)
  let autoPinnedId = null; // presentation auto-pin; a new one clears the user pin
  let reactionsOpen = false;
  let moreMenu = null;
  const disposers = [];

  const monitor = new AudioLevelMonitor();

  // ---- DOM ----
  const gridEl = el('div', { class: 'grid' });
  const reactionsLayer = el('div', { class: 'reactions-layer' });
  const stage = el('div', { class: 'stage' }, gridEl, reactionsLayer);
  const body = el('div', { class: 'meeting-body' }, stage);

  const clockEl = el('span', {}, formatClock());
  const durationEl = el('span', {}, '00:00');
  const codeEl = el(
    'button',
    { class: 'code-chip', title: 'Copy meeting link', 'aria-label': 'Copy meeting link', onclick: copyMeetingLink },
    el('span', { class: 'meeting-code' }, displayCode(meetingCode ?? '')),
    icon('copy')
  );
  const codeText = codeEl.firstChild;

  const micBtn = barToggle('mic', 'Turn off microphone (⌘/Ctrl+D)', () => media.setMicOn(!media.micOn));
  const camBtn = barToggle('cam', 'Turn off camera (⌘/Ctrl+E)', () => media.setCamOn(!media.camOn));
  const presentBtn = barToggle('present', 'Present now', togglePresent);
  const handBtn = barToggle('hand', 'Raise hand', () => {
    session.setHand(!session.hand);
    renderControls();
  });
  const reactBtn = barToggle('emoji', 'Send a reaction', toggleReactions);
  reactBtn.setAttribute('aria-haspopup', 'true');
  const moreBtn = barToggle('more', 'More options', toggleMoreMenu);
  moreBtn.setAttribute('aria-haspopup', 'menu');
  moreBtn.setAttribute('aria-expanded', 'false');
  const leaveBtn = el(
    'button',
    { class: 'leave-btn', 'aria-label': 'Leave call', title: 'Leave call', onclick: leaveCall },
    icon('callEnd')
  );

  const infoBtn = sideBtn('info', 'Meeting details', () => togglePanel('info'));
  const peopleBtn = sideBtn('people', 'People', () => togglePanel('people'));
  const chatBtn = sideBtn('chat', 'In-call messages', () => togglePanel('chat'));
  const peopleBadge = el('span', { class: 'badge badge-count' }, '1');
  const chatBadge = el('span', { class: 'badge', style: { display: 'none' } }, '0');
  peopleBtn.append(peopleBadge);
  chatBtn.append(chatBadge);

  const bar = el(
    'div',
    { class: 'meeting-bar' },
    el(
      'div',
      { class: 'meeting-meta' },
      clockEl,
      el('span', { class: 'sep' }),
      durationEl,
      el('span', { class: 'sep' }),
      codeEl
    ),
    el(
      'div',
      { class: 'meeting-controls' },
      micBtn,
      camBtn,
      presentBtn,
      handBtn,
      reactBtn,
      moreBtn,
      leaveBtn
    ),
    el('div', { class: 'meeting-side-controls' }, infoBtn, peopleBtn, chatBtn)
  );

  const view = el('div', { class: 'meeting' }, body, bar);
  root.append(view);

  const tileGrid = new TileGrid(gridEl, { onPin: onPinTile });
  // A second view of the same call, for when the reader has to work in
  // another tab. It borrows the tiles; the call itself never leaves here.
  const pip = new PictureInPicture({ media, host: view, onLeave: leaveCall });

  // ---- wiring ----

  disposers.push(
    roster.on('change', ({ type, participant }) => {
      refreshTiles();
      peoplePanel?.refresh(roster);
      renderPeopleBadge();
      if (type === 'add' && participant.hand) handsUp.add(participant.id);
      if (type === 'remove') handsUp.delete(participant.id);
      if (type === 'update') onParticipantUpdate(participant);
    }),

    session.on('peer-joined', ({ participant }) => {
      toast(`${participant.name} joined`, { icon: 'people' });
      sounds.join();
    }),

    session.on('host-migrating', () => {
      // The successor may take up to the claim deadline to appear — say why
      // the meeting suddenly went quiet instead of looking hung.
      toast('The host left the meeting. Finding a new host…', { icon: 'people' });
    }),

    session.on('host-changed', ({ name, self }) => {
      // Becoming host yourself needs no announcement — nothing changes for
      // you. When it's someone else, say so: it explains where control went.
      if (!self) toast(`${name} is hosting this meeting now.`, { icon: 'people' });
    }),

    session.on('code-changed', () => {
      // Only a room-less meeting's shareable code moves with the host.
      if (call.roomCode) return;
      meetingCode = session.code;
      codeText.textContent = displayCode(meetingCode ?? '');
      if (openPanelName === 'info') {
        closePanel();
        togglePanel('info');
      }
    }),

    session.on('peer-left', ({ participant }) => {
      toast(`${participant.name} left the meeting`, { icon: 'people' });
      sounds.leave();
      monitor.unwatch(participant.id);
    }),

    session.on('stream', ({ peerId, kind, stream }) => {
      if (kind === 'camera') monitor.watch(peerId, stream);
      if (kind === 'screen') autoPin(`${peerId}:screen`);
      refreshTiles();
    }),

    session.on('stream-removed', ({ peerId, kind }) => {
      if (kind === 'camera') monitor.unwatch(peerId);
      if (kind === 'screen' && autoPinnedId === `${peerId}:screen`) autoPinnedId = null;
      refreshTiles();
    }),

    session.on('chat', (m) => {
      chatMessages.push(m);
      if (openPanelName === 'chat') {
        chatPanel.appendMessage(m);
      } else if (!m.self) {
        // Only chime when the message would otherwise go unnoticed.
        unreadChat++;
        renderChatBadge();
        // The preview is the natural way in: pressing it opens the chat.
        chatToasts.push(
          toast(`${m.name}: ${m.text.slice(0, 80)}`, {
            icon: 'chat',
            duration: 6000,
            onClick: () => {
              if (openPanelName !== 'chat') togglePanel('chat');
            },
          })
        );
        sounds.message();
      }
    }),

    session.on('reaction', ({ peerId, name, emoji }) => {
      spawnFloatingEmoji(emoji, name);
      tileGrid.reactionBubble(peerId, emoji);
      pip.reactionBubble(peerId, emoji);
    }),

    session.on('status', ({ phase }) => {
      if (phase === 'failed') toast('Connection lost', { icon: 'info' });
    }),

    session.on('peer-link', ({ peerId, state }) => {
      const name = roster.get(peerId)?.name ?? 'Someone';
      if (state === 'lost') toast(`Connection to ${name} lost — reconnecting…`, { icon: 'info' });
      else toast(`Reconnected to ${name}`, { icon: 'info' });
    }),

    session.on('error', ({ message }) => toast(message, { icon: 'info' })),

    media.on('change', () => {
      renderControls();
      refreshTiles();
    }),

    media.on('audio-track', () => monitor.watch(session.selfId, media.stream)),

    media.on('screen', ({ on }) => {
      if (on) autoPin(`${session.selfId}:screen`);
      else if (autoPinnedId === `${session.selfId}:screen`) autoPinnedId = null;
      renderControls();
      refreshTiles();
    }),

    media.on('error', ({ message }) => toast(message, { icon: 'info' })),

    monitor.on('speaking', ({ id, speaking }) => {
      roster.update(id, { speaking });
    })
  );

  monitor.watch(session.selfId, media.stream);

  const resizeObserver = new ResizeObserver(() => tileGrid.layout());
  resizeObserver.observe(gridEl);

  const clockTimer = setInterval(() => {
    clockEl.textContent = formatClock();
    if (session.startedAt) durationEl.textContent = formatDuration(Date.now() - session.startedAt);
  }, 1000);

  window.addEventListener('keydown', onKeydown);
  window.addEventListener('resize', onWindowResize);
  document.addEventListener('click', onDocumentClick, true);

  renderControls();
  renderPanelButtons();
  refreshTiles();
  renderPeopleBadge();

  if (session.isHost) {
    toast('Your meeting is ready. Share the link to invite others.', { icon: 'check' });
    // On phones the info panel is a near-fullscreen sheet — don't cover
    // the freshly joined call with it.
    if (window.matchMedia('(min-width: 821px)').matches) togglePanel('info');
  }

  // ---- behaviors ----

  function refreshTiles() {
    const tiles = collectTiles();
    const ids = new Set(tiles.map((t) => t.id));
    // Drop a user pin whose tile is gone. The auto-pin is kept: its stream
    // can land a beat before the peer's `presenting` flag does, and the
    // presentation should still take the stage once its tile shows up. It
    // is cleared explicitly when the share ends.
    if (userPinnedId && !ids.has(userPinnedId)) userPinnedId = null;
    const pinnedId = userPinnedId ?? (ids.has(autoPinnedId) ? autoPinnedId : null);
    tileGrid.update(tiles);
    tileGrid.setPinned(pinnedId);
    pip.update({ tiles, pinnedId });
  }

  function collectTiles() {
    const tiles = [];
    for (const p of roster.sorted()) {
      const isSelf = p.isSelf;
      const stream = isSelf ? media.stream : session.getStream(p.id, 'camera');
      tiles.push({
        id: p.id,
        title: isSelf ? `${p.name} (You)` : p.name,
        colorSeed: p.name,
        stream,
        showVideo: isSelf ? media.camOn : !!(p.cam && stream),
        mirrored: isSelf,
        muted: isSelf,
        micOn: p.mic,
        hand: p.hand,
        reconnecting: !isSelf && !!p.reconnecting,
        speaking: p.speaking && p.mic,
        fit: 'cover',
        self: isSelf,
        screen: false,
      });
      const presenting = isSelf ? media.presenting : p.presenting;
      const screenStream = isSelf ? media.screenStream : session.getStream(p.id, 'screen');
      if (presenting && screenStream) {
        tiles.push({
          id: `${p.id}:screen`,
          title: isSelf ? 'Your presentation' : `${p.name} is presenting`,
          colorSeed: p.name,
          // Never play our capture back into the surface being captured.
          // These tiles also feed PiP; the outgoing stream stays in LocalMedia.
          stream: isSelf ? null : screenStream,
          showVideo: !isSelf,
          mirrored: false,
          muted: true,
          micOn: undefined,
          hand: false,
          reconnecting: !isSelf && !!p.reconnecting,
          speaking: false,
          fit: 'contain',
          self: isSelf,
          screen: true,
        });
      }
    }
    return tiles;
  }

  function onPinTile(id) {
    const onStage = userPinnedId ?? autoPinnedId;
    if (onStage === id) {
      // Unpin whatever is featured — including an auto-pinned presentation,
      // which otherwise would bounce straight back onto the stage.
      userPinnedId = null;
      if (autoPinnedId === id) autoPinnedId = null;
    } else {
      userPinnedId = id;
    }
    refreshTiles();
  }

  /**
   * A new presentation takes the stage (the next refreshTiles applies it),
   * even over a pin the user made earlier — that pin was about a call
   * without a presentation in it. A pin made *during* the share still wins,
   * and outlives it: the user chose it knowing what was on stage.
   */
  function autoPin(tileId) {
    autoPinnedId = tileId;
    userPinnedId = null;
  }

  function onParticipantUpdate(p) {
    if (p.hand && !handsUp.has(p.id)) {
      handsUp.add(p.id);
      if (!p.isSelf) {
        toast(`${p.name} raised their hand`, { icon: 'hand' });
        sounds.hand();
      }
    } else if (!p.hand) {
      handsUp.delete(p.id);
    }
  }

  function renderControls() {
    setToggle(micBtn, 'mic', media.micOn, 'microphone (⌘/Ctrl+D)');
    setToggle(camBtn, 'cam', media.camOn, 'camera (⌘/Ctrl+E)');

    clear(presentBtn).append(icon(media.presenting ? 'stopPresent' : 'present'));
    presentBtn.classList.toggle('active', media.presenting);
    setLabel(presentBtn, media.presenting ? 'Stop presenting' : 'Present now');
    presentBtn.setAttribute('aria-pressed', media.presenting ? 'true' : 'false');

    clear(handBtn).append(icon('hand'));
    handBtn.classList.toggle('active', session.hand);
    setLabel(handBtn, session.hand ? 'Lower hand' : 'Raise hand');
    handBtn.setAttribute('aria-pressed', session.hand ? 'true' : 'false');

    reactBtn.classList.toggle('active', reactionsOpen);
    reactBtn.setAttribute('aria-expanded', reactionsOpen ? 'true' : 'false');
  }

  function setToggle(btn, kind, on, label) {
    clear(btn).append(icon(on ? kind : `${kind}Off`));
    btn.classList.toggle('off', !on);
    setLabel(btn, `Turn ${on ? 'off' : 'on'} ${label}`);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  /** Tooltip and accessible name together — aria-label overrides title,
      so updating only the title leaves screen readers a stale name. */
  function setLabel(btn, label) {
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }

  function renderPeopleBadge() {
    const count = roster.size;
    peopleBadge.textContent = String(count);
    // aria-label wins over the badge text, so the count has to be in it.
    peopleBtn.setAttribute('aria-label', `People, ${count} in call`);
  }

  function renderChatBadge() {
    chatBadge.textContent = String(unreadChat);
    chatBadge.style.display = unreadChat > 0 ? '' : 'none';
    chatBtn.setAttribute(
      'aria-label',
      unreadChat > 0 ? `In-call messages, ${unreadChat} unread` : 'In-call messages'
    );
  }

  async function togglePresent() {
    try {
      if (media.presenting) media.stopScreenShare();
      else await media.startScreenShare();
    } catch (err) {
      if (err?.name !== 'NotAllowedError') toast('Screen sharing failed.', { icon: 'info' });
    }
  }

  /**
   * Float the meeting over other windows. The browser only allows it
   * straight off a click, so this stays on the click's own path — no
   * awaiting anything before asking.
   */
  async function togglePip() {
    try {
      await pip.toggle();
    } catch (err) {
      // Our own refusals say what the reader can do about it — pass the
      // reason through rather than replacing it with a shrug.
      if (err instanceof PipUnavailableError) toast(err.message, { icon: 'info' });
      else if (err?.name !== 'NotAllowedError' && err?.name !== 'AbortError') {
        toast('Picture-in-picture isn’t available right now.', { icon: 'info' });
      }
    }
  }

  // ---- reactions ----

  function toggleReactions() {
    reactionsOpen ? closeReactions() : openReactions();
  }

  function openReactions() {
    reactionsOpen = true;
    const barEl = el(
      'div',
      { class: 'reactions-bar', role: 'toolbar', 'aria-label': 'Reactions' },
      REACTIONS.map((emoji, i) =>
        el(
          'button',
          {
            'aria-label': `React with ${emoji}`,
            // A toolbar is one tab stop that moves focus with the arrow
            // keys, so only the entry point is tabbable.
            tabindex: i === 0 ? '0' : '-1',
            onclick: () => session.sendReaction(emoji),
          },
          emoji
        )
      )
    );
    view.append(barEl);
    placePopover(barEl, view.getBoundingClientRect().width / 2);
    liftToasts();
    renderControls();
    // Opening a popover without taking focus leaves a keyboard user on the
    // trigger, with the whole side of the control bar to tab through before
    // reaching what just appeared.
    barEl.querySelector('button')?.focus();
  }

  function closeReactions() {
    reactionsOpen = false;
    const barEl = view.querySelector('.reactions-bar');
    // Removing the focused button would drop focus to <body>.
    const hadFocus = !!barEl?.contains(document.activeElement);
    barEl?.remove();
    liftToasts();
    renderControls();
    if (hadFocus && reactBtn.isConnected) reactBtn.focus();
  }

  function spawnFloatingEmoji(emoji, name) {
    const x = 8 + Math.random() * 30; // left band, like Meet
    const node = el(
      'div',
      { class: 'float-emoji', style: { left: `${x}%` } },
      el('span', {}, emoji),
      el('span', { class: 'float-name' }, name)
    );
    reactionsLayer.append(node);
    setTimeout(() => node.remove(), 3400);
  }

  // ---- panels ----

  function togglePanel(name) {
    if (openPanelName === name) {
      closePanel();
      return;
    }
    closePanel();
    openPanelName = name;

    if (name === 'info') {
      openPanel = buildInfoPanel({
        code: meetingCode,
        persistent: !!call.roomCode,
        health: call.linkHealth ?? null,
        onClose: closePanel,
      });
    } else if (name === 'people') {
      peoplePanel = buildPeoplePanel({ onClose: closePanel });
      peoplePanel.refresh(roster);
      openPanel = peoplePanel;
    } else if (name === 'chat') {
      chatPanel = buildChatPanel({
        messages: chatMessages,
        onSend: (text) => session.sendChat(text),
        onClose: closePanel,
      });
      openPanel = chatPanel;
      unreadChat = 0;
      renderChatBadge();
      // The panel now shows every message; stale previews above it are noise.
      chatToasts.splice(0).forEach((dismiss) => dismiss());
      queueMicrotask(() => chatPanel.focus());
    }

    body.append(openPanel.node);
    renderPanelButtons();
    queueMicrotask(() => {
      tileGrid.layout();
      repositionPopovers();
    });
  }

  function closePanel() {
    openPanel?.dispose?.();
    openPanel?.node.remove();
    openPanel = null;
    chatPanel = null;
    peoplePanel = null;
    openPanelName = null;
    renderPanelButtons();
    queueMicrotask(() => {
      tileGrid.layout();
      repositionPopovers();
    });
  }

  function renderPanelButtons() {
    for (const [btn, name] of [[infoBtn, 'info'], [peopleBtn, 'people'], [chatBtn, 'chat']]) {
      btn.classList.toggle('panel-open', openPanelName === name);
      btn.setAttribute('aria-expanded', openPanelName === name ? 'true' : 'false');
    }
  }

  // ---- more menu / settings ----

  function toggleMoreMenu() {
    if (moreMenu) {
      closeMoreMenu();
      return;
    }
    const dark = effectiveTheme() === 'dark';
    moreMenu = el(
      'div',
      { class: 'menu menu-above-bar', role: 'menu' },
      menuItem('sparkle', 'Change background', () => {
        closeMoreMenu();
        // Focus the trigger so the dialog's focus trap knows where to
        // return focus when it closes (the menu item is gone by then).
        moreBtn.focus();
        openBackgroundDialog({ media });
      }),
      menuItem('settings', 'Settings', () => {
        closeMoreMenu();
        moreBtn.focus();
        openSettings();
      }),
      // No item where the page cannot go full screen (iPhone Safari) — one
      // that silently does nothing is worse than none.
      document.fullscreenEnabled || document.fullscreenElement
        ? menuItem(
            document.fullscreenElement ? 'fullscreenExit' : 'fullscreen',
            document.fullscreenElement ? 'Exit full screen' : 'Full screen',
            () => {
              closeMoreMenu();
              if (document.fullscreenElement) document.exitFullscreen?.()?.catch?.(() => {});
              else document.documentElement.requestFullscreen?.()?.catch?.(() => {});
            }
          )
        : null,
      pip.supported
        ? menuItem(
            pip.active ? 'pipExit' : 'pip',
            pip.active ? 'Exit picture-in-picture' : 'Picture-in-picture',
            () => {
              closeMoreMenu();
              moreBtn.focus();
              togglePip();
            }
          )
        : null,
      menuItem(dark ? 'sun' : 'moon', dark ? 'Switch to light theme' : 'Switch to dark theme', () => {
        closeMoreMenu();
        toggleTheme();
      }),
      el('hr', { class: 'menu-sep' }),
      menuItem('link', 'Copy meeting link', () => {
        closeMoreMenu();
        copyMeetingLink();
      })
    );
    view.append(moreMenu);
    moreBtn.setAttribute('aria-expanded', 'true');
    positionMoreMenu();
    liftToasts();
    // role="menu" promises keyboard semantics: focus lands inside, and the
    // arrow keys walk the items (see onKeydown).
    moreMenu.querySelector('.menu-item')?.focus();
  }

  // Anchor the menu over the three-dots button.
  function positionMoreMenu() {
    const btn = moreBtn.getBoundingClientRect();
    const bounds = view.getBoundingClientRect();
    placePopover(moreMenu, btn.left - bounds.left + btn.width / 2);
  }

  /**
   * Put a bar popover at `centerX` (relative to the view), kept inside the
   * area the stage actually occupies. On a desktop layout the side panel is
   * a column beside the stage rather than an overlay, so a popover centred
   * on the whole view opens on top of it — covering the chat composer or
   * the participant list it sits over. On phones the panel is a bottom
   * sheet these popovers are meant to float above, and the stage is the
   * full width, so nothing moves.
   */
  function placePopover(node, centerX) {
    const bounds = view.getBoundingClientRect();
    const usable = openPanel && window.matchMedia('(min-width: 821px)').matches
      ? stage.getBoundingClientRect()
      : bounds;
    const left = usable.left - bounds.left + 12;
    const right = usable.right - bounds.left - 12;
    const width = node.offsetWidth;
    // Too wide to fit beside the panel: centre it on the stage and let the
    // popover's own overflow handling deal with the rest.
    const x = width > right - left ? left + (right - left - width) / 2 : Math.min(Math.max(centerX - width / 2, left), right - width);
    node.style.left = `${Math.round(x)}px`;
    // The class centres with `translate`; an explicit left replaces that.
    node.style.translate = 'none';
  }

  /** Re-place whatever popovers are open (the stage just changed width). */
  function repositionPopovers() {
    if (moreMenu) positionMoreMenu();
    const barEl = view.querySelector('.reactions-bar');
    if (barEl) placePopover(barEl, view.getBoundingClientRect().width / 2);
    liftToasts();
  }

  /**
   * Toasts sit just above the control bar — exactly where these popovers
   * open. Joins, chat and raised hands arrive constantly, so the reaction
   * picker was regularly buried under a notification seconds after being
   * opened. Park the toast stack above whichever popover is up.
   */
  function liftToasts() {
    const host = document.getElementById('toasts');
    if (!host) return;
    const popover = moreMenu ?? view.querySelector('.reactions-bar');
    if (!popover) {
      host.style.bottom = '';
      return;
    }
    host.style.bottom = `${Math.round(window.innerHeight - popover.getBoundingClientRect().top + 12)}px`;
  }

  async function copyMeetingLink() {
    try {
      await navigator.clipboard.writeText(buildMeetingURL(meetingCode));
      toast('Meeting link copied', { icon: 'check' });
    } catch {
      // Clipboard blocked (an embedding page may not grant it) — make sure
      // the link is on screen to copy by hand, and say so: with the panel
      // already open the chip otherwise did nothing visible at all.
      if (openPanelName !== 'info') togglePanel('info');
      toast('Copy failed. Select the link in Meeting details to copy it.', { icon: 'info' });
    }
  }

  /** @param {{restoreFocus?: boolean}} [opts] false while the view tears down */
  function closeMoreMenu({ restoreFocus = true } = {}) {
    // Removing the focused item would drop focus to <body>.
    const hadFocus = !!moreMenu?.contains(document.activeElement);
    moreMenu?.remove();
    moreMenu = null;
    moreBtn.setAttribute('aria-expanded', 'false');
    liftToasts();
    if (restoreFocus && hadFocus && moreBtn.isConnected) moreBtn.focus();
  }

  function menuItem(iconName, label, onclick) {
    // role=menu on the container promises menuitem children — without them
    // assistive tech announces an empty menu, or a run of plain buttons.
    return el('button', { class: 'menu-item', role: 'menuitem', onclick }, icon(iconName), label);
  }

  async function openSettings() {
    const micSelect = el('select', { 'aria-label': 'Microphone' });
    const camSelect = el('select', { 'aria-label': 'Camera' });
    const spkSelect = el('select', { 'aria-label': 'Speakers' });

    const nsToggle = el('input', { type: 'checkbox', class: 'switch', role: 'switch' });
    nsToggle.checked = media.noiseSuppression;
    nsToggle.onchange = async () => {
      nsToggle.disabled = true;
      const ok = await media.setNoiseSuppression(nsToggle.checked);
      nsToggle.disabled = false;
      nsToggle.checked = media.noiseSuppression;
      // Failures surface as a toast through the media 'error' listener;
      // only persist what actually worked.
      if (ok) setPref('noiseSuppression', media.noiseSuppression);
    };

    const backdrop = el(
      'div',
      {
        class: 'dialog-backdrop',
        onclick: (e) => {
          if (e.target === backdrop) backdrop.remove();
        },
      },
      el(
        'div',
        { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Settings', tabindex: '-1' },
        el(
          'div',
          { class: 'dialog-header' },
          el('h2', {}, 'Settings'),
          el('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => backdrop.remove() }, icon('close'))
        ),
        el(
          'div',
          { class: 'dialog-body' },
          nicknameField({ ctx, session }),
          el('div', {}, el('label', { class: 'field-label' }, 'Microphone'), el('div', { class: 'select-field' }, icon('mic'), micSelect)),
          el('div', {}, el('label', { class: 'field-label' }, 'Camera'), el('div', { class: 'select-field' }, icon('cam'), camSelect)),
          el('div', {}, el('label', { class: 'field-label' }, 'Speakers'), el('div', { class: 'select-field' }, icon('volume'), spkSelect)),
          el(
            'label',
            { class: 'toggle-field' },
            el(
              'span',
              { class: 'toggle-text' },
              el('span', { class: 'toggle-title' }, 'Noise suppression'),
              el('span', { class: 'toggle-sub' }, 'Filters out background noise like typing, fans, and traffic')
            ),
            nsToggle
          ),
          el(
            'div',
            {},
            el('label', { class: 'field-label' }, 'Keyboard shortcuts'),
            el(
              'div',
              { class: 'shortcut-list' },
              el('kbd', {}, '⌘/Ctrl + D'),
              el('span', {}, 'Toggle microphone'),
              el('kbd', {}, '⌘/Ctrl + E'),
              el('span', {}, 'Toggle camera'),
              el('kbd', {}, 'Esc'),
              el('span', {}, 'Close panels and menus')
            )
          )
        )
      )
    );
    document.body.append(backdrop);
    const dialogEl = backdrop.querySelector('.dialog');
    if (dialogEl) trapFocus(dialogEl); // before focus moves — it restores to the current element
    dialogEl?.focus();

    try {
      const { mics, cams, speakers } = await media.listDevices();
      fill(micSelect, mics, media.micId);
      fill(camSelect, cams, media.camId);
      fill(spkSelect, speakers, getPref('speakerId'));
      micSelect.onchange = async () => {
        await media.setMicDevice(micSelect.value);
        setPref('micId', micSelect.value);
      };
      camSelect.onchange = async () => {
        await media.setCamDevice(camSelect.value);
        setPref('camId', camSelect.value);
        refreshTiles();
      };
      spkSelect.onchange = async () => {
        setPref('speakerId', spkSelect.value);
        await tileGrid.setSink(spkSelect.value);
      };
    } catch {
      /* device enumeration unavailable */
    }

    function fill(select, devices, currentId) {
      clear(select);
      if (!devices.length) {
        select.append(el('option', { value: '' }, 'Not available'));
        select.disabled = true;
        return;
      }
      devices.forEach((d, i) => select.append(el('option', { value: d.deviceId }, d.label || `Device ${i + 1}`)));
      if (currentId && devices.some((d) => d.deviceId === currentId)) select.value = currentId;
    }
  }

  // ---- global handlers ----

  function onKeydown(e) {
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');
    // The device shortcuts stay out of a text box. Ctrl+D and Ctrl+E are
    // macOS text-editing bindings — delete-forward and end-of-line — so
    // in the chat composer these swallowed the keystroke and toggled a
    // device instead of editing the message.
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && !isTextEntry(document.activeElement)) {
      if (e.key === 'd' || e.key === 'D') {
        e.preventDefault();
        media.setMicOn(!media.micOn);
        return;
      }
      if (e.key === 'e' || e.key === 'E') {
        e.preventDefault();
        media.setCamOn(!media.camOn);
        return;
      }
    }
    if (e.key === 'Escape') {
      // A dialog closes regardless of where focus sits — its own selects
      // and switches are exactly where focus lives while it is open.
      const dialog = document.querySelector('.dialog-backdrop');
      if (dialog) {
        dialog.remove();
        return;
      }
      if (inField) return; // e.g. typing in chat — don't close the panel
      if (moreMenu) closeMoreMenu();
      else if (reactionsOpen) closeReactions();
      else if (openPanelName) closePanel();
      return;
    }

    // The open popovers say role="menu" and role="toolbar", both of which
    // promise the arrow keys move between items. Only while focus is
    // actually inside one, though — a popover left open behind a chat
    // message must not take the arrow keys away from the caret.
    const focused = document.activeElement;
    if (moreMenu?.contains(focused)) {
      rove(e, [...moreMenu.querySelectorAll('.menu-item')], 'ArrowDown', 'ArrowUp');
      return;
    }
    const barEl = reactionsOpen ? view.querySelector('.reactions-bar') : null;
    if (barEl?.contains(focused)) {
      rove(e, [...barEl.querySelectorAll('button')], 'ArrowRight', 'ArrowLeft', { roving: true });
    }
  }

  /**
   * Move focus between `items` with a pair of arrow keys, wrapping at both
   * ends. `roving` also carries the single tab stop along, which is what a
   * toolbar wants and a menu has no need of.
   */
  function rove(e, items, forwardKey, backKey, { roving = false } = {}) {
    const step = e.key === forwardKey ? 1 : e.key === backKey ? -1 : 0;
    if (!step || !items.length) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement);
    const next = items[(at + step + items.length) % items.length];
    if (roving) for (const item of items) item.tabIndex = item === next ? 0 : -1;
    next.focus();
  }

  function onWindowResize() {
    repositionPopovers();
  }

  function onDocumentClick(e) {
    // Close popovers when clicking outside them.
    if (moreMenu && !moreMenu.contains(e.target) && !moreBtn.contains(e.target)) closeMoreMenu();
    if (reactionsOpen) {
      const barEl = view.querySelector('.reactions-bar');
      if (barEl && !barEl.contains(e.target) && !reactBtn.contains(e.target)) closeReactions();
    }
  }

  function leaveCall() {
    ctx.endCall();
  }

  // Apply saved speaker preference.
  const savedSpeaker = getPref('speakerId');
  if (savedSpeaker) tileGrid.setSink(savedSpeaker);

  // ---- cleanup ----

  return () => {
    for (const dispose of disposers) dispose();
    openPanel?.dispose?.();
    window.removeEventListener('keydown', onKeydown);
    window.removeEventListener('resize', onWindowResize);
    document.removeEventListener('click', onDocumentClick, true);
    clearInterval(clockTimer);
    resizeObserver.disconnect();
    monitor.close();
    pip.destroy();
    closeMoreMenu({ restoreFocus: false });
    tileGrid.destroy();
    const toastHost = document.getElementById('toasts');
    if (toastHost) toastHost.style.bottom = ''; // #toasts outlives this view
    document.querySelector('.dialog-backdrop')?.remove();
  };
}

function barToggle(iconName, title, onclick) {
  return el(
    'button',
    { class: iconName === 'mic' || iconName === 'cam' ? 'round-ctl' : 'bar-btn', title, 'aria-label': title, onclick },
    icon(iconName)
  );
}

function sideBtn(iconName, title, onclick) {
  return el('button', { class: 'bar-btn', title, 'aria-label': title, onclick }, icon(iconName));
}

/** Inputs that hold a caret, where a typed key is the user editing text. */
const TEXT_ENTRY_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', 'password', 'number']);

/**
 * Whether the keyboard is in a text-entry context — a caret the user is
 * editing, rather than a button or a select. Exported for the shortcut
 * tests.
 * @param {Element|null} node
 */
export function isTextEntry(node) {
  if (!node) return false;
  if (node.isContentEditable) return true;
  if (node.tagName === 'TEXTAREA') return true;
  return node.tagName === 'INPUT' && TEXT_ENTRY_TYPES.has(node.type);
}
