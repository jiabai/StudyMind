# StudyMind 独立账号与 LLM Server 重建计划

## Goal

在 StudyMind 仓库内独立实现账号认证、LLM 密钥托管和计费权益服务；参考实现只用于设计与安全模式，不产生运行时耦合，并彻底移除 Server Task 域。

## Status

**Implementation complete — 2026-08-09**

## Completed phases

- [x] 确认 14 模型、完整 HTTP surface、安全边界和业务常量
- [x] 建立独立规格、ADR 与八阶段 TDD 实施计划
- [x] 替换 Prisma schema 和新基线迁移，删除旧 Task 域
- [x] 实现 MemoryStore/PrismaStore 事务语义和 SQLite 并发约束
- [x] 实现 desktop/web/admin 认证、激活、权益、LLM checkout 和支付
- [x] 同步 Rust 账号回调、环境变量和 Worker checkout 合同
- [x] 实现 fail-closed runtime、readiness、可观测性、生命周期和运维工具
- [x] 建立产品身份扫描、完整 Server 文档并执行最终审计

## Final verification

- Server identity boundary：2/2 通过
- Server：28 files / 199 tests，串行和默认模式均通过
- Server build：Prisma generate + TypeScript no-emit 通过
- 临时 SQLite：migration deploy/status、preflight、restore smoke 通过；未读取或修改 `server/data`
- Rust 定向：account 5/5、auth callback 5/5 通过
- Worker：26/26 通过；Ruff 通过
- 全量 Cargo 已按默认及单线程各运行一次，但均因本任务范围外的既有桌面文件系统/watchdog 测试失败并超时，详情记录在 `progress.md`

## Residual risks

- SQLite 是本机单实例持久化边界，不支持多实例横向扩展。
- 微信支付、SMTP、反向代理和真实备份恢复仍需在目标部署环境做带真实凭据的验收。
- 当前 Codex 环境预置 `RUST_LOG=warn` 时 Prisma 6.19 CLI schema engine 会无细节退出；最终迁移 gate 按测试 harness 使用 `RUST_LOG=info` 成功。生产部署应在预演中验证 CLI 环境。
- 仓库全量 Rust suite 存在与本次 Server 改造无关的既有失败/超时，需单独任务处理。
