const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const { spawn } = require('child_process');
const iconv = require('iconv-lite');
const jschardet = require('jschardet');
const pidusage = require('pidusage');
const pLimit = require('p-limit');
const childProcessLimit = pLimit(5);

const PIDUSAGE_CONCURRENCY = Number(process.env.PIDUSAGE_CONCURRENCY) || 3;
const pidusageLimit = pLimit(PIDUSAGE_CONCURRENCY);

// 阈值：CPU% 与 内存变动小于阈值将不会触发更新，减少网络与处理开销
const MC_STATS_CPU_THRESHOLD = Number(process.env.MC_STATS_CPU_THRESHOLD) || 0.5; // 百分比
const MC_STATS_MEM_THRESHOLD = Number(process.env.MC_STATS_MEM_THRESHOLD) || 1024 * 1024; // 字节

let archiver = null;
let extractZip = null;
let psList = null;
try {
  archiver = require('archiver');
} catch (e) {
  archiver = null;
}
try {
  extractZip = require('extract-zip');
} catch (e) {
  extractZip = null;
}
try {
  psList = require('ps-list');
} catch (e) {
  psList = null;
}


const LOG_MAX_LINES = 2000;
const PLAYER_COUNT_REGEX = /There are\s+(\d+)\s+of\s+a\s+max\s+of\s+(\d+)\s+players\s+online/i;
const PLAYER_LIST_REGEX = /^(?:\[.*?\]\s*)?\[?\s*([^\]]*?)\s*\]?$/;
const TPS_REGEX = /TPS\s+from\s+last\s+.*?:\s*([\d.]+)/i;

class McServer {
  constructor(id, config = {}, baseDir = process.cwd(), eventCallback = null) {
    this.id = String(id || 'default');
    this.baseDir = baseDir;
    this.eventCallback = typeof eventCallback === 'function' ? eventCallback : null;
    this.config = Object.assign({
      name: this.id,
      display_name: this.id,
      fullCommand: '',
      workingDir: baseDir,
      javaPath: 'java',
      jarPath: 'server.jar',
      minMemory: '1024M',
      maxMemory: '4096M',
      additionalArgs: '',
      backupDir: 'backups',
      autoBackupEnabled: false,
      autoBackupCron: '',
      backupRetentionCount: 7,
      backupRetentionDays: 30,
      autoRestart: false,
      autoRestartDelaySeconds: 5,
      autoRestartMaxRetries: 3,
      playerListIntervalSeconds: 5,
      tpsIntervalSeconds: 5,
      statsIntervalSeconds: 15
    }, config || {});

    this.logs = [];
    this.process = null;
    this.playerInfo = { players: [], count: 0, max: 0 };
    this.latestTps = null;
    this.latestCpu = 0;
    this.latestMemory = { used: 0, total: os.totalmem() };
    this.manualStopRequested = false;
    this.restartAttempts = 0;
    this.playerListTimer = null;
    this.statsTimer = null;
    this.tpsTimer = null;
    this.lastCpuTime = null;
    this.lastCpuTimestamp = null;
    this.lastCpuPid = null;
    this._statsPending = false;
    this._lastStatsEmitTime = 0;
    this.autoBackupTimer = null;
    this.lastAutoBackupKey = null;
    this.backupInProgress = false;
    this.restartResetTimer = null;
    this.saveAllWaiters = [];
    this._lastPlayerRefreshAt = 0;
    this._processDiscoveryCache = null;
    this._processDiscoveryCacheExpiresAt = 0;
    this.logDir = path.join(this.baseDir, 'logs', 'mc', this.id);
    this.logFile = path.join(this.logDir, 'latest.log');
    this.logBuffer = [];
    this.logFlushTimer = null;
    this._startLogFlusher();

    try {
      this.ensureLogDir();
    } catch (e) {
      console.warn(`无法创建 MC 日志目录 ${this.logDir}: ${e.message}`);
    }
    this.configureAutoTasks();
    this.checkCompressionTools().catch(() => {});
  }

  emit(event, payload = {}) {
    if (!this.eventCallback) return;
    try {
      this.eventCallback(event, this.id, payload);
    } catch (e) {
      // ignore callback errors
    }
  }

  getDefaultPollingConfig() {
    return {
      playerListIntervalSeconds: 5,
      tpsIntervalSeconds: 5,
      statsIntervalSeconds: 15
    };
  }

