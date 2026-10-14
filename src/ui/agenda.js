import { el, clear } from './dom.js';
import { icon } from './icons.js';
import { formatDay } from '../lib/time.js';
import {
  DAY_MS,
  startOfDay,
  addDays,
  nextDayStart,
  isSameDay,
  firstDayOfWeek,
  startOfWeek,
  weekDays,
  toMeeting,
  onDay,
  statusOf,
  splitPast,
  nextUp,
  covered,
  addRange,
  windowFor,
  mergeWindow,
  readAgendaCache,
  writeAgendaCache,
  formatRange,
  dayLabel,
  guestsLabel,
} from '../lib/agenda.js';

/** A list older than this is re-read when the window comes back to the front. */
const STALE_MS = 60_000;
/** How often "now" moves: a running meeting's badge, a finished one sliding
 *  down to "Earlier", the date rolling over at midnight. */
const TICK_MS = 30_000;

/**
 * "Your meetings": the day's meetings from the Calendar app, with a Join
 * button on each — the home screen's answer to digging the link out of an
 * email. Google Meet–style: a week strip to pick a day, that day's list split
 * into what is still to come and what is over, and when the day is empty,
 * the next meeting anywhere ahead.
 *
 * Data comes from lib/calendar.js (the Calendar's app-to-app API, desktop
 * only); the panel is only mounted where that is supported. A snapshot of
 * the last answer paints the list at once while the Calendar is asked again,
 * so the usual open is instant and honest at the same time.
 *
 * @param {HTMLElement} host where the panel is appended
 * @param {object} opts
 * @param {object} opts.calendar the client from lib/calendar.js
 * @param {object} opts.ctx the app context (openPrejoin)
 * @param {string|Promise<string>} [opts.userKey] scopes the snapshot to the
 *   account; empty means no snapshot is read or written
 * @param {() => number} [opts.now]
 * @param {string} [opts.locale]
 * @param {() => void} [opts.openCalendar] opens the Calendar app itself
 * @returns {() => void} cleanup
 */
