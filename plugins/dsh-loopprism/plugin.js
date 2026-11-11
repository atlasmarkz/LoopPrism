// LoopPrism for DeepSeek Harness. A function plugin: `name`, `inject` and `apply` only, no
// default export (the harness loader reads the module namespace). The logic is in ./lib/index.js.
import { install } from './lib/index.js';

// Resolved from the harness the plugin is mounted in. If it cannot be found the live half still
// works and only the review tools are skipped (install() logs it).
let defineTool;
try {
  ({ defineTool } = await import('@deepseek-ai/dsh-tools'));
} catch {
  /* not resolvable from here */
}

export const name = 'loopprism';
export const inject = ['tools', 'agents'];

export function apply(ctx, config) {
  install(ctx, config ?? {}, { defineTool });
}
