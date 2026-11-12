export interface ShutdownEvent {
    preventDefault(): void;
    stopImmediatePropagation?(): void;
    returnValue?: unknown;
}
export class TaskShutdown {
    private allowing = false;
    private busy = false;
    private disposed = false;
    constructor(private unfinished: () => boolean, private prompt: () => Promise<boolean>, private save: () => Promise<void>, private close: () => void, private error: (error: unknown) => void, private reveal: () => void = () => { }) { }
    onNativeClose(event: Pick<ShutdownEvent,'preventDefault'>): void {
        this.onClose(event);
    }
    onClose(event: ShutdownEvent): void {
        if (this.allowing || this.disposed || !this.unfinished())
            return;
        event.preventDefault();
        event.stopImmediatePropagation?.();
        event.returnValue = false;
        window.setTimeout(() => { if (!this.allowing && !this.disposed)
            { if (typeof document !== 'undefined') clearHeldQuitProgress(document); this.reveal(); } }, 0);
        if (this.busy)
            return;
        this.busy = true;
        void (async () => { try {
            if (!await this.prompt() || this.disposed)
                return;
            await this.save();
            if (this.disposed)
                return;
            this.allowing = true;
            this.close();
        }
        catch (error) {
            this.error(error);
        }
        finally {
            this.busy = false;
        } })();
    }
    dispose(): void { this.disposed = true; }
}

export function installNativeTaskCloseGuard(shutdown:TaskShutdown):()=>void{
    interface NativeWindow {on(name:string,fn:(event:ShutdownEvent)=>void):void;removeListener(name:string,fn:(event:ShutdownEvent)=>void):void}
    const electron=(window as unknown as {require:(id:string)=>{remote:{getCurrentWindow:()=>NativeWindow}}}).require('electron');
    const native=electron.remote.getCurrentWindow();
    const hold=(event:ShutdownEvent)=>shutdown.onNativeClose(event);
    native.on('close',hold);
    return ()=>native.removeListener('close',hold);
}

// Obsidian's private quit progress singleton remains mounted after a held close.
// Mirror hide() only for that Saving screen, leaving other progress untouched.
export function clearHeldQuitProgress(doc: Document): void {
    if (!doc.body.classList.contains('in-progress')) return;
    let removed = false;
    for (const node of Array.from(doc.querySelectorAll<HTMLElement>('body > .progress-bar-container'))) {
        const message = node.querySelector('.progress-bar-message')?.textContent?.trim() || '';
        if (/^(Saving|正在保存|保存中)(?:\.{3}|…)?$/i.test(message)) { node.remove(); removed = true; }
    }
    if (removed) doc.body.classList.remove('in-progress');
}
