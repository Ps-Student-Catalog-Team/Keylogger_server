const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const net = require('net');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const axios = require('axios');
const mysql = require('mysql2/promise');
require('dotenv').config();

// 初始化 Express
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

//Alist 客户端
const ALIST_CONFIG = {
    url: process.env.ALIST_URL || 'http://10.88.202.73:5244',
    basePath: process.env.ALIST_BASE_PATH || '/学生目录/log',
    username: process.env.ALIST_USERNAME || 'admin',
    password: process.env.ALIST_PASSWORD || 'adm1n5'
};

class AlistClient {
    constructor(config) {
        this.baseUrl = config.url.replace(/\/$/, '');
        this.basePath = config.basePath.replace(/\/$/, '');
        this.username = config.username;
        this.password = config.password;
        this.token = null;
        this.tokenExpire = 0;
    }

    async _request(method, endpoint, data = null, options = {}, retry = true) {
        await this._ensureToken();
        const url = `${this.baseUrl}${endpoint}`;
        const headers = {
            'Authorization': this.token,
            ...options.headers
        };
        try {
            const response = await axios({
                method,
                url,
                data,
                headers,
                ...options
            });
            return response.data;
        } catch (error) {
            if (retry && error.response && error.response.status === 401) {
                // Token 失效，重新登录并重试一次
                await this._login();
                headers.Authorization = this.token;
                const retryResponse = await axios({ method, url, data, headers, ...options });
                return retryResponse.data;
            }
            throw error;
        }
    }

    async _login() {
        const response = await axios.post(`${this.baseUrl}/api/auth/login`, {
            username: this.username,
            password: this.password
        });
        if (response.data.code === 200) {
            this.token = response.data.data.token;
            this.tokenExpire = Date.now() + 23 * 60 * 60 * 1000; // 24h 有效期提前1h刷新
        } else {
            throw new Error('Alist 登录失败: ' + response.data.message);
        }
    }

    async _ensureToken() {
        if (!this.token || Date.now() >= this.tokenExpire) {
            await this._login();
        }
    }

    _getFullPath(relativePath) {
        return relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
    }

    // 确保目录存在
    async ensureDir(dirPath) {
        const fullPath = this._getFullPath(dirPath);
        try {
            await this._request('GET', `/api/fs/list?path=${encodeURIComponent(fullPath)}`);
        } catch (err) {
            if (err.response && err.response.status === 404) {
                await this._request('POST', '/api/fs/mkdir', { path: fullPath });
            } else {
                throw err;
            }
        }
    }

    // 列出目录文件
    async listFiles(dirPath) {
    const fullPath = this._getFullPath(dirPath);
    try {
        const result = await this._request('GET', `/api/fs/list?path=${encodeURIComponent(fullPath)}`);
        
        // 临时日志
        console.log(`[Alist] listFiles(${dirPath}) 返回:`, JSON.stringify(result, null, 2));

        if (result.code === 200) {
            // 尝试从多个可能的字段中获取文件列表
            let items = [];
            if (result.data?.content && Array.isArray(result.data.content)) {
                items = result.data.content;
            } else if (result.data?.files && Array.isArray(result.data.files)) {
                items = result.data.files;
            } else if (Array.isArray(result.data)) {
                items = result.data;
            }

            return items.map(item => ({
                filename: item.name || item.filename || 'unknown',
                size: item.size || 0,
                uploadTime: new Date(item.modified || item.updated || item.mtime || Date.now())
            }));
        }
        return [];
    } catch (err) {
        if (err.response && err.response.status === 404) {
            return [];  // 目录不存在，视为空
        }
        throw err;
    }
}
    // 读取文本文件
    async readFile(filePath) {
        const fullPath = this._getFullPath(filePath);
        return await this._request('GET', `/api/fs/get?path=${encodeURIComponent(fullPath)}`, null, {
            responseType: 'text'
        });
    }

    // 下载文件（流式）
    async downloadFile(filePath, res) {
        const fullPath = this._getFullPath(filePath);
        await this._ensureToken();
        const url = `${this.baseUrl}/api/fs/get?path=${encodeURIComponent(fullPath)}`;
        const response = await axios({
            method: 'GET',
            url,
            headers: { 'Authorization': this.token },
            responseType: 'stream'
        });
        response.data.pipe(res);
    }