  normalizePollingConfig(config = {}) {
    const defaults = this.getDefaultPollingConfig();
    const values = {};
    values.playerListIntervalSeconds = Number(config.playerListIntervalSeconds ?? config.playerList ?? defaults.playerListIntervalSeconds);
    values.tpsIntervalSeconds = Number(config.tpsIntervalSeconds ?? config.tps ?? defaults.tpsIntervalSeconds);
    values.statsIntervalSeconds = Number(config.statsIntervalSeconds ?? config.stats ?? defaults.statsIntervalSeconds);

    const toValidSeconds = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback);
    return {
      playerListIntervalSeconds: toValidSeconds(values.playerListIntervalSeconds, defaults.playerListIntervalSeconds),
      tpsIntervalSeconds: toValidSeconds(values.tpsIntervalSeconds, defaults.tpsIntervalSeconds),
      statsIntervalSeconds: toValidSeconds(values.statsIntervalSeconds, defaults.statsIntervalSeconds)
    };
  }

  getRefreshPresetMap() {
    return {
      fast: { playerListIntervalSeconds: 1, statsIntervalSeconds: 5, tpsIntervalSeconds: 1 },
      standard: { playerListIntervalSeconds: 5, statsIntervalSeconds: 15, tpsIntervalSeconds: 5 },
      slow: { playerListIntervalSeconds: 15, statsIntervalSeconds: 30, tpsIntervalSeconds: 15 }
    };
  }

  getRefreshPresetValues(preset = 'standard') {
    const presets = this.getRefreshPresetMap();
    return presets[preset] || presets.standard;
  }

  getRefreshPresetFromConfig(cfg = {}) {
    const playerList = Number(cfg.playerListIntervalSeconds ?? cfg.playerList ?? 0);
    const stats = Number(cfg.statsIntervalSeconds ?? cfg.stats ?? 0);
    const tps = Number(cfg.tpsIntervalSeconds ?? cfg.tps ?? 0);
    const values = this.getRefreshPresetValues('fast');
    if (playerList === values.playerListIntervalSeconds && stats === values.statsIntervalSeconds && tps === values.tpsIntervalSeconds) return 'fast';
    const standard = this.getRefreshPresetValues('standard');
    if (playerList === standard.playerListIntervalSeconds && stats === standard.statsIntervalSeconds && tps === standard.tpsIntervalSeconds) return 'standard';
    const slow = this.getRefreshPresetValues('slow');
    if (playerList === slow.playerListIntervalSeconds && stats === slow.statsIntervalSeconds && tps === slow.tpsIntervalSeconds) return 'slow';
    return 'custom';
  }

  setConfig(config = {}) {
    const newConfig = Object.assign({}, this.config, config);
    newConfig.autoBackupEnabled = newConfig.autoBackupEnabled === true || String(newConfig.autoBackupEnabled) === 'true' || String(newConfig.autoBackupEnabled) === '1';
    newConfig.autoRestart = newConfig.autoRestart === true || String(newConfig.autoRestart) === 'true' || String(newConfig.autoRestart) === '1';
    newConfig.autoRestartDelaySeconds = Number(newConfig.autoRestartDelaySeconds) || 0;
    newConfig.autoRestartMaxRetries = Number(newConfig.autoRestartMaxRetries) || 0;
    const pollingConfig = this.normalizePollingConfig(newConfig);
    newConfig.playerListIntervalSeconds = pollingConfig.playerListIntervalSeconds;
    newConfig.tpsIntervalSeconds = pollingConfig.tpsIntervalSeconds;
    newConfig.statsIntervalSeconds = pollingConfig.statsIntervalSeconds;
    newConfig.backupRetentionCount = Number(newConfig.backupRetentionCount) || 0;
    newConfig.backupRetentionDays = Number(newConfig.backupRetentionDays) || 0;

    if (newConfig.autoBackupEnabled && String(newConfig.autoBackupCron || '').trim() && !this.isCronExpressionValid(String(newConfig.autoBackupCron))) {
      throw new Error('autoBackupCron 格式无效');
    }

    if (config.name !== undefined) newConfig.name = config.name;
    if (config.display_name !== undefined) newConfig.display_name = config.display_name;
    if (config.backupDir !== undefined) newConfig.backupDir = config.backupDir;

    const oldPlayerListInterval = Number(this.config.playerListIntervalSeconds) || 0;
    const oldTpsInterval = Number(this.config.tpsIntervalSeconds) || 0;
    const oldStatsInterval = Number(this.config.statsIntervalSeconds) || 0;
    this.config = newConfig;
    this.configureAutoTasks();
    const newPlayerListInterval = Number(this.config.playerListIntervalSeconds) || 0;
    const newTpsInterval = Number(this.config.tpsIntervalSeconds) || 0;
    const newStatsInterval = Number(this.config.statsIntervalSeconds) || 0;
    if (this.process && !this.process.recovered) {
      if (oldPlayerListInterval !== newPlayerListInterval) {
        this.stopPlayerListPolling();
      }
      if (oldTpsInterval !== newTpsInterval) {
        this.stopTpsPolling();
        this.startTpsPolling();
      }
      if (oldStatsInterval !== newStatsInterval) {
        this.stopStatsPolling();
        this.startStatsPolling();
      }
    }
    return this.config;
  }

  configureAutoTasks() {
    this.stopAutoBackup();
    if (!this.config.autoBackupEnabled || !String(this.config.autoBackupCron || '').trim()) {
      return;
    }
    if (!this.isCronExpressionValid(String(this.config.autoBackupCron))) {
      this.pushLog(`自动备份 Cron 表达式无效：${String(this.config.autoBackupCron)}`);
      return;
    }
    this.autoBackupTimer = setInterval(async () => {
      if (!this.config.autoBackupEnabled || !this.config.autoBackupCron) return;
      const now = new Date();
      if (!this.isCronScheduleDue(this.config.autoBackupCron, now)) return;
      const key = this.getAutoBackupKey(now);
      if (key === this.lastAutoBackupKey) return;
      this.lastAutoBackupKey = key;
      await this.runScheduledBackup();
    }, 30 * 1000);
  }

  parseCronField(field, value, min, max) {
    if (field === '*') return true;
    if (field.includes(',')) {
      return field.split(',').some((part) => this.parseCronField(part.trim(), value, min, max));
    }
    if (field.indexOf('/') > -1) {
      const [base, step] = field.split('/');
      const interval = parseInt(step, 10);
      if (Number.isNaN(interval) || interval <= 0) return false;
      if (base === '*') {
        return (value - min) % interval === 0;
      }
      return false;
    }
    if (field.indexOf('-') > -1) {
      const [start, end] = field.split('-').map((v) => parseInt(v, 10));
      if (Number.isNaN(start) || Number.isNaN(end)) return false;
      return value >= start && value <= end;
    }
    const expected = parseInt(field, 10);
    return !Number.isNaN(expected) && value === expected;
  }

  isCronScheduleDue(cronExpression, now) {
    const parts = String(cronExpression || '').trim().split(/\s+/);
    if (parts.length !== 5) return false;
    const [minuteExpr, hourExpr, dayExpr, monthExpr, dowExpr] = parts;
    return this.parseCronField(minuteExpr, now.getMinutes(), 0, 59)
      && this.parseCronField(hourExpr, now.getHours(), 0, 23)
      && this.parseCronField(dayExpr, now.getDate(), 1, 31)
      && this.parseCronField(monthExpr, now.getMonth() + 1, 1, 12)
      && this.parseCronField(dowExpr, now.getDay(), 0, 6);
  }

  getAutoBackupKey(now) {
    return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
  }

  stopAutoBackup() {
    if (this.autoBackupTimer) {
      clearInterval(this.autoBackupTimer);
      this.autoBackupTimer = null;
    }
  }

  async runScheduledBackup() {
    if (this.backupInProgress) return;
    this.backupInProgress = true;
    try {
      const fileName = await this.createBackup();
      this.pushLog(`自动备份完成: ${fileName}`);
    } catch (e) {
      this.pushLog(`自动备份失败: ${e.message}`);
    } finally {
      this.backupInProgress = false;
    }
  }

  startPlayerListPolling() {
    this.stopPlayerListPolling();
    // 玩家列表改为按需刷新，不再做周期性轮询，避免不必要的命令发送和 CPU 开销。
    return false;
  }

  stopPlayerListPolling() {
    if (this.playerListTimer) {
      clearInterval(this.playerListTimer);
      this.playerListTimer = null;
    }
  }

  requestPlayerListRefresh(reason = 'manual') {
    if (!this.process || this.process.recovered || !this.process.stdin || this.process.stdin.destroyed) return false;
    const now = Date.now();
    if (now - this._lastPlayerRefreshAt < 4000) {
      return true;
    }
    this._lastPlayerRefreshAt = now;
    const ok = this.sendCommand('list', true);
    if (ok && this.emit) {
      this.emit('mc_player_refresh_requested', { reason });
    }
    return ok;
  }

  startTpsPolling() {
    this.stopTpsPolling();
    const intervalSeconds = Number(this.config.tpsIntervalSeconds) || 0;
    if (!intervalSeconds || !this.process || this.process.recovered || !this.process.stdin || this.process.stdin.destroyed) return;
    this.tpsTimer = setInterval(() => {
      if (this.process && !this.process.recovered && this.process.stdin && !this.process.stdin.destroyed) {
        this.sendCommand('tps', true);
      }
    }, intervalSeconds * 1000);
  }

  stopTpsPolling() {
    if (this.tpsTimer) {
      clearInterval(this.tpsTimer);
      this.tpsTimer = null;
    }
  }

  scheduleAutoRestart() {
    if (!this.config.autoRestart || this.manualStopRequested) return;
    const maxRetries = Number(this.config.autoRestartMaxRetries) || 0;
    if (this.restartAttempts >= maxRetries) {
      this.pushLog('已达到最大自动重启次数，不再继续重启');
      return;
    }
    const delay = Math.max(1, Number(this.config.autoRestartDelaySeconds) || 5);
    const backoff = Math.min(delay * Math.pow(2, this.restartAttempts), 60);
    this.restartAttempts += 1;
    this.pushLog(`将在 ${backoff} 秒后自动重启（${this.restartAttempts}/${maxRetries}）`);
    this.autoRestartTimer = setTimeout(() => {
      this.autoRestartTimer = null;
      if (!this.process) {
        this.start(false);
      }
    }, backoff * 1000);
  }

  stopAutoRestart() {
    if (this.autoRestartTimer) {
      clearTimeout(this.autoRestartTimer);
      this.autoRestartTimer = null;
    }
  }

  waitForProcessClose(timeoutMs = 15000) {
    if (!this.process) return Promise.resolve();
    return new Promise((resolve) => {
      const processRef = this.process;
      const onClose = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        processRef.removeListener('close', onClose);
        resolve();
      }, timeoutMs);
      processRef.once('close', onClose);
    });
  }

  getLaunchCommand() {
    const cmd = String(this.config.fullCommand || '').trim();
    if (cmd) return cmd;
    const javaPath = String(this.config.javaPath || 'java').trim();
    const jarPath = String(this.config.jarPath || 'server.jar').trim();
    const minMemory = String(this.config.minMemory || '1024M').trim();
    const maxMemory = String(this.config.maxMemory || '4096M').trim();
    const args = String(this.config.additionalArgs || '').trim();
    if (!jarPath) return '';
    return `${javaPath} -Xms${minMemory} -Xmx${maxMemory}${args ? ` ${args}` : ''} -jar ${jarPath} nogui`.trim();
  }

  getLaunchArgs() {
    const cmd = String(this.config.fullCommand || '').trim();
    if (cmd) {
      return this.ensureJlineTerminalArg(this.parseCommandString(cmd));
    }
    const javaPath = String(this.config.javaPath || 'java').trim();
    const jarPath = String(this.config.jarPath || 'server.jar').trim();
    const minMemory = String(this.config.minMemory || '1024M').trim();
    const maxMemory = String(this.config.maxMemory || '4096M').trim();
    const args = String(this.config.additionalArgs || '').trim();
    const result = [javaPath, `-Xms${minMemory}`, `-Xmx${maxMemory}`];
    if (args) {
      result.push(...this.parseCommandString(args));
    }
    result.push('-jar', jarPath, 'nogui');
    return this.ensureJlineTerminalArg(result);
  }

  ensureJlineTerminalArg(args) {
    const normalizedArgs = Array.isArray(args) ? args.slice() : [];
    if (normalizedArgs.some((arg) => String(arg).includes('-Djline.terminal='))) {
      return normalizedArgs;
    }
    const jarIndex = normalizedArgs.findIndex((arg) => arg === '-jar');
    const javaIndex = normalizedArgs.findIndex((arg) => {
      if (!arg || typeof arg !== 'string') return false;
      return /(^|[\\/])java(?:\.exe)?$/i.test(arg) || arg.toLowerCase() === 'java';
    });
    const insertAt = jarIndex > 0 ? jarIndex : (javaIndex >= 0 ? javaIndex + 1 : 1);
    normalizedArgs.splice(insertAt, 0, '-Djline.terminal=jline.UnsupportedTerminal');
    return normalizedArgs;
  }

  parseCommandString(command) {
    const args = [];
    let current = '';
    let quote = null;
    for (let i = 0; i < command.length; i += 1) {
      const ch = command[i];
      if (quote) {
        if (ch === quote) {
          quote = null;
          continue;
        }
        current += ch;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (/\s/.test(ch)) {
        if (current) {
          args.push(current);
          current = '';
        }
        continue;
      }
      current += ch;
    }
    if (current) args.push(current);
    return args;
  }

  isCronExpressionValid(expression) {
    const parts = String(expression || '').trim().split(/\s+/);
    if (parts.length !== 5) return false;
    return [
      this.parseCronField(parts[0], new Date().getMinutes(), 0, 59),
      this.parseCronField(parts[1], new Date().getHours(), 0, 23),
      this.parseCronField(parts[2], new Date().getDate(), 1, 31),
      this.parseCronField(parts[3], new Date().getMonth() + 1, 1, 12),
      this.parseCronField(parts[4], new Date().getDay(), 0, 6)
    ].every(Boolean);
  }

  resetRestartAttemptsAfterStableRun() {
    if (this.restartResetTimer) {
      clearTimeout(this.restartResetTimer);
      this.restartResetTimer = null;
    }
    if (this.restartAttempts <= 0) return;
    this.restartResetTimer = setTimeout(() => {
      this.restartAttempts = 0;
      this.restartResetTimer = null;
      this.pushLog('自动重启计数器已重置');
    }, 10 * 60 * 1000);
  }

  clearRestartResetTimer() {
    if (this.restartResetTimer) {
      clearTimeout(this.restartResetTimer);
      this.restartResetTimer = null;
    }
  }

  waitForSaveAllConfirmation(timeoutMs = 15000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const index = this.saveAllWaiters.indexOf(resolve);
        if (index !== -1) this.saveAllWaiters.splice(index, 1);
        resolve(false);
      }, timeoutMs);
      const wrappedResolve = (result) => {
        clearTimeout(timer);
        resolve(result);
      };
      this.saveAllWaiters.push(wrappedResolve);
    });
  }

  resolveWorkingDir() {
    return path.isAbsolute(this.config.workingDir || '') ? this.config.workingDir : path.join(this.baseDir, String(this.config.workingDir || ''));
  }

  resolveBackupDir() {
    const backupDir = this.config.backupDir || 'backups';
    return path.isAbsolute(backupDir) ? backupDir : path.join(this.baseDir, backupDir);
  }

  ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  ensureLogDir() {
    this.ensureDir(this.logDir);
  }

  decodeProcessOutput(data) {
    if (typeof data === 'string') return data;
    if (!Buffer.isBuffer(data)) return String(data || '');

    const utf8 = data.toString('utf8');
    if (!utf8.includes('�')) return utf8;

    const detection = jschardet.detect(data);
    const encoding = detection && detection.encoding ? String(detection.encoding).toLowerCase() : null;
    if (encoding && encoding !== 'ascii') {
      try {
        if (encoding.includes('gb') || encoding.includes('cp936')) {
          return iconv.decode(data, 'gb18030');
        }
        return iconv.decode(data, encoding);
      } catch (e) {
        // fall through to fallback below
      }
    }

    try {
      return iconv.decode(data, 'gb18030');
    } catch (e) {
      return utf8;
    }
  }

  pushLog(line) {
    const raw = String(line || '');
    const normalized = raw.replace(/\r?\n$/, '');
    if (!normalized) return;

    // 过滤 TPS 自动轮询行（不记录日志，只解析数值）
    const cleanForFilter = normalized.replace(/\u001b\[[0-9;]*m/g, '');
    if (cleanForFilter.includes('TPS from last')) {
      this.updateTpsFromLine(normalized);
      return;
    }

    const parts = normalized.split(/\r?\n/);
    for (const part of parts) {
      const trimmed = String(part || '').trim();
      if (!trimmed) continue;
      const formatted = `${new Date().toISOString()} ${trimmed}`;

      // 写入内存缓冲区（而非直接写文件）
      this.logBuffer.push(formatted + os.EOL);
      if (this.logBuffer.length >= 50) {
        this.flushLogBuffer(); // 达到 50 行立即刷新
      }

      // 保留内存日志（最多 2000 行）
      this.logs.push(formatted);
      while (this.logs.length > LOG_MAX_LINES) this.logs.shift();

      // 解析玩家/TPS 信息（非阻塞）
      this.updatePlayerInfoFromLine(trimmed);
      this.updateTpsFromLine(trimmed);

      // 处理 save-all 等待回调
      if (this.saveAllWaiters.length && /Saved (?:the game|world|server state)/i.test(trimmed)) {
        this.saveAllWaiters.splice(0, this.saveAllWaiters.length).forEach((resolve) => resolve(true));
      }

      // WebSocket 发送（保持单条，但可增加节流，此处先保留）
      this.emit('mc_log', { line: trimmed, level: this.classifyLogLevel(trimmed) });
    }
  }

  _startLogFlusher() {
    if (this.logFlushTimer) clearInterval(this.logFlushTimer);
    this.logFlushTimer = setInterval(() => {
      this.flushLogBuffer();
    }, 2000);
  }

  flushLogBuffer() {
    if (this.logBuffer.length === 0) return;
    const chunk = this.logBuffer.join('');
    this.logBuffer = [];
    fs.promises.appendFile(this.logFile, chunk).catch(() => {});
  }


  getLogs(limit = 200) {
    return this.logs.slice(-limit);
  }

  classifyLogLevel(text) {
    const upper = String(text || '').toUpperCase();
    if (upper.includes('[SEVERE]') || upper.includes('[ERROR]') || upper.includes('[STDERR]')) return 'error';
    if (upper.includes('[WARN]') || upper.includes('[WARNING]') || upper.includes(' WARN ')) return 'warn';
    if (upper.includes('[INFO]')) return 'info';
    return 'info';
  }

  updatePlayerInfoFromLine(line) {
    const parsed = this.parsePlayerListLine(line);
    if (parsed) {
      this.playerInfo.count = parsed.count;
      this.playerInfo.max = parsed.max;
      this.playerInfo.players = parsed.players;
      this.emit('mc_players', {
        players: this.playerInfo.players,
        count: this.playerInfo.count,
        max: this.playerInfo.max
      });
      return;
    }

    // 原有的旧逻辑作为回退，兼容极少数特殊格式
    const countMatch = line.match(PLAYER_COUNT_REGEX);
    if (countMatch) {
      this.playerInfo.count = parseInt(countMatch[1], 10) || 0;
      this.playerInfo.max = parseInt(countMatch[2], 10) || 0;
      this.emit('mc_players', {
        players: this.playerInfo.players,
        count: this.playerInfo.count,
        max: this.playerInfo.max
      });
      return;
    }

    if (line.trim().startsWith('[')) {
      const listMatch = line.match(PLAYER_LIST_REGEX);
      if (listMatch) {
        const raw = listMatch[1].trim();
        if (raw === '' || raw === '[]') {
          this.playerInfo.players = [];
        } else {
          const players = raw.replace(/^\[|\]$/g, '').split(/,\s*/).map((name) => name.replace(/^"|"$/g, '').trim()).filter(Boolean);
          this.playerInfo.players = players;
        }
        this.emit('mc_players', {
          players: this.playerInfo.players,
          count: this.playerInfo.players.length,
          max: this.playerInfo.max
        });
      }
    }
  }

  updateTpsFromLine(line) {
    const cleanLine = String(line || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    const patterns = [
      /TPS from last 1m, 5m, 15m:\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/i,
      /TPS from last 1m:\s*([\d.]+)/i,
      /TPS:\s*([\d.]+)/i,
      /TPS\s+from\s+last\s+.*?:\s*([\d.]+)/i
    ];

    let tps = null;
    for (const pattern of patterns) {
      const match = cleanLine.match(pattern);
      if (match) {
        tps = parseFloat(match[1]);
        if (!Number.isNaN(tps)) break;
      }
    }

    if (tps !== null && !Number.isNaN(tps)) {
      this.latestTps = tps;
      this.emit('mc_stats', { cpu: this.latestCpu, memory: this.latestMemory, tps: tps });
    }
  }

  async getMcProcessStats(pid) {
    if (!pid) return null;
    if (process.platform === 'win32') {
      return this.getWindowsProcessStats(pid);
    }
    return this.getUnixProcessStats(pid);
  }

  async getWindowsProcessStats(pid) {
    if (!pid) return null;
    if (this._statsPending) return null;
    this._statsPending = true;
    try {
      // 直接使用 pidusage
      const stats = await pidusageLimit(() => pidusage(pid));
      return {
        cpu: Math.min(100, Math.max(0, stats.cpu)),
        memory: { used: stats.memory, total: os.totalmem() }
      };
    } catch (err) {
      // 备选：如果 pidusage 失败（如进程退出），尝试 ps-list
      if (psList) {
        try {
          const procs = await psList();
          const proc = procs.find((entry) => Number(entry.pid) === Number(pid));
          if (proc) {
            return {
              cpu: Math.min(100, Math.max(0, Number(proc.cpu) || 0)),
              memory: { used: Number(proc.memory) || 0, total: os.totalmem() }
            };
          }
        } catch (e) { /* ignore */ }
      }
      this.pushLog(`获取进程 ${pid} 统计失败: ${err.message}`);
      return null;
    } finally {
      this._statsPending = false;
    }
  }

  parseCpuTime(timeString) {
    const parts = String(timeString || '').trim().split(':').map((v) => parseInt(v, 10));
    if (parts.some((n) => Number.isNaN(n))) return 0;
    if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }
    return parts[0] || 0;
  }

  async getUnixProcessStats(pid) {
    if (!pid) return null;
    if (this._statsPending) return null;
    this._statsPending = true;
    try {
      const stats = await pidusageLimit(() => pidusage(pid));
      return {
        cpu: Math.min(100, Math.max(0, stats.cpu)),
        memory: { used: stats.memory, total: os.totalmem() }
      };
    } catch (err) {
      this.pushLog(`获取进程 ${pid} 统计失败: ${err.message}`);
      return null;
    } finally {
      this._statsPending = false;
    }
  }

  startStatsPolling() {
    this.stopStatsPolling();
    if (!this.process || !this.process.pid) return;
    const intervalSeconds = Number(this.config.statsIntervalSeconds) || 0;
    if (!intervalSeconds) return;
    const poll = async () => {
      if (!this.process || !this.process.pid) return;
      const stats = await this.getMcProcessStats(this.process.pid);
      if (stats) {
        const now = Date.now();
        const oldCpu = typeof this.latestCpu === 'number' ? this.latestCpu : 0;
        const oldMemUsed = (this.latestMemory && this.latestMemory.used) || 0;
        const cpuDiff = Math.abs(stats.cpu - oldCpu);
        const memDiff = Math.abs((stats.memory && stats.memory.used ? stats.memory.used : 0) - oldMemUsed);
        const forceEmit = !this._lastStatsEmitTime || (now - this._lastStatsEmitTime) > (intervalSeconds * 1000 * 5);
        if (cpuDiff >= MC_STATS_CPU_THRESHOLD || memDiff >= MC_STATS_MEM_THRESHOLD || forceEmit) {
          this.latestCpu = stats.cpu;
          this.latestMemory = stats.memory;
          this._lastStatsEmitTime = now;
          this.emit('mc_stats', { cpu: this.latestCpu, memory: this.latestMemory, tps: this.latestTps });
        }
      }
    };
    poll(); // 立即执行一次
    this.statsTimer = setInterval(poll, intervalSeconds * 1000);
  }

  stopStatsPolling() {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  async checkCompressionTools() {
    try {
      if (process.platform === 'win32') {
        if (!archiver || !extractZip) {
          this.pushLog('警告：未安装 archiver 或 extract-zip 模块；请运行 `npm install archiver extract-zip`，以避免启用 PowerShell 进行压缩/解压');
        } else {
          this.pushLog('已检测到 archiver 与 extract-zip；将使用 Node 原生库进行压缩/解压');
        }
      } else {
        try {
          await this.runChildProcess('tar', ['--version'], { windowsHide: true });
        } catch (e) {
          this.pushLog('警告：系统未检测到 tar 命令，备份压缩可能失败');
        }
      }
    } catch (e) {
      this.pushLog('警告：无法检测备份压缩工具，备份可能失败');
    }
  }

  start(manual = true) {
    if (this.process) return false;
    const command = this.getLaunchCommand();
    if (!command) {
      this.pushLog('启动命令未配置，无法启动');
      return false;
    }
    const cwd = this.resolveWorkingDir();
    this.ensureLogDir();

    try {
      this.manualStopRequested = false;
      if (manual) this.restartAttempts = 0;
      const launchArgs = this.getLaunchArgs();
      if (launchArgs.length === 0) {
        this.pushLog('启动命令未配置，无法启动');
        return false;
      }
      const program = launchArgs[0];
      const args = launchArgs.slice(1);
      this.process = spawn(program, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const actualPid = this.process.pid;
      this.pushLog(`启动命令: ${program} ${args.join(' ')}，PID: ${actualPid}`);

      if (this.process.stdout) {
        this.process.stdout.on('data', (data) => this.pushLog(this.decodeProcessOutput(data)));
      }
      if (this.process.stderr) {
        this.process.stderr.on('data', (data) => this.pushLog('[STDERR] ' + this.decodeProcessOutput(data)));
      }

      this.process.on('close', (code) => {
        this.pushLog(`进程已退出，退出码: ${code}`);
        this.process = null;
        this.stopPlayerListPolling();
        this.stopStatsPolling();
        this.stopTpsPolling();
        this.clearRestartResetTimer();
        if (!this.manualStopRequested && this.config.autoRestart) {
          this.scheduleAutoRestart();
        }
      });
      this.process.on('error', (err) => {
        this.pushLog(`启动失败: ${err.message}`);
        this.process = null;
        this.clearRestartResetTimer();
      });
      
      this.startStatsPolling();      // 保留性能统计轮询（CPU/内存/TPS）
      this.startTpsPolling();        // 保留 TPS 轮询（但 TPS 输出已被过滤，不会刷日志）
      this.resetRestartAttemptsAfterStableRun();
      return true;
    } catch (e) {
      this.pushLog(`启动异常: ${e.message}`);
      console.error('[mc_server] 启动失败详情:', e);
      this.process = null;
      this.clearRestartResetTimer();
      return false;
    }
  }

  stop() {
    if (!this.process) return false;
    try {
      this.manualStopRequested = true;
      this.stopPlayerListPolling();
      this.stopStatsPolling();
      this.stopTpsPolling();
      this.stopAutoRestart();
      if (this.process.stdin && !this.process.stdin.destroyed) {
        this.process.stdin.write('stop\n');
      }
      this.pushLog('已发送 stop 命令');
      return true;
    } catch (e) {
      this.pushLog(`发送 stop 失败: ${e.message}`);
      return false;
    }
  }

  kill() {
    if (!this.process) return false;
    try {
      this.manualStopRequested = true;
      this.stopPlayerListPolling();
      this.stopStatsPolling();
      this.stopTpsPolling();
      this.stopAutoRestart();
      const pid = this.process.pid;
      if (!pid) return false;
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(pid), '/f', '/t'], { windowsHide: true });
      } else {
        try {
          process.kill(pid, 'SIGTERM');
        } catch (e) {
          spawn('kill', ['-TERM', String(pid)], { windowsHide: true });
        }
      }
      this.pushLog('已强制终止进程');
      this.process = null;
      return true;
    } catch (e) {
      this.pushLog(`强制终止失败: ${e.message}`);
      return false;
    }
  }

  sendCommand(cmd, skipLog = false) {
    if (!cmd || !this.process) return false;
    if (this.process.recovered) {
      this.pushLog(`命令发送失败：进程处于恢复只读模式，无法发送命令: ${cmd}`);
      return false;
    }
    try {
      if (this.process.stdin && !this.process.stdin.destroyed) {
        this.process.stdin.write(cmd + '\n');
        if (!skipLog) {
          this.pushLog('> ' + cmd);
        }
        return true;
      }
      this.pushLog(`命令发送失败：stdin 未就绪，无法发送命令: ${cmd}`);
      return false;
    } catch (e) {
      this.pushLog(`发送命令失败: ${e.message}`);
      return false;
    }
  }

  getStatus() {
    const running = this.process !== null;
    const pid = this.process ? this.process.pid : null;
    const recovered = this.process && this.process.recovered === true;
    return { id: this.id, running, pid, recovered, latestTps: this.latestTps };
  }

  async createBackup() {
    const backupDir = this.resolveBackupDir();
    this.ensureDir(backupDir);
    const cwd = this.resolveWorkingDir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const idPart = (this.config && this.config.name) ? String(this.config.name).replace(/[^a-zA-Z0-9-_]/g, '_') : this.id;
    const filename = process.platform === 'win32' ? `backup-${idPart}-${timestamp}.zip` : `backup-${idPart}-${timestamp}.tar.gz`;
    const dest = path.join(backupDir, filename);
    const worldDirs = ['world', 'world_nether', 'world_the_end']
      .map((dir) => path.join(cwd, dir))
      .filter((dirPath) => fs.existsSync(dirPath));

    if (worldDirs.length === 0) {
      throw new Error('未找到任何 world 目录可备份');
    }

    await this.safeBackupWorlds(worldDirs, dest, cwd);
    this.cleanupOldBackups();
    return filename;
  }

  async listBackups() {
    const backupDir = this.resolveBackupDir();
    if (!fs.existsSync(backupDir)) return [];
    return fs.readdirSync(backupDir)
      .filter((name) => name.endsWith('.zip') || name.endsWith('.tar.gz'))
      .map((name) => {
        const filePath = path.join(backupDir, name);
        const st = fs.statSync(filePath);
        return { name, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  }

  getBackupPath(name) {
    return path.join(this.resolveBackupDir(), path.basename(name));
  }

  async restoreBackup(name) {
    const backupPath = this.getBackupPath(name);
    if (!fs.existsSync(backupPath)) {
      throw new Error('备份文件不存在');
    }
    if (this.process) {
      this.stop();
      await this.waitForProcessClose(15000);
      if (this.process) {
        this.kill();
        await this.waitForProcessClose(5000);
      }
    }
    await this.extractBackupArchive(backupPath, this.resolveWorkingDir());
    this.start();
    return true;
  }

  async createBackupArchive(worldDirs, dest, cwd) {
    const cwdResolved = cwd || this.resolveWorkingDir();
    const destPath = path.isAbsolute(dest) ? dest : path.join(cwdResolved, dest);

    // 强制使用 archiver（无论平台），如果未安装则报错
    if (!archiver) {
      throw new Error('archiver module is required for backups. Run `npm install archiver`');
    }

    // 统一使用 zip 格式（Windows 原生支持，且 archiver 跨平台）
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(destPath);
      const archive = (typeof archiver === 'function') 
        ? archiver('zip', { zlib: { level: 9 } }) 
        : (archiver.create ? archiver.create('zip', { zlib: { level: 9 } }) : null);
      if (!archive) return reject(new Error('archiver module API 不兼容'));

      output.on('close', resolve);
      output.on('error', reject);
      archive.on('warning', (err) => {
        if (err.code === 'ENOENT') this.pushLog(`archiver warning: ${err.message}`);
        else reject(err);
      });
      archive.on('error', reject);
      archive.pipe(output);

      for (const dir of worldDirs) {
        const full = path.isAbsolute(dir) ? dir : path.join(cwdResolved, dir);
        if (fs.existsSync(full)) {
          const st = fs.statSync(full);
          if (st.isDirectory()) archive.directory(full, path.basename(full));
          else archive.file(full, { name: path.basename(full) });
        } else {
          this.pushLog(`备份路径不存在：${full}`);
        }
      }
      archive.finalize();
    });
  }

  async extractBackupArchive(file, cwd) {
    const cwdResolved = cwd || this.resolveWorkingDir();
    const filePath = path.isAbsolute(file) ? file : path.join(cwdResolved, file);

    if (filePath.toLowerCase().endsWith('.zip')) {
      if (!extractZip) {
        throw new Error('extract-zip module is required to extract zip archives on Windows. Run `npm install extract-zip`');
      }
      await extractZip(filePath, { dir: cwdResolved });
      return;
    }

    await this.runChildProcess('tar', ['-xzf', filePath, '-C', cwdResolved], { cwd: cwdResolved });
  }

  async runChildProcess(command, args, options = {}) {
    return childProcessLimit(async () => {
      return new Promise((resolve, reject) => {
        const child = spawn(command, args, { windowsHide: true, ...options });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (data) => { stdout += this.decodeProcessOutput(data); });
        child.stderr.on('data', (data) => { stderr += this.decodeProcessOutput(data); });
        child.on('close', (code) => {
          if (code === 0) {
            resolve(stdout);
            return;
          }
          reject(new Error(stderr || stdout || `退出码 ${code}`));
        });
        child.on('error', (err) => reject(err));
      });
    });
  }
  async safeBackupWorlds(worldDirs, dest, cwd) {
    let saveOffSent = false;
    if (this.process) {
      if (this.process.recovered === true) {
        this.pushLog('检测到恢复的进程；跳过自动备份以避免不一致的世界快照');
        throw new Error('进程处于恢复模式，无法执行安全备份');
      }
      this.pushLog('正在执行 save-off/save-all 同步世界数据，以开始安全备份');
      saveOffSent = this.sendCommand('save-off');
      if (!saveOffSent) {
        this.pushLog('警告: save-off 命令发送失败，备份期间数据可能不一致');
      }
      this.sendCommand('save-all');
      const success = await this.waitForSaveAllConfirmation(15000);
      if (!success) {
        this.pushLog('警告: 未检测到 save-all 完成确认，继续备份可能会导致数据不一致');
      }
    }

    try {
      await this.createBackupArchive(worldDirs, dest, cwd);
    } finally {
      if (saveOffSent && this.process) {
        this.sendCommand('save-on');
        this.pushLog('已恢复自动保存 (save-on)');
      }
    }
  }

  cleanupOldBackups() {
    try {
      const backupDir = this.resolveBackupDir();
      this.ensureDir(backupDir);
      const files = fs.readdirSync(backupDir).filter((name) => /\.(tar\.gz|zip)$/i.test(name));
      let list = files.map((name) => {
        const filePath = path.join(backupDir, name);
        const st = fs.statSync(filePath);
        return { name, path: filePath, mtime: st.mtimeMs };
      }).sort((a, b) => b.mtime - a.mtime);

      const now = Date.now();
      if (Number.isFinite(this.config.backupRetentionDays) && this.config.backupRetentionDays > 0) {
        const cutoff = now - this.config.backupRetentionDays * 24 * 60 * 60 * 1000;
        for (const item of list) {
          if (item.mtime < cutoff) {
            try { fs.unlinkSync(item.path); } catch (e) { }
          }
        }
        // 重新读取列表，避免后续按数量删除时依据过期前的静态列表误删
        const refreshed = fs.readdirSync(backupDir).filter((name) => /\.(tar\.gz|zip)$/i.test(name));
        list = refreshed.map((name) => {
          const filePath = path.join(backupDir, name);
          const st = fs.statSync(filePath);
          return { name, path: filePath, mtime: st.mtimeMs };
        }).sort((a, b) => b.mtime - a.mtime);
      }

      if (Number.isFinite(this.config.backupRetentionCount) && this.config.backupRetentionCount > 0) {
        list.slice(this.config.backupRetentionCount).forEach((item) => {
          try { fs.unlinkSync(item.path); } catch (e) { }
        });
      }
    } catch (e) {
      // ignore cleanup errors
    }
  }

  // 更通用的玩家解析，兼容多种服务端输出格式
  parsePlayerListLine(line) {
    const text = String(line || '').replace(/§[0-9A-FK-OR]/gi, '').trim();
    const patterns = [
      /There are\s+(\d+)\s+of\s+a\s+max\s+of\s+(\d+)\s+players\s+online:?\s*(.*)/i,
      /当前在线\s*(\d+)\s*名?玩家[\s\S]*?最大\s*(\d+)\s*名?在线:?:?\s*(.*)/,
      /There are (\d+)\/([0-9]+) players online:?\s*(.*)/i,
    ];
    for (const rx of patterns) {
      const m = text.match(rx);
      if (m) {
        const count = parseInt(m[1], 10) || 0;
        const max = parseInt(m[2], 10) || 0;
        const players = m[3] ? m[3].replace(/^\[|\]$/g, '').split(/,\s*/).map(p => p.replace(/^"|"$/g, '').trim()).filter(Boolean) : [];
        return { count, max, players };
      }
    }
    return null;
  }

  async discoverExistingProcess() {
    if (this.process) return this.process;
    const now = Date.now();
    if (this._processDiscoveryCache && now < this._processDiscoveryCacheExpiresAt) {
      return this._processDiscoveryCache;
    }

    const jarName = path.basename(String(this.config.jarPath || 'server.jar')).toLowerCase();
    let pid = null;

    try {
      // 优先使用 ps-list 
      if (psList) {
        const procs = await psList();
        for (const p of procs) {
          const name = String(p.name || '').toLowerCase();
          const cmd = String(p.cmd || p.cmdline || p.command || '').toLowerCase();
          if ((name.includes('java') || cmd.includes('java')) && cmd.includes(jarName)) {
            pid = Number(p.pid);
            break;
          }
        }
      } else {
        // 备选：wmic
        try {
          const out = await this.runChildProcess('cmd', ['/c', `wmic process where "Name='java.exe' and CommandLine like '%${jarName}%'" get ProcessId /FORMAT:CSV`], { windowsHide: true });
          const lines = out.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
          for (const line of lines) {
            const m = line.match(/,([0-9]+)$/);
            if (m) { pid = parseInt(m[1], 10); break; }
          }
        } catch (e) { /* ignore */ }
      }
    } catch (e) {
      // ignore
    }

    const discovered = pid && !Number.isNaN(pid) && pid > 0 ? { pid, recovered: true } : null;
    this._processDiscoveryCache = discovered;
    this._processDiscoveryCacheExpiresAt = Date.now() + 30000; // 延长至 30 秒

    if (discovered) {
      this.process = discovered;
      this.stopPlayerListPolling();
      this.stopStatsPolling();
      this.pushLog(`已检测到现有 MC 进程 ${pid}，进入只读恢复模式`);
      return this.process;
    }
    return null;
  }

  async findJavaSubProcess(parentPid, timeoutMs = 8000) {
    const startTime = Date.now();
    this.pushLog(`开始查找父进程 ${parentPid} 下的 Java 子进程...`);
    while (Date.now() - startTime < timeoutMs) {
      try {
        if (psList) {
          const procs = await psList();
          const child = procs.find(p => Number(p.ppid) === Number(parentPid) && (String(p.name || '').toLowerCase().includes('java') || String(p.cmd || p.cmdline || '').toLowerCase().includes('java')));
          if (child) {
            const pid = Number(child.pid);
            this.pushLog(`找到实际 Java 子进程 PID: ${pid} (父进程: ${parentPid})`);
            return pid;
          }
        } else if (process.platform === 'win32') {
          try {
            const out = await this.runChildProcess('cmd', ['/c', `wmic process where "ParentProcessId=${parentPid} and Name='java.exe'" get ProcessId /FORMAT:CSV`], { windowsHide: true });
            const m = out.trim().match(/,([0-9]+)$/m);
            if (m) {
              const pid = parseInt(m[1], 10);
              if (!isNaN(pid) && pid > 0) {
                this.pushLog(`找到实际 Java 子进程 PID: ${pid} (父进程: ${parentPid})`);
                return pid;
              }
            }
          } catch (e) { /* ignore */ }
        } else {
          try {
            const out = await this.runChildProcess('sh', ['-c', `ps --no-headers -o pid,ppid,comm,args | awk '$2==${parentPid} && $3 ~ /java/ {print $1; exit}'`], { windowsHide: true });
            const pid = parseInt(out.trim(), 10);
            if (!isNaN(pid) && pid > 0) {
              this.pushLog(`找到实际 Java 子进程 PID: ${pid} (父进程: ${parentPid})`);
              return pid;
            }
          } catch (e) { /* ignore */ }
        }
      } catch (e) {
        // ignore
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    this.pushLog(`警告：未能在 ${timeoutMs}ms 内找到 Java 子进程，将保持原有 PID (${parentPid})`);
    return null;
  }
}

class McServerManager {
  constructor(dbPool, baseDir = process.cwd(), eventCallback = null) {
    this.servers = new Map();
    this.dbPool = dbPool;
    this.baseDir = baseDir;
    this.eventCallback = typeof eventCallback === 'function' ? eventCallback : null;
  }

  emitEvent(serverId, event, payload) {
    if (!this.eventCallback) return;
    try {
      this.eventCallback(event, serverId, payload);
    } catch (e) {
      // ignore callback errors
    }
  }

  parseStoredConfig(rawConfig) {
    let cfg = {};
    if (typeof rawConfig === 'string') {
      if (rawConfig.trim()) {
        try {
          cfg = JSON.parse(rawConfig);
        } catch (e) {
          console.warn(`mc_servers config JSON 解析失败，已使用默认配置: ${e.message}`);
          cfg = {};
        }
      }
    } else if (Buffer.isBuffer(rawConfig)) {
      try {
        const text = rawConfig.toString('utf8');
        cfg = text.trim() ? JSON.parse(text) : {};
      } catch (e) {
        console.warn(`mc_servers config Buffer 解析失败，已使用默认配置: ${e.message}`);
        cfg = {};
      }
    } else if (typeof rawConfig === 'object' && rawConfig !== null) {
      cfg = rawConfig;
    }
    return typeof cfg === 'object' && cfg !== null ? cfg : {};
  }

  parseBoolean(value) {
    if (value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true') {
      return true;
    }
    return false;
  }

  normalizeConfigInput(config) {
    if (typeof config === 'string') {
      try {
        return JSON.parse(config);
      } catch (e) {
        throw new Error('config JSON 解析失败');
      }
    }
    if (typeof config !== 'object' || config === null) {
      throw new Error('config 必须为对象');
    }
    return config;
  }

  async loadFromDatabase() {
    if (!this.dbPool) return;
    try {
      const [rows] = await this.dbPool.execute('SELECT * FROM mc_servers');
      for (const row of rows) {
        const rowId = row && row.id ? row.id : '(unknown)';
        const rowName = row && row.name ? row.name : '';
        let cfg = this.parseStoredConfig(row.config);
        if (!cfg.name) cfg.name = rowName || String(rowId);
        if (!cfg.display_name) cfg.display_name = row.display_name || cfg.name;
        cfg.auto_start = this.parseBoolean(row.auto_start);

        let srv;
        try {
          srv = new McServer(row.id, cfg, this.baseDir, (event, serverId, payload) => this.emitEvent(serverId, event, payload));
        } catch (e) {
          console.warn(`mc_servers[${rowId}] 实例创建失败，已跳过该记录: ${e.message}`);
          continue;
        }

        this.servers.set(String(row.id), srv);
        if (this.parseBoolean(row.auto_start)) {
          setImmediate(async () => {
            try {
              await srv.start(false);
            } catch (e) {
              console.warn(`mc_servers[${rowId}] 自动启动失败: ${e.message}`);
            }
          });
        }
      }
    } catch (e) {
      console.warn('加载 mc_servers 表失败:', e.message);
    }
  }

  getServer(id) {
    if (!id) return null;
    return this.servers.get(String(id));
  }

  getAllServersInfo() {
    return Array.from(this.servers.entries()).map(([id, s]) => ({
      id,
      name: s.config.display_name || s.config.name || id,
      status: s.getStatus()
    }));
  }

  async createServer(name, config = {}) {
    if (!this.dbPool) throw new Error('数据库未配置');
    const normalizedConfig = this.normalizeConfigInput(config || {});
    const basePayload = Object.assign({}, normalizedConfig, {
      name,
      display_name: normalizedConfig.display_name || name
    });

    let attempt = 0;
    let attemptName = String(name);
    while (attempt < 10) {
      const payload = Object.assign({}, basePayload, { name: attemptName });
      payload.auto_start = this.parseBoolean(payload.auto_start || payload.autoStart);
      try {
        const [result] = await this.dbPool.execute(
          'INSERT INTO mc_servers (name, display_name, config, auto_start) VALUES (?, ?, ?, ?)',
          [attemptName, payload.display_name, JSON.stringify(payload), payload.auto_start ? 1 : 0]
        );
        const id = result.insertId;
        const srv = new McServer(id, payload, this.baseDir, (event, serverId, payloadData) => this.emitEvent(serverId, event, payloadData));
        this.servers.set(String(id), srv);
        return srv;
      } catch (e) {
        const msg = String(e && e.message || '').toLowerCase();
        if (msg.includes('duplicate') || e && e.code === 'ER_DUP_ENTRY') {
          attempt += 1;
          attemptName = `${String(name)}-${attempt}`;
          continue;
        }
        throw e;
      }
    }
    throw new Error('无法创建 MC 服务器：name 重复冲突（尝试多次失败）');
  }

  async updateServer(id, data = {}) {
    const sid = String(id);
    const server = this.servers.get(sid);
    if (!server) throw new Error('MC 服务器不存在');
    const updates = [];
    const params = [];

    if (data.name !== undefined) {
      server.config.name = String(data.name);
      updates.push('name = ?');
      params.push(server.config.name);
    }
    if (data.display_name !== undefined) {
      server.config.display_name = String(data.display_name);
      updates.push('display_name = ?');
      params.push(server.config.display_name);
    }
    if (data.config !== undefined) {
      const normalizedConfig = this.normalizeConfigInput(data.config);
      server.setConfig(normalizedConfig);
      updates.push('config = ?');
      params.push(JSON.stringify(server.config));
    }
    if (data.auto_start !== undefined || data.autoStart !== undefined) {
      const autoStartValue = this.parseBoolean(data.auto_start !== undefined ? data.auto_start : data.autoStart);
      server.config.auto_start = autoStartValue;
      updates.push('auto_start = ?');
      params.push(autoStartValue ? 1 : 0);
    }

    if (updates.length > 0 && this.dbPool) {
      params.push(id);
      try {
        await this.dbPool.execute(`UPDATE mc_servers SET ${updates.join(', ')} WHERE id = ?`, params);
      } catch (e) {
        throw e;
      }
    }

    return server;
  }

  async deleteServer(id, options = { removeFiles: false }) {
    const sid = String(id);
    const srv = this.servers.get(sid);
    if (srv && srv.process) {
      try { srv.kill(); } catch (e) { }
    }
    if (this.dbPool) {
      await this.dbPool.execute('DELETE FROM mc_servers WHERE id = ?', [id]);
    }
    if (options && options.removeFiles && srv) {
      try {
        const backupDir = srv.resolveBackupDir ? srv.resolveBackupDir() : path.join(this.baseDir, 'backups', sid);
        const logDir = srv.logDir || path.join(this.baseDir, 'logs', 'mc', sid);
        const workDir = srv.resolveWorkingDir ? srv.resolveWorkingDir() : null;
        if (backupDir && fs.existsSync(backupDir)) {
          try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch (e) { }
        }
        if (logDir && fs.existsSync(logDir)) {
          try { fs.rmSync(logDir, { recursive: true, force: true }); } catch (e) { }
        }
        if (workDir && path.resolve(workDir).startsWith(path.resolve(this.baseDir))) {
          try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { }
        }
      } catch (e) {
        // ignore file deletion errors
      }
    }

    this.servers.delete(sid);
    return true;
  }
}

function createMcControlRouter(mcManager, logger, options = {}) {
  const router = express.Router({ mergeParams: true });
  const fsImpl = options.fs || fs;
  const pathImpl = options.path || path;
  const asyncHandler = options.asyncHandler || ((fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next));

  function ensureMcServer(req, res, next) {
    if (!mcManager || !mcManager.getServer) {
      return res.status(500).json({ success: false, error: 'MC 管理器未初始化' });
    }
    const { id } = req.params;
    const server = mcManager.getServer(id);
    if (!server) {
      return res.status(404).json({ success: false, error: 'MC 服务器实例未找到' });
    }
    req.mcServer = server;
    next();
  }

  router.use(ensureMcServer);

  router.get('/config', asyncHandler(async (req, res) => {
    res.json({ success: true, config: req.mcServer.config, refreshPresets: req.mcServer.getRefreshPresetMap() });
  }));

  router.post('/config', asyncHandler(async (req, res) => {
    const config = req.body || {};
    if (logger && logger.debug) logger.debug('POST /api/mc/servers/:id/config', { id: req.params.id, body: config, ip: req.ip });
    try {
      req.mcServer.setConfig(config);
      await mcManager.updateServer(req.params.id, { config: req.mcServer.config });
      res.json({ success: true, message: '配置已保存' });
    } catch (e) {
      if (logger && logger.error) logger.error('POST /api/mc/servers/:id/config error', { id: req.params.id, message: e.message, stack: e.stack, body: config });
      const statusCode = e.message === 'autoBackupCron 格式无效' ? 400 : 500;
      res.status(statusCode).json({ success: false, error: e.message });
    }
  }));

  router.get('/players', asyncHandler(async (req, res) => {
    const info = req.mcServer.playerInfo || { players: [], count: 0, max: 0 };
    res.json({ success: true, players: info.players, count: info.count, max: info.max });
  }));

  router.post('/players/refresh', asyncHandler(async (req, res) => {
    if (!req.mcServer.process) return res.status(400).json({ success: false, error: 'Minecraft 服务器未运行' });
    const ok = req.mcServer.requestPlayerListRefresh('manual');
    if (!ok) return res.status(500).json({ success: false, error: '刷新玩家列表失败' });
    res.json({ success: true, message: '玩家列表刷新中，请稍候' });
  }));

  router.post('/start', asyncHandler(async (req, res) => {
    res.json({ success: req.mcServer.start(true) });
  }));

  router.post('/stop', asyncHandler(async (req, res) => {
    res.json({ success: req.mcServer.stop() });
  }));

  router.post('/kill', asyncHandler(async (req, res) => {
    res.json({ success: req.mcServer.kill() });
  }));

  router.post('/command', asyncHandler(async (req, res) => {
    const { command } = req.body || {};
    if (!command) return res.status(400).json({ success: false, error: '命令不能为空' });
    res.json({ success: req.mcServer.sendCommand(String(command)) });
  }));

  router.get('/status', asyncHandler(async (req, res) => {
    res.json(req.mcServer.getStatus());
  }));

  router.get('/logs', asyncHandler(async (req, res) => {
    res.json({ success: true, logs: req.mcServer.getLogs() });
  }));

  router.get('/logs/download', asyncHandler(async (req, res) => {
    const logFile = req.mcServer.logFile;
    if (!fsImpl.existsSync(logFile)) {
      return res.status(404).json({ success: false, error: 'MC 日志文件不存在' });
    }
    res.download(logFile, 'mc_latest.log', (err) => {
      if (err) res.status(500).json({ success: false, error: '下载日志失败' });
    });
  }));

  router.post('/sync', asyncHandler(async (req, res) => {
    let status = req.mcServer.getStatus ? req.mcServer.getStatus() : { running: false };
    if (!status.running) {
      const recovered = await req.mcServer.discoverExistingProcess();
      if (recovered) {
        status = req.mcServer.getStatus();
      }
    }
    if (status.running && status.recovered) {
      return res.json({ success: true, message: '已检测到现有 MC 进程，进入只读恢复模式。命令发送受限，仅支持日志/状态查看。', status });
    }
    if (status.running) {
      return res.json({ success: true, message: 'MC 服务器正在运行。', status });
    }
    res.json({ success: true, message: '未检测到可管理的 MC 进程。若进程仍在运行，请检查服务器配置或手动清理僵尸进程。', status });
  }));

  router.post('/backup', asyncHandler(async (req, res) => {
    try {
      const name = await req.mcServer.createBackup();
      res.json({ success: true, name });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  }));

  router.get('/backups', asyncHandler(async (req, res) => {
    try {
      const backups = await req.mcServer.listBackups();
      res.json({ success: true, backups });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  }));

  router.get('/backups/:name/download', asyncHandler(async (req, res) => {
    const file = req.mcServer.getBackupPath(req.params.name);
    if (!fsImpl.existsSync(file)) return res.status(404).json({ success: false, error: '备份文件不存在' });
    res.download(file, req.params.name, (err) => {
      if (err) res.status(500).json({ success: false, error: '下载失败' });
    });
  }));

  router.post('/backups/:name/restore', asyncHandler(async (req, res) => {
    try {
      await req.mcServer.restoreBackup(req.params.name);
      res.json({ success: true, message: '备份还原成功' });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  }));

  return router;
}

module.exports = McServer;
module.exports.McServer = McServer;
module.exports.McServerManager = McServerManager;
module.exports.createMcControlRouter = createMcControlRouter;
