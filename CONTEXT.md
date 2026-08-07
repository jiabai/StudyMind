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