    // 上传文本文件
    async uploadFile(dirPath, filename, content) {
        const fullDir = this._getFullPath(dirPath);
        const fullPath = `${fullDir}/${filename}`;
        await this.ensureDir(dirPath);
        await this._request('PUT', `/api/fs/put?path=${encodeURIComponent(fullPath)}`, content, {
            headers: {
                'Content-Type': 'text/plain',
                'Content-Length': Buffer.byteLength(content)
            }
        });
        return { success: true, filename };
    }
}

const alistClient = new AlistClient(ALIST_CONFIG);

//  MySQL 连接池
const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'log_manager',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'client_logs',
    charset: 'utf8mb4',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

const pool = mysql.createPool(dbConfig);

// 初始化数据库表
async function initDatabase() {
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS known_clients (
                id VARCHAR(45) PRIMARY KEY COMMENT '客户端标识 ip:port',
                ip VARCHAR(45) NOT NULL,
                port INT NOT NULL,
                last_seen BIGINT COMMENT '最后在线时间戳（毫秒）',
                created_at BIGINT COMMENT '创建时间戳（毫秒）'
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        console.log('MySQL 数据库表初始化完成');
    } catch (error) {
        console.error('数据库初始化失败:', error);
        process.exit(1);
    } finally {
        if (connection) connection.release();
    }
}

// 从数据库加载已知客户端
async function loadKnownClientsFromDB() {
    let connection;
    try {
        connection = await pool.getConnection();
        const [rows] = await connection.execute('SELECT ip, port FROM known_clients');
        return rows.map(row => `${row.ip}:${row.port}`);
    } catch (error) {
        console.error('加载已知客户端失败:', error);
        return [];
    } finally {
        if (connection) connection.release();
    }
}

// 保存/更新已知客户端
async function saveKnownClientToDB(clientId, ip, port) {
    let connection;
    try {
        connection = await pool.getConnection();
        const now = Date.now();
        await connection.execute(
            `INSERT INTO known_clients (id, ip, port, last_seen, created_at) 
             VALUES (?, ?, ?, ?, ?) 
             ON DUPLICATE KEY UPDATE 
                 ip = VALUES(ip), 
                 port = VALUES(port), 
                 last_seen = VALUES(last_seen)`,
            [clientId, ip, port, now, now]
        );
    } catch (error) {
        console.error('保存客户端到数据库失败:', error);
    } finally {
        if (connection) connection.release();
    }
}

// 更新最后在线时间
async function updateLastSeen(clientId) {
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.execute(
            'UPDATE known_clients SET last_seen = ? WHERE id = ?',
            [Date.now(), clientId]
        );
    } catch (error) {
        console.error('更新最后在线时间失败:', error);
    } finally {
        if (connection) connection.release();
    }
}

// ClientManager (被动监听模式)
const TCP_LISTEN_PORT = parseInt(process.env.TCP_PORT) || 9999;

class ClientManager {
    constructor() {
        this.clients = new Map();           // 在线客户端 Map<clientId, clientObject>
        this.knownClients = new Set();      // 已知客户端 ID 集合
        this.webClients = new Set();        // WebSocket 连接
        this.heartbeatInterval = 30000;
        this.tcpServer = null;

        this.init();
    }

    async init() {
        await initDatabase();
        const ids = await loadKnownClientsFromDB();
        ids.forEach(id => this.knownClients.add(id));
        console.log(`从数据库加载了 ${ids.length} 个已知客户端`);

        this.startTcpServer();
        this.startHeartbeat();
    }

