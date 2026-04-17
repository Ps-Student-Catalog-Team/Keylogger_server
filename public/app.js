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
const WS_URL = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`;
let autoRefreshTimer = null;
const AUTO_REFRESH_INTERVAL = 1000; // 1秒
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

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
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
    const sortedClients = [...clients].sort((a, b) => {
        if (a.status === 'online' && b.status !== 'online') return -1;
        if (a.status !== 'online' && b.status === 'online') return 1;
        // 状态相同时，按照 IP 地址排序
        return a.ip.localeCompare(b.ip);
    });

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
    const sortedClients = [...clients].sort((a, b) => {
        if (a.status === 'online' && b.status !== 'online') return -1;
        if (a.status !== 'online' && b.status === 'online') return 1;
        // 状态相同时，按照 IP 地址排序
        return a.ip.localeCompare(b.ip);
    });

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

// 初始化连接
connectWebSocket();