let mcRefreshTimer = null;
const COMMAND_HISTORY_KEY = 'mcCommandHistory';
const COMMAND_HISTORY_MAX = 50;
const commandHistory = [];
let historyIndex = -1;
let mcLogLines = [];
let mcConsoleFilterText = '';
let mcStatsChart = null;
const mcStatsHistory = { cpu: [], memory: [], tps: [], labels: [] };
const MC_STATS_HISTORY_MAX_MS = 60 * 60 * 1000;
const MC_STATS_CHART_RANGES = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000
};
const MC_REFRESH_PRESET_VALUES = {
  fast: { playerListIntervalSeconds: 1, statsIntervalSeconds: 5, tpsIntervalSeconds: 1 },
  standard: { playerListIntervalSeconds: 5, statsIntervalSeconds: 15, tpsIntervalSeconds: 5 },
  slow: { playerListIntervalSeconds: 15, statsIntervalSeconds: 30, tpsIntervalSeconds: 15 }
};
let mcStatsChartRange = '15m';

// 多服务器支持：当前选中的服务器 ID
let currentMcServerId = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureMcServerSelected(timeoutMs = 3000) {
  if (currentMcServerId) return;
  const start = Date.now();
  while (!currentMcServerId && Date.now() - start < timeoutMs) {
    await sleep(100);
  }
  if (!currentMcServerId) {
    throw new Error('未选中 MC 服务器实例，无法执行操作');
  }
}

function mcApi(path) {
  if (!currentMcServerId) {
    const msg = 'currentMcServerId 未设置，无法构建 MC API 请求';
    console.warn(msg);
    throw new Error(msg);
  }
  return `/api/mc/${currentMcServerId}${path}`;
}

