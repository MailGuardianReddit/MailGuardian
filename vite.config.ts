import { defineConfig } from 'vite';
import { devvit } from '@devvit/start/vite';
import * as fs from 'node:fs';
import * as path from 'node:path';

const aiPrivateEntry = path.resolve(__dirname, 'src/server/ai-private/index.ts');
const aiPrivateAvailable = fs.existsSync(aiPrivateEntry);
const aiPrivateAliasTarget = aiPrivateAvailable
  ? aiPrivateEntry
  : path.resolve(__dirname, 'src/server/ai-public/index.ts');

export default defineConfig({
  plugins: [devvit()],
  define: {
    __AMU_HAS_PRIVATE_AI__: JSON.stringify(aiPrivateAvailable),
  },
  resolve: {
    alias: {
      '@ai': path.resolve(__dirname, 'src/server/ai/index.ts'),
      '@ai-private': aiPrivateAliasTarget,
    },
  },
});