    startTcpServer() {
        this.tcpServer = net.createServer((socket) => {
            const remoteAddress = socket.remoteAddress.replace(/^::ffff:/, '');
            const remotePort = socket.remotePort;
            const clientId = `${remoteAddress}:${remotePort}`;

            console.log(`客户端主动连接: ${clientId}`);

            const client = {
                id: clientId,
                ip: remoteAddress,
                port: remotePort,
                socket,
                status: 'online',
                recording: true,
                uploadEnabled: false,
                lastSeen: new Date(),
                logDir: alistClient.basePath,
                commandQueue: [],
                pendingResponse: null,
                shouldReconnect: false
            };

            // 如果已存在同 ID 的旧连接，先清理
            const existing = this.clients.get(clientId);
            if (existing) {
                existing.socket.destroy();
                this.clients.delete(clientId);
            }

            this.clients.set(clientId, client);
            this.knownClients.add(clientId);
            saveKnownClientToDB(clientId, remoteAddress, remotePort).catch(e => console.error(e));

            this.setupSocketListeners(client);
            this.broadcastToWeb({ type: 'client_connected', client: this.getClientInfo(client) });
        });

        this.tcpServer.on('error', (err) => {
            console.error('TCP 服务器错误:', err);
        });

        this.tcpServer.listen(TCP_LISTEN_PORT, () => {
            console.log(`TCP 被动监听端口 ${TCP_LISTEN_PORT}，等待客户端连接...`);
        });
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
                        console.error('解析客户端消息失败:', msg);
                    }
                });
            } catch (e) {
                console.error('处理客户端数据失败:', e);
            }
        });

        client.socket.on('close', () => {
            console.log(`客户端 ${client.id} 连接断开`);
            client.status = 'offline';
            this.broadcastToWeb({ type: 'client_offline', clientId: client.id });
        });

        client.socket.on('error', (err) => {
            console.error(`客户端 ${client.id} 错误:`, err.message);
            client.status = 'offline';
            this.broadcastToWeb({ type: 'client_offline', clientId: client.id });
        });
    }

    handleResponse(client, response) {
        client.lastSeen = new Date();
        updateLastSeen(client.id).catch(e => console.error(e));

        if (response.status === 'ok' && response.data) {
            if (response.data.recording !== undefined) {
                client.recording = response.data.recording;
            }
            if (response.data.upload_enabled !== undefined) {
                client.uploadEnabled = response.data.upload_enabled;
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
            return { success: false, error: '客户端离线或不存在' };
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
        // 在线客户端
        for (const client of this.clients.values()) {
            allClients.push(this.getClientInfo(client));
        }
        // 离线但已知的客户端
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
}

const clientManager = new ClientManager();

//  WebSocket 处理
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

                case 'disconnect_client':
                    const client = clientManager.clients.get(data.clientId);
                    if (client) {
                        client.socket.end();
                        clientManager.clients.delete(data.clientId);
                    }
                    ws.send(JSON.stringify({ type: 'disconnected', clientId: data.clientId }));
                    break;

                default:
                    ws.send(JSON.stringify({ type: 'error', message: '未知的命令类型' }));
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

//HTTP API
app.get('/api/clients', (req, res) => {
    res.json(clientManager.getAllClients());
});

app.get('/api/clients/:clientId/logs', async (req, res) => {
    const client = clientManager.clients.get(req.params.clientId);
    if (!client) {
        return res.status(404).json({ error: '客户端不存在或离线' });
    }
    try {
        const files = await alistClient.listFiles(client.logDir);
        res.json(files);
    } catch (e) {
        console.error('获取日志列表失败:', e);
        res.status(500).json({ error: '读取失败', details: e.message });
    }
});

app.get('/api/clients/:clientId/logs/:filename', async (req, res) => {
    const client = clientManager.clients.get(req.params.clientId);
    if (!client) {
        return res.status(404).json({ error: '客户端不存在或离线' });
    }
    const filePath = `${client.logDir}/${req.params.filename}`;
    try {
        const content = await alistClient.readFile(filePath);
        res.json({ content });
    } catch (e) {
        console.error('读取文件失败:', e);
        res.status(404).json({ error: '文件不存在或无法读取' });
    }
});

app.get('/api/clients/:clientId/logs/:filename/download', async (req, res) => {
    const client = clientManager.clients.get(req.params.clientId);
    if (!client) {
        return res.status(404).json({ error: '客户端不存在或离线' });
    }
    const filePath = `${client.logDir}/${req.params.filename}`;
    try {
        await alistClient.downloadFile(filePath, res);
    } catch (e) {
        console.error('下载文件失败:', e);
        if (!res.headersSent) {
            res.status(404).json({ error: '文件不存在或无法下载' });
        }
    }
});

app.post('/api/upload/:ip', express.raw({ type: 'text/plain', limit: '10mb' }), async (req, res) => {
    const ip = req.params.ip;
    const clientId = Array.from(clientManager.clients.keys()).find(id => id.startsWith(ip));
    if (!clientId) {
        return res.status(404).json({ error: '客户端不存在或离线' });
    }
    const client = clientManager.clients.get(clientId);
    const filename = `${ip}_${new Date().toISOString().split('T')[0].replace(/-/g, '')}.log`;
    try {
        await alistClient.uploadFile(client.logDir, filename, req.body.toString());
        res.json({ success: true, filename });
    } catch (e) {
        console.error('上传到 Alist 失败:', e);
        res.status(500).json({ error: '保存失败', details: e.message });
    }
});

//启动服务
const PORT = parseInt(process.env.PORT) || 3232;
server.listen(PORT, () => {
    console.log(`HTTP 服务运行在端口 ${PORT}`);
    console.log(`访问 http://localhost:${PORT} 打开管理界面`);
});