function updateMcSelectedServerLabel() {
  const select = document.getElementById('mcServerSelect');
  const label = document.getElementById('mcSelectedServerName');
  if (!label) return;
  if (!select || !select.value) {
    label.textContent = '未选择实例';
    return;
  }
  label.textContent = select.selectedOptions?.[0]?.textContent || select.value;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripMcColorCodes(text) {
  return String(text || '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/§[0-9A-FK-OR]/gi, '');
}

function classifyMcLogLevel(text) {
  const upper = String(text || '').toUpperCase();
  if (upper.includes('[SEVERE]') || upper.includes('[ERROR]') || upper.includes('[STDERR]')) {
    return 'error';
  }
  if (upper.includes('[WARN]') || upper.includes('[WARNING]') || upper.includes(' WARN ')) {
    return 'warn';
  }
  if (upper.includes('[INFO]')) {
    return 'info';
  }
  return 'info';
}

function getMcLogStyle(level) {
  if (level === 'error') return 'color: #ef4444;';
  if (level === 'warn') return 'color: #f59e0b;';
  if (level === 'info') return 'color: #10b981;';
  return '';
}

function formatMcColorCodes(text) {
  const colorMap = {
    '0': '#000000', '1': '#0000AA', '2': '#00AA00', '3': '#00AAAA',
    '4': '#AA0000', '5': '#AA00AA', '6': '#FFAA00', '7': '#AAAAAA',
    '8': '#555555', '9': '#5555FF', 'a': '#55FF55', 'b': '#55FFFF',
    'c': '#FF5555', 'd': '#FF55FF', 'e': '#FFFF55', 'f': '#FFFFFF'
  };
  const ansiColorMap = {
    30: '#000000', 31: '#AA0000', 32: '#00AA00', 33: '#AA5500',
    34: '#0000AA', 35: '#AA00AA', 36: '#00AAAA', 37: '#AAAAAA',
    90: '#555555', 91: '#FF5555', 92: '#55FF55', 93: '#FFFF55',
    94: '#5555FF', 95: '#FF55FF', 96: '#55FFFF', 97: '#FFFFFF'
  };
  const highlightLevels = {
    '\[INFO\]': 'color: #3b82f6; font-weight: 600',
    '\[WARN\]': 'color: #f59e0b; font-weight: 600',
    '\[ERROR\]': 'color: #ef4444; font-weight: 600',
    '\[SEVERE\]': 'color: #ef4444; font-weight: 600',
    '\[DEBUG\]': 'color: #6b7280; font-weight: 600'
  };

  let html = '';
  let currentStyle = { color: null, bold: false, italic: false, underline: false };
  const openSpan = () => {
    const styles = [];
    if (currentStyle.color) styles.push(`color: ${currentStyle.color}`);
    if (currentStyle.bold) styles.push('font-weight: 700');
    if (currentStyle.italic) styles.push('font-style: italic');
    if (currentStyle.underline) styles.push('text-decoration: underline');
    return styles.length ? `<span style="${styles.join('; ')}">` : '<span>';
  };
  const segments = String(text).split(/(\u001b\[[0-9;]*m|§[0-9A-FK-OR])/gi);
  let opened = false;
  segments.forEach((segment) => {
    if (!segment) return;
    const ansiMatch = segment.match(/^\u001b\[([0-9;]*)m$/);
    if (ansiMatch) {
      if (opened) html += '</span>';
      const codes = ansiMatch[1].split(';').map(Number).filter((n) => !Number.isNaN(n));
      codes.forEach((code) => {
        if (code === 0) {
          currentStyle = { color: null, bold: false, italic: false, underline: false };
        } else if (code === 1) {
          currentStyle.bold = true;
        } else if (code === 3) {
          currentStyle.italic = true;
        } else if (code === 4) {
          currentStyle.underline = true;
        } else if (ansiColorMap[code]) {
          currentStyle.color = ansiColorMap[code];
        }
      });
      html += openSpan();
      opened = true;
      return;
    }
    if (/^§[0-9A-FK-OR]$/i.test(segment)) {
      if (opened) html += '</span>';
      const code = segment[1].toLowerCase();
      if (code === 'r') {
        currentStyle = { color: null, bold: false, italic: false, underline: false };
      } else if (colorMap[code]) {
        currentStyle.color = colorMap[code];
      } else if (code === 'l') {
        currentStyle.bold = true;
      } else if (code === 'o') {
        currentStyle.italic = true;
      } else if (code === 'n') {
        currentStyle.underline = true;
      }
      html += openSpan();
      opened = true;
      return;
    }
    if (!opened) {
      html += '<span>' + escapeHtml(segment) + '</span>';
      opened = true;
      return;
    }
    html += escapeHtml(segment);
  });
  if (opened) html += '</span>';

  Object.keys(highlightLevels).forEach((pattern) => {
    const re = new RegExp(pattern, 'g');
    html = html.replace(re, (match) => `<span style="${highlightLevels[pattern]}">${match}</span>`);
  });
  return html;
}

function formatMcLogs(logs) {
  if (!Array.isArray(logs)) return formatMcColorCodes(logs);
  return logs.map((line) => formatMcColorCodes(line)).join('<br>');
}

function persistCommandHistory() {
  try {
    window.localStorage.setItem(COMMAND_HISTORY_KEY, JSON.stringify(commandHistory.slice(-COMMAND_HISTORY_MAX)));
  } catch (e) {
    console.warn('无法保存命令历史:', e);
  }
}

function loadCommandHistory() {
  try {
    const raw = window.localStorage.getItem(COMMAND_HISTORY_KEY);
    if (!raw) return;
    const items = JSON.parse(raw);
    if (Array.isArray(items)) {
      commandHistory.length = 0;
      items.slice(-COMMAND_HISTORY_MAX).forEach((item) => {
        if (typeof item === 'string' && item.trim()) {
          commandHistory.push(item);
        }
      });
      historyIndex = commandHistory.length;
    }
  } catch (e) {
    console.warn('无法加载命令历史:', e);
  }
}

function addToCommandHistory(command) {
  if (!command) return;
  const last = commandHistory[commandHistory.length - 1];
  if (last === command) return;
  commandHistory.push(command);
  while (commandHistory.length > COMMAND_HISTORY_MAX) {
    commandHistory.shift();
  }
  historyIndex = commandHistory.length;
  persistCommandHistory();
}

let mcAutoScroll = true;

function appendMcLog(line) {
  let text = '';
  let level = null;
  if (typeof line === 'object' && line !== null) {
    text = String(line.text || '');
    level = String(line.level || classifyMcLogLevel(text)).toLowerCase();
  } else {
    text = String(line || '');
    level = classifyMcLogLevel(text);
  }

  // 去掉开头的 ISO 时间戳
  text = text.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\s+/, '');

  if (!level) return;
  mcLogLines.push({ text, level });
  if (mcLogLines.length > 1000) {
    mcLogLines.shift();
  }
  renderMcConsole();
}

  // Backups UI
  async function loadMcBackups() {
    try {
      await ensureMcServerSelected();
      const resp = await fetch(mcApi('/backups'));
      const data = await resp.json();
      const container = document.getElementById('mcBackupsList');
      if (!container) return;
      if (!data.success) {
        container.innerHTML = `<p class="mc-player-empty">加载备份列表失败</p>`;
        return;
      }
      if (!data.backups || data.backups.length === 0) {
        container.innerHTML = `<p class="mc-player-empty">暂无备份文件</p>`;
        return;
      }
      const items = data.backups.map(b => {
        const date = new Date(b.mtime).toLocaleString();
        return `<div class="mc-player-item"><span>${b.name} <small style="color:var(--gray);">${date} · ${Math.round(b.size/1024)} KB</small></span><div style="display:flex;gap:0.5rem;"><button class="btn btn-sm btn-success" onclick="downloadMcBackup('${b.name}')"><i class="fas fa-download"></i> 下载</button><button class="btn btn-sm btn-secondary" onclick="confirmRestoreMcBackup('${b.name}')"><i class="fas fa-undo"></i> 还原</button></div></div>`;
      }).join('');
      container.innerHTML = `<div>${items}</div>`;
    } catch (e) {
      console.error('加载备份失败', e);
      const container = document.getElementById('mcBackupsList');
      if (container) container.innerHTML = `<p class="mc-player-empty">加载备份列表失败</p>`;
    }
  }

  function downloadMcBackup(name) {
    try {
      const link = document.createElement('a');
      link.href = mcApi(`/backups/${encodeURIComponent(name)}/download`);
      link.download = name;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      showToast('开始下载备份', 'success');
    } catch (e) {
      console.error('下载备份失败', e);
      showToast('下载备份失败', 'error');
    }
  }

  function confirmRestoreMcBackup(name) {
    if (typeof showConfirmModal === 'function') {
      showConfirmModal('确认还原', `确认要从备份 ${name} 还原世界吗？此操作会覆盖当前世界，并在完成后重启服务器。`, () => restoreMcBackup(name));
    } else if (window.confirm(`确认要从备份 ${name} 还原世界吗？此操作会覆盖当前世界，并在完成后重启服务器。`)) {
      restoreMcBackup(name);
    }
  }

  async function restoreMcBackup(name) {
    try {
      await ensureMcServerSelected();
      const resp = await fetch(mcApi(`/backups/${encodeURIComponent(name)}/restore`), { method: 'POST' });
      const data = await resp.json();
      if (data.success) {
        showToast('还原已完成，服务器已重启（如果配置）', 'success');
        setTimeout(() => { loadMcStatus(); }, 2000);
      } else {
        showToast(data.error || '还原失败', 'error');
      }
    } catch (e) {
      console.error('还原请求失败', e);
      showToast('还原请求失败', 'error');
    }
  }

  async function createMcBackup() {
    try {
      await ensureMcServerSelected();
      const resp = await fetch(mcApi('/backup'), { method: 'POST' });
      const data = await resp.json();
      if (data.success) {
        showToast('备份已创建: ' + data.name, 'success');
        setTimeout(loadMcBackups, 800);
      } else {
        showToast(data.error || '创建备份失败', 'error');
      }
    } catch (e) {
      console.error('创建备份失败', e);
      showToast('创建备份失败', 'error');
    }
  }

function highlightConsoleLine(htmlLine, keyword) {
  if (!keyword) return htmlLine;
  const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return htmlLine.replace(new RegExp(`(${escapedKeyword})`, 'gi'), '<span style="background: rgba(245, 158, 11, 0.25); color: #fff;">$1</span>');
}

function renderMcConsole() {
    const output = document.getElementById('mcStdout');
    if (!output) return;

    const filter = (mcConsoleFilterText || '').trim().toLowerCase();
    const lines = mcLogLines.filter((entry) => {
        if (!filter) return true;
        return entry.text.toLowerCase().includes(filter);
    });

    const levelColorMap = {
        info: '#10b981',   // 绿色
        warn: '#f59e0b',   // 橙色
        error: '#ef4444'   // 红色
    };

    output.innerHTML = lines.map((entry) => {
        let text = escapeHtml(entry.text);
        // 匹配独立的 INFO、WARN、ERROR（不区分大小写，使用单词边界）
        text = text.replace(/\b(INFO|WARN|ERROR)\b/gi, (match) => {
            const lower = match.toLowerCase();
            const color = levelColorMap[lower];
            return `<span style="color: ${color};">${match}</span>`;
        });
        return `<div style="white-space: pre-wrap; word-break: break-word;">${text}</div>`;
    }).join('');

    if (mcAutoScroll) {
        output.scrollTop = output.scrollHeight;
    }
}

function clearMcConsole() {
  mcLogLines = [];
  const output = document.getElementById('mcStdout');
  if (output) {
    output.innerHTML = '';
  }
}

function toggleMcAutoScroll() {
  mcAutoScroll = !mcAutoScroll;
  const button = document.getElementById('mcAutoScrollBtn');
  if (button) {
    button.innerHTML = `<i class="fas fa-${mcAutoScroll ? 'lock-open' : 'lock'}"></i> ${mcAutoScroll ? '自动滚动' : '锁定滚动'}`;
  }
  showToast(mcAutoScroll ? '自动滚动已启用' : '已锁定滚动', 'info');
}

function formatMcStatsTimeLabel(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function initMcStatsChart() {
  const canvas = document.getElementById('mcStatsChart');
  if (!canvas || !canvas.getContext || typeof Chart === 'undefined') return;
  if (mcStatsChart) {
    mcStatsChart.destroy();
    mcStatsChart = null;
  }
  const ctx = canvas.getContext('2d');
  const gradientCpu = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradientCpu.addColorStop(0, 'rgba(59, 130, 246, 0.28)');
  gradientCpu.addColorStop(1, 'rgba(59, 130, 246, 0.04)');
  const gradientMem = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradientMem.addColorStop(0, 'rgba(16, 185, 129, 0.24)');
  gradientMem.addColorStop(1, 'rgba(16, 185, 129, 0.04)');
  const gradientTps = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradientTps.addColorStop(0, 'rgba(245, 158, 11, 0.2)');
  gradientTps.addColorStop(1, 'rgba(245, 158, 11, 0.04)');

  mcStatsChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label: 'CPU %', data: [], backgroundColor: gradientCpu, borderColor: '#3b82f6', fill: true, tension: 0.35, borderWidth: 2, pointRadius: 0, yAxisID: 'y' },
        { label: '内存 MB', data: [], backgroundColor: gradientMem, borderColor: '#10b981', fill: true, tension: 0.35, borderWidth: 2, pointRadius: 0, yAxisID: 'y1' },
        { label: 'TPS', data: [], backgroundColor: gradientTps, borderColor: '#f59e0b', fill: true, tension: 0.35, borderWidth: 2, pointRadius: 0, yAxisID: 'y2' }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top', labels: { usePointStyle: true, pointStyle: 'circle' } },
        tooltip: {
          mode: 'index',
          intersect: false,
          callbacks: {
            label(context) {
              const value = context.parsed.y;
              if (value == null || Number.isNaN(value)) return `${context.dataset.label}: -`;
              if (context.dataset.label === 'CPU %') return `CPU: ${value.toFixed(1)} %`;
              if (context.dataset.label === '内存 MB') return `内存: ${value.toFixed(0)} MB`;
              if (context.dataset.label === 'TPS') return `TPS: ${value.toFixed(2)}`;
              return `${context.dataset.label}: ${value}`;
            }
          }
        }
      },
      scales: {
        x: {
          type: 'category',
          grid: { color: 'rgba(107, 117, 128, 0.12)' },
          ticks: { autoSkip: true, maxRotation: 0, minRotation: 0 }
        },
        y: {
          type: 'linear',
          position: 'left',
          title: { display: true, text: 'CPU (%)' },
          beginAtZero: true,
          grid: { color: 'rgba(107, 117, 128, 0.12)' }
        },
        y1: {
          type: 'linear',
          position: 'right',
          offset: true,
          title: { display: true, text: '内存 (MB)' },
          beginAtZero: true,
          grid: { drawOnChartArea: false, color: 'rgba(107, 117, 128, 0.12)' }
        },
        y2: {
          type: 'linear',
          position: 'right',
          offset: true,
          title: { display: true, text: 'TPS' },
          beginAtZero: true,
          grid: { drawOnChartArea: false, color: 'rgba(107, 117, 128, 0.12)' },
          min: 0,
          max: 20
        }
      }
    }
  });
}

