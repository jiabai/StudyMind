# StudyMind UI/UX 修复执行计划

> 本计划对应 `docs/superpowers/specs/2026-08-28-study-mind-ui-ux-fixes-design.md` 与 `docs/ui-audit/2026-08-28/TODO.md`。

## 1. 建立状态与交互测试

先修改现有 Vitest 测试，覆盖以下失败行为：

- `useHistoryController` 在列表请求失败后暴露失败状态，并支持重试；失败不应被清除成普通空态。
- `SidebarHistoryNotice` 渲染错误提示时提供重试操作。
- `useSettingsController` 加载失败后拒绝 `submitSettings`，重试成功后才允许保存。
- `HeroUploadZone` 错误态不包含嵌套的 button 语义。
- `RecordingCard` 在录音来源不可用时提供重新检查操作。
- New topic 的重置回调可以把焦点目标交给上传入口。
- `App.css` 的窄窗口排序、对比度 token 和禁用态规则符合验收约束。

验证：先运行相关测试，确认新增断言按预期失败。

## 2. 修复历史列表失败态

涉及：

- `app/src/features/history/useHistoryController.ts`
- `app/src/features/sidebar/AppSidebar.tsx`
- `app/src/features/sidebar/SidebarHistoryNotice.tsx`
- `app/src/i18n/synthesisResources.ts`

实现加载失败状态与重试回调；侧边栏按 loading/error/empty/data 的互斥顺序渲染。重试成功清除失败态，错误内容只使用本地化 message code。

## 3. 修复上传优先级与 New topic 焦点

涉及：

- `app/src/App.tsx`
- `app/src/features/workflow/HeroUploadZone.tsx`
- `app/src/App.css`

为上传入口提供稳定的 focus ref/回调；New topic 重置后聚焦上传入口。错误态改为普通状态容器 + 单一“重新选择”按钮。窄窗口通过现有响应式断点调整卡片顺序，宽屏布局不变。

## 4. 修复设置安全性与操作文案

涉及：

- `app/src/features/settings/useSettingsController.ts`
- `app/src/features/settings/SettingsSheet.tsx`
- `app/src/features/settings/LanguagePreferenceField.tsx`
- `app/src/i18n/synthesisResources.ts`

增加设置加载状态；失败时显示重试、锁定保存与依赖加载的控件，阻止默认 draft 提交。为立即生效的语言偏好和提交保存的配置补充说明，按现有业务行为保持兼容。

## 5. 修复隐私文案、对比度和平台/菜单语义

涉及：

- `app/src/features/workflow/HeroUploadZone.tsx`
- `app/src/features/results/AiGenerationWorkspace.tsx`
- `app/src/features/sidebar/SidebarUserMenu.tsx`
- `app/src/features/updates/*`
- `app/src/App.tsx`
- `app/src/App.css`
- `app/src/i18n/synthesisResources.ts`

统一本地处理与云端 LLM 说明、中英文术语、低对比度 token 和禁用态表现。根据平台渲染窗口控制；把 Credits 改为状态文本；为禁用更新动作提供解释。

## 6. 验证与复核

依次运行：

```text
npm --prefix app test
npm --prefix app run build
cargo check --manifest-path app/src-tauri/Cargo.toml
```

复查审查截图对应场景：历史加载失败、窄窗口首屏、New topic、设置加载失败、上传错误态、中英文入口文案。完成后更新 TODO 勾选状态，并报告仍受环境限制的验证项。
