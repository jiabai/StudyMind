use serde_json::{Map, Value};
use std::sync::OnceLock;

const CONTRACT_JSON: &str = include_str!("../../../contracts/desktop-worker-contract.json");
const SAFE_CODE_MAX_CHARS: usize = 96;
pub(crate) const ASR_MODEL_DOWNLOAD_EVENT_NAME: &str = "asr-model-download-progress";
pub(crate) const MODEL_DOWNLOAD_EVENT_PREFIX: &str = "STUDYMIND_MODEL_DOWNLOAD ";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct InvalidProgressEvent;

pub(crate) fn validate_worker_progress_event(
    payload: &Value,
) -> Result<Value, InvalidProgressEvent> {
    let contract = contract()?;
    let section = contract
        .pointer("/progressEvents/worker")
        .ok_or(InvalidProgressEvent)?;
    let object = validate_top_level_shape(payload, section)?;
    let stage = object
        .get("stage")
        .and_then(Value::as_str)
        .ok_or(InvalidProgressEvent)?;
    validate_stage(stage, contract)?;
    validate_progress(object, contract)?;
    validate_code_and_args(object, section, contract)?;
    Ok(payload.clone())
}

pub(crate) fn validate_model_download_event(
    payload: &Value,
) -> Result<Value, InvalidProgressEvent> {
    let contract = contract()?;
    let section = contract
        .pointer("/progressEvents/asrModelDownload")
        .ok_or(InvalidProgressEvent)?;
    let object = validate_top_level_shape(payload, section)?;
    validate_progress(object, contract)?;
    let code_rule = validate_code_and_args(object, section, contract)?;

    let status = object
        .get("status")
        .and_then(Value::as_str)
        .ok_or(InvalidProgressEvent)?;
    let expected_status = code_rule
        .get("status")
        .and_then(Value::as_str)
        .ok_or(InvalidProgressEvent)?;
    if status != expected_status {
        return Err(InvalidProgressEvent);
    }

    match code_rule
        .get("current_file")
        .and_then(Value::as_str)
        .ok_or(InvalidProgressEvent)?
    {
        "required" => {
            let current_file = object
                .get("current_file")
                .and_then(Value::as_str)
                .ok_or(InvalidProgressEvent)?;
            if !is_safe_basename(current_file) {
                return Err(InvalidProgressEvent);
            }
        }
        "forbidden" if object.contains_key("current_file") => return Err(InvalidProgressEvent),
        "forbidden" => {}
        _ => return Err(InvalidProgressEvent),
    }

    Ok(payload.clone())
}

pub(crate) fn invalid_progress_log_detail(payload: &Value) -> String {
    let code = payload
        .as_object()
        .and_then(|object| object.get("message_code"))
        .and_then(Value::as_str)
        .filter(|code| is_safe_log_code(code))
        .unwrap_or("invalid");
    format!("message_code={code}")
}

pub(crate) fn cancelled_model_download_event() -> Value {
    let payload = serde_json::json!({
        "status": "cancelled",
        "progress": 0,
        "message_code": "model.download.cancelled"
    });
    validate_model_download_event(&payload)
        .expect("static model cancellation event must match desktop-worker contract")
}

fn contract() -> Result<&'static Value, InvalidProgressEvent> {
    static CONTRACT: OnceLock<Option<Value>> = OnceLock::new();
    CONTRACT
        .get_or_init(|| serde_json::from_str(CONTRACT_JSON).ok())
        .as_ref()
        .ok_or(InvalidProgressEvent)
}

fn validate_top_level_shape<'a>(
    payload: &'a Value,
    section: &Value,
) -> Result<&'a Map<String, Value>, InvalidProgressEvent> {
    let object = payload.as_object().ok_or(InvalidProgressEvent)?;
    let required = string_array(section.get("requiredFields"))?;
    let optional = string_array(section.get("optionalFields"))?;
    if required.iter().any(|field| !object.contains_key(*field))
        || object
            .keys()
            .any(|field| !required.contains(&field.as_str()) && !optional.contains(&field.as_str()))
    {
        return Err(InvalidProgressEvent);
    }
    Ok(object)
}