function updateCommandPreview() {
    const java = document.getElementById('mcJavaPath')?.value.trim() || 'java';
    const minMem = document.getElementById('mcMinMemory')?.value.trim() || '1024M';
    const maxMem = document.getElementById('mcMaxMemory')?.value.trim() || '4096M';
    const jar = document.getElementById('mcJarPath')?.value.trim() || 'server.jar';
    const args = document.getElementById('mcAdditionalArgs')?.value.trim() || '';
    let cmd = `${java} -Xms${minMem} -Xmx${maxMem}`;
    if (args) cmd += ` ${args}`;
    cmd += ` -jar ${jar} nogui`;
    const preview = document.getElementById('mcConfigCommandPreview');
    if (preview) preview.value = cmd;   // textarea 也支持 .value
}

function getMcStatsTimeWindowMs() {
  return MC_STATS_CHART_RANGES[mcStatsChartRange] || null;
}

function getMcStatsVisibleSeries() {
  const windowMs = getMcStatsTimeWindowMs();
  const now = Date.now();
  const labels = [];
  const cpu = [];
  const memory = [];
  const tps = [];

  for (let i = 0; i < mcStatsHistory.labels.length; i++) {
    const timestamp = mcStatsHistory.labels[i];
    if (windowMs != null && now - timestamp > windowMs) {
      continue;
    }
    labels.push(timestamp);
    cpu.push(mcStatsHistory.cpu[i]);
    memory.push(mcStatsHistory.memory[i]);
    tps.push(mcStatsHistory.tps[i]);
  }

  return { labels, cpu, memory, tps };
}

