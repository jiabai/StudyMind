use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use tauri::AppHandle;
use url::Url;
use uuid::Uuid;

use crate::{ensure_runtime_dirs, resolve_runtime_paths, RuntimePaths};

const ACCOUNT_SESSION_FILE_NAME: &str = "session.json";
const ACCOUNT_PENDING_STATE_FILE_NAME: &str = "pending_auth_state.txt";
const DEFAULT_SERVER_BASE_URL: &str = "https://StudyMind.8xf.pro";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AuthCallback {
    pub(crate) ticket: String,
    pub(crate) state: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct BeginAuthFlowResult {
    auth_url: String,
    state: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct AccountSessionFile {
    session_token: String,
    email: String,
    expires_at: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct AccountStatusView {
    authenticated: bool,
    email: Option<String>,
    entitlement_status: String,
    entitlement_expires_at: Option<String>,
    llm_quota_limit: i32,
    llm_quota_used: i32,
    llm_quota_remaining: i32,
    llm_quota_resets_at: Option<String>,
    llm_configured: bool,
    last_verified_at: Option<String>,
    can_process: bool,
    can_generate_ai: bool,
    server_error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ServerAccountStatus {
    authenticated: bool,
    email: String,
    entitlement_status: String,
    entitlement_expires_at: Option<String>,
    llm_quota_limit: i32,
    llm_quota_used: i32,
    llm_quota_remaining: i32,
    llm_quota_resets_at: Option<String>,
    llm_configured: bool,
    last_verified_at: String,
    can_process: bool,
    can_generate_ai: bool,
}

#[derive(Debug, Deserialize)]
struct SessionExchangeResponse {
    session_token: String,
    email: String,
    expires_at: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct CompleteAuthFlowResult {
    authenticated: bool,
    email: String,
    can_process: bool,
    can_generate_ai: bool,
}

#[derive(Debug, Serialize)]
pub(crate) struct WechatCheckoutView {
    order_id: String,
    amount_fen: i32,
    currency: String,
    code_url: String,
    expires_at: String,
    status: String,
}

#[derive(Debug, Deserialize)]
struct ServerWechatCheckout {
    order_id: String,
    amount_fen: i32,
    currency: String,
    code_url: String,
    expires_at: String,
    status: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct CheckoutStatusView {
    order_id: String,
    status: String,
    entitlement_expires_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ServerCheckoutStatus {
    order_id: String,
    status: String,
    entitlement_expires_at: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct ServerManagedLlmInvocation {
    pub(crate) server_base_url: String,
    pub(crate) session_token: String,
    pub(crate) request_id: String,
}

#[tauri::command]
pub(crate) fn begin_auth_flow(app: AppHandle) -> Result<BeginAuthFlowResult, String> {
    let paths = resolve_runtime_paths(&app)?;
    ensure_runtime_dirs(&paths)?;
    let state = generate_auth_state();
    fs::create_dir_all(account_auth_dir(&paths)).map_err(|error| error.to_string())?;
    fs::write(account_pending_state_path(&paths), &state).map_err(|error| error.to_string())?;
    Ok(BeginAuthFlowResult {
        auth_url: build_auth_login_url(&server_base_url(), &state)?,
        state,
    })
}

#[tauri::command]
pub(crate) async fn complete_auth_flow(
    app: AppHandle,
    callback_url: String,
) -> Result<CompleteAuthFlowResult, String> {
    let paths = resolve_runtime_paths(&app)?;
    ensure_runtime_dirs(&paths)?;
    let pending_state = fs::read_to_string(account_pending_state_path(&paths))
        .map_err(|_| "No pending login state was found.".to_string())?;
    let callback = parse_auth_callback_url(&callback_url, pending_state.trim())?;
    let exchange = exchange_auth_ticket(&server_base_url(), &callback).await?;
    fs::create_dir_all(account_auth_dir(&paths)).map_err(|error| error.to_string())?;
    write_account_session(&account_session_path(&paths), &exchange)?;
    let _ = fs::remove_file(account_pending_state_path(&paths));
    let status =
        get_account_status_from_server(&server_base_url(), &exchange.session_token).await?;
    Ok(CompleteAuthFlowResult {
        authenticated: true,
        email: exchange.email,
        can_process: status.can_process,
        can_generate_ai: status.can_generate_ai,
    })
}

#[tauri::command]
pub(crate) async fn get_account_status(app: AppHandle) -> Result<AccountStatusView, String> {
    let paths = resolve_runtime_paths(&app)?;
    ensure_runtime_dirs(&paths)?;
    let Some(session) = read_account_session(&account_session_path(&paths))? else {
        return Ok(guest_account_status());
    };
    match get_account_status_from_server(&server_base_url(), &session.session_token).await {
        Ok(status) => Ok(AccountStatusView {
            authenticated: status.authenticated,
            email: Some(status.email),
            entitlement_status: status.entitlement_status,
            entitlement_expires_at: status.entitlement_expires_at,
            llm_quota_limit: status.llm_quota_limit,
            llm_quota_used: status.llm_quota_used,
            llm_quota_remaining: status.llm_quota_remaining,
            llm_quota_resets_at: status.llm_quota_resets_at,
            llm_configured: status.llm_configured,
            last_verified_at: Some(status.last_verified_at),
            can_process: status.can_process,
            can_generate_ai: status.can_generate_ai,
            server_error: None,
        }),
        Err(error) => Ok(AccountStatusView {
            authenticated: true,
            email: Some(session.email),
            entitlement_status: "unknown".to_string(),
            entitlement_expires_at: None,
            llm_quota_limit: 0,
            llm_quota_used: 0,
            llm_quota_remaining: 0,
            llm_quota_resets_at: None,
            llm_configured: false,
            last_verified_at: None,
            can_process: false,
            can_generate_ai: false,
            server_error: Some(error),
        }),
    }
}

#[tauri::command]
pub(crate) async fn logout_account(app: AppHandle) -> Result<(), String> {
    let paths = resolve_runtime_paths(&app)?;
    if let Some(session) = read_account_session(&account_session_path(&paths))? {
        let _ = reqwest::Client::new()
            .post(format!("{}/api/desktop/logout", server_base_url()))
            .bearer_auth(session.session_token)
            .send()
            .await;
    }
    let _ = fs::remove_file(account_session_path(&paths));
    Ok(())
}

#[tauri::command]
pub(crate) async fn redeem_activation_code(
    app: AppHandle,
    code: String,
) -> Result<AccountStatusView, String> {
    let paths = resolve_runtime_paths(&app)?;
    let session = require_account_session(&paths)?;
    let response = reqwest::Client::new()
        .post(build_activation_redeem_url(&server_base_url()))
        .bearer_auth(&session.session_token)
        .json(&serde_json::json!({ "code": code }))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(response_error_message(response, "Activation code redeem failed.").await);
    }
    let status = response
        .json::<ServerAccountStatus>()
        .await
        .map_err(|error| error.to_string())?;
    Ok(account_status_view_from_server(status))
}

#[tauri::command]
pub(crate) async fn create_wechat_checkout(app: AppHandle) -> Result<WechatCheckoutView, String> {
    let paths = resolve_runtime_paths(&app)?;
    let session = require_account_session(&paths)?;
    let response = reqwest::Client::new()
        .post(format!(
            "{}/api/desktop/billing/wechat-native",
            server_base_url()
        ))
        .bearer_auth(session.session_token)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Checkout failed with status {}.",
            response.status()
        ));
    }
    let checkout = response
        .json::<ServerWechatCheckout>()
        .await
        .map_err(|error| error.to_string())?;
    Ok(WechatCheckoutView {
        order_id: checkout.order_id,
        amount_fen: checkout.amount_fen,
        currency: checkout.currency,
        code_url: checkout.code_url,
        expires_at: checkout.expires_at,
        status: checkout.status,
    })
}

#[tauri::command]
pub(crate) async fn get_checkout_status(
    app: AppHandle,
    order_id: String,
) -> Result<CheckoutStatusView, String> {
    let paths = resolve_runtime_paths(&app)?;
    let session = require_account_session(&paths)?;
    let response = reqwest::Client::new()
        .get(format!(
            "{}/api/desktop/billing/orders/{}",
            server_base_url(),
            percent_encode(&order_id)
        ))
        .bearer_auth(session.session_token)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Order status failed with status {}.",
            response.status()
        ));
    }
    let status = response
        .json::<ServerCheckoutStatus>()
        .await
        .map_err(|error| error.to_string())?;
    Ok(CheckoutStatusView {
        order_id: status.order_id,
        status: status.status,
        entitlement_expires_at: status.entitlement_expires_at,
    })
}

pub(crate) fn server_managed_llm_invocation(
    paths: &RuntimePaths,
) -> Result<Option<ServerManagedLlmInvocation>, String> {
    let Some(session) = read_account_session(&account_session_path(paths))? else {
        return Ok(None);
    };
    Ok(Some(ServerManagedLlmInvocation {
        server_base_url: server_base_url(),
        session_token: session.session_token,
        request_id: format!("llm-{}", Uuid::new_v4().simple()),
    }))
}

fn account_auth_dir(paths: &RuntimePaths) -> std::path::PathBuf {
    paths.user_data_dir.join("auth")
}

fn account_session_path(paths: &RuntimePaths) -> std::path::PathBuf {
    account_auth_dir(paths).join(ACCOUNT_SESSION_FILE_NAME)
}

fn account_pending_state_path(paths: &RuntimePaths) -> std::path::PathBuf {
    account_auth_dir(paths).join(ACCOUNT_PENDING_STATE_FILE_NAME)
}

pub(crate) fn server_base_url() -> String {
    std::env::var("StudyMind_SERVER_BASE_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_SERVER_BASE_URL.to_string())
        .trim_end_matches('/')
        .to_string()
}

fn generate_auth_state() -> String {
    format!("state-{}", Uuid::new_v4().simple())
}

pub(crate) fn build_auth_login_url(server_base_url: &str, state: &str) -> Result<String, String> {
    validate_auth_state(state)?;
    let base = server_base_url.trim_end_matches('/');
    if !base.starts_with("http://") && !base.starts_with("https://") {
        return Err("StudyMind server URL must start with http:// or https://.".to_string());
    }
    Ok(format!(
        "{}/login?desktop=1&state={}&redirect_uri={}",
        base,
        percent_encode(state),
        percent_encode("studymind://auth/callback")
    ))
}

pub(crate) fn build_activation_redeem_url(server_base_url: &str) -> String {
    format!(
        "{}/api/desktop/activation-codes/redeem",
        server_base_url.trim_end_matches('/')
    )
}

pub(crate) fn parse_auth_callback_url(
    callback_url: &str,
    expected_state: &str,
) -> Result<AuthCallback, String> {
    validate_auth_state(expected_state)?;
    let url = Url::parse(callback_url).map_err(|_| "Auth callback URL is invalid.".to_string())?;
    if url.scheme() != "studymind" || url.host_str() != Some("auth") || url.path() != "/callback" {
        return Err("Auth callback URL target is invalid.".to_string());
    }
    let mut ticket: Option<String> = None;
    let mut state: Option<String> = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "ticket" => ticket = Some(value.to_string()),
            "state" => state = Some(value.to_string()),
            _ => {}
        }
    }
    let Some(ticket) = ticket else {
        return Err("Auth callback is missing a login ticket.".to_string());
    };
    let Some(state) = state else {
        return Err("Auth callback is missing state.".to_string());
    };
    if state != expected_state {
        return Err("Auth callback state does not match this device.".to_string());
    }
    if !ticket.starts_with("flt_") || ticket.len() > 256 {
        return Err("Auth callback ticket is invalid.".to_string());
    }
    Ok(AuthCallback { ticket, state })
}

