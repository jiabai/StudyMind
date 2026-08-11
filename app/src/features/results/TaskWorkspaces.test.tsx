import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, test, vi } from "vitest";

import { createGuestAccountStatus } from "../../accountState";
import {
  createInitialWorkflow,
  requestProcessingCancellation,
  startProcessing,
  startInsightRetry,
  summarizeWorkerResult,
  type WorkflowState,
} from "../../workflow";
import { createTaskWorkspaceViewModel } from "../../taskWorkspaceViewModel";
import type { TranscriptDetailController } from "../transcript/useTranscriptDetailController";
import type { TranscriptNotesController } from "../transcript/useTranscriptNotesController";
import type { TranscriptNote } from "../../transcriptNotesState";
import { LocalTranscriptWorkspace } from "../transcript/LocalTranscriptWorkspace";
import { AiGenerationWorkspace } from "./AiGenerationWorkspace";
import { AiResultDetailSheet } from "./AiResultDetailSheet";
import { TaskStatusBanner } from "./TaskStatusBanner";
import { initializeI18n } from "../../i18n/i18n";
import type { SupportedLocale } from "../../i18n/locale";

function findMatchingDivClose(source: string, openingIndex: number): number {
  const divTagPattern = /<\/?div\b[^>]*>/g;
  divTagPattern.lastIndex = openingIndex;
  let depth = 0;
  let match: RegExpExecArray | null;

  while ((match = divTagPattern.exec(source)) !== null) {
    if (match[0].startsWith("</")) {
      depth -= 1;
      if (depth === 0) {
        return match.index;
      }
    } else if (!match[0].endsWith("/>")) {
      depth += 1;
    }
  }

  return -1;
}

function readyWorkflow(): WorkflowState {
  return summarizeWorkerResult({
    status: "completed",
    task_id: "same-task",
    task_dir: "D:/StudyMind/outputs/tasks/same-task",
    artifacts: {
      video: "media/video.mp4",
      audio: "media/audio.wav",
      transcript_txt: "transcript/transcript.txt",
      transcript_md: "transcript/transcript.md",
    },
    text: "第一段正式文字稿。第二段正式文字稿。",
    summary: "",
    insights: [],
    transcript: { source: "asr", language: "zh", engine: "SenseVoice" },
    dissection: null,
    dissection_source_status: null,
    error: null,
  });
}

function generatedDissectionWorkflow(): WorkflowState {
  const workflow = readyWorkflow();
  return {
    ...workflow,
    artifacts: {
      ...workflow.artifacts,
      dissection: "ai/dissection.json",
      dissection_md: "ai/dissection.md",
    },
    dissection: {
      schemaVersion: 1,
      sourceTranscriptSha256: "a".repeat(64),
      sourceLanguage: "zh-CN",
      sourceChunks: [{ id: 1, startByte: 0, endByte: 27, sha256: "b".repeat(64) }],
      overallNarrative: {
        openingHook: "问题钩子",
        structureType: "问题—分析—结论",
        turningPoint: "第二段",
        closingType: "总结",
      },
      segments: [{
        id: 1,
        title: "开场",
        sourceChunkIds: [1],
        coreClaim: "第一段正式文字稿。",
        supportingPoints: ["第二段正式文字稿。"],
        rhetoricalDevices: ["设问"],
        rhythmNote: "简洁",
        reusablePattern: "提出[问题]后给出[结论]",
        riskFlags: [],
      }],
      highlights: ["第一段正式文字稿。"],
      reusableTemplate: { name: "问题解答", skeleton: ["提出问题", "展开分析", "给出结论"] },
      audienceFit: [{ audience: "初学者", fit: "high", note: "容易理解" }],
      strengths: ["结构清晰"],
      weaknesses: ["论据较少"],
    },
  };
}

function aiAccount(quota = 8) {
  return {
    ...createGuestAccountStatus(),
    authenticated: true,
    entitlementStatus: "active",
    llmConfigured: true,
    llmQuotaLimit: 10,
    llmQuotaUsed: 10 - quota,
    llmQuotaRemaining: quota,
    canProcess: true,
    canGenerateAi: quota > 0,
  };
}