function pruneMcStatsHistory() {
  const now = Date.now();
  const cutoff = now - MC_STATS_HISTORY_MAX_MS;
  while (mcStatsHistory.labels.length > 0 && mcStatsHistory.labels[0] < cutoff) {
    mcStatsHistory.labels.shift();
    mcStatsHistory.cpu.shift();
    mcStatsHistory.memory.shift();
    mcStatsHistory.tps.shift();
  }
}

function updateMcStatsChart() {
  if (!mcStatsChart) initMcStatsChart();
  if (!mcStatsChart) return;

  const visible = getMcStatsVisibleSeries();
  mcStatsChart.data.labels = visible.labels.map((ts) => formatMcStatsTimeLabel(ts));
  mcStatsChart.data.datasets[0].data = visible.cpu;
  mcStatsChart.data.datasets[1].data = visible.memory;
  mcStatsChart.data.datasets[2].data = visible.tps;
  mcStatsChart.update('none');
}

function setMcStatsRange(range) {
  if (!MC_STATS_CHART_RANGES[range]) return;
  mcStatsChartRange = range;
  const rangeSelect = document.getElementById('mcStatsRangeSelect');
  if (rangeSelect) rangeSelect.value = range;
  updateMcStatsChart();
}

function getMcRefreshPresetFromConfig(cfg = {}) {
  const playerList = Number(cfg.playerListIntervalSeconds || 0);
  const stats = Number(cfg.statsIntervalSeconds || 0);
  const tps = Number(cfg.tpsIntervalSeconds || 0);
  if (playerList === 1 && stats === 5 && tps === 1) return 'fast';
  if (playerList === 5 && stats === 15 && tps === 5) return 'standard';
  if (playerList === 15 && stats === 30 && tps === 15) return 'slow';
  return 'custom';
}

function getMcRefreshPresetValue(preset) {
  if (preset === 'custom') {
    return { playerListIntervalSeconds: 5, statsIntervalSeconds: 15, tpsIntervalSeconds: 5 };
  }
  return MC_REFRESH_PRESET_VALUES[preset] || MC_REFRESH_PRESET_VALUES.standard;
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const num = parseFloat(String(value || '').replace(/[^0-9.+-eE]/g, ''));
  return Number.isFinite(num) ? num : null;
}

function normalizeMemory(memo) {
  if (!memo) return { used: null, total: null };
  if (typeof memo === 'object') {
    return { used: toNumber(memo.used), total: toNumber(memo.total) };
  }
  return { used: toNumber(memo), total: null };
}

function updateMcStats(cpu, memory, tps) {
  const cpuNode = document.getElementById('mcCpu');
  const memoryNode = document.getElementById('mcMemory');
  const tpsNode = document.getElementById('mcTps');
  const cpuValue = toNumber(cpu);
  const memoryValue = normalizeMemory(memory);
  const tpsValue = toNumber(tps);

  if (cpuNode) {
    cpuNode.textContent = cpuValue != null ? `${cpuValue.toFixed(1)} %` : '-';
  }
  if (memoryNode) {
    const formatMb = (mb) => {
      if (mb == null) return '-';
      if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
      return `${mb} MB`;
    };
    const usedMb = memoryValue.used != null ? Math.round(memoryValue.used / 1024 / 1024) : null;
    const totalMb = memoryValue.total != null ? Math.round(memoryValue.total / 1024 / 1024) : null;
    memoryNode.textContent = `${formatMb(usedMb)} / ${formatMb(totalMb)}`;
  }
  if (tpsNode) {
    tpsNode.textContent = tpsValue != null ? tpsValue.toFixed(2) : '-';
  }

  mcStatsHistory.cpu.push(cpuValue != null ? cpuValue : null);
  mcStatsHistory.memory.push(memoryValue.used != null ? memoryValue.used / 1024 / 1024 : null);
  mcStatsHistory.tps.push(tpsValue != null ? tpsValue : null);
  mcStatsHistory.labels.push(Date.now());

  pruneMcStatsHistory();
  updateMcStatsChart();
}

