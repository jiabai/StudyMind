export const dissectionResources = {
  "zh-CN": {
    dissection: {
      card: { title: "文字稿解剖", description: "拆解结构、表达手法与可复用骨架", stale: "文字稿已更新，解剖可能过时" },
      confirmation: {
        ariaLabel: "确认生成文字稿解剖", sectionLabel: "文字稿解剖", title: "确认解剖这份文字稿",
        closeAria: "关闭文字稿解剖确认", task: "任务", characters: "文字稿字符数", chunks: "输入片段",
        language: "输出语言", calls: "预计调用", quota: "剩余额度",
        callRange: "预计 {{minimum}}–{{maximum}} 次，最多 {{hardMaximum}} 次",
        privacy: "确认后，已保存的文字稿会分片发送给管理员配置的云端 LLM；多轮合计可能覆盖全文。不会发送视频、音频、来源网址、偏好或其他 AI 结果。",
        creditDisclosure: "1 次额度 = 1 次云端 LLM API 调用尝试。已发起的调用即使失败、超时或取消也不返还额度。",
        tooLong: "当前文字稿超过本版本最多 6 次调用的处理范围。", insufficientQuota: "剩余额度不足以覆盖预计调用上限。",
        cancel: "取消", confirm: "确认生成",
      },
      report: {
        stale: "文字稿已更新，这份解剖可能过时；请重新解剖后再定位原文。", narrative: "叙事结构",
        structureType: "推进结构", openingHook: "开头钩子", turningPoint: "转折", closingType: "收尾",
        segments: "主题分段", supportingPoints: "支撑点", rhetoricalDevices: "表达手法", rhythm: "节奏",
        reusablePattern: "可复用模式", riskFlags: "风险标记", sourceChunks: "引用片段", locateSource: "定位到文字稿", locateDisabled: "文字稿已变化，请重新解剖后定位",
        highlights: "亮点金句", strengths: "亮点", weaknesses: "短板", template: "可复用骨架", audienceFit: "受众适配", redissection: "重新解剖",
        fit: { high: "高", medium: "中", low: "低" },
      },
    },
  },
  "zh-TW": {
    dissection: {
      card: { title: "逐字稿解剖", description: "拆解結構、表達手法與可重用骨架", stale: "逐字稿已更新，解剖可能過時" },
      confirmation: {
        ariaLabel: "確認產生逐字稿解剖", sectionLabel: "逐字稿解剖", title: "確認解剖這份逐字稿",
        closeAria: "關閉逐字稿解剖確認", task: "任務", characters: "逐字稿字元數", chunks: "輸入片段",
        language: "輸出語言", calls: "預計呼叫", quota: "剩餘額度",
        callRange: "預計 {{minimum}}–{{maximum}} 次，最多 {{hardMaximum}} 次",
        privacy: "確認後，已儲存的逐字稿會分片傳送給管理員設定的雲端 LLM；多輪合計可能涵蓋全文。不會傳送影片、音訊、來源網址、偏好或其他 AI 結果。",
        creditDisclosure: "1 次額度 = 1 次雲端 LLM API 呼叫嘗試。已發起的呼叫即使失敗、逾時或取消也不退還額度。",
        tooLong: "目前逐字稿超過此版本最多 6 次呼叫的處理範圍。", insufficientQuota: "剩餘額度不足以涵蓋預計呼叫上限。",
        cancel: "取消", confirm: "確認產生",
      },
      report: {
        stale: "逐字稿已更新，這份解剖可能過時；請重新解剖後再定位原文。", narrative: "敘事結構",
        structureType: "推進結構", openingHook: "開頭鉤子", turningPoint: "轉折", closingType: "收尾",
        segments: "主題分段", supportingPoints: "支持點", rhetoricalDevices: "表達手法", rhythm: "節奏",
        reusablePattern: "可重用模式", riskFlags: "風險標記", sourceChunks: "引用片段", locateSource: "定位到逐字稿", locateDisabled: "逐字稿已變更，請重新解剖後定位",
        highlights: "亮點金句", strengths: "亮點", weaknesses: "短板", template: "可重用骨架", audienceFit: "受眾適配", redissection: "重新解剖",
        fit: { high: "高", medium: "中", low: "低" },
      },
    },
  },
  "en-US": {
    dissection: {
      card: { title: "Transcript Dissection", description: "Break down structure, rhetoric, and reusable patterns", stale: "The transcript changed; this report may be stale" },
      confirmation: {
        ariaLabel: "Confirm Transcript Dissection", sectionLabel: "Transcript Dissection", title: "Confirm this transcript dissection",
        closeAria: "Close Transcript Dissection confirmation", task: "Task", characters: "Transcript characters", chunks: "Input chunks",
        language: "Output language", calls: "Estimated calls", quota: "Credits remaining",
        callRange: "Estimated {{minimum}}–{{maximum}} calls, at most {{hardMaximum}}",
        privacy: "After confirmation, the saved transcript is sent in chunks to the administrator-configured cloud LLM. Across calls, this may cover the full transcript. Video, audio, source URL, preferences, and other AI results are not sent.",
        creditDisclosure: "1 Credit = 1 cloud LLM API call attempt. Credits for started calls are not refunded after failure, timeout, or cancellation.",
        tooLong: "This transcript exceeds the current six-call processing limit.", insufficientQuota: "The remaining balance is below the estimated call maximum.",
        cancel: "Cancel", confirm: "Confirm generation",
      },
      report: {
        stale: "The transcript changed, so this report may be stale. Run dissection again before locating source text.", narrative: "Narrative structure",
        structureType: "Structure", openingHook: "Opening hook", turningPoint: "Turning point", closingType: "Closing",
        segments: "Topic segments", supportingPoints: "Supporting points", rhetoricalDevices: "Rhetorical devices", rhythm: "Rhythm",
        reusablePattern: "Reusable pattern", riskFlags: "Risk flags", sourceChunks: "Cited chunks", locateSource: "Locate in transcript", locateDisabled: "The transcript changed; run dissection again to locate sources",
        highlights: "Highlights", strengths: "Strengths", weaknesses: "Weaknesses", template: "Reusable template", audienceFit: "Audience fit", redissection: "Run dissection again",
        fit: { high: "High", medium: "Medium", low: "Low" },
      },
    },
  },
} as const;