fn validate_auth_state(state: &str) -> Result<(), String> {
    if state.len() < 8
        || state.len() > 160
        || !state
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '~' | '-'))
    {
        return Err("Auth state is invalid.".to_string());
    }
    Ok(())
}

fn percent_encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

async fn exchange_auth_ticket(
    server_base_url: &str,
    callback: &AuthCallback,
) -> Result<SessionExchangeResponse, String> {
    let response = reqwest::Client::new()
        .post(format!(
            "{}/api/desktop/sessions/exchange",
            server_base_url.trim_end_matches('/')
        ))
        .json(&serde_json::json!({
            "ticket": callback.ticket,
            "state": callback.state,
        }))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Login exchange failed with status {}.",
            response.status()
        ));
    }
    response
        .json::<SessionExchangeResponse>()
        .await
        .map_err(|error| error.to_string())
}

async fn get_account_status_from_server(
    server_base_url: &str,
    session_token: &str,
) -> Result<ServerAccountStatus, String> {
    let response = reqwest::Client::new()
        .get(format!(
            "{}/api/desktop/account",
            server_base_url.trim_end_matches('/')
        ))
        .bearer_auth(session_token)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Account status failed with status {}.",
            response.status()
        ));
    }
    response
        .json::<ServerAccountStatus>()
        .await
        .map_err(|error| error.to_string())
}

