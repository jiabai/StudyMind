import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  loadAnnotations,
  saveAnnotations,
  type SummaryAnnotation,
} from "../annotationClient";
import type { UiMessage } from "../i18n/uiMessage";
import type { WorkflowState } from "../workflow";

type UseAnnotationsControllerOptions = {
  workflow: WorkflowState;
  setActionNotice: (message: UiMessage | null) => void;
};

export function useAnnotationsController({
  workflow,
  setActionNotice,
}: UseAnnotationsControllerOptions) {
  const [annotations, setAnnotations] = useState<SummaryAnnotation[]>([]);
  const [annotationsLoading, setAnnotationsLoading] = useState(false);
  const [annotationsSaving, setAnnotationsSaving] = useState(false);
  const annotationLoadTaskIdRef = useRef<string | null>(null);
  const currentTaskIdRef = useRef(workflow.taskId);
  currentTaskIdRef.current = workflow.taskId;

  useEffect(() => {
    if (!workflow.taskId) {
      annotationLoadTaskIdRef.current = null;
      setAnnotations([]);
      setAnnotationsLoading(false);
      return;
    }

    if (annotationLoadTaskIdRef.current === workflow.taskId) {
      return;
    }
    annotationLoadTaskIdRef.current = workflow.taskId;

    let cancelled = false;
    setAnnotationsLoading(true);
    setAnnotations([]);
    const taskId = workflow.taskId;

    async function load() {
      try {
        const result = await loadAnnotations(taskId);
        if (cancelled) {
          return;
        }
        setAnnotations(result.annotations);
      } catch {
        if (cancelled) {
          return;
        }
        setAnnotations([]);
      } finally {
        if (!cancelled) {
          setAnnotationsLoading(false);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [workflow.taskId]);

  const addAnnotation = useCallback(
    (
      targetTab: string,
      textAnchor: string,
      charIndex: number,
      content: string,
      color: string | null = null,
    ) => {
      const now = new Date().toISOString().replace("Z", "+00:00");
      const newAnnotation: SummaryAnnotation = {
        id: `ann_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        target_tab: targetTab,
        text_anchor: textAnchor,
        char_index: charIndex,
        content,
        color,
        created_at: now,
        updated_at: now,
      };
      setAnnotations((current) => [...current, newAnnotation]);
      return newAnnotation;
    },
    [],
  );

  const updateAnnotation = useCallback(
    (id: string, content: string, color: string | null = null) => {
      setAnnotations((current) =>
        current.map((a) =>
          a.id === id
            ? {
                ...a,
                content,
                color,
                updated_at: new Date().toISOString().replace("Z", "+00:00"),
              }
            : a,
        ),
      );
    },
    [],
  );

  const deleteAnnotation = useCallback((id: string) => {
    setAnnotations((current) => current.filter((a) => a.id !== id));
  }, []);

  const saveAnnotationsToDisk = useCallback(async () => {
    if (!workflow.taskId || annotationsSaving) {
      return;
    }
    const expectedTaskId = workflow.taskId;
    setAnnotationsSaving(true);
    try {
      const result = await saveAnnotations(expectedTaskId, annotations);
      if (currentTaskIdRef.current !== expectedTaskId) {
        return;
      }
      setAnnotations(result.annotations);
    } catch {
      setActionNotice({
        messageCode: "synthesis.annotation.saveFailed",
        args: {},
      });
    } finally {
      setAnnotationsSaving(false);
    }
  }, [annotations, annotationsSaving, setActionNotice, workflow.taskId]);

  const getAnnotationsForTab = useCallback(
    (tab: string) => annotations.filter((a) => a.target_tab === tab),
    [annotations],
  );

  const findAnnotationByTextAnchor = useCallback(
    (tab: string, text: string) =>
      annotations.find(
        (a) => a.target_tab === tab && a.text_anchor === text,
      ),
    [annotations],
  );

  return {
    annotations,
    annotationsLoading,
    annotationsSaving,
    addAnnotation,
    updateAnnotation,
    deleteAnnotation,
    saveAnnotationsToDisk,
    getAnnotationsForTab,
    findAnnotationByTextAnchor,
  };
}
