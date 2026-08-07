import {
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  Lightbulb,
  RotateCcw,
  ShieldCheck,
  UserRound,
  X,
} from "lucide-react";
import { useMemo } from "react";
import {
  INSIGHT_PREFERENCE_FIELDS,
  type GenerationPreferenceField,
  type GenerationPreferences,
  type InspirationProfile,
} from "../../insightPreferences";
import type { SupportedLocale } from "../../i18n/locale";
import { countTextUnits, formatWordCount } from "../../i18n/formatters";
import {
  getPreferenceCopy,
  getPreferenceFieldPresentation,
  interpolatePreferenceCopy,
  summarizeGenerationPreferences,
  summarizeInspirationProfile,
} from "../../i18n/preferencePresentation";
import {
  advanceGenerationStep,
  backGenerationStep,
  cancelProfileSetupInFlow,
  selectGenerationOption,
  startGenerationPreferenceEditing,
  startProfileSetupInFlow,
  useDefaultGenerationPreferences,
  type InsightPreferenceFlowState,
} from "../../insightPreferenceFlow";
import { InspirationProfileForm } from "./InspirationProfileForm";
import { OutputLanguageField } from "./OutputLanguageField";
import { useModalFocus } from "../modal/useModalFocus";

type InsightPreferenceFlowProps = {
  flow: InsightPreferenceFlowState;
  busy: boolean;
  accountQuotaRemaining: number;
  transcriptText: string;
  transcriptPath: string | null;
  locale: SupportedLocale;
  outputLanguage: SupportedLocale;
  onFlowChange: (flow: InsightPreferenceFlowState) => void;
  onSkipProfile: () => void;
  onSaveProfile: (profile: InspirationProfile) => void;
  onConfirm: (preferences: GenerationPreferences) => void;
  onCancel: () => void;
};

export function InsightPreferenceFlow({
  flow,
  busy,
  accountQuotaRemaining,
  transcriptText,
  transcriptPath,
  locale,
  outputLanguage,
  onFlowChange,
  onSkipProfile,
  onSaveProfile,
  onConfirm,
  onCancel,
}: InsightPreferenceFlowProps) {
  const preferenceModalRef = useModalFocus<HTMLElement>(true);
  const copy = getPreferenceCopy(locale).flow;
  const title =
    flow.screen === "profile_intro" || flow.screen === "profile_form"
      ? copy.titleProfile
      : flow.screen === "confirmation"
        ? copy.titleConfirmation
        : copy.titleGeneration;

  return (
    <div className="modal-backdrop sheet-backdrop" role="presentation" onClick={onCancel}>
      <section
        ref={preferenceModalRef}
        className="sheet-panel detail-modal preference-flow-sheet"
        aria-label={title}
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-header sheet-header">
          <div>
            <p className="section-label">{copy.sectionLabel}</p>
            <h2>{title}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onCancel} aria-label={copy.closeAria}>
            <X size={18} />
          </button>
        </header>

        {flow.screen === "profile_intro" ? (
          <ProfileIntro
            locale={locale}
            resetRequired={flow.profileResetRequired}
            busy={busy}
            onStart={() => onFlowChange(startProfileSetupInFlow(flow))}
            onSkip={onSkipProfile}
          />
        ) : null}

        {flow.screen === "profile_form" ? (
          <InspirationProfileForm
            locale={locale}
            initialProfile={flow.profile}
            busy={busy}
            onCancel={() => {
              const nextFlow = cancelProfileSetupInFlow(flow);
              if (nextFlow) {
                onFlowChange(nextFlow);
                return;
              }
              onCancel();
            }}
            onSave={onSaveProfile}
          />
        ) : null}

        {flow.screen === "default_summary" ? (
          <DefaultSummary
            locale={locale}
            flow={flow}
            busy={busy}
            onDirect={() => onFlowChange(useDefaultGenerationPreferences(flow))}
            onModify={() => onFlowChange(startGenerationPreferenceEditing(flow))}
            onEditProfile={() => onFlowChange(startProfileSetupInFlow(flow))}
          />
        ) : null}

        {flow.screen === "generation_step" ? (
          <GenerationStep
            locale={locale}
            flow={flow}
            busy={busy}
            onFlowChange={onFlowChange}
          />
        ) : null}

        {flow.screen === "confirmation" ? (
          <ConfirmationStep
            locale={locale}
            outputLanguage={outputLanguage}
            flow={flow}
            busy={busy}
            accountQuotaRemaining={accountQuotaRemaining}
            transcriptText={transcriptText}
            transcriptPath={transcriptPath}
            onBack={() => onFlowChange(startGenerationPreferenceEditing(flow))}
            onConfirm={() => onConfirm(flow.generationPreferences)}
            onCancel={onCancel}
          />
        ) : null}
      </section>
    </div>
  );
}