fn validate_progress(
    object: &Map<String, Value>,
    contract: &Value,
) -> Result<(), InvalidProgressEvent> {
    let schema = contract
        .pointer("/progressEvents/fieldSchemas/progress")
        .ok_or(InvalidProgressEvent)?;
    let progress = object
        .get("progress")
        .and_then(Value::as_i64)
        .ok_or(InvalidProgressEvent)?;
    let minimum = i64_schema_value(schema, "minimum")?;
    let maximum = i64_schema_value(schema, "maximum")?;
    if progress < minimum || progress > maximum {
        return Err(InvalidProgressEvent);
    }
    Ok(())
}

fn validate_stage(stage: &str, contract: &Value) -> Result<(), InvalidProgressEvent> {
    let schema = contract
        .pointer("/progressEvents/fieldSchemas/stage")
        .ok_or(InvalidProgressEvent)?;
    let allowed = string_array(schema.get("enum"))?;
    if !allowed.contains(&stage) {
        return Err(InvalidProgressEvent);
    }
    Ok(())
}

fn validate_code_and_args<'a>(
    object: &Map<String, Value>,
    section: &'a Value,
    contract: &Value,
) -> Result<&'a Value, InvalidProgressEvent> {
    let code = object
        .get("message_code")
        .and_then(Value::as_str)
        .ok_or(InvalidProgressEvent)?;
    let code_rule = section
        .get("messageCodes")
        .and_then(Value::as_object)
        .and_then(|codes| codes.get(code))
        .ok_or(InvalidProgressEvent)?;
    let allowed_args = string_array(code_rule.get("allowedArgs"))?;

    if let Some(args_value) = object.get("message_args") {
        let args = args_value.as_object().ok_or(InvalidProgressEvent)?;
        for (key, value) in args {
            if !allowed_args.contains(&key.as_str()) {
                return Err(InvalidProgressEvent);
            }
            validate_arg(key, value, contract)?;
        }
        validate_arg_relationships(args, contract)?;
    }

    Ok(code_rule)
}

fn validate_arg_relationships(
    args: &Map<String, Value>,
    contract: &Value,
) -> Result<(), InvalidProgressEvent> {
    let enforce_retry_order = contract
        .pointer("/progressEvents/messageArgs/constraints/attemptMustNotExceedTotal")
        .and_then(Value::as_bool)
        .ok_or(InvalidProgressEvent)?;
    if !enforce_retry_order {
        return Err(InvalidProgressEvent);
    }

    if let (Some(attempt), Some(total)) = (
        args.get("attempt").and_then(Value::as_i64),
        args.get("total").and_then(Value::as_i64),
    ) {
        if attempt > total {
            return Err(InvalidProgressEvent);
        }
    }
    Ok(())
}

fn validate_arg(key: &str, value: &Value, contract: &Value) -> Result<(), InvalidProgressEvent> {
    let schema = contract
        .pointer(&format!("/progressEvents/messageArgs/properties/{key}"))
        .ok_or(InvalidProgressEvent)?;
    match key {
        "model" => {
            let model = value.as_str().ok_or(InvalidProgressEvent)?;
            let allowed = string_array(schema.get("enum"))?;
            if !allowed.contains(&model) {
                return Err(InvalidProgressEvent);
            }
        }
        "language" => {
            let language = value.as_str().ok_or(InvalidProgressEvent)?;
            let min = usize_schema_value(schema, "minLength")?;
            let max = usize_schema_value(schema, "maxLength")?;
            let length = language.chars().count();
            if length < min || length > max || !is_safe_language_tag(language) {
                return Err(InvalidProgressEvent);
            }
        }
        "attempt" | "total" => {
            let number = value.as_i64().ok_or(InvalidProgressEvent)?;
            let minimum = i64_schema_value(schema, "minimum")?;
            let maximum = i64_schema_value(schema, "maximum")?;
            if number < minimum || number > maximum {
                return Err(InvalidProgressEvent);
            }
        }
        _ => return Err(InvalidProgressEvent),
    }
    Ok(())
}

fn string_array(value: Option<&Value>) -> Result<Vec<&str>, InvalidProgressEvent> {
    value
        .and_then(Value::as_array)
        .ok_or(InvalidProgressEvent)?
        .iter()
        .map(|item| item.as_str().ok_or(InvalidProgressEvent))
        .collect()
}

fn usize_schema_value(schema: &Value, field: &str) -> Result<usize, InvalidProgressEvent> {
    schema
        .get(field)
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or(InvalidProgressEvent)
}

