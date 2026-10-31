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
});
