// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn chat(prompt: &str) -> String {
    format!("AI Echo: {}", prompt)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Disable DMABUF renderer to fix white screen on some Linux systems
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![chat])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