fn i64_schema_value(schema: &Value, field: &str) -> Result<i64, InvalidProgressEvent> {
    schema
        .get(field)
        .and_then(Value::as_i64)
        .ok_or(InvalidProgressEvent)
}

fn is_safe_language_tag(value: &str) -> bool {
    let mut parts = value.split('-');
    let Some(language) = parts.next() else {
        return false;
    };
    if !(2..=8).contains(&language.len())
        || !language.bytes().all(|byte| byte.is_ascii_alphabetic())
    {
        return false;
    }
    parts.all(|part| {
        (1..=8).contains(&part.len()) && part.bytes().all(|byte| byte.is_ascii_alphanumeric())
    })
}

fn is_safe_basename(value: &str) -> bool {
    let length = value.chars().count();
    (1..=255).contains(&length)
        && value != "."
        && value != ".."
        && !value.starts_with(' ')
        && !value.ends_with(['.', ' '])
        && value.chars().all(is_safe_basename_character)
        && value
            .chars()
            .any(|character| character.is_ascii_alphanumeric())
}

fn is_safe_basename_character(character: char) -> bool {
    character.is_ascii_alphanumeric()
        || matches!(character, '.' | '_' | ' ' | '(' | ')' | '+' | '-')
}

fn is_safe_log_code(value: &str) -> bool {
    if value.chars().count() > SAFE_CODE_MAX_CHARS {
        return false;
    }
    let parts = value.split('.').collect::<Vec<_>>();
    parts.len() == 3
        && parts.iter().all(|part| {
            let mut characters = part.chars();
            characters
                .next()
                .is_some_and(|character| character.is_ascii_lowercase())
                && characters.all(|character| {
                    character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_'
                })
        })
}

#[cfg(test)]
mod tests {
    use super::{
        cancelled_model_download_event, invalid_progress_log_detail, validate_model_download_event,
        validate_worker_progress_event, CONTRACT_JSON,
    };

    #[test]
    fn worker_progress_accepts_registered_code_and_closed_typed_args() {
        let payload = serde_json::json!({
            "stage": "video_extracting",
            "progress": 22,
            "message_code": "subtitle.detect.found",
            "message_args": {"language": "zh-Hant-TW"}
        });

        assert_eq!(
            validate_worker_progress_event(&payload).expect("valid worker event"),
            payload
        );
    }

    #[test]
    fn worker_progress_stage_allowlist_comes_from_contract_and_excludes_desktop_cancelling() {
        let contract: serde_json::Value =
            serde_json::from_str(CONTRACT_JSON).expect("parse embedded contract");
        let contract_stages = contract["progressEvents"]["fieldSchemas"]["stage"]["enum"]
            .as_array()
            .expect("worker stage enum")
            .iter()
            .map(|stage| stage.as_str().expect("string stage"))
            .collect::<Vec<_>>();

        for stage in contract_stages {
            let payload = serde_json::json!({
                "stage": stage,
                "progress": 1,
                "message_code": "audio.extract.running"
            });
            assert!(validate_worker_progress_event(&payload).is_ok());
        }
        let desktop_only = serde_json::json!({
            "stage": "cancelling",
            "progress": 1,
            "message_code": "audio.extract.running"
        });
        assert!(validate_worker_progress_event(&desktop_only).is_err());
    }

    #[test]
    fn every_contract_registered_code_is_accepted_with_its_discriminator() {
        let contract: serde_json::Value =
            serde_json::from_str(CONTRACT_JSON).expect("parse embedded contract");
        let worker_codes = contract["progressEvents"]["worker"]["messageCodes"]
            .as_object()
            .expect("worker code registry");
        for code in worker_codes.keys() {
            let payload = serde_json::json!({
                "stage": "video_extracting",
                "progress": 50,
                "message_code": code
            });
            validate_worker_progress_event(&payload)
                .unwrap_or_else(|_| panic!("registered worker code rejected: {code}"));
        }

        let model_codes = contract["progressEvents"]["asrModelDownload"]["messageCodes"]
            .as_object()
            .expect("model code registry");
        for (code, rule) in model_codes {
            let mut payload = serde_json::json!({
                "status": rule["status"],
                "progress": 50,
                "message_code": code
            });
            if rule["current_file"] == "required" {
                payload["current_file"] = serde_json::json!("model.pt");
            }
            validate_model_download_event(&payload)
                .unwrap_or_else(|_| panic!("registered model code rejected: {code}"));
        }
    }

