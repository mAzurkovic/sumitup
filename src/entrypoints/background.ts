// Chrome keeps this setting in memory, so a browser restart resets it to enabled.
function disablePanel() {
  browser.sidePanel.setOptions({ enabled: false });
}

export default defineBackground(() => {
  disablePanel();
  browser.runtime.onStartup.addListener(disablePanel);
});