function renderPlayerList(players, count, max) {
  const container = document.getElementById('mcPlayerList');
  const countLabel = document.getElementById('mcPlayerCount');
  const maxLabel = document.getElementById('mcPlayerMax');
  if (countLabel) {
    countLabel.textContent = `${count || (players ? players.length : 0)}`;
  }
  if (maxLabel) {
    maxLabel.textContent = `${max || '-'}`;
  }
  if (!container) return;

  if (!Array.isArray(players) || players.length === 0) {
    container.innerHTML = '<p class="mc-player-empty">暂无玩家在线</p>';
    return;
  }

  const listItems = players.map((player) => {
    const safeName = player.replace(/'/g, "\\'");
    return `<div class="mc-player-item">
              <span><i class="fas fa-user"></i> ${player}</span>
              <div style="display:flex; gap:0.5rem; flex-wrap: wrap;">
                <button class="btn btn-secondary btn-sm" title="踢出玩家 ${player}" onclick="confirmMcPlayerAction('${safeName}', 'kick')"><i class="fas fa-sign-out-alt"></i> 踢出</button>
                <button class="btn btn-danger btn-sm" title="封禁玩家 ${player}" onclick="confirmMcPlayerAction('${safeName}', 'ban')"><i class="fas fa-ban"></i> 封禁</button>
                <button class="btn btn-success btn-sm" title="授予 OP ${player}" onclick="confirmMcPlayerAction('${safeName}', 'op')"><i class="fas fa-user-shield"></i> OP</button>
                <button class="btn btn-secondary btn-sm" title="撤销 OP ${player}" onclick="confirmMcPlayerAction('${safeName}', 'deop')"><i class="fas fa-user-minus"></i> DEOP</button>
              </div>
            </div>`;
  });

  container.innerHTML = `<div>${listItems.join('')}</div>`;
}

function confirmMcPlayerAction(player, action) {
  let actionLabel = '操作';
  let command = '';
  if (action === 'ban') {
    actionLabel = '封禁';
    command = `ban ${player}`;
  } else if (action === 'kick') {
    actionLabel = '踢出';
    command = `kick ${player}`;
  } else if (action === 'op') {
    actionLabel = '授予 OP';
    command = `op ${player}`;
  } else if (action === 'deop') {
    actionLabel = '撤销 OP';
    command = `deop ${player}`;
  }
  if (!command) return;
  const message = `确定要${actionLabel} 玩家 ${player} 吗？`;
  const actionCallback = async () => {
    const success = await sendMcCommand(command);
    if (success) {
      setTimeout(loadMcPlayers, 1500);
    }
  };
  if (typeof showConfirmModal === 'function') {
    showConfirmModal(`确认${actionLabel}`, message, actionCallback);
  } else if (window.confirm(message)) {
    actionCallback();
  }
}

async function refreshMcPlayerList() {
  try {
    await ensureMcServerSelected();
    const response = await fetch(mcApi('/players/refresh'), { method: 'POST' });
    const data = await response.json();
    if (data.success) {
      showToast(data.message || '玩家列表刷新中，请稍候', 'success');
      if (Array.isArray(data.players)) {
        renderPlayerList(data.players, data.count || 0, data.max || 0);
      } else {
        setTimeout(loadMcPlayers, 1500);
      }
    } else {
      showToast(data.error || '刷新失败', 'error');
    }
  } catch (error) {
    console.error('刷新玩家列表失败:', error);
    showToast('刷新玩家列表失败', 'error');
  }
}

function downloadMcLog() {
  try {
    const link = document.createElement('a');
    link.href = mcApi('/logs/download');
    link.download = 'mc_latest.log';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast('MC 日志下载已开始', 'success');
  } catch (error) {
    console.error('下载 MC 日志失败:', error);
    showToast('下载 MC 日志失败', 'error');
  }
}

async function loadMcConfig() {
    try {
        await ensureMcServerSelected();
        updateMcSelectedServerLabel();
        const response = await fetch(mcApi('/config'));
        const data = await response.json();
        if (!data.success) {
            showToast(data.message || '获取 MC 配置失败', 'error');
            return;
        }
        const cfg = data.config;

        // 分解字段
        document.getElementById('mcJavaPath').value = cfg.javaPath || 'java';
        document.getElementById('mcMinMemory').value = cfg.minMemory || '1024M';
        document.getElementById('mcMaxMemory').value = cfg.maxMemory || '4096M';
        document.getElementById('mcJarPath').value = cfg.jarPath || 'server.jar';
        document.getElementById('mcAdditionalArgs').value = cfg.additionalArgs || '';

        // 其他配置
        document.getElementById('mcConfigDir').value = cfg.workingDir || '';
        const autoRestartCheckbox = document.getElementById('mcAutoRestartInput');
        if (autoRestartCheckbox) autoRestartCheckbox.checked = !!cfg.autoRestart;
        const delay = document.getElementById('mcAutoRestartDelay');
        if (delay && typeof cfg.autoRestartDelaySeconds === 'number') delay.value = cfg.autoRestartDelaySeconds;
        const maxRetries = document.getElementById('mcAutoRestartMaxRetries');
        if (maxRetries && typeof cfg.autoRestartMaxRetries === 'number') maxRetries.value = cfg.autoRestartMaxRetries;
        const backupDirInput = document.getElementById('mcBackupDir');
        if (backupDirInput && typeof cfg.backupDir === 'string') backupDirInput.value = cfg.backupDir || '';
        const autoBackupCheckbox = document.getElementById('mcAutoBackupEnable');
        if (autoBackupCheckbox) autoBackupCheckbox.checked = !!cfg.autoBackupEnabled;
        const autoBackupCron = document.getElementById('mcAutoBackupCron');
        if (autoBackupCron && typeof cfg.autoBackupCron === 'string') autoBackupCron.value = cfg.autoBackupCron || '';
        const retentionCount = document.getElementById('mcBackupRetentionCount');
        if (retentionCount && typeof cfg.backupRetentionCount === 'number') retentionCount.value = cfg.backupRetentionCount;
        const retentionDays = document.getElementById('mcBackupRetentionDays');
        if (retentionDays && typeof cfg.backupRetentionDays === 'number') retentionDays.value = cfg.backupRetentionDays;
        const refreshPreset = document.getElementById('mcRefreshPreset');
        const playerListInput = document.getElementById('mcPlayerListInterval');
        const statsInput = document.getElementById('mcStatsInterval');
        const tpsInput = document.getElementById('mcTpsInterval');
        const applyPresetValues = (preset) => {
            const values = getMcRefreshPresetValue(preset);
            if (playerListInput) playerListInput.value = values.playerListIntervalSeconds;
            if (statsInput) statsInput.value = values.statsIntervalSeconds;
            if (tpsInput) tpsInput.value = values.tpsIntervalSeconds;
        };
        if (refreshPreset) {
            refreshPreset.value = getMcRefreshPresetFromConfig(cfg);
            refreshPreset.onchange = () => {
                if (refreshPreset.value === 'custom') return;
                applyPresetValues(refreshPreset.value);
            };
        }
        if (playerListInput && typeof cfg.playerListIntervalSeconds === 'number') playerListInput.value = cfg.playerListIntervalSeconds;
        if (statsInput && typeof cfg.statsIntervalSeconds === 'number') statsInput.value = cfg.statsIntervalSeconds;
        if (tpsInput && typeof cfg.tpsIntervalSeconds === 'number') tpsInput.value = cfg.tpsIntervalSeconds;
        if (playerListInput) {
            playerListInput.addEventListener('input', () => {
                if (refreshPreset && refreshPreset.value !== 'custom') {
                    refreshPreset.value = 'custom';
                }
            });
        }
        if (statsInput) {
            statsInput.addEventListener('input', () => {
                if (refreshPreset && refreshPreset.value !== 'custom') {
                    refreshPreset.value = 'custom';
                }
            });
        }
        if (tpsInput) {
            tpsInput.addEventListener('input', () => {
                if (refreshPreset && refreshPreset.value !== 'custom') {
                    refreshPreset.value = 'custom';
                }
            });
        }

        // 更新命令预览
        updateCommandPreview();

        // 兼容旧配置：如果只有 fullCommand 而没有分解字段，给个提示
        if (cfg.fullCommand && !cfg.javaPath && !cfg.jarPath) {
            showToast('检测到旧版完整命令配置，请重新填写分解字段并保存', 'warning');
        }

        updateMcAutoRestartDisplay(!!cfg.autoRestart);
    } catch (error) {
        console.error('加载 MC 配置失败:', error);
        showToast('加载 MC 配置失败', 'error');
    }
}

async function saveMcConfig() {
    const javaPath = document.getElementById('mcJavaPath')?.value.trim() || '';
    const minMemory = document.getElementById('mcMinMemory')?.value.trim() || '';
    const maxMemory = document.getElementById('mcMaxMemory')?.value.trim() || '';
    const jarPath = document.getElementById('mcJarPath')?.value.trim() || '';
    const additionalArgs = document.getElementById('mcAdditionalArgs')?.value.trim() || '';
    const workingDir = document.getElementById('mcConfigDir')?.value.trim() || '';
    const autoRestart = !!document.getElementById('mcAutoRestartInput')?.checked;
    const autoRestartDelayRaw = document.getElementById('mcAutoRestartDelay')?.value;
    const autoRestartDelaySeconds = autoRestartDelayRaw === '' ? undefined : parseInt(autoRestartDelayRaw, 10);
    const autoRestartMaxRetriesRaw = document.getElementById('mcAutoRestartMaxRetries')?.value;
    const autoRestartMaxRetries = autoRestartMaxRetriesRaw === '' ? undefined : parseInt(autoRestartMaxRetriesRaw, 10);
    const backupDir = document.getElementById('mcBackupDir')?.value.trim() || '';
    const autoBackupEnabled = !!document.getElementById('mcAutoBackupEnable')?.checked;
    const autoBackupCron = document.getElementById('mcAutoBackupCron')?.value.trim() || '';
    const backupRetentionCountRaw = document.getElementById('mcBackupRetentionCount')?.value;
    const backupRetentionCount = backupRetentionCountRaw === '' ? undefined : parseInt(backupRetentionCountRaw, 10);
    const backupRetentionDaysRaw = document.getElementById('mcBackupRetentionDays')?.value;
    const backupRetentionDays = backupRetentionDaysRaw === '' ? undefined : parseInt(backupRetentionDaysRaw, 10);
    const refreshPreset = document.getElementById('mcRefreshPreset')?.value || 'standard';
    const refreshValues = getMcRefreshPresetValue(refreshPreset);
    const playerListIntervalValue = toNumber(document.getElementById('mcPlayerListInterval')?.value);
    const statsIntervalValue = toNumber(document.getElementById('mcStatsInterval')?.value);
    const tpsIntervalValue = toNumber(document.getElementById('mcTpsInterval')?.value);
    const playerListIntervalSeconds = playerListIntervalValue != null && playerListIntervalValue > 0 ? playerListIntervalValue : refreshValues.playerListIntervalSeconds;
    const statsIntervalSeconds = statsIntervalValue != null && statsIntervalValue > 0 ? statsIntervalValue : refreshValues.statsIntervalSeconds;
    const tpsIntervalSeconds = tpsIntervalValue != null && tpsIntervalValue > 0 ? tpsIntervalValue : refreshValues.tpsIntervalSeconds;

    // 构建配置对象（不使用 fullCommand）
    const configPayload = {
        javaPath,
        minMemory,
        maxMemory,
        jarPath,
        additionalArgs,
        fullCommand: '',          // 清空完整命令，让服务端使用分解字段
        workingDir,
        backupDir,
        autoBackupEnabled,
        autoBackupCron,
        backupRetentionCount,
        backupRetentionDays,
        autoRestart,
        autoRestartDelaySeconds,
        autoRestartMaxRetries,
        playerListIntervalSeconds,
        statsIntervalSeconds,
        tpsIntervalSeconds
    };

    try {
        const response = await fetch(mcApi('/config'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(configPayload),
        });
        const data = await response.json();
        if (data.success) {
            showToast('MC 配置已保存', 'success');
            // 重新加载配置以同步
            await loadMcConfig();
            updateMcAutoRestartDisplay(autoRestart);
        } else {
            showToast(data.error || data.message || '保存 MC 配置失败', 'error');
        }
    } catch (error) {
        console.error('保存 MC 配置失败:', error);
        showToast('保存 MC 配置失败', 'error');
    }
}

async function loadMcStatus() {
  try {
    await ensureMcServerSelected();
    updateMcSelectedServerLabel();
    const response = await fetch(mcApi('/status'));
    const data = await response.json();
    const statusNode = document.getElementById('mcStatus');
    const pidNode = document.getElementById('mcPid');
    if (data.running) {
      const recovered = data.recovered === true;
      statusNode.textContent = recovered ? '运行中（只读）' : '运行中';
      pidNode.textContent = data.pid || '-';
    } else {
      statusNode.textContent = '未运行';
      pidNode.textContent = '-';
    }
  } catch (error) {
    console.error('加载 MC 状态失败:', error);
    document.getElementById('mcStatus').textContent = '未知';
    document.getElementById('mcPid').textContent = '-';
  }
}

async function syncMcStatus() {
  try {
    await ensureMcServerSelected();
    const resp = await fetch(mcApi('/sync'), { method: 'POST' });
    const data = await resp.json();
    if (data.success) {
      showToast(data.message || '已同步服务器状态', 'success');
      await loadMcStatus();
      // reload logs and players to reflect possible recovered state
      loadMcLogs();
      loadMcPlayers();
    } else {
      showToast(data.message || data.error || '未找到运行中的 MC 进程', 'warning');
      await loadMcStatus();
    }
  } catch (e) {
    console.error('同步失败', e);
    showToast('同步失败', 'error');
  }
}

// Attach sync button if present in DOM
const mcSyncBtn = document.getElementById('mcSyncBtn');
if (mcSyncBtn) {
  mcSyncBtn.addEventListener('click', (e) => {
    e.preventDefault();
    syncMcStatus();
  });
}

async function loadMcLogs() {
  try {
    await ensureMcServerSelected();
    const response = await fetch(mcApi('/logs'));
    const data = await response.json();
    if (!data.success) {
      showToast(data.message || '获取 MC 日志失败', 'error');
      return;
    }
    mcLogLines = [];
    if (Array.isArray(data.logs)) {
      data.logs.slice(-1000).forEach((item) => {
        const text = String(item || '');
        const level = classifyMcLogLevel(text);
        if (['info', 'warn', 'error'].includes(level)) {
          mcLogLines.push({ text, level });
        }
      });
    }
    renderMcConsole();
  } catch (error) {
    console.error('获取 MC 日志失败:', error);
  }
}

function updateMcAutoRestartDisplay(enabled) {
  const node = document.getElementById('mcAutoRestart');
  if (node) {
    node.textContent = enabled ? '已启用' : '已禁用';
  }
}

async function loadMcPlayers() {
  try {
    await ensureMcServerSelected();
    const response = await fetch(mcApi('/players'));
    const data = await response.json();
    if (data.success) {
      renderPlayerList(data.players || [], data.count || 0, data.max || 0);
      window.mcPlayersLastUpdate = Date.now();
    }
  } catch (error) {
    console.error('加载 MC 玩家列表失败:', error);
  }
}

async function startMinecraftServer() {
  try {
    await ensureMcServerSelected();
    const response = await fetch(mcApi('/start'), { method: 'POST' });
    const data = await response.json();
    if (data.success) {
      showToast('Minecraft 服务器启动中', 'success');
      await loadMcStatus();
      loadMcLogs();
      loadMcPlayers();
    } else {
      showToast('启动失败', 'error');
    }
  } catch (error) {
    console.error('启动 MC 失败:', error);
    showToast('启动失败', 'error');
  }
}

async function stopMinecraftServer() {
  try {
    await ensureMcServerSelected();
    // 检查当前状态，若为恢复（只读）态，则提示用户选择强制终止
    const st = await fetch(mcApi('/status'));
    const stData = await st.json();
    if (stData.running && stData.recovered) {
      const msg = '检测到服务器为恢复（只读）状态，无法通过控制台发送 stop。是否执行强制终止（kill）？';
      if (typeof showConfirmModal === 'function') {
        showConfirmModal('强制终止', msg, async () => {
          const resp = await fetch(mcApi('/kill'), { method: 'POST' });
          const data = await resp.json();
          if (data.success) showToast('已强制终止 MC 服务器', 'success');
          else showToast('强制终止失败', 'error');
          await loadMcStatus();
        });
      } else if (window.confirm(msg)) {
        const resp = await fetch(mcApi('/kill'), { method: 'POST' });
        const data = await resp.json();
        if (data.success) showToast('已强制终止 MC 服务器', 'success');
        else showToast('强制终止失败', 'error');
        await loadMcStatus();
      }
      return;
    }

    const response = await fetch(mcApi('/stop'), { method: 'POST' });
    const data = await response.json();
    if (data.success) {
      showToast('已发送停止命令', 'success');
    } else {
      showToast(data.error || '停止失败', 'error');
    }
    await loadMcStatus();
  } catch (error) {
    console.error('停止 MC 失败:', error);
    showToast('停止失败', 'error');
  }
}

async function killMinecraftServer() {
  try {
    await ensureMcServerSelected();
    const response = await fetch(mcApi('/kill'), { method: 'POST' });
    const data = await response.json();
    if (data.success) {
      showToast('已强制终止 MC 服务器', 'success');
    } else {
      showToast('强制终止失败', 'error');
    }
    await loadMcStatus();
  } catch (error) {
    console.error('强制终止 MC 失败:', error);
    showToast('强制终止失败', 'error');
  }
}

async function sendMcCommand(commandInput) {
  const input = document.getElementById('mcCommandInput');
  const command = commandInput || input?.value.trim();
  if (!command) {
    showToast('请输入要发送的命令', 'warning');
    return false;
  }
  try {
    await ensureMcServerSelected();
    // 若服务器处于恢复（只读）态，禁止发送命令
    try {
      const st = await fetch(mcApi('/status'));
      const stData = await st.json();
      if (stData.running && stData.recovered) {
        showToast('当前服务器为恢复（只读）状态，无法发送控制台命令，请使用强制终止或在主机上重启服务器', 'warning');
        return false;
      }
    } catch (e) {
      // ignore status check errors and try to send command
    }
    const response = await fetch(mcApi('/command'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command }),
    });
    const data = await response.json();
    if (data.success) {
      showToast('命令已发送', 'success');
      addToCommandHistory(command);
      if (input && !commandInput) input.value = '';
      loadMcLogs();
      return true;
    } else {
      showToast(data.error || '命令发送失败', 'error');
      return false;
    }
  } catch (error) {
    console.error('发送 MC 命令失败:', error);
    showToast('命令发送失败', 'error');
    return false;
  }
}