function transcriptController(): TranscriptDetailController {
  return {
    detailTab: null,
    openDetailTab: vi.fn(),
    closeDetail: vi.fn(),
    detailTitle: "完整文字稿",
    detailText: "第一段正式文字稿。第二段正式文字稿。",
    exportPath: "D:/StudyMind/outputs/tasks/same-task/transcript/transcript.txt",
    currentTranscriptPath: "D:/StudyMind/outputs/tasks/same-task/transcript/transcript.txt",
    transcriptDetail: {
      task_id: "same-task",
      text: "第一段正式文字稿。第二段正式文字稿。",
      segments: [
        { id: "segment-1", start_ms: 0, end_ms: 5000, text: "第一段正式文字稿。" },
        { id: "segment-2", start_ms: 5000, end_ms: 9000, text: "第二段正式文字稿。" },
      ],
      audio_asset_path: "D:/StudyMind/outputs/tasks/same-task/media/audio.wav",
      audio_path: "D:/StudyMind/outputs/tasks/same-task/media/audio.wav",
      has_original_backup: true,
      artifacts: { transcript_txt: "transcript/transcript.txt" },
      transcript: { source: "asr", language: "zh", engine: "SenseVoice" },
    },
    transcriptDraft: "第一段正式文字稿。第二段正式文字稿。",
    transcriptSegments: [
      { id: "segment-1", start_ms: 0, end_ms: 5000, text: "第一段正式文字稿。" },
      { id: "segment-2", start_ms: 5000, end_ms: 9000, text: "第二段正式文字稿。" },
    ],
    transcriptDirty: false,
    transcriptLoading: false,
    transcriptSaving: false,
    activeTranscriptSegmentId: null,
    editingTranscriptSegmentId: null,
    transcriptAudioCurrentTime: 0,
    transcriptAudioDuration: 9,
    transcriptAudioPlaying: false,
    transcriptAudioRef: createRef<HTMLAudioElement>(),
    transcriptSegmentRefs: { current: {} },
    transcriptSourceLabel: "来源：本地 ASR",
    transcriptAudioSrc: "asset://audio.wav",
    transcriptAudioProgress: 0,
    transcriptAudioScrubberMax: 9,
    transcriptAudioScrubberStyle: { "--audio-progress": "0%" },
    hasTranscriptSegments: true,
    copyDetail: vi.fn(),
    copyTranscript: vi.fn(),
    exportDetail: vi.fn(),
    exportTranscript: vi.fn(),
    saveTranscriptDraft: vi.fn(),
    playTranscriptSegment: vi.fn(),
    handleTranscriptAudioMetadata: vi.fn(),
    handleTranscriptTimeUpdate: vi.fn(),
    handleTranscriptAudioPlay: vi.fn(),
    handleTranscriptAudioPause: vi.fn(),
    toggleTranscriptAudio: vi.fn(),
    scrubTranscriptAudio: vi.fn(),
    beginTranscriptSegmentEdit: vi.fn(),
    endTranscriptSegmentEdit: vi.fn(),
    updateTranscriptSegmentDraft: vi.fn(),
    updateFullTranscriptDraft: vi.fn(),
  } as unknown as TranscriptDetailController;
}

function notesController(notes: TranscriptNote[] = []): TranscriptNotesController {
  return {
    activeTaskId: "same-task",
    notes,
    notesLoading: false,
    notesLoadError: null,
    notesSaving: false,
    notesSaveError: null,
    editingNoteId: null,
    editingNoteContent: "",
    focusedNoteId: null,
    retryLoadNotes: vi.fn(),
    createNoteForSegment: vi.fn(),
    focusNoteForSegment: vi.fn(),
    beginNoteEdit: vi.fn(),
    updateNoteDraft: vi.fn(),
    cancelNoteEdit: vi.fn(),
    saveNote: vi.fn(),
    deleteNote: vi.fn(),
    clearFocusedNote: vi.fn(),
  } as TranscriptNotesController;
}

