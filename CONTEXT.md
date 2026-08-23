# StudyMind

课堂学习辅助桌面应用：将本地音视频转写为带时间戳的文字稿，再由 AI 生成知识点摘要、思维导图与文字稿解剖。

## Language

### 工作单元

**Task**:
一次媒体处理的完整工作单元，由 task_id 唯一标识，持久化为 task_dir 下的 StudyMind-task.json manifest。
_Avoid_: job, project

**JobStage**:
Task 在管线中当前所处的生命周期阶段（waiting_input / video_extracting / video_transcribing / insights_generating / completed / partial_completed / failed）。
_Avoid_: status, state

**Pipeline**:
从媒体导入到产物落盘的有序处理流程，由 media preparation → transcript → insights 三个阶段编排而成。
_Avoid_: workflow, flow

### 输入

**LocalMediaSource**:
用户导入的本地音视频文件，封装为 ProcessLocalMediaRequest。
_Avoid_: source, input file

**PreparedMedia**:
媒体预处理产物：提取后的音频路径 + 可选的字幕候选。
_Avoid_: extracted media, normalized media

### 内置录音

**RecordingSession**:
一次从开始采集到停止、失败或放弃结束的录音会话；它不是 Task，也不是 LocalMediaSource。
_Avoid_: recording task, recording file

**RecordingMode**:
录音会话的音源选择：`mic`（仅麦克风）、`system`（仅系统声音）或 `mixed`（麦克风与系统声音）。
_Avoid_: audio source, capture type

**RecordingSource**:
`RecordingSession` 中可独立报告故障并保留采集语义的音源：`microphone` 或 `systemAudio`；它不同于用户选择的 RecordingMode。
_Avoid_: source, RecordingMode

**RecordingSourceCapability**:
某类录音音源在当前系统版本、设备与权限状态下是否可以启动的事实；它不同于用户选择的 RecordingMode。
_Avoid_: mode availability, platform support

**RecordingFallback**:
空闲态中，已保存的 RecordingMode 因当前能力变化而不可用时，自动选择可用的 `mic` 并告知用户；用户明确点击开始后以及 RecordingSession 已开始后不静默换源。
_Avoid_: silent downgrade, automatic source switch

**SystemAudioRecording**:
只保存可捕获的 macOS 全局系统音频，不保存或传递屏幕视频；主显示器只作为 v1 的
`SCContentFilter` 技术入口，不是用户可见的录音范围。实现前必须验证 audio-only stream 能持续
捕获全局系统音频。
_Avoid_: screen recording, loopback device

**MixedRecordingFailure**:
`mixed` 会话成功交付给用户后，任一路音源在运行、停止或会话收到整体停止/放弃请求前自行结束时，
整个 RecordingSession 立即进入失败终态且不提交部分录音产物；首先确认的失败决定失败归因。成功交付前的
权限、初始化、ready 或 timeout 结果属于 RecordingStartFailure，不形成 RecordingFailure。
_Avoid_: partial mixed recording, source fallback

**MixedRecordingReady**:
`mixed` 会话的麦克风与系统声音均已具备接受音频帧的条件；它不要求任一路已经产生首帧。
双方就绪前收到的帧不属于 RecordingSession 的有效录音内容。
_Avoid_: first frame, capture started

**RecordingStartFailure**:
录音成功交付给用户前发生的致命启动结果；启动操作只有在采集资源清理完成后才报告它，且不形成可恢复的
RecordingFailure 状态。
_Avoid_: active recording failure, failed recording state

**RecordingFailure**:
录音成功交付给用户后，使 RecordingSession 立即进入错误终态的致命结果；它停止用户可见的录音计时，
不创建 LocalMediaSource，也不执行媒体交接。失败结果在本次应用运行期间保持可恢复，直到用户确认或开始新会话。
_Avoid_: warning, recording stopped

**RecordingFailureIdentity**:
由 RecordingSession、稳定错误码与可选音源共同确定的一次 RecordingFailure；同一身份经由实时通知、
命令结果或状态恢复重复到达时仍是同一次失败。
_Avoid_: error occurrence, notification id

**RecordingCleanup**:
RecordingFailure 已对用户可见后，对该会话残留采集资源和临时产物进行的后台收尾阶段；完成前不得开始
新的 RecordingSession，也不得改变已确认的失败归因。只有在采集资源已确认释放后，临时产物删除失败才不阻塞
后续会话；无法确认采集资源已释放时，本次应用运行期间继续阻止录音。
_Avoid_: finalization, media handoff

**RecordingPermissionWait**:
录音启动期间由操作系统管理的权限交互；它先于音源就绪等待，不计入 MixedRecordingReady 的期限。
_Avoid_: startup timeout, capture timeout

**RecordingWarning**:
RecordingSession 中已经恢复、不会使录音失败，但可能影响产物连续性的非致命情况；它必须可被
用户知晓，并与 RecordingError 区分。
_Avoid_: error, diagnostic log

**EmptyRecording**:
没有产生有效音频帧的 RecordingSession 结果；v1 拒绝它并回到空闲态。
_Avoid_: zero recording, blank audio

**SilentRecording**:
包含有效音频帧但没有可感知声音的录音；v1 将其视为合法本地媒体，不因静音自动失败。
_Avoid_: empty recording


### 转写

**Transcript**:
带时间戳的文字稿，来源为 ASR 推理或本地字幕文件。
_Avoid_: subtitle, caption, text

**TranscriptMetadata**:
Transcript 的来源元信息：source（asr/subtitle）、language、engine。
_Avoid_: transcript info, transcript details

### AI 生成（InsightFlow）

**Summary**:
基于 Transcript 生成的课堂要点文字总结。
_Avoid_: abstract, overview

**Mindmap**:
基于 Transcript 生成的 Mermaid 思维导图，呈现知识点结构。
_Avoid_: outline, tree, diagram

**Insight**:
从 Transcript 抽取的一个知识点：包含 topic、match_reason、follow_up_questions、suitable_use。
_Avoid_: note, point, takeaway

**Dissection**:
对已保存 Transcript 的结构化拆解，按 chunk 做 map-reduce 生成解剖报告。
_Avoid_: analysis, breakdown, parse

### 偏好

**PreferenceSnapshot**:
AI 生成时捕获的用户偏好快照，包含 InspirationProfile 与 GenerationPreferences。
_Avoid_: user config, settings

**InspirationProfile**:
用户角色画像：role / domain / stage / city_context / gender_perspective / platforms。
_Avoid_: persona, user profile

**GenerationPreferences**:
AI 生成偏好：goal / scenario / angles / audience / styles / avoid。
_Avoid_: prompt config, output config

### 基础设施

**Worker**:
独立运行的 Python 进程，承担 ASR 推理与 InsightFlow 生成；通过 Desktop Contract 与 Tauri 通信。
_Avoid_: backend, service

**Desktop Contract**:
Tauri（Rust）与 Worker（Python）之间的进程间协议，定义环境变量前缀 STUDYMIND_、事件前缀 STUDYMIND_PROGRESS 与版本号。
_Avoid_: IPC, protocol

**Artifact**:
Task 产物在 task_dir 下持久化的文件（transcript/ai 子目录），通过原子写入提交。
_Avoid_: output, file, result
