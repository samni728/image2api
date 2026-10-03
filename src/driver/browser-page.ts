import type { Page } from '@jackwener/opencli/browser/page';

export type BrowserPage = Pick<Page, 'goto' | 'evaluate' | 'click' | 'nativeType' | 'closeWindow'>;

/** Require a signed-in, loaded ChatGPT page before interpreting missing DOM as data. */
export async function waitForChatGPTReady(page: BrowserPage, expectedUrl?: string): Promise<void> {
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    const state = await page.evaluate<{ url: string; composer: boolean }>(`(()=>({
      url:location.href,
      composer:!!document.querySelector('[contenteditable="true"][role="textbox"], #prompt-textarea, textarea')
    }))()`);
    if (!state || typeof state.url !== 'string' || typeof state.composer !== 'boolean') {
      throw new Error('Invalid ChatGPT page readiness result.');
    }
    const current = new URL(state.url);
    if (current.hostname !== 'chatgpt.com' || /\/(auth|login|signin)(\/|$)/i.test(current.pathname)) {
      throw new Error('ChatGPT redirected to login or an unexpected site.');
    }
    if (state.composer) {
      if (expectedUrl && current.pathname !== new URL(expectedUrl).pathname) {
        throw new Error('ChatGPT redirected away from the requested page.');
      }
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  throw new Error('ChatGPT page did not become ready.');
}
