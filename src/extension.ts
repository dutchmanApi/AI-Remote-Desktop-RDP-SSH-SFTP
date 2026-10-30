import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import * as net from 'net';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { Client, ClientChannel, SFTPWrapper } from 'ssh2';
import type { RdpSession as AgentRdpSession } from 'agent-rdp' with { 'resolution-mode': 'import' };

// ─────────────────────────────────────────────────────────
//  Types
// ─────────────────────────────────────────────────────────

export interface ServerProfile {
    id: string;
    name: string;
    host: string;
    username: string;
    privateKeyPath?: string;
}

interface ServerCredentials extends ServerProfile {
    password?: string;
}

type SshConnectionOptions = {
    host: string;
    port: number;
    username: string;
    password?: string;
    privateKey?: Buffer;
    readyTimeout?: number;
};

const STORAGE_KEY   = 'cloudRdp.savedServers';
const SFTP_SCHEME   = 'cloudrdp-sftp';

/** Stable per-server WebSocket ports; agent-rdp daemons persist across panels. */
const STREAM_PORT_BASE = 10000;
const STREAM_PORT_RANGE = 50000;

// ─────────────────────────────────────────────────────────
//  State
// ─────────────────────────────────────────────────────────

const sftpPool        = new Map<string, { client: Client; sftp: SFTPWrapper }>();
const sftpConnections = new Map<string, Promise<{ client: Client; sftp: SFTPWrapper }>>();

/** Active agent-rdp sessions keyed by server id. */
const rdpSessions = new Map<string, AgentRdpSession>();

