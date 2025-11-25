/**
 * WebSocket Status Server
 *
 * Provides real-time status updates for the review process
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';

// HTML content for the monitor page (embedded to avoid path issues)
const MONITOR_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Code Review Monitor - Argus</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
            color: #333;
        }
        .container { max-width: 1200px; margin: 0 auto; }
        header { text-align: center; color: white; margin-bottom: 30px; }
        h1 { font-size: 2.5em; margin-bottom: 10px; text-shadow: 2px 2px 4px rgba(0,0,0,0.2); }
        .subtitle { font-size: 1.2em; opacity: 0.9; }
        .status-card {
            background: white;
            border-radius: 15px;
            padding: 30px;
            margin-bottom: 20px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.1);
        }
        .current-phase {
            text-align: center;
            padding: 40px 20px;
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
            color: white;
            border-radius: 15px;
            margin-bottom: 20px;
        }
        .phase-title { font-size: 2em; margin-bottom: 10px; font-weight: 600; }
        .phase-message { font-size: 1.2em; opacity: 0.95; }
        .progress-section { margin-top: 20px; }
        .progress-bar-container {
            background: rgba(255,255,255,0.3);
            border-radius: 20px;
            height: 30px;
            overflow: hidden;
            margin-top: 10px;
        }
        .progress-bar {
            background: white;
            height: 100%;
            border-radius: 20px;
            transition: width 0.3s ease;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: 600;
            color: #764ba2;
        }
        .agents-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 15px;
            margin-top: 20px;
        }
        .agent-card {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 20px;
            border-radius: 10px;
            transition: transform 0.2s;
        }
        .agent-card:hover { transform: translateY(-2px); }
        .agent-card.active {
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
            box-shadow: 0 8px 20px rgba(0,0,0,0.2);
        }
        .agent-card.completed { background: linear-gradient(135deg, #84fab0 0%, #8fd3f4 100%); }
        .agent-name { font-size: 1.2em; font-weight: 600; margin-bottom: 5px; }
        .agent-status { font-size: 0.9em; opacity: 0.9; }
        .timeline { margin-top: 30px; }
        .timeline-item {
            display: flex;
            gap: 15px;
            margin-bottom: 20px;
            animation: slideIn 0.3s ease-out;
        }
        @keyframes slideIn {
            from { opacity: 0; transform: translateX(-20px); }
            to { opacity: 1; transform: translateX(0); }
        }
        .timeline-marker {
            width: 12px;
            height: 12px;
            background: #667eea;
            border-radius: 50%;
            margin-top: 6px;
            flex-shrink: 0;
        }
        .timeline-marker.phase { background: #f5576c; width: 16px; height: 16px; }
        .timeline-marker.complete { background: #84fab0; }
        .timeline-marker.error { background: #ff6b6b; }
        .timeline-content { flex: 1; background: #f8f9fa; padding: 15px; border-radius: 8px; }
        .timeline-time { font-size: 0.85em; color: #666; margin-bottom: 5px; }
        .timeline-message { font-size: 1em; color: #333; font-weight: 500; }
        .connection-status {
            position: fixed;
            top: 20px;
            right: 20px;
            background: white;
            padding: 10px 20px;
            border-radius: 25px;
            box-shadow: 0 4px 10px rgba(0,0,0,0.1);
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .status-dot {
            width: 10px;
            height: 10px;
            border-radius: 50%;
            background: #84fab0;
            animation: pulse 2s infinite;
        }
        .status-dot.disconnected { background: #ff6b6b; animation: none; }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 15px;
            margin-top: 20px;
        }
        .stat-card {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 20px;
            border-radius: 10px;
            text-align: center;
        }
        .stat-value { font-size: 2.5em; font-weight: 700; margin-bottom: 5px; }
        .stat-label { font-size: 0.9em; opacity: 0.9; }
        .spinner {
            display: inline-block;
            width: 20px;
            height: 20px;
            border: 3px solid rgba(255,255,255,0.3);
            border-top-color: white;
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>🔍 Argus Code Review Monitor</h1>
            <p class="subtitle">实时代码审查状态监控</p>
        </header>
        <div class="connection-status">
            <div class="status-dot" id="statusDot"></div>
            <span id="statusText">连接中...</span>
        </div>
        <div class="status-card">
            <div class="current-phase" id="currentPhase">
                <div class="phase-title">初始化中...</div>
                <div class="phase-message">正在建立连接</div>
                <div class="progress-section" id="progressSection" style="display: none;">
                    <div class="progress-bar-container">
                        <div class="progress-bar" id="progressBar" style="width: 0%">0%</div>
                    </div>
                </div>
            </div>
            <div class="stats-grid">
                <div class="stat-card"><div class="stat-value" id="statPhases">-</div><div class="stat-label">当前阶段</div></div>
                <div class="stat-card"><div class="stat-value" id="statAgents">0</div><div class="stat-label">运行的 Agents</div></div>
                <div class="stat-card"><div class="stat-value" id="statIssues">-</div><div class="stat-label">发现的问题</div></div>
                <div class="stat-card"><div class="stat-value" id="statTime">0s</div><div class="stat-label">已用时间</div></div>
            </div>
            <h3 style="margin-top: 30px; margin-bottom: 15px;">Specialist Agents</h3>
            <div class="agents-grid" id="agentsGrid"></div>
        </div>
        <div class="status-card">
            <h3 style="margin-bottom: 20px;">执行日志</h3>
            <div class="timeline" id="timeline"></div>
        </div>
    </div>
    <script>
        let ws, startTime = Date.now(), agents = new Map();
        const statusDot = document.getElementById('statusDot');
        const statusText = document.getElementById('statusText');
        const currentPhase = document.getElementById('currentPhase');
        const progressSection = document.getElementById('progressSection');
        const progressBar = document.getElementById('progressBar');
        const timeline = document.getElementById('timeline');
        const agentsGrid = document.getElementById('agentsGrid');
        const statPhases = document.getElementById('statPhases');
        const statAgents = document.getElementById('statAgents');
        const statIssues = document.getElementById('statIssues');
        const statTime = document.getElementById('statTime');

        function connect() {
            ws = new WebSocket(\`ws://\${window.location.host}\`);
            ws.onopen = () => {
                statusDot.classList.remove('disconnected');
                statusText.textContent = '已连接';
            };
            ws.onclose = () => {
                statusDot.classList.add('disconnected');
                statusText.textContent = '连接断开';
                setTimeout(connect, 3000);
            };
            ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                if (data.type === 'history') {
                    data.data.forEach(update => handleUpdate(update));
                } else {
                    handleUpdate(data);
                }
            };
        }

        function handleUpdate(update) {
            switch (update.type) {
                case 'phase':
                    currentPhase.querySelector('.phase-title').innerHTML = \`<span class="spinner"></span> \${update.phase || update.message}\`;
                    currentPhase.querySelector('.phase-message').textContent = update.message;
                    statPhases.textContent = update.phase || '-';
                    break;
                case 'agent':
                    if (!agents.has(update.agent)) agents.set(update.agent, { name: update.agent, status: 'pending' });
                    const agent = agents.get(update.agent);
                    agent.status = update.details?.status || 'running';
                    agent.message = update.message;
                    updateAgentsGrid();
                    statAgents.textContent = Array.from(agents.values()).filter(a => a.status === 'running').length;
                    break;
                case 'progress':
                    if (update.progress !== undefined && update.total !== undefined) {
                        progressSection.style.display = 'block';
                        const percent = Math.round((update.progress / update.total) * 100);
                        progressBar.style.width = percent + '%';
                        progressBar.textContent = \`\${update.progress}/\${update.total} (\${percent}%)\`;
                    }
                    break;
                case 'complete':
                    currentPhase.querySelector('.phase-title').textContent = '✅ 审查完成';
                    currentPhase.querySelector('.phase-message').textContent = update.message;
                    currentPhase.style.background = 'linear-gradient(135deg, #84fab0 0%, #8fd3f4 100%)';
                    if (update.details?.issues) statIssues.textContent = update.details.issues;
                    break;
                case 'error':
                    currentPhase.querySelector('.phase-title').textContent = '❌ 发生错误';
                    currentPhase.querySelector('.phase-message').textContent = update.message;
                    currentPhase.style.background = 'linear-gradient(135deg, #ff6b6b 0%, #ee5a6f 100%)';
                    break;
            }
            addTimelineItem(update);
        }

        function updateAgentsGrid() {
            agentsGrid.innerHTML = '';
            agents.forEach(agent => {
                const card = document.createElement('div');
                card.className = \`agent-card \${agent.status}\`;
                let icon = agent.status === 'running' ? '🔄' : agent.status === 'completed' ? '✅' : agent.status === 'error' ? '❌' : '⏳';
                card.innerHTML = \`<div class="agent-name">\${icon} \${agent.name}</div><div class="agent-status">\${agent.message || agent.status}</div>\`;
                agentsGrid.appendChild(card);
            });
        }

        function addTimelineItem(update) {
            const item = document.createElement('div');
            item.className = 'timeline-item';
            const markerClass = update.type === 'phase' ? 'phase' : update.type === 'complete' ? 'complete' : update.type === 'error' ? 'error' : '';
            const time = new Date(update.timestamp).toLocaleTimeString('zh-CN');
            item.innerHTML = \`<div class="timeline-marker \${markerClass}"></div><div class="timeline-content"><div class="timeline-time">\${time}</div><div class="timeline-message">\${update.message}</div></div>\`;
            timeline.insertBefore(item, timeline.firstChild);
            while (timeline.children.length > 50) timeline.removeChild(timeline.lastChild);
        }

        setInterval(() => {
            const elapsed = Math.floor((Date.now() - startTime) / 1000);
            statTime.textContent = elapsed + 's';
        }, 1000);

        connect();
    </script>
</body>
</html>`;

export interface StatusUpdate {
  type: 'phase' | 'agent' | 'progress' | 'complete' | 'error';
  phase?: string;
  agent?: string;
  message: string;
  progress?: number;
  total?: number;
  timestamp: number;
  details?: Record<string, unknown>;
}

export class StatusServer {
  private wss: WebSocketServer | null = null;
  private server: ReturnType<typeof createServer> | null = null;
  private clients: Set<WebSocket> = new Set();
  private port: number;
  private history: StatusUpdate[] = [];

  constructor(port = 3456) {
    this.port = port;
  }

  /**
   * Start the WebSocket server
   */
  start(): Promise<{ url: string; port: number }> {
    return new Promise((resolve, reject) => {
      // Create HTTP server for serving the HTML page
      this.server = createServer((req, res) => {
        if (req.url === '/' || req.url === '/index.html') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(MONITOR_HTML);
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      });

      // Create WebSocket server
      this.wss = new WebSocketServer({ server: this.server });

      this.wss.on('connection', (ws: WebSocket) => {
        console.log('[StatusServer] Client connected');
        this.clients.add(ws);

        // Send history to new client
        ws.send(JSON.stringify({ type: 'history', data: this.history }));

        ws.on('close', () => {
          console.log('[StatusServer] Client disconnected');
          this.clients.delete(ws);
        });

        ws.on('error', (error) => {
          console.error('[StatusServer] WebSocket error:', error);
          this.clients.delete(ws);
        });
      });

      this.server.listen(this.port, () => {
        const url = `http://localhost:${this.port}`;
        console.log(`\n🔍 Status Monitor: ${url}\n`);
        resolve({ url, port: this.port });
      });

      this.server.on('error', (error) => {
        reject(error);
      });
    });
  }

  /**
   * Send status update to all connected clients
   */
  sendUpdate(update: Omit<StatusUpdate, 'timestamp'>): void {
    const fullUpdate: StatusUpdate = {
      ...update,
      timestamp: Date.now(),
    };

    // Add to history
    this.history.push(fullUpdate);

    // Broadcast to all clients
    const message = JSON.stringify(fullUpdate);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      // Close all client connections
      for (const client of this.clients) {
        client.close();
      }
      this.clients.clear();

      // Close WebSocket server
      if (this.wss) {
        this.wss.close(() => {
          console.log('[StatusServer] WebSocket server closed');
        });
      }

      // Close HTTP server
      if (this.server) {
        this.server.close(() => {
          console.log('[StatusServer] HTTP server closed');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Get number of connected clients
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Clear history
   */
  clearHistory(): void {
    this.history = [];
  }
}

/**
 * Create and start a status server
 */
export async function createStatusServer(port?: number): Promise<StatusServer> {
  const server = new StatusServer(port);
  await server.start();
  return server;
}
