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
- 第一轮 RED：纯内存连续禁用词 fixture 被报告为 `fixture.ts:1`，并发现 email/page/routes 和 Rust callback 负向测试中的旧身份字面量；清理后 identity 2/2 通过。
- P2 复审发现原扫描器只看 raw source，静态拆分可以绕过。第二轮 RED 使用 base64 承载的内存 TS/Rust 源码，包含二元 `+`、数组 `join`、字符串 `concat` 和 Rust `concat!`；旧 scanner 返回空数组，回归测试按预期失败。
- 通过 TypeScript AST 有限求值和 Rust `concat!` 全字面量解析实现静态折叠；raw source 与折叠结果使用同一 forbidden 规则。首次运行主动检出 9 处仓库负向 fixture，没有使用 allowlist。
- 冗余页面旧身份断言删除；仍有业务意义的 legacy scheme/ticket 拒绝测试改用运行时字符输入。最终 identity 3/3、全 Server 200/200 通过。
- 精确行号另走一次 RED/GREEN：多行 raw fixture 最初错误报告第 1 行，修复后 raw match 使用自身 offset，折叠结果使用表达式起点，fixture 正确报告第 2 行。
- 实施计划的 55 个已执行步骤全部更新为 `[x]`；机械审计结果为 55 checked / 0 unchecked。
- 重写 `server/README.md`；保留用户已有 `AGENTS.md` 与 triage 文档改动；确认 `.gitignore` 已完整覆盖 Server 数据库及 sidecar。

## Final test evidence

| Gate | Result |
|---|---|
| `npm --prefix server test -- --run tests/productIdentityBoundary.test.ts` | 1 file / 3 tests passed |
| Server serial (`--maxWorkers=1 --no-file-parallelism`) | 28 files / 199 tests passed |
| `npm --prefix server test` | 28 files / 200 tests passed |
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
- 这些文件不在 Task 8 修改范围；本次 Rust diff 只改变旧 ticket 负向 fixture 的构造方式，其直接相关的 callback 测试全部通过。未对无关桌面端测试做越界修复。

## Remaining deployment validation

- 在目标主机验证 SMTP 投递、微信支付签名/通知、反向代理和 TLS/Cookie 行为。
- 对真实备份执行停机快照、restore smoke、预检与回滚演练。
- 另开任务修复仓库既有全量 Rust 测试失败和 watchdog 超时。