fn account_status_view_from_server(status: ServerAccountStatus) -> AccountStatusView {
    AccountStatusView {
        authenticated: status.authenticated,
        email: Some(status.email),
        entitlement_status: status.entitlement_status,
        entitlement_expires_at: status.entitlement_expires_at,
        llm_quota_limit: status.llm_quota_limit,
        llm_quota_used: status.llm_quota_used,
        llm_quota_remaining: status.llm_quota_remaining,
        llm_quota_resets_at: status.llm_quota_resets_at,
        llm_configured: status.llm_configured,
        last_verified_at: Some(status.last_verified_at),
        can_process: status.can_process,
        can_generate_ai: status.can_generate_ai,
        server_error: None,
    }
}

async fn response_error_message(response: reqwest::Response, fallback: &str) -> String {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let server_error = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(|error| error.as_str())
                .map(str::to_string)
        });
    match server_error {
        Some(message) if !message.trim().is_empty() => message,
        _ => format!("{fallback} Status {status}."),
    }
}

fn write_account_session(path: &Path, session: &SessionExchangeResponse) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let session_file = AccountSessionFile {
        session_token: session.session_token.clone(),
        email: session.email.clone(),
        expires_at: session.expires_at.clone(),
    };
    fs::write(
        path,
        serde_json::to_string_pretty(&session_file).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

fn read_account_session(path: &Path) -> Result<Option<AccountSessionFile>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str::<AccountSessionFile>(&content)
        .map(Some)
        .map_err(|error| error.to_string())
}

