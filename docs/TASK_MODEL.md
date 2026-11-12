# TASK_MODEL.md — 任务模型

## 任务的生命周期

```
pending → processing → done / failed
outbox: pending → sent / failed / unknown
```

- **pending**：微信消息已入队，等 worker 认领。
- **processing**：worker 已认领（`mv` 原子操作），租约 10 分钟（按 ctime 判）；worker 每 60 秒 touch 续租；过期自动回收回 pending。
- **done**：worker 执行完并把回复写进 outbox。
- **failed**：worker 执行失败（真实原因写进 outbox 给用户，不编造成功）。
- **outbox sent**：桥接进程已发回微信，账本记 sent。
- **outbox failed**：达到最大重试次数（3 次），进 failed，等人工处理。
- **outbox unknown**：发送结果不确定（网络错误、超时）；**永不自动重发**，等人工确认。

## 任务文件格式

`queue/pending/<id>.json`：

```json
{
  "id": "wx-<时间戳>-<随机>",
  "conversationId": "<owner id>",
  "text": "消息正文",
  "media": null,
  "receivedAt": "2026-11-12T10:03:23.282Z",
  "source": "wechat",
  "attempts": 0
}
```

`outbox/<id>.json`：

```json
{
  "taskId": "<id>",
  "text": "回复正文",
  "attempts": 0
}
```

有图片/文件回传时加：`"mediaPath": "<绝对路径>", "mediaType": "image|video|file", "mediaFileName": "xxx.png"`。

## 幂等与去重

- 入站去重：`data/seen.json`（文本 + 发信人哈希，1 小时 TTL，最多 500 条）；重投靠 seen 过滤。
- 出站幂等：`data/send-ledger.json`（intent → sent）；账本已记 sent 的不再重发；同一 client_id 重试时服务端去重。
- 损坏处理：队列文件损坏进 `queue/quarantine/` 并告警；账本损坏时发送 fail-closed（拒绝发送等人处理）。

## 跨端查询

App 与微信共用同一份队列/outbox 文件；主聊天问“微信任务进行到哪了？”时，直接读 `queue/` 与 `outbox/` 给出准确状态（M2 测试 B1）。

## 开发任务（M4）

开发任务走另一条记录：`developer/tasks/<task-id>/`（result.json + out.txt + err.txt），经 `developer/run-dev-task.sh` 执行；状态：ok / error / timeout / needs_approval。见 `developer/README.md`。