    #[test]
    fn worker_progress_rejects_unknown_or_additional_fields() {
        for payload in [
            serde_json::json!({
                "stage": "video_extracting", "progress": 22,
                "message_code": "unknown.action.state"
            }),
            serde_json::json!({
                "stage": "video_extracting", "progress": 22,
                "message_code": "audio.extract.running", "message": "raw prose"
            }),
            serde_json::json!({
                "stage": "video_extracting", "progress": 22,
                "message_code": "audio.extract.running", "task_id": "private"
            }),
        ] {
            assert!(validate_worker_progress_event(&payload).is_err());
        }
    }

    #[test]
    fn worker_progress_rejects_missing_fields_invalid_stage_and_progress_range() {
        for payload in [
            serde_json::json!({"stage": "video_extracting", "progress": 22}),
            serde_json::json!({
                "stage": "not-a-stage", "progress": 22,
                "message_code": "audio.extract.running"
            }),
            serde_json::json!({
                "stage": "video_extracting", "progress": -1,
                "message_code": "audio.extract.running"
            }),
            serde_json::json!({
                "stage": "video_extracting", "progress": 101,
                "message_code": "audio.extract.running"
            }),
            serde_json::json!({
                "stage": "video_extracting", "progress": "22",
                "message_code": "audio.extract.running"
            }),
            serde_json::json!({
                "stage": "video_extracting", "progress": 22.5,
                "message_code": "audio.extract.running"
            }),
        ] {
            assert!(validate_worker_progress_event(&payload).is_err());
        }
    }

    #[test]
    fn worker_progress_rejects_wrong_or_unsafe_message_args() {
        for payload in [
            serde_json::json!({
                "stage": "video_extracting", "progress": 22,
                "message_code": "audio.extract.running",
                "message_args": {"language": "zh-CN"}
            }),
            serde_json::json!({
                "stage": "video_extracting", "progress": 22,
                "message_code": "subtitle.detect.found",
                "message_args": {"language": "https://secret.example/path"}
            }),
            serde_json::json!({
                "stage": "video_extracting", "progress": 22,
                "message_code": "ai.generation.running",
                "message_args": {"attempt": 0, "total": 101}
            }),
            serde_json::json!({
                "stage": "video_extracting", "progress": 22,
                "message_code": "ai.generation.running",
                "message_args": {"attempt": 1.5, "total": 2}
            }),
            serde_json::json!({
                "stage": "video_extracting", "progress": 22,
                "message_code": "ai.generation.running",
                "message_args": {"attempt": 3, "total": 2}
            }),
            serde_json::json!({
                "stage": "video_transcribing", "progress": 50,
                "message_code": "asr.cache.preparing",
                "message_args": {"model": "private/model"}
            }),
        ] {
            assert!(validate_worker_progress_event(&payload).is_err());
        }
    }

