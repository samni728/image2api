import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Page } from '@jackwener/opencli/browser/page';
import { config } from '../config.js';
import type { DriverResult, GeneratedAsset } from '../types.js';
import type { BrowserPage } from './browser-page.js';
import { deleteConversation } from './delete-helper.js';
import { listProjectConversations, type ProjectConversation } from './project-scan-helper.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const CHATGPT = 'https://chatgpt.com';

type GenerateOptions = {
  prompt: string;
  imagePaths?: string[];
  conversationUrl?: string;
  size?: string;
  quality?: string;
  background?: string;
};

export class ChatGPTImageDriver {
  constructor(private readonly page: BrowserPage = new Page(
    config.browserSession,
    config.browserIdleSeconds,
    undefined,
    config.windowMode,
    'adapter',
    'persistent',
  )) {}

  private closing?: Promise<void>;

  private queue: Promise<unknown> = Promise.resolve();

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('Browser driver is closed.'));
    const run = this.queue.then(fn, fn);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async ping(): Promise<{ ok: boolean; url?: string; error?: string }> {
    return this.serial(async () => {
      try {
        await this.page.goto(CHATGPT, { settleMs: 800 });
        let result: any = null;
        const end = Date.now() + 10_000;
        while (Date.now() < end) {
          result = await this.page.evaluate(`(()=>({url:location.href, composer:!!document.querySelector('[contenteditable="true"][role="textbox"], #prompt-textarea, textarea')}))()`);
          if (result?.composer) break;
          await sleep(400);
        }
        return { ok: Boolean(result?.composer), url: String(result?.url || '') };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  async generate(options: GenerateOptions): Promise<DriverResult> {
    return this.serial(() => this.generateUnsafe(options));
  }

  private async generateUnsafe(options: GenerateOptions): Promise<DriverResult> {
    const imagePaths = options.imagePaths ?? [];
    const isContinuation = Boolean(options.conversationUrl);
    const target = options.conversationUrl || config.projectUrl || (config.projectId ? `${CHATGPT}/g/g-p-${config.projectId}/project` : `${CHATGPT}/new`);
    await this.page.goto(target, { settleMs: 1200 });
    await this.waitForComposer(15_000);

    const beforeSources = new Set(await this.getGeneratedSources());
    if (imagePaths.length) {
      await this.uploadImages(imagePaths);
    }

    const prompt = this.decoratePrompt(options, isContinuation);
    await this.sendPrompt(prompt);
    const conversationUrl = await this.waitForConversationUrl(20_000);
    const newSources = await this.waitForNewGeneratedSources(beforeSources, config.generationTimeoutMs);
    if (!newSources.length) throw new Error('ChatGPT finished without a detectable generated image.');

    const assets: GeneratedAsset[] = [];
    for (const src of newSources) {
      const asset = await this.exportImage(src);
      if (!asset) continue;
      fs.mkdirSync(config.outputDir, { recursive: true });
      const ext = asset.mimeType.includes('webp') ? 'webp' : asset.mimeType.includes('jpeg') || asset.mimeType.includes('jpg') ? 'jpg' : 'png';
      const filePath = path.join(config.outputDir, `chatgpt_${Date.now()}_${crypto.randomBytes(5).toString('hex')}.${ext}`);
      fs.writeFileSync(filePath, Buffer.from(asset.base64, 'base64'));
      asset.filePath = filePath;
      assets.push(asset);
    }
    if (!assets.length) throw new Error('Generated image was visible but could not be exported.');

    const conversationId = this.conversationIdFromUrl(conversationUrl);
    if (!conversationId) throw new Error(`Could not parse ChatGPT conversation id from ${conversationUrl}`);
    return { conversationId, conversationUrl, assets };
  }

  private decoratePrompt(options: GenerateOptions, continuation: boolean): string {
    const hasImages = Boolean(options.imagePaths?.length);
    let text = hasImages
      ? `Edit the attached image${options.imagePaths!.length === 1 ? '' : 's'}: ${options.prompt}`
      : continuation
        ? `Continue editing the previously generated image: ${options.prompt}. Generate the updated image.`
        : `Generate an image of: ${options.prompt}`;
    const hints: string[] = [];
    if (options.size && options.size !== 'auto') hints.push(`requested output size/aspect ratio ${options.size}`);
    if (options.quality && options.quality !== 'auto') hints.push(`requested quality ${options.quality}`);
    if (options.background && options.background !== 'auto') hints.push(`background ${options.background}`);
    if (hints.length) text += `\nPreferences: ${hints.join('; ')}.`;
    return text;
  }

  private async waitForComposer(timeoutMs: number) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const ok = await this.page.evaluate(`(()=>!!document.querySelector('[contenteditable="true"][role="textbox"], #prompt-textarea, textarea'))()`);
      if (ok) return;
      await sleep(500);
    }
    throw new Error('ChatGPT composer did not become ready.');
  }

  private async sendPrompt(text: string) {
    const focused = await this.page.evaluate(`(()=>{
      const selectors=['[contenteditable="true"][role="textbox"]','#prompt-textarea','textarea'];
      const c=selectors.map(s=>document.querySelector(s)).find(Boolean);
      if(!c)return false;
      c.focus();
      if(c instanceof HTMLTextAreaElement || c instanceof HTMLInputElement)c.value='';
      else { c.textContent=''; c.innerHTML='<p><br></p>'; }
      c.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward',data:null}));
      return true;
    })()`);
    if (!focused) throw new Error('Could not focus ChatGPT composer.');
    await this.page.nativeType(text);

    const end = Date.now() + 12_000;
    while (Date.now() < end) {
      const sent = await this.page.evaluate(`(()=>{
        const labels=['发送','发送提示','Send','Send prompt','Send message'];
        const buttons=[...document.querySelectorAll('button')];
        const b=document.querySelector('button[data-testid="send-button"]:not([disabled]), #composer-submit-button:not([disabled])') ||
          buttons.find(x=>labels.includes(x.getAttribute('aria-label')||'') && !x.disabled && x.getAttribute('aria-disabled')!=='true');
        if(!b)return false; b.click(); return true;
      })()`);
      if (sent) return;
      await sleep(400);
    }
    throw new Error('Could not find an enabled ChatGPT send button.');
  }

  private async uploadImages(paths: string[]) {
    for (const p of paths) {
      const stat = fs.statSync(p);
      if (!stat.isFile()) throw new Error(`Input image is not a file: ${p}`);
      if (stat.size > config.maxInputBytes) throw new Error(`Input image exceeds MAX_INPUT_IMAGE_BYTES: ${p}`);
    }

    const fileIds: string[] = [];
    await this.page.evaluate(`(()=>{window.__w2aChunks={};window.__w2aFiles=[];return true})()`);
    for (const filePath of paths) {
      const id = crypto.randomBytes(8).toString('hex');
      fileIds.push(id);
      const name = path.basename(filePath);
      const mime = this.mimeFromPath(filePath);
      const b64 = fs.readFileSync(filePath).toString('base64');
      await this.page.evaluate(`(()=>{window.__w2aChunks[${JSON.stringify(id)}]=[];return true})()`);
      const chunkSize = 384 * 1024;
      for (let offset = 0; offset < b64.length; offset += chunkSize) {
        const chunk = b64.slice(offset, offset + chunkSize);
        await this.page.evaluate(`(()=>{window.__w2aChunks[${JSON.stringify(id)}].push(${JSON.stringify(chunk)});return window.__w2aChunks[${JSON.stringify(id)}].length})()`);
      }
      await this.page.evaluate(`(()=>{
        const id=${JSON.stringify(id)}, name=${JSON.stringify(name)}, mime=${JSON.stringify(mime)};
        const b64=window.__w2aChunks[id].join('');
        const bin=atob(b64); const bytes=new Uint8Array(bin.length);
        for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
        window.__w2aFiles.push(new File([bytes],name,{type:mime}));
        delete window.__w2aChunks[id]; return {name,size:bytes.length};
      })()`);
    }

    const attached = await this.page.evaluate(`(()=>{
      const inputs=[...document.querySelectorAll('input[type="file"]')];
      const input=inputs.find(x=>(x.getAttribute('accept')||'')==='image/*') || inputs.find(x=>(x.getAttribute('accept')||'').includes('image')) || inputs[0];
      if(!(input instanceof HTMLInputElement))return {ok:false,reason:'file input not found'};
      const dt=new DataTransfer(); for(const f of window.__w2aFiles)dt.items.add(f); input.files=dt.files;
      const propsKey=Object.keys(input).find(k=>k.startsWith('__reactProps$'));
      if(propsKey && input[propsKey] && typeof input[propsKey].onChange==='function'){
        const nativeEvent=new Event('change',{bubbles:true});
        input[propsKey].onChange({target:input,currentTarget:input,nativeEvent,preventDefault(){},stopPropagation(){},isDefaultPrevented(){return false},isPropagationStopped(){return false},persist(){}});
      } else {
        input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true}));
      }
      const count=dt.files.length; window.__w2aFiles=[]; return {ok:true,count};
    })()`);
    if (!(attached as any)?.ok) throw new Error(`Could not attach image(s): ${(attached as any)?.reason || 'unknown error'}`);
    await sleep(1800);
  }

  private mimeFromPath(filePath: string) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.png') return 'image/png';
    if (ext === '.webp') return 'image/webp';
    if (ext === '.gif') return 'image/gif';
    return 'image/jpeg';
  }

  private async getGeneratedSources(): Promise<string[]> {
    const values = await this.page.evaluate(`(()=>[...document.images]
      .filter(i=>/已生成图像|generated image/i.test(i.alt||''))
      .map(i=>i.currentSrc||i.src||'').filter(Boolean))()`);
    return Array.isArray(values) ? values.map(String) : [];
  }

  private async waitForNewGeneratedSources(before: Set<string>, timeoutMs: number): Promise<string[]> {
    const end = Date.now() + timeoutMs;
    let lastKey = '';
    let stable = 0;
    let last: string[] = [];
    while (Date.now() < end) {
      await sleep(2500);
      const state = await this.page.evaluate(`(()=>({
        generating:[...document.querySelectorAll('button')].some(b=>/停止生成|stop generating|thinking|正在生成/i.test((b.getAttribute('aria-label')||'')+' '+(b.innerText||''))),
        sources:[...document.images].filter(i=>/已生成图像|generated image/i.test(i.alt||'')).map(i=>i.currentSrc||i.src||'').filter(Boolean)
      }))()`);
      const sources = Array.isArray((state as any)?.sources) ? (state as any).sources.map(String).filter((s:string)=>!before.has(s)) : [];
      if (sources.length) {
        const key = sources.join('\n');
        stable = key === lastKey ? stable + 1 : 1;
        lastKey = key;
        last = sources;
        if (!(state as any)?.generating && stable >= 2) return last;
      }
    }
    if (last.length) return last;
    throw new Error(`Image generation timed out after ${Math.round(timeoutMs / 1000)}s.`);
  }

  private async waitForConversationUrl(timeoutMs: number): Promise<string> {
    const end = Date.now() + timeoutMs;
    let latest = '';
    while (Date.now() < end) {
      latest = String(await this.page.evaluate('location.href') || '');
      if (/\/c\/[0-9a-f]{8}-[0-9a-f-]{20,}/i.test(decodeURIComponent(latest))) return latest;
      await sleep(400);
    }
    if (latest) return latest;
    throw new Error('ChatGPT conversation URL was not captured.');
  }

  private conversationIdFromUrl(url: string) {
    try { const pathname=decodeURIComponent(new URL(url).pathname); const id=pathname.match(/\/c\/([0-9a-f]{8}-[0-9a-f-]{20,})/i)?.[1] || ''; return id; } catch { return ''; }
  }

  private async exportImage(src: string): Promise<GeneratedAsset | null> {
    const result = await this.page.evaluate(`(async()=>{
      const src=${JSON.stringify(src)};
      const img=[...document.images].find(i=>(i.currentSrc||i.src||'')===src);
      let dataUrl=''; let mime='image/png';
      try {
        if(src.startsWith('data:')) dataUrl=src;
        else { const r=await fetch(src,{credentials:'include'}); if(r.ok){const b=await r.blob();mime=b.type||mime;dataUrl=await new Promise((resolve,reject)=>{const fr=new FileReader();fr.onloadend=()=>resolve(String(fr.result||''));fr.onerror=reject;fr.readAsDataURL(b);});} }
      } catch(e) {}
      if(!dataUrl && img){try{const c=document.createElement('canvas');c.width=img.naturalWidth||img.width;c.height=img.naturalHeight||img.height;const x=c.getContext('2d');x.drawImage(img,0,0);dataUrl=c.toDataURL('image/png');mime='image/png';}catch(e){}}
      if(!dataUrl)return null;
      const m=dataUrl.match(/^data:([^;]+);base64,(.*)$/s); if(!m)return null;
      return {mimeType:m[1]||mime,base64:m[2],width:img?.naturalWidth||0,height:img?.naturalHeight||0};
    })()`);
    if (!result || typeof result !== 'object') return null;
    return result as GeneratedAsset;
  }

  async deleteConversation(conversationUrl: string): Promise<boolean> {
    return this.serial(() => deleteConversation(this.page, conversationUrl));
  }

  async listProjectConversations(): Promise<ProjectConversation[]> {
    return this.serial(() => listProjectConversations(this.page));
  }

  close(): Promise<void> {
    // Release this Page's session lease after already queued operations finish.
    this.closing ??= this.queue.then(() => this.page.closeWindow());
    return this.closing;
  }
}

export const chatgptDriver = new ChatGPTImageDriver();