export function mountAgenda(host, { calendar, ctx, userKey = '', now = () => Date.now(), locale, openCalendar }) {
  const firstDay = firstDayOfWeek(locale);
  const ownOrigin = typeof location !== 'undefined' ? location.origin + location.pathname : '';

  let selected = startOfDay(now());
  let weekStart = startOfWeek(selected, firstDay);
  let todayStart = selected;
  const byId = new Map(); // meeting id -> meeting
  let ranges = []; // windows whose data is current: read since the last refresh
  let known = []; // windows ever read (this session, or the snapshot) — the days the panel can speak for
  let fetchedAt = 0; // when the last read landed (a snapshot's savedAt counts)
  let loading = false; // a read is under way or waiting its turn
  let error = null; // the last failed read's error, until a read succeeds
  let fromSnapshot = false; // is what's shown the stored snapshot?
  let key = '';
  let alive = true;

  /* ---- Static frame --------------------------------------------------- */

  const titleId = `agenda-title-${Math.random().toString(36).slice(2, 8)}`;
  const title = el('h2', { class: 'agenda-title', id: titleId });
  const subtitle = el('span', { class: 'agenda-subtitle' });
  const todayBtn = el(
    'button',
    { class: 'btn btn-text agenda-today', type: 'button', onclick: () => select(startOfDay(now())) },
    'Today'
  );
  const prevBtn = el(
    'button',
    { class: 'icon-btn', type: 'button', 'aria-label': 'Previous week', title: 'Previous week', onclick: () => shiftWeek(-1) },
    icon('chevronLeft')
  );
  const nextBtn = el(
    'button',
    { class: 'icon-btn', type: 'button', 'aria-label': 'Next week', title: 'Next week', onclick: () => shiftWeek(1) },
    icon('chevronRight')
  );
  const strip = el('div', { class: 'agenda-strip', role: 'group', onkeydown: onStripKeydown });
  const body = el('div', { class: 'agenda-body' });
  const status = el('span', { class: 'agenda-status', role: 'status' });
  const refreshBtn = el(
    'button',
    { class: 'icon-btn agenda-refresh', type: 'button', 'aria-label': 'Refresh', title: 'Refresh', onclick: () => refresh({ manual: true }) },
    icon('refresh')
  );

  const panel = el(
    'section',
    { class: 'agenda', 'aria-labelledby': titleId },
    el(
      'div',
      { class: 'agenda-head' },
      el('div', { class: 'agenda-heading' }, title, subtitle),
      el('div', { class: 'agenda-nav' }, todayBtn, prevBtn, nextBtn)
    ),
    strip,
    body,
    el(
      'div',
      { class: 'agenda-foot' },
      el('span', { class: 'agenda-source' }, icon('calendar'), 'From Calendar'),
      status,
      refreshBtn
    )
  );
  host.append(panel);

  /* ---- Rendering ------------------------------------------------------ */

  const meetings = () => [...byId.values()];
  const hasData = () => fetchedAt > 0;

  function renderHead() {
    title.textContent = dayLabel(selected, todayStart, locale);
    // Today/Tomorrow/Yesterday get the date as a subtitle; further out the
    // title is the date already. Counted in calendar days — raw milliseconds
    // read a 23-hour day as "not two days" and doubled the date up.
    subtitle.textContent = Math.abs(Math.round((selected - todayStart) / DAY_MS)) < 2
      ? formatDay(new Date(selected), locale)
      : '';
    todayBtn.disabled = isSameDay(selected, todayStart);
    strip.setAttribute('aria-label', `Week of ${formatDay(new Date(weekStart), locale)}`);
  }

  function renderStrip() {
    rebuild(strip, () => {
      const all = meetings();
      for (const day of weekDays(weekStart)) buildDay(day, all);
    });
  }

  function buildDay(day, all) {
    const count = onDay(all, day).length;
    const date = new Date(day);
    const isSelected = day === selected;
    const isToday = day === todayStart;
    const label = date.toLocaleDateString(locale, { weekday: 'long', month: 'long', day: 'numeric' });
    strip.append(
      el(
        'button',
        {
          class: `agenda-day${isSelected ? ' is-selected' : ''}${isToday ? ' is-today' : ''}${count ? ' has-meetings' : ''}`,
          type: 'button',
          'aria-pressed': String(isSelected),
          'aria-label': count ? `${label}, ${count === 1 ? '1 meeting' : `${count} meetings`}` : label,
          tabindex: isSelected ? '0' : '-1',
          dataset: { day: String(day), focusKey: `day:${day}` },
          onclick: () => select(day),
        },
        el('span', { class: 'agenda-dow' }, date.toLocaleDateString(locale, { weekday: 'short' })),
        el('span', { class: 'agenda-dom' }, String(date.getDate())),
        el('span', { class: 'agenda-dot', 'aria-hidden': 'true' })
      )
    );
  }

  /**
   * Empty `node` and fill it again with `build()`, keeping keyboard focus on
   * the control it was on. Everything here is rebuilt wholesale — when a read
   * lands, and every half minute for the body — and rebuilding the focused
   * button drops focus to <body>: the arrow keys stop working on the strip,
   * a reader parked on Join is thrown out. Controls that should survive a
   * rebuild carry a data-focus-key naming them.
   */
  function rebuild(node, build) {
    const active = document.activeElement;
    const focused = node.contains(active) ? active.dataset?.focusKey ?? null : null;
    clear(node);
    build();
    if (focused === null) return;
    for (const candidate of node.querySelectorAll('[data-focus-key]')) {
      if (candidate.dataset.focusKey === focused) {
        candidate.focus();
        break;
      }
    }
  }

  function renderBody() {
    rebuild(body, buildBody);
  }

  /** Whether the selected day lies inside a window that has been read. */
  const selectedKnown = () => covered(known, selected, nextDayStart(selected));

  function buildBody() {
    const t = now();
    const all = meetings();
    const day = onDay(all, selected);

    if (day.length) {
      const { ahead, past } = splitPast(day, t);
      const isToday = isSameDay(selected, todayStart);
      if (ahead.length) body.append(section(isToday && past.length ? 'Upcoming' : null, ahead, t));
      if (past.length) body.append(section(isToday ? 'Earlier today' : ahead.length ? 'Earlier' : null, past, t));
      return;
    }

    // A day that has never been read is not empty, it is unread: the days
    // outside the snapshot's window, or a week clicked to while a read is
    // still under way, must not be painted as confidently free.
    if (!selectedKnown()) {
      body.append(loading || !error ? skeleton() : errorState());
      return;
    }

    // An empty day. Say so, and point at what is coming.
    const next = nextUp(all, t, selected);
    const empty = el('div', { class: 'agenda-empty' });
    const when = isSameDay(selected, todayStart)
      ? 'today'
      : selected > todayStart
        ? `on ${formatDay(new Date(selected), locale)}`
        : `on ${formatDay(new Date(selected), locale)}`;
    empty.append(el('p', { class: 'agenda-empty-title' }, `No meetings ${when}`));
    if (next) {
      const nextDay = startOfDay(next.start);
      empty.append(
        el(
          'button',
          { class: 'agenda-next', type: 'button', dataset: { focusKey: 'next' }, onclick: () => select(nextDay) },
          el('span', { class: 'agenda-next-label' }, 'Next up'),
          el(
            'span',
            { class: 'agenda-next-body' },
            el('span', { class: 'agenda-next-when' }, `${dayLabel(nextDay, todayStart, locale)} · ${formatRange(next, locale)}`),
            el('span', { class: 'agenda-next-title' }, next.title)
          ),
          icon('chevronRight')
        )
      );
    } else if (all.length === 0) {
      empty.append(
        el(
          'p',
          { class: 'agenda-empty-hint' },
          'Meetings from your calendar show up here. Add a Puter Meetings link to an event in Calendar, and it is one click away.'
        )
      );
      if (openCalendar) {
        empty.append(
          el(
            'button',
            { class: 'btn btn-outline agenda-open-calendar', type: 'button', dataset: { focusKey: 'open-calendar' }, onclick: openCalendar },
            icon('calendar'),
            'Open Calendar'
          )
        );
      }
    }
    body.append(empty);
  }

  function section(heading, items, t) {
    const list = el('ul', { class: 'agenda-list' });
    for (const m of items) list.append(row(m, t));
    return el('div', { class: 'agenda-section' }, heading ? el('h3', { class: 'agenda-section-title' }, heading) : null, list);
  }

  function row(m, t) {
    const state = statusOf(m, t);
    const meta = [guestsLabel(m.guests), m.recurring ? 'Repeats' : ''].filter(Boolean).join(' · ');
    const badge =
      state === 'now'
        ? el('span', { class: 'agenda-badge is-now' }, 'Now')
        : state === 'soon'
          ? el('span', { class: 'agenda-badge' }, 'Starting soon')
          : null;
    const action = m.code
      ? el(
          'button',
          {
            class: `btn agenda-join ${state === 'now' || state === 'soon' ? 'btn-primary' : 'btn-tonal'}`,
            type: 'button',
            'aria-label': `Join ${m.title}`,
            dataset: { focusKey: `join:${m.id}` },
            onclick: () => ctx.openPrejoin({ mode: 'join', code: m.code }),
          },
          icon('videoCall'),
          'Join'
        )
      : el(
          'a',
          {
            class: 'btn btn-outline agenda-join',
            href: m.url,
            target: '_blank',
            rel: 'noopener noreferrer',
            'aria-label': `Open the link for ${m.title} in a new tab`,
            dataset: { focusKey: `join:${m.id}` },
          },
          icon('openInNew'),
          'Open link'
        );
    return el(
      'li',
      { class: `agenda-item is-${state}`, dataset: { id: m.id } },
      el(
        'div',
        { class: 'agenda-item-main' },
        el('div', { class: 'agenda-item-time' }, formatRange(m, locale), badge),
        el('div', { class: 'agenda-item-title', title: m.title }, m.title),
        meta ? el('div', { class: 'agenda-item-meta' }, meta) : null
      ),
      action
    );
  }

  function skeleton() {
    const ghost = () =>
      el(
        'li',
        { class: 'agenda-item is-skeleton', 'aria-hidden': 'true' },
        el('div', { class: 'agenda-item-main' }, el('div', { class: 'agenda-item-time' }), el('div', { class: 'agenda-item-title' })),
        el('div', { class: 'agenda-join' })
      );
    return el('ul', { class: 'agenda-list', 'aria-busy': 'true', 'aria-label': 'Loading your meetings' }, ghost(), ghost());
  }

  function errorState() {
    return el(
      'div',
      { class: 'agenda-empty' },
      el('p', { class: 'agenda-empty-title' }, 'Couldn’t reach Calendar'),
      el('p', { class: 'agenda-empty-hint' }, 'Your meetings will show here once the Calendar app answers.'),
      el(
        'button',
        { class: 'btn btn-outline', type: 'button', dataset: { focusKey: 'retry' }, onclick: () => refresh({ manual: true }) },
        icon('refresh'),
        'Try again'
      )
    );
  }

  function renderFoot() {
    refreshBtn.disabled = loading;
    refreshBtn.classList.toggle('is-spinning', loading);
    if (loading) status.textContent = hasData() ? 'Updating…' : 'Loading…';
    else if (error && hasData()) status.textContent = 'Couldn’t update from Calendar';
    else if (fromSnapshot && hasData()) status.textContent = 'Last known';
    else status.textContent = '';
  }

  function render() {
    renderHead();
    renderStrip();
    renderBody();
    renderFoot();
  }

  /* ---- Navigation ----------------------------------------------------- */

  function select(day, { focus = false } = {}) {
    selected = startOfDay(day);
    const ws = startOfWeek(selected, firstDay);
    if (ws !== weekStart) weekStart = ws;
    render();
    if (focus) strip.querySelector('.agenda-day.is-selected')?.focus();
    void ensure();
  }

  function shiftWeek(n) {
    select(addDays(selected, 7 * n));
  }

  function onStripKeydown(e) {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      select(addDays(selected, e.key === 'ArrowLeft' ? -1 : 1), { focus: true });
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      select(e.key === 'Home' ? weekStart : addDays(weekStart, 6), { focus: true });
    }
  }

  /* ---- Data ----------------------------------------------------------- */

  /** Make sure the visible week has been read this session. */
  function ensure() {
    const w = windowFor(weekStart, startOfWeek(todayStart, firstDay));
    if (covered(ranges, w.from, w.to)) return Promise.resolve();
    return read(w);
  }

  /**
   * Read the visible window again, whatever we hold. `manual` also lifts a
   * backoff — the user asked, so one launch attempt is theirs to spend.
   * Everything read earlier this session is stale from here: it is read
   * again when the user next goes there (what is shown stays on screen
   * meanwhile — see `known`).
   */
  function refresh({ manual = false } = {}) {
    if (manual) calendar.clearBackoff?.();
    ranges = [];
    return read(windowFor(weekStart, startOfWeek(todayStart, firstDay)), { force: true });
  }

  /*
   * Reads run one at a time, in the order they were asked for. The Calendar
   * is launched in the background and answers a second or two later, and
   * plenty happens in that time: the user clicks to another week, the window
   * comes to the front, the Calendar says it changed. Each of those is a
   * read that has to happen *after* the one under way — not be folded into
   * it and forgotten, which is what left a week unread (painted as empty) or
   * a refresh that never ended, its spinner stuck. A queued read that turns
   * out to be covered by the time its turn comes is skipped; one asked for
   * twice is queued once.
   */
  const queue = []; // { w, force, done, settle }
  let running = false;

  function read(w, { force = false } = {}) {
    const same = queue.find((job) => job.w.from === w.from && job.w.to === w.to);
    if (same) {
      same.force ||= force;
      return same.done;
    }
    let settle;
    const done = new Promise((resolve) => {
      settle = resolve;
    });
    queue.push({ w, force, done, settle });
    loading = true;
    renderFoot();
    if (!selectedKnown()) renderBody(); // the skeleton, for a day we have nothing on yet
    void pump();
    return done;
  }

  async function pump() {
    if (running) return;
    running = true;
    try {
      while (queue.length && alive) {
        const job = queue.shift();
        try {
          await perform(job);
        } finally {
          job.settle();
        }
        if (alive) {
          loading = queue.length > 0;
          render();
        }
      }
    } finally {
      running = false;
      for (const job of queue.splice(0)) job.settle(); // torn down with reads still waiting
    }
  }

  async function perform({ w, force }) {
    // Read earlier in the queue's run (a refresh covering this week): done.
    if (!force && covered(ranges, w.from, w.to)) return;
    if (!calendar.available()) {
      // Backing off after a failure: don't launch, but say so.
      if (!error) error = new Error('Calendar is not available right now');
      return;
    }
    try {
      const { events } = await calendar.listMeetings({ from: w.from, to: w.to });
      if (!alive) return;
      const fresh = events.map((ev) => toMeeting(ev, { ownOrigin })).filter(Boolean);
      mergeWindow(byId, fresh, w.from, w.to);
      ranges = addRange(ranges, w.from, w.to);
      known = addRange(known, w.from, w.to);
      fetchedAt = now();
      error = null;
      fromSnapshot = false;
      if (key) writeAgendaCache(key, { savedAt: fetchedAt, from: w.from, to: w.to, meetings: meetings() });
    } catch (err) {
      if (!alive) return;
      error = err;
    }
  }

  /** Paint the stored snapshot, if there is one for this account. */
  function hydrate() {
    const snap = readAgendaCache(key, { ownOrigin });
    if (!snap) return;
    mergeWindow(byId, snap.meetings, snap.from, snap.to);
    ranges = addRange(ranges, snap.from, snap.to);
    known = addRange(known, snap.from, snap.to);
    fetchedAt = snap.savedAt;
    fromSnapshot = true;
  }

  /* ---- Lifecycle ------------------------------------------------------ */

  render();
  Promise.resolve(userKey)
    .catch(() => '')
    .then((k) => {
      if (!alive) return;
      key = typeof k === 'string' ? k : '';
      if (key) hydrate();
      render();
      // A snapshot is what the panel opens on; the Calendar is asked anyway,
      // so what is shown is never older than one launch of it.
      return fromSnapshot ? refresh() : ensure();
    });

  const onFront = () => {
    if (!alive || loading) return;
    if (document.visibilityState === 'hidden') return;
    if (hasData() && now() - fetchedAt < STALE_MS) return;
    void refresh();
  };
  window.addEventListener('focus', onFront);
  document.addEventListener('visibilitychange', onFront);
  const unsubscribeChanged = calendar.onChange?.(() => void refresh()) ?? null;

  const tick = setInterval(() => {
    const t = startOfDay(now());
    if (t !== todayStart) {
      // Midnight: what was "today" is now "yesterday", and the strip's
      // markers move. The selected day stays where the user put it.
      todayStart = t;
      render();
      void ensure();
    } else {
      renderBody();
    }
  }, TICK_MS);

  return () => {
    alive = false;
    clearInterval(tick);
    window.removeEventListener('focus', onFront);
    document.removeEventListener('visibilitychange', onFront);
    unsubscribeChanged?.();
    panel.remove();
  };
}
