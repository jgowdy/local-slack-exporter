const startButton = document.getElementById('start');
const stopButton = document.getElementById('stop');
const diagnosticsButton = document.getElementById('diagnostics');
const statusBox = document.getElementById('status');

let localRunning = false;

function readOptions() {
  return {
    includeThreads: document.getElementById('includeThreads').checked,
    scrollDelayMs: Number(document.getElementById('scrollDelayMs').value) || 900,
    maxScrollPasses: Number(document.getElementById('maxScrollPasses').value) || 800,
    settlePasses: Number(document.getElementById('settlePasses').value) || 8,
    channelScrollFraction: 1.15,
    maxThreadScrollPasses: 120
  };
}

async function getSlackTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error('No active tab found.');
  if (!tab.url || !/^https:\/\/[^/]+\.slack\.com\//.test(tab.url)) {
    throw new Error('Open a Slack channel tab first.');
  }
  return tab;
}

async function sendToTab(message) {
  const tab = await getSlackTab();
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (error) {
    if (!/Receiving end does not exist|Could not establish connection/i.test(error.message || '')) throw error;
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await new Promise((resolve) => setTimeout(resolve, 350));
    return chrome.tabs.sendMessage(tab.id, message);
  }
}

function setRunningUi(isRunning) {
  localRunning = Boolean(isRunning);
  startButton.disabled = localRunning;
  diagnosticsButton.disabled = localRunning;
  stopButton.disabled = false;
  stopButton.textContent = localRunning ? 'Stop and download partial export' : 'Stop';
  stopButton.style.background = localRunning ? '#b3261e' : '#616061';
}

async function refreshState() {
  try {
    const state = await sendToTab({ type: 'LOCAL_SLACK_EXPORT_QUERY_STATE' });
    if (state && typeof state.running === 'boolean') {
      setRunningUi(state.running);
      if (state.status) statusBox.textContent = state.status;
    }
  } catch (_) {
    setRunningUi(false);
  }
}

diagnosticsButton.addEventListener('click', async () => {
  startButton.disabled = true;
  diagnosticsButton.disabled = true;
  statusBox.textContent = 'Building DOM diagnostics...';

  try {
    await sendToTab({ type: 'LOCAL_SLACK_EXPORT_DIAGNOSTICS' });
  } catch (error) {
    statusBox.textContent = `Error: ${error.message}`;
  } finally {
    setRunningUi(false);
  }
});

startButton.addEventListener('click', async () => {
  setRunningUi(true);
  statusBox.textContent = 'Starting export...';

  try {
    const result = await sendToTab({ type: 'LOCAL_SLACK_EXPORT_START', options: readOptions() });
    setRunningUi(result && typeof result.running === 'boolean' ? result.running : true);
  } catch (error) {
    statusBox.textContent = `Error: ${error.message}`;
    setRunningUi(false);
  }
});

stopButton.addEventListener('click', async () => {
  stopButton.disabled = false;
  statusBox.textContent = 'Stop requested. Saving partial export after the current operation...';

  try {
    const result = await sendToTab({ type: 'LOCAL_SLACK_EXPORT_STOP' });
    if (result && typeof result.running === 'boolean') setRunningUi(result.running);
  } catch (error) {
    statusBox.textContent = `Error: ${error.message}`;
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== 'LOCAL_SLACK_EXPORT_STATUS') return;
  statusBox.textContent = message.status;
  if (typeof message.running === 'boolean') setRunningUi(message.running);
  if (message.done) setRunningUi(false);
});

setRunningUi(false);
refreshState();
