// MV3 service worker (module)
// Ensures PDFs live in a dedicated window.
// Remembers PDF tab IDs in chrome.storage.session and enforces separation again if needed.

const PDF_VIEWER_EXTENSION_ID = 'mhjfbmdgcfjbbpaeojofohoefgiehjai'; // Chrome's built-in PDF viewer ID

// -------- Storage helpers (session-only) --------
// We keep a Set of tabIds (as numbers) in chrome.storage.session under the key 'pdfTabIds'.
async function getTrackedSet() {
  const { pdfTabIds } = await chrome.storage.session.get({ pdfTabIds: [] });
  // Normalize to numbers (tab IDs are numbers, but storage can return strings)
  return new Set(pdfTabIds.map(Number));
}

async function setTrackedSet(set) {
  await chrome.storage.session.set({ pdfTabIds: Array.from(set) });
}

async function trackTab(tabId) {
  const set = await getTrackedSet();
  if (!set.has(tabId)) {
    set.add(tabId);
    await setTrackedSet(set);
  }
}

async function untrackTab(tabId) {
  const set = await getTrackedSet();
  if (set.delete(tabId)) {
    await setTrackedSet(set);
  }
}

async function isTracked(tabId) {
  const set = await getTrackedSet();
  return set.has(tabId);
}

// -------- PDF detection --------
function isPdfUrl(url = '') {
  if (!url) return false;
  // Heuristics:
  // 1) direct .pdf links (with optional query/hash)
  // 2) Chrome built-in viewer
  // 3) file:// local PDFs ending with .pdf
  return (
    /\.pdf($|[?#])/i.test(url) ||
    url.startsWith(`chrome-extension://${PDF_VIEWER_EXTENSION_ID}/`) ||
    (url.startsWith('file://') && /\.pdf($|[?#])/i.test(url))
  );
}

function isPdfTab(tab) {
  return Boolean(tab && tab.url && isPdfUrl(tab.url));
}

// -------- Window separation logic --------
async function ensurePdfTabIsSolo(tab) {
  if (!tab || tab.id == null || tab.windowId == null) return;
  if (await isTracked(tab.id)) return;

  // Get all tabs in the window
  const tabsInWindow = await chrome.tabs.query({ windowId: tab.windowId });
  const tabCount = tabsInWindow.length;

  if (tabCount > 1) {
    // Move PDF tab into a fresh window
    await chrome.windows.create({ tabId: tab.id, focused: true });
    await trackTab(tab.id);
    return;
  }

  // If it's already solo, just track it (so we re-enforce if needed later)
  await trackTab(tab.id);
}

// If any window containing a tracked PDF tab gains an extra tab,
// move the PDF tab out again.
// async function enforceWhenWindowChangesFor(tabOrWindowId) {
//   // tabOrWindowId can be a windowId or a tab object; normalize to windowId
//   let windowId = null;

//   if (typeof tabOrWindowId === 'number') {
//     windowId = tabOrWindowId;
//   } else if (tabOrWindowId && typeof tabOrWindowId === 'object') {
//     windowId = tabOrWindowId.windowId ?? null;
//   }

//   if (windowId == null) return;

//   const tabsInWindow = await chrome.tabs.query({ windowId });
//   if (tabsInWindow.length <= 1) return;

//   // See if this window contains any tracked PDF tabs
//   const tracked = await getTrackedSet();
//   const pdfTabsHere = tabsInWindow.filter(t => tracked.has(t.id));

//   // For each tracked PDF tab in this window that is not alone, move it out.
//   for (const pdfTab of pdfTabsHere) {
//     // If there are more than 1 tabs, yank the PDF tab to its own window.
//     await chrome.windows.create({ tabId: pdfTab.id, focused: true });
//     // (already tracked)
//   }
// }

// -------- Event handlers --------

// 1) Detect navigations to PDFs
chrome.webNavigation.onCommitted.addListener(async (details) => {
  // We only care about main frame navigations to a PDF:
  if (details.frameId !== 0) return;
  if (!isPdfUrl(details.url)) return;

  try {
    const tab = await chrome.tabs.get(details.tabId);
    await ensurePdfTabIsSolo(tab);
  } catch (e) {
    // Tab may have gone away
  }
});

// 2) Also catch URL changes via tabs.onUpdated (some PDFs load via viewer handoff)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // If it becomes a PDF, enforce solo
  if ((changeInfo.status === 'loading' || changeInfo.url) && isPdfTab(tab)) {
    await ensurePdfTabIsSolo(tab);
    return;
  }

  // If it's a tracked PDF tab and anything changes, re-check the window is still solo
//   if (await isTracked(tabId)) {
//     // Make sure window still has just this one
//     const tabsInWindow = await chrome.tabs.query({ windowId: tab.windowId });
//     if (tabsInWindow.length > 1) {
//       await chrome.windows.create({ tabId, focused: true });
//     }
//   }
});

// 3) If a new tab is created in a window that currently hosts a tracked PDF tab,
// move the PDF tab out again so it's solo.
// chrome.tabs.onCreated.addListener(async (newTab) => {
//   if (newTab.windowId == null) return;

//   const tabsInWindow = await chrome.tabs.query({ windowId: newTab.windowId });
//   const tracked = await getTrackedSet();
//   const pdfTabsHere = tabsInWindow.filter(t => tracked.has(t.id));

//   for (const pdfTab of pdfTabsHere) {
//     // If the window now has more than 1 tabs, re-separate the PDF tab.
//     if (tabsInWindow.length > 1) {
//       await chrome.windows.create({ tabId: pdfTab.id, focused: true });
//     }
//   }
// });

// 4) If a tab is attached (dragged) into a window with a tracked PDF tab,
// re-separate the PDF tab.
// chrome.tabs.onAttached.addListener(async (tabId, attachInfo) => {
//   await enforceWhenWindowChangesFor(attachInfo.newWindowId);
// });

// 5) Cleanup when a tracked PDF tab closes
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  await untrackTab(tabId);
});

// 6) As a fallback, when a window gains or loses tabs due to moves/creates/removes,
// re-enforce (this is a belt-and-suspenders approach, cheap enough in practice).
// chrome.tabs.onMoved.addListener(async (tabId, moveInfo) => {
//   await enforceWhenWindowChangesFor(moveInfo.windowId);
// });
// chrome.tabs.onDetached.addListener(async (tabId, detachInfo) => {
//   await enforceWhenWindowChangesFor(detachInfo.oldWindowId);
// });