    #[test]
    fn model_progress_enforces_code_status_and_current_file_discriminator() {
        let valid_file = serde_json::json!({
            "status": "downloading",
            "progress": 44,
            "message_code": "model.file.downloading",
            "current_file": "model.pt"
        });
        assert_eq!(
            validate_model_download_event(&valid_file).expect("valid file event"),
            valid_file
        );

        for payload in [
            serde_json::json!({
                "status": "started", "progress": 0,
                "message_code": "model.file.downloading", "current_file": "model.pt"
            }),
            serde_json::json!({
                "status": "downloading", "progress": 44,
                "message_code": "model.file.downloading"
            }),
            serde_json::json!({
                "status": "started", "progress": 0,
                "message_code": "model.download.preparing", "current_file": "model.pt"
            }),
            serde_json::json!({
                "status": "downloading", "progress": 44,
                "message_code": "model.file.downloading", "current_file": "../model.pt"
            }),
            serde_json::json!({
                "status": "downloading", "progress": 44,
                "message_code": "model.file.downloading", "current_file": "dir\\model.pt"
            }),
            serde_json::json!({
                "status": "downloading", "progress": 44,
                "message_code": "model.file.downloading", "current_file": "."
            }),
            serde_json::json!({
                "status": "downloading", "progress": 44,
                "message_code": "model.file.downloading", "current_file": "a".repeat(256)
            }),
            serde_json::json!({
                "status": "downloading", "progress": 44,
                "message_code": "model.file.downloading", "current_file": "C:model.pt"
            }),
            serde_json::json!({
                "status": "downloading", "progress": 44,
                "message_code": "model.file.downloading", "current_file": "model.pt:stream"
            }),
            serde_json::json!({
                "status": "downloading", "progress": 44,
                "message_code": "model.file.downloading", "current_file": "https:model.pt"
            }),
            serde_json::json!({
                "status": "downloading", "progress": 44,
                "message_code": "model.file.downloading", "current_file": "model\u{202e}.pt"
            }),
            serde_json::json!({
                "status": "downloading", "progress": 44,
                "message_code": "model.file.downloading", "current_file": "model\u{2028}.pt"
            }),
            serde_json::json!({
                "status": "downloading", "progress": 44,
                "message_code": "model.file.downloading", "current_file": "model\u{0085}.pt"
            }),
            serde_json::json!({
                "status": "downloading", "progress": 44,
                "message_code": "model.file.downloading", "current_file": "model\u{00a0}file.pt"
            }),
            serde_json::json!({
                "status": "downloading", "progress": 44,
                "message_code": "model.file.downloading", "current_file": "model\u{0600}file.pt"
            }),
            serde_json::json!({
                "status": "downloading", "progress": 44,
                "message_code": "model.file.downloading", "current_file": "model\u{1d173}file.pt"
            }),
            serde_json::json!({
                "status": "downloading", "progress": 44,
                "message_code": "model.file.downloading", "current_file": "model\u{e0001}file.pt"
            }),
            serde_json::json!({
                "status": "downloading", "progress": 44,
                "message_code": "model.file.downloading", "current_file": "model.pt."
            }),
            serde_json::json!({
                "status": "downloading", "progress": 44,
                "message_code": "model.file.downloading", "current_file": "model.pt "
            }),
        ] {
            assert!(validate_model_download_event(&payload).is_err());
        }
    }

    #[test]
    fn model_progress_accepts_portable_release_basenames() {
        for current_file in [
            "model.pt",
            ".gitattributes",
            "configuration.json",
            "MODEL_VERSION.txt",
            "SenseVoice Small (v2)+fp16.bin",
        ] {
            let payload = serde_json::json!({
                "status": "downloading", "progress": 44,
                "message_code": "model.file.downloading", "current_file": current_file
            });
            assert!(validate_model_download_event(&payload).is_ok());
        }
    }

    #[test]
    fn model_progress_rejects_prose_unknown_fields_and_wrong_args() {
        for payload in [
            serde_json::json!({
                "status": "started", "progress": 0,
                "message_code": "model.download.preparing",
                "message": "raw natural language"
            }),
            serde_json::json!({
                "status": "started", "progress": 0,
                "message_code": "model.download.preparing",
                "message_args": {"model": "private/model"}
            }),
            serde_json::json!({
                "status": "cancelled", "progress": 0,
                "message_code": "model.download.cancelled",
                "message_args": {"prompt": "secret"}
            }),
        ] {
            assert!(validate_model_download_event(&payload).is_err());
        }
    }

    #[test]
    fn invalid_event_log_detail_keeps_only_bounded_safe_code() {
        assert_eq!(
            invalid_progress_log_detail(&serde_json::json!({
                "message_code": "unknown.action.state",
                "message_args": {"prompt": "do not log me"},
                "message": "raw prose"
            })),
            "message_code=unknown.action.state"
        );
        for payload in [
            serde_json::json!({"message_code": "../../secret"}),
            serde_json::json!({"message_code": "UPPER.action.state"}),
            serde_json::json!({"message_code": "a.b.c.d"}),
            serde_json::json!({"message_code": "a".repeat(120)}),
            serde_json::json!({"message_code": 7}),
            serde_json::json!({"message": "provider secret"}),
        ] {
            assert_eq!(
                invalid_progress_log_detail(&payload),
                "message_code=invalid"
            );
        }
    }

    #[test]
    fn synthetic_cancelled_model_event_uses_contract_shape_without_prose() {
        let payload = cancelled_model_download_event();

        assert_eq!(payload["status"], "cancelled");
        assert_eq!(payload["progress"], 0);
        assert_eq!(payload["message_code"], "model.download.cancelled");
        assert!(payload.get("message").is_none());
        assert!(validate_model_download_event(&payload).is_ok());
    }
}
