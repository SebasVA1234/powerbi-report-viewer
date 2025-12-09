class WindowManager {
    constructor() {
        this.windows = new Map();
        this.windowIdCounter = 0;
        this.maxWindows = 5;
        this.activeWindowId = null;
        this.zIndexBase = 1000;
        this.zIndexCounter = 0;
        this.cascadeOffset = { x: 30, y: 30 };
        this.nextPosition = { x: 80, y: 60 };
        this.dragState = null;
        this.resizeState = null;
        this.init();
        this.loadConfig();
    }
    
    async loadConfig() {
        try {
            const response = await fetch('/api/config/public');
            const data = await response.json();
            if (data.success && data.data.max_report_windows) {
                this.maxWindows = parseInt(data.data.max_report_windows);
                this.updateWindowCount();
            }
        } catch (error) {
            console.warn('No se pudo cargar configuración, usando valores por defecto');
        }
    }
    
    init() {
        if (!document.getElementById('windows-container')) {
            const container = document.createElement('div');
            container.id = 'windows-container';
            document.body.appendChild(container);
        }
        
        if (!document.getElementById('taskbar')) {
            const taskbar = document.createElement('div');
            taskbar.id = 'taskbar';
            taskbar.innerHTML = `
                <div class="taskbar-windows"></div>
                <div class="taskbar-info">
                    <span class="window-count">0 / ${this.maxWindows} ventanas</span>
                </div>
            `;
            document.body.appendChild(taskbar);
        }
        
        document.addEventListener('mousemove', (e) => this.handleMouseMove(e));
        document.addEventListener('mouseup', (e) => this.handleMouseUp(e));
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.activeWindowId) {
                const win = this.windows.get(this.activeWindowId);
                if (win && win.maximized) this.toggleMaximize(this.activeWindowId);
            }
        });
    }
    
    setMaxWindows(max) {
        this.maxWindows = Math.max(1, Math.min(10, max));
        this.updateWindowCount();
    }
    
    openWindow(reportId, title, embedUrl) {
        for (const [id, win] of this.windows) {
            if (win.reportId === reportId) {
                this.focusWindow(id);
                if (win.minimized) this.toggleMinimize(id);
                return id;
            }
        }
        
        if (this.windows.size >= this.maxWindows) {
            if (typeof Notification !== 'undefined' && Notification.warning) {
                Notification.warning(`Máximo ${this.maxWindows} ventanas permitidas. Cierra una para abrir otra.`);
            }
            return null;
        }
        
        const windowId = ++this.windowIdCounter;
        const position = this.getNextPosition();
        const defaultWidth = Math.min(1200, window.innerWidth * 0.7);
        const defaultHeight = Math.min(700, window.innerHeight * 0.75);
        
        const windowEl = document.createElement('div');
        windowEl.className = 'report-window';
        windowEl.id = `window-${windowId}`;
        windowEl.style.cssText = `left:${position.x}px;top:${position.y}px;width:${defaultWidth}px;height:${defaultHeight}px;z-index:${this.getNextZIndex()};`;
        
        windowEl.innerHTML = `
            <div class="window-header" data-window-id="${windowId}">
                <div class="window-title">
                    <svg class="window-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="3" x2="9" y2="21"></line></svg>
                    <span class="window-title-text">${this.escapeHtml(title)}</span>
                </div>
                <div class="window-controls">
                    <button class="window-btn window-btn-minimize" onclick="windowManager.toggleMinimize(${windowId})" title="Minimizar">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                    </button>
                    <button class="window-btn window-btn-maximize" onclick="windowManager.toggleMaximize(${windowId})" title="Maximizar">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>
                    </button>
                    <button class="window-btn window-btn-close" onclick="windowManager.closeWindow(${windowId})" title="Cerrar">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                    </button>
                </div>
            </div>
            <div class="window-body">
                <div class="window-loading"><div class="loading-spinner"></div><span>Cargando reporte...</span></div>
                <iframe class="window-iframe" src="${embedUrl}" allowfullscreen="true"></iframe>
            </div>
            <div class="window-resize-handle" data-window-id="${windowId}"></div>
        `;
        
        document.getElementById('windows-container').appendChild(windowEl);
        
        this.windows.set(windowId, { id: windowId, reportId, title, embedUrl, element: windowEl, minimized: false, maximized: false, previousState: null });
        
        const header = windowEl.querySelector('.window-header');
        header.addEventListener('mousedown', (e) => this.startDrag(e, windowId));
        header.addEventListener('dblclick', () => this.toggleMaximize(windowId));
        
        windowEl.querySelector('.window-resize-handle').addEventListener('mousedown', (e) => this.startResize(e, windowId));
        windowEl.addEventListener('mousedown', () => this.focusWindow(windowId));
        windowEl.querySelector('.window-iframe').addEventListener('load', () => { windowEl.querySelector('.window-loading').style.display = 'none'; });
        
        this.addToTaskbar(windowId, title);
        this.focusWindow(windowId);
        document.body.classList.add('has-taskbar');
        this.updateWindowCount();
        return windowId;
    }
    
    closeWindow(windowId) {
        const win = this.windows.get(windowId);
        if (!win) return;
        win.element.classList.add('closing');
        setTimeout(() => {
            win.element.remove();
            this.windows.delete(windowId);
            this.removeFromTaskbar(windowId);
            this.updateWindowCount();
            if (this.windows.size === 0) document.body.classList.remove('has-taskbar');
            else {
                const nextWindow = Array.from(this.windows.values()).pop();
                if (nextWindow) this.focusWindow(nextWindow.id);
            }
        }, 200);
    }
    
    toggleMinimize(windowId) {
        const win = this.windows.get(windowId);
        if (!win) return;
        win.minimized = !win.minimized;
        if (win.minimized) {
            win.element.classList.add('minimized');
            this.updateTaskbarButton(windowId, { minimized: true });
            const visibleWindows = Array.from(this.windows.values()).filter(w => !w.minimized);
            if (visibleWindows.length > 0) this.focusWindow(visibleWindows[visibleWindows.length - 1].id);
        } else {
            win.element.classList.remove('minimized');
            this.updateTaskbarButton(windowId, { minimized: false });
            this.focusWindow(windowId);
        }
    }
    
    toggleMaximize(windowId) {
        const win = this.windows.get(windowId);
        if (!win) return;
        const btn = win.element.querySelector('.window-btn-maximize');
        if (win.maximized) {
            win.element.classList.remove('maximized');
            if (win.previousState) {
                win.element.style.left = win.previousState.left;
                win.element.style.top = win.previousState.top;
                win.element.style.width = win.previousState.width;
                win.element.style.height = win.previousState.height;
            }
            win.maximized = false;
            btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>`;
        } else {
            win.previousState = { left: win.element.style.left, top: win.element.style.top, width: win.element.style.width, height: win.element.style.height };
            win.element.classList.add('maximized');
            win.maximized = true;
            btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="5" width="14" height="14" rx="1" ry="1"></rect><path d="M9 3h10a2 2 0 0 1 2 2v10"></path></svg>`;
        }
        this.focusWindow(windowId);
    }
    
    focusWindow(windowId) {
        const win = this.windows.get(windowId);
        if (!win) return;
        this.windows.forEach((w, id) => { w.element.classList.remove('active'); this.updateTaskbarButton(id, { focused: false }); });
        win.element.classList.add('active');
        win.element.style.zIndex = this.getNextZIndex();
        this.activeWindowId = windowId;
        this.updateTaskbarButton(windowId, { focused: true });
    }
    
    startDrag(e, windowId) {
        if (e.target.closest('.window-controls')) return;
        const win = this.windows.get(windowId);
        if (!win || win.maximized) return;
        e.preventDefault();
        this.dragState = { windowId, startX: e.clientX, startY: e.clientY, startLeft: parseInt(win.element.style.left), startTop: parseInt(win.element.style.top) };
        win.element.classList.add('dragging');
    }
    
    startResize(e, windowId) {
        const win = this.windows.get(windowId);
        if (!win || win.maximized) return;
        e.preventDefault();
        e.stopPropagation();
        this.resizeState = { windowId, startX: e.clientX, startY: e.clientY, startWidth: parseInt(win.element.style.width), startHeight: parseInt(win.element.style.height) };
        win.element.classList.add('resizing');
    }
    
    handleMouseMove(e) {
        if (this.dragState) {
            const win = this.windows.get(this.dragState.windowId);
            if (!win) return;
            let newLeft = Math.max(0, Math.min(this.dragState.startLeft + e.clientX - this.dragState.startX, window.innerWidth - 100));
            let newTop = Math.max(0, Math.min(this.dragState.startTop + e.clientY - this.dragState.startY, window.innerHeight - 100));
            win.element.style.left = newLeft + 'px';
            win.element.style.top = newTop + 'px';
        }
        if (this.resizeState) {
            const win = this.windows.get(this.resizeState.windowId);
            if (!win) return;
            win.element.style.width = Math.max(400, this.resizeState.startWidth + e.clientX - this.resizeState.startX) + 'px';
            win.element.style.height = Math.max(300, this.resizeState.startHeight + e.clientY - this.resizeState.startY) + 'px';
        }
    }
    
    handleMouseUp() {
        if (this.dragState) { const win = this.windows.get(this.dragState.windowId); if (win) win.element.classList.remove('dragging'); this.dragState = null; }
        if (this.resizeState) { const win = this.windows.get(this.resizeState.windowId); if (win) win.element.classList.remove('resizing'); this.resizeState = null; }
    }
    
    addToTaskbar(windowId, title) {
        const taskbarWindows = document.querySelector('.taskbar-windows');
        if (!taskbarWindows) return;
        const btn = document.createElement('button');
        btn.className = 'taskbar-btn';
        btn.id = `taskbar-btn-${windowId}`;
        btn.onclick = () => {
            const win = this.windows.get(windowId);
            if (win) {
                if (win.minimized) this.toggleMinimize(windowId);
                else if (this.activeWindowId === windowId) this.toggleMinimize(windowId);
                else this.focusWindow(windowId);
            }
        };
        btn.innerHTML = `<svg class="taskbar-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="3" x2="9" y2="21"></line></svg><span class="taskbar-btn-title">${this.escapeHtml(title)}</span>`;
        taskbarWindows.appendChild(btn);
    }
    
    removeFromTaskbar(windowId) { const btn = document.getElementById(`taskbar-btn-${windowId}`); if (btn) btn.remove(); }
    
    updateTaskbarButton(windowId, state) {
        const btn = document.getElementById(`taskbar-btn-${windowId}`);
        if (!btn) return;
        if (state.minimized !== undefined) btn.classList.toggle('minimized', state.minimized);
        if (state.focused !== undefined) btn.classList.toggle('focused', state.focused);
    }
    
    updateWindowCount() { const countEl = document.querySelector('.window-count'); if (countEl) countEl.textContent = `${this.windows.size} / ${this.maxWindows} ventanas`; }
    
    getNextPosition() {
        const pos = { ...this.nextPosition };
        this.nextPosition.x += this.cascadeOffset.x;
        this.nextPosition.y += this.cascadeOffset.y;
        if (this.nextPosition.x > window.innerWidth - 500 || this.nextPosition.y > window.innerHeight - 400) this.nextPosition = { x: 80, y: 60 };
        return pos;
    }
    
    getNextZIndex() { return this.zIndexBase + (++this.zIndexCounter); }
    escapeHtml(text) { const div = document.createElement('div'); div.textContent = text; return div.innerHTML; }
    closeAll() { Array.from(this.windows.keys()).forEach(id => this.closeWindow(id)); }
}

const windowManager = new WindowManager();
window.windowManager = windowManager;