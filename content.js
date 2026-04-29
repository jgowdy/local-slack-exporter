(() => {
  'use strict';

  const DEFAULT_OPTIONS = {
    includeThreads: true,
    scrollDelayMs: 900,
    maxScrollPasses: 1000,
    settlePasses: 100,
    maxThreadScrollPasses: 120,
    channelScrollFraction: 0.92
  };

  let stopRequested = false;
  let running = false;
  let lastStatus = 'Idle.';
  let activeMessages = null;
  let activeStats = null;
  let activeThreadParentKeys = null;
  let activeProcessedThreadKeys = null;

  function currentState() {
    return {
      running,
      stopRequested,
      status: lastStatus,
      messageCount: activeMessages ? activeMessages.size : 0,
      stats: activeStats ? { ...activeStats } : null
    };
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function interruptibleSleep(ms) {
    const deadline = Date.now() + Math.max(0, ms);
    while (!stopRequested && Date.now() < deadline) {
      await sleep(Math.min(125, deadline - Date.now()));
    }
  }

  function visibleTimestampRange(messages) {
    const timestamps = [...messages.values()]
      .map((message) => message.ts)
      .filter((ts) => /^\d{10}\.\d{6}$/.test(String(ts || '')))
      .sort();
    return {
      oldest: timestamps[0] || null,
      newest: timestamps[timestamps.length - 1] || null
    };
  }

  function setPhase(phase) {
    if (activeStats) activeStats.phase = phase;
  }

  function progressLines(extra = {}) {
    const lines = [];
    if (activeStats?.phase) lines.push(`Phase: ${activeStats.phase}`);
    if (activeMessages) {
      const range = visibleTimestampRange(activeMessages);
      lines.push(`Messages: ${activeMessages.size}`);
      lines.push(`Oldest ts: ${range.oldest || 'unknown'}`);
      lines.push(`Newest ts: ${range.newest || 'unknown'}`);
    }
    if (activeStats) {
      lines.push(`Thread parents discovered: ${activeStats.threadParentsDiscovered}`);
      lines.push(`Thread parents processed: ${activeStats.threadParentsProcessed}`);
      lines.push(`Replies collected: ${activeStats.repliesCollected}`);
    }
    for (const [label, value] of Object.entries(extra)) lines.push(`${label}: ${value}`);
    return lines.join('\n');
  }

  function visibleWindowSignature() {
    return findMessageElements()
      .map((element) => {
        const ts = timestampFromElement(element) || '';
        const key = element.getAttribute('data-item-key') || element.closest('[data-item-key]')?.getAttribute('data-item-key') || '';
        const textHash = stableHash(messageTextFromElement(element) || textOf(element)).slice(0, 10);
        return `${ts || key || textHash}`;
      })
      .filter(Boolean)
      .join('|');
  }

  function threadParentKey(element) {
    const ts = timestampFromElement(element);
    if (ts) return ts;
    const itemKey = element.getAttribute('data-item-key') || element.closest('[data-item-key]')?.getAttribute('data-item-key');
    if (itemKey) return itemKey;
    return stableHash(`${userFromElement(element) || ''}\n${messageTextFromElement(element) || textOf(element)}`).slice(0, 16);
  }

  function rememberVisibleThreadParents(root = document) {
    const parents = findVisibleThreadParentElements(root);
    if (!activeStats || !activeThreadParentKeys) return parents;

    for (const parent of parents) {
      const key = threadParentKey(parent);
      if (key) activeThreadParentKeys.add(key);
    }
    activeStats.threadParentsDiscovered = activeThreadParentKeys.size;
    return parents;
  }

  function mapKeyForMessage(message) {
    return message.ts || message.id;
  }

  function mergeThreadIntoParent(messages, parentElement, replies) {
    const parsed = parseMessage(parentElement, 0, 'channel');
    const key = mapKeyForMessage(parsed);
    const existing = messages.get(key) || parsed;
    messages.set(key, {
      ...existing,
      ...parsed,
      has_thread: true,
      thread_reply_count: replies.length,
      thread_replies: replies
    });
    return key;
  }

  function status(text, done = false) {
    lastStatus = text;
    chrome.runtime.sendMessage({
      type: 'LOCAL_SLACK_EXPORT_STATUS',
      status: text,
      done,
      running,
      stopRequested,
      messageCount: activeMessages ? activeMessages.size : 0,
      stats: activeStats ? { ...activeStats } : null
    }).catch(() => {});
  }

  function visible(element) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function textOf(element) {
    return (element?.innerText || element?.textContent || '').replace(/\u00a0/g, ' ').trim();
  }

  function cssEscape(value) {
    return CSS && CSS.escape ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function scrollerScore(element) {
    const rect = element.getBoundingClientRect();
    const qa = element.getAttribute('data-qa') || '';
    const className = String(element.className || '');
    const messageCount = findMessageElements(element).length;
    const timestampCount = element.querySelectorAll('a[href*="/archives/"][href*="p"], a.c-timestamp, [data-ts]').length;
    const messageContainerCount = element.querySelectorAll('[data-qa="message_container"], .c-message_kit__background').length;
    const isSidebar = /sidebar|team_sidebar|channel_sidebar|list_browser|member_list|dm_browser/i.test(`${qa} ${className}`);
    const centralPane = rect.left > Math.min(320, window.innerWidth * 0.28) && rect.width > Math.min(520, window.innerWidth * 0.42);
    const slackScrollbar = qa === 'slack_kit_scrollbar' || className.includes('c-scrollbar__hider');

    if (!visible(element) || isSidebar) return 0;
    if (!messageCount && !messageContainerCount && !timestampCount) return 0;

    return (messageCount * 5000)
      + (messageContainerCount * 2500)
      + (timestampCount * 250)
      + (centralPane ? 2000 : -2500)
      + (slackScrollbar ? 600 : 0)
      + Math.min(1000, rect.width)
      + Math.min(1000, rect.height);
  }

  function findScrollableContainers() {
    const candidates = [...document.querySelectorAll('div, section, main')]
      .filter((el) => {
        const style = getComputedStyle(el);
        return /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 300;
      })
      .map((element) => ({ element, score: scrollerScore(element) }))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score);

    if (candidates[0]) return candidates[0].element;
    throw new Error('Could not find the Slack message pane. Open a conversation/channel and make sure the message area is visible before exporting.');
  }

  function findMessageElements(root = document) {
    const selectors = [
      '[data-qa="virtual-list-item"] [data-qa="message_container"]',
      '[data-qa="message_container"]',
      '.c-virtual_list__item:has(.c-message_kit__background)',
      '.c-message_kit__background',
      '[data-qa="message-text"]'
    ];

    const elements = [];
    for (const selector of selectors) {
      try {
        elements.push(...root.querySelectorAll(selector));
      } catch (_) {
        // :has() is unavailable in some Chromium builds; other selectors cover the common path.
      }
    }

    const normalized = [];
    const seen = new Set();
    for (const element of elements) {
      const message = element.closest('[data-qa="message_container"], .c-message_kit__background, [data-qa="virtual-list-item"]') || element;
      if (!seen.has(message) && visible(message)) {
        seen.add(message);
        normalized.push(message);
      }
    }
    return normalized;
  }

  function messageRowForElement(element) {
    if (!element) return null;
    return element.closest('[data-qa="virtual-list-item"], .c-virtual_list__item')
      || element.closest('[data-qa="message_container"], .c-message_kit__background')
      || element;
  }

  function findVisibleThreadParentElements(root = document) {
    const structuralSelector = [
      '[data-qa="reply_bar"]',
      'button[data-qa="reply_bar_count"]',
      '[data-qa="reply_bar_count"]',
      '[data-qa="reply_count"]',
      '[data-qa="thread_reply_bar"]',
      'button[aria-label*="repl" i]',
      'a[aria-label*="repl" i]',
      '[role="button"][aria-label*="repl" i]',
      'button[aria-label*="thread" i]',
      'a[aria-label*="thread" i]',
      '[role="button"][aria-label*="thread" i]'
    ].join(', ');
    const candidates = [...root.querySelectorAll(structuralSelector)].filter((candidate) => {
      const qa = candidate.getAttribute('data-qa') || '';
      return /reply|thread/i.test(qa) || looksLikeThreadCountControl(candidate);
    });
    const seen = new Set();
    const parents = [];

    for (const candidate of candidates) {
      const row = messageRowForElement(candidate);
      if (!row || seen.has(row) || !visible(row)) continue;
      seen.add(row);
      parents.push(row);
    }

    for (const row of findMessageRows(root)) {
      if (seen.has(row) || !visible(row)) continue;
      if (!rowLooksLikeThreadParent(row)) continue;
      seen.add(row);
      parents.push(row);
    }

    return parents;
  }

  function findMessageRows(root = document) {
    const rows = [];
    const seen = new Set();
    const selector = '[data-qa="virtual-list-item"], .c-virtual_list__item, [data-qa="message_container"], .c-message_kit__background';
    for (const element of root.querySelectorAll(selector)) {
      const row = messageRowForElement(element);
      if (!row || seen.has(row)) continue;
      seen.add(row);
      rows.push(row);
    }
    return rows;
  }

  function findChannelName() {
    const titleSelectors = [
      '[data-qa="channel_name"]',
      '[data-qa="channel-header-title"]',
      '[data-qa="channel_header_name"]',
      'h1'
    ];
    for (const selector of titleSelectors) {
      const value = textOf(document.querySelector(selector));
      if (value) return value.replace(/^#\s*/, '');
    }
    const match = location.pathname.match(/\/archives\/([^/?#]+)/);
    return match ? match[1] : 'slack-channel';
  }

  function timestampFromElement(element) {
    const directTs = element.getAttribute('data-msg-ts') || element.querySelector('[data-msg-ts]')?.getAttribute('data-msg-ts');
    if (directTs) return directTs;

    const itemKey = element.getAttribute('data-item-key') || element.closest('[data-item-key]')?.getAttribute('data-item-key');
    if (/^\d{10}\.\d{6}$/.test(itemKey || '')) return itemKey;

    const id = element.id || element.closest('[id^="message-list_"]')?.id || '';
    const idMatch = id.match(/message-list_(\d{10}\.\d{6})/);
    if (idMatch) return idMatch[1];

    const time = element.querySelector('a[href*="/archives/"][href*="p"], a.c-timestamp, time, [data-qa="message_timestamp"]');
    const href = time?.getAttribute('href') || '';
    const hrefTs = href.match(/\/p(\d{10})(\d{6})/);
    if (hrefTs) return `${hrefTs[1]}.${hrefTs[2]}`;
    const datetime = time?.getAttribute('datetime') || element.querySelector('time')?.getAttribute('datetime');
    if (datetime) return datetime;
    const aria = time?.getAttribute('aria-label') || time?.getAttribute('title') || textOf(time);
    if (aria) return aria;
    return null;
  }

  function userFromElement(element) {
    const selectors = [
      '[data-qa="message_sender"]',
      '.c-message__sender_link',
      '.c-message_kit__sender',
      'button[data-qa="message_sender"]',
      'a[data-qa="message_sender"]'
    ];
    for (const selector of selectors) {
      const value = textOf(element.querySelector(selector));
      if (value) return value;
    }
    const labelled = element.querySelector('[aria-label*="message from" i]');
    const label = labelled?.getAttribute('aria-label') || '';
    const match = label.match(/message from\s+([^,]+)/i);
    return match ? match[1].trim() : null;
  }

  function messageTextFromElement(element) {
    const selectors = [
      '[data-qa="message-text"]',
      '.c-message_kit__text',
      '.p-rich_text_section',
      '.c-message__body'
    ];
    const pieces = [];
    for (const selector of selectors) {
      for (const node of element.querySelectorAll(selector)) {
        const value = textOf(node);
        if (value && !pieces.includes(value)) pieces.push(value);
      }
      if (pieces.length) break;
    }

    if (pieces.length) return pieces.join('\n').trim();

    const clone = element.cloneNode(true);
    for (const junk of clone.querySelectorAll('button, [role="button"], .c-message__actions, .c-message_kit__actions')) junk.remove();
    return textOf(clone);
  }

  function reactionsFromElement(element) {
    const reactions = [];
    for (const reaction of element.querySelectorAll('[data-qa="reaction"], .c-reaction')) {
      const label = reaction.getAttribute('aria-label') || reaction.getAttribute('data-stringify-emoji') || textOf(reaction);
      if (label) reactions.push(label);
    }
    return reactions;
  }

  function attachmentsFromElement(element) {
    return [...element.querySelectorAll('a[href]')]
      .map((a) => ({ text: textOf(a), href: a.href }))
      .filter((a) => a.href && !a.href.includes('/archives/'));
  }

  function looksLikeThreadCountControl(element) {
    const label = `${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''} ${textOf(element)}`;
    return /\b\d+\b/.test(label) && /\brepl(?:y|ies)\b|\bthread\b|view\s+thread|see\s+thread/i.test(label);
  }

  function rowLooksLikeThreadParent(row) {
    const labels = [...row.querySelectorAll('button, a, [role="button"], [aria-label], [title]')]
      .map((element) => `${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''} ${textOf(element)}`)
      .join(' ');
    if (/\b\d+\s+repl(?:y|ies)\b|\brepl(?:y|ies)\s+\d+\b|\bview\s+thread\b|\bsee\s+thread\b/i.test(labels)) return true;

    const rowText = textOf(row);
    return /\b\d+\s+repl(?:y|ies)\b/i.test(rowText) && /\b(last reply|repl(?:y|ies))\b/i.test(rowText);
  }

  function threadButtonFromElement(element, options = {}) {
    const root = messageRowForElement(element) || element;
    const allowHidden = Boolean(options.allowHidden);
    const exactSelectors = [
      'button[data-qa="reply_bar_count"]',
      '[role="button"][data-qa="reply_bar_count"]',
      '[data-qa="reply_bar"] button',
      '[data-qa="reply_bar"] [role="button"]',
      '[data-qa="reply_count"] button',
      '[data-qa="reply_count"] [role="button"]',
      '[data-qa="thread_reply_bar"] button',
      '[data-qa="thread_reply_bar"] [role="button"]'
    ];

    for (const selector of exactSelectors) {
      const control = root.querySelector(selector);
      if (control && (allowHidden || visible(control))) return control;
    }

    const labelCandidates = root.querySelectorAll('button[aria-label*="repl" i], a[aria-label*="repl" i], [role="button"][aria-label*="repl" i], button[aria-label*="thread" i], [role="button"][aria-label*="thread" i]');
    for (const control of labelCandidates) {
      if (looksLikeThreadCountControl(control) && (allowHidden || visible(control))) return control;
    }

    for (const control of root.querySelectorAll('button, a, [role="button"]')) {
      if (looksLikeThreadCountControl(control) && (allowHidden || visible(control))) return control;
    }

    return null;
  }

  function humanHover(element) {
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const options = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + Math.max(1, Math.min(rect.width - 1, rect.width / 2)),
      clientY: rect.top + Math.max(1, Math.min(rect.height - 1, rect.height / 2))
    };
    for (const type of ['mouseenter', 'mouseover', 'mousemove']) element.dispatchEvent(new MouseEvent(type, options));
  }

  function humanClick(element) {
    if (!element) return;
    element.scrollIntoView({ block: 'center', behavior: 'auto' });
    const rect = element.getBoundingClientRect();
    const options = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + Math.max(1, Math.min(rect.width - 1, rect.width / 2)),
      clientY: rect.top + Math.max(1, Math.min(rect.height - 1, rect.height / 2))
    };
    for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const EventCtor = type.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
      element.dispatchEvent(new EventCtor(type, options));
    }
    if (typeof element.click === 'function') element.click();
  }

  function parseMessage(element, index, source) {
    const ts = timestampFromElement(element);
    const fallbackHash = stableHash(`${userFromElement(element) || ''}\n${messageTextFromElement(element) || textOf(element)}`).slice(0, 12);
    return {
      id: ts || `${source}-${fallbackHash}`,
      ts,
      user: userFromElement(element),
      text: messageTextFromElement(element),
      reactions: reactionsFromElement(element),
      attachments: attachmentsFromElement(element),
      source
    };
  }

  function stableHash(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  function mergeMessages(targetMap, elements, source) {
    let added = 0;
    elements.forEach((element, index) => {
      const parsed = parseMessage(element, index, source);
      if (!parsed.text && !parsed.user && !parsed.ts) return;
      const key = parsed.ts || parsed.id;
      if (!targetMap.has(key)) {
        targetMap.set(key, parsed);
        added++;
      } else {
        const existing = targetMap.get(key);
        targetMap.set(key, { ...existing, ...parsed, text: parsed.text || existing.text });
      }
    });
    return added;
  }

  function channelScrollStep(scroller, options) {
    return Math.max(1200, Math.floor((scroller.clientHeight || window.innerHeight || 1000) * options.channelScrollFraction));
  }

  function scrollChannelBy(scroller, delta) {
    const before = scroller.scrollTop;
    scroller.scrollTop = Math.max(0, Math.min(scroller.scrollHeight, before + delta));
    return Math.abs(scroller.scrollTop - before);
  }

  function oldestVisibleKey() {
    const keys = findMessageElements().map((element) => timestampFromElement(element) || element.closest('[data-item-key]')?.getAttribute('data-item-key') || '').filter(Boolean).sort();
    return keys[0] || '';
  }

  function newestVisibleKey() {
    const keys = findMessageElements().map((element) => timestampFromElement(element) || element.closest('[data-item-key]')?.getAttribute('data-item-key') || '').filter(Boolean).sort();
    return keys[keys.length - 1] || '';
  }

  async function scrollToChannelBottom(scroller, options) {
    setPhase('moving to newest messages');
    let sameWindow = 0;
    let bottomClamped = 0;
    let lastWindowSignature = visibleWindowSignature();
    const maxStartupJumps = 30;

    for (let jump = 1; jump <= maxStartupJumps && !stopRequested; jump++) {
      const beforeTop = scroller.scrollTop;
      scroller.scrollTop = scroller.scrollHeight;
      await interruptibleSleep(Math.max(250, Math.floor(options.scrollDelayMs * 0.45)) + Math.floor(Math.random() * 100));
      if (stopRequested) break;

      const currentWindowSignature = visibleWindowSignature();
      const visibleWindowChanged = currentWindowSignature && currentWindowSignature !== lastWindowSignature;
      sameWindow = visibleWindowChanged ? 0 : sameWindow + 1;
      lastWindowSignature = currentWindowSignature || lastWindowSignature;

      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
      const moved = Math.abs(scroller.scrollTop - beforeTop);
      const bottomClampSignal = atBottom || (moved < 2 && Math.abs(scroller.scrollTop - beforeTop) < 2);
      bottomClamped = bottomClampSignal ? bottomClamped + 1 : 0;

      status(`Moving to newest messages before export...\n${progressLines({
        'Jump': `${jump}/${maxStartupJumps}`,
        'Same visible page': `${sameWindow}/6`,
        'Bottom clamp': `${bottomClamped}/2`
      })}`);

      if (bottomClamped >= 2 || sameWindow >= 6) break;
    }
  }

  async function scrollToOldest(scroller, messages, options) {
    setPhase('collecting older history');
    let noProgress = 0;
    let sameWindow = 0;
    let topClamped = 0;
    let lastCount = messages.size;
    let lastOldest = oldestVisibleKey();
    let lastHeight = scroller.scrollHeight;
    let lastWindowSignature = visibleWindowSignature();

    for (let pass = 1; pass <= options.maxScrollPasses && !stopRequested; pass++) {
      mergeMessages(messages, findMessageElements(), 'channel');
      if (options.includeThreads) await collectVisibleThreads(messages, options, `${pass}/${options.maxScrollPasses}`);
      if (stopRequested) break;
      const beforeTop = scroller.scrollTop;
      const step = channelScrollStep(scroller, options);
      const moved = scrollChannelBy(scroller, -step);
      await interruptibleSleep(options.scrollDelayMs + Math.floor(Math.random() * 250));
      if (stopRequested) break;
      mergeMessages(messages, findMessageElements(), 'channel');
      rememberVisibleThreadParents();

      const count = messages.size;
      const currentOldest = oldestVisibleKey();
      const currentHeight = scroller.scrollHeight;
      const currentWindowSignature = visibleWindowSignature();
      const visibleWindowChanged = currentWindowSignature && currentWindowSignature !== lastWindowSignature;
      const progressed = count > lastCount || (currentOldest && currentOldest !== lastOldest) || Math.abs(currentHeight - lastHeight) > 20 || visibleWindowChanged;
      const physicallyStalled = scroller.scrollTop <= 2 || moved < 2 || Math.abs(scroller.scrollTop - beforeTop) < 2;
      const topClampSignal = beforeTop <= 2 && scroller.scrollTop <= 2 && moved < 2 && (!currentOldest || currentOldest === lastOldest);

      noProgress = progressed ? 0 : noProgress + 1;
      sameWindow = visibleWindowChanged ? 0 : sameWindow + 1;
      topClamped = topClampSignal ? topClamped + 1 : 0;
      lastCount = count;
      lastOldest = currentOldest || lastOldest;
      lastHeight = currentHeight;
      lastWindowSignature = currentWindowSignature || lastWindowSignature;

      status(`Loading older conversation history...\n${progressLines({
        'Page': `${pass}/${options.maxScrollPasses}`,
        'No-growth pages': `${noProgress}/${options.settlePasses}`,
        'Same visible page': `${sameWindow}/12`,
        'Top clamp': `${topClamped}/2`
      })}`);

      if (topClamped >= 2 || (noProgress >= options.settlePasses && physicallyStalled) || sameWindow >= 12) {
        status(`Reached apparent top of channel history.\nMessages seen: ${messages.size}`);
        break;
      }
      if (noProgress >= options.settlePasses * 2) break;
    }
  }

  async function scrollToNewestAndCollect(scroller, messages, options) {
    setPhase('collecting newer history');
    let noProgress = 0;
    let sameWindow = 0;
    let lastCount = messages.size;
    let lastNewest = newestVisibleKey();
    let lastHeight = scroller.scrollHeight;
    let lastWindowSignature = visibleWindowSignature();

    for (let pass = 1; pass <= options.maxScrollPasses && !stopRequested; pass++) {
      mergeMessages(messages, findMessageElements(), 'channel');
      if (options.includeThreads) await collectVisibleThreads(messages, options, `${pass}/${options.maxScrollPasses}`);
      if (stopRequested) break;
      const beforeTop = scroller.scrollTop;
      const step = channelScrollStep(scroller, options);
      const moved = scrollChannelBy(scroller, step);
      await interruptibleSleep(options.scrollDelayMs + Math.floor(Math.random() * 250));
      if (stopRequested) break;
      mergeMessages(messages, findMessageElements(), 'channel');
      rememberVisibleThreadParents();

      const count = messages.size;
      const currentNewest = newestVisibleKey();
      const currentHeight = scroller.scrollHeight;
      const currentWindowSignature = visibleWindowSignature();
      const visibleWindowChanged = currentWindowSignature && currentWindowSignature !== lastWindowSignature;
      const progressed = count > lastCount || (currentNewest && currentNewest !== lastNewest) || Math.abs(currentHeight - lastHeight) > 20 || visibleWindowChanged;
      const physicallyStalled = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4 || moved < 2 || Math.abs(scroller.scrollTop - beforeTop) < 2;

      noProgress = progressed ? 0 : noProgress + 1;
      sameWindow = visibleWindowChanged ? 0 : sameWindow + 1;
      lastCount = count;
      lastNewest = currentNewest || lastNewest;
      lastHeight = currentHeight;
      lastWindowSignature = currentWindowSignature || lastWindowSignature;

      status(`Collecting conversation history newest-ward...\n${progressLines({
        'Page': `${pass}/${options.maxScrollPasses}`,
        'No-growth pages': `${noProgress}/${options.settlePasses}`,
        'Same visible page': `${sameWindow}/12`
      })}`);

      if ((noProgress >= options.settlePasses && physicallyStalled) || sameWindow >= 12) break;
      if (noProgress >= options.settlePasses * 2) break;
    }
  }

  function findThreadPane() {
    const selectors = [
      '[data-qa="thread_view"]',
      '[data-qa="thread_flexpane"]',
      '[data-qa*="thread" i]',
      '.p-threads_flexpane',
      '.p-flexpane',
      '[class*="thread" i]'
    ];
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        if (node && visible(node) && findMessageElements(node).length) return node;
      }
    }

    const rightSideMessageContainers = [...document.querySelectorAll('div, section, aside')]
      .filter((node) => {
        if (!visible(node)) return false;
        const rect = node.getBoundingClientRect();
        if (rect.x < window.innerWidth * 0.45 || rect.width < 260 || rect.height < 250) return false;
        return findMessageElements(node).length > 0 && (node.querySelector('button[aria-label*="close" i], [data-qa="close_flexpane"], [data-qa="close"]') || /thread/i.test(node.className || ''));
      })
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return (br.width * br.height) - (ar.width * ar.height);
      });
    return rightSideMessageContainers[0] || null;
  }

  function findThreadScroller(pane) {
    if (!pane) return null;
    const candidates = [...pane.querySelectorAll('div, section')]
      .filter((el) => {
        const style = getComputedStyle(el);
        return /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 80;
      })
      .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
    return candidates[0] || pane;
  }

  async function waitForThreadPane(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs && !stopRequested) {
      const pane = findThreadPane();
      if (pane) return pane;
      await interruptibleSleep(150);
    }
    return null;
  }

  function filteredThreadReplies(replies, parentText, parentTs) {
    return [...replies.values()].filter((reply) => {
      if (!reply.text && !reply.user) return false;
      // Slack panes usually include the parent message at the top; remove that row only.
      if (parentTs && reply.ts === parentTs) return false;
      if (!reply.ts && reply.text === parentText) return false;
      return true;
    });
  }

  async function collectThreadForElement(element, parentKey, options, onProgress) {
    const row = messageRowForElement(element) || element;

    row.scrollIntoView({ block: 'center', behavior: 'auto' });
    humanHover(row);
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    await interruptibleSleep(Math.max(250, Math.floor(options.scrollDelayMs * 0.45)));
    if (stopRequested) return [];

    const button = threadButtonFromElement(row) || threadButtonFromElement(row, { allowHidden: true });
    if (!button) return [];

    let pane = null;
    humanHover(row);
    humanClick(button);
    for (let i = 0; i < 30 && !stopRequested; i++) {
      await interruptibleSleep(150);
      pane = findThreadPane();
      if (pane) break;
    }
    if (!pane) return [];
    const scroller = findThreadScroller(pane);
    const replies = new Map();
    const parentText = messageTextFromElement(row);
    const parentTs = timestampFromElement(row);
    let lastReportedReplyCount = 0;

    function reportReplyProgress() {
      const currentReplyCount = filteredThreadReplies(replies, parentText, parentTs).length;
      if (currentReplyCount > lastReportedReplyCount && typeof onProgress === 'function') {
        onProgress(currentReplyCount - lastReportedReplyCount, currentReplyCount);
      }
      lastReportedReplyCount = currentReplyCount;
    }

    scroller.scrollTop = 0;
    await interruptibleSleep(Math.max(300, Math.floor(options.scrollDelayMs * 0.6)));
    for (let pass = 0; pass < options.maxThreadScrollPasses && !stopRequested; pass++) {
      mergeMessages(replies, findMessageElements(pane), `thread:${parentKey}`);
      reportReplyProgress();
      const before = scroller.scrollTop;
      const step = Math.max(500, Math.floor(scroller.clientHeight * 0.9));
      scrollChannelBy(scroller, step);
      await interruptibleSleep(options.scrollDelayMs);
      if (stopRequested) break;
      mergeMessages(replies, findMessageElements(pane), `thread:${parentKey}`);
      reportReplyProgress();
      if (Math.abs(scroller.scrollTop - before) < 8 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 6) break;
    }

    const closeSelectors = [
      '[data-qa="close_flexpane"]',
      '[data-qa="close"]',
      'button[aria-label="Close"]',
      'button[aria-label*="close" i]'
    ];
    for (const selector of closeSelectors) {
      const close = pane.querySelector(selector) || document.querySelector(selector);
      if (close && visible(close)) {
        humanClick(close);
        await interruptibleSleep(Math.min(options.scrollDelayMs, 500));
        break;
      }
    }

    return filteredThreadReplies(replies, parentText, parentTs);
  }

  async function collectVisibleThreads(messages, options, pageLabel) {
    if (!options.includeThreads || !activeProcessedThreadKeys) return;

    const previousPhase = activeStats?.phase || '';
    setPhase('collecting visible threads');
    const parents = rememberVisibleThreadParents();

    for (const parent of parents) {
      if (stopRequested) break;
      const parentKey = threadParentKey(parent);
      if (!parentKey || activeProcessedThreadKeys.has(parentKey)) continue;
      if (!threadButtonFromElement(parent, { allowHidden: true })) continue;

      const parsed = parseMessage(parent, 0, 'channel');
      const key = mapKeyForMessage(parsed);
      activeProcessedThreadKeys.add(parentKey);

      if (activeStats) {
        activeStats.threadParentsProcessed = activeProcessedThreadKeys.size;
        activeStats.threadParentsDiscovered = Math.max(activeStats.threadParentsDiscovered, activeThreadParentKeys?.size || 0, activeProcessedThreadKeys.size);
      }

      status(`Collecting thread replies in place...\n${progressLines({
        'Page': pageLabel,
        'Current parent': `${parsed.user || 'unknown'} - ${(parsed.text || '').slice(0, 120)}`
      })}`);

      const replies = await collectThreadForElement(parent, parentKey, options, (newReplies, currentReplyCount) => {
        if (activeStats) activeStats.repliesCollected += newReplies;
        status(`Collecting thread replies in place...\n${progressLines({
          'Page': pageLabel,
          'Current parent replies': currentReplyCount
        })}`);
      });
      mergeThreadIntoParent(messages, parent, sortMessages(new Map(replies.map((reply) => [mapKeyForMessage(reply), reply]))));

      status(`Collected thread beside parent message.\n${progressLines({
        'Page': pageLabel,
        'Last parent replies': replies.length
      })}`);
      await interruptibleSleep(Math.max(200, Math.floor(options.scrollDelayMs * 0.5)));
    }

    if (previousPhase) setPhase(previousPhase);
  }

  async function collectThreads(scroller, messages, options) {
    setPhase('collecting threads');
    const processed = new Set();
    let noMovement = 0;

    // Open thread parents while they are visible. Slack virtualizes old DOM nodes, so storing
    // elements first and clicking them later is unreliable.
    scroller.scrollTop = 0;
    await interruptibleSleep(options.scrollDelayMs + 300);

    for (let pass = 1; pass <= options.maxScrollPasses && !stopRequested; pass++) {
      const elements = findMessageElements();
      const visibleThreadParents = rememberVisibleThreadParents();
      for (const element of elements) {
        if (!threadButtonFromElement(element, { allowHidden: true })) continue;
        const row = messageRowForElement(element) || element;
        if (!visibleThreadParents.includes(row) && visible(row)) visibleThreadParents.push(row);
      }
      if (activeThreadParentKeys && activeStats) {
        for (const parent of visibleThreadParents) activeThreadParentKeys.add(threadParentKey(parent));
        activeStats.threadParentsDiscovered = activeThreadParentKeys.size;
      }

      for (const element of visibleThreadParents) {
        if (stopRequested) break;
        const parsed = parseMessage(element, pass, 'channel');
        const key = parsed.ts || parsed.id;
        if (processed.has(key)) continue;

        processed.add(key);
        if (activeStats) {
          activeStats.threadParentsProcessed = processed.size;
          activeStats.threadParentsDiscovered = Math.max(activeStats.threadParentsDiscovered, processed.size);
        }
        status(`Collecting visible thread replies...\n${progressLines({
          'Current parent': `${parsed.user || 'unknown'} - ${(parsed.text || '').slice(0, 120)}`
        })}`);
        const replies = await collectThreadForElement(element, key, options);
        const existing = messages.get(key) || parsed;
        messages.set(key, { ...existing, thread_replies: replies });
        if (activeStats) activeStats.repliesCollected += replies.length;
        status(`Collected thread replies.\n${progressLines({
          'Last parent replies': replies.length
        })}`);
        await interruptibleSleep(options.scrollDelayMs + Math.floor(Math.random() * 400));
      }

      status(`Scanning for thread parents...\n${progressLines({
        'Page': `${pass}/${options.maxScrollPasses}`
      })}`);

      const before = scroller.scrollTop;
      const step = channelScrollStep(scroller, options);
      const moved = scrollChannelBy(scroller, step);
      await interruptibleSleep(options.scrollDelayMs + Math.floor(Math.random() * 250));

      if (moved < 2 || Math.abs(scroller.scrollTop - before) < 8) noMovement++;
      else noMovement = 0;

      if (noMovement >= options.settlePasses && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) break;
    }
  }

  function findCurrentElementForMessage(message) {
    if (message.ts) {
      const compact = message.ts.replace('.', '');
      const exact = document.querySelector(`a[href*="p${cssEscape(compact)}"]`);
      if (exact) return exact.closest('[data-qa="message_container"], .c-message_kit__background, [data-qa="virtual-list-item"]') || exact;
    }
    const text = (message.text || '').slice(0, 80);
    if (!text) return null;
    return findMessageElements().find((element) => messageTextFromElement(element).includes(text)) || null;
  }

  function sortMessages(messages) {
    return [...messages.values()].sort((a, b) => {
      const ats = Number(String(a.ts || '').replace(/[^0-9.]/g, ''));
      const bts = Number(String(b.ts || '').replace(/[^0-9.]/g, ''));
      if (!Number.isNaN(ats) && !Number.isNaN(bts) && ats && bts) return ats - bts;
      return String(a.id).localeCompare(String(b.id));
    });
  }

  function downloadJson(payload) {
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safeChannel = payload.channel.name.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'slack-channel';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url;
    a.download = `${safeChannel}-${stamp}.json`;
    a.style.display = 'none';
    document.documentElement.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1000);
  }

  async function startExport(rawOptions) {
    if (running) {
      status('Export already running.');
      return;
    }

    running = true;
    stopRequested = false;
    const options = { ...DEFAULT_OPTIONS, ...rawOptions };
    options.scrollDelayMs = Math.max(250, Number(options.scrollDelayMs) || DEFAULT_OPTIONS.scrollDelayMs);
    options.maxScrollPasses = Math.max(10, Number(options.maxScrollPasses) || DEFAULT_OPTIONS.maxScrollPasses);
    options.settlePasses = Math.max(3, Number(options.settlePasses) || DEFAULT_OPTIONS.settlePasses);
    options.maxThreadScrollPasses = Math.max(20, Number(options.maxThreadScrollPasses) || DEFAULT_OPTIONS.maxThreadScrollPasses);
    options.channelScrollFraction = Math.max(0.5, Math.min(1.8, Number(options.channelScrollFraction) || DEFAULT_OPTIONS.channelScrollFraction));

    try {
      const scroller = findScrollableContainers();
      const messages = new Map();
      activeMessages = messages;
      activeThreadParentKeys = new Set();
      activeProcessedThreadKeys = new Set();
      activeStats = {
        phase: 'starting',
        threadParentsDiscovered: 0,
        threadParentsProcessed: 0,
        repliesCollected: 0
      };

      status(`Moving to newest messages before export...\n${progressLines()}`);
      await scrollToChannelBottom(scroller, options);
      if (stopRequested) setPhase('stopping');

      if (!stopRequested) {
        status(`Collecting currently loaded messages...\n${progressLines()}`);
        mergeMessages(messages, findMessageElements(), 'channel');
        rememberVisibleThreadParents();
      }

      if (!stopRequested) await scrollToOldest(scroller, messages, options);
      if (!stopRequested) await scrollToNewestAndCollect(scroller, messages, options);
      if (stopRequested) setPhase('stopping');
      else setPhase('done');

      const payload = {
        exported_at: new Date().toISOString(),
        exporter: {
          name: 'Local Slack Channel Exporter',
          version: '0.3.17',
          locality: 'local-only-dom-scraper'
        },
        source_url: location.href,
        channel: {
          name: findChannelName()
        },
        options,
        stopped_early: stopRequested,
        message_count: messages.size,
        thread_parent_count: activeStats ? activeStats.threadParentsProcessed : 0,
        thread_reply_count: activeStats ? activeStats.repliesCollected : 0,
        messages: sortMessages(messages)
      };

      downloadJson(payload);
      status(`Done. Downloaded JSON.\nMessages: ${payload.message_count}\nStopped early: ${payload.stopped_early}`, true);
    } catch (error) {
      console.error('[Local Slack Exporter] Export failed', error);
      status(`Export failed: ${error.message}`, true);
    } finally {
      running = false;
      stopRequested = false;
      activeMessages = null;
      activeStats = null;
      activeThreadParentKeys = null;
      activeProcessedThreadKeys = null;
    }
  }


  function redactTextValue(value, maxLength = 180) {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return '';
    return `[redacted:${normalized.length} chars:${stableHash(normalized).slice(0, 10)}]${normalized.length > maxLength ? '[truncated]' : ''}`;
  }

  function redactAttributeValue(name, value) {
    if (!value) return value;
    const lower = name.toLowerCase();
    if (lower === 'href') {
      try {
        const url = new URL(value, location.href);
        if (url.hostname.endsWith('.slack.com') && url.pathname.includes('/archives/')) return url.pathname.replace(/\/[^/]+\/p\d+/, '/CHANNEL/pTIMESTAMP');
        return `${url.protocol}//${url.hostname}${url.pathname ? '/...' : ''}`;
      } catch (_) {
        return '[redacted-url]';
      }
    }
    if (lower === 'src' || lower === 'srcset' || lower.includes('token')) return '[redacted]';
    if (lower === 'aria-label' || lower === 'title' || lower.startsWith('data-stringify')) return redactTextValue(value);
    return value.length > 160 ? `${value.slice(0, 160)}...` : value;
  }

  function redactedHtmlSnippet(element, maxChars = 5000) {
    if (!element) return null;
    const clone = element.cloneNode(true);

    // Avoid mutating SVG/media internals in diagnostics. Redacting/truncating SVG
    // path data such as `d` creates invalid path attributes and Chrome logs errors.
    // Selector tuning does not need icon geometry or media sources, so replace
    // those subtrees with inert placeholders before touching attributes.
    for (const node of clone.querySelectorAll('svg, img, picture, video, audio, canvas, source')) {
      const placeholder = document.createElement('span');
      placeholder.setAttribute('data-local-slack-exporter-redacted-node', node.tagName.toLowerCase());
      node.replaceWith(placeholder);
    }

    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    for (const node of textNodes) node.nodeValue = redactTextValue(node.nodeValue, 80);

    for (const node of clone.querySelectorAll('*')) {
      for (const attr of [...node.attributes]) {
        const name = attr.name.toLowerCase();
        if (name === 'd' || name.startsWith('on')) {
          node.removeAttribute(attr.name);
        } else {
          node.setAttribute(attr.name, redactAttributeValue(attr.name, attr.value));
        }
      }
    }

    const html = clone.outerHTML.replace(/\s+/g, ' ').trim();
    return html.length > maxChars ? `${html.slice(0, maxChars)}...[truncated ${html.length - maxChars} chars]` : html;
  }

  function elementFingerprint(element) {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const attributes = {};
    for (const attr of [...element.attributes || []]) {
      if (/^(id|class|role|aria-|data-qa|data-testid|data-test|data-item-key|href|title)$/i.test(attr.name)) {
        attributes[attr.name] = redactAttributeValue(attr.name, attr.value);
      }
    }
    return {
      tag: element.tagName.toLowerCase(),
      attributes,
      text: redactTextValue(textOf(element)),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      visible: visible(element),
      child_count: element.children.length
    };
  }

  function countSelector(selector) {
    try {
      return document.querySelectorAll(selector).length;
    } catch (error) {
      return `selector-error:${error.message}`;
    }
  }

  function selectorDiagnostics(root = document) {
    const selectors = [
      '[data-qa="virtual-list-item"]',
      '[data-qa="message_container"]',
      '[data-qa="message-text"]',
      '[data-qa="reply_bar"]',
      '[data-qa="reply_bar_count"]',
      '[data-qa="reply_count"]',
      '[data-qa="thread_reply_bar"]',
      '[data-qa="thread_view"]',
      '[data-qa="thread_flexpane"]',
      '[data-qa="slack_kit_scrollbar"]',
      '.c-virtual_list__item',
      '.c-message_kit__background',
      '.c-message_kit__text',
      '.p-rich_text_section',
      '.p-threads_flexpane',
      '.p-flexpane',
      'button[aria-label*="repl" i]',
      'a[aria-label*="repl" i]',
      'button[aria-label*="thread" i]',
      'a[aria-label*="thread" i]',
      'button[aria-label*="Close" i]',
      'a[href*="/archives/"][href*="p"]',
      'time'
    ];
    return Object.fromEntries(selectors.map((selector) => [selector, countSelector.call(null, selector)]));
  }

  function summarizeScrollableContainers() {
    return [...document.querySelectorAll('div, section, main')]
      .map((el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return {
          element: elementFingerprint(el),
          overflowY: style.overflowY,
          scrollTop: Math.round(el.scrollTop),
          scrollHeight: Math.round(el.scrollHeight),
          clientHeight: Math.round(el.clientHeight),
          rectHeight: Math.round(rect.height),
          message_descendants: findMessageElements(el).length,
          scroller_score: scrollerScore(el)
        };
      })
      .filter((item) => /(auto|scroll)/.test(item.overflowY) && item.scrollHeight > item.clientHeight + 80)
      .sort((a, b) => b.scroller_score - a.scroller_score || (b.scrollHeight - b.clientHeight + b.message_descendants * 1000) - (a.scrollHeight - a.clientHeight + a.message_descendants * 1000))
      .slice(0, 12);
  }

  function summarizeInteractiveElements() {
    return [...document.querySelectorAll('button, a, [role="button"]')]
      .map((el) => {
        const text = textOf(el);
        const aria = el.getAttribute('aria-label') || '';
        return {
          element: elementFingerprint(el),
          text: redactTextValue(text),
          aria_label: redactTextValue(aria),
          data_qa: el.getAttribute('data-qa') || null,
          href: redactAttributeValue('href', el.getAttribute('href') || '') || null
        };
      })
      .filter((item) => /repl|thread|close|older|newer|jump|load|history|message/i.test(`${item.text} ${item.aria_label} ${item.data_qa || ''}`))
      .slice(0, 100);
  }

  function summarizeMessageCandidates() {
    const elements = findMessageElements();
    return elements.slice(0, 25).map((el, index) => {
      const threadButton = threadButtonFromElement(el);
      return {
        index,
        element: elementFingerprint(el),
        parsed: {
          ts: timestampFromElement(el),
          user: redactTextValue(userFromElement(el)),
          text: redactTextValue(messageTextFromElement(el)),
          reaction_count: reactionsFromElement(el).length,
          attachment_count: attachmentsFromElement(el).length,
          has_thread_button: Boolean(threadButton)
        },
        thread_button: elementFingerprint(threadButton),
        redacted_html: redactedHtmlSnippet(el, 3500)
      };
    });
  }

  function summarizeThreadPane() {
    const pane = findThreadPane();
    if (!pane) return null;
    const scroller = findThreadScroller(pane);
    return {
      pane: elementFingerprint(pane),
      scroller: elementFingerprint(scroller),
      selector_counts: selectorDiagnostics(pane),
      message_candidates: findMessageElements(pane).slice(0, 20).map((el, index) => ({
        index,
        element: elementFingerprint(el),
        parsed: {
          ts: timestampFromElement(el),
          user: redactTextValue(userFromElement(el)),
          text: redactTextValue(messageTextFromElement(el))
        },
        redacted_html: redactedHtmlSnippet(el, 2500)
      })),
      redacted_html: redactedHtmlSnippet(pane, 6000)
    };
  }

  function buildDiagnosticsPayload() {
    const scroller = findScrollableContainers();
    const payload = {
      exported_at: new Date().toISOString(),
      exporter: {
        name: 'Local Slack Channel Exporter',
        version: '0.3.17',
        diagnostic_mode: true,
        privacy: 'message/user text redacted with length+hash fingerprints; URLs and media sources redacted'
      },
      location: {
        origin: location.origin,
        pathname: location.pathname,
        href_shape: location.href.replace(/\/archives\/[^/?#]+/, '/archives/CHANNEL')
      },
      document: {
        title: redactTextValue(document.title),
        ready_state: document.readyState,
        body_text_hash: stableHash(document.body?.innerText || ''),
        body_text_length: (document.body?.innerText || '').length
      },
      channel: {
        name: redactTextValue(findChannelName())
      },
      selector_counts: selectorDiagnostics(),
      chosen_scroller: elementFingerprint(scroller),
      scrollable_containers: summarizeScrollableContainers(),
      message_candidate_count: findMessageElements().length,
      message_candidates: summarizeMessageCandidates(),
      interactive_candidates: summarizeInteractiveElements(),
      thread_pane: summarizeThreadPane(),
      body_redacted_sample: redactedHtmlSnippet(document.body, 10000)
    };
    return payload;
  }

  function downloadDiagnostics() {
    const payload = buildDiagnosticsPayload();
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url;
    a.download = `slack-dom-diagnostics-${stamp}.json`;
    a.style.display = 'none';
    document.documentElement.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1000);
    status('Downloaded DOM diagnostics JSON. It is redacted, but still review before sharing.', true);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.type) return false;

    if (message.type === 'LOCAL_SLACK_EXPORT_START') {
      startExport(message.options || {});
      sendResponse({ ok: true, ...currentState() });
      return false;
    }

    if (message.type === 'LOCAL_SLACK_EXPORT_STOP') {
      if (running) {
        stopRequested = true;
        status('Stop requested. Saving partial export after the current operation...');
      } else {
        status('No export is currently running.', true);
      }
      sendResponse({ ok: true, ...currentState() });
      return false;
    }

    if (message.type === 'LOCAL_SLACK_EXPORT_QUERY_STATE') {
      sendResponse({ ok: true, ...currentState() });
      return false;
    }

    if (message.type === 'LOCAL_SLACK_EXPORT_DIAGNOSTICS') {
      try {
        downloadDiagnostics();
        sendResponse({ ok: true, ...currentState() });
      } catch (error) {
        console.error('[Local Slack Exporter] Diagnostics failed', error);
        status(`Diagnostics failed: ${error.message}`, true);
        sendResponse({ ok: false, error: error.message, ...currentState() });
      }
      return false;
    }

    return false;
  });

})();