const mcCommandInput = document.getElementById('mcCommandInput');
if (mcCommandInput) {
  mcCommandInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      sendMcCommand();
      return;
    }

    if (event.key === 'ArrowUp') {
      if (commandHistory.length === 0) return;
      historyIndex = Math.max(0, historyIndex - 1);
      mcCommandInput.value = commandHistory[historyIndex] || '';
      event.preventDefault();
      return;
    }

    if (event.key === 'ArrowDown') {
      if (commandHistory.length === 0) return;
      historyIndex = Math.min(commandHistory.length, historyIndex + 1);
      mcCommandInput.value = commandHistory[historyIndex] || '';
      event.preventDefault();
    }
  });
}

const mcConsoleFilter = document.getElementById('mcConsoleFilter');
if (mcConsoleFilter) {
  mcConsoleFilter.addEventListener('input', (event) => {
    mcConsoleFilterText = event.target.value || '';
    renderMcConsole();
  });
}

async function loadMcServers() {
  try {
    const res = await fetch('/api/mc/servers');
    const data = await res.json();
    const select = document.getElementById('mcServerSelect');
    if (!select) return;
    if (!data || !Array.isArray(data.servers)) {
      select.innerHTML = '<option value="">(未配置实例)</option>';
      currentMcServerId = null;
      return;
    }
    const previous = currentMcServerId;
    const options = data.servers.map((s) => `<option value="${s.id}">${s.display_name || s.name || s.id}</option>`).join('');
    select.innerHTML = options;
    if (previous && data.servers.some((s) => String(s.id) === String(previous))) {
      currentMcServerId = previous;
    } else {
      currentMcServerId = data.servers.length ? String(data.servers[0].id) : null;
    }
    select.value = currentMcServerId || '';
    updateMcSelectedServerLabel();
    if (currentMcServerId) {
      switchMcServer();
    }
  } catch (e) {
    console.warn('加载 MC 服务器列表失败', e);
  }
}