function ProfileIntro({
  locale,
  resetRequired,
  busy,
  onStart,
  onSkip,
}: {
  locale: SupportedLocale;
  resetRequired: boolean;
  busy: boolean;
  onStart: () => void;
  onSkip: () => void;
}) {
  const copy = getPreferenceCopy(locale).flow;
  return (
    <div className="preference-flow-content">
      <div className="preference-panel">
        <UserRound size={20} />
        <div>
          <strong>{resetRequired ? copy.introResetTitle : copy.introTitle}</strong>
          <p>
            {resetRequired
              ? copy.introResetDescription
              : copy.introDescription}
          </p>
        </div>
      </div>
      <div className="settings-actions sheet-footer">
        <button type="button" className="secondary-button" onClick={onSkip} disabled={busy}>
          <span>{busy ? copy.processing : copy.skip}</span>
        </button>
        <button type="button" className="primary-button" onClick={onStart} disabled={busy}>
          <UserRound size={16} />
          <span>{copy.startSetup}</span>
        </button>
      </div>
    </div>
  );
}

function DefaultSummary({
  locale,
  flow,
  busy,
  onDirect,
  onModify,
  onEditProfile,
}: {
  locale: SupportedLocale;
  flow: InsightPreferenceFlowState;
  busy: boolean;
  onDirect: () => void;
  onModify: () => void;
  onEditProfile: () => void;
}) {
  const copy = getPreferenceCopy(locale).flow;
  return (
    <div className="preference-flow-content">
      <SummaryGroup
        title={copy.profileGroupTitle}
        lines={summarizeInspirationProfile(flow.profile, locale)}
      />
      <SummaryGroup
        title={copy.defaultGenerationGroupTitle}
        lines={
          flow.defaultGenerationPreferences
            ? summarizeGenerationPreferences(flow.defaultGenerationPreferences, locale)
            : []
        }
      />
      <div className="settings-actions sheet-footer">
        <button type="button" className="secondary-button" onClick={onEditProfile} disabled={busy}>
          <UserRound size={16} />
          <span>{copy.editProfile}</span>
        </button>
        <button type="button" className="secondary-button" onClick={onModify} disabled={busy}>
          <RotateCcw size={16} />
          <span>{copy.modifyDirection}</span>
        </button>
        <button type="button" className="primary-button" onClick={onDirect} disabled={busy}>
          <ChevronRight size={16} />
          <span>{copy.generateDirectly}</span>
        </button>
      </div>
    </div>
  );
}

