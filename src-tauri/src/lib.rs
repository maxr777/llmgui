use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use keyring::{Entry, Error as KeyringError};
use reqwest::{Client, RequestBuilder, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::time::Duration;
use tauri::State;

const CREDENTIAL_SERVICE: &str = "com.maxr777.llmgui";
const MAX_MESSAGES: usize = 200;
const MAX_ATTACHMENTS: usize = 20;
const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;
const MAX_TEXT_ATTACHMENT_BYTES: usize = 2 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;
const MAX_ATTACHMENT_TOTAL_BYTES: usize = 20 * 1024 * 1024;
const MAX_ANTHROPIC_IMAGE_BASE64_BYTES: usize = 10_000_000;
const MAX_ANTHROPIC_REQUEST_BYTES: usize = 32_000_000;
const MAX_RESPONSE_BYTES: usize = 10 * 1024 * 1024;
const MAX_OUTPUT_TOKENS: u64 = 4096;
const MAX_THINKING_TOKENS: u64 = 16384;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatMessage {
    role: String,
    content: String,
    #[serde(default)]
    attachments: Vec<ChatAttachment>,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum ChatAttachment {
    Text {
        name: String,
        content: String,
    },
    Media {
        name: String,
        media_type: String,
        data: String,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatRequest {
    provider: String,
    model: String,
    #[serde(skip)]
    api_key: String,
    system: Option<String>,
    messages: Vec<ChatMessage>,
    temperature: Option<f64>,
    top_p: Option<f64>,
    top_k: Option<u64>,
    thinking: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatResponse {
    content: String,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    total_tokens: Option<u64>,
    stop_reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CredentialTestRequest {
    provider: String,
    #[serde(skip)]
    api_key: String,
}

#[derive(Serialize)]
struct ApiKeyStatus {
    saved: bool,
    error: Option<String>,
}

#[derive(Serialize)]
struct ApiKeyStatuses {
    openai: ApiKeyStatus,
    anthropic: ApiKeyStatus,
    google: ApiKeyStatus,
}

struct HttpClient(Client);

fn credential_entry(provider: &str) -> Result<Entry, String> {
    if !matches!(provider, "openai" | "anthropic" | "google") {
        return Err("Unsupported provider.".into());
    }
    Entry::new(CREDENTIAL_SERVICE, provider)
        .map_err(|_| "Could not access the system credential store.".into())
}

fn load_api_key_from_store(provider: &str) -> Result<String, String> {
    match credential_entry(provider)?.get_password() {
        Ok(key) => Ok(key),
        Err(KeyringError::NoEntry) => Err("An API key is required.".into()),
        Err(_) => Err("Could not read from the system credential store.".into()),
    }
}

fn api_key_status(provider: &str) -> ApiKeyStatus {
    let entry = match credential_entry(provider) {
        Ok(entry) => entry,
        Err(error) => {
            return ApiKeyStatus {
                saved: false,
                error: Some(error),
            }
        }
    };
    match entry.get_password() {
        Ok(_) => ApiKeyStatus {
            saved: true,
            error: None,
        },
        Err(KeyringError::NoEntry) => ApiKeyStatus {
            saved: false,
            error: None,
        },
        Err(_) => ApiKeyStatus {
            saved: false,
            error: Some("Could not read from the system credential store.".into()),
        },
    }
}

fn load_api_key_statuses_from_store() -> ApiKeyStatuses {
    ApiKeyStatuses {
        openai: api_key_status("openai"),
        anthropic: api_key_status("anthropic"),
        google: api_key_status("google"),
    }
}

fn save_api_key_to_store(provider: &str, api_key: &str) -> Result<(), String> {
    let entry = credential_entry(provider)?;
    let api_key = api_key.trim();
    if api_key.is_empty() {
        match entry.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(_) => Err("Could not delete from the system credential store.".into()),
        }
    } else {
        entry
            .set_password(api_key)
            .map_err(|_| "Could not save to the system credential store.".into())
    }
}

impl ChatAttachment {
    fn name(&self) -> &str {
        match self {
            Self::Text { name, .. } | Self::Media { name, .. } => name,
        }
    }
}

fn message_text(message: &ChatMessage) -> String {
    let mut content = message.content.clone();
    for attachment in &message.attachments {
        if let ChatAttachment::Text {
            name,
            content: text,
        } = attachment
        {
            content.push_str("\n\n<attachment name=\"");
            content.push_str(&name.replace('"', "&quot;"));
            content.push_str("\">\n");
            content.push_str(text);
            content.push_str("\n</attachment>");
        }
    }
    content
}

fn validate(request: &ChatRequest) -> Result<(), String> {
    if request.api_key.trim().is_empty() {
        return Err("An API key is required.".into());
    }
    if !matches!(request.provider.as_str(), "openai" | "anthropic" | "google") {
        return Err("Unsupported provider.".into());
    }
    if request.model.is_empty()
        || request.model.len() > 200
        || !request
            .model
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ".-_".contains(character))
    {
        return Err("The selected model name is invalid.".into());
    }
    if request.messages.is_empty() || request.messages.len() > MAX_MESSAGES {
        return Err(format!("A request must contain 1–{MAX_MESSAGES} messages."));
    }
    if request
        .messages
        .iter()
        .any(|message| !matches!(message.role.as_str(), "user" | "assistant"))
    {
        return Err("The conversation contains an invalid message role.".into());
    }

    let mut text_bytes = request.system.as_ref().map_or(0, String::len);
    let mut attachment_count = 0usize;
    let mut encoded_media_bytes = 0usize;
    for message in &request.messages {
        if !message.attachments.is_empty() && message.role != "user" {
            return Err("Only user messages can contain attachments.".into());
        }
        if message.content.is_empty() && message.attachments.is_empty() {
            return Err("Messages cannot be empty.".into());
        }
        text_bytes = text_bytes
            .checked_add(message.content.len())
            .unwrap_or(usize::MAX);
        for attachment in &message.attachments {
            attachment_count = attachment_count.saturating_add(1);
            let name = attachment.name();
            if name.is_empty()
                || name.len() > 255
                || name
                    .chars()
                    .any(|character| character.is_control() || matches!(character, '/' | '\\'))
            {
                return Err("An attachment has an invalid filename.".into());
            }
            match attachment {
                ChatAttachment::Text { content, .. } => {
                    if content.is_empty()
                        || content.len() > MAX_TEXT_ATTACHMENT_BYTES
                        || content.contains('\0')
                    {
                        return Err("A text attachment is empty or exceeds 2 MiB.".into());
                    }
                    let escaped_name_bytes = name
                        .chars()
                        .map(|character| {
                            if character == '"' {
                                6
                            } else {
                                character.len_utf8()
                            }
                        })
                        .sum::<usize>();
                    text_bytes = text_bytes
                        .checked_add(
                            content.len()
                                + escaped_name_bytes
                                + "\n\n<attachment name=\"\">\n\n</attachment>".len(),
                        )
                        .unwrap_or(usize::MAX);
                }
                ChatAttachment::Media {
                    media_type, data, ..
                } => {
                    if request.provider == "anthropic"
                        && media_type.starts_with("image/")
                        && data.len() > MAX_ANTHROPIC_IMAGE_BASE64_BYTES
                    {
                        return Err("An image exceeds Anthropic's encoded 10 MB limit.".into());
                    }
                    if !matches!(
                        media_type.as_str(),
                        "application/pdf" | "image/jpeg" | "image/png" | "image/webp"
                    ) || data.len() > (MAX_ATTACHMENT_BYTES * 4 / 3) + 4
                    {
                        return Err(
                            "An attachment has an unsupported type or exceeds 10 MiB.".into()
                        );
                    }
                    encoded_media_bytes = encoded_media_bytes
                        .checked_add(data.len())
                        .unwrap_or(usize::MAX);
                }
            }
        }
    }
    if attachment_count > MAX_ATTACHMENTS {
        return Err(format!(
            "A request can contain at most {MAX_ATTACHMENTS} attachments."
        ));
    }
    if text_bytes > MAX_REQUEST_BYTES {
        return Err("The conversation is too large to send (4 MiB text limit).".into());
    }
    if encoded_media_bytes > (MAX_ATTACHMENT_TOTAL_BYTES * 4 / 3) + (MAX_ATTACHMENTS * 4) {
        return Err("Attachments exceed the 20 MiB total limit.".into());
    }

    let mut attachment_bytes = 0usize;
    for attachment in request
        .messages
        .iter()
        .flat_map(|message| &message.attachments)
    {
        if let ChatAttachment::Media {
            media_type, data, ..
        } = attachment
        {
            let decoded = BASE64
                .decode(data)
                .map_err(|_| "An attachment contains invalid data.".to_string())?;
            let valid_signature = match media_type.as_str() {
                "application/pdf" => decoded.starts_with(b"%PDF-"),
                "image/jpeg" => decoded.starts_with(&[0xff, 0xd8, 0xff]),
                "image/png" => decoded.starts_with(b"\x89PNG\r\n\x1a\n"),
                "image/webp" => decoded.starts_with(b"RIFF") && decoded.get(8..12) == Some(b"WEBP"),
                _ => false,
            };
            if decoded.len() > MAX_ATTACHMENT_BYTES || !valid_signature {
                return Err(
                    "An attachment's contents do not match its type or exceed 10 MiB.".into(),
                );
            }
            attachment_bytes = attachment_bytes
                .checked_add(decoded.len())
                .unwrap_or(usize::MAX);
            if attachment_bytes > MAX_ATTACHMENT_TOTAL_BYTES {
                return Err("Attachments exceed the 20 MiB total limit.".into());
            }
        }
    }
    if let Some(value) = request.temperature {
        let max = if request.provider == "anthropic" {
            1.0
        } else {
            2.0
        };
        if !value.is_finite() || !(0.0..=max).contains(&value) {
            return Err(format!("Temperature must be between 0 and {max}."));
        }
    }
    if let Some(value) = request.top_p {
        if !value.is_finite() || !(0.0..=1.0).contains(&value) {
            return Err("Top-P must be between 0 and 1.".into());
        }
    }
    let thinking = request.thinking.as_deref().map(str::trim);
    if request.provider == "anthropic"
        && thinking.is_none()
        && request.temperature.is_some()
        && request.top_p.is_some()
    {
        return Err("Anthropic accepts either Temperature or Top-P, not both.".into());
    }
    if let Some(thinking) = thinking {
        if thinking.is_empty() || thinking.len() > 20 {
            return Err("Thinking must be a valid effort or token budget.".into());
        }
        match request.provider.as_str() {
            "openai" => {
                if !matches!(
                    thinking,
                    "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
                ) {
                    return Err(
                        "OpenAI Thinking must be none, minimal, low, medium, high, xhigh, or max."
                            .into(),
                    );
                }
                if thinking != "none"
                    && (request.temperature.is_some_and(|value| value != 1.0)
                        || request.top_p.is_some_and(|value| value != 1.0))
                {
                    return Err("OpenAI Thinking requires default sampling parameters (Temperature and Top-P unset or 1).".into());
                }
            }
            "anthropic" => {
                let budget = thinking.parse::<u64>().map_err(|_| {
                    "Anthropic Thinking must be a token budget of at least 1024.".to_string()
                })?;
                if !(1024..=MAX_THINKING_TOKENS).contains(&budget) {
                    return Err(format!(
                        "Anthropic Thinking must be between 1024 and {MAX_THINKING_TOKENS} tokens."
                    ));
                }
                if request.temperature.is_some_and(|value| value != 1.0)
                    || request.top_p.is_some_and(|value| value < 0.95)
                    || request.top_k.is_some()
                {
                    return Err("Anthropic Thinking requires Temperature unset or 1, Top-P unset or at least 0.95, and Top-K unset.".into());
                }
            }
            "google" => {
                let uses_budget = request.model.starts_with("gemini-2.5-");
                let uses_level = request.model.starts_with("gemini-3");
                if uses_budget {
                    let budget = thinking.parse::<i64>().map_err(|_| {
                        "Gemini 2.5 Thinking must be a token budget or -1 for dynamic thinking."
                            .to_string()
                    })?;
                    if budget < -1 || budget > MAX_THINKING_TOKENS as i64 {
                        return Err(format!(
                            "Gemini 2.5 Thinking must be -1 or between 0 and {MAX_THINKING_TOKENS} tokens."
                        ));
                    }
                } else if uses_level {
                    if !matches!(thinking, "minimal" | "low" | "medium" | "high") {
                        return Err(
                            "Gemini 3 Thinking must be minimal, low, medium, or high.".into()
                        );
                    }
                } else if let Ok(budget) = thinking.parse::<i64>() {
                    if budget < -1 || budget > MAX_THINKING_TOKENS as i64 {
                        return Err(format!(
                            "Google Thinking must be -1 or between 0 and {MAX_THINKING_TOKENS} tokens."
                        ));
                    }
                } else if !matches!(thinking, "minimal" | "low" | "medium" | "high") {
                    return Err(
                        "Google Thinking must be a token budget or minimal, low, medium, or high."
                            .into(),
                    );
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn insert_optional(map: &mut Map<String, Value>, key: &str, value: Option<f64>) {
    if let Some(value) = value {
        map.insert(key.into(), json!(value));
    }
}

async fn send_json(request: RequestBuilder) -> Result<Value, String> {
    let response = request.send().await.map_err(|error| {
        if error.is_timeout() {
            "The provider request timed out.".to_string()
        } else if error.is_connect() {
            "Could not connect to the provider.".to_string()
        } else {
            "The provider request failed.".to_string()
        }
    })?;
    let status = response.status();
    if response.content_length().unwrap_or(0) > MAX_RESPONSE_BYTES as u64 {
        return Err("The provider returned an unexpectedly large response.".into());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "Could not read the provider response.".to_string())?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("The provider returned an unexpectedly large response.".into());
    }
    let body: Value = serde_json::from_slice(&bytes).map_err(|_| {
        if status.is_success() {
            "The provider returned an invalid response.".to_string()
        } else {
            status_error(status, None)
        }
    })?;
    if !status.is_success() {
        let message = body
            .pointer("/error/message")
            .or_else(|| body.pointer("/error/status"))
            .and_then(Value::as_str);
        return Err(status_error(status, message));
    }
    Ok(body)
}

fn status_error(status: StatusCode, message: Option<&str>) -> String {
    if matches!(status.as_u16(), 401 | 403) {
        return "Authentication failed. Check the API key and its permissions.".into();
    }
    let category = match status.as_u16() {
        404 => "Model or endpoint not found",
        429 => "Provider rate limit reached",
        400..=499 => "Provider rejected the request",
        _ => "Provider service error",
    };
    match message {
        Some(message) if !message.is_empty() => {
            let safe: String = message
                .chars()
                .filter(|character| !character.is_control())
                .take(300)
                .collect();
            format!("{category}: {safe}")
        }
        _ => format!("{category} (HTTP {}).", status.as_u16()),
    }
}

fn openai_body(request: &ChatRequest) -> Map<String, Value> {
    let mut messages = Vec::new();
    if let Some(system) = request.system.as_ref().filter(|value| !value.is_empty()) {
        messages.push(json!({ "role": "system", "content": system }));
    }
    messages.extend(request.messages.iter().map(|message| {
        let text = message_text(message);
        let media: Vec<_> = message
            .attachments
            .iter()
            .filter_map(|attachment| match attachment {
                ChatAttachment::Media {
                    name,
                    media_type,
                    data,
                } => Some((name, media_type, data)),
                ChatAttachment::Text { .. } => None,
            })
            .collect();
        if media.is_empty() {
            return json!({ "role": message.role, "content": text });
        }
        let mut content = Vec::new();
        if !text.is_empty() {
            content.push(json!({ "type": "text", "text": text }));
        }
        content.extend(media.into_iter().map(|(name, media_type, data)| {
            let data_url = format!("data:{media_type};base64,{data}");
            if media_type == "application/pdf" {
                json!({
                    "type": "file",
                    "file": { "filename": name, "file_data": data_url }
                })
            } else {
                json!({ "type": "image_url", "image_url": { "url": data_url } })
            }
        }));
        json!({ "role": message.role, "content": content })
    }));
    let mut body = Map::new();
    body.insert("model".into(), json!(request.model));
    body.insert("messages".into(), json!(messages));
    let thinking = request.thinking.as_deref().map(str::trim);
    let reasoning_enabled = thinking.is_some_and(|value| value != "none");
    let max_tokens = if reasoning_enabled {
        MAX_OUTPUT_TOKENS + MAX_THINKING_TOKENS
    } else {
        MAX_OUTPUT_TOKENS
    };
    body.insert("max_completion_tokens".into(), json!(max_tokens));
    body.insert("store".into(), json!(false));
    if !reasoning_enabled {
        insert_optional(&mut body, "temperature", request.temperature);
        insert_optional(&mut body, "top_p", request.top_p);
    }
    if let Some(thinking) = thinking {
        body.insert("reasoning_effort".into(), json!(thinking));
    }
    body
}

async fn openai(client: &Client, request: &ChatRequest) -> Result<ChatResponse, String> {
    let body = openai_body(request);
    let value = send_json(
        client
            .post("https://api.openai.com/v1/chat/completions")
            .bearer_auth(&request.api_key)
            .json(&body),
    )
    .await?;
    let content = value
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .or_else(|| {
            value
                .pointer("/choices/0/message/refusal")
                .and_then(Value::as_str)
        })
        .filter(|content| !content.is_empty())
        .ok_or_else(|| {
            if value
                .pointer("/choices/0/finish_reason")
                .and_then(Value::as_str)
                == Some("length")
            {
                "OpenAI used the completion token allowance without producing visible text. Lower Thinking or shorten the conversation.".to_string()
            } else {
                "OpenAI returned no visible text.".to_string()
            }
        })?;
    Ok(ChatResponse {
        content: content.into(),
        input_tokens: value
            .pointer("/usage/prompt_tokens")
            .and_then(Value::as_u64),
        output_tokens: value
            .pointer("/usage/completion_tokens")
            .and_then(Value::as_u64),
        total_tokens: value.pointer("/usage/total_tokens").and_then(Value::as_u64),
        stop_reason: value
            .pointer("/choices/0/finish_reason")
            .and_then(Value::as_str)
            .map(Into::into),
    })
}

fn anthropic_body(request: &ChatRequest) -> Map<String, Value> {
    let messages: Vec<Value> = request
        .messages
        .iter()
        .map(|message| {
            let text = message_text(message);
            let mut content: Vec<Value> = message
                .attachments
                .iter()
                .filter_map(|attachment| match attachment {
                    ChatAttachment::Media {
                        name,
                        media_type,
                        data,
                    } => Some(if media_type == "application/pdf" {
                        json!({
                            "type": "document",
                            "source": {
                                "type": "base64",
                                "media_type": media_type,
                                "data": data
                            },
                            "title": name
                        })
                    } else {
                        json!({
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": media_type,
                                "data": data
                            }
                        })
                    }),
                    ChatAttachment::Text { .. } => None,
                })
                .collect();
            if content.is_empty() {
                return json!({ "role": message.role, "content": text });
            }
            if !text.is_empty() {
                content.push(json!({ "type": "text", "text": text }));
            }
            json!({ "role": message.role, "content": content })
        })
        .collect();
    let mut body = Map::new();
    body.insert("model".into(), json!(request.model));
    body.insert("messages".into(), json!(messages));
    let thinking_budget = request
        .thinking
        .as_deref()
        .map(str::trim)
        .and_then(|value| value.parse::<u64>().ok());
    body.insert(
        "max_tokens".into(),
        json!(MAX_OUTPUT_TOKENS + thinking_budget.unwrap_or(0)),
    );
    if let Some(system) = request.system.as_ref().filter(|value| !value.is_empty()) {
        body.insert("system".into(), json!(system));
    }
    if thinking_budget.is_none() {
        insert_optional(&mut body, "temperature", request.temperature);
    }
    insert_optional(&mut body, "top_p", request.top_p);
    if let Some(top_k) = request.top_k.filter(|value| *value > 0) {
        body.insert("top_k".into(), json!(top_k));
    }
    if let Some(budget) = thinking_budget {
        body.insert(
            "thinking".into(),
            json!({ "type": "enabled", "budget_tokens": budget }),
        );
    }
    body
}

async fn anthropic(client: &Client, request: &ChatRequest) -> Result<ChatResponse, String> {
    let body = anthropic_body(request);
    let serialized = serde_json::to_vec(&body)
        .map_err(|_| "Could not serialize the provider request.".to_string())?;
    if serialized.len() > MAX_ANTHROPIC_REQUEST_BYTES {
        return Err("The request exceeds Anthropic's 32 MB limit.".into());
    }
    let value = send_json(
        client
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", &request.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .body(serialized),
    )
    .await?;
    let content = value["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|block| block["type"] == "text")
        .filter_map(|block| block["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n");
    if content.is_empty() {
        return Err("Anthropic returned no visible text.".into());
    }
    let input = value.pointer("/usage/input_tokens").and_then(Value::as_u64);
    let output = value
        .pointer("/usage/output_tokens")
        .and_then(Value::as_u64);
    Ok(ChatResponse {
        content,
        input_tokens: input,
        output_tokens: output,
        total_tokens: input.zip(output).map(|(input, output)| input + output),
        stop_reason: value["stop_reason"].as_str().map(Into::into),
    })
}

fn google_body(request: &ChatRequest) -> Map<String, Value> {
    let contents: Vec<Value> =
        request
            .messages
            .iter()
            .map(|message| {
                let role = if message.role == "assistant" {
                    "model"
                } else {
                    "user"
                };
                let text = message_text(message);
                let mut parts = Vec::new();
                if !text.is_empty() {
                    parts.push(json!({ "text": text }));
                }
                parts.extend(message.attachments.iter().filter_map(
                    |attachment| match attachment {
                        ChatAttachment::Media {
                            media_type, data, ..
                        } => Some(json!({
                            "inlineData": {
                                "mimeType": media_type,
                                "data": data
                            }
                        })),
                        ChatAttachment::Text { .. } => None,
                    },
                ));
                json!({ "role": role, "parts": parts })
            })
            .collect();
    let mut generation = Map::new();
    insert_optional(&mut generation, "temperature", request.temperature);
    insert_optional(&mut generation, "topP", request.top_p);
    if let Some(top_k) = request.top_k.filter(|value| *value > 0) {
        generation.insert("topK".into(), json!(top_k));
    }
    let mut max_tokens = MAX_OUTPUT_TOKENS;
    if let Some(thinking) = request.thinking.as_deref().map(str::trim) {
        let uses_budget = request.model.starts_with("gemini-2.5-")
            || (!request.model.starts_with("gemini-3") && thinking.parse::<i64>().is_ok());
        let config = if uses_budget {
            let budget = thinking.parse::<i64>().unwrap_or(-1);
            if budget == -1 {
                max_tokens += MAX_THINKING_TOKENS;
            } else if budget > 0 {
                max_tokens += budget as u64;
            }
            json!({ "thinkingBudget": budget })
        } else {
            max_tokens += MAX_THINKING_TOKENS;
            json!({ "thinkingLevel": thinking })
        };
        generation.insert("thinkingConfig".into(), config);
    }
    generation.insert("maxOutputTokens".into(), json!(max_tokens));
    let mut body = Map::new();
    body.insert("contents".into(), json!(contents));
    body.insert("generationConfig".into(), Value::Object(generation));
    if let Some(system) = request.system.as_ref().filter(|value| !value.is_empty()) {
        body.insert(
            "systemInstruction".into(),
            json!({ "parts": [{ "text": system }] }),
        );
    }
    body
}

async fn google(client: &Client, request: &ChatRequest) -> Result<ChatResponse, String> {
    let body = google_body(request);
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
        request.model
    );
    let value = send_json(
        client
            .post(url)
            .header("x-goog-api-key", &request.api_key)
            .json(&body),
    )
    .await?;
    if let Some(reason) = value
        .pointer("/promptFeedback/blockReason")
        .and_then(Value::as_str)
    {
        return Err(format!("Google blocked the prompt: {reason}."));
    }
    let content = value
        .pointer("/candidates/0/content/parts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|part| part["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n");
    if content.is_empty() {
        let reason = value
            .pointer("/candidates/0/finishReason")
            .and_then(Value::as_str)
            .unwrap_or("unknown reason");
        if reason == "MAX_TOKENS" {
            return Err("Google used the output token allowance without producing visible text. Lower Thinking or shorten the conversation.".into());
        }
        return Err(format!("Google returned no visible text ({reason})."));
    }
    Ok(ChatResponse {
        content,
        input_tokens: value
            .pointer("/usageMetadata/promptTokenCount")
            .and_then(Value::as_u64),
        output_tokens: value
            .pointer("/usageMetadata/candidatesTokenCount")
            .and_then(Value::as_u64),
        total_tokens: value
            .pointer("/usageMetadata/totalTokenCount")
            .and_then(Value::as_u64),
        stop_reason: value
            .pointer("/candidates/0/finishReason")
            .and_then(Value::as_str)
            .map(Into::into),
    })
}

fn credential_test_request(
    client: &Client,
    request: &CredentialTestRequest,
) -> Result<RequestBuilder, String> {
    if request.api_key.trim().is_empty() {
        return Err("An API key is required.".into());
    }
    match request.provider.as_str() {
        "openai" => Ok(client
            .get("https://api.openai.com/v1/models")
            .bearer_auth(&request.api_key)),
        "anthropic" => Ok(client
            .get("https://api.anthropic.com/v1/models")
            .header("x-api-key", &request.api_key)
            .header("anthropic-version", "2023-06-01")),
        "google" => Ok(client
            .get("https://generativelanguage.googleapis.com/v1beta/models")
            .header("x-goog-api-key", &request.api_key)),
        _ => Err("Unsupported provider.".into()),
    }
}

async fn stored_api_key(provider: &str) -> Result<String, String> {
    let provider = provider.to_string();
    tauri::async_runtime::spawn_blocking(move || load_api_key_from_store(&provider))
        .await
        .map_err(|_| "Could not access the system credential store.".to_string())?
}

#[tauri::command]
async fn load_api_key_statuses() -> Result<ApiKeyStatuses, String> {
    tauri::async_runtime::spawn_blocking(load_api_key_statuses_from_store)
        .await
        .map_err(|_| "Could not access the system credential store.".to_string())
}

#[tauri::command]
async fn save_api_key(provider: String, api_key: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || save_api_key_to_store(&provider, &api_key))
        .await
        .map_err(|_| "Could not access the system credential store.".to_string())?
}

#[tauri::command]
async fn test_credentials(
    client: State<'_, HttpClient>,
    mut request: CredentialTestRequest,
) -> Result<(), String> {
    request.api_key = stored_api_key(&request.provider).await?;
    let request = credential_test_request(&client.0, &request)?;
    send_json(request).await.map(|_| ())
}

#[tauri::command]
async fn chat(
    client: State<'_, HttpClient>,
    mut request: ChatRequest,
) -> Result<ChatResponse, String> {
    request.api_key = stored_api_key(&request.provider).await?;
    validate(&request)?;
    match request.provider.as_str() {
        "openai" => openai(&client.0, &request).await,
        "anthropic" => anthropic(&client.0, &request).await,
        "google" => google(&client.0, &request).await,
        _ => Err("Unsupported provider.".into()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Disable DMABUF renderer to fix white screen on some Linux systems.
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("failed to build HTTP client");

    tauri::Builder::default()
        .manage(HttpClient(client))
        .invoke_handler(tauri::generate_handler![
            chat,
            load_api_key_statuses,
            save_api_key,
            test_credentials
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn media(name: &str, media_type: &str, data: &[u8]) -> ChatAttachment {
        ChatAttachment::Media {
            name: name.into(),
            media_type: media_type.into(),
            data: BASE64.encode(data),
        }
    }

    fn request(provider: &str) -> ChatRequest {
        ChatRequest {
            provider: provider.into(),
            model: "test-model".into(),
            api_key: "test-key".into(),
            system: None,
            messages: vec![ChatMessage {
                role: "user".into(),
                content: "Hello".into(),
                attachments: Vec::new(),
            }],
            temperature: None,
            top_p: None,
            top_k: None,
            thinking: None,
        }
    }

    #[test]
    fn accepts_provider_defaults() {
        assert!(validate(&request("openai")).is_ok());
        assert!(validate(&request("anthropic")).is_ok());
        assert!(validate(&request("google")).is_ok());
    }

    #[test]
    fn ignores_api_keys_from_the_webview() {
        let chat: ChatRequest = serde_json::from_value(json!({
            "provider": "openai",
            "model": "test-model",
            "apiKey": "webview-key",
            "messages": [{ "role": "user", "content": "Hello" }]
        }))
        .unwrap();
        let test: CredentialTestRequest = serde_json::from_value(json!({
            "provider": "openai",
            "apiKey": "webview-key"
        }))
        .unwrap();
        assert!(chat.api_key.is_empty());
        assert!(test.api_key.is_empty());
    }

    #[test]
    fn deserializes_the_attachment_wire_union() {
        let request: ChatRequest = serde_json::from_value(json!({
            "provider": "openai",
            "model": "test-model",
            "messages": [{
                "role": "user",
                "content": "",
                "attachments": [
                    { "kind": "text", "name": "notes.txt", "content": "notes" },
                    {
                        "kind": "media",
                        "name": "image.png",
                        "mediaType": "image/png",
                        "data": BASE64.encode(b"\x89PNG\r\n\x1a\n")
                    }
                ]
            }]
        }))
        .unwrap();
        assert!(matches!(
            request.messages[0].attachments[0],
            ChatAttachment::Text { .. }
        ));
        assert!(matches!(
            request.messages[0].attachments[1],
            ChatAttachment::Media { .. }
        ));
    }

    #[test]
    fn builds_fixed_provider_credential_tests() {
        let client = Client::new();
        let cases = [
            (
                "openai",
                "https://api.openai.com/v1/models",
                "authorization",
            ),
            (
                "anthropic",
                "https://api.anthropic.com/v1/models",
                "x-api-key",
            ),
            (
                "google",
                "https://generativelanguage.googleapis.com/v1beta/models",
                "x-goog-api-key",
            ),
        ];
        for (provider, url, header) in cases {
            let request = credential_test_request(
                &client,
                &CredentialTestRequest {
                    provider: provider.into(),
                    api_key: "test-key".into(),
                },
            )
            .unwrap()
            .build()
            .unwrap();
            assert_eq!(request.url().as_str(), url);
            assert!(request.headers().contains_key(header));
        }
    }

    #[test]
    fn rejects_invalid_credential_tests() {
        let client = Client::new();
        for (provider, api_key) in [("unknown", "test-key"), ("openai", "  ")] {
            assert!(credential_test_request(
                &client,
                &CredentialTestRequest {
                    provider: provider.into(),
                    api_key: api_key.into(),
                },
            )
            .is_err());
        }
    }

    #[test]
    fn redacts_provider_authentication_errors() {
        let error = status_error(
            StatusCode::UNAUTHORIZED,
            Some("Incorrect API key provided: sk-secret-fingerprint"),
        );
        assert_eq!(
            error,
            "Authentication failed. Check the API key and its permissions."
        );
        assert!(!error.contains("sk-secret-fingerprint"));
    }

    #[test]
    fn rejects_conflicting_anthropic_sampling_controls() {
        let mut request = request("anthropic");
        request.temperature = Some(0.7);
        request.top_p = Some(0.9);
        assert_eq!(
            validate(&request).unwrap_err(),
            "Anthropic accepts either Temperature or Top-P, not both."
        );
    }

    #[test]
    fn rejects_invalid_roles_and_model_paths() {
        let mut invalid_role = request("google");
        invalid_role.messages[0].role = "system".into();
        assert!(validate(&invalid_role).is_err());

        let mut invalid_model = request("google");
        invalid_model.model = "../model".into();
        assert!(validate(&invalid_model).is_err());
    }

    #[test]
    fn validates_provider_specific_thinking_values() {
        let mut openai = request("openai");
        openai.thinking = Some("high".into());
        openai.temperature = Some(1.0);
        assert!(validate(&openai).is_ok());
        openai.temperature = Some(0.7);
        assert!(validate(&openai).is_err());
        openai.temperature = None;
        openai.thinking = Some("1024".into());
        assert!(validate(&openai).is_err());

        let mut anthropic = request("anthropic");
        anthropic.thinking = Some("1024".into());
        anthropic.temperature = Some(1.0);
        assert!(validate(&anthropic).is_ok());
        anthropic.top_p = Some(0.9);
        assert!(validate(&anthropic).is_err());
        anthropic.top_p = Some(0.95);
        assert!(validate(&anthropic).is_ok());

        let mut google = request("google");
        google.model = "gemini-2.5-flash".into();
        google.thinking = Some("-1".into());
        assert!(validate(&google).is_ok());
        google.thinking = Some("low".into());
        assert!(validate(&google).is_err());
        google.model = "gemini-3-flash".into();
        assert!(validate(&google).is_ok());
        google.thinking = Some("1024".into());
        assert!(validate(&google).is_err());
    }

    #[test]
    fn builds_provider_specific_thinking_bodies() {
        let mut openai = request("openai");
        openai.temperature = Some(1.0);
        openai.top_p = Some(1.0);
        openai.thinking = Some("high".into());
        let body = Value::Object(openai_body(&openai));
        assert_eq!(body["reasoning_effort"], "high");
        assert_eq!(body["max_completion_tokens"], 20480);
        assert!(body.get("temperature").is_none());
        assert!(body.get("top_p").is_none());

        openai.thinking = Some("none".into());
        let body = Value::Object(openai_body(&openai));
        assert_eq!(body["max_completion_tokens"], 4096);
        assert_eq!(body["temperature"], 1.0);
        assert_eq!(body["top_p"], 1.0);

        let mut anthropic = request("anthropic");
        anthropic.temperature = Some(1.0);
        anthropic.thinking = Some("1024".into());
        let body = Value::Object(anthropic_body(&anthropic));
        assert_eq!(body["thinking"]["type"], "enabled");
        assert_eq!(body["thinking"]["budget_tokens"], 1024);
        assert_eq!(body["max_tokens"], 5120);
        assert!(body.get("temperature").is_none());

        let mut google = request("google");
        google.model = "gemini-2.5-flash".into();
        google.thinking = Some("1024".into());
        let body = Value::Object(google_body(&google));
        assert_eq!(
            body["generationConfig"]["thinkingConfig"]["thinkingBudget"],
            1024
        );
        assert_eq!(body["generationConfig"]["maxOutputTokens"], 5120);

        google.model = "gemini-3-flash".into();
        google.thinking = Some("low".into());
        let body = Value::Object(google_body(&google));
        assert_eq!(
            body["generationConfig"]["thinkingConfig"]["thinkingLevel"],
            "low"
        );
        assert_eq!(body["generationConfig"]["maxOutputTokens"], 20480);
    }

    #[test]
    fn validates_and_builds_multimodal_attachments() {
        let mut request = request("openai");
        request.messages[0].attachments = vec![
            media("document.pdf", "application/pdf", b"%PDF-1.4"),
            media("image.png", "image/png", b"\x89PNG\r\n\x1a\n"),
        ];
        assert!(validate(&request).is_ok());

        let body = Value::Object(openai_body(&request));
        assert_eq!(
            body["messages"][0]["content"],
            json!([
                { "type": "text", "text": "Hello" },
                {
                    "type": "file",
                    "file": {
                        "filename": "document.pdf",
                        "file_data": format!("data:application/pdf;base64,{}", BASE64.encode(b"%PDF-1.4"))
                    }
                },
                {
                    "type": "image_url",
                    "image_url": {
                        "url": format!("data:image/png;base64,{}", BASE64.encode(b"\x89PNG\r\n\x1a\n"))
                    }
                }
            ])
        );

        request.provider = "anthropic".into();
        let body = Value::Object(anthropic_body(&request));
        assert_eq!(body["messages"][0]["content"][0]["type"], "document");
        assert_eq!(
            body["messages"][0]["content"][0]["source"]["data"],
            BASE64.encode(b"%PDF-1.4")
        );
        assert_eq!(body["messages"][0]["content"][1]["type"], "image");
        assert_eq!(body["messages"][0]["content"][2]["text"], "Hello");

        request.provider = "google".into();
        let body = Value::Object(google_body(&request));
        assert_eq!(
            body["contents"][0]["parts"][1]["inlineData"]["mimeType"],
            "application/pdf"
        );
        assert_eq!(
            body["contents"][0]["parts"][2]["inlineData"]["mimeType"],
            "image/png"
        );
    }

    #[test]
    fn rejects_mislabeled_attachment_data() {
        let mut request = request("openai");
        request.messages[0]
            .attachments
            .push(media("not-an-image.png", "image/png", b"not a PNG"));
        assert!(validate(&request).is_err());

        request.messages[0].attachments = vec![ChatAttachment::Media {
            name: "broken.png".into(),
            media_type: "image/png".into(),
            data: "not base64!".into(),
        }];
        assert!(validate(&request).is_err());
    }

    #[test]
    fn validates_text_attachments_and_attachment_only_messages() {
        let mut request = request("openai");
        request.messages[0].content.clear();
        request.messages[0].attachments.push(ChatAttachment::Text {
            name: "photo.png".into(),
            content: "[binary unavailable after app restart]".into(),
        });
        assert!(validate(&request).is_ok());
        let expected = "\n\n<attachment name=\"photo.png\">\n[binary unavailable after app restart]\n</attachment>";
        assert_eq!(message_text(&request.messages[0]), expected);
        assert_eq!(
            Value::Object(openai_body(&request))["messages"][0]["content"],
            expected
        );

        request.messages[0].attachments = vec![ChatAttachment::Text {
            name: "large.txt".into(),
            content: "x".repeat(MAX_TEXT_ATTACHMENT_BYTES + 1),
        }];
        assert!(validate(&request).is_err());
    }

    #[test]
    fn builds_native_attachment_only_messages() {
        let mut request = request("openai");
        request.messages[0].content.clear();
        request.messages[0].attachments =
            vec![media("image.png", "image/png", b"\x89PNG\r\n\x1a\n")];
        assert!(validate(&request).is_ok());
        let openai = Value::Object(openai_body(&request));
        assert_eq!(openai["messages"][0]["content"][0]["type"], "image_url");
        assert_eq!(
            openai["messages"][0]["content"].as_array().unwrap().len(),
            1
        );

        request.provider = "anthropic".into();
        let anthropic = Value::Object(anthropic_body(&request));
        assert_eq!(anthropic["messages"][0]["content"][0]["type"], "image");

        request.provider = "google".into();
        let google = Value::Object(google_body(&request));
        assert_eq!(
            google["contents"][0]["parts"][0]["inlineData"]["mimeType"],
            "image/png"
        );
    }

    #[test]
    fn enforces_anthropics_encoded_image_limit() {
        let mut bytes = vec![0; 7_500_000];
        bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        let mut request = request("anthropic");
        request.messages[0].attachments = vec![media("image.png", "image/png", &bytes)];
        assert!(matches!(
            &request.messages[0].attachments[0],
            ChatAttachment::Media { data, .. }
                if data.len() == MAX_ANTHROPIC_IMAGE_BASE64_BYTES
        ));
        assert!(validate(&request).is_ok());

        let ChatAttachment::Media { data, .. } = &mut request.messages[0].attachments[0] else {
            unreachable!()
        };
        data.push_str("AAAA");
        assert!(validate(&request).is_err());
    }

    #[test]
    fn rejects_excessive_attachments_and_unsafe_filenames() {
        let mut request = request("openai");
        request.messages[0].attachments = (0..=MAX_ATTACHMENTS)
            .map(|index| ChatAttachment::Text {
                name: format!("{index}.txt"),
                content: "x".into(),
            })
            .collect();
        assert!(validate(&request).is_err());

        request.messages[0].attachments = vec![ChatAttachment::Text {
            name: "../unsafe.txt".into(),
            content: "x".into(),
        }];
        assert!(validate(&request).is_err());

        request.messages[0].attachments = vec![ChatAttachment::Text {
            name: "é".repeat(128),
            content: "x".into(),
        }];
        assert!(validate(&request).is_err());
    }
}
