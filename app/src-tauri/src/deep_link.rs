use tauri::{Emitter, WebviewWindow};

pub(crate) trait DeepLinkActivationWindow {
    fn unminimize_window(&self) -> Result<(), String>;
    fn show_window(&self) -> Result<(), String>;
    fn focus_window(&self) -> Result<(), String>;
    fn emit_deep_link_args(&self, argv: Vec<String>) -> Result<(), String>;
}

impl DeepLinkActivationWindow for WebviewWindow {
    fn unminimize_window(&self) -> Result<(), String> {
        self.unminimize().map_err(|error| error.to_string())
    }

    fn show_window(&self) -> Result<(), String> {
        self.show().map_err(|error| error.to_string())
    }

    fn focus_window(&self) -> Result<(), String> {
        self.set_focus().map_err(|error| error.to_string())
    }

    fn emit_deep_link_args(&self, argv: Vec<String>) -> Result<(), String> {
        self.emit("studymind-deep-link-args", argv)
            .map_err(|error| error.to_string())
    }
}

pub(crate) fn activate_main_window_for_deep_link<W: DeepLinkActivationWindow>(
    window: &W,
    argv: Vec<String>,
) {
    log::debug!("deep-link callback firing with {} args", argv.len());
    for (i, arg) in argv.iter().enumerate() {
        log::debug!("  arg[{i}] = {}", crate::sanitize_diagnostic_text(arg));
    }
    if let Err(e) = window.unminimize_window() {
        log::warn!("unminimize failed: {e}");
    }
    if let Err(e) = window.show_window() {
        log::warn!("show failed: {e}");
    }
    if let Err(e) = window.focus_window() {
        log::warn!("focus failed: {e}");
    }
    if let Err(e) = window.emit_deep_link_args(argv) {
        log::warn!("emit deep-link-args failed: {e}");
    } else {
        log::debug!("studymind-deep-link-args emitted");
    }
}

#[cfg(test)]
mod tests {
    use super::{activate_main_window_for_deep_link, DeepLinkActivationWindow};
    use std::cell::RefCell;

    #[derive(Default)]
    struct FakeDeepLinkWindow {
        actions: RefCell<Vec<String>>,
    }

    impl FakeDeepLinkWindow {
        fn record(&self, action: &str) {
            self.actions.borrow_mut().push(action.to_string());
        }
    }

    impl DeepLinkActivationWindow for FakeDeepLinkWindow {
        fn unminimize_window(&self) -> Result<(), String> {
            self.record("unminimize");
            Ok(())
        }

        fn show_window(&self) -> Result<(), String> {
            self.record("show");
            Ok(())
        }

        fn focus_window(&self) -> Result<(), String> {
            self.record("focus");
            Ok(())
        }

        fn emit_deep_link_args(&self, argv: Vec<String>) -> Result<(), String> {
            self.record(&format!("emit:{}", argv.join("|")));
            Ok(())
        }
    }

    #[test]
    fn deep_link_activation_brings_existing_main_window_forward() {
        let window = FakeDeepLinkWindow::default();

        activate_main_window_for_deep_link(
            &window,
            vec!["studymind://auth/callback?ticket=flt_abc&state=state-1".to_string()],
        );

        assert_eq!(
            window.actions.into_inner(),
            vec![
                "unminimize",
                "show",
                "focus",
                "emit:studymind://auth/callback?ticket=flt_abc&state=state-1",
            ]
        );
    }
}