function sendMcSubscription(serverId) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn('WebSocket 未连接，延迟订阅 MC 事件');
    return;
  }
  const payload = { type: 'subscribe_mc', serverId: serverId || '*' };
  try { ws.send(JSON.stringify(payload)); } catch (e) { console.warn('订阅 MC 事件失败', e); }
}

function disconnectMcSubscription(serverId) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn('WebSocket 未连接，无法取消订阅 MC 事件');
    return;
  }
  const payload = { type: 'unsubscribe_mc', serverId: serverId || '*' };
  try { ws.send(JSON.stringify(payload)); } catch (e) { console.warn('取消订阅 MC 事件失败', e); }
}

function switchMcServer() {
  const sel = document.getElementById('mcServerSelect');
  if (!sel) return;
  const newId = sel.value || null;
  if (newId === currentMcServerId) return;
  if (currentMcServerId) {
    disconnectMcSubscription(currentMcServerId);
  }
  currentMcServerId = newId;
  updateMcSelectedServerLabel();
  if (!currentMcServerId) {
    return;
  }
  loadMcStatus();
  loadMcLogs();
  loadMcPlayers();
  loadMcConfig();
  sendMcSubscription(currentMcServerId);
}

async function createMcServer() {
  const name = window.prompt('请输入新 MC 服务器实例名称:');
  if (!name) return;
  try {
    const response = await fetch('/api/mc/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, config: { fullCommand: '', workingDir: '', backupDir: 'backups', autoRestart: false, autoRestartDelaySeconds: 5, autoRestartMaxRetries: 3, autoBackupEnabled: false, autoBackupCron: '', backupRetentionCount: 7, backupRetentionDays: 30, playerListIntervalSeconds: 5, statsIntervalSeconds: 15, tpsIntervalSeconds: 5 } })
    });
    const result = await response.json();
    if (result.success) {
      showToast?.('MC 实例已创建', 'success');
      await loadMcServers();
    } else {
      showToast?.(result.error || '创建实例失败', 'error');
    }
  } catch (e) {
    console.error('创建 MC 实例失败', e);
    showToast?.('创建实例失败', 'error');
  }
}

