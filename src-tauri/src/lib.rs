use reqwest::{Client, RequestBuilder, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::time::Duration;
use tauri::State;

const MAX_MESSAGES: usize = 200;
const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 10 * 1024 * 1024;
const MAX_OUTPUT_TOKENS: u64 = 4096;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatRequest {
    provider: String,
    model: String,
    api_key: String,
    system: Option<String>,
    messages: Vec<ChatMessage>,
    temperature: Option<f64>,
    top_p: Option<f64>,
    top_k: Option<u64>,
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

struct HttpClient(Client);

fn validate(request: &ChatRequest) -> Result<(), String> {
    if request.api_key.trim().is_empty() {
        return Err("An API key is required.".into());
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
    let bytes = request
        .messages
        .iter()
        .try_fold(0usize, |total, message| {
            total.checked_add(message.content.len())
        })
        .unwrap_or(usize::MAX);
    if bytes > MAX_REQUEST_BYTES {
        return Err("The conversation is too large to send (4 MiB limit).".into());
    }
    if request
        .messages
        .iter()
        .any(|message| !matches!(message.role.as_str(), "user" | "assistant"))
    {
        return Err("The conversation contains an invalid message role.".into());
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
    if request.provider == "anthropic" && request.temperature.is_some() && request.top_p.is_some() {
        return Err("Anthropic accepts either Temperature or Top-P, not both.".into());
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
    let category = match status.as_u16() {
        401 | 403 => "Authentication failed",
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

async fn openai(client: &Client, request: &ChatRequest) -> Result<ChatResponse, String> {
    let mut messages = Vec::new();
    if let Some(system) = request.system.as_ref().filter(|value| !value.is_empty()) {
        messages.push(json!({ "role": "system", "content": system }));
    }
    messages.extend(
        request
            .messages
            .iter()
            .map(|message| json!({ "role": message.role, "content": message.content })),
    );
    let mut body = Map::new();
    body.insert("model".into(), json!(request.model));
    body.insert("messages".into(), json!(messages));
    body.insert("max_completion_tokens".into(), json!(MAX_OUTPUT_TOKENS));
    body.insert("store".into(), json!(false));
    insert_optional(&mut body, "temperature", request.temperature);
    insert_optional(&mut body, "top_p", request.top_p);
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
        .ok_or_else(|| "OpenAI returned no visible text.".to_string())?;
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

async fn anthropic(client: &Client, request: &ChatRequest) -> Result<ChatResponse, String> {
    let messages: Vec<Value> = request
        .messages
        .iter()
        .map(|message| json!({ "role": message.role, "content": message.content }))
        .collect();
    let mut body = Map::new();
    body.insert("model".into(), json!(request.model));
    body.insert("messages".into(), json!(messages));
    body.insert("max_tokens".into(), json!(MAX_OUTPUT_TOKENS));
    if let Some(system) = request.system.as_ref().filter(|value| !value.is_empty()) {
        body.insert("system".into(), json!(system));
    }
    insert_optional(&mut body, "temperature", request.temperature);
    insert_optional(&mut body, "top_p", request.top_p);
    if let Some(top_k) = request.top_k.filter(|value| *value > 0) {
        body.insert("top_k".into(), json!(top_k));
    }
    let value = send_json(
        client
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", &request.api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&body),
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

async fn google(client: &Client, request: &ChatRequest) -> Result<ChatResponse, String> {
    let contents: Vec<Value> = request
        .messages
        .iter()
        .map(|message| {
            let role = if message.role == "assistant" {
                "model"
            } else {
                "user"
            };
            json!({ "role": role, "parts": [{ "text": message.content }] })
        })
        .collect();
    let mut generation = Map::new();
    generation.insert("maxOutputTokens".into(), json!(MAX_OUTPUT_TOKENS));
    insert_optional(&mut generation, "temperature", request.temperature);
    insert_optional(&mut generation, "topP", request.top_p);
    if let Some(top_k) = request.top_k.filter(|value| *value > 0) {
        generation.insert("topK".into(), json!(top_k));
    }
    let mut body = Map::new();
    body.insert("contents".into(), json!(contents));
    body.insert("generationConfig".into(), Value::Object(generation));
    if let Some(system) = request.system.as_ref().filter(|value| !value.is_empty()) {
        body.insert(
            "systemInstruction".into(),
            json!({ "parts": [{ "text": system }] }),
        );
    }
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

#[tauri::command]
async fn chat(client: State<'_, HttpClient>, request: ChatRequest) -> Result<ChatResponse, String> {
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
        .invoke_handler(tauri::generate_handler![chat])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(provider: &str) -> ChatRequest {
        ChatRequest {
            provider: provider.into(),
            model: "test-model".into(),
            api_key: "test-key".into(),
            system: None,
            messages: vec![ChatMessage {
                role: "user".into(),
                content: "Hello".into(),
            }],
            temperature: None,
            top_p: None,
            top_k: None,
        }
    }

    #[test]
    fn accepts_provider_defaults() {
        assert!(validate(&request("openai")).is_ok());
        assert!(validate(&request("anthropic")).is_ok());
        assert!(validate(&request("google")).is_ok());
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
}