// ─────────────────────────────────────────────────────────
//  Activate
// ─────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {

    // 1. SFTP Virtual FileSystem
    const sftpFsProvider = new CloudSftpFileSystemProvider(context);
    context.subscriptions.push(
        vscode.workspace.registerFileSystemProvider(SFTP_SCHEME, sftpFsProvider, { isCaseSensitive: true })
    );

    // 2. Sidebar TreeDataProvider
    const treeProvider = new CloudServerTreeProvider(context);
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('cloudRdpServersView', treeProvider)
    );

    // ── COMMAND: Add Server ───────────────────────────────
    const addServerCmd = vscode.commands.registerCommand('cloudRdp.addServer', async () => {
        const name = await vscode.window.showInputBox({
            prompt: 'Friendly name for this server',
            placeHolder: 'e.g., OCI Mumbai'
        });
        if (!name) { return; }

        const host = await vscode.window.showInputBox({
            prompt: 'Server IP or Hostname',
            placeHolder: 'e.g., 161.118.173.220'
        });
        if (!host) { return; }

        const username = await vscode.window.showInputBox({
            prompt: 'SSH / RDP Username',
            value: 'ubuntu'
        });
        if (!username) { return; }

        const password = await vscode.window.showInputBox({
            prompt: 'RDP / Linux password (stored in VS Code secret storage; leave blank to use SSH key only)',
            password: true,
            ignoreFocusOut: true
        });

        const id = crypto.randomUUID();
        const servers = context.globalState.get<ServerProfile[]>(STORAGE_KEY, []);
        servers.push({ id, name, host, username });
        await context.globalState.update(STORAGE_KEY, servers);

        if (password) {
            await context.secrets.store(`rdp_pwd_${id}`, password);
        }

        treeProvider.refresh();
        vscode.window.showInformationMessage(`Saved server "${name}" (${host}).`);
    });

    // ── COMMAND: Refresh Tree ─────────────────────────────
    const refreshTreeCmd = vscode.commands.registerCommand('cloudRdp.refreshTree', () => {
        for (const conn of sftpPool.values()) { conn.client.end(); }
        sftpPool.clear();
        treeProvider.refresh();
    });

    // ── COMMAND: Delete Server ────────────────────────────
    const deleteServerCmd = vscode.commands.registerCommand('cloudRdp.deleteServer', async (node?: ServerTreeItem) => {
        if (!node) { return; }
        const confirm = await vscode.window.showWarningMessage(
            `Delete server "${node.profile.name}"?`,
            { modal: true }, 'Delete'
        );
        if (confirm !== 'Delete') { return; }

        const servers = context.globalState.get<ServerProfile[]>(STORAGE_KEY, [])
            .filter(s => s.id !== node.profile.id);
        await context.globalState.update(STORAGE_KEY, servers);
        await context.secrets.delete(`rdp_pwd_${node.profile.id}`);

        const pooled = sftpPool.get(node.profile.id);
        if (pooled) { pooled.client.end(); sftpPool.delete(node.profile.id); }

        // Disconnect any live RDP session for this server
        const rdp = rdpSessions.get(node.profile.id);
        if (rdp) { try { await rdp.disconnect(); } catch { /* ignore */ } rdpSessions.delete(node.profile.id); }

        treeProvider.refresh();
    });

    // ── COMMAND: Edit Server ──────────────────────────────
    const editServerCmd = vscode.commands.registerCommand('cloudRdp.editServer', async (node?: ServerTreeItem) => {
        if (!node) { return; }
        const { profile } = node;

        const name = await vscode.window.showInputBox({ prompt: 'Friendly name', value: profile.name });
        if (!name) { return; }

        const host = await vscode.window.showInputBox({ prompt: 'Server IP or Hostname', value: profile.host });
        if (!host) { return; }

        const username = await vscode.window.showInputBox({ prompt: 'Username', value: profile.username });
        if (!username) { return; }

        const password = await vscode.window.showInputBox({
            prompt: 'Update RDP password (leave blank to keep current)',
            password: true,
            ignoreFocusOut: true
        });

        const servers = context.globalState.get<ServerProfile[]>(STORAGE_KEY, []);
        await context.globalState.update(STORAGE_KEY, servers.map(s =>
            s.id === profile.id ? { ...s, name, host, username } : s
        ));
        if (password) {
            await context.secrets.store(`rdp_pwd_${profile.id}`, password);
        }
        treeProvider.refresh();
        vscode.window.showInformationMessage(`Updated server "${name}" (${host}).`);
    });

    // ── COMMAND: Open Remote File via SFTP ───────────────
    const openRemoteFileCmd = vscode.commands.registerCommand('cloudRdp.openRemoteFile', async (serverId: string, remotePath: string) => {
        const normalized = remotePath.startsWith('/') ? remotePath : `/${remotePath}`;
        const uri = vscode.Uri.from({ scheme: SFTP_SCHEME, authority: serverId, path: normalized });
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: false });
    });

    // ── COMMAND: Open Embedded RDP Desktop ───────────────
    const openEmbeddedDesktopCmd = vscode.commands.registerCommand('cloudRdp.openEmbeddedDesktop', async (node?: ServerTreeItem) => {
        const creds = await resolveServerCredentials(context, node?.profile);
        if (!creds) { return; }

        // agent-rdp needs a real password (SSH key auth is for SFTP/terminal only)
        if (!creds.password) {
            const pw = await vscode.window.showInputBox({
                prompt: `Enter the Linux/RDP password for "${creds.username}@${creds.host}"`,
                password: true,
                ignoreFocusOut: true
            });
            if (!pw) { return; }
            creds.password = pw;
        }

        // Disconnect any previous session for this profile so we get a fresh one
        const existing = rdpSessions.get(creds.id);
        if (existing) {
            try { await existing.disconnect(); } catch { /* ignore */ }
            rdpSessions.delete(creds.id);
        }

        // agent-rdp keeps its daemon alive after a panel closes. Its stream
        // port is fixed when that daemon starts, so it must stay stable for
        // this profile across panel reopen and VS Code reloads.
        const streamIdentity = crypto.createHash('sha256').update(creds.id).digest('hex');
        const streamPort = STREAM_PORT_BASE + (parseInt(streamIdentity.slice(0, 8), 16) % STREAM_PORT_RANGE);

        // Create the webview panel first (shows "Connecting…" immediately)
        const panel = vscode.window.createWebviewPanel(
            'cloudRdpCanvas',
            `RDP: ${creds.name}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: []
            }
        );

        panel.webview.html = getWebviewHtml(streamPort, creds);

        // ── Connect with agent-rdp ────────────────────────
        // agent-rdp is ESM-only; use import() so Node resolves its "import" export.
        let rdp: AgentRdpSession;
        try {
            const mod = await import('agent-rdp');
            rdp = new mod.RdpSession({
                // Include the port in the daemon identity so a daemon created
                // with the old per-panel port cannot be silently reused.
                session: `vscode-${streamIdentity}-${streamPort}`,
                streamPort,
                timeout: 30000
            });
            // agent-rdp 0.6.5 starts the stream server but hardcodes
            // stream_port: 0 in its connect request, which disables frames.
            const send = rdp._send.bind(rdp);
            rdp._send = request => send(
                request.type === 'connect' ? { ...request, stream_port: streamPort } : request
            );
        } catch (err: any) {
            vscode.window.showErrorMessage(`agent-rdp failed to load: ${err.message}`);
            panel.dispose();
            return;
        }

        rdpSessions.set(creds.id, rdp);

        // Notify webview when panel is closed → disconnect daemon
        panel.onDidDispose(async () => {
            const session = rdpSessions.get(creds.id);
            if (session) {
                try { await session.disconnect(); } catch { /* ignore */ }
                rdpSessions.delete(creds.id);
            }
        });

        // Connect in background; send status messages to webview
        (async () => {
            try {
                panel.webview.postMessage({ type: 'status', text: `Connecting to ${creds.host}:3389…`, state: 'connecting' });

                await rdp.connect({
                    host: creds.host,
                    port: 3389,
                    username: creds.username,
                    password: creds.password!,
                    width: 1280,
                    height: 800
                });

                panel.webview.postMessage({ type: 'status', text: 'Connected', state: 'connected' });
                panel.webview.postMessage({ type: 'stream', url: `ws://127.0.0.1:${streamPort}` });

            } catch (err: any) {
                const msg = err?.message ?? String(err);
                panel.webview.postMessage({ type: 'status', text: `Error: ${msg}`, state: 'error' });
                vscode.window.showErrorMessage(`RDP connection failed: ${msg}`);
                rdpSessions.delete(creds.id);
            }
        })();

        // ── Relay mouse / keyboard / clipboard from webview ──
        panel.webview.onDidReceiveMessage(async (msg) => {
            const session = rdpSessions.get(creds.id);
            if (!session) { return; }

            try {
                switch (msg.type) {
                    case 'mouse_move':
                        await session.mouse.move({ x: msg.x, y: msg.y });
                        break;
                    case 'mouse_down':
                    case 'mouse_up':
                    case 'mouse_click':
                        await session.mouse.click({ x: msg.x, y: msg.y });
                        break;
                    case 'mouse_right':
                        await session.mouse.rightClick({ x: msg.x, y: msg.y });
                        break;
                    case 'mouse_dblclick':
                        await session.mouse.doubleClick({ x: msg.x, y: msg.y });
                        break;
                    case 'scroll_up':
                        await session.scroll.up({ amount: msg.amount ?? 3 });
                        break;
                    case 'scroll_down':
                        await session.scroll.down({ amount: msg.amount ?? 3 });
                        break;
                    case 'key_press':
                        await session.keyboard.press({ keys: msg.key });
                        break;
                    case 'key_type':
                        await session.keyboard.type({ text: msg.text });
                        break;
                    case 'ctrl_alt_del':
                        await session.keyboard.press({ keys: 'ctrl+alt+delete' });
                        break;
                    case 'disconnect':
                        await session.disconnect();
                        rdpSessions.delete(creds.id);
                        panel.webview.postMessage({ type: 'status', text: 'Disconnected', state: 'disconnected' });
                        break;
                    case 'screenshot': {
                        const shot = await session.screenshot({ format: 'png' });
                        panel.webview.postMessage({
                            type: 'screenshot',
                            base64: shot.base64,
                            format: shot.format
                        });
                        break;
                    }
                }
            } catch (err: any) {
                const message = err?.message ?? err;
                console.error(
                    msg.type === 'screenshot' ? '[cloud-rdp] screenshot failed:' : '[cloud-rdp] input relay error:',
                    message
                );
            }
        });
    });

    // ── COMMAND: Kill stale xRDP session (Fix black screen) ──
    const killRdpSessionCmd = vscode.commands.registerCommand('cloudRdp.killRdpSession', async (node?: ServerTreeItem) => {
        const creds = await resolveServerCredentials(context, node?.profile);
        if (!creds) { return; }

        let sshOptions: SshConnectionOptions;
        try { sshOptions = await getSshConnectionOptions(context, creds); }
        catch (err: any) { vscode.window.showErrorMessage(`SSH Error: ${err.message}`); return; }

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Resetting xRDP session on ${creds.host}…`, cancellable: false },
            async () => {
                try {
                    const client = await connectSshWithRetry(sshOptions);
                    await new Promise<void>((resolve, reject) => {
                        const cmd = [
                            `pkill -HUP -u ${creds.username} xfce4-session 2>/dev/null || true`,
                            'sleep 1',
                            `pkill -15 -u ${creds.username} Xorg 2>/dev/null || true`,
                            'sleep 1',
                            `pkill -9 -u ${creds.username} Xorg 2>/dev/null || true`,
                            'echo DONE'
                        ].join(' && ');
                        client.exec(cmd, (err, stream) => {
                            if (err) { client.end(); reject(err); return; }
                            stream.on('close', () => { client.end(); resolve(); });
                        });
                    });
                    vscode.window.showInformationMessage(`xRDP session on ${creds.host} was reset. Open Embedded Desktop to get a fresh session.`);
                } catch (err: any) {
                    vscode.window.showErrorMessage(`Failed to reset xRDP session: ${err.message}`);
                }
            }
        );
    });

    // ── COMMAND: Open SSH Terminal ────────────────────────
    const openTerminalCmd = vscode.commands.registerCommand('cloudRdp.openTerminal', async (node?: ServerTreeItem) => {
        const creds = await resolveServerCredentials(context, node?.profile);
        if (!creds) { return; }

        let sshOptions: SshConnectionOptions;
        try { sshOptions = await getSshConnectionOptions(context, creds); }
        catch (err: any) { vscode.window.showErrorMessage(`SSH Error: ${err.message}`); return; }

        const writeEmitter = new vscode.EventEmitter<string>();
        const closeEmitter = new vscode.EventEmitter<number>();
        let sshClient: Client | undefined;
        let shellStream: ClientChannel | undefined;

        const pty: vscode.Pseudoterminal = {
            onDidWrite: writeEmitter.event,
            onDidClose: closeEmitter.event,
            open: (dims) => {
                writeEmitter.fire(`\x1b[36m[Connecting to ${creds.name} (${creds.host})…]\x1b[0m\r\n`);
                void connectSshWithRetry(sshOptions).then(client => {
                    sshClient = client;
                    client.on('error', err => writeEmitter.fire(`\x1b[31m[SSH Error]: ${err.message}\x1b[0m\r\n`));
                    writeEmitter.fire(`\x1b[32m[Connected! Shell ready.]\x1b[0m\r\n\r\n`);
                    client.shell({ term: 'xterm-256color', rows: dims?.rows ?? 30, cols: dims?.columns ?? 120 }, (err, stream) => {
                        if (err) { writeEmitter.fire(`\x1b[31m[Shell Error]: ${err.message}\x1b[0m\r\n`); return; }
                        shellStream = stream;
                        stream.on('data', (d: Buffer) => writeEmitter.fire(d.toString('utf8')));
                        stream.on('close', () => { client.end(); closeEmitter.fire(0); });
                    });
                }).catch((err: Error) => writeEmitter.fire(`\x1b[31m[SSH Error]: ${err.message}\x1b[0m\r\n`));
            },
            close: () => { shellStream?.end(); sshClient?.end(); },
            handleInput: (data) => shellStream?.write(data),
            setDimensions: (dim) => shellStream?.setWindow(dim.rows, dim.columns, 0, 0)
        };

        const terminal = vscode.window.createTerminal({ name: `SSH: ${creds.name}`, pty });
        terminal.show();
    });

    context.subscriptions.push(
        addServerCmd,
        refreshTreeCmd,
        deleteServerCmd,
        editServerCmd,
        openRemoteFileCmd,
        openEmbeddedDesktopCmd,
        openTerminalCmd,
        killRdpSessionCmd
    );
}

// ─────────────────────────────────────────────────────────
//  Webview HTML  — renders JPEG stream on <canvas>
// ─────────────────────────────────────────────────────────

function getWebviewHtml(streamPort: number, creds: ServerCredentials): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none';
           img-src blob: data:;
           style-src 'nonce-${nonce}';
           script-src 'nonce-${nonce}';
           connect-src ws://127.0.0.1:${streamPort};">
<style nonce="${nonce}">
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 100%; height: 100%; overflow: hidden;
    background: #1e1e1e; display: flex; flex-direction: column;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }

  /* ── Toolbar ── */
  #toolbar {
    flex-shrink: 0; height: 36px; background: #252526;
    border-bottom: 1px solid #3c3c3c;
    display: flex; align-items: center; gap: 8px; padding: 0 10px;
  }
  #status-dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: #6e6e6e; flex-shrink: 0; transition: background .3s;
  }
  #status-dot.connecting { background: #f5a623; }
  #status-dot.connected  { background: #4ec94e; }
  #status-dot.error      { background: #f48771; }
  #status-text { color: #ccc; font-size: 12px; flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .tb-btn {
    background: #0e639c; color: #fff; border: none;
    padding: 3px 10px; border-radius: 2px; cursor: pointer; font-size: 11px;
    white-space: nowrap;
  }
  .tb-btn:hover { background: #1177bb; }
  .tb-btn.danger { background: #6c2020; }
  .tb-btn.danger:hover { background: #9e2929; }

  /* ── Canvas wrapper ── */
  #viewport {
    flex: 1; overflow: auto; display: flex;
    justify-content: center; align-items: flex-start;
    cursor: default;
  }
  #rdp-canvas {
    display: block; image-rendering: pixelated;
    background: #000; cursor: default;
  }
  #overlay {
    position: fixed; inset: 36px 0 0 0;
    display: flex; flex-direction: column;
    justify-content: center; align-items: center; gap: 14px;
    background: rgba(30,30,30,.88); transition: opacity .4s;
  }
  #overlay.hidden { opacity: 0; pointer-events: none; }
  #overlay-icon { font-size: 48px; }
  #overlay-msg  { color: #ccc; font-size: 14px; text-align: center; max-width: 420px; }
  .spinner {
    width: 36px; height: 36px; border: 3px solid #444;
    border-top-color: #0e639c; border-radius: 50%;
    animation: spin .8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>

<!-- Toolbar -->
<div id="toolbar">
  <div id="status-dot" class="connecting"></div>
  <span id="status-text">Connecting to ${creds.host}…</span>
  <button class="tb-btn" id="btn-cad">Ctrl+Alt+Del</button>
  <button class="tb-btn" id="btn-fit">Fit</button>
  <button class="tb-btn" id="btn-full">1:1</button>
  <button class="tb-btn danger" id="btn-disc">Disconnect</button>
</div>

<!-- Canvas -->
<div id="viewport">
  <canvas id="rdp-canvas" width="1280" height="800"></canvas>
</div>

<!-- Connecting overlay -->
<div id="overlay">
  <div class="spinner"></div>
  <div id="overlay-msg">Connecting to ${escapeHtml(creds.host)}&hellip;</div>
</div>

<script nonce="${nonce}">
(function () {
  'use strict';

  const vscode   = acquireVsCodeApi();
  const canvas   = document.getElementById('rdp-canvas');
  const ctx      = canvas.getContext('2d');
  const overlay  = document.getElementById('overlay');
  const overlayMsg = document.getElementById('overlay-msg');
  const statusDot  = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');

  let ws = null;
  let fitMode = true;
  let lastScale = 1;

  // ── Status helpers ──────────────────────────────────────
  function setStatus(text, state) {
    statusText.textContent = text;
    statusDot.className = state || '';
    if (state === 'connected') {
      // keep overlay hidden once connected
    }
  }

  function showOverlay(msg, isError) {
    overlay.classList.remove('hidden');
    overlayMsg.textContent = msg;
    const spinner = overlay.querySelector('.spinner');
    if (spinner) spinner.style.display = isError ? 'none' : '';
    if (isError) {
      const icon = document.createElement('div');
      icon.id = 'overlay-icon'; icon.textContent = '⚠️';
      overlay.prepend(icon);
    }
  }

  function hideOverlay() {
    overlay.classList.add('hidden');
  }

  // ── Scale canvas to viewport ────────────────────────────
  function applyFit() {
    if (!fitMode) { canvas.style.transform = ''; canvas.style.transformOrigin = ''; return; }
    const vp = document.getElementById('viewport');
    const sx = vp.clientWidth  / canvas.width;
    const sy = vp.clientHeight / canvas.height;
    lastScale = Math.min(sx, sy, 1); // never upscale beyond 100%
    canvas.style.transform = \`scale(\${lastScale})\`;
    canvas.style.transformOrigin = 'top left';
  }
  window.addEventListener('resize', applyFit);

  // ── Toolbar buttons ─────────────────────────────────────
  document.getElementById('btn-cad').addEventListener('click', () => vscode.postMessage({ type: 'ctrl_alt_del' }));
  document.getElementById('btn-disc').addEventListener('click', () => vscode.postMessage({ type: 'disconnect' }));
  document.getElementById('btn-fit').addEventListener('click', () => { fitMode = true;  applyFit(); });
  document.getElementById('btn-full').addEventListener('click', () => { fitMode = false; canvas.style.transform = ''; });

  // ── Mouse ───────────────────────────────────────────────
  function canvasCoords(e) {
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.round((e.clientX - r.left) / lastScale),
      y: Math.round((e.clientY - r.top)  / lastScale)
    };
  }

  canvas.addEventListener('mousemove', e => {
    const p = canvasCoords(e);
    vscode.postMessage({ type: 'mouse_move', ...p });
  });
  canvas.addEventListener('mousedown', e => {
    canvas.focus();
    const p = canvasCoords(e);
    if (e.button === 2) { vscode.postMessage({ type: 'mouse_right', ...p }); }
    else                { vscode.postMessage({ type: 'mouse_click', ...p }); }
  });
  canvas.addEventListener('dblclick', e => {
    vscode.postMessage({ type: 'mouse_dblclick', ...canvasCoords(e) });
  });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    vscode.postMessage({ type: e.deltaY < 0 ? 'scroll_up' : 'scroll_down', amount: 3 });
  }, { passive: false });
  canvas.addEventListener('contextmenu', e => e.preventDefault());

  // ── Keyboard ────────────────────────────────────────────
  const KEY_MAP = {
    'Enter':'enter','Escape':'escape','Backspace':'backspace','Tab':'tab',
    'Delete':'delete','Home':'home','End':'end','PageUp':'pageup','PageDown':'pagedown',
    'ArrowUp':'up','ArrowDown':'down','ArrowLeft':'left','ArrowRight':'right',
    'F1':'f1','F2':'f2','F3':'f3','F4':'f4','F5':'f5','F6':'f6',
    'F7':'f7','F8':'f8','F9':'f9','F10':'f10','F11':'f11','F12':'f12',
  };

  canvas.setAttribute('tabindex', '0');
  canvas.addEventListener('keydown', e => {
    e.preventDefault();
    // Build modifier+key combo string
    const parts = [];
    if (e.ctrlKey)  parts.push('ctrl');
    if (e.altKey)   parts.push('alt');
    if (e.shiftKey && e.key.length > 1) parts.push('shift');
    const mapped = KEY_MAP[e.key];
    if (mapped) {
      parts.push(mapped);
      vscode.postMessage({ type: 'key_press', key: parts.join('+') });
    } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey) {
      vscode.postMessage({ type: 'key_type', text: e.key });
    } else if (e.key.length === 1) {
      parts.push(e.key.toLowerCase());
      vscode.postMessage({ type: 'key_press', key: parts.join('+') });
    }
  });

  // ── WebSocket frame receiver ────────────────────────────
  function connectStream(url) {
    if (ws) { try { ws.close(); } catch {} }
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => console.log('[rdp-stream] WebSocket open');
    ws.onclose = (e) => console.log('[rdp-stream] closed', e.code);
    ws.onerror = (e) => console.warn('[rdp-stream] error', e);

    function drawJpeg(src) {
      const img = new Image();
      img.onload = () => {
        if (img.width !== canvas.width || img.height !== canvas.height) {
          canvas.width  = img.width;
          canvas.height = img.height;
          applyFit();
        }
        ctx.drawImage(img, 0, 0);
        if (src.startsWith('blob:')) { URL.revokeObjectURL(src); }
      };
      img.onerror = () => {
        if (src.startsWith('blob:')) { URL.revokeObjectURL(src); }
        console.warn('[rdp-stream] invalid JPEG frame');
      };
      img.src = src;
    }

    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        // agent-rdp sends JSON text messages; desktop frames contain a
        // base64-encoded JPEG in the data field.
        try {
          const message = JSON.parse(e.data);
          if (message.type === 'frame' && typeof message.data === 'string') {
            drawJpeg('data:image/jpeg;base64,' + message.data);
          } else if (message.type !== 'status') {
            console.debug('[rdp-stream] ignored message', message.type);
          }
        } catch (err) {
          console.warn('[rdp-stream] invalid message', err);
        }
        return;
      }

      // Keep compatibility with daemons that send raw JPEG binary frames.
      const blob = new Blob([e.data], { type: 'image/jpeg' });
      drawJpeg(URL.createObjectURL(blob));
    };
  }

  // ── Extension → Webview messages ───────────────────────
  window.addEventListener('message', e => {
    const msg = e.data;
    switch (msg.type) {
      case 'status':
        setStatus(msg.text, msg.state);
        if (msg.state === 'error') { showOverlay(msg.text, true); }
        break;
      case 'stream':
        hideOverlay();
        vscode.postMessage({ type: 'screenshot' });
        connectStream(msg.url);
        break;
      case 'screenshot':
        // Render a one-shot screenshot (base64) into the canvas
        if (msg.base64) {
          const img = new Image();
          img.onload = () => {
            if (img.width !== canvas.width || img.height !== canvas.height) {
              canvas.width = img.width;
              canvas.height = img.height;
              applyFit();
            }
            ctx.drawImage(img, 0, 0);
          };
          const mimeType = msg.format === 'png' ? 'image/png' : 'image/jpeg';
          img.src = 'data:' + mimeType + ';base64,' + msg.base64;
        }
        break;
    }
  });

  // Initial fit
  applyFit();
})();
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─────────────────────────────────────────────────────────
//  SSH helpers
// ─────────────────────────────────────────────────────────

async function getSshConnectionOptions(
    context: vscode.ExtensionContext,
    profile: ServerCredentials
): Promise<SshConnectionOptions> {
    let privateKeyPath = profile.privateKeyPath;
    if (!privateKeyPath && profile.password) {
        const method = await vscode.window.showQuickPick(
            [
                { label: '🔑  Use saved password', usePrivateKey: false },
                { label: '📂  Choose SSH private key file', usePrivateKey: true }
            ],
            { placeHolder: `SSH authentication for ${profile.name}` }
        );
        if (!method) { throw new Error('Choose an SSH authentication method.'); }
        if (!method.usePrivateKey) {
            return { host: profile.host, port: 22, username: profile.username, password: profile.password, readyTimeout: 12000 };
        }
    }

    if (!privateKeyPath) {
        const selected = await vscode.window.showOpenDialog({
            canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
            openLabel: 'Use SSH Private Key',
            defaultUri: vscode.Uri.file(path.join(homedir(), 'Downloads')),
            filters: { 'SSH private keys': ['key', 'pem', 'ppk'] }
        });
        if (!selected?.[0]) { throw new Error('Choose an SSH private key file or add a password.'); }
        privateKeyPath = selected[0].fsPath;

        const servers = context.globalState.get<ServerProfile[]>(STORAGE_KEY, []);
        await context.globalState.update(STORAGE_KEY, servers.map(s =>
            s.id === profile.id ? { ...s, privateKeyPath } : s
        ));
    }

    if (privateKeyPath.toLowerCase().endsWith('.pub')) {
        throw new Error('Select the private key file, not the .pub public key.');
    }

    let privateKey: Buffer;
    try { privateKey = readFileSync(privateKeyPath); }
    catch (err: any) { throw new Error(`Cannot read SSH key at ${privateKeyPath}: ${err.message}`); }

    return { host: profile.host, port: 22, username: profile.username, privateKey, readyTimeout: 12000 };
}

async function connectSshWithRetry(options: SshConnectionOptions): Promise<Client> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await new Promise<Client>((resolve, reject) => {
                const client = new Client();
                let ready = false;
                client.once('ready', () => { ready = true; resolve(client); });
                client.once('error', err => { if (!ready) { reject(err); } });
                client.once('close', () => { if (!ready) { reject(new Error('SSH connection closed before ready')); } });
                client.connect(options);
            });
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== 'EADDRINUSE') { throw err; }
            if (attempt >= 2) { throw new Error(`Could not allocate SSH socket to ${options.host}:22 after 3 attempts.`); }
            await new Promise(r => setTimeout(r, 250 * (attempt + 1)));
        }
    }
}

function checkPortOpen(host: string, port: number): Promise<boolean> {
    return new Promise(resolve => {
        const s = new net.Socket();
        s.setTimeout(1000);
        s.once('connect', () => { s.destroy(); resolve(true); });
        s.once('timeout', () => { s.destroy(); resolve(false); });
        s.once('error',   () => { s.destroy(); resolve(false); });
        s.connect(port, host);
    });
}

// ─────────────────────────────────────────────────────────
//  resolveServerCredentials
// ─────────────────────────────────────────────────────────

async function resolveServerCredentials(
    context: vscode.ExtensionContext,
    profile?: ServerProfile
): Promise<ServerCredentials | undefined> {
    const servers = context.globalState.get<ServerProfile[]>(STORAGE_KEY, []);
    if (!profile) {
        if (servers.length === 0) {
            vscode.window.showWarningMessage('No servers saved yet. Click "+" in the Cloud RDP sidebar first.');
            return undefined;
        }
        const picked = await vscode.window.showQuickPick(
            servers.map(s => ({ label: s.name, description: `${s.username}@${s.host}`, profile: s })),
            { placeHolder: 'Select a Cloud Server' }
        );
        if (!picked) { return undefined; }
        profile = picked.profile;
    }
    const password = await context.secrets.get(`rdp_pwd_${profile.id}`);
    return { ...profile, password };
}

// ─────────────────────────────────────────────────────────
//  SFTP helpers
// ─────────────────────────────────────────────────────────

async function getSftpConnection(context: vscode.ExtensionContext, serverId: string): Promise<SFTPWrapper> {
    const existing = sftpPool.get(serverId);
    if (existing) { return existing.sftp; }

    let connPromise = sftpConnections.get(serverId);
    if (!connPromise) {
        const servers = context.globalState.get<ServerProfile[]>(STORAGE_KEY, []);
        const profile  = servers.find(s => s.id === serverId);
        if (!profile) { throw new Error('Server profile not found'); }

        connPromise = (async () => {
            const password = await context.secrets.get(`rdp_pwd_${serverId}`);
            const options  = await getSshConnectionOptions(context, { ...profile, password });
            const client   = await connectSshWithRetry(options);
            client.on('error', err => {
                if (sftpPool.get(serverId)?.client === client) { sftpPool.delete(serverId); }
                console.error(`SFTP error for ${profile.host}:`, err);
            });
            return new Promise<{ client: Client; sftp: SFTPWrapper }>((resolve, reject) => {
                client.sftp((err, sftp) => {
                    if (err) { client.end(); reject(err); return; }
                    const conn = { client, sftp };
                    sftpPool.set(serverId, conn);
                    resolve(conn);
                });
            });
        })();
        sftpConnections.set(serverId, connPromise);
    }

    try {
        const conn = await connPromise;
        return conn.sftp;
    } finally {
        if (sftpConnections.get(serverId) === connPromise) { sftpConnections.delete(serverId); }
    }
}

// ─────────────────────────────────────────────────────────
//  Tree Providers
// ─────────────────────────────────────────────────────────

type TreeItemNode = ServerTreeItem | SftpEntryTreeItem;

class ServerTreeItem extends vscode.TreeItem {
    constructor(public readonly profile: ServerProfile) {
        super(profile.name, vscode.TreeItemCollapsibleState.Collapsed);
        this.description = `${profile.username}@${profile.host}`;
        this.contextValue = 'server';
        this.iconPath = new vscode.ThemeIcon('vm-active');
    }
}

class SftpEntryTreeItem extends vscode.TreeItem {
    constructor(
        public readonly serverId: string,
        public readonly filename: string,
        public readonly remotePath: string,
        public readonly isDirectory: boolean
    ) {
        super(filename, isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        this.contextValue = isDirectory ? 'sftpFolder' : 'sftpFile';
        this.iconPath = isDirectory ? new vscode.ThemeIcon('folder') : new vscode.ThemeIcon('file-code');
        if (!isDirectory) {
            this.command = { command: 'cloudRdp.openRemoteFile', title: 'Open Remote File', arguments: [serverId, remotePath] };
        }
    }
}

class CloudServerTreeProvider implements vscode.TreeDataProvider<TreeItemNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TreeItemNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    constructor(private context: vscode.ExtensionContext) {}
    refresh(): void { this._onDidChangeTreeData.fire(); }
    getTreeItem(element: TreeItemNode): vscode.TreeItem { return element; }

    async getChildren(element?: TreeItemNode): Promise<TreeItemNode[]> {
        if (!element) {
            const servers = this.context.globalState.get<ServerProfile[]>(STORAGE_KEY, []);
            return servers.map(s => new ServerTreeItem(s));
        }
        const serverId = element instanceof ServerTreeItem ? element.profile.id : element.serverId;
        try {
            const sftp = await getSftpConnection(this.context, serverId);
            const targetDir = element instanceof ServerTreeItem
                ? await new Promise<string>((res, rej) => sftp.realpath('.', (e, p) => e ? rej(e) : res(p)))
                : element.remotePath;

            const list = await new Promise<any[]>((res, rej) =>
                sftp.readdir(targetDir, (err, items) => err ? rej(err) : res(items))
            );
            list.sort((a, b) => {
                const aD = a.attrs.isDirectory(), bD = b.attrs.isDirectory();
                if (aD !== bD) { return aD ? -1 : 1; }
                return a.filename.localeCompare(b.filename);
            });
            return list.map(item => {
                const fullPath = path.posix.join(targetDir.replace(/\\/g, '/'), item.filename);
                return new SftpEntryTreeItem(serverId, item.filename, fullPath, item.attrs.isDirectory());
            });
        } catch (err: any) {
            vscode.window.showErrorMessage(`SFTP Error: ${err.message}`);
            return [];
        }
    }
}

// ─────────────────────────────────────────────────────────
//  SFTP FileSystem Provider
// ─────────────────────────────────────────────────────────

class CloudSftpFileSystemProvider implements vscode.FileSystemProvider {
    private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;
    constructor(private context: vscode.ExtensionContext) {}
    watch(): vscode.Disposable { return new vscode.Disposable(() => {}); }

    private getRemotePath(uri: vscode.Uri): string {
        return /^\/[a-zA-Z]:/.test(uri.path) ? uri.path.slice(1) : uri.path;
    }

    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        const sftp = await getSftpConnection(this.context, uri.authority);
        return new Promise((resolve, reject) => {
            sftp.stat(this.getRemotePath(uri), (err, stats) => {
                if (err) { return reject(vscode.FileSystemError.FileNotFound(uri)); }
                resolve({
                    type: stats.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File,
                    ctime: stats.atime * 1000, mtime: stats.mtime * 1000, size: stats.size
                });
            });
        });
    }

    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        const sftp = await getSftpConnection(this.context, uri.authority);
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            const stream = sftp.createReadStream(this.getRemotePath(uri));
            stream.on('data', (c: Buffer) => chunks.push(c));
            stream.on('error', (e: Error) => reject(vscode.FileSystemError.Unavailable(e.message)));
            stream.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
        });
    }

    async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
        const sftp = await getSftpConnection(this.context, uri.authority);
        return new Promise((resolve, reject) => {
            const stream = sftp.createWriteStream(this.getRemotePath(uri));
            stream.on('error', (e: Error) => reject(vscode.FileSystemError.Unavailable(e.message)));
            stream.on('close', () => {
                vscode.window.setStatusBarMessage(`$(cloud-upload) Synced ${path.posix.basename(uri.path)}`, 3000);
                resolve();
            });
            stream.end(Buffer.from(content));
        });
    }

    readDirectory(): [string, vscode.FileType][] { return []; }
    createDirectory(): void {}
    delete(): void {}
    rename(): void {}
}

// ─────────────────────────────────────────────────────────
//  Deactivate
// ─────────────────────────────────────────────────────────

export async function deactivate() {
    for (const conn of sftpPool.values()) { conn.client.end(); }
    sftpPool.clear();

    for (const rdp of rdpSessions.values()) {
        try { await rdp.disconnect(); } catch { /* ignore */ }
    }
    rdpSessions.clear();
}
