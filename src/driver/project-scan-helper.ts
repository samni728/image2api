import { config } from '../config.js';
import { waitForChatGPTReady, type BrowserPage } from './browser-page.js';

export type ProjectConversation = {
  conversationId: string;
  conversationUrl: string;
  title: string;
};

export async function listProjectConversations(page: BrowserPage): Promise<ProjectConversation[]> {
  if (!config.projectUrl || !config.projectId) return [];
  await page.goto(config.projectUrl, { settleMs: 1200 });
  await waitForChatGPTReady(page, config.projectUrl);

  const projectId = config.projectId;
  const rows = await page.evaluate(`(()=>{
    const projectId=${JSON.stringify(projectId)};
    const seen=new Set();
    return [...document.querySelectorAll('a')].map(a=>({
      href:a.getAttribute('href')||'',
      title:(a.innerText||a.getAttribute('aria-label')||'').trim()
    })).filter(x=>x.href.includes('/g/g-p-'+projectId+'/c/')).filter(x=>{
      if(seen.has(x.href)) return false;
      seen.add(x.href);
      return true;
    });
  })()`);

  if (!Array.isArray(rows)) throw new Error('Invalid project conversation scan result.');
  const out: ProjectConversation[] = [];
  for (const row of rows as any[]) {
    const href = String(row?.href || '');
    const match = href.match(/\/c\/([0-9a-f-]{20,})/i);
    if (!match) continue;
    const absolute = href.startsWith('http') ? href : `https://chatgpt.com${href}`;
    out.push({
      conversationId: match[1],
      conversationUrl: absolute,
      title: String(row?.title || ''),
    });
  }
  return out;
}
