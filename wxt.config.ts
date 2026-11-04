import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  outDir: 'dist',
  manifest: {
    name: 'Sum it up!',
    description: 'Summarize pages and selected text with your own AI key.',
    minimum_chrome_version: '141',
    permissions: ['sidePanel', 'storage', 'scripting'],
    host_permissions: ['<all_urls>'],
    action: { default_title: 'Sum it up!' },
  },
  hooks: {
    // A default panel would be on every tab, and Chrome lists it there after a restart.
    // With none, a toolbar click turns the panel on for that one tab.
    'build:manifestGenerated': (_wxt, manifest) => {
      delete manifest.side_panel;
    },
  },
});
