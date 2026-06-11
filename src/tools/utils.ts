import type * as playwright from 'playwright';
import { TIMEOUTS } from '../config/constants.js';
import type { Tab } from '../tab.js';
import { toolsUtilsDebug } from '../utils/log.js';
export async function waitForCompletion<R>(
  tab: Tab,
  callback: () => Promise<R>
): Promise<R> {
  const requests = new Set<playwright.Request>();
  let frameNavigated = false;
  let navigationCompleted = false;
  let waitCallback: () => void = () => {
    // Default empty callback
  };
  const waitBarrier = new Promise<void>((f) => {
    waitCallback = f;
  });
  const requestListener = (request: playwright.Request) =>
    requests.add(request);
  const requestFinishedListener = (request: playwright.Request) => {
    requests.delete(request);
    if (!requests.size && navigationCompleted) {
      waitCallback();
    }
  };
  const frameNavigateListener = (frame: playwright.Frame) => {
    if (frame.parentFrame()) {
      return;
    }
    frameNavigated = true;

    // Enhanced navigation handling with stability checks
    (async () => {
      try {
        await tab.waitForLoadState('load');
        await tab
          .waitForLoadState('networkidle', {
            timeout: getNavigationConfig().networkIdleTimeout,
          })
          .catch((error) => {
            toolsUtilsDebug('Network idle timeout reached:', error);
          });
        navigationCompleted = true;
        if (!requests.size) {
          waitCallback();
        }
      } catch (error) {
        // Fallback if load states fail
        toolsUtilsDebug('Load state waiting failed, continuing:', error);
        navigationCompleted = true;
        waitCallback();
      }
    })().catch((error) => {
      toolsUtilsDebug('Navigation handling failed:', error);
      navigationCompleted = true;
      waitCallback();
    });
  };
  const onTimeout = () => {
    dispose();
    navigationCompleted = true;
    waitCallback();
  };
  tab.page.on('request', requestListener);
  tab.page.on('requestfinished', requestFinishedListener);
  tab.page.on('framenavigated', frameNavigateListener);
  const timeout = setTimeout(
    onTimeout,
    getNavigationConfig().completionTimeout
  );
  const dispose = () => {
    tab.page.off('request', requestListener);
    tab.page.off('requestfinished', requestFinishedListener);
    tab.page.off('framenavigated', frameNavigateListener);
    clearTimeout(timeout);
  };
  try {
    const result = await callback();
    if (!(requests.size || frameNavigated)) {
      navigationCompleted = true;
      waitCallback();
    }
    await waitBarrier;
    // Additional stability wait with context verification
    if (frameNavigated) {
      await tab.waitForTimeout(getNavigationConfig().stabilityWait);
      // Verify page is still responsive
      try {
        await tab.page.evaluate(() => document.readyState);
      } catch (error) {
        // Context might be destroyed, but we still return the result
        toolsUtilsDebug(
          'Page readyState check failed (context may be destroyed):',
          error
        );
      }
    } else {
      await tab.waitForTimeout(getNavigationConfig().defaultWait);
    }
    return result;
  } finally {
    dispose();
  }
}
export async function generateLocator(
  locator: playwright.Locator
): Promise<string> {
  try {
    // Playwright 1.61 removed the internal locator._resolveSelector(). The
    // public normalize() is the equivalent: it resolves an aria-ref locator to
    // a concrete, readable locator whose toString() is the generated code.
    const normalized = await locator.normalize();
    return normalized.toString();
  } catch (error) {
    toolsUtilsDebug('Locator generation failed:', error);
    // Code generation is for display only — never fail the action over it.
    // The action itself will surface a precise error if the element is gone.
    return locator.toString();
  }
}
export async function callOnPageNoTrace<T>(
  page: playwright.Page,
  callback: (p: playwright.Page) => Promise<T>
): Promise<T> {
  return await (
    page as unknown as {
      _wrapApiCall: <U>(
        fn: () => Promise<U>,
        opts: { internal: boolean }
      ) => Promise<U>;
    }
  )._wrapApiCall(() => callback(page), {
    internal: true,
  });
}

function getNavigationConfig() {
  return {
    networkIdleTimeout: TIMEOUTS.NETWORK_IDLE_TIMEOUT,
    completionTimeout: 15_000,
    stabilityWait: TIMEOUTS.STABILITY_WAIT,
    defaultWait: TIMEOUTS.WAIT_FOR_COMPLETION,
  };
}