function GenerationStep({
  locale,
  flow,
  busy,
  onFlowChange,
}: {
  locale: SupportedLocale;
  flow: InsightPreferenceFlowState;
  busy: boolean;
  onFlowChange: (flow: InsightPreferenceFlowState) => void;
}) {
  const config = INSIGHT_PREFERENCE_FIELDS[flow.currentStep];
  const presentation = getPreferenceFieldPresentation(locale, flow.currentStep);
  const copy = getPreferenceCopy(locale).flow;
  const rawValue = flow.generationPreferences[flow.currentStep];
  const selectedValues = Array.isArray(rawValue) ? rawValue : [rawValue];
  const maxReached = Array.isArray(rawValue) && rawValue.length >= config.max;
  const isFinalStep = flow.currentStep === "avoid";

  return (
    <div className="preference-flow-content">
      <div className="preference-step-header">
        <span>
          {interpolatePreferenceCopy(copy.stepProgress, {
            current: flow.currentStepIndex + 1,
            total: 6,
          })}
        </span>
        <h3>{presentation.label}</h3>
      </div>
      <div className="preference-options large">
        {presentation.options.map((option) => {
          const selected = selectedValues.includes(option.id);
          return (
            <button
              key={option.id}
              type="button"
              className={`preference-option ${selected ? "selected" : ""}`}
              disabled={busy || (!selected && maxReached)}
              onClick={() =>
                onFlowChange(
                  selectGenerationOption(
                    flow,
                    flow.currentStep as GenerationPreferenceField,
                    option.id,
                  ),
                )
              }
            >
              {selected ? <CheckCircle2 size={14} /> : null}
              <span>{option.label}</span>
            </button>
          );
        })}
      </div>
      <div className="settings-actions sheet-footer">
        <button
          type="button"
          className="secondary-button"
          disabled={busy || flow.currentStepIndex === 0}
          onClick={() => onFlowChange(backGenerationStep(flow))}
        >
          <ArrowLeft size={16} />
          <span>{copy.previous}</span>
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={busy || !flow.canAdvance}
          onClick={() => onFlowChange(advanceGenerationStep(flow))}
        >
          <ChevronRight size={16} />
          <span>{isFinalStep ? copy.completeSelection : copy.next}</span>
        </button>
      </div>
    </div>
  );
}

function ConfirmationStep({
  locale,
  outputLanguage,
  flow,
  busy,
  accountQuotaRemaining,
  transcriptText,
  transcriptPath,
  onBack,
  onConfirm,
  onCancel,
}: {
  locale: SupportedLocale;
  outputLanguage: SupportedLocale;
  flow: InsightPreferenceFlowState;
  busy: boolean;
  accountQuotaRemaining: number;
  transcriptText: string;
  transcriptPath: string | null;
  onBack: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const copy = getPreferenceCopy(locale).flow;
  const transcriptUnitCount = useMemo(
    () => countTextUnits(transcriptText, locale),
    [locale, transcriptText],
  );
  return (
    <div className="preference-flow-content">
      <p className="settings-warning privacy-callout">
        <ShieldCheck size={16} />
        <span>{copy.privacyInsights}</span>
      </p>
      <div className="confirm-summary preference-confirm-grid">
        <div>
          <span className="account-status-label">{copy.currentTranscript}</span>
          <strong>
            {transcriptUnitCount > 0
              ? formatWordCount(transcriptUnitCount, locale)
              : copy.waitingTranscript}
          </strong>
          <small>{transcriptPath || copy.transcriptUnavailable}</small>
        </div>
        <div>
          <span className="account-status-label">{copy.creditsLabel}</span>
          <strong>
            {interpolatePreferenceCopy(copy.creditsBalance, {
              count: new Intl.NumberFormat(locale).format(accountQuotaRemaining),
            })}
          </strong>
          <small>{copy.quotaDisclosure}</small>
        </div>
        <OutputLanguageField locale={locale} outputLanguage={outputLanguage} />
      </div>
      <SummaryGroup
        title={copy.currentGenerationGroupTitle}
        lines={summarizeGenerationPreferences(flow.generationPreferences, locale)}
      />
      <SummaryGroup
        title={copy.longTermContextGroupTitle}
        lines={summarizeInspirationProfile(flow.profile, locale)}
        quiet
      />
      <div className="settings-actions sheet-footer">
        <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>
          <span>{copy.cancel}</span>
        </button>
        <button type="button" className="secondary-button" onClick={onBack} disabled={busy}>
          <ArrowLeft size={16} />
          <span>{copy.backToEdit}</span>
        </button>
        <button type="button" className="primary-button" onClick={onConfirm} disabled={busy}>
          <Lightbulb size={16} />
          <span>{busy ? copy.starting : copy.confirm}</span>
        </button>
      </div>
    </div>
  );
}

function SummaryGroup({
  title,
  lines,
  quiet = false,
}: {
  title: string;
  lines: string[];
  quiet?: boolean;
}) {
  return (
    <section className={`preference-summary-group${quiet ? " quiet" : ""}`}>
      <h3>{title}</h3>
      <div className="preference-summary-list">
        {lines.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </div>
    </section>
  );
}