fn require_account_session(paths: &RuntimePaths) -> Result<AccountSessionFile, String> {
    read_account_session(&account_session_path(paths))?
        .ok_or_else(|| "Please log in to StudyMind first.".to_string())
}

fn guest_account_status() -> AccountStatusView {
    AccountStatusView {
        authenticated: false,
        email: None,
        entitlement_status: "inactive".to_string(),
        entitlement_expires_at: None,
        llm_quota_limit: 0,
        llm_quota_used: 0,
        llm_quota_remaining: 0,
        llm_quota_resets_at: None,
        llm_configured: false,
        last_verified_at: None,
        can_process: false,
        can_generate_ai: false,
        server_error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::{account_status_view_from_server, guest_account_status, ServerAccountStatus};
    use serde_json::json;

    #[test]
    fn account_status_view_preserves_separate_processing_and_ai_gates() {
        let status: ServerAccountStatus = serde_json::from_value(json!({
            "authenticated": true,
            "email": "user@example.com",
            "entitlement_status": "active",
            "entitlement_expires_at": "2026-07-22T08:00:00.000Z",
            "llm_quota_limit": 20,
            "llm_quota_used": 20,
            "llm_quota_remaining": 0,
            "llm_quota_resets_at": "2026-07-22T08:00:00.000Z",
            "llm_configured": false,
            "last_verified_at": "2026-06-21T08:00:00.000Z",
            "can_process": true,
            "can_generate_ai": false
        }))
        .expect("deserialize server account status");

        let view = account_status_view_from_server(status);
        let value = serde_json::to_value(view).expect("serialize account status view");

        assert_eq!(value["can_process"], true);
        assert_eq!(value["can_generate_ai"], false);
    }

    #[test]
    fn guest_account_status_blocks_processing_and_ai_generation() {
        let value = serde_json::to_value(guest_account_status()).expect("serialize guest status");

        assert_eq!(value["can_process"], false);
        assert_eq!(value["can_generate_ai"], false);
    }
}