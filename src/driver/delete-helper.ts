import { waitForChatGPTReady, type BrowserPage } from './browser-page.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function conversationIdFromUrl(url: string) {
  try {
    const pathname = decodeURIComponent(new URL(url).pathname);
    return pathname.match(/\/c\/([0-9a-f]{8}-[0-9a-f-]{20,})/i)?.[1] || '';
  } catch {
    return '';
  }
}

export async function deleteConversation(page: BrowserPage, conversationUrl: string): Promise<boolean> {
  const id = conversationIdFromUrl(conversationUrl);
  if (!id) return false;
  try {
    await page.goto(conversationUrl, { settleMs: 1200 });
    await waitForChatGPTReady(page, conversationUrl);

    const markedMenu = await page.evaluate(`(()=>{
      const id=${JSON.stringify(id)};
      const link=[...document.querySelectorAll('a')].find(a=>(a.getAttribute('href')||'').includes('/c/'+id));
      const row=link?.closest('[role="listitem"]');
      const b=row?.querySelector('button[aria-label="聊天操作"], button[aria-label="Chat options"], button[aria-haspopup="menu"]');
      if(!(b instanceof HTMLElement))return {ok:false,link:!!link,row:!!row};
      b.setAttribute('data-w2a-delete-menu','1'); return {ok:true};
    })()`);
    if (!(markedMenu as any)?.ok) return false;
    await page.click('[data-w2a-delete-menu="1"]');
    await sleep(650);

    const markedDelete = await page.evaluate(`(()=>{
      const el=[...document.querySelectorAll('[role="menuitem"]')].find(x=>/^(删除|Delete)$/i.test((x.innerText||'').trim()));
      if(!(el instanceof HTMLElement))return false;
      el.setAttribute('data-w2a-delete-item','1'); return true;
    })()`);
    if (!markedDelete) return false;
    await page.click('[data-w2a-delete-item="1"]');
    await sleep(650);

    const markedConfirm = await page.evaluate(`(()=>{
      const d=document.querySelector('[role="dialog"]'); if(!d)return false;
      const buttons=[...d.querySelectorAll('button')];
      const b=buttons.find(x=>/^(删除聊天|Delete chat)$/i.test((x.innerText||'').trim())) || buttons.filter(x=>/删除|Delete/i.test((x.innerText||'').trim())).at(-1);
      if(!(b instanceof HTMLElement))return false;
      b.setAttribute('data-w2a-delete-confirm','1'); return true;
    })()`);
    if (!markedConfirm) return false;
    await page.click('[data-w2a-delete-confirm="1"]');
    // DOM evidence is a conservative confirmation, not a server-side receipt.
    // Give navigation/sidebar/dialog updates up to eight seconds to converge.
    const end = Date.now() + 8_000;
    while (Date.now() < end) {
      const state = await page.evaluate<{ url: string; composer: boolean; exists: boolean; dialogOpen: boolean }>(`(()=>({
        url:location.href,
        composer:!!document.querySelector('[contenteditable="true"][role="textbox"], #prompt-textarea, textarea'),
        exists:[...document.querySelectorAll('a')].some(a=>(a.getAttribute('href')||'').includes('/c/'+${JSON.stringify(id)})),
        dialogOpen:!!document.querySelector('[role="dialog"]')
      }))()`);
      if (!state || typeof state.url !== 'string') return false;
      const current = new URL(state.url);
      if (current.hostname !== 'chatgpt.com' || /\/(auth|login|signin)(\/|$)/i.test(current.pathname)) return false;
      if (state.composer === true && state.exists === false && state.dialogOpen === false &&
          conversationIdFromUrl(state.url) !== id) return true;
      await sleep(400);
    }
    return false;
  } catch {
    // Failed navigation, login redirects and incomplete DOM are never proof of deletion.
    return false;
  }
}