describe("task domain workspaces", () => {
  beforeAll(async () => {
    await initializeI18n("zh-CN");
  });

  test("renders a local completion banner and two labelled workspaces for the same task", () => {
    const workflow = readyWorkflow();
    const model = createTaskWorkspaceViewModel(workflow, aiAccount());
    const markup = renderToStaticMarkup(
      <>
        <TaskStatusBanner model={model.banner} />
        <LocalTranscriptWorkspace
          model={model.local}
          controller={transcriptController()}
          actionNotice={null}
          onLocateArtifact={vi.fn()}
          onCancel={vi.fn()}
        />
        <AiGenerationWorkspace
          model={model.ai}
          quotaRemaining={8}
          onSummaryAction={vi.fn()}
          onInsightsAction={vi.fn()}
          onViewTarget={vi.fn()}
          onCancel={vi.fn()}
        />
      </>,
    );

    expect(markup).toContain('aria-label="任务状态"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-atomic="true"');
    expect(markup).toContain("媒体文件和文字稿已保存在本机");
    expect(markup).toContain('aria-label="本地文字稿工作区"');
    expect(markup).toContain('data-task-id="same-task"');
    expect(markup).toContain('aria-label="学习整理工作区"');
    expect(markup.match(/data-task-id="same-task"/g)).toHaveLength(2);
    expect(markup).toContain("文字稿校对");
    expect(markup).toContain("学习整理");
    expect(markup).not.toContain("Local transcript");
    expect(markup).not.toContain("Cloud AI");
    expect(markup).not.toContain(">本地完成</span>");
    expect(markup).not.toContain(">可选</span>");
    expect(markup.match(/class="ai-target-status"/g)).toHaveLength(3);
  });

  test("keeps meaningful workspace statuses for active and constrained states", () => {
    const processingWorkflow = startProcessing(createInitialWorkflow(), {
      kind: "local_file",
      displayName: "Lecture.mp4",
      mediaKind: "video",
    });
    const processingModel = createTaskWorkspaceViewModel(processingWorkflow, aiAccount());
    const processingMarkup = renderToStaticMarkup(
      <>
        <LocalTranscriptWorkspace
          model={processingModel.local}
          controller={transcriptController()}
          actionNotice={null}
          onLocateArtifact={vi.fn()}
          onCancel={vi.fn()}
        />
        <AiGenerationWorkspace
          model={processingModel.ai}
          quotaRemaining={8}
          onSummaryAction={vi.fn()}
          onInsightsAction={vi.fn()}
          onViewTarget={vi.fn()}
          onCancel={vi.fn()}
        />
      </>,
    );
    expect(processingMarkup).toContain(">处理中</span>");
    expect(processingMarkup).toContain(">等待文字稿</span>");

    const failedWorkflow = summarizeWorkerResult({
      status: "failed",
      task_id: null,
      task_dir: null,
      artifacts: {},
      text: "",
      summary: "",
      insights: [],
      transcript: null,
      dissection: null,
      dissection_source_status: null,
      error: { code: "MEDIA_DOWNLOAD_FAILED", message: "failed", stage: "video_extracting" },
    });
    const failedModel = createTaskWorkspaceViewModel(failedWorkflow, aiAccount());
    const failedMarkup = renderToStaticMarkup(
      <LocalTranscriptWorkspace
        model={failedModel.local}
        controller={transcriptController()}
          actionNotice={null}
        onLocateArtifact={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(failedMarkup).toContain(">处理失败</span>");

    const generatingWorkflow = startInsightRetry(readyWorkflow(), "summary");
    const generatingModel = createTaskWorkspaceViewModel(generatingWorkflow, aiAccount());
    const generatingMarkup = renderToStaticMarkup(
      <AiGenerationWorkspace
        model={generatingModel.ai}
        quotaRemaining={8}
        onSummaryAction={vi.fn()}
        onInsightsAction={vi.fn()}
        onViewTarget={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(generatingMarkup).toContain(">生成中</span>");
  });

  test("shows motion only for the active local processing stage", () => {
    const extractingWorkflow = startProcessing(
      createInitialWorkflow(),
      { kind: "local_file", displayName: "Lecture.mp4", mediaKind: "video" },
    );
    const extractingModel = createTaskWorkspaceViewModel(extractingWorkflow, aiAccount());
    const extractingMarkup = renderToStaticMarkup(
      <LocalTranscriptWorkspace
        model={extractingModel.local}
        controller={transcriptController()}
        actionNotice={null}
        onLocateArtifact={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(extractingMarkup).toMatch(
      /<span class="active"><svg[^>]*lucide-loader-circle spin/,
    );
    expect(extractingMarkup).not.toMatch(
      /<span class="pending"><svg[^>]*lucide-loader-circle spin/,
    );

    const transcribingWorkflow: WorkflowState = {
      ...extractingWorkflow,
      stage: "video_transcribing",
    };
    const transcribingModel = createTaskWorkspaceViewModel(transcribingWorkflow, aiAccount());
    const transcribingMarkup = renderToStaticMarkup(
      <LocalTranscriptWorkspace
        model={transcribingModel.local}
        controller={transcriptController()}
        actionNotice={null}
        onLocateArtifact={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(transcribingMarkup).toMatch(
      /<span class="complete"><svg[^>]*lucide-circle-check/,
    );
    expect(transcribingMarkup).toMatch(
      /<span class="active"><svg[^>]*lucide-loader-circle spin/,
    );
  });

  test("labels local audio preparation without claiming that a video is being extracted", () => {
    const workflow = startProcessing(createInitialWorkflow(), {
      kind: "local_file",
      displayName: "Interview.mp3",
      mediaKind: "audio",
    });
    const model = createTaskWorkspaceViewModel(workflow, aiAccount());
    const markup = renderToStaticMarkup(
      <LocalTranscriptWorkspace
        model={model.local}
        controller={transcriptController()}
        actionNotice={null}
        onLocateArtifact={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(markup).toContain("音频准备中");
    expect(markup).not.toContain("视频提取中");
  });

  test("keeps the idle task banner static", () => {
    const model = createTaskWorkspaceViewModel(createInitialWorkflow(), aiAccount());
    const markup = renderToStaticMarkup(<TaskStatusBanner model={model.banner} />);

    expect(markup).not.toContain('class="lucide lucide-loader-circle spin"');
  });

  test("local workspace is audio-first with compact file actions and inline transcript review", () => {
    const workflow = readyWorkflow();
    const model = createTaskWorkspaceViewModel(workflow, aiAccount());
    const markup = renderToStaticMarkup(
      <LocalTranscriptWorkspace
        model={model.local}
        controller={transcriptController()}
          actionNotice={null}
        onLocateArtifact={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="音频回听工具栏"');
    expect(markup).toContain('class="local-artifact-toolbar"');
    expect(markup).toContain("定位视频");
    expect(markup).toContain("定位音频");
    expect(markup).toContain('class="transcript-review-panel"');
    expect(markup).toContain("第一段正式文字稿。");
    expect(markup).toContain('class="transcript-action-bar"');
    expect(markup.match(/class="transcript-segment /g)).toHaveLength(2);
    expect(markup).not.toContain("result-grid");
  });

  test("composes the transcript, notes, and learning workspaces in the intended layout", () => {
    const appSource = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
    expect(appSource).toContain("task-workspace-primary-column");
    expect(appSource).toContain("TranscriptNotesPanel");
    expect(appSource).toContain("transcriptNotesController");
    expect(appSource.indexOf("TranscriptNotesPanel")).toBeGreaterThan(
      appSource.indexOf("LocalTranscriptWorkspace"),
    );
    const learningRowClassStart = appSource.indexOf(
      'className="task-workspace-learning-row"',
    );
    const learningRowStart = appSource.lastIndexOf("<div", learningRowClassStart);
    const learningRowEnd = findMatchingDivClose(appSource, learningRowStart);
    const learningRowSource = appSource.slice(learningRowStart, learningRowEnd);
    const taskLayoutClassStart = appSource.indexOf(
      "className={`task-workspace-layout",
    );
    const taskLayoutStart = appSource.lastIndexOf("<div", taskLayoutClassStart);
    const taskLayoutEnd = findMatchingDivClose(appSource, taskLayoutStart);
    const notesStart = appSource.indexOf("<TranscriptNotesPanel");
    const annotationStart = appSource.indexOf("<AnnotationListPanel");

    expect(learningRowClassStart).toBeGreaterThan(-1);
    expect(learningRowEnd).toBeGreaterThan(learningRowStart);
    expect(learningRowSource).toContain("<AiGenerationWorkspace");
    expect(learningRowSource).toContain("<AnnotationListPanel");
    expect(learningRowSource.indexOf("<AnnotationListPanel")).toBeGreaterThan(
      learningRowSource.indexOf("<AiGenerationWorkspace"),
    );
    expect(notesStart).toBeGreaterThan(learningRowEnd);
    expect(notesStart).toBeLessThan(taskLayoutEnd);
    expect(annotationStart).toBeGreaterThan(learningRowStart);
    expect(annotationStart).toBeLessThan(learningRowEnd);
  });

  test("renders one note action per transcript segment with inserted state", () => {
    const workflow = readyWorkflow();
    const model = createTaskWorkspaceViewModel(workflow, aiAccount());
    const markup = renderToStaticMarkup(
      <LocalTranscriptWorkspace
        model={model.local}
        controller={transcriptController()}
        notesController={notesController([
          {
            id: "note-1",
            transcript_segment_id: "segment-1",
            source_text: "第一段正式文字稿。",
            content: "重点",
            created_at: "2026-08-11T10:00:00+00:00",
            updated_at: "2026-08-11T10:00:00+00:00",
          },
        ])}
        actionNotice={null}
        onLocateArtifact={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(markup.match(/class="[^"]*transcript-segment-note/g)).toHaveLength(2);
    expect(markup).toContain('aria-label="已插入笔记"');
    expect(markup).toContain('aria-label="插入笔记"');
    expect(markup).toMatch(/transcript-segment-note inserted/);
  });

  test("disables note actions when transcript editing is unavailable", () => {
    const workflow = readyWorkflow();
    const model = createTaskWorkspaceViewModel(workflow, aiAccount());
    const markup = renderToStaticMarkup(
      <LocalTranscriptWorkspace
        model={{ ...model.local, canEdit: false }}
        controller={transcriptController()}
        notesController={notesController()}
        actionNotice={null}
        onLocateArtifact={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(markup.match(/class="[^"]*transcript-segment-note[^>]*disabled/g)).toHaveLength(2);
  });

  test("hides transcript segments whose text was cleared without changing the saved timeline", () => {
    const workflow = readyWorkflow();
    const baseController = transcriptController();
    const segments = [
      { id: "segment-empty", start_ms: 0, end_ms: 5000, text: "   " },
      { id: "segment-visible", start_ms: 5000, end_ms: 9000, text: "保留的文字稿内容。" },
    ];
    const controller = {
      ...baseController,
      transcriptDraft: "保留的文字稿内容。",
      transcriptSegments: segments,
      transcriptDetail: baseController.transcriptDetail
        ? { ...baseController.transcriptDetail, text: "保留的文字稿内容。", segments }
        : baseController.transcriptDetail,
    } as TranscriptDetailController;
    const model = createTaskWorkspaceViewModel(workflow, aiAccount());
    const markup = renderToStaticMarkup(
      <LocalTranscriptWorkspace
        model={model.local}
        controller={controller}
        actionNotice={null}
        onLocateArtifact={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(markup.match(/class="transcript-segment /g)).toHaveLength(1);
    expect(markup).not.toContain("segment-empty");
    expect(markup).toContain("保留的文字稿内容。");
    expect(controller.transcriptSegments).toHaveLength(2);
  });

  test("renders an audio-only local workspace from the facade model without workflow state", () => {
    const workflow = summarizeWorkerResult({
      status: "completed",
      task_id: "audio-only-task",
      task_dir: "D:/StudyMind/outputs/tasks/audio-only-task",
      artifacts: {
        audio: "media/audio.wav",
        transcript_txt: "transcript/transcript.txt",
        transcript_md: "transcript/transcript.md",
      },
      text: "音频文件文字稿。",
      summary: "",
      insights: [],
      transcript: { source: "asr", language: "zh", engine: "SenseVoice" },
      dissection: null,
      dissection_source_status: null,
      error: null,
    });
    const model = createTaskWorkspaceViewModel(workflow, aiAccount());
    const markup = renderToStaticMarkup(
      <LocalTranscriptWorkspace
        model={model.local}
        controller={transcriptController()}
        actionNotice={null}
        onLocateArtifact={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(markup).not.toContain("定位视频");
    expect(markup).toContain("定位音频");
    expect(markup).toContain("来源：本地 ASR");
  });

  test("AI workspace has independent summary, inspiration, and dissection targets without a mindmap target", () => {
    const workflow = readyWorkflow();
    const model = createTaskWorkspaceViewModel(workflow, aiAccount());
    const markup = renderToStaticMarkup(
      <AiGenerationWorkspace
        model={model.ai}
        quotaRemaining={8}
        onSummaryAction={vi.fn()}
        onInsightsAction={vi.fn()}
        onViewTarget={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(markup).toContain("学习整理");
    expect(markup).toContain("确认后仅发送文字稿片段，视频和音频不会上传");
    expect(markup).toContain('data-ai-target="summary"');
    expect(markup).toContain("知识结构");
    expect(markup).toContain("提炼核心概念并生成 Mermaid 知识图谱");
    expect(markup).toContain('data-ai-target="insights"');
    expect(markup.match(/<article class="ai-target-card/g)).toHaveLength(3);
    expect(markup).toContain('data-ai-target="dissection"');
    expect(markup).toContain("文字稿解剖");
    expect(markup).toContain("学习问题");
    expect(markup.indexOf('data-ai-target="dissection"')).toBeLessThan(
      markup.indexOf('data-ai-target="insights"'),
    );
    expect(markup).toContain("AI Credits 余额：8");
    expect(markup).toContain("一次学习整理可能消耗多个 Credits。");
    expect(markup).not.toContain("当前可用 8 次");
    expect(markup).not.toContain('data-ai-target="mindmap"');
    expect(markup.match(/class="secondary-button ai-target-action"/g)).toHaveLength(3);
    expect(markup).not.toContain('class="primary-button"');
  });

  test("generated dissection card exposes only the view action", () => {
    const model = createTaskWorkspaceViewModel(generatedDissectionWorkflow(), aiAccount());
    const markup = renderToStaticMarkup(
      <AiGenerationWorkspace
        model={model.ai}
        quotaRemaining={8}
        onSummaryAction={vi.fn()}
        onInsightsAction={vi.fn()}
        onDissectionAction={vi.fn()}
        onViewTarget={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const dissectionCard = markup.match(
      /<article[^>]*data-ai-target="dissection"[\s\S]*?<\/article>/,
    )?.[0];

    expect(dissectionCard).toBeDefined();
    expect(dissectionCard).toContain("查看结果");
    expect(dissectionCard).not.toContain("确认生成");
    expect(dissectionCard).not.toContain('class="secondary-button ai-target-action"');
  });

  test("generated dissection detail exposes a specifically named redissection action", () => {
    const workflow = generatedDissectionWorkflow();
    const controller = {
      ...transcriptController(),
      detailTab: "dissection",
      detailText: "# 文字稿解剖",
      exportPath: "D:/StudyMind/outputs/tasks/same-task/ai/dissection.md",
    } as TranscriptDetailController;
    const markup = renderToStaticMarkup(
      <AiResultDetailSheet
        actionNotice={null}
        controller={controller}
        workflow={workflow}
        annotations={[]}
        annotationsLoading={false}
        activeAnnotationId={null}
        onAnnotationAdd={vi.fn()}
        onAnnotationUpdate={vi.fn()}
        onAnnotationDelete={vi.fn()}
        onOpenDirectionEditor={vi.fn()}
        onOpenDissectionConfirmation={vi.fn()}
        onLocateDissectionChunks={vi.fn()}
      />,
    );

    expect(markup).toContain("重新解剖");
    expect(markup).not.toContain("重新生成");
  });

  test("dissection detail never falls through to the inspiration empty state when the report object is missing", () => {
    const workflow = {
      ...readyWorkflow(),
      artifacts: {
        ...readyWorkflow().artifacts,
        dissection: "ai/dissection.json",
        dissection_md: "ai/dissection.md",
      },
      dissection: null,
    };
    const controller = {
      ...transcriptController(),
      detailTab: "dissection",
      detailText: "",
      exportPath: "D:/StudyMind/outputs/tasks/same-task/ai/dissection.md",
    } as TranscriptDetailController;
    const markup = renderToStaticMarkup(
      <AiResultDetailSheet
        actionNotice={null}
        controller={controller}
        workflow={workflow}
        annotations={[]}
        annotationsLoading={false}
        activeAnnotationId={null}
        onAnnotationAdd={vi.fn()}
        onAnnotationUpdate={vi.fn()}
        onAnnotationDelete={vi.fn()}
        onOpenDirectionEditor={vi.fn()}
        onOpenDissectionConfirmation={vi.fn()}
        onLocateDissectionChunks={vi.fn()}
      />,
    );

    expect(markup).toContain("文字稿解剖尚未生成。");
    expect(markup).not.toContain("学习问题尚未生成。");
    expect(markup).not.toContain('class="insight-detail-list"');
  });

  test("renders AI cancellation from the facade model without workflow state", () => {
    const workflow = requestProcessingCancellation(
      startInsightRetry(readyWorkflow(), "summary"),
    );
    const model = createTaskWorkspaceViewModel(workflow, aiAccount());
    const markup = renderToStaticMarkup(
      <AiGenerationWorkspace
        model={model.ai}
        quotaRemaining={8}
        onSummaryAction={vi.fn()}
        onInsightsAction={vi.fn()}
        onViewTarget={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(markup).toContain("正在取消");
    expect(markup).toMatch(/class="secondary-button danger-soft ai-cancel-button"[^>]*disabled=""/);
  });

  test("AI generation keeps transcript review visible but disables editing and saving", () => {
    const workflow = startInsightRetry(readyWorkflow(), "summary");
    const model = createTaskWorkspaceViewModel(workflow, aiAccount());
    const markup = renderToStaticMarkup(
      <LocalTranscriptWorkspace
        model={model.local}
        controller={transcriptController()}
          actionNotice={null}
        onLocateArtifact={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(markup).toContain("AI 正在使用已保存版本");
    expect(markup).toContain("第一段正式文字稿。");
    expect(markup).toContain('aria-label="播放音频"');
    expect(markup).toContain(
      'class="secondary-button compact-button transcript-segment-edit"',
    );
    expect(markup).toContain('aria-label="编辑此片段"');
    expect(markup).toContain('title="编辑"');
    expect(markup).toContain('class="lucide lucide-pencil"');
    expect(markup).not.toMatch(/>编辑<\/button>/);
    expect(markup).toMatch(
      /class="secondary-button compact-button transcript-segment-edit"[^>]*disabled=""[^>]*aria-label="编辑此片段"/,
    );
    expect(markup).toContain('class="primary-button" disabled=""');
    expect(markup).toContain("<span>保存</span>");
  });

  test("quota exhaustion is explained in the AI workspace without disabling local review", () => {
    const workflow = readyWorkflow();
    const model = createTaskWorkspaceViewModel(workflow, aiAccount(0));
    const markup = renderToStaticMarkup(
      <AiGenerationWorkspace
        model={model.ai}
        quotaRemaining={0}
        notice={{ messageCode: "preferences.notice.preferencesReadFailed" }}
        onSummaryAction={vi.fn()}
        onInsightsAction={vi.fn()}
        onViewTarget={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(markup).toContain("AI Credits 已用完");
    expect(markup).toContain('class="ai-workspace-notice"');
    expect(markup).toContain("无法读取本地偏好，请稍后重试。");
    expect(markup).toContain('disabled=""');
  });

  test.each([
    ["zh-CN", "本地文字稿工作区", "文字稿校对", "播放音频", "编辑此片段", "复制", "导出", "保存"],
    ["zh-TW", "本機逐字稿工作區", "逐字稿校對", "播放音訊", "編輯此片段", "複製", "匯出", "儲存"],
    ["en-US", "Local Transcript workspace", "Transcript Review", "Play audio", "Edit this segment", "Copy", "Export", "Save"],
  ] as const)(
    "localizes transcript controls and audio accessibility copy in %s",
    async (locale, workspaceLabel, title, playAudio, editSegment, copy, exportLabel, save) => {
      await initializeI18n(locale as SupportedLocale);
      const workflow = readyWorkflow();
      const model = createTaskWorkspaceViewModel(workflow, aiAccount());
      const markup = renderToStaticMarkup(
        <LocalTranscriptWorkspace
          model={model.local}
          controller={transcriptController()}
          actionNotice={null}
          onLocateArtifact={vi.fn()}
          onCancel={vi.fn()}
        />,
      );

      expect(markup).toContain(`aria-label="${workspaceLabel}"`);
      expect(markup).toContain(title);
      expect(markup).toContain(`aria-label="${playAudio}"`);
      expect(markup).toContain(`aria-label="${editSegment}"`);
      expect(markup).toContain(`>${copy}</span>`);
      expect(markup).toContain(`>${exportLabel}</span>`);
      expect(markup).toContain(`>${save}</span>`);
      expect(markup).toContain("第一段正式文字稿。");

      await initializeI18n("zh-CN");
    },
  );

  test("shows a localized generic worker error with only a safe code", async () => {
    await initializeI18n("en-US");
    const failedWorkflow = summarizeWorkerResult({
      status: "failed",
      task_id: null,
      task_dir: null,
      artifacts: {},
      text: "",
      summary: "",
      insights: [],
      transcript: null,
      dissection: null,
      dissection_source_status: null,
      error: {
        code: "FUTURE_WORKER_FAILURE",
        message: "Authorization: Bearer super-secret at C:/private/transcript.txt",
        stage: "video_transcribing",
      },
    });
    const model = createTaskWorkspaceViewModel(failedWorkflow, aiAccount());
    const markup = renderToStaticMarkup(
      <LocalTranscriptWorkspace
        model={model.local}
        controller={transcriptController()}
          actionNotice={null}
        onLocateArtifact={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(markup).toContain("The operation failed. Try again later.");
    expect(markup).toContain("Technical details");
    expect(markup).toContain("FUTURE_WORKER_FAILURE");
    expect(markup).not.toContain("super-secret");
    expect(markup).not.toContain("C:/private");
    await initializeI18n("zh-CN");
  });

  test.each([
    ["zh-CN", "处理已超过最长运行时间，StudyMind 已停止本次任务。现有结果已保留，请重试。"],
    ["zh-TW", "處理已超過最長執行時間，StudyMind 已停止本次工作。現有結果已保留，請重試。"],
    ["en-US", "StudyMind stopped this operation after it reached the maximum run time. Existing results were kept; try again."],
  ] as const)(
    "shows AI execution-timeout recovery guidance in %s",
    async (locale, expectedGuidance) => {
      await initializeI18n(locale);
      const source = readyWorkflow();
      const failedWorkflow = summarizeWorkerResult(
        {
          status: "partial_completed",
          task_id: source.taskId,
          task_dir: source.taskDir,
          artifacts: source.artifacts,
          text: source.text,
          summary: source.summary,
          insights: source.insights,
          transcript: source.transcript,
          dissection: null,
          dissection_source_status: null,
          error: {
            code: "WORKER_EXECUTION_TIMEOUT",
            message: "untrusted runtime detail",
            stage: "insights_generating",
          },
        },
        "summary",
      );
      const model = createTaskWorkspaceViewModel(failedWorkflow, aiAccount());
      const markup = renderToStaticMarkup(
        <AiGenerationWorkspace
          model={model.ai}
          quotaRemaining={8}
          onSummaryAction={vi.fn()}
          onInsightsAction={vi.fn()}
          onViewTarget={vi.fn()}
          onCancel={vi.fn()}
        />,
      );

      expect(markup).toContain(expectedGuidance);
      expect(markup).not.toContain("untrusted runtime detail");
      await initializeI18n("zh-CN");
    },
  );
});