async function deleteMcServer(id) {
  try {
    const response = await fetch(`/api/mc/servers/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const result = await response.json();
    if (result.success) {
      showToast?.('MC 实例已删除', 'success');
      currentMcServerId = null;
      await loadMcServers();
    } else {
      showToast?.(result.error || '删除实例失败', 'error');
    }
  } catch (e) {
    console.error('删除 MC 实例失败', e);
    showToast?.('删除实例失败', 'error');
  }
}

function confirmDeleteMcServer() {
  const sel = document.getElementById('mcServerSelect');
  if (!sel || !sel.value) {
    showToast?.('请选择要删除的实例', 'warning');
    return;
  }
  const msg = `确认删除 MC 实例 ${sel.options[sel.selectedIndex]?.text || sel.value} 吗？此操作不可撤销。`;
  if (window.confirm(msg)) {
    deleteMcServer(sel.value);
  }
}

loadCommandHistory();
loadMcServers();

// 初始化过滤器输入值（如果 DOM 已经存在）
try {
  const f = document.getElementById('mcConsoleFilter');
  if (f) {
    f.value = mcConsoleFilterText || '';
  }
} catch (e) {
  // ignore
}

// 监听分解字段输入，实时更新命令预览
document.addEventListener('DOMContentLoaded', () => {
    const previewFields = ['mcJavaPath', 'mcMinMemory', 'mcMaxMemory', 'mcJarPath', 'mcAdditionalArgs'];
    previewFields.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', updateCommandPreview);
    });
    // 若页面已加载但尚未触发（例如通过动态切换页面），手动调用一次
    updateCommandPreview();
});