use serde::{Deserialize, Serialize};
use url::Url;

const SOURCE_IDENTITY_VERSION: u64 = 1;
const MAX_CANONICAL_URL_LENGTH: usize = 2_048;
const MAX_SOURCE_STABLE_ID_LENGTH: usize = 80;
const MAX_SOURCE_QUERY_PAIRS: usize = 1;
const MAX_SOURCE_QUERY_COMPONENT_LENGTH: usize = 128;
const MAX_EFFECTIVE_PART: u64 = 100_000;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct SourceIdentity {
    pub(crate) version: u64,
    pub(crate) platform: String,
    pub(crate) stable_id: String,
    #[serde(default)]
    pub(crate) effective_part: Option<u64>,
    pub(crate) canonical_url: String,
}

impl SourceIdentity {
    pub(crate) fn is_safe(&self) -> bool {
        if self.version != SOURCE_IDENTITY_VERSION
            || self.stable_id.is_empty()
            || self.stable_id.len() > MAX_SOURCE_STABLE_ID_LENGTH
            || !self
                .stable_id
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
            || self.canonical_url.is_empty()
            || self.canonical_url.len() > MAX_CANONICAL_URL_LENGTH
            || self.canonical_url.chars().any(char::is_control)
            || self.canonical_url.contains('%')
            || self
                .effective_part
                .is_some_and(|part| part == 0 || part > MAX_EFFECTIVE_PART)
        {
            return false;
        }
        if !platform_stable_id_is_valid(&self.platform, &self.stable_id) {
            return false;
        }
        let expected_host = match self.platform.as_str() {
            "xiaohongshu" => "www.xiaohongshu.com",
            "douyin" => "www.douyin.com",
            "bilibili" => "www.bilibili.com",
            "youtube" => "www.youtube.com",
            _ => return false,
        };
        let Ok(parsed) = Url::parse(&self.canonical_url) else {
            return false;
        };
        if parsed.scheme() != "https"
            || parsed.host_str() != Some(expected_host)
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.fragment().is_some()
            || parsed.port().is_some()
        {
            return false;
        }
        let query_pairs = parsed.query_pairs().collect::<Vec<_>>();
        if query_pairs.len() > MAX_SOURCE_QUERY_PAIRS
            || query_pairs.iter().any(|(key, value)| {
                key.is_empty()
                    || key.len() > MAX_SOURCE_QUERY_COMPONENT_LENGTH
                    || value.len() > MAX_SOURCE_QUERY_COMPONENT_LENGTH
                    || is_sensitive_parameter_name(key)
                    || (value.as_ref() != self.stable_id && is_sensitive_parameter_value(value))
            })
        {
            return false;
        }
        match self.platform.as_str() {
            "xiaohongshu" => {
                self.effective_part.is_none()
                    && parsed.query().is_none()
                    && parsed.path().strip_prefix("/explore/") == Some(self.stable_id.as_str())
            }
            "douyin" => {
                self.effective_part.is_none()
                    && parsed.query().is_none()
                    && parsed.path().strip_prefix("/video/") == Some(self.stable_id.as_str())
            }
            "bilibili" => {
                if parsed.path().strip_prefix("/video/") != Some(self.stable_id.as_str()) {
                    return false;
                }
                match self.effective_part {
                    Some(1) => parsed.query().is_none(),
                    Some(part) if part > 1 => {
                        query_pairs.len() == 1
                            && query_pairs[0].0 == "p"
                            && query_pairs[0].1 == part.to_string()
                    }
                    _ => false,
                }
            }
            "youtube" => {
                self.effective_part.is_none()
                    && parsed.path() == "/watch"
                    && query_pairs.len() == 1
                    && query_pairs[0].0 == "v"
                    && query_pairs[0].1 == self.stable_id.as_str()
            }
            _ => false,
        }
    }

    pub(crate) fn equality_key(&self) -> Option<(&str, &str, Option<u64>)> {
        self.is_safe().then_some((
            self.platform.as_str(),
            self.stable_id.as_str(),
            self.effective_part,
        ))
    }
}

fn platform_stable_id_is_valid(platform: &str, stable_id: &str) -> bool {
    match platform {
        "xiaohongshu" => {
            stable_id.len() == 24
                && stable_id
                    .chars()
                    .all(|ch| ch.is_ascii_digit() || matches!(ch, 'a'..='f'))
        }
        "douyin" => {
            (15..=24).contains(&stable_id.len()) && stable_id.chars().all(|ch| ch.is_ascii_digit())
        }
        "bilibili" => {
            (stable_id.len() == 12
                && stable_id.starts_with("BV")
                && stable_id[2..].chars().all(|ch| ch.is_ascii_alphanumeric()))
                || (stable_id.strip_prefix("av").is_some_and(|digits| {
                    (1..=20).contains(&digits.len()) && digits.chars().all(|ch| ch.is_ascii_digit())
                }))
        }
        "youtube" => {
            stable_id.len() == 11
                && stable_id
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
        }
        _ => false,
    }
}

fn is_sensitive_parameter_name(value: &str) -> bool {
    let normalized = value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    normalized.contains("token")
        || normalized.contains("signature")
        || matches!(normalized.as_str(), "s" | "sig")
        || normalized.contains("auth")
        || normalized.contains("cookie")
        || normalized.contains("session")
        || normalized.contains("credential")
        || normalized.contains("password")
        || normalized.contains("secret")
        || normalized == "key"
        || normalized.ends_with("key")
}

fn is_sensitive_parameter_value(value: &str) -> bool {
    let normalized = value.to_ascii_lowercase();
    normalized.contains("secret")
        || normalized.contains("bearer")
        || normalized.contains("xsec_token")
        || normalized.contains("access_token")
        || normalized.contains("signature=")
}
