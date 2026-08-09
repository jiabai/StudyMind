# StudyMind Server 重建进度

## Session: 2026-08-08 — 2026-08-09

### Architecture correction

- 用户纠正原 Task 同步方案后停止错误实现，重新确认独立账号/权益/LLM Server 边界。
- 完成规格 `docs/superpowers/specs/2026-08-08-independent-account-llm-server-design.md`、ADR-0002 和八阶段 TDD 计划。

### Implementation commits

- Domain/migration：`7ba389a`、`64bb128`
- MemoryStore：`bcff616`、`65caad9`、`07332c6`、`52f9ae4`、`709b01b`
- PrismaStore：`99cb5f3`、`9004a45`、`4e62c8d`、`db599d9`
- Desktop auth/Rust：`069c0d0`、`140a8c8`、`c38f1d1`、`a38d82d`
- Activation/LLM：`e200303`、`26e7092`、`7401dee`、`028b0eb`
- Billing/Admin/Web：`1b008a6`、`618b698`、`d441253`、`79b6528`、`e54f306`
- Runtime/operations：`a957438`、`5e9549d`、`cf079a5`、`37c9146`、`59b6791`、`3c4a2ca`

### Task 8 TDD

- 新增 `server/tests/productIdentityBoundary.test.ts`。
- 首次运行按预期 RED：纯内存 fixture 被报告为 `fixture.ts:1`，并发现 email/page/routes 和 Rust callback 负向测试中的旧身份字面量。
- 将负向测试改成运行时/编译期拼接，不改变其拒绝旧身份的行为；复跑 identity 2/2 通过。
- 重写 `server/README.md`；保留用户已有 `AGENTS.md` 与 triage 文档改动；确认 `.gitignore` 已完整覆盖 Server 数据库及 sidecar。

## Final test evidence

| Gate | Result |
|---|---|
| `npm --prefix server test -- --run tests/productIdentityBoundary.test.ts` | 1 file / 2 tests passed |
| Server serial (`--maxWorkers=1 --no-file-parallelism`) | 28 files / 199 tests passed |
| `npm --prefix server test` | 28 files / 199 tests passed |
| `npm --prefix server run build` | Prisma Client 6.19.3 generated; TypeScript passed |
| Disposable SQLite deploy + status | baseline migration applied; schema up to date |
| Disposable SQLite preflight + restore smoke | both passed; source copy not modified |
| `cargo test ... account` | 5 passed, 234 filtered |
| `cargo test ... tests::auth_callback` | 5 passed, 234 filtered |
| `uv run pytest worker/tests/test_llm.py -q` | 26 passed |
| `uv run pytest worker/tests` | 26 passed |
| `uv run ruff check worker` | passed |

## Full Cargo exception

- 默认并行 `cargo test`：239 tests 启动，180 秒超时；出现既有 annotation storage、LLM local settings、progress protocol 与 watchdog 失败。
- 单线程 `cargo test -- --test-threads=1`：360 秒超时；同样的既有失败复现，并卡在长时间 watchdog 测试。
- 这些文件不在 Task 8 修改范围；本次 Rust diff 只把三个旧 ticket 测试字符串改为 `concat!`，其直接相关的 callback 测试全部通过。未对无关桌面端测试做越界修复。

## Remaining deployment validation

- 在目标主机验证 SMTP 投递、微信支付签名/通知、反向代理和 TLS/Cookie 行为。
- 对真实备份执行停机快照、restore smoke、预检与回滚演练。
- 另开任务修复仓库既有全量 Rust 测试失败和 watchdog 超时。
