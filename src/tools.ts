import type { FullConfig } from './config.js';
import { batchExecuteTool } from './tools/batch-execute.js';
import common from './tools/common.js';
import console from './tools/console.js';
import { browserDiagnose } from './tools/diagnose.js';
import dialogs from './tools/dialogs.js';
import emulate from './tools/emulate.js';
import evaluate from './tools/evaluate.js';
import files from './tools/files.js';
import { browserFindElements } from './tools/find-elements.js';
import form from './tools/form.js';
import getConfig from './tools/get-config.js';
import inspectHtml from './tools/inspect-html.js';
import install from './tools/install.js';
import keyboard from './tools/keyboard.js';
import mouse from './tools/mouse.js';
import navigate from './tools/navigate.js';
import network from './tools/network.js';
import pdf from './tools/pdf.js';
import route from './tools/route.js';
import screenshot from './tools/screenshot.js';
import snapshot from './tools/snapshot.js';
import storage from './tools/storage.js';
import tabs from './tools/tabs.js';
import type { AnyTool } from './tools/tool.js';
import tracing from './tools/tracing.js';
import verify from './tools/verify.js';
import wait from './tools/wait.js';
export const allTools: AnyTool[] = [
  ...common,
  ...console,
  ...dialogs,
  ...emulate,
  ...evaluate,
  ...files,
  ...form,
  ...getConfig,
  ...install,
  ...inspectHtml,
  ...keyboard,
  ...navigate,
  ...network,
  ...mouse,
  ...pdf,
  ...route,
  ...screenshot,
  ...snapshot,
  ...storage,
  ...tabs,
  ...tracing,
  ...verify,
  ...wait,
  batchExecuteTool,
  browserFindElements,
  browserDiagnose,
];
export function filteredTools(config: FullConfig): AnyTool[] {
  const isChromium = config.browser.browserName === 'chromium';
  return allTools.filter((tool) => {
    // Chromium-only tools (CDP-backed cache/throttle) are hidden entirely on
    // Firefox/WebKit, where newCDPSession is unavailable.
    if (tool.chromiumOnly && !isChromium) {
      return false;
    }
    return (
      tool.capability.startsWith('core') ||
      config.capabilities?.includes(tool.capability)
    );
  });
